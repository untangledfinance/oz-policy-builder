//! prime-seat: one NEAR-routed owner's seat on one Prime Account, and that owner's session keys.
//!
//! The owner is an ed25519 key the NEAR MPC signs with. It never signs a vote. It signs a grant that names this
//! seat, the account and a session key, and the seat then votes and acts through that key while the grant is live.
//! `External(seat, account)` in rule 0 is served by `verify`, `Delegated(seat)` in a bounded rule by `__check_auth`.
//! Both take a live key's signature over `sha256(seat || digest)`, so one signature serves one seat only.
//!
//! Grant: `sha256("prime-seat-grant" || network id || account || seat || key || be64 start || be64 end)`, 32-byte
//! contract ids, unix seconds. The owner signs it; with `end == 0` it is an end, and the key may sign it too.
//! An end stores 0 for the maximum TTL, so a revoked key never returns.
#![no_std]

use soroban_sdk::{auth::*, contract, contractimpl, crypto::*, xdr::ToXdr};
use soroban_sdk::{Address, Bytes, BytesN, Env, Error, Vec};

const NO: Error = Error::from_contract_error(1);

#[contract]
pub struct PrimeSeat;

fn id(e: &Env, a: &Address) -> Bytes {
    a.clone().to_xdr(e).slice(8..)
}

fn cfg(e: &Env) -> (Bytes, BytesN<32>) {
    e.storage().instance().get(&0u32).unwrap()
}

fn sha(e: &Env, m: &Bytes) -> Bytes {
    e.crypto().sha256(m).into()
}

fn signed(e: &Env, key: &BytesN<32>, sig: &BytesN<64>, hash: Bytes) -> Result<(), Error> {
    let end: u64 = e.storage().temporary().get(key).unwrap_or(0);
    let mut m = id(e, &e.current_contract_address());
    m.append(&hash);
    if end < e.ledger().timestamp() {
        return Err(NO);
    }
    Ok(e.crypto().ed25519_verify(key, &sha(e, &m), sig))
}

#[contractimpl]
impl PrimeSeat {
    pub fn __constructor(e: Env, account: Address, owner: BytesN<32>) {
        let account = id(&e, &account);
        e.storage().instance().set(&0u32, &(account, owner));
    }

    pub fn grant(
        e: Env,
        key: BytesN<32>,
        start: u64,
        end: u64,
        by: BytesN<32>,
        sig: BytesN<64>,
    ) -> Result<(), Error> {
        let (account, owner) = cfg(&e);
        let (me, now) = (e.current_contract_address(), e.ledger().timestamp());
        let t = e.storage().temporary();
        let old: Option<u64> = t.get(&key);
        let timely = start <= now && now <= end && end - start <= 604_800;
        let fresh = old != Some(0) && old < Some(end);
        if (by != owner && (end != 0 || by != key)) || (end != 0 && !(timely && fresh)) {
            return Err(NO);
        }
        let mut m = Bytes::from_slice(&e, b"prime-seat-grant");
        m.append(&e.ledger().network_id().into());
        m.append(&account);
        m.append(&id(&e, &me));
        m.append(&key.clone().into());
        m.extend_from_array(&start.to_be_bytes());
        m.extend_from_array(&end.to_be_bytes());
        e.crypto().ed25519_verify(&by, &sha(&e, &m), &sig);
        let ttl = if end == 0 {
            e.storage().max_ttl()
        } else {
            ((end - now) / 4) as u32 + 1
        };
        t.set(&key, &end);
        t.extend_ttl(&key, ttl, ttl);
        if end != 0 {
            e.deployer().extend_ttl(me, ttl, ttl);
        }
        Ok(())
    }

    /// The `External` signer interface. Proof: a session key (32 bytes), then its signature (64 bytes).
    pub fn verify(e: Env, hash: Bytes, key_data: Bytes, proof: Bytes) -> bool {
        let key = proof.slice(..32).try_into().ok().unwrap();
        let sig = proof.slice(32..).try_into().ok().unwrap();
        key_data == cfg(&e).0 && signed(&e, &key, &sig, hash).is_ok()
    }

    pub fn batch_canonicalize_key(e: Env, keys: Vec<Bytes>) -> Vec<Bytes> {
        let mut out = Vec::new(&e);
        for _ in 0..keys.len() {
            out.push_back(Bytes::new(&e));
        }
        out
    }
}

#[contractimpl]
impl CustomAccountInterface for PrimeSeat {
    type Signature = (BytesN<32>, BytesN<64>);
    type Error = Error;

    fn __check_auth(
        e: Env,
        payload: Hash<32>,
        p: Self::Signature,
        _c: Vec<Context>,
    ) -> Result<(), Error> {
        signed(&e, &p.0, &p.1, payload.into())
    }
}

#[cfg(test)]
mod test;
