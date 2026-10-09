extern crate std;

use super::*;
use ed25519_dalek::{Signer as _, SigningKey};
use sha2::{Digest, Sha256};
use soroban_sdk::testutils::{storage::Temporary as _, Address as _, Ledger as _, MockAuth, MockAuthInvoke};
use soroban_sdk::xdr::{self, Limits, WriteXdr};
use soroban_sdk::{contract, contractimpl, IntoVal, InvokeError};

const EXPIRED: Error = Error::from_contract_error(1);
type R = Result<(), Result<Error, InvokeError>>;

struct T { e: Env, id: Address, owner: Address, client: PrimeSessionClient<'static> }

fn setup() -> T {
    let e = Env::default();
    e.ledger().set_sequence_number(500);
    let owner = Address::generate(&e);
    let id = e.register(PrimeSession, (owner.clone(),));
    let client = PrimeSessionClient::new(&e, &id);
    T { e, id, owner, client }
}

fn pk(e: &Env, k: &SigningKey) -> BytesN<32> { BytesN::from_array(e, &k.verifying_key().to_bytes()) }

fn grant_as(t: &T, who: &Address, key: &BytesN<32>, until: u32) -> bool {
    t.e.mock_auths(&[MockAuth { address: who, invoke: &MockAuthInvoke { contract: &t.id, fn_name: "grant", args: (key.clone(), until).into_val(&t.e), sub_invokes: &[] } }]);
    matches!(t.client.try_grant(key, &until), Ok(Ok(())))
}

fn check(t: &T, k: &SigningKey, signer: &SigningKey) -> R {
    let payload = [7u8; 32];
    let sig = BytesN::from_array(&t.e, &signer.sign(&payload).to_bytes());
    let ctx: Vec<Context> = Vec::new(&t.e);
    t.e.try_invoke_contract_check_auth::<Error>(&t.id, &BytesN::from_array(&t.e, &payload), (pk(&t.e, k), sig).into_val(&t.e), &ctx)
}

#[test]
fn owner_grants_then_session_key_moves() {
    let t = setup();
    let k = SigningKey::from_bytes(&[9; 32]);
    assert!(grant_as(&t, &t.owner, &pk(&t.e, &k), 500 + 720));
    assert_eq!(check(&t, &k, &k), Ok(()));
}

#[test]
fn stranger_cannot_grant() {
    let t = setup();
    let k = SigningKey::from_bytes(&[9; 32]);
    assert!(!grant_as(&t, &Address::generate(&t.e), &pk(&t.e, &k), 600));
    assert_eq!(check(&t, &k, &k), Err(Ok(EXPIRED)));
}

#[test]
fn at_most_seven_days() {
    let t = setup();
    let k = SigningKey::from_bytes(&[9; 32]);
    assert!(!grant_as(&t, &t.owner, &pk(&t.e, &k), 500 + 120_961));
    assert!(grant_as(&t, &t.owner, &pk(&t.e, &k), 500 + 120_960));
    assert_eq!(check(&t, &k, &k), Ok(()));
}

#[test]
fn expires_at_its_ledger() {
    let t = setup();
    let k = SigningKey::from_bytes(&[9; 32]);
    assert!(grant_as(&t, &t.owner, &pk(&t.e, &k), 510));
    t.e.ledger().set_sequence_number(510);
    assert_eq!(check(&t, &k, &k), Ok(()));
    t.e.ledger().set_sequence_number(511);
    assert_eq!(check(&t, &k, &k), Err(Ok(EXPIRED)));
}

#[test]
fn entry_outlives_a_long_session() {
    let t = setup();
    let k = SigningKey::from_bytes(&[9; 32]);
    assert!(grant_as(&t, &t.owner, &pk(&t.e, &k), 500 + 120_960));
    t.e.ledger().set_sequence_number(500 + 60_000);
    assert_eq!(check(&t, &k, &k), Ok(()));
    t.e.ledger().set_sequence_number(500 + 120_960);
    assert_eq!(check(&t, &k, &k), Ok(()));
    t.e.ledger().set_sequence_number(500 + 120_961);
    assert_eq!(check(&t, &k, &k), Err(Ok(EXPIRED)));
}

#[test]
fn a_revoked_key_cannot_move() {
    let t = setup();
    let a = SigningKey::from_bytes(&[9; 32]);
    assert!(grant_as(&t, &t.owner, &pk(&t.e, &a), 900));
    assert_eq!(check(&t, &a, &a), Ok(()));
    assert!(grant_as(&t, &t.owner, &pk(&t.e, &a), 0));
    assert_eq!(check(&t, &a, &a), Err(Ok(EXPIRED)));
}

#[test]
fn revoke_spares_the_wallets_other_session() {
    let t = setup();
    let (a, b) = (SigningKey::from_bytes(&[9; 32]), SigningKey::from_bytes(&[8; 32]));
    assert!(grant_as(&t, &t.owner, &pk(&t.e, &a), 900));
    assert!(grant_as(&t, &t.owner, &pk(&t.e, &b), 900));
    assert!(grant_as(&t, &t.owner, &pk(&t.e, &a), 0));
    assert_eq!(check(&t, &a, &a), Err(Ok(EXPIRED)));
    assert_eq!(check(&t, &b, &b), Ok(()));
}

#[test]
fn never_granted_key_and_wrong_signer_are_refused() {
    let t = setup();
    let (a, b) = (SigningKey::from_bytes(&[9; 32]), SigningKey::from_bytes(&[8; 32]));
    assert_eq!(check(&t, &a, &a), Err(Ok(EXPIRED)));
    assert!(grant_as(&t, &t.owner, &pk(&t.e, &a), 900));
    assert!(matches!(check(&t, &a, &b), Err(Ok(e)) if e.is_type(soroban_sdk::xdr::ScErrorType::Crypto)));
}

// An ed25519 account contract as the owner, so the tests sign real authorization entries with real nonces.
#[contract]
pub struct EdAccount;
#[contractimpl]
impl EdAccount {
    pub fn __constructor(e: Env, pk: BytesN<32>) { e.storage().instance().set(&0u32, &pk); }
}
#[contractimpl]
impl CustomAccountInterface for EdAccount {
    type Signature = BytesN<64>;
    type Error = Error;
    fn __check_auth(e: Env, payload: Hash<32>, sig: BytesN<64>, _c: Vec<Context>) -> Result<(), Error> {
        let pk: BytesN<32> = e.storage().instance().get(&0u32).unwrap();
        e.crypto().ed25519_verify(&pk, &payload.into(), &sig);
        Ok(())
    }
}

fn setup_signing_owner() -> (T, SigningKey) {
    let e = Env::default();
    e.ledger().set_sequence_number(500);
    let osk = SigningKey::from_bytes(&[3; 32]);
    let owner = e.register(EdAccount, (BytesN::from_array(&e, &osk.verifying_key().to_bytes()),));
    let id = e.register(PrimeSession, (owner.clone(),));
    let client = PrimeSessionClient::new(&e, &id);
    (T { e, id, owner, client }, osk)
}

fn signed_grant(t: &T, osk: &SigningKey, key: &BytesN<32>, until: u32, nonce: i64, exp: u32) -> xdr::SorobanAuthorizationEntry {
    let args: std::vec::Vec<xdr::ScVal> = std::vec![xdr::ScVal::Bytes(xdr::ScBytes(key.to_array().to_vec().try_into().unwrap())), xdr::ScVal::U32(until)];
    let inv = xdr::SorobanAuthorizedInvocation {
        function: xdr::SorobanAuthorizedFunction::ContractFn(xdr::InvokeContractArgs {
            contract_address: (&t.id).into(),
            function_name: "grant".try_into().unwrap(),
            args: args.try_into().unwrap(),
        }),
        sub_invocations: Default::default(),
    };
    let pre = xdr::HashIdPreimage::SorobanAuthorization(xdr::HashIdPreimageSorobanAuthorization {
        network_id: xdr::Hash(t.e.ledger().network_id().to_array()),
        nonce,
        signature_expiration_ledger: exp,
        invocation: inv.clone(),
    });
    let payload: [u8; 32] = Sha256::digest(pre.to_xdr(Limits::none()).unwrap()).into();
    let sig = osk.sign(&payload).to_bytes();
    xdr::SorobanAuthorizationEntry {
        credentials: xdr::SorobanCredentials::Address(xdr::SorobanAddressCredentials {
            address: (&t.owner).into(),
            nonce,
            signature_expiration_ledger: exp,
            signature: xdr::ScVal::Bytes(xdr::ScBytes(sig.to_vec().try_into().unwrap())),
        }),
        root_invocation: inv,
    }
}

fn submit(t: &T, entry: &xdr::SorobanAuthorizationEntry, key: &BytesN<32>, until: u32) -> bool {
    t.e.set_auths(std::slice::from_ref(entry));
    matches!(t.client.try_grant(key, &until), Ok(Ok(())))
}

#[test]
fn a_held_back_entry_is_refused_after_a_revoke() {
    let (t, osk) = setup_signing_owner();
    let k = SigningKey::from_bytes(&[9; 32]);
    let key = pk(&t.e, &k);
    let first = signed_grant(&t, &osk, &key, 500 + 1_000, 11, 600);
    let held = signed_grant(&t, &osk, &key, 500 + 1_000, 22, 600);
    assert!(submit(&t, &first, &key, 500 + 1_000));
    assert_eq!(check(&t, &k, &k), Ok(()));
    assert!(submit(&t, &signed_grant(&t, &osk, &key, 0, 33, 600), &key, 0));
    assert_eq!(check(&t, &k, &k), Err(Ok(EXPIRED)));
    t.e.ledger().set_sequence_number(550);
    assert!(!submit(&t, &held, &key, 500 + 1_000));
    assert_eq!(check(&t, &k, &k), Err(Ok(EXPIRED)));
}

#[test]
fn a_far_future_entry_is_refused_after_a_revoke_and_the_revoke_outlives_its_signature() {
    let (t, osk) = setup_signing_owner();
    let k = SigningKey::from_bytes(&[9; 32]);
    let key = pk(&t.e, &k);
    let far = 500 + 120_960 + 50_000;
    let sleeper = signed_grant(&t, &osk, &key, far, 44, 500 + 200_000);
    assert!(!submit(&t, &sleeper, &key, far));
    assert!(submit(&t, &signed_grant(&t, &osk, &key, 0, 55, 600), &key, 0));
    t.e.ledger().set_sequence_number(far - 120_960);
    assert!(!submit(&t, &sleeper, &key, far));
    assert_eq!(check(&t, &k, &k), Err(Ok(EXPIRED)));
    let left = t.e.as_contract(&t.id, || t.e.storage().temporary().get_ttl(&key));
    assert!(left >= 500 + 200_000 - (far - 120_960));
}

#[test]
fn a_revoked_key_is_never_granted_again_and_other_keys_still_are() {
    let t = setup();
    let (a, b) = (SigningKey::from_bytes(&[9; 32]), SigningKey::from_bytes(&[8; 32]));
    assert!(grant_as(&t, &t.owner, &pk(&t.e, &a), 900));
    assert!(grant_as(&t, &t.owner, &pk(&t.e, &a), 0));
    assert!(!grant_as(&t, &t.owner, &pk(&t.e, &a), 900));
    assert!(grant_as(&t, &t.owner, &pk(&t.e, &a), 0));
    assert!(grant_as(&t, &t.owner, &pk(&t.e, &b), 900));
    assert_eq!(check(&t, &b, &b), Ok(()));
}
