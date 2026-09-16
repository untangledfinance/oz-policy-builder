extern crate std;
use super::*;
use soroban_sdk::{
    contract, contractimpl, symbol_short, testutils::Address as _, token, vec, IntoVal,
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

fn call(e: &Env, target: &Address, name: &str, args: Vec<Val>) -> Call {
    Call {
        target: target.clone(),
        function_name: Symbol::new(e, name),
        args,
        executor_authorizations: Vec::new(e),
    }
}

#[test]
fn executes_no_funding_call_in_order() {
    let e = Env::default();
    e.mock_all_auths();
    let prime = Address::generate(&e);
    let interpreter = e.register(policy_interpreter::PolicyInterpreter, ());
    let adapter = e.register(ExecutionAdapter, (&prime, &interpreter));
    let venue = e.register(Fixture, ());
    let calls = vec![
        &e,
        call(&e, &venue, "set", (&prime, 1u32).into_val(&e)),
        call(&e, &venue, "set", (&prime, 2u32).into_val(&e)),
    ];
    let result = ExecutionAdapterClient::new(&e, &adapter).execute(&prime, &calls);
    assert_eq!(result.len(), 2);
    assert_eq!(FixtureClient::new(&e, &venue).get(), 2);
}

#[test]
fn late_failure_rolls_back_earlier_state() {
    let e = Env::default();
    e.mock_all_auths();
    let prime = Address::generate(&e);
    let interpreter = e.register(policy_interpreter::PolicyInterpreter, ());
    let adapter = e.register(ExecutionAdapter, (&prime, &interpreter));
    let venue = e.register(Fixture, ());
    let calls = vec![
        &e,
        call(&e, &venue, "set", (&prime, 7u32).into_val(&e)),
        call(&e, &venue, "fail", Vec::new(&e)),
    ];
    assert!(ExecutionAdapterClient::new(&e, &adapter)
        .try_execute(&prime, &calls)
        .is_err());
    assert_eq!(FixtureClient::new(&e, &venue).get(), 0);
    assert!(
        !policy_interpreter::PolicyInterpreterClient::new(&e, &interpreter)
            .execution_active(&adapter)
    );
}

#[test]
fn stranger_cannot_choose_their_own_prime_to_spend_adapter_balance() {
    let e = Env::default();
    e.mock_all_auths();
    let prime = Address::generate(&e);
    let stranger = Address::generate(&e);
    let interpreter = e.register(policy_interpreter::PolicyInterpreter, ());
    let adapter = e.register(ExecutionAdapter, (&prime, &interpreter));
    let token_addr = e
        .register_stellar_asset_contract_v2(Address::generate(&e))
        .address();
    token::StellarAssetClient::new(&e, &token_addr).mint(&adapter, &100);
    let calls = vec![
        &e,
        call(
            &e,
            &token_addr,
            "transfer",
            (&adapter, &stranger, 100i128).into_val(&e),
        ),
    ];
    assert!(ExecutionAdapterClient::new(&e, &adapter)
        .try_execute(&stranger, &calls)
        .is_err());
    assert_eq!(token::Client::new(&e, &token_addr).balance(&adapter), 100);
    assert_eq!(token::Client::new(&e, &token_addr).balance(&stranger), 0);
}

#[test]
fn missing_prime_authorization_is_rejected() {
    let e = Env::default();
    let prime = Address::generate(&e);
    let interpreter = e.register(policy_interpreter::PolicyInterpreter, ());
    let adapter = e.register(ExecutionAdapter, (&prime, &interpreter));
    let venue = e.register(Fixture, ());
    let calls = vec![&e, call(&e, &venue, "get", Vec::new(&e))];
    assert!(ExecutionAdapterClient::new(&e, &adapter)
        .try_execute(&prime, &calls)
        .is_err());
}

#[contract]
struct ScopeObserver;
#[contractimpl]
impl ScopeObserver {
    pub fn observe(e: Env, interpreter: Address, adapter: Address) {
        assert!(
            policy_interpreter::PolicyInterpreterClient::new(&e, &interpreter)
                .execution_active(&adapter),
            "scope must be open while calls execute"
        );
    }
}
#[test]
fn execution_opens_scope_and_removes_it_even_when_no_child_requires_prime_auth() {
    let e = Env::default();
    e.mock_all_auths();
    let prime = Address::generate(&e);
    let interpreter = e.register(policy_interpreter::PolicyInterpreter, ());
    let adapter = e.register(ExecutionAdapter, (&prime, &interpreter));
    let venue = e.register(ScopeObserver, ());
    let calls = vec![
        &e,
        call(&e, &venue, "observe", (&interpreter, &adapter).into_val(&e)),
    ];
    ExecutionAdapterClient::new(&e, &adapter).execute(&prime, &calls);
    assert!(
        !policy_interpreter::PolicyInterpreterClient::new(&e, &interpreter)
            .execution_active(&adapter)
    );
}
