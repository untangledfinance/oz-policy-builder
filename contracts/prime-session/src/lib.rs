//! prime-session: a session key for a Prime Account on Stellar, granted by one SEP-53 signature of its owner.
//!
//! An instance belongs to one wallet and is a `Delegated` signer of that wallet's session rules only, never of
//! the account's 2-of-3 rule: a session key can make the moves its rules allow and can never vote as a seat.
//! The owner is an ed25519 key that signs SEP-53 messages: Freighter's own key (`signMessage`), or a NEAR MPC key
//! held for MetaMask (its eth-implicit NEAR account) or Phantom (through prime-near-signer); the MPC signs the
//! SEP-53 digest.
//!
//! grant text: "Prime session\ncontract: <this contract>\nsession key: <hex>\nvalid until ledger (hex): <8 hex digits>"
//! (the contract address already commits to the network). Revoking is the same text with ledger 0. The owner signs
//! SEP-53: ed25519 over sha256("Stellar Signed Message:\n" + text).
//!
//! Proof: (session key, valid until, owner's SEP-53 signature of the grant text, session key's signature of the
//! payload). Refused: expired or more than 7 days ahead (contract error 1), revoked (2), a bad signature (trap).
#![no_std]

use soroban_sdk::{auth::*, crypto::*};
use soroban_sdk::{contract, contractimpl, Bytes, BytesN, Env, Error, Vec};

#[contract]
pub struct PrimeSession;

#[contractimpl]
impl PrimeSession {
    pub fn __constructor(e: Env, owner: BytesN<32>) {
        e.storage().instance().set(&0u32, &owner);
    }

    pub fn revoke(e: Env, key: BytesN<32>, owner_sig: BytesN<64>) {
        by_owner(&e, &key, 0, &owner_sig);
        e.storage().persistent().set(&key, &());
    }
}

#[contractimpl]
impl CustomAccountInterface for PrimeSession {
    type Signature = (BytesN<32>, u32, BytesN<64>, BytesN<64>);
    type Error = Error;

    fn __check_auth(e: Env, payload: Hash<32>, p: Self::Signature, _c: Vec<Context>) -> Result<(), Error> {
        let (key, until, owner_sig, sig) = p;
        let now = e.ledger().sequence();
        if now > until || until > now + 120_960 {
            return Err(Error::from_contract_error(1));
        }
        if e.storage().persistent().has(&key) {
            return Err(Error::from_contract_error(2));
        }
        by_owner(&e, &key, until, &owner_sig);
        e.crypto().ed25519_verify(&key, &payload.into(), &sig);
        Ok(())
    }
}

/// Traps unless the owner signed the SEP-53 message of the grant text for `key` and `until`.
fn by_owner(e: &Env, key: &BytesN<32>, until: u32, owner_sig: &BytesN<64>) {
    let owner: BytesN<32> = e.storage().instance().get(&0u32).unwrap();
    e.crypto().ed25519_verify(&owner, &e.crypto().sha256(&grant_message(e, key, until)).into(), owner_sig);
}

/// "Stellar Signed Message:\n" + grant text.
pub fn grant_message(e: &Env, key: &BytesN<32>, until: u32) -> Bytes {
    let mut t = Bytes::from_slice(e, b"Stellar Signed Message:\nPrime session\ncontract: ");
    t.append(&e.current_contract_address().to_string().to_bytes());
    t.append(&Bytes::from_slice(e, b"\nsession key: "));
    hex(&mut t, &key.to_array());
    t.append(&Bytes::from_slice(e, b"\nvalid until ledger (hex): "));
    hex(&mut t, &until.to_be_bytes());
    t
}

fn hex(t: &mut Bytes, b: &[u8]) {
    for x in b {
        t.push_back(b"0123456789abcdef"[(x >> 4) as usize]);
        t.push_back(b"0123456789abcdef"[(x & 15) as usize]);
    }
}

#[cfg(test)]
mod test;
