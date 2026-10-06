extern crate std;

use super::*;
use ed25519_dalek::{Signer as _, SigningKey};
use k256::ecdsa::SigningKey as EthKey;
use soroban_sdk::{
    auth::ContractContext, bytesn, symbol_short, testutils::Address as _, testutils::Ledger as _,
    IntoVal, InvokeError,
};

const ACCOUNT: &str = "CD77AAD766IG4U64GIBCFHTQMCOX65FSDMP3CNPB75PSNEOFLX4G32RB";
const EXPIRED: Error = Error::from_contract_error(1);
const WRONG_ACCOUNT: Error = Error::from_contract_error(2);
const WRONG_OWNER: Error = Error::from_contract_error(3);

struct T {
    e: Env,
    signer: Address,
    account: Address,
    eth: EthKey,
    session: SigningKey,
}

fn eth_address(e: &Env, k: &EthKey) -> BytesN<20> {
    let pt = k.verifying_key().to_encoded_point(false);
    let h = e
        .crypto()
        .keccak256(&Bytes::from_slice(e, &pt.as_bytes()[1..]))
        .to_array();
    BytesN::from_array(e, &h[12..].try_into().unwrap())
}

fn setup() -> T {
    let e = Env::default();
    e.ledger().set_sequence_number(500);
    let account = Address::from_str(&e, ACCOUNT);
    let eth = EthKey::from_slice(&[7u8; 32]).unwrap();
    let signer = e.register(SessionSigner, (eth_address(&e, &eth), account.clone()));
    let session = SigningKey::from_bytes(&[9u8; 32]);
    T {
        e,
        signer,
        account,
        eth,
        session,
    }
}

/// What MetaMask returns for eth_signTypedData_v4: r || s || v, v = 27 + parity.
fn grant(t: &T, eth: &EthKey, account: &Address, key: &BytesN<32>, until: u32) -> BytesN<65> {
    let d =
        t.e.as_contract(&t.signer, || digest(&t.e, account, key, until))
            .to_array();
    let (sig, rec) = eth.sign_prehash_recoverable(&d).unwrap();
    let mut g = [0u8; 65];
    g[..64].copy_from_slice(&sig.to_bytes());
    g[64] = 27 + rec.to_byte();
    BytesN::from_array(&t.e, &g)
}

fn ctx(e: &Env, contract: &Address) -> Vec<Context> {
    let c = ContractContext {
        contract: contract.clone(),
        fn_name: symbol_short!("chk"),
        args: soroban_sdk::vec![e],
    };
    soroban_sdk::vec![e, Context::Contract(c)]
}

fn proof(t: &T, payload: &[u8; 32], until: u32) -> Proof {
    let key = BytesN::from_array(&t.e, &t.session.verifying_key().to_bytes());
    let g = grant(t, &t.eth, &t.account, &key, until);
    (
        key,
        until,
        g,
        BytesN::from_array(&t.e, &t.session.sign(payload).to_bytes()),
    )
}

fn check_on(
    t: &T,
    signer: &Address,
    payload: [u8; 32],
    p: Proof,
    c: Vec<Context>,
) -> Result<(), Result<Error, InvokeError>> {
    t.e.try_invoke_contract_check_auth::<Error>(
        signer,
        &BytesN::from_array(&t.e, &payload),
        p.into_val(&t.e),
        &c,
    )
}

fn check(
    t: &T,
    payload: [u8; 32],
    p: Proof,
    c: Vec<Context>,
) -> Result<(), Result<Error, InvokeError>> {
    check_on(t, &t.signer, payload, p, c)
}

/// The session signature is checked by the host, so a bad one fails as a
/// host crypto error, not as one of this contract's codes.
fn is_crypto(r: Result<(), Result<Error, InvokeError>>) -> bool {
    matches!(r, Err(Ok(e)) if e.is_type(soroban_sdk::xdr::ScErrorType::Crypto))
}

#[test]
fn accepts_a_live_grant() {
    let t = setup();
    assert_eq!(
        check(&t, [1; 32], proof(&t, &[1; 32], 600), ctx(&t.e, &t.account)),
        Ok(())
    );
}

#[test]
fn accepts_up_to_and_including_valid_until() {
    let t = setup();
    let p = proof(&t, &[1; 32], 600);
    t.e.ledger().set_sequence_number(600);
    assert_eq!(check(&t, [1; 32], p, ctx(&t.e, &t.account)), Ok(()));
}

#[test]
fn refuses_after_valid_until() {
    let t = setup();
    let p = proof(&t, &[1; 32], 600);
    t.e.ledger().set_sequence_number(601);
    assert_eq!(
        check(&t, [1; 32], p, ctx(&t.e, &t.account)),
        Err(Ok(EXPIRED))
    );
}

#[test]
fn refuses_a_context_on_another_contract() {
    let t = setup();
    let other = Address::generate(&t.e);
    assert_eq!(
        check(&t, [1; 32], proof(&t, &[1; 32], 600), ctx(&t.e, &other)),
        Err(Ok(WRONG_ACCOUNT))
    );
}

#[test]
fn refuses_a_grant_from_another_wallet() {
    let t = setup();
    let mut p = proof(&t, &[1; 32], 600);
    p.2 = grant(
        &t,
        &EthKey::from_slice(&[8u8; 32]).unwrap(),
        &t.account,
        &p.0,
        600,
    );
    assert_eq!(
        check(&t, [1; 32], p, ctx(&t.e, &t.account)),
        Err(Ok(WRONG_OWNER))
    );
}

#[test]
fn refuses_a_stretched_valid_until() {
    let t = setup();
    let mut p = proof(&t, &[1; 32], 600);
    p.1 = 100_000; // the wallet granted 600
    assert_eq!(
        check(&t, [1; 32], p, ctx(&t.e, &t.account)),
        Err(Ok(WRONG_OWNER))
    );
}

#[test]
fn refuses_a_grant_for_another_key() {
    let t = setup();
    let mut p = proof(&t, &[1; 32], 600);
    let other = SigningKey::from_bytes(&[10u8; 32]);
    p.0 = BytesN::from_array(&t.e, &other.verifying_key().to_bytes());
    p.3 = BytesN::from_array(&t.e, &other.sign(&[1; 32]).to_bytes());
    assert_eq!(
        check(&t, [1; 32], p, ctx(&t.e, &t.account)),
        Err(Ok(WRONG_OWNER))
    );
}

#[test]
fn refuses_a_grant_made_for_another_account() {
    let t = setup();
    let p = proof(&t, &[1; 32], 600);
    let other = Address::generate(&t.e);
    let signer =
        t.e.register(SessionSigner, (eth_address(&t.e, &t.eth), other.clone()));
    assert_eq!(
        check_on(&t, &signer, [1; 32], p, ctx(&t.e, &other)),
        Err(Ok(WRONG_OWNER))
    );
}

#[test]
fn refuses_a_grant_made_for_another_network() {
    let t = setup();
    let p = proof(&t, &[1; 32], 600);
    t.e.ledger().set_network_id([5u8; 32]);
    assert_eq!(
        check(&t, [1; 32], p, ctx(&t.e, &t.account)),
        Err(Ok(WRONG_OWNER))
    );
}

#[test]
fn refuses_a_session_signature_over_another_payload() {
    let t = setup();
    let p = proof(&t, &[2; 32], 600);
    assert!(is_crypto(check(&t, [1; 32], p, ctx(&t.e, &t.account))));
}

/// The digest and grant are viem's `hashTypedData` / `signTypedData` output,
/// the bytes MetaMask's eth_signTypedData_v4 returns for the same data.
#[test]
fn matches_viem_and_accepts_its_signature() {
    let e = Env::default();
    e.ledger().set_sequence_number(500);
    let testnet = bytesn!(
        &e,
        0xcee0302d59844d32bdca915c8203dd44b33fbb7edc19051ea37abedf28ecd472
    );
    e.ledger().set_network_id(testnet.to_array());
    let account = Address::from_str(&e, ACCOUNT);
    let owner = bytesn!(&e, 0x17c5185167401eD00cF5F5b2fc97D9BBfDb7D025);
    let signer = e.register(SessionSigner, (owner, account.clone()));
    let key = bytesn!(
        &e,
        0x1111111111111111111111111111111111111111111111111111111111111111
    );
    let d = e.as_contract(&signer, || digest(&e, &account, &key, 1000));
    assert_eq!(
        BytesN::from(d),
        bytesn!(
            &e,
            0xac1495ae36e5e4513c051926ba1abdde57b967e831e493161204be90b2d57ed8
        )
    );
    let viem = bytesn!(&e, 0xc5dae286ff4830571db3ee4d8a2e7659c3d65b763608df878fa328f1cc605fb400cbcb851f3a624d21a73393fab4c12e362ddaa6c0e641c3528748a0b3e899b91b);
    // The grant names key 0x11..11, whose secret nobody has, so the owner
    // check must pass and the session signature check must be what refuses.
    let p: Proof = (key, 1000, viem, BytesN::from_array(&e, &[0; 64]));
    let r = e.try_invoke_contract_check_auth::<Error>(
        &signer,
        &BytesN::from_array(&e, &[1; 32]),
        p.into_val(&e),
        &ctx(&e, &account),
    );
    assert!(is_crypto(r), "{r:?}");
}
