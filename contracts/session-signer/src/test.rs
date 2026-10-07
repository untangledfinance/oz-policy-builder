extern crate std;

use super::*;
use ed25519_dalek::{Signer as _, SigningKey};
use sha2::Digest as _;
use soroban_sdk::{testutils::Ledger as _, Address, IntoVal, InvokeError};

const EXPIRED: Error = Error::from_contract_error(1);
const REVOKED: Error = Error::from_contract_error(2);
type R = Result<(), Result<Error, InvokeError>>;

struct T {
    e: Env,
    signer: Address,
    owner: SigningKey,
    session: SigningKey,
}

fn setup() -> T {
    let e = Env::default();
    e.ledger().set_sequence_number(500);
    let owner = SigningKey::from_bytes(&[5u8; 32]);
    let signer = e.register(SessionSigner, (BytesN::from_array(&e, &owner.verifying_key().to_bytes()),));
    T { e, signer, owner, session: SigningKey::from_bytes(&[9u8; 32]) }
}

fn key(t: &T) -> BytesN<32> {
    BytesN::from_array(&t.e, &t.session.verifying_key().to_bytes())
}

/// The grant text, rebuilt independently of the contract.
fn text(signer: &Address, key: &BytesN<32>, until: u32) -> std::string::String {
    let mut c = std::vec![0u8; signer.to_string().len() as usize];
    signer.to_string().copy_into_slice(&mut c);
    let hex: std::string::String = key.to_array().iter().map(|x| std::format!("{x:02x}")).collect();
    std::format!("Prime session\ncontract: {}\nsession key: {hex}\nvalid until ledger (hex): {until:08x}", std::string::String::from_utf8(c).unwrap())
}

/// What Freighter's signMessage (SEP-53) returns, and what NEAR MPC returns when asked to sign the SEP-53 digest.
fn sep53(wallet: &SigningKey, t: &str) -> [u8; 64] {
    let d: [u8; 32] = sha2::Sha256::digest([b"Stellar Signed Message:\n".as_slice(), t.as_bytes()].concat()).into();
    wallet.sign(&d).to_bytes()
}

fn proof_by(t: &T, wallet: &SigningKey, signer: &Address, until: u32, signed_until: u32, payload: &[u8; 32]) -> Proof {
    (
        key(t),
        until,
        BytesN::from_array(&t.e, &sep53(wallet, &text(signer, &key(t), signed_until))),
        BytesN::from_array(&t.e, &t.session.sign(payload).to_bytes()),
    )
}

fn proof(t: &T, until: u32) -> Proof {
    proof_by(t, &t.owner, &t.signer, until, until, &[1; 32])
}

fn check_on(t: &T, signer: &Address, payload: [u8; 32], p: Proof) -> R {
    let ctx: Vec<Context> = Vec::new(&t.e);
    t.e.try_invoke_contract_check_auth::<Error>(signer, &BytesN::from_array(&t.e, &payload), p.into_val(&t.e), &ctx)
}

fn check(t: &T, p: Proof) -> R {
    check_on(t, &t.signer, [1; 32], p)
}

/// A bad ed25519 signature is refused by the host, not by a contract code.
fn is_crypto(r: R) -> bool {
    matches!(r, Err(Ok(e)) if e.is_type(soroban_sdk::xdr::ScErrorType::Crypto))
}

#[test]
fn grant_text_matches_the_contract() {
    let t = setup();
    let on_chain = t.e.as_contract(&t.signer, || grant_text(&t.e, &key(&t), 1234567));
    let mut b = std::vec![0u8; on_chain.len() as usize];
    on_chain.copy_into_slice(&mut b);
    assert_eq!(std::string::String::from_utf8(b).unwrap(), text(&t.signer, &key(&t), 1234567));
    let zero = t.e.as_contract(&t.signer, || grant_text(&t.e, &key(&t), 0));
    assert!(zero.len() as usize == text(&t.signer, &key(&t), 0).len());
}

#[test]
fn accepts_a_live_grant() {
    let t = setup();
    assert_eq!(check(&t, proof(&t, 600)), Ok(()));
}

#[test]
fn accepts_at_valid_until_and_refuses_after() {
    let t = setup();
    let p = proof(&t, 600);
    t.e.ledger().set_sequence_number(600);
    assert_eq!(check(&t, p.clone()), Ok(()));
    t.e.ledger().set_sequence_number(601);
    assert_eq!(check(&t, p), Err(Ok(EXPIRED)));
}

#[test]
fn caps_a_session_at_seven_days() {
    let t = setup();
    assert_eq!(check(&t, proof(&t, 500 + 120_960)), Ok(()));
    assert_eq!(check(&t, proof(&t, 500 + 120_961)), Err(Ok(EXPIRED)));
}

#[test]
fn refuses_a_grant_from_another_wallet() {
    let t = setup();
    let other = SigningKey::from_bytes(&[6u8; 32]);
    assert!(is_crypto(check(&t, proof_by(&t, &other, &t.signer, 600, 600, &[1; 32]))));
}

#[test]
fn refuses_a_stretched_valid_until() {
    let t = setup();
    assert!(is_crypto(check(&t, proof_by(&t, &t.owner, &t.signer, 700, 600, &[1; 32]))));
}

#[test]
fn refuses_a_grant_for_another_key() {
    let t = setup();
    let mut p = proof(&t, 600);
    let other = SigningKey::from_bytes(&[8u8; 32]);
    p.0 = BytesN::from_array(&t.e, &other.verifying_key().to_bytes());
    p.3 = BytesN::from_array(&t.e, &other.sign(&[1; 32]).to_bytes());
    assert!(is_crypto(check(&t, p)));
}

#[test]
fn refuses_a_grant_made_for_another_instance_of_the_same_wallet() {
    let t = setup();
    let again = t.e.register(SessionSigner, (BytesN::from_array(&t.e, &t.owner.verifying_key().to_bytes()),));
    let p = proof(&t, 600);
    assert!(is_crypto(check_on(&t, &again, [1; 32], p)));
}

#[test]
fn refuses_a_grant_signed_without_the_sep53_prefix() {
    let t = setup();
    let mut p = proof(&t, 600);
    p.2 = BytesN::from_array(&t.e, &t.owner.sign(text(&t.signer, &key(&t), 600).as_bytes()).to_bytes());
    assert!(is_crypto(check(&t, p)));
}

#[test]
fn refuses_a_session_signature_over_another_payload() {
    let t = setup();
    let p = proof_by(&t, &t.owner, &t.signer, 600, 600, &[2; 32]);
    assert!(is_crypto(check(&t, p)));
}

#[test]
fn revoke_ends_that_session_only() {
    let t = setup();
    let p = proof(&t, 600);
    let sig = BytesN::from_array(&t.e, &sep53(&t.owner, &text(&t.signer, &key(&t), 0)));
    SessionSignerClient::new(&t.e, &t.signer).revoke(&key(&t), &sig);
    assert_eq!(check(&t, p), Err(Ok(REVOKED)));
    let other = T { session: SigningKey::from_bytes(&[11u8; 32]), ..setup_same(&t) };
    assert_eq!(check(&other, proof(&other, 600)), Ok(()));
}

fn setup_same(t: &T) -> T {
    T { e: t.e.clone(), signer: t.signer.clone(), owner: t.owner.clone(), session: t.session.clone() }
}

#[test]
fn revoke_needs_the_owner_and_ledger_zero() {
    let t = setup();
    let client = SessionSignerClient::new(&t.e, &t.signer);
    let other = SigningKey::from_bytes(&[6u8; 32]);
    let by_other = BytesN::from_array(&t.e, &sep53(&other, &text(&t.signer, &key(&t), 0)));
    assert!(client.try_revoke(&key(&t), &by_other).is_err());
    let grant_not_revoke = BytesN::from_array(&t.e, &sep53(&t.owner, &text(&t.signer, &key(&t), 600)));
    assert!(client.try_revoke(&key(&t), &grant_not_revoke).is_err());
    assert_eq!(check(&t, proof(&t, 600)), Ok(()));
}

#[test]
fn a_revocation_never_authorises() {
    let t = setup();
    // the signed revoke text (ledger 0) presented as a grant: expired before any signature check
    let p = proof_by(&t, &t.owner, &t.signer, 0, 0, &[1; 32]);
    assert_eq!(check(&t, p), Err(Ok(EXPIRED)));
}
