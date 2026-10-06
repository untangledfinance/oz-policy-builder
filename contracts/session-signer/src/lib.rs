//! A session key for a Prime Account, granted by an Ethereum wallet.
//!
//! The account's admins install an instance once, as the `Delegated` signer of
//! a context rule; the instance is bound to the wallet (`owner`). The wallet
//! grants a short-lived ed25519 key by signing EIP-712 `PrimeSession` data off
//! chain, naming THIS instance, and that key alone then authorises what the
//! rule allows until `validUntil`. Starting or renewing a session needs no
//! transaction and no NEAR signature.
//!
//! The proof is `(session_key, valid_until, rs, v, session_sig)`, where `rs`
//! and `v` split the wallet's 65-byte signature (the grant). It is
//! accepted only when, else the contract error in brackets:
//! - the ledger is at or before `valid_until`, at most 7 days ahead (1);
//! - the key has not been revoked (2);
//! - `grant` is the owner's EIP-712 signature over this instance, this
//!   network, the key and `valid_until` (3);
//! - `session_sig` is the key's signature over this authorisation's payload.
//!
//! `revoke` ends one session early: the owner signs the same data with
//! `validUntil` 0, which never authorises anything, and anyone may submit it.
//! A revoked key is a persistent entry: archiving does not drop it, because a
//! call that reads it must restore it first, so a revocation is permanent.
#![no_std]

use soroban_sdk::{auth::*, crypto::*};
use soroban_sdk::{contract, contractimpl, Bytes, BytesN, Env, Error, Vec, U256};

type Proof = (BytesN<32>, u32, BytesN<64>, u32, BytesN<64>);

/// keccak256("PrimeSession(string signer,bytes32 sessionKey,uint32 validUntil,bytes32 network)")
const TYPEHASH: &[u8; 32] = b"\xd3\x30\x7a\x53\x43\x72\x29\x4a\x6d\x42\x57\x2a\xe2\x52\x41\x28\xd1\x5a\x5d\x8a\xfa\x63\x83\x9c\x65\x69\x73\xa0\xd6\xdc\xab\x5f";
/// 0x1901 || keccak256 of EIP712Domain(string name,string version) = {"Prime Session", "1"}.
const PREFIX: &[u8; 34] = b"\x19\x01\xad\x8e\x3c\xd0\xa4\x53\x07\x09\x17\xe7\xab\x97\x2d\x4e\x0c\x8d\xa9\xd6\x89\xce\x2d\x56\xf6\x2d\x93\xb3\x55\x12\x11\x9d\x62\x62";

#[contract]
pub struct SessionSigner;

#[contractimpl]
impl SessionSigner {
    pub fn __constructor(e: Env, owner: BytesN<20>) {
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

/// True when (`rs`, `v`) is the owner's signature over the EIP-712 digest
/// keccak256(PREFIX || keccak256(TYPEHASH || keccak256(this contract's strkey)
/// || key || uint256(until) || network id)).
fn by_owner(e: &Env, key: &BytesN<32>, until: u32, rs: &BytesN<64>, v: u32) -> bool {
    let c = e.crypto();
    let me = e.current_contract_address().to_string().to_bytes();
    let mut s = Bytes::from_array(e, TYPEHASH);
    s.append(&c.keccak256(&me).into());
    s.append(&key.clone().into());
    s.append(&U256::from_u32(e, until).to_be_bytes());
    s.append(&e.ledger().network_id().into());
    let mut m = Bytes::from_array(e, PREFIX);
    m.append(&c.keccak256(&s).into());
    let pk = c.secp256k1_recover(&c.keccak256(&m), rs, v % 27);
    let signer = c.keccak256(&Bytes::from_slice(e, &pk.to_array()[1..]));
    let owner: BytesN<20> = e.storage().instance().get(&0u32).unwrap();
    signer.to_array()[12..] == owner.to_array()
}

#[cfg(test)]
mod test;
