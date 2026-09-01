#![no_std]

//! A Blend-`submit`-shaped stub for TESTNET VERIFICATION ONLY.
//!
//! See ../Cargo.toml for the rationale. Two deployed instances play the
//! role of "real Blend" and "evil twin" in the SCENARIO B integration
//! test - same `submit` shape, different target contract, so the
//! interpreter's `eq(call_contract, ...)` constraint is what
//! distinguishes PERMIT from DENY.

extern crate alloc;

use soroban_sdk::{contract, contractimpl, contracttype, token, Address, Env, Vec};

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
    /// reason.
    ///
    /// Each request then pulls its own token, which is what makes the auth
    /// tree match a real Blend supply: `submit` on the pool with a nested
    /// `transfer` on the token, two contexts rather than one. Decoding the
    /// mainnet envelopes shows exactly that shape, and the nested transfer
    /// is the context an OZ `spending_limit` on a token-scoped rule meters
    /// - a spend cap cannot sit on this pool's own rule, because the
    /// built-in refuses any call not named `transfer`.
    ///
    /// An empty request vector moves nothing, so a caller that only wants
    /// an auth context to exist can still get one without holding a
    /// balance. Every request is treated as a supply-style pull; the stub
    /// does not interpret `request_type`.
    pub fn submit(e: &Env, from: Address, _spender: Address, _to: Address, requests: Vec<Request>) {
        from.require_auth();
        let pool = e.current_contract_address();
        for request in requests.iter() {
            token::TokenClient::new(e, &request.address).transfer(&from, &pool, &request.amount);
        }
    }
}
