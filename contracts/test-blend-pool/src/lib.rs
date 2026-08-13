#![no_std]

//! A Blend-`submit`-shaped stub for TESTNET VERIFICATION ONLY.
//!
//! See ../Cargo.toml for the rationale. Two deployed instances play the
//! role of "real Blend" and "evil twin" in the SCENARIO B integration
//! test - same `submit` shape, different target contract, so the
//! interpreter's `eq(call_contract, ...)` constraint is what
//! distinguishes PERMIT from DENY.

extern crate alloc;

use soroban_sdk::{contract, contractimpl, contracttype, Address, Env, Vec};

/// Mirrors Blend's `Request` struct: the field set and types are exactly
/// what the recorded Blend `submit` call carries, so the interpreter's
/// `call_arg_field(index, element, field)` leaves bind cleanly.
#[contracttype]
#[derive(Clone, Debug)]
pub struct Request {
    pub address: Address,
    pub amount: i128,
    pub request_type: u32,
}

#[contract]
pub struct TestBlendPool;

#[contractimpl]
impl TestBlendPool {
    /// Blend-shaped `submit(from, spender, to, requests)`.
    ///
    /// The `from.require_auth()` call is the point: the OZ smart account
    /// test path needs a target whose call generates an auth context the
    /// account's `__check_auth` -> interpreter.enforce sees. Without it
    /// no policy is consulted and the test would pass for the wrong
    /// reason. We do NOT move tokens; the stub returns Void.
    pub fn submit(
        e: &Env,
        from: Address,
        _spender: Address,
        _to: Address,
        _requests: Vec<Request>,
    ) {
        from.require_auth();
        // The real Blend emits events for each request; we skip that here
        // because nothing in the test relies on it and no_std alloc
        // pressure is not a concern for a 2-deploy test fixture.
        let _ = e;
    }
}
