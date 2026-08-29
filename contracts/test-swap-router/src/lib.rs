#![no_std]

//! A swap-shaped stub for TESTNET VERIFICATION ONLY.
//!
//! See ../Cargo.toml for the rationale, including the correction that SoroSwap
//! DOES publish a testnet router. One deployed instance gives the slippage-floor
//! predicate something to bind against on chain, so `out >= in * num/den` can be
//! evidenced by a submitted transaction rather than only by the deny-case
//! harness - without depending on a pool's price holding still.

use soroban_sdk::{contract, contractimpl, Address, Env};

#[contract]
pub struct TestSwapRouter;

#[contractimpl]
impl TestSwapRouter {
    /// `swap(amount_in, amount_out, to)`.
    ///
    /// The argument ORDER is the contract here: the predicate reads the input
    /// at index 0 and the output at index 1, so a stub that took them the other
    /// way round would make the floor pass while bounding the wrong number.
    ///
    /// `to.require_auth()` produces the auth context the account's
    /// `__check_auth` hands to the interpreter. Without it nothing would be
    /// evaluated and the call would be permitted for the wrong reason.
    pub fn swap(e: &Env, amount_in: i128, amount_out: i128, to: Address) {
        to.require_auth();
        let _ = (e, amount_in, amount_out);
    }
}
