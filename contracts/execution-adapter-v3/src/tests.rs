extern crate std;
use super::*;
use soroban_sdk::{testutils::Address as _, xdr::ToXdr, Bytes, String as SString};

/// Stands in for the custody gate: the adapter only ever asks it two things.
#[contract]
pub struct FixtureGate;

#[contractimpl]
impl FixtureGate {
    pub fn __constructor(e: Env, allowed: Vec<Address>, custody: Address) {
        e.storage().instance().set(&symbol_short!("a"), &allowed);
        e.storage().instance().set(&symbol_short!("c"), &custody);
    }
    pub fn allowed(e: Env) -> Vec<Address> {
        e.storage().instance().get(&symbol_short!("a")).unwrap()
    }
    pub fn custody(e: Env) -> Address {
        e.storage().instance().get(&symbol_short!("c")).unwrap()
    }
    pub fn ping(_e: Env) {}
    pub fn one(_e: Env, _a: Val) {}
    pub fn two(_e: Env, _a: Val, _b: Val) {}
}

struct World {
    e: Env,
    adapter: Address,
    gate: Address,
    prime: Address,
    custody: Address,
    stranger: Address,
}

fn world() -> World {
    let e = Env::default();
    e.mock_all_auths();
    let prime = Address::generate(&e);
    let custody = Address::generate(&e);
    let stranger = Address::generate(&e);
    // `allowed` names the gate's own perimeter; the adapter adds the gate.
    let allowed = Vec::from_array(&e, [custody.clone(), prime.clone()]);
    let gate = e.register(FixtureGate, (allowed, custody.clone()));
    let adapter = e.register(ExecutionAdapter, (prime.clone(), gate.clone()));
    World { e, adapter, gate, prime, custody, stranger }
}

fn call_to(e: &Env, target: &Address, f: &str, args: Vec<Val>) -> Call {
    Call {
        target: target.clone(),
        function_name: Symbol::new(e, f),
        args,
        executor_authorizations: Vec::new(e),
    }
}

type Outcome = Result<
    Result<(), soroban_sdk::ConversionError>,
    Result<soroban_sdk::Error, soroban_sdk::InvokeError>,
>;

fn run(w: &World, calls: Vec<Call>) -> Outcome {
    ExecutionAdapterClient::new(&w.e, &w.adapter).try_execute(&calls, &Vec::new(&w.e))
}

fn refused(w: &World, calls: Vec<Call>, want: E) {
    match run(w, calls) {
        Err(Ok(got)) => assert_eq!(got, soroban_sdk::Error::from_contract_error(want as u32)),
        other => panic!("expected {:?}, permitted: {}", want, other.is_ok()),
    }
}

#[test]
fn permits_a_call_to_the_gate_itself() {
    let w = world();
    let calls = Vec::from_array(&w.e, [call_to(&w.e, &w.gate, "ping", Vec::new(&w.e))]);
    assert!(run(&w, calls).is_ok());
}

#[test]
fn refuses_an_unlisted_target() {
    let w = world();
    let calls = Vec::from_array(&w.e, [call_to(&w.e, &w.stranger, "ping", Vec::new(&w.e))]);
    refused(&w, calls, E::AddressNotAllowed);
}

#[test]
fn refuses_the_prime_as_a_target() {
    let w = world();
    // The Prime is on the perimeter, so only the dedicated check can refuse it.
    let calls = Vec::from_array(&w.e, [call_to(&w.e, &w.prime, "ping", Vec::new(&w.e))]);
    refused(&w, calls, E::PrimeTarget);
}

#[test]
fn refuses_a_stranger_in_an_argument() {
    let w = world();
    let args = Vec::from_array(&w.e, [w.stranger.to_val()]);
    let calls = Vec::from_array(&w.e, [call_to(&w.e, &w.gate, if args.len() == 2 { "two" } else { "one" }, args)]);
    refused(&w, calls, E::AddressNotAllowed);
}

#[test]
fn refuses_a_stranger_buried_in_a_nested_argument() {
    let w = world();
    let inner: Vec<Val> = Vec::from_array(&w.e, [w.stranger.to_val()]);
    let mid: Vec<Val> = Vec::from_array(&w.e, [inner.into_val(&w.e)]);
    let args = Vec::from_array(&w.e, [mid.into_val(&w.e)]);
    refused(&w, Vec::from_array(&w.e, [call_to(&w.e, &w.gate, if args.len() == 2 { "two" } else { "one" }, args)]), E::AddressNotAllowed);
}

#[test]
fn refuses_a_stranger_written_as_a_strkey() {
    let w = world();
    let args = Vec::from_array(&w.e, [w.stranger.to_string().to_val()]);
    refused(&w, Vec::from_array(&w.e, [call_to(&w.e, &w.gate, if args.len() == 2 { "two" } else { "one" }, args)]), E::AddressNotAllowed);
}

#[test]
fn permits_an_allowed_address_written_as_a_strkey() {
    let w = world();
    let args = Vec::from_array(&w.e, [w.custody.to_string().to_val()]);
    assert!(run(&w, Vec::from_array(&w.e, [call_to(&w.e, &w.gate, if args.len() == 2 { "two" } else { "one" }, args)])).is_ok());
}

#[test]
fn permits_data_that_cannot_denote_an_address() {
    let w = world();
    let blob = Bytes::from_array(&w.e, &[7u8; 64]);
    let note = SString::from_str(&w.e, "settlement 42");
    let args = Vec::from_array(&w.e, [blob.to_val(), note.to_val()]);
    assert!(run(&w, Vec::from_array(&w.e, [call_to(&w.e, &w.gate, if args.len() == 2 { "two" } else { "one" }, args)])).is_ok());
}

#[test]
fn refuses_an_authorization_it_cannot_check() {
    let w = world();
    let deploy = InvokerContractAuthEntry::CreateContractHostFn(
        soroban_sdk::auth::CreateContractHostFnContext {
            executable: soroban_sdk::auth::ContractExecutable::Wasm(
                soroban_sdk::BytesN::from_array(&w.e, &[0u8; 32]),
            ),
            salt: soroban_sdk::BytesN::from_array(&w.e, &[1u8; 32]),
        },
    );
    let mut c = call_to(&w.e, &w.gate, "ping", Vec::new(&w.e));
    c.executor_authorizations = Vec::from_array(&w.e, [deploy]);
    refused(&w, Vec::from_array(&w.e, [c]), E::Uncheckable);
}

#[test]
fn the_binding_moves_only_with_the_gate_custody() {
    let w = world();
    let allowed = Vec::from_array(&w.e, [w.custody.clone()]);
    let successor = w.e.register(FixtureGate, (allowed, w.custody.clone()));
    ExecutionAdapterClient::new(&w.e, &w.adapter).rebind(&successor);
    let bound: Address = w.e.as_contract(&w.adapter, || {
        w.e.storage().instance().get(&symbol_short!("gate")).unwrap()
    });
    assert_eq!(bound, successor);
}

#[test]
fn the_deployment_convention_derives_the_address_custody_names() {
    // Tooling computes this; the contract no longer asserts it, but the
    // formula is the one the gate's `caller` has to be set to.
    let e = Env::default();
    let prime = Address::generate(&e);
    let gate = Address::generate(&e);
    let mut b = Bytes::from_slice(&e, b"prime.execution.adapter.v3");
    b.append(&gate.clone().to_xdr(&e));
    let derived = e
        .deployer()
        .with_address(prime.clone(), e.crypto().sha256(&b))
        .deployed_address();
    assert_ne!(derived, prime);
}
