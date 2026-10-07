//! A session key for a Prime Account, granted by the owner's wallet with one readable message.
//!
//! An instance is a `Delegated` signer of the account (its seat, and its session rules). The owner
//! signs the grant text with their own wallet:
//! - `Evm(address)`: MetaMask `personal_sign` (EIP-191);
//! - `Stellar(key)`: Freighter `signMessage` (SEP-53: ed25519 over sha256 of the prefixed text);
//! - `Solana(key)`: Phantom `signMessage` (ed25519 over the text).
//!
//! grant text: "Prime session\ncontract: <this contract>\nsession key: <hex>\nvalid until ledger: <n>\nnetwork: <hex>"
//!
//! The proof is `(session_key, valid_until, rs, v, session_sig)`: `rs`/`v` is the owner's signature
//! (`v` only for EVM), `session_sig` the key's signature over the authorisation payload. Refused, with
//! the contract error: expired or more than 7 days ahead (1), revoked (2), not signed by the owner (3).
//! `revoke` ends a session for good: the owner's signature over the grant text with ledger 0.
#![no_std]

use soroban_sdk::{auth::*, crypto::*};
use soroban_sdk::{contract, contractimpl, contracttype, Bytes, BytesN, Env, Error, Vec};

type Proof = (BytesN<32>, u32, BytesN<64>, u32, BytesN<64>);

#[contracttype]
#[derive(Clone)]
pub enum Owner {
    Evm(BytesN<20>),
    Stellar(BytesN<32>),
    Solana(BytesN<32>),
}

#[contract]
pub struct SessionSigner;

#[contractimpl]
impl SessionSigner {
    pub fn __constructor(e: Env, owner: Owner) {
        e.storage().instance().set(&0u32, &owner);
    }

    pub fn revoke(e: Env, key: BytesN<32>, rs: BytesN<64>, v: u32) -> Result<(), Error> {
        need(by_owner(&e, &key, 0, &rs, v), 3).map(|_| e.storage().persistent().set(&key, &()))
    }
}

#[contractimpl]
impl CustomAccountInterface for SessionSigner {
    type Signature = Proof;
    type Error = Error;

    fn __check_auth(e: Env, payload: Hash<32>, p: Proof, _c: Vec<Context>) -> Result<(), Error> {
        let (key, until, rs, v, sig) = p;
        let now = e.ledger().sequence();
        need(now <= until && until <= now + 120_960, 1)?;
        need(!e.storage().persistent().has(&key), 2)?;
        need(by_owner(&e, &key, until, &rs, v), 3)?;
        e.crypto().ed25519_verify(&key, &payload.into(), &sig);
        Ok(())
    }
}

fn need(ok: bool, code: u32) -> Result<(), Error> {
    ok.then_some(()).ok_or(Error::from_contract_error(code))
}

/// True when the owner signed the grant text for `key` and `until`. A bad ed25519 signature traps.
fn by_owner(e: &Env, key: &BytesN<32>, until: u32, rs: &BytesN<64>, v: u32) -> bool {
    let (c, text) = (e.crypto(), grant_text(e, key, until));
    match e.storage().instance().get::<_, Owner>(&0u32).unwrap() {
        Owner::Evm(owner) => {
            let mut m = Bytes::from_slice(e, b"\x19Ethereum Signed Message:\n");
            m.append(&dec(e, text.len()));
            m.append(&text);
            let pk = c.secp256k1_recover(&c.keccak256(&m), rs, v % 27);
            c.keccak256(&Bytes::from_slice(e, &pk.to_array()[1..])).to_array()[12..] == owner.to_array()
        }
        Owner::Stellar(pk) => {
            let mut m = Bytes::from_slice(e, b"Stellar Signed Message:\n");
            m.append(&text);
            c.ed25519_verify(&pk, &c.sha256(&m).into(), rs);
            true
        }
        Owner::Solana(pk) => {
            c.ed25519_verify(&pk, &text, rs);
            true
        }
    }
}

pub fn grant_text(e: &Env, key: &BytesN<32>, until: u32) -> Bytes {
    let mut t = Bytes::from_slice(e, b"Prime session\ncontract: ");
    t.append(&e.current_contract_address().to_string().to_bytes());
    t.append(&Bytes::from_slice(e, b"\nsession key: "));
    t.append(&hex(e, &key.to_array()));
    t.append(&Bytes::from_slice(e, b"\nvalid until ledger: "));
    t.append(&dec(e, until));
    t.append(&Bytes::from_slice(e, b"\nnetwork: "));
    t.append(&hex(e, &e.ledger().network_id().to_array()));
    t
}

fn hex(e: &Env, b: &[u8; 32]) -> Bytes {
    let mut o = [0u8; 64];
    for (i, x) in b.iter().enumerate() {
        o[2 * i] = b"0123456789abcdef"[(x >> 4) as usize];
        o[2 * i + 1] = b"0123456789abcdef"[(x & 15) as usize];
    }
    Bytes::from_array(e, &o)
}

fn dec(e: &Env, mut n: u32) -> Bytes {
    let (mut d, mut i) = ([0u8; 10], 10);
    loop {
        i -= 1;
        d[i] = b'0' + (n % 10) as u8;
        n /= 10;
        if n == 0 {
            return Bytes::from_slice(e, &d[i..]);
        }
    }
}

#[cfg(test)]
mod test;
