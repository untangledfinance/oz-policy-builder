#![no_std]
// TEST FIXTURE ONLY: real Blend tests use the public testnet pool separately.
use soroban_sdk::{contract, contractimpl, symbol_short, Address, Env};
#[contract]
pub struct TestVenue;
#[contractimpl]
impl TestVenue {
    pub fn __constructor(e: Env, admin: Address) {
        e.storage().instance().set(&symbol_short!("admin"), &admin);
    }
    pub fn set_fail(e: Env, enabled: bool) {
        let a: Address = e.storage().instance().get(&symbol_short!("admin")).unwrap();
        a.require_auth();
        e.storage().instance().set(&symbol_short!("fail"), &enabled);
    }
    pub fn act(e: Env, prime: Address, value: u32) -> u32 {
        prime.require_auth();
        assert!(
            !e.storage()
                .instance()
                .get(&symbol_short!("fail"))
                .unwrap_or(false),
            "deliberate venue failure"
        );
        e.storage().instance().set(&symbol_short!("value"), &value);
        value
    }
    pub fn get(e: Env) -> u32 {
        e.storage()
            .instance()
            .get(&symbol_short!("value"))
            .unwrap_or(0)
    }
}
