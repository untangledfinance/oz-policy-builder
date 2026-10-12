//! prime-seat: one NEAR-routed owner's seat on one Prime Account, and that owner's session keys.
//!
//! The owner is an ed25519 key the NEAR MPC signs with. It never signs a vote. It signs a grant that names this
//! seat, the account and a session key, and the seat then votes and acts through that key while the grant is live.
//! Both entry points take a live key's signature over `sha256(seat || digest)`, so one signature serves one seat only.
//!
//! The deployed OZ account hashes `sha256(payload || XDR(rule ids))`. Each proof carries that preimage, and the seat
//! reads the rule ids from it: `External(seat, account id)` in `verify` serves rule 0 only, `Delegated(seat)` in
//! `__check_auth` serves rules other than 0 only, and only for the pinned account's `__check_auth` frame.
//!
//! Grant: `sha256("prime-seat-grant" || network id || account || seat || key || be64 start || be64 end)`, 32-byte
//! contract ids, unix seconds. The owner signs it; with `end == 0` it is an end, and the key may sign it too.
//! Every grant entry lives for the maximum TTL; an end stores 0, so a revoked key never returns.
#![no_std]

use soroban_sdk::xdr::{FromXdr, ToXdr};
use soroban_sdk::{auth::*, contract, contractimpl, crypto::*, TryFromVal};
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

fn rules(e: &Env, pre: &Bytes, digest: &Bytes) -> Option<Vec<u32>> {
    if sha(e, pre) != *digest {
        return None;
    }
    Vec::from_xdr(e, &pre.slice(32..)).ok()
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
        let now = e.ledger().timestamp();
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
        m.append(&id(&e, &e.current_contract_address()));
        m.append(&key.clone().into());
        m.extend_from_array(&start.to_be_bytes());
        m.extend_from_array(&end.to_be_bytes());
        e.crypto().ed25519_verify(&by, &sha(&e, &m), &sig);
        t.set(&key, &end);
        t.extend_ttl(&key, e.storage().max_ttl(), e.storage().max_ttl());
        Ok(())
    }

    /// The `External` signer interface for rule 0. Proof: a session key (32 bytes), its signature (64 bytes), then the
    /// preimage of `hash` (the account's payload and the XDR of its rule ids).
    pub fn verify(e: Env, hash: Bytes, key_data: Bytes, proof: Bytes) -> bool {
        let key = proof.slice(..32).try_into().ok().unwrap();
        let sig = proof.slice(32..96).try_into().ok().unwrap();
        let rule0 = rules(&e, &proof.slice(96..), &hash).is_some_and(|r| r.iter().all(|i| i == 0));
        key_data == cfg(&e).0 && rule0 && signed(&e, &key, &sig, hash).is_ok()
    }

    pub fn batch_canonicalize_key(e: Env, keys: Vec<Bytes>) -> Vec<Bytes> {
        Vec::from_iter(&e, keys.iter().map(|_| Bytes::new(&e)))
    }
}

#[contractimpl]
impl CustomAccountInterface for PrimeSeat {
    type Signature = (BytesN<32>, BytesN<64>, Bytes);
    type Error = Error;

    fn __check_auth(
        e: Env,
        payload: Hash<32>,
        p: Self::Signature,
        c: Vec<Context>,
    ) -> Result<(), Error> {
        let Some(Context::Contract(x)) = c.get(0) else {
            return Err(NO);
        };
        let digest = Bytes::try_from_val(&e, &x.args.get(0).ok_or(NO)?).map_err(|_| NO)?;
        let moved = rules(&e, &p.2, &digest).is_some_and(|r| r.iter().all(|i| i != 0));
        if id(&e, &x.contract) != cfg(&e).0 || !moved {
            return Err(NO);
        }
        signed(&e, &p.0, &p.1, payload.into())
    }
}

#[cfg(test)]
mod test;
