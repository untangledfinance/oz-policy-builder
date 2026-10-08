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

fn grant_as(t: &T, who: &Address, key: &BytesN<32>, until: u32, vote: bool) -> bool {
    t.e.mock_auths(&[MockAuth { address: who, invoke: &MockAuthInvoke { contract: &t.id, fn_name: "grant", args: (key.clone(), until, vote).into_val(&t.e), sub_invokes: &[] } }]);
    matches!(t.client.try_grant(key, &until, &vote), Ok(Ok(())))
}

// A move: the Delegated entry point (`__check_auth`) with a session key's proof.
fn mv(t: &T, k: &SigningKey, signer: &SigningKey) -> R {
    let payload = [7u8; 32];
    let sig = BytesN::from_array(&t.e, &signer.sign(&payload).to_bytes());
    let ctx: Vec<Context> = Vec::new(&t.e);
    t.e.try_invoke_contract_check_auth::<Error>(&t.id, &BytesN::from_array(&t.e, &payload), (pk(&t.e, k), sig).into_val(&t.e), &ctx)
}

// A vote: the External entry point (`verify`) with a session key's proof.
fn vote(t: &T, k: &SigningKey, signer: &SigningKey) -> bool {
    let digest = [5u8; 32];
    let mut proof = std::vec::Vec::from(k.verifying_key().to_bytes());
    proof.extend_from_slice(&signer.sign(&digest).to_bytes());
    t.client.verify(&Bytes::from_array(&t.e, &digest), &Bytes::new(&t.e), &Bytes::from_slice(&t.e, &proof))
}

fn vote_try(t: &T, k: &SigningKey, signer: &SigningKey) -> Result<Result<bool, soroban_sdk::ConversionError>, Result<Error, InvokeError>> {
    let digest = [5u8; 32];
    let mut proof = std::vec::Vec::from(k.verifying_key().to_bytes());
    proof.extend_from_slice(&signer.sign(&digest).to_bytes());
    t.client.try_verify(&Bytes::from_array(&t.e, &digest), &Bytes::new(&t.e), &Bytes::from_slice(&t.e, &proof))
}

// The owner's own vote: `verify` with an empty proof; the owner must authorize it.
fn owner_vote(t: &T, who: Option<&Address>) -> bool {
    let digest = Bytes::from_array(&t.e, &[5u8; 32]);
    if let Some(a) = who {
        t.e.mock_auths(&[MockAuth { address: a, invoke: &MockAuthInvoke { contract: &t.id, fn_name: "verify", args: (digest.clone(),).into_val(&t.e), sub_invokes: &[] } }]);
    }
    matches!(t.client.try_verify(&digest, &Bytes::new(&t.e), &Bytes::new(&t.e)), Ok(Ok(true)))
}

#[test]
fn owner_grants_then_session_key_moves() {
    let t = setup();
    let k = SigningKey::from_bytes(&[9; 32]);
    assert!(grant_as(&t, &t.owner, &pk(&t.e, &k), 500 + 720, false));
    assert_eq!(mv(&t, &k, &k), Ok(()));
}

#[test]
fn stranger_cannot_grant() {
    let t = setup();
    let k = SigningKey::from_bytes(&[9; 32]);
    assert!(!grant_as(&t, &Address::generate(&t.e), &pk(&t.e, &k), 600, true));
    assert_eq!(mv(&t, &k, &k), Err(Ok(EXPIRED)));
    assert!(!vote(&t, &k, &k));
}

#[test]
fn at_most_seven_days() {
    let t = setup();
    let k = SigningKey::from_bytes(&[9; 32]);
    assert!(!grant_as(&t, &t.owner, &pk(&t.e, &k), 500 + 120_961, true));
    assert!(grant_as(&t, &t.owner, &pk(&t.e, &k), 500 + 120_960, true));
    assert_eq!(mv(&t, &k, &k), Ok(()));
    assert!(vote(&t, &k, &k));
}

#[test]
fn expires_at_its_ledger() {
    let t = setup();
    let k = SigningKey::from_bytes(&[9; 32]);
    assert!(grant_as(&t, &t.owner, &pk(&t.e, &k), 510, true));
    t.e.ledger().set_sequence_number(510);
    assert_eq!(mv(&t, &k, &k), Ok(()));
    assert!(vote(&t, &k, &k));
    t.e.ledger().set_sequence_number(511);
    assert_eq!(mv(&t, &k, &k), Err(Ok(EXPIRED)));
    assert!(!vote(&t, &k, &k));
}

#[test]
fn entry_outlives_a_long_session() {
    let t = setup();
    let k = SigningKey::from_bytes(&[9; 32]);
    assert!(grant_as(&t, &t.owner, &pk(&t.e, &k), 500 + 120_960, true));
    t.e.ledger().set_sequence_number(500 + 60_000);
    assert_eq!(mv(&t, &k, &k), Ok(()));
    t.e.ledger().set_sequence_number(500 + 120_960);
    assert!(vote(&t, &k, &k));
    t.e.ledger().set_sequence_number(500 + 120_961);
    assert_eq!(mv(&t, &k, &k), Err(Ok(EXPIRED)));
    assert!(!vote(&t, &k, &k));
}

#[test]
fn a_revoked_key_cannot_move_or_vote() {
    let t = setup();
    let a = SigningKey::from_bytes(&[9; 32]);
    assert!(grant_as(&t, &t.owner, &pk(&t.e, &a), 900, true));
    assert_eq!(mv(&t, &a, &a), Ok(()));
    assert!(vote(&t, &a, &a));
    assert!(grant_as(&t, &t.owner, &pk(&t.e, &a), 0, false));
    assert_eq!(mv(&t, &a, &a), Err(Ok(EXPIRED)));
    assert!(!vote(&t, &a, &a));
}

#[test]
fn revoke_spares_the_wallets_other_session() {
    let t = setup();
    let (a, b) = (SigningKey::from_bytes(&[9; 32]), SigningKey::from_bytes(&[8; 32]));
    assert!(grant_as(&t, &t.owner, &pk(&t.e, &a), 900, true));
    assert!(grant_as(&t, &t.owner, &pk(&t.e, &b), 900, true));
    assert!(grant_as(&t, &t.owner, &pk(&t.e, &a), 0, false));
    assert_eq!(mv(&t, &a, &a), Err(Ok(EXPIRED)));
    assert_eq!(mv(&t, &b, &b), Ok(()));
    assert!(vote(&t, &b, &b));
}

#[test]
fn never_granted_key_and_wrong_signer_are_refused() {
    let t = setup();
    let (a, b) = (SigningKey::from_bytes(&[9; 32]), SigningKey::from_bytes(&[8; 32]));
    assert_eq!(mv(&t, &a, &a), Err(Ok(EXPIRED)));
    assert!(!vote(&t, &a, &a));
    assert!(grant_as(&t, &t.owner, &pk(&t.e, &a), 900, true));
    assert!(matches!(mv(&t, &a, &b), Err(Ok(e)) if e.is_type(soroban_sdk::xdr::ScErrorType::Crypto)));
    assert!(!matches!(vote_try(&t, &a, &b), Ok(Ok(true))));
}

#[test]
fn a_move_only_key_moves_but_never_votes() {
    let t = setup();
    let a = SigningKey::from_bytes(&[9; 32]);
    assert!(grant_as(&t, &t.owner, &pk(&t.e, &a), 900, false));
    assert_eq!(mv(&t, &a, &a), Ok(()));
    assert!(!vote(&t, &a, &a));
}

#[test]
fn a_vote_key_moves_and_votes() {
    let t = setup();
    let a = SigningKey::from_bytes(&[9; 32]);
    assert!(grant_as(&t, &t.owner, &pk(&t.e, &a), 900, true));
    assert_eq!(mv(&t, &a, &a), Ok(()));
    assert!(vote(&t, &a, &a));
}

#[test]
fn a_regrant_replaces_the_vote_flag_and_needs_the_owner() {
    let t = setup();
    let a = SigningKey::from_bytes(&[9; 32]);
    let key = pk(&t.e, &a);
    assert!(grant_as(&t, &t.owner, &key, 900, true));
    assert!(!grant_as(&t, &Address::generate(&t.e), &key, 900, false));
    assert!(vote(&t, &a, &a));
    assert!(grant_as(&t, &t.owner, &key, 900, false));
    assert!(!vote(&t, &a, &a));
    assert_eq!(mv(&t, &a, &a), Ok(()));
    assert!(!grant_as(&t, &Address::generate(&t.e), &key, 900, true));
    assert!(!vote(&t, &a, &a));
    assert!(grant_as(&t, &t.owner, &key, 900, true));
    assert!(vote(&t, &a, &a));
}

#[test]
fn the_owner_votes_only_with_its_own_authorization() {
    let t = setup();
    assert!(owner_vote(&t, Some(&t.owner)));
    assert!(!owner_vote(&t, Some(&Address::generate(&t.e))));
    assert!(!owner_vote(&t, None));
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

fn bytes_val(b: &[u8]) -> xdr::ScVal { xdr::ScVal::Bytes(xdr::ScBytes(b.to_vec().try_into().unwrap())) }

fn signed(t: &T, osk: &SigningKey, contract: &Address, name: &str, args: std::vec::Vec<xdr::ScVal>, nonce: i64, exp: u32) -> xdr::SorobanAuthorizationEntry {
    let inv = xdr::SorobanAuthorizedInvocation {
        function: xdr::SorobanAuthorizedFunction::ContractFn(xdr::InvokeContractArgs {
            contract_address: contract.try_into().unwrap(),
            function_name: name.try_into().unwrap(),
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
            address: (&t.owner).try_into().unwrap(),
            nonce,
            signature_expiration_ledger: exp,
            signature: bytes_val(&sig),
        }),
        root_invocation: inv,
    }
}

fn signed_grant(t: &T, osk: &SigningKey, key: &BytesN<32>, until: u32, vote: bool, nonce: i64, exp: u32) -> xdr::SorobanAuthorizationEntry {
    signed(t, osk, &t.id, "grant", std::vec![bytes_val(&key.to_array()), xdr::ScVal::U32(until), xdr::ScVal::Bool(vote)], nonce, exp)
}

fn submit(t: &T, entry: &xdr::SorobanAuthorizationEntry, key: &BytesN<32>, until: u32, vote: bool) -> bool {
    t.e.set_auths(&[entry.clone()]);
    matches!(t.client.try_grant(key, &until, &vote), Ok(Ok(())))
}

#[test]
fn a_held_back_entry_is_refused_after_a_revoke() {
    let (t, osk) = setup_signing_owner();
    let k = SigningKey::from_bytes(&[9; 32]);
    let key = pk(&t.e, &k);
    let first = signed_grant(&t, &osk, &key, 500 + 1_000, true, 11, 600);
    let held = signed_grant(&t, &osk, &key, 500 + 1_000, true, 22, 600);
    assert!(submit(&t, &first, &key, 500 + 1_000, true));
    assert_eq!(mv(&t, &k, &k), Ok(()));
    assert!(submit(&t, &signed_grant(&t, &osk, &key, 0, false, 33, 600), &key, 0, false));
    assert_eq!(mv(&t, &k, &k), Err(Ok(EXPIRED)));
    t.e.ledger().set_sequence_number(550);
    assert!(!submit(&t, &held, &key, 500 + 1_000, true));
    assert!(!vote(&t, &k, &k));
}

#[test]
fn a_far_future_entry_is_refused_after_a_revoke_and_the_revoke_outlives_its_signature() {
    let (t, osk) = setup_signing_owner();
    let k = SigningKey::from_bytes(&[9; 32]);
    let key = pk(&t.e, &k);
    let far = 500 + 120_960 + 50_000;
    let sleeper = signed_grant(&t, &osk, &key, far, true, 44, 500 + 200_000);
    assert!(!submit(&t, &sleeper, &key, far, true));
    assert!(submit(&t, &signed_grant(&t, &osk, &key, 0, false, 55, 600), &key, 0, false));
    t.e.ledger().set_sequence_number(far - 120_960);
    assert!(!submit(&t, &sleeper, &key, far, true));
    assert_eq!(mv(&t, &k, &k), Err(Ok(EXPIRED)));
    let left = t.e.as_contract(&t.id, || t.e.storage().temporary().get_ttl(&key));
    assert!(left >= 500 + 200_000 - (far - 120_960));
}

#[test]
fn the_vote_flag_is_bound_by_the_owners_signature() {
    let (t, osk) = setup_signing_owner();
    let k = SigningKey::from_bytes(&[9; 32]);
    let key = pk(&t.e, &k);
    let move_only = signed_grant(&t, &osk, &key, 900, false, 66, 600);
    assert!(!submit(&t, &move_only, &key, 900, true));
    assert!(!vote(&t, &k, &k));
    assert!(submit(&t, &move_only, &key, 900, false));
    assert_eq!(mv(&t, &k, &k), Ok(()));
    assert!(!vote(&t, &k, &k));
    let vote_grant = signed_grant(&t, &osk, &key, 900, true, 77, 600);
    assert!(!submit(&t, &vote_grant, &key, 900, false));
    assert!(submit(&t, &vote_grant, &key, 900, true));
    assert!(vote(&t, &k, &k));
}

#[test]
fn an_owners_signed_vote_covers_one_payload_only() {
    let (t, osk) = setup_signing_owner();
    let digest = [5u8; 32];
    let entry = signed(&t, &osk, &t.id, "verify", std::vec![bytes_val(&digest)], 88, 600);
    let go = |p: [u8; 32]| matches!(t.client.try_verify(&Bytes::from_array(&t.e, &p), &Bytes::new(&t.e), &Bytes::new(&t.e)), Ok(Ok(true)));
    t.e.set_auths(&[entry.clone()]);
    assert!(!go([8u8; 32]));
    t.e.set_auths(&[entry]);
    assert!(go(digest));
}

#[test]
fn a_revoked_key_is_never_granted_again_and_other_keys_still_are() {
    let t = setup();
    let (a, b) = (SigningKey::from_bytes(&[9; 32]), SigningKey::from_bytes(&[8; 32]));
    assert!(grant_as(&t, &t.owner, &pk(&t.e, &a), 900, true));
    assert!(grant_as(&t, &t.owner, &pk(&t.e, &a), 0, false));
    assert!(!grant_as(&t, &t.owner, &pk(&t.e, &a), 900, true));
    assert!(!grant_as(&t, &t.owner, &pk(&t.e, &a), 900, false));
    assert!(grant_as(&t, &t.owner, &pk(&t.e, &a), 0, false));
    assert!(grant_as(&t, &t.owner, &pk(&t.e, &b), 900, false));
    assert_eq!(mv(&t, &b, &b), Ok(()));
}
