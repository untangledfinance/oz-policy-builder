extern crate std;

use super::*;
use ed25519_dalek::{Signer as _, SigningKey};
use k256::ecdsa::SigningKey as EthKey;
use soroban_sdk::{bytesn, testutils::Ledger as _, Address, IntoVal, InvokeError, Vec};

const EXPIRED: Error = Error::from_contract_error(1);
const REVOKED: Error = Error::from_contract_error(2);
const NOT_OWNER: Error = Error::from_contract_error(3);
type R = Result<(), Result<Error, InvokeError>>;

struct T {
    e: Env,
    signer: Address,
    eth: EthKey,
    session: SigningKey,
}

fn eth_address(e: &Env, k: &EthKey) -> BytesN<20> {
    let pt = k.verifying_key().to_encoded_point(false);
    let h = e
        .crypto()
        .keccak256(&Bytes::from_slice(e, &pt.as_bytes()[1..]));
    BytesN::from_array(e, &h.to_array()[12..].try_into().unwrap())
}

fn setup() -> T {
    let e = Env::default();
    e.ledger().set_sequence_number(500);
    let eth = EthKey::from_slice(&[7u8; 32]).unwrap();
    let signer = e.register(SessionSigner, (Owner::Evm(eth_address(&e, &eth)),));
    let session = SigningKey::from_bytes(&[9u8; 32]);
    T {
        e,
        signer,
        eth,
        session,
    }
}

/// The personal_sign digest of the grant text, rebuilt independently of the contract.
fn digest(e: &Env, signer: &Address, key: &BytesN<32>, until: u32) -> [u8; 32] {
    let t = text(e, signer, key, until);
    let m = std::format!("\x19Ethereum Signed Message:\n{}{t}", t.len());
    e.crypto().keccak256(&Bytes::from_slice(e, m.as_bytes())).to_array()
}

/// What MetaMask returns for personal_sign, split as the contract takes it.
fn grant(t: &T, eth: &EthKey, signer: &Address, key: &BytesN<32>, until: u32) -> (BytesN<64>, u32) {
    let (sig, rec) = eth
        .sign_prehash_recoverable(&digest(&t.e, signer, key, until))
        .unwrap();
    (
        BytesN::from_array(&t.e, &sig.to_bytes().into()),
        27 + rec.to_byte() as u32,
    )
}

fn key(t: &T) -> BytesN<32> {
    BytesN::from_array(&t.e, &t.session.verifying_key().to_bytes())
}

fn proof(t: &T, payload: &[u8; 32], until: u32) -> Proof {
    let (rs, v) = grant(t, &t.eth, &t.signer, &key(t), until);
    (
        key(t),
        until,
        rs,
        v,
        BytesN::from_array(&t.e, &t.session.sign(payload).to_bytes()),
    )
}

fn check_on(t: &T, signer: &Address, payload: [u8; 32], p: Proof) -> R {
    let ctx: Vec<Context> = Vec::new(&t.e);
    t.e.try_invoke_contract_check_auth::<Error>(
        signer,
        &BytesN::from_array(&t.e, &payload),
        p.into_val(&t.e),
        &ctx,
    )
}

fn check(t: &T, p: Proof) -> R {
    check_on(t, &t.signer, [1; 32], p)
}

/// A bad session signature is refused by the host, not by a contract code.
fn is_crypto(r: R) -> bool {
    matches!(r, Err(Ok(e)) if e.is_type(soroban_sdk::xdr::ScErrorType::Crypto))
}

#[test]
fn accepts_a_live_grant() {
    let t = setup();
    assert_eq!(check(&t, proof(&t, &[1; 32], 600)), Ok(()));
}

#[test]
fn accepts_at_valid_until_and_refuses_after() {
    let t = setup();
    let p = proof(&t, &[1; 32], 600);
    t.e.ledger().set_sequence_number(600);
    assert_eq!(check(&t, p.clone()), Ok(()));
    t.e.ledger().set_sequence_number(601);
    assert_eq!(check(&t, p), Err(Ok(EXPIRED)));
}

#[test]
fn caps_a_session_at_seven_days() {
    let t = setup();
    assert_eq!(check(&t, proof(&t, &[1; 32], 500 + 120_960)), Ok(()));
    assert_eq!(
        check(&t, proof(&t, &[1; 32], 500 + 120_961)),
        Err(Ok(EXPIRED))
    );
}

#[test]
fn refuses_a_grant_from_another_wallet() {
    let t = setup();
    let mut p = proof(&t, &[1; 32], 600);
    (p.2, p.3) = grant(
        &t,
        &EthKey::from_slice(&[8u8; 32]).unwrap(),
        &t.signer,
        &p.0,
        600,
    );
    assert_eq!(check(&t, p), Err(Ok(NOT_OWNER)));
}

#[test]
fn refuses_a_stretched_valid_until() {
    let t = setup();
    let mut p = proof(&t, &[1; 32], 600);
    p.1 = 700; // the wallet granted 600
    assert_eq!(check(&t, p), Err(Ok(NOT_OWNER)));
}

#[test]
fn refuses_a_grant_for_another_key() {
    let t = setup();
    let mut p = proof(&t, &[1; 32], 600);
    let other = SigningKey::from_bytes(&[10u8; 32]);
    p.0 = BytesN::from_array(&t.e, &other.verifying_key().to_bytes());
    p.4 = BytesN::from_array(&t.e, &other.sign(&[1; 32]).to_bytes());
    assert_eq!(check(&t, p), Err(Ok(NOT_OWNER)));
}

#[test]
fn refuses_a_grant_made_for_another_instance_of_the_same_wallet() {
    let t = setup();
    let p = proof(&t, &[1; 32], 600);
    let again = t.e.register(SessionSigner, (Owner::Evm(eth_address(&t.e, &t.eth)),));
    assert_eq!(check_on(&t, &again, [1; 32], p), Err(Ok(NOT_OWNER)));
}

#[test]
fn refuses_a_bad_v() {
    let t = setup();
    let mut p = proof(&t, &[1; 32], 600);
    p.3 = if p.3 == 27 { 28 } else { 27 };
    assert!(check(&t, p).is_err());
}

#[test]
fn refuses_a_session_signature_over_another_payload() {
    let t = setup();
    assert!(is_crypto(check(&t, proof(&t, &[2; 32], 600))));
}

#[test]
fn revoke_ends_that_session_only() {
    let t = setup();
    let c = SessionSignerClient::new(&t.e, &t.signer);
    let (rs, v) = grant(&t, &t.eth, &t.signer, &key(&t), 0);
    c.revoke(&key(&t), &rs, &v);
    assert_eq!(check(&t, proof(&t, &[1; 32], 600)), Err(Ok(REVOKED)));
    let other = SigningKey::from_bytes(&[11u8; 32]);
    let k = BytesN::from_array(&t.e, &other.verifying_key().to_bytes());
    let (rs, v) = grant(&t, &t.eth, &t.signer, &k, 600);
    let p = (
        k,
        600,
        rs,
        v,
        BytesN::from_array(&t.e, &other.sign(&[1; 32]).to_bytes()),
    );
    assert_eq!(check(&t, p), Ok(()));
}

#[test]
fn revoke_needs_the_owner_and_a_zero_valid_until() {
    let t = setup();
    let c = SessionSignerClient::new(&t.e, &t.signer);
    let (rs, v) = grant(
        &t,
        &EthKey::from_slice(&[8u8; 32]).unwrap(),
        &t.signer,
        &key(&t),
        0,
    );
    assert_eq!(c.try_revoke(&key(&t), &rs, &v), Err(Ok(NOT_OWNER)));
    // A session grant (valid_until 600) is not a revocation.
    let (rs, v) = grant(&t, &t.eth, &t.signer, &key(&t), 600);
    assert_eq!(c.try_revoke(&key(&t), &rs, &v), Err(Ok(NOT_OWNER)));
    assert_eq!(check(&t, proof(&t, &[1; 32], 600)), Ok(()));
}

#[test]
fn a_revocation_never_authorises() {
    let t = setup();
    let (rs, v) = grant(&t, &t.eth, &t.signer, &key(&t), 0);
    let p = (
        key(&t),
        0,
        rs,
        v,
        BytesN::from_array(&t.e, &t.session.sign(&[1; 32]).to_bytes()),
    );
    assert_eq!(check(&t, p), Err(Ok(EXPIRED)));
}

/// The digest and grant are viem's `hashMessage` / `signMessage` output (MetaMask personal_sign),
/// signed by the well-known test key of anvil account 0.
#[test]
fn matches_viem_and_metamask() {
    let e = Env::default();
    e.ledger().set_sequence_number(500);
    let testnet = bytesn!(
        &e,
        0xcee0302d59844d32bdca915c8203dd44b33fbb7edc19051ea37abedf28ecd472
    );
    e.ledger().set_network_id(testnet.to_array());
    let at = Address::from_str(
        &e,
        "CDRLTNNG2APUPPWNWZBVMUYRVWFJLQIN5LTAPILC7ZD6G6MGI2XJFVWN",
    );
    let owner = bytesn!(&e, 0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266);
    let signer = e.register_at(&at, SessionSigner, (Owner::Evm(owner),));
    let key = bytesn!(
        &e,
        0x1111111111111111111111111111111111111111111111111111111111111111
    );
    let want = bytesn!(
        &e,
        0xcd40652e71446661ddd26b667351dbc20fd0b7581fa6b727cbd6e9bec98e76d7
    );
    assert_eq!(digest(&e, &signer, &key, 1000), want.to_array());
    let rs = bytesn!(&e, 0xe1e2cb11122e90ec28884f615ef9cd224601cb9cd3abe4465cfef07e6b339f5c5a30b70b4e15ad07589a90d0a25a3f4736ef335639088771554f19e20468ae81);
    // The grant names key 0x11..11, whose secret nobody has: the owner check
    // must pass, so the session signature check is what refuses.
    let p: Proof = (key, 1000, rs, 0x1b, BytesN::from_array(&e, &[0; 64]));
    let ctx: Vec<Context> = Vec::new(&e);
    let r = e.try_invoke_contract_check_auth::<Error>(
        &signer,
        &BytesN::from_array(&e, &[1; 32]),
        p.into_val(&e),
        &ctx,
    );
    assert!(is_crypto(r), "{r:?}");
}

// v3: Stellar (Freighter, SEP-53) and Solana (Phantom, signMessage) owners.

/// The grant text, rebuilt independently of the contract.
fn text(e: &Env, signer: &Address, key: &BytesN<32>, until: u32) -> std::string::String {
    let hex = |b: &[u8]| b.iter().map(|x| std::format!("{x:02x}")).collect::<std::string::String>();
    let mut c = std::vec![0u8; signer.to_string().len() as usize];
    signer.to_string().copy_into_slice(&mut c);
    std::format!(
        "Prime session\ncontract: {}\nsession key: {}\nvalid until ledger: {until}",
        std::string::String::from_utf8(c).unwrap(),
        hex(&key.to_array())
    )
}

fn sep53(t: &str) -> [u8; 32] {
    use sha2::Digest as _;
    sha2::Sha256::digest([b"Stellar Signed Message:\n".as_slice(), t.as_bytes()].concat()).into()
}

fn ed_setup(stellar: bool) -> (T, SigningKey) {
    let t = setup();
    let wallet = SigningKey::from_bytes(&[5u8; 32]);
    let pk = BytesN::from_array(&t.e, &wallet.verifying_key().to_bytes());
    let owner = if stellar { Owner::Stellar(pk) } else { Owner::Solana(pk) };
    let signer = t.e.register(SessionSigner, (owner,));
    (T { signer, ..t }, wallet)
}

fn ed_proof(t: &T, wallet: &SigningKey, stellar: bool, until: u32, signed_until: u32) -> Proof {
    let msg = text(&t.e, &t.signer, &key(t), signed_until);
    let sig = if stellar { wallet.sign(&sep53(&msg)) } else { wallet.sign(msg.as_bytes()) };
    (key(t), until, BytesN::from_array(&t.e, &sig.to_bytes()), 0, BytesN::from_array(&t.e, &t.session.sign(&[1; 32]).to_bytes()))
}

#[test]
fn grant_text_matches_the_contract() {
    let (t, _) = ed_setup(true);
    let on_chain = t.e.as_contract(&t.signer, || grant_text(&t.e, &key(&t), 600));
    let mut b = std::vec![0u8; on_chain.len() as usize];
    on_chain.copy_into_slice(&mut b);
    assert_eq!(std::string::String::from_utf8(b).unwrap(), text(&t.e, &t.signer, &key(&t), 600));
}

#[test]
fn stellar_owner_sep53_grant() {
    let (t, w) = ed_setup(true);
    assert_eq!(check(&t, ed_proof(&t, &w, true, 600, 600)), Ok(()));
    // Same text without the SEP-53 prefix (a Phantom-style signature) is refused.
    assert!(is_crypto(check(&t, ed_proof(&t, &w, false, 600, 600))));
    // Stretched validity, another wallet, and the 7-day cap.
    assert!(is_crypto(check(&t, ed_proof(&t, &w, true, 700, 600))));
    assert!(is_crypto(check(&t, ed_proof(&t, &SigningKey::from_bytes(&[6u8; 32]), true, 600, 600))));
    assert_eq!(check(&t, ed_proof(&t, &w, true, 500 + 120_961, 500 + 120_961)), Err(Ok(EXPIRED)));
}

#[test]
fn solana_owner_text_grant() {
    let (t, w) = ed_setup(false);
    assert_eq!(check(&t, ed_proof(&t, &w, false, 600, 600)), Ok(()));
    assert!(is_crypto(check(&t, ed_proof(&t, &w, true, 600, 600))));
    assert!(is_crypto(check(&t, ed_proof(&t, &SigningKey::from_bytes(&[6u8; 32]), false, 600, 600))));
    t.e.ledger().set_sequence_number(601);
    assert_eq!(check(&t, ed_proof(&t, &w, false, 600, 600)), Err(Ok(EXPIRED)));
}

#[test]
fn ed25519_owner_grant_is_bound_to_the_instance_and_revocable() {
    let (t, w) = ed_setup(false);
    let other = t.e.register(SessionSigner, (Owner::Solana(BytesN::from_array(&t.e, &w.verifying_key().to_bytes())),));
    assert!(is_crypto(check_on(&t, &other, [1; 32], ed_proof(&t, &w, false, 600, 600))));
    let rev = text(&t.e, &t.signer, &key(&t), 0);
    let client = SessionSignerClient::new(&t.e, &t.signer);
    client.revoke(&key(&t), &BytesN::from_array(&t.e, &w.sign(rev.as_bytes()).to_bytes()), &0);
    assert_eq!(check(&t, ed_proof(&t, &w, false, 600, 600)), Err(Ok(REVOKED)));
}
