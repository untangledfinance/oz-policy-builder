//! Prime seat: one NEAR-routed owner's seat on one Prime Account, and that owner's session keys.
//!
//! The owner is an ed25519 key the NEAR MPC signs with. It never signs a vote. It signs a grant that names this
//! seat, the account and a session key, and the seat then votes and acts through that key while the grant is live.
//! Both entry points take a live key's signature over `sha256(seat || digest)`, so one signature serves one seat only.
//!
//! The deployed OZ account hashes `sha256(payload || XDR(rule ids))`. Each proof carries that preimage, and the seat
//! reads the rule ids from it: `External(seat, account id)` in `verify` serves rule 0 only, `Delegated(seat)` in
//! `__check_auth` serves rules other than 0 only, and only when the first context targets the pinned account
//! with the digest as its first argument; it reads no function name and no later context.
//!
//! Grant: `sha256("prime-seat-grant" || network id || account || seat || key || be64 start || be64 end
//! || be32 generation when that generation is above zero)`, 32-byte contract ids, unix seconds. The owner
//! signs it; with `end == 0` it is an end, and the key may sign it too.
//! Every grant entry lives for the maximum TTL; an end stores 0 and bumps the key's persistent generation,
//! so an end signed under an earlier generation cannot revoke a key granted again after the entry expires.
#![no_std]

use soroban_sdk::xdr::{FromXdr, ToXdr};
use soroban_sdk::{auth::*, contract, contractevent, contractimpl, crypto::*, TryFromVal};
use soroban_sdk::{Address, Bytes, BytesN, Env, Error, Vec};

const NO: Error = Error::from_contract_error(1);

/// Maximum length of a grant window in seconds (seven days). Stated in the README, the audit overview,
/// the Stellar guide and STRIDE row T-14; changing it changes a documented security bound.
const MAX_GRANT_WINDOW: u64 = 7 * 24 * 60 * 60;

/// Published by `grant` for a grant and for an end. `end == 0` is an end. `generation` is the key's
/// per-key generation after the call, which the next message for the key must sign over (an end bumps
/// it, a grant leaves it). The topic is the session key. A monitor reads grants and ends from this
/// event rather than from storage or transaction history.
#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Granted {
    #[topic]
    pub key: BytesN<32>,
    pub start: u64,
    pub end: u64,
    pub generation: u32,
}

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
    if pre.len() < 32 || sha(e, pre) != *digest {
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
        let p = e.storage().persistent();
        let old: Option<u64> = t.get(&key);
        // Per-key generation in persistent storage. It is never removed, so it survives the ~180-day
        // eviction of the temporary entry; each end bumps it. An end signed under an earlier generation
        // no longer verifies, so an old end cannot revoke a key granted again after the entry expired.
        let generation: u32 = p.get(&key).unwrap_or(0);
        let timely = start <= now && now <= end && end - start <= MAX_GRANT_WINDOW;
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
        // Gen 0 keeps the recorded vectors valid: the message is unchanged until the key's first end.
        if generation > 0 {
            m.extend_from_array(&generation.to_be_bytes());
        }
        e.crypto().ed25519_verify(&by, &sha(&e, &m), &sig);
        let next = if end == 0 {
            p.set(&key, &(generation + 1));
            p.extend_ttl(&key, e.storage().max_ttl(), e.storage().max_ttl());
            generation + 1
        } else {
            generation
        };
        t.set(&key, &end);
        t.extend_ttl(&key, e.storage().max_ttl(), e.storage().max_ttl());
        Granted {
            key,
            start,
            end,
            generation: next,
        }
        .publish(&e);
        Ok(())
    }

    /// The `External` signer interface for rule 0. Proof: a session key (32 bytes), its signature (64 bytes), then the
    /// preimage of `hash` (the account's payload and the XDR of its rule ids).
    pub fn verify(e: Env, hash: Bytes, key_data: Bytes, proof: Bytes) -> bool {
        if proof.len() < 96 {
            return false;
        }
        let key = proof.slice(..32).try_into().ok().unwrap();
        let sig = proof.slice(32..96).try_into().ok().unwrap();
        let rule0 = rules(&e, &proof.slice(96..), &hash)
            .is_some_and(|r| !r.is_empty() && r.iter().all(|i| i == 0));
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
        let moved =
            rules(&e, &p.2, &digest).is_some_and(|r| !r.is_empty() && r.iter().all(|i| i != 0));
        if id(&e, &x.contract) != cfg(&e).0 || !moved {
            return Err(NO);
        }
        signed(&e, &p.0, &p.1, payload.into())
    }
}

#[cfg(test)]
mod test;
