//! prime-session: a session key for a Prime Account on Stellar, granted by one authorization of its owner.
//!
//! An instance belongs to one wallet and is a `Delegated` signer of that wallet's session rules only, never of
//! the account's 2-of-3 rule: a session key can make the moves its rules allow and can never vote as a seat.
//! The owner is a Stellar account: Freighter's own (`signAuthEntry`), or a G account whose key is held by the
//! NEAR MPC for MetaMask and Phantom under the path `prime:stellar-session`, which no seat vote uses.
//!
//! `grant(key, until)` needs the owner's ordinary Soroban authorization, so the host's nonce and signature
//! expiry stop replays and the entry binds the network, this contract, the key and the ledger. It stores `until`
//! in temporary storage whose TTL ends at `until`. Revoking is `grant(key, 0)`: it keeps its entry for the
//! network's maximum TTL, and while that entry lives no later grant of the key is accepted, so a signed entry
//! that was held back cannot bring the key back.
//!
//! Proof: (session key, session key's signature of the payload). Refused: no live grant, expired, more than 7
//! days ahead, or a grant of a revoked key (contract error 1); a bad signature (trap).
#![no_std]

use soroban_sdk::{auth::*, crypto::*};
use soroban_sdk::{contract, contractimpl, Address, BytesN, Env, Error, Vec};

#[contract]
pub struct PrimeSession;

#[contractimpl]
impl PrimeSession {
    pub fn __constructor(e: Env, owner: Address) {
        e.storage().instance().set(&0u32, &owner);
    }

    /// Starts, extends, shortens or (with a past ledger) ends a session; at most 120,960 ledgers (7 days) ahead.
    pub fn grant(e: Env, key: BytesN<32>, until: u32) -> Result<(), Error> {
        e.storage().instance().get::<u32, Address>(&0).unwrap().require_auth();
        let ttl = until.saturating_sub(e.ledger().sequence());
        if ttl > 120_960 || (until != 0 && e.storage().temporary().get(&key) == Some(0u32)) {
            return Err(Error::from_contract_error(1));
        }
        e.storage().temporary().set(&key, &until);
        let ttl = if until == 0 { e.storage().max_ttl() } else { ttl };
        e.storage().temporary().extend_ttl(&key, ttl, ttl);
        Ok(())
    }
}

#[contractimpl]
impl CustomAccountInterface for PrimeSession {
    type Signature = (BytesN<32>, BytesN<64>);
    type Error = Error;

    fn __check_auth(e: Env, payload: Hash<32>, p: Self::Signature, _c: Vec<Context>) -> Result<(), Error> {
        let (key, sig) = p;
        if e.storage().temporary().get(&key).unwrap_or(0u32) < e.ledger().sequence() {
            return Err(Error::from_contract_error(1));
        }
        e.crypto().ed25519_verify(&key, &payload.into(), &sig);
        Ok(())
    }
}

#[cfg(test)]
mod test;
