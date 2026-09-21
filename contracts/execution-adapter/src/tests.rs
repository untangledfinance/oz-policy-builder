extern crate std;
use super::*;
use soroban_sdk::{
    auth::ContractContext,
    contract, contractimpl, symbol_short,
    testutils::{storage::Instance as _, Address as _},
    token, vec, Bytes, IntoVal,
};

#[contract]
struct Fixture;
#[contractimpl]
impl Fixture {
    pub fn set(e: Env, who: Address, value: u32) {
        who.require_auth();
        e.storage().instance().set(&symbol_short!("value"), &value);
    }
    pub fn get(e: Env) -> u32 {
        e.storage()
            .instance()
            .get(&symbol_short!("value"))
            .unwrap_or(0)
    }
    pub fn fail(_e: Env) {
        panic!("deliberate late failure");
    }
}

fn address(e: &Env, prime: &Address) -> Address {
    let salt = e
        .crypto()
        .sha256(&Bytes::from_slice(e, b"prime.execution.adapter.v2"));
    e.deployer()
        .with_address(prime.clone(), salt)
        .deployed_address()
}
fn call(e: &Env, target: &Address, name: &str, args: Vec<Val>) -> Call {
    Call {
        target: target.clone(),
        function_name: Symbol::new(e, name),
        args,
        executor_authorizations: Vec::new(e),
    }
}
/// The INVOCATION arguments of `execute`, in declaration order. These unit
/// tests do not install a policy, so an empty grant list is correct: nothing
/// will ask the policy anything.
fn args(e: &Env, prime: &Address, policy: &Address, calls: &Vec<Call>) -> Vec<Val> {
    let grants = Vec::<soroban_sdk::auth::InvokerContractAuthEntry>::new(e);
    (prime, policy, calls, grants).into_val(e)
}

#[test]
fn stateless_execution_at_derived_address_preserves_order() {
    let e = Env::default();
    e.mock_all_auths();
    let prime = Address::generate(&e);
    let interpreter = Address::generate(&e);
    // No constructor configuration: the Prime association follows from the address.
    let adapter = e.register_at(&address(&e, &prime), ExecutionAdapter, ());
    let venue = e.register(Fixture, ());
    let calls = vec![
        &e,
        call(&e, &venue, "set", (&prime, 1u32).into_val(&e)),
        call(&e, &venue, "set", (&prime, 2u32).into_val(&e)),
    ];
    let result: Vec<Val> = e.invoke_contract(
        &adapter,
        &Symbol::new(&e, "execute"),
        args(&e, &prime, &interpreter, &calls),
    );
    assert_eq!(result.len(), 2);
    assert_eq!(FixtureClient::new(&e, &venue).get(), 2);
    e.as_contract(&adapter, || {
        assert!(e.storage().instance().all().is_empty())
    });
}

#[test]
fn late_failure_rolls_back_earlier_state() {
    let e = Env::default();
    e.mock_all_auths();
    let prime = Address::generate(&e);
    let interpreter = Address::generate(&e);
    let adapter = e.register_at(&address(&e, &prime), ExecutionAdapter, ());
    let venue = e.register(Fixture, ());
    let calls = vec![
        &e,
        call(&e, &venue, "set", (&prime, 7u32).into_val(&e)),
        call(&e, &venue, "fail", Vec::new(&e)),
    ];
    assert!(e
        .try_invoke_contract::<Vec<Val>, soroban_sdk::Error>(
            &adapter,
            &Symbol::new(&e, "execute"),
            args(&e, &prime, &interpreter, &calls)
        )
        .is_err());
    assert_eq!(FixtureClient::new(&e, &venue).get(), 0);
}

#[test]
fn stranger_cannot_choose_own_prime_to_spend_adapter_balance() {
    let e = Env::default();
    e.mock_all_auths();
    let prime = Address::generate(&e);
    let stranger = Address::generate(&e);
    let interpreter = Address::generate(&e);
    let adapter = e.register_at(&address(&e, &prime), ExecutionAdapter, ());
    let asset = e
        .register_stellar_asset_contract_v2(Address::generate(&e))
        .address();
    token::StellarAssetClient::new(&e, &asset).mint(&adapter, &100);
    let calls = vec![
        &e,
        call(
            &e,
            &asset,
            "transfer",
            (&adapter, &stranger, 100i128).into_val(&e),
        ),
    ];
    assert!(e
        .try_invoke_contract::<Vec<Val>, soroban_sdk::Error>(
            &adapter,
            &Symbol::new(&e, "execute"),
            args(&e, &stranger, &interpreter, &calls)
        )
        .is_err());
    assert_eq!(token::Client::new(&e, &asset).balance(&adapter), 100);
    assert_eq!(token::Client::new(&e, &asset).balance(&stranger), 0);
}

#[test]
fn missing_prime_authorization_is_rejected() {
    let e = Env::default();
    let prime = Address::generate(&e);
    let interpreter = Address::generate(&e);
    let adapter = e.register_at(&address(&e, &prime), ExecutionAdapter, ());
    let venue = e.register(Fixture, ());
    let calls = vec![&e, call(&e, &venue, "get", Vec::new(&e))];
    assert!(e
        .try_invoke_contract::<Vec<Val>, soroban_sdk::Error>(
            &adapter,
            &Symbol::new(&e, "execute"),
            args(&e, &prime, &interpreter, &calls)
        )
        .is_err());
}

#[test]
fn execution_cannot_target_account_or_interpreter() {
    let e = Env::default();
    e.mock_all_auths();
    let prime = e.register(Fixture, ());
    let interpreter = e.register(Fixture, ());
    let adapter = e.register_at(&address(&e, &prime), ExecutionAdapter, ());
    for target in [&prime, &interpreter] {
        let calls = vec![&e, call(&e, target, "get", Vec::new(&e))];
        assert!(e
            .try_invoke_contract::<Vec<Val>, soroban_sdk::Error>(
                &adapter,
                &Symbol::new(&e, "execute"),
                args(&e, &prime, &interpreter, &calls)
            )
            .is_err());
    }
}

#[test]
fn an_unused_nested_grant_cannot_authorize_account_management() {
    use soroban_sdk::auth::SubContractInvocation;
    let e = Env::default();
    e.mock_all_auths();
    let prime = Address::generate(&e);
    let interpreter = Address::generate(&e);
    let adapter = e.register_at(&address(&e, &prime), ExecutionAdapter, ());
    let venue = e.register(Fixture, ());
    let mut c = call(&e, &venue, "set", (&prime, 7u32).into_val(&e));
    c.executor_authorizations
        .push_back(InvokerContractAuthEntry::Contract(SubContractInvocation {
            context: ContractContext {
                contract: prime.clone(),
                fn_name: Symbol::new(&e, "add_context_rule"),
                args: Vec::new(&e),
            },
            sub_invocations: Vec::new(&e),
        }));
    let calls = vec![&e, c];
    assert!(e
        .try_invoke_contract::<Vec<Val>, soroban_sdk::Error>(
            &adapter,
            &Symbol::new(&e, "execute"),
            args(&e, &prime, &interpreter, &calls)
        )
        .is_err());
    assert_eq!(FixtureClient::new(&e, &venue).get(), 0);
}
