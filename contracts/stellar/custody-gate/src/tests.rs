extern crate std;
use super::*;
use soroban_sdk::{testutils::Address as _, token::StellarAssetClient, BytesN, Env, IntoVal};

struct World {
    e: Env,
    gate: Address,
    token: Address,
    custody: Address,
    caller: Address,
    stranger: Address,
    /// On `allowed` so a grant may name it, but off `payees`: `pull` must not
    /// pay it. Stands in for the policy interpreter of F-2026-20150.
    interpreter: Address,
}

/// The caller is a real deployed contract, so `executable()` returns the hash
/// the gate is configured with.
#[contract]
pub struct Caller;
#[contractimpl]
impl Caller {
    pub fn draw(e: Env, gate: Address, token: Address, to: Address, amount: i128) {
        e.invoke_contract::<()>(
            &gate,
            &Symbol::new(&e, "pull"),
            soroban_sdk::vec![&e, token.into_val(&e), to.into_val(&e), amount.into_val(&e)],
        );
    }
}

fn world(wrong_build: bool) -> World {
    let e = Env::default();
    e.mock_all_auths();
    let custody = Address::generate(&e);
    let stranger = Address::generate(&e);
    let interpreter = Address::generate(&e);
    let caller = e.register(Caller, ());
    let sac = e.register_stellar_asset_contract_v2(custody.clone());
    let token = sac.address();
    StellarAssetClient::new(&e, &token).mint(&custody, &1_000_000);
    let real = match caller.executable() {
        Some(Executable::Wasm(h)) => h,
        _ => BytesN::from_array(&e, &[0u8; 32]),
    };
    let cfg = Cfg {
        custody: custody.clone(),
        caller: caller.clone(),
        caller_code: if wrong_build {
            BytesN::from_array(&e, &[9u8; 32])
        } else {
            real
        },
        // The interpreter is on the perimeter (a grant may name it) but not a
        // payee: `pull` must never pay it.
        allowed: Vec::from_array(&e, [custody.clone(), interpreter.clone()]),
        payees: Vec::from_array(&e, [custody.clone()]),
    };
    let gate = e.register(CustodyGate, (cfg,));
    token::Client::new(&e, &token).approve(&custody, &gate, &1_000_000, &10_000);
    World {
        e,
        gate,
        token,
        custody,
        caller,
        stranger,
        interpreter,
    }
}

#[test]
fn releases_to_a_listed_destination() {
    let w = world(false);
    CallerClient::new(&w.e, &w.caller).draw(&w.gate, &w.token, &w.custody, &1_000);
}

#[test]
fn refuses_a_destination_it_does_not_name() {
    let w = world(false);
    let r = CallerClient::new(&w.e, &w.caller).try_draw(&w.gate, &w.token, &w.stranger, &1_000);
    assert!(r.is_err(), "a stranger must not be a destination");
}

#[test]
fn refuses_a_caller_running_the_wrong_build() {
    let w = world(true);
    let r = CallerClient::new(&w.e, &w.caller).try_draw(&w.gate, &w.token, &w.custody, &1_000);
    assert!(r.is_err(), "only the approved build may draw");
}

/// F-2026-20150: an address on `allowed` but not on `payees` - the interpreter -
/// cannot be a `pull` destination, and nothing is drawn.
#[test]
fn refuses_a_payee_off_the_list_even_when_it_is_allowed() {
    let w = world(false);
    let allowed = CustodyGateClient::new(&w.e, &w.gate).allowed();
    assert!(
        allowed.contains(&w.interpreter),
        "the interpreter is on allowed"
    );
    let before = token::Client::new(&w.e, &w.token).balance(&w.custody);
    let r = CallerClient::new(&w.e, &w.caller).try_draw(&w.gate, &w.token, &w.interpreter, &1_000);
    assert!(r.is_err(), "an allowed non-payee must not be paid");
    assert_eq!(
        token::Client::new(&w.e, &w.token).balance(&w.interpreter),
        0
    );
    assert_eq!(
        token::Client::new(&w.e, &w.token).balance(&w.custody),
        before
    );
}

/// The two lists are read separately and the interpreter sits only on `allowed`.
#[test]
fn the_two_lists_are_distinct() {
    let w = world(false);
    let g = CustodyGateClient::new(&w.e, &w.gate);
    assert!(g.allowed().contains(&w.interpreter));
    assert!(!g.payees().contains(&w.interpreter));
    assert!(g.payees().contains(&w.custody));
}

/// The constructor refuses a payee that is not also on `allowed`, so the gate
/// can never hold a destination that could never pass the perimeter.
#[test]
fn the_constructor_refuses_a_payee_that_is_not_allowed() {
    let e = Env::default();
    e.mock_all_auths();
    let custody = Address::generate(&e);
    let stray = Address::generate(&e);
    let caller = e.register(Caller, ());
    let code = match caller.executable() {
        Some(Executable::Wasm(h)) => h,
        _ => BytesN::from_array(&e, &[0u8; 32]),
    };
    let cfg = Cfg {
        custody: custody.clone(),
        caller: caller.clone(),
        caller_code: code,
        allowed: Vec::from_array(&e, [custody.clone()]),
        payees: Vec::from_array(&e, [custody.clone(), stray.clone()]),
    };
    let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        e.register(CustodyGate, (cfg,))
    }));
    assert!(
        r.is_err(),
        "a payee off allowed must be refused at construction"
    );
}

/// A payee is paid; a stranger (on neither list) is still refused.
#[test]
fn a_listed_payee_is_paid_a_stranger_is_not() {
    let w = world(false);
    CallerClient::new(&w.e, &w.caller).draw(&w.gate, &w.token, &w.custody, &1_000);
    let r = CallerClient::new(&w.e, &w.caller).try_draw(&w.gate, &w.token, &w.stranger, &1_000);
    assert!(r.is_err(), "a stranger is on neither list");
    assert_eq!(token::Client::new(&w.e, &w.token).balance(&w.stranger), 0);
}
