//! prime-session as a seat: one contract per wallet is both its vote in rule 0 and its session key store.
//!
//! The wallet's session rules list `Delegated(this contract)`; `__check_auth` accepts any live session key, as
//! before. The wallet's rule-0 seat is `External(this contract, _)` and is served by `verify`: it accepts the
//! owner's own authorization (a nested `owner.require_auth_for_args`) or a live session key whose grant carries the
//! vote flag. A Delegated signer is told nothing about the rule it serves, and the policy-interpreter refuses
//! External signers on its rules, so the two entry points are what keeps a move-only key out of rule 0.
//!
//! `grant(key, until, vote)` needs the owner's Soroban authorization, so the flag is bound by the owner's signature
//! like the key and the end ledger. Revoking is `grant(key, 0, false)`: its entry lives for the network's maximum
//! TTL and refuses any later grant of the key.
#![no_std]

use soroban_sdk::{auth::*, crypto::*};
use soroban_sdk::{contract, contractimpl, Address, Bytes, BytesN, Env, Error, IntoVal, Vec};

#[contract]
pub struct PrimeSession;

fn live(e: &Env, key: &BytesN<32>, vote: bool) -> bool {
    let g = e.storage().temporary().get(key).unwrap_or(0u32);
    g & 0x7fff_ffff >= e.ledger().sequence() && (g >> 31 == 1 || !vote)
}

#[contractimpl]
impl PrimeSession {
    pub fn __constructor(e: Env, owner: Address) {
        e.storage().instance().set(&0u32, &owner);
    }

    /// Starts, extends, shortens or (with a past ledger) ends a session; at most 120,960 ledgers (7 days) ahead.
    pub fn grant(e: Env, key: BytesN<32>, until: u32, vote: bool) -> Result<(), Error> {
        e.storage().instance().get::<u32, Address>(&0).unwrap().require_auth();
        let ttl = until.saturating_sub(e.ledger().sequence());
        if ttl > 120_960 || (until != 0 && e.storage().temporary().get(&key) == Some(0u32)) {
            return Err(Error::from_contract_error(1));
        }
        e.storage().temporary().set(&key, &if until == 0 { 0 } else { until | (vote as u32) << 31 });
        let ttl = if until == 0 { e.storage().max_ttl() } else { ttl };
        e.storage().temporary().extend_ttl(&key, ttl, ttl);
        Ok(())
    }

    /// The `External` signer interface, the seat in rule 0. Proof: empty (the owner authorizes) or session key (32 bytes) then its signature of the digest (64 bytes).
    pub fn verify(e: Env, hash: Bytes, _key_data: Bytes, proof: Bytes) -> bool {
        if proof.is_empty() {
            e.storage().instance().get::<u32, Address>(&0).unwrap().require_auth_for_args((hash,).into_val(&e));
            return true;
        }
        let (key, sig) = (BytesN::try_from(proof.slice(..32)).unwrap(), BytesN::try_from(proof.slice(32..)).unwrap());
        live(&e, &key, true) && { e.crypto().ed25519_verify(&key, &hash, &sig); true }
    }

    pub fn batch_canonicalize_key(_e: Env, keys: Vec<Bytes>) -> Vec<Bytes> {
        keys
    }
}

#[contractimpl]
impl CustomAccountInterface for PrimeSession {
    type Signature = (BytesN<32>, BytesN<64>);
    type Error = Error;

    fn __check_auth(e: Env, payload: Hash<32>, p: Self::Signature, _c: Vec<Context>) -> Result<(), Error> {
        if !live(&e, &p.0, false) {
            return Err(Error::from_contract_error(1));
        }
        e.crypto().ed25519_verify(&p.0, &payload.into(), &p.1);
        Ok(())
    }
}

#[cfg(test)]
mod test;
