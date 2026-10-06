//! A session key for one Prime Account, granted by an Ethereum wallet.
//!
//! The account's admins install this contract once, as the `Delegated` signer
//! of a context rule. From then on the wallet (MetaMask) grants a short-lived
//! ed25519 key by signing EIP-712 `PrimeSession` data off chain, and that key
//! alone authorises the calls the rule allows until `validUntil`. Starting or
//! renewing a session needs no transaction and no NEAR signature.
//!
//! The proof is `(session_key, valid_until, grant, session_sig)`, and
//! `__check_auth` accepts it only when all of these hold, else it fails with
//! the contract error in brackets:
//! - the ledger has not passed `valid_until` (1);
//! - every context is the bound Prime Account (2): this contract is only ever
//!   asked through that account's `require_auth_for_args`;
//! - `grant` is the bound Ethereum address's EIP-712 signature over the bound
//!   account, this network, the session key and `valid_until` (3);
//! - `session_sig` is the session key's signature over this payload.
#![no_std]

use soroban_sdk::auth::{Context, CustomAccountInterface};
use soroban_sdk::{contract, contractimpl, crypto::Hash, Address, Bytes, BytesN, Env, Error, Vec};

type Proof = (BytesN<32>, u32, BytesN<65>, BytesN<64>);

/// keccak256("PrimeSession(string account,bytes32 sessionKey,uint32 validUntil,bytes32 network)")
const TYPEHASH: &[u8; 32] = b"\x24\x80\xcb\x53\x4e\xa3\xe2\x0b\x8c\xef\xb0\xef\x70\xd2\xe5\x1b\xac\x0c\x0f\x78\x8e\xed\x1e\x4e\xc7\x41\x49\xbc\x0b\xd2\x19\xae";
/// keccak256 of EIP712Domain(string name,string version) = {"Prime Session", "1"}.
const DOMAIN: &[u8; 32] = b"\xad\x8e\x3c\xd0\xa4\x53\x07\x09\x17\xe7\xab\x97\x2d\x4e\x0c\x8d\xa9\xd6\x89\xce\x2d\x56\xf6\x2d\x93\xb3\x55\x12\x11\x9d\x62\x62";

#[contract]
pub struct SessionSigner;

#[contractimpl]
impl SessionSigner {
    pub fn __constructor(e: Env, owner: BytesN<20>, account: Address) {
        e.storage().instance().set(&0u32, &(owner, account));
    }
}

#[contractimpl]
impl CustomAccountInterface for SessionSigner {
    type Signature = Proof;
    type Error = Error;

    fn __check_auth(e: Env, payload: Hash<32>, p: Proof, ctx: Vec<Context>) -> Result<(), Error> {
        let (owner, account): (BytesN<20>, Address) = e.storage().instance().get(&0u32).unwrap();
        let (key, until, grant, sig) = p;
        need(e.ledger().sequence() <= until, 1)?;
        let ours = |c: Context| matches!(c, Context::Contract(c) if c.contract == account);
        need(ctx.iter().all(ours), 2)?;
        let (g, c) = (grant.to_array(), e.crypto());
        let rs = BytesN::from_array(&e, &g[..64].try_into().unwrap());
        let pk = c.secp256k1_recover(&digest(&e, &account, &key, until), &rs, g[64] as u32 % 27);
        let signer = c.keccak256(&Bytes::from_slice(&e, &pk.to_array()[1..]));
        need(signer.to_array()[12..] == owner.to_array(), 3)?;
        c.ed25519_verify(&key, &payload.into(), &sig);
        e.storage().instance().extend_ttl(17_280, 518_400);
        Ok(())
    }
}

fn need(ok: bool, code: u32) -> Result<(), Error> {
    ok.then_some(()).ok_or(Error::from_contract_error(code))
}

/// The EIP-712 digest: keccak256(0x1901 || DOMAIN || keccak256(TYPEHASH ||
/// keccak256(account) || key || uint256(until) || network id)).
pub fn digest(e: &Env, account: &Address, key: &BytesN<32>, until: u32) -> Hash<32> {
    let mut s = Bytes::from_array(e, TYPEHASH);
    s.append(&e.crypto().keccak256(&account.to_string().to_bytes()).into());
    s.append(&key.clone().into());
    s.extend_from_array(&[0u8; 28]);
    s.extend_from_array(&until.to_be_bytes());
    s.append(&e.ledger().network_id().into());
    let mut m = Bytes::from_array(e, &[0x19, 0x01]);
    m.extend_from_array(DOMAIN);
    m.append(&e.crypto().keccak256(&s).into());
    e.crypto().keccak256(&m)
}

#[cfg(test)]
mod test;
