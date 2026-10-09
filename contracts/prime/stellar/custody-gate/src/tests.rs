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
        allowed: Vec::from_array(&e, [custody.clone()]),
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
