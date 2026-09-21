#![no_std]
//! Invoker-auth probe. Three questions, asked on live testnet:
//!
//!   T1  Is `spender.require_auth()` inside `transfer_from` satisfied for free
//!       when the SPENDER is the contract making the call?
//!       -> decides whether CustodyGate can hold the allowance.
//!
//!   T2  Is `caller.require_auth()` satisfied for free when `caller` is the
//!       contract that invoked us?
//!       -> decides whether the gate can gate on "only the adapter may call me",
//!          and whether the adapter can be the principal for venue calls.
//!
//!   T3  Does that same check actually REFUSE an address that did not authorize?
//!       -> proves T2 is not vacuous.

use soroban_sdk::{contract, contractimpl, token, vec, Address, Env, IntoVal, Symbol};

#[contract]
pub struct Probe;

#[contractimpl]
impl Probe {
    /// T1. This contract is the spender; no signature for it is supplied.
    pub fn pull(e: Env, token: Address, from: Address, to: Address, amount: i128) {
        token::Client::new(&e, &token).transfer_from(
            &e.current_contract_address(),
            &from,
            &to,
            &amount,
        );
    }

    /// T2 / T3. Demands authorization from `caller`.
    pub fn gated(e: Env, caller: Address) -> u32 {
        let _ = &e;
        caller.require_auth();
        7
    }

    /// T2. Calls `peer.gated(self)`. If the invoker rule holds this needs no signature.
    pub fn go(e: Env, peer: Address) -> u32 {
        let me: Address = e.current_contract_address();
        e.invoke_contract::<u32>(&peer, &Symbol::new(&e, "gated"), vec![&e, me.into_val(&e)])
    }
}
