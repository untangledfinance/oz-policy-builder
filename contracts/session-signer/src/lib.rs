//! A session key for a Prime Account, granted by the owner's wallet.
//!
//! The owner is one of (v3):
//! - `Evm(address)`: MetaMask and other EVM wallets sign EIP-712 `PrimeSession` data;
//! - `Stellar(ed25519 key)`: Freighter and other Stellar wallets sign the grant text with SEP-53
//!   (`signMessage`: ed25519 over sha256("Stellar Signed Message:\n" || text));
//! - `Solana(ed25519 key)`: Phantom and other Solana wallets sign the grant text with `signMessage`
//!   (ed25519 over the UTF-8 text itself).
//! The grant text names this instance, the key, the last ledger and the network:
//! "Prime session\ncontract: C…\nsession key: <hex>\nvalid until ledger: <n>\nnetwork: <hex>".
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
use soroban_sdk::{contract, contractimpl, contracttype, Bytes, BytesN, Env, Error, Vec, U256};

type Proof = (BytesN<32>, u32, BytesN<64>, u32, BytesN<64>);

/// keccak256("PrimeSession(string signer,bytes32 sessionKey,uint32 validUntil,bytes32 network)")
const TYPEHASH: &[u8; 32] = b"\xd3\x30\x7a\x53\x43\x72\x29\x4a\x6d\x42\x57\x2a\xe2\x52\x41\x28\xd1\x5a\x5d\x8a\xfa\x63\x83\x9c\x65\x69\x73\xa0\xd6\xdc\xab\x5f";
/// 0x1901 || keccak256 of EIP712Domain(string name,string version) = {"Prime Session", "1"}.
const PREFIX: &[u8; 34] = b"\x19\x01\xad\x8e\x3c\xd0\xa4\x53\x07\x09\x17\xe7\xab\x97\x2d\x4e\x0c\x8d\xa9\xd6\x89\xce\x2d\x56\xf6\x2d\x93\xb3\x55\x12\x11\x9d\x62\x62";

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

/// True when the owner granted `key` until ledger `until` on this instance and network.
/// EVM: (`rs`, `v`) recovers to the owner over the EIP-712 digest
/// keccak256(PREFIX || keccak256(TYPEHASH || keccak256(this contract's strkey)
/// || key || uint256(until) || network id)).
/// Stellar / Solana: `rs` is the ed25519 signature over the grant text (SEP-53 prehashed for
/// Stellar); `v` is unused. A bad ed25519 signature traps (the host's verify panics).
fn by_owner(e: &Env, key: &BytesN<32>, until: u32, rs: &BytesN<64>, v: u32) -> bool {
    let c = e.crypto();
    match e.storage().instance().get::<_, Owner>(&0u32).unwrap() {
        Owner::Evm(owner) => {
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
            signer.to_array()[12..] == owner.to_array()
        }
        Owner::Stellar(pk) => {
            let mut m = Bytes::from_slice(e, b"Stellar Signed Message:\n");
            m.append(&grant_text(e, key, until));
            c.ed25519_verify(&pk, &c.sha256(&m).into(), rs);
            true
        }
        Owner::Solana(pk) => {
            c.ed25519_verify(&pk, &grant_text(e, key, until), rs);
            true
        }
    }
}

/// The readable grant the Stellar and Solana wallets sign.
pub fn grant_text(e: &Env, key: &BytesN<32>, until: u32) -> Bytes {
    let mut t = Bytes::from_slice(e, b"Prime session\ncontract: ");
    t.append(&e.current_contract_address().to_string().to_bytes());
    t.append(&Bytes::from_slice(e, b"\nsession key: "));
    t.append(&hex(e, &key.to_array()));
    t.append(&Bytes::from_slice(e, b"\nvalid until ledger: "));
    let mut d = [0u8; 10];
    let mut n = until;
    let mut i = d.len();
    loop {
        i -= 1;
        d[i] = b'0' + (n % 10) as u8;
        n /= 10;
        if n == 0 {
            break;
        }
    }
    t.append(&Bytes::from_slice(e, &d[i..]));
    t.append(&Bytes::from_slice(e, b"\nnetwork: "));
    t.append(&hex(e, &e.ledger().network_id().to_array()));
    t
}

fn hex(e: &Env, b: &[u8; 32]) -> Bytes {
    const H: &[u8; 16] = b"0123456789abcdef";
    let mut o = [0u8; 64];
    for (i, x) in b.iter().enumerate() {
        o[2 * i] = H[(x >> 4) as usize];
        o[2 * i + 1] = H[(x & 15) as usize];
    }
    Bytes::from_array(e, &o)
}

#[cfg(test)]
mod test;
