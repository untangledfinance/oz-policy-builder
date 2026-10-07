//! A session key for a Prime Account on Stellar, granted by one SEP-53 signature of its owner.
//!
//! An instance belongs to one wallet and is a `Delegated` signer of that wallet's session rules only, never of
//! the account's 2-of-3 rule: a session key can make the moves its rules allow and can never vote as a seat.
//! The owner is an ed25519 key that signs SEP-53 messages: Freighter's own key (`signMessage`), or the NEAR MPC
//! key of a MetaMask / Phantom NEAR account (the MPC signs the SEP-53 digest).
//!
//! grant text: "Prime session\ncontract: <this contract>\nsession key: <hex>\nvalid until ledger: <n>"
//! (the contract address already commits to the network). Revoking is the same text with ledger 0.
//!
//! Proof: (session key, valid until, owner's SEP-53 signature of the grant text, session key's signature of the
//! payload). Refused: expired or more than 7 days ahead (contract error 1), revoked (2), a bad signature (trap).
#![no_std]

use soroban_sdk::{auth::*, crypto::*};
use soroban_sdk::{contract, contractimpl, Bytes, BytesN, Env, Error, Vec};

type Proof = (BytesN<32>, u32, BytesN<64>, BytesN<64>);

#[contract]
pub struct SessionSigner;

#[contractimpl]
impl SessionSigner {
    pub fn __constructor(e: Env, owner: BytesN<32>) {
        e.storage().instance().set(&0u32, &owner);
    }

    pub fn revoke(e: Env, key: BytesN<32>, owner_sig: BytesN<64>) {
        by_owner(&e, &key, 0, &owner_sig);
        e.storage().persistent().set(&key, &());
    }
}

#[contractimpl]
impl CustomAccountInterface for SessionSigner {
    type Signature = Proof;
    type Error = Error;

    fn __check_auth(e: Env, payload: Hash<32>, p: Proof, _c: Vec<Context>) -> Result<(), Error> {
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
    let mut m = Bytes::from_slice(e, b"Stellar Signed Message:\n");
    m.append(&grant_text(e, key, until));
    let owner: BytesN<32> = e.storage().instance().get(&0u32).unwrap();
    e.crypto().ed25519_verify(&owner, &e.crypto().sha256(&m).into(), owner_sig);
}

pub fn grant_text(e: &Env, key: &BytesN<32>, until: u32) -> Bytes {
    let mut t = Bytes::from_slice(e, b"Prime session\ncontract: ");
    t.append(&e.current_contract_address().to_string().to_bytes());
    t.append(&Bytes::from_slice(e, b"\nsession key: "));
    let mut h = [0u8; 64];
    for (i, x) in key.to_array().iter().enumerate() {
        h[2 * i] = b"0123456789abcdef"[(x >> 4) as usize];
        h[2 * i + 1] = b"0123456789abcdef"[(x & 15) as usize];
    }
    t.append(&Bytes::from_array(e, &h));
    t.append(&Bytes::from_slice(e, b"\nvalid until ledger: "));
    let (mut d, mut i, mut n) = ([0u8; 10], 10, until);
    loop {
        i -= 1;
        d[i] = b'0' + (n % 10) as u8;
        n /= 10;
        if n == 0 {
            break;
        }
    }
    t.append(&Bytes::from_slice(e, &d[i..]));
    t
}

#[cfg(test)]
mod test;
