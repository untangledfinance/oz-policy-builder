extern crate std;

use super::*;
use ed25519_dalek::{Signer as _, SigningKey};
use sha2::{Digest, Sha256};
use soroban_sdk::testutils::{
    storage::{Instance as _, Temporary as _},
    Address as _, Ledger as _,
};
use soroban_sdk::{IntoVal, InvokeError, Symbol};

const NOW: u64 = 1_800_000_000;
const NET: [u8; 32] = [7; 32];
const REFUSED: Error = Error::from_contract_error(1);
type R = Result<(), Result<Error, InvokeError>>;

fn sk(n: u8) -> SigningKey {
    SigningKey::from_bytes(&[n; 32])
}

fn pk(k: &SigningKey) -> [u8; 32] {
    k.verifying_key().to_bytes()
}

fn sha(parts: &[&[u8]]) -> [u8; 32] {
    let mut h = Sha256::new();
    parts.iter().for_each(|p| h.update(p));
    h.finalize().into()
}

fn xdr_bytes(e: &Env, a: &Address) -> std::vec::Vec<u8> {
    let x = a.clone().to_xdr(e);
    let mut v = std::vec![0u8; x.len() as usize];
    x.copy_into_slice(&mut v);
    v
}

fn raw(e: &Env, a: &Address) -> [u8; 32] {
    let v = xdr_bytes(e, a);
    v[v.len() - 32..].try_into().unwrap()
}

fn ghash(
    net: &[u8; 32],
    account: &[u8; 32],
    seat: &[u8; 32],
    key: &[u8; 32],
    s: u64,
    n: u64,
) -> [u8; 32] {
    sha(&[
        b"prime-seat-grant",
        net,
        account,
        seat,
        key,
        &s.to_be_bytes(),
        &n.to_be_bytes(),
    ])
}

struct T {
    e: Env,
    account: Address,
    seat: Address,
    owner: SigningKey,
    client: PrimeSeatClient<'static>,
}

fn setup() -> T {
    let e = Env::default();
    e.ledger().set_timestamp(NOW);
    e.ledger().set_sequence_number(500);
    e.ledger().set_network_id(NET);
    let account = Address::generate(&e);
    let owner = sk(1);
    let seat = e.register(
        PrimeSeat,
        (account.clone(), BytesN::from_array(&e, &pk(&owner))),
    );
    let client = PrimeSeatClient::new(&e, &seat);
    T {
        e,
        account,
        seat,
        owner,
        client,
    }
}

fn bn<const N: usize>(e: &Env, b: &[u8; N]) -> BytesN<N> {
    BytesN::from_array(e, b)
}

impl T {
    fn hash(&self, key: &SigningKey, start: u64, end: u64) -> [u8; 32] {
        ghash(
            &NET,
            &raw(&self.e, &self.account),
            &raw(&self.e, &self.seat),
            &pk(key),
            start,
            end,
        )
    }

    /// grant(key, start, end) with `by` named and `signer` signing the real hash.
    fn grant_by(
        &self,
        key: &SigningKey,
        start: u64,
        end: u64,
        by: &SigningKey,
        signer: &SigningKey,
    ) -> R {
        let sig = signer.sign(&self.hash(key, start, end)).to_bytes();
        let r = self.client.try_grant(
            &bn(&self.e, &pk(key)),
            &start,
            &end,
            &bn(&self.e, &pk(by)),
            &bn(&self.e, &sig),
        );
        r.map(|x| x.unwrap())
    }

    fn grant(&self, key: &SigningKey, start: u64, end: u64) -> R {
        self.grant_by(key, start, end, &self.owner, &self.owner)
    }

    /// A session for `key` from two minutes ago until `NOW + 3600`.
    fn live(&self, key: &SigningKey) {
        assert_eq!(self.grant(key, NOW - 120, NOW + 3600), Ok(()));
    }

    fn digest(&self, hash: &[u8; 32]) -> [u8; 32] {
        sha(&[&raw(&self.e, &self.seat), hash])
    }

    fn proof(&self, key: &SigningKey, signer: &SigningKey, hash: &[u8; 32]) -> Bytes {
        let mut p = std::vec::Vec::from(pk(key));
        p.extend_from_slice(&signer.sign(&self.digest(hash)).to_bytes());
        Bytes::from_slice(&self.e, &p)
    }

    fn verify(&self, kd: &Bytes, proof: &Bytes, hash: &[u8; 32]) -> Result<bool, ()> {
        let h = Bytes::from_array(&self.e, hash);
        self.client
            .try_verify(&h, kd, proof)
            .map(|x| x.unwrap())
            .map_err(|_| ())
    }

    fn kd(&self) -> Bytes {
        Bytes::from_array(&self.e, &raw(&self.e, &self.account))
    }

    fn check(
        &self,
        seat: &Address,
        key: &SigningKey,
        signer: &SigningKey,
        ctx: &Vec<Context>,
    ) -> R {
        let payload = [9u8; 32];
        let sig = signer
            .sign(&sha(&[&raw(&self.e, seat), &payload]))
            .to_bytes();
        self.e.try_invoke_contract_check_auth::<Error>(
            seat,
            &bn(&self.e, &payload),
            (bn(&self.e, &pk(key)), bn(&self.e, &sig)).into_val(&self.e),
            ctx,
        )
    }

    fn no_ctx(&self) -> Vec<Context> {
        Vec::new(&self.e)
    }

    fn ttl(&self, key: &SigningKey) -> u32 {
        self.e.as_contract(&self.seat, || {
            self.e.storage().temporary().get_ttl(&bn(&self.e, &pk(key)))
        })
    }

    fn at(&self, t: u64) {
        self.e.ledger().set_timestamp(t);
    }
}

fn is_crypto(r: &R) -> bool {
    matches!(r, Err(Ok(e)) if e.is_type(soroban_sdk::xdr::ScErrorType::Crypto))
}

#[test]
fn the_owner_grants_and_the_key_votes_and_acts() {
    let t = setup();
    let k = sk(9);
    t.live(&k);
    let h = [5u8; 32];
    assert_eq!(t.verify(&t.kd(), &t.proof(&k, &k, &h), &h), Ok(true));
    assert_eq!(t.check(&t.seat, &k, &k, &t.no_ctx()), Ok(()));
}

#[test]
fn only_the_owner_signs_a_grant() {
    let t = setup();
    let (k, stranger) = (sk(9), sk(4));
    let g = t.grant_by(&k, NOW - 120, NOW + 3600, &stranger, &stranger);
    assert_eq!(g, Err(Ok(REFUSED)));
    let g = t.grant_by(&k, NOW - 120, NOW + 3600, &k, &k);
    assert_eq!(g, Err(Ok(REFUSED)));
    let g = t.grant_by(&k, NOW - 120, NOW + 3600, &t.owner, &stranger);
    assert!(matches!(g, Err(Ok(e)) if e != REFUSED), "{g:?}");
    assert_eq!(t.check(&t.seat, &k, &k, &t.no_ctx()), Err(Ok(REFUSED)));
}

#[test]
fn a_grant_signed_for_another_account_seat_or_key_is_refused() {
    let t = setup();
    let k = sk(9);
    let (a, s) = (raw(&t.e, &t.account), raw(&t.e, &t.seat));
    let (start, end) = (NOW - 120, NOW + 3600);
    let other = [3u8; 32];
    let tries = [
        ghash(&NET, &other, &s, &pk(&k), start, end),
        ghash(&NET, &a, &other, &pk(&k), start, end),
        ghash(&NET, &a, &s, &pk(&sk(8)), start, end),
        ghash(&[8; 32], &a, &s, &pk(&k), start, end),
        ghash(&NET, &a, &s, &pk(&k), start + 1, end),
        ghash(&NET, &a, &s, &pk(&k), start, end + 1),
        sha(&[
            b"prime-seat-grant",
            &NET,
            &a,
            &s,
            &pk(&k),
            &start.to_be_bytes(),
            &end.to_be_bytes(),
        ]),
    ];
    for (i, h) in tries.iter().enumerate() {
        let sig = t.owner.sign(h).to_bytes();
        let r = t.client.try_grant(
            &bn(&t.e, &pk(&k)),
            &start,
            &end,
            &bn(&t.e, &pk(&t.owner)),
            &bn(&t.e, &sig),
        );
        assert_eq!(i < 6, r.is_err(), "try {i}");
    }
}

#[test]
fn the_grant_hash_equals_the_shared_vectors() {
    let vectors = [
        (
            "CAR5IKJTBWVHIVVS6KR5HNNTMDRXI6GRIIMFFDY7HXF3XERGLVS7DRMH",
            "CDZPWOQO4SRC6XOWIDYKCYK6DPBA25B542YKW7L56OAEYJVXZLZGDM4Z",
            "GAEPREQKX4GBTQSRLQV5J5C2LHRZQHMQNBKT7MHSFBGLRXWVBGFXLWXA",
            1791799080u64,
            1791827880u64,
            "20896a451e7ec53375a3134a86e263ad8af4a7098bb2c5c1dc86a853c8c3cc9b",
        ),
        (
            "CAEUBVIH42RV7DKYLJ44OCKZZCPUAKXDYLLU6YGQ44ZA7MWQQSFMAPMP",
            "CD3CMAIAJ6WGYO7OLV3RJSPXWHICHZT4UZ4G4IMVVS4ANIJ2IICOO5S3",
            "GDZCACRYUYVBDZVSLXU7ROAVMYIROLKG4NCD25HYQJXGTPHO5QFFL4SD",
            1791799080,
            1791885480,
            "6c92c0b522a1867d5fb114968e21e30cb0e8da3ce470300e373befba17d8275f",
        ),
        (
            "CDFRZ4MLT6W6KJ4QPXIKQ7PWOKH2AR53KRFRGPB4ELNHPO63KHZDKSFM",
            "CDAXPDLZS76OGJ6VTFTFA5LLJKT6YEMSTFKJE4F4EEKW6FOTIOVNQKSX",
            "GBGAPCP7YFJV4KGPEL65YPLJMCNWAOGZYXCUB27VOHBWXSMDVL3UWQ6R",
            1798761840,
            1799366640,
            "6a8afcc28414e2d52b05b2c9826d82a693d20e4423f867befd3c13da8a2b9c6f",
        ),
        (
            "CDP2UUBIKGBENTBJTHERJXPHD5PZURDBPECJAENXX7FWAHDSVOQKLNYN",
            "CDNM6GNBRYQA76J7DRVVEBNIY3CJD2XQCBHSHSFRKFLJL5V4DIV2TRR6",
            "GA3QYJJPQGO2IDCBDY5MFCX6UOW5MVLQWE4BZQDBT44WUX2726HU34H6",
            0,
            0,
            "11374e52f0fd2264b6552f5a2e776cd414a6e3b435cdeed7ac19416a92df2fe4",
        ),
    ];
    let testnet = Sha256::digest(b"Test SDF Network ; September 2015");
    for (account, seat, key, start, end, payload) in vectors {
        let e = Env::default();
        e.ledger().set_network_id(testnet.into());
        e.ledger().set_sequence_number(500);
        e.ledger()
            .set_timestamp(if end == 0 { 1_791_799_200 } else { start + 120 });
        let (account, seat_id) = (Address::from_str(&e, account), Address::from_str(&e, seat));
        let owner = sk(1);
        e.register_at(&seat_id, PrimeSeat, (account.clone(), bn(&e, &pk(&owner))));
        let key = raw(&e, &Address::from_str(&e, key));
        let want = hex(payload);
        assert_eq!(
            ghash(
                &testnet.into(),
                &raw(&e, &account),
                &raw(&e, &seat_id),
                &key,
                start,
                end
            ),
            want
        );
        let sig = owner.sign(&want).to_bytes();
        let c = PrimeSeatClient::new(&e, &seat_id);
        let r = c.try_grant(
            &bn(&e, &key),
            &start,
            &end,
            &bn(&e, &pk(&owner)),
            &bn(&e, &sig),
        );
        assert!(matches!(r, Ok(Ok(()))), "{seat}");
    }
}

fn hex(s: &str) -> [u8; 32] {
    core::array::from_fn(|i| u8::from_str_radix(&s[2 * i..2 * i + 2], 16).unwrap())
}

#[test]
fn the_window_runs_from_start_to_end_and_at_most_seven_days() {
    let k = sk(9);
    let cases = [
        (NOW, NOW + 1, true),
        (NOW + 1, NOW + 100, false),
        (NOW - 100, NOW, true),
        (NOW - 100, NOW - 1, false),
        (NOW - 120, NOW - 120 + 604_800, true),
        (NOW - 119, NOW - 119 + 604_800 + 1, false),
        (NOW - 604_800, NOW, true),
        (NOW - 604_801, NOW, false),
        (NOW, NOW, true),
        (NOW + 1, NOW, false),
        (NOW, NOW - 1, false),
    ];
    for (i, (start, end, ok)) in cases.into_iter().enumerate() {
        let t = setup();
        let r = t.grant(&k, start, end);
        assert_eq!(r, if ok { Ok(()) } else { Err(Ok(REFUSED)) }, "case {i}");
    }
}

#[test]
fn a_key_is_live_to_its_end_second_and_then_refused_while_its_entry_lives() {
    let t = setup();
    let k = sk(9);
    t.live(&k);
    let h = [5u8; 32];
    t.at(NOW + 3600);
    assert_eq!(t.verify(&t.kd(), &t.proof(&k, &k, &h), &h), Ok(true));
    assert_eq!(t.check(&t.seat, &k, &k, &t.no_ctx()), Ok(()));
    t.at(NOW + 3601);
    assert!(t.ttl(&k) > 0);
    assert_eq!(t.verify(&t.kd(), &t.proof(&k, &k, &h), &h), Ok(false));
    assert_eq!(t.check(&t.seat, &k, &k, &t.no_ctx()), Err(Ok(REFUSED)));
}

#[test]
fn an_ungranted_key_and_a_wrong_signature_are_refused() {
    let t = setup();
    let (k, other) = (sk(9), sk(8));
    let h = [5u8; 32];
    assert_eq!(t.verify(&t.kd(), &t.proof(&k, &k, &h), &h), Ok(false));
    assert_eq!(t.check(&t.seat, &k, &k, &t.no_ctx()), Err(Ok(REFUSED)));
    t.live(&k);
    assert_eq!(t.verify(&t.kd(), &t.proof(&k, &other, &h), &h), Err(()));
    assert!(is_crypto(&t.check(&t.seat, &k, &other, &t.no_ctx())));
    assert_eq!(
        t.verify(&t.kd(), &t.proof(&other, &other, &h), &h),
        Ok(false)
    );
}

#[test]
fn an_end_by_the_owner_or_by_the_key_is_final_and_a_stranger_cannot_end() {
    let (k, stranger) = (sk(9), sk(4));
    for by_key in [false, true] {
        let t = setup();
        t.live(&k);
        let early = t.owner.sign(&t.hash(&k, NOW - 120, NOW + 3600)).to_bytes();
        let r = t.grant_by(&k, 0, 0, &stranger, &stranger);
        assert_eq!(r, Err(Ok(REFUSED)));
        let by = if by_key { &k } else { &t.owner };
        assert_eq!(t.grant_by(&k, 0, 0, by, by), Ok(()));
        let h = [5u8; 32];
        assert_eq!(t.verify(&t.kd(), &t.proof(&k, &k, &h), &h), Ok(false));
        assert_eq!(t.check(&t.seat, &k, &k, &t.no_ctx()), Err(Ok(REFUSED)));
        let replay = t.client.try_grant(
            &bn(&t.e, &pk(&k)),
            &(NOW - 120),
            &(NOW + 3600),
            &bn(&t.e, &pk(&t.owner)),
            &bn(&t.e, &early),
        );
        assert_eq!(replay.map(|x| x.unwrap()), Err(Ok(REFUSED)));
        assert_eq!(t.grant(&k, NOW - 100, NOW + 100), Err(Ok(REFUSED)));
        assert_eq!(t.grant(&k, NOW - 100, NOW + 3000), Err(Ok(REFUSED)));
    }
}

#[test]
fn an_end_stores_zero_for_the_maximum_ttl_and_spares_other_keys() {
    let t = setup();
    let (a, b) = (sk(9), sk(8));
    t.live(&a);
    t.live(&b);
    let before =
        t.e.as_contract(&t.seat, || t.e.storage().instance().get_ttl());
    assert_eq!(t.grant(&a, 0, 0), Ok(()));
    assert_eq!(t.ttl(&a), t.e.storage().max_ttl());
    assert_eq!(
        t.e.as_contract(&t.seat, || t.e.storage().instance().get_ttl()),
        before
    );
    assert_eq!(t.check(&t.seat, &b, &b, &t.no_ctx()), Ok(()));
}

#[test]
fn a_key_never_granted_can_be_ended_in_advance() {
    let t = setup();
    let k = sk(9);
    assert_eq!(t.grant(&k, 0, 0), Ok(()));
    assert_eq!(t.grant(&k, NOW - 120, NOW + 3600), Err(Ok(REFUSED)));
}

#[test]
fn a_regrant_must_end_later_and_a_replay_cannot_shorten_a_session() {
    let t = setup();
    let k = sk(9);
    assert_eq!(t.grant(&k, NOW - 120, NOW + 3600), Ok(()));
    assert_eq!(t.grant(&k, NOW - 120, NOW + 3600), Err(Ok(REFUSED)));
    assert_eq!(t.grant(&k, NOW - 120, NOW + 3599), Err(Ok(REFUSED)));
    assert_eq!(t.grant(&k, NOW - 120, NOW + 7200), Ok(()));
    assert_eq!(t.grant(&k, NOW - 120, NOW + 3600), Err(Ok(REFUSED)));
    t.at(NOW + 7000);
    assert_eq!(t.check(&t.seat, &k, &k, &t.no_ctx()), Ok(()));
}

#[test]
fn the_entry_and_the_instance_live_past_the_end() {
    let t = setup();
    let k = sk(9);
    let before =
        t.e.as_contract(&t.seat, || t.e.storage().instance().get_ttl());
    t.live(&k);
    let want = (3600 / 4) as u32 + 1;
    assert_eq!(t.ttl(&k), want);
    assert_eq!(
        t.e.as_contract(&t.seat, || t.e.storage().instance().get_ttl()),
        want.max(before)
    );
    let long = sk(8);
    assert_eq!(t.grant(&long, NOW - 120, NOW - 120 + 604_800), Ok(()));
    let longest = ((604_800 - 120) / 4 + 1) as u32;
    assert_eq!(t.ttl(&long), longest);
    assert_eq!(
        t.e.as_contract(&t.seat, || t.e.storage().instance().get_ttl()),
        longest
    );
}

#[test]
fn verify_needs_this_seats_account_in_key_data() {
    let t = setup();
    let k = sk(9);
    t.live(&k);
    let h = [5u8; 32];
    let p = t.proof(&k, &k, &h);
    assert_eq!(t.verify(&t.kd(), &p, &h), Ok(true));
    let other = Bytes::from_array(&t.e, &raw(&t.e, &Address::generate(&t.e)));
    assert_eq!(t.verify(&other, &p, &h), Ok(false));
    assert_eq!(t.verify(&Bytes::new(&t.e), &p, &h), Ok(false));
    assert_eq!(t.verify(&Bytes::from_array(&t.e, &[0]), &p, &h), Ok(false));
}

#[test]
fn a_proof_covers_one_hash_and_names_the_seat() {
    let t = setup();
    let k = sk(9);
    t.live(&k);
    let (h, h2) = ([5u8; 32], [6u8; 32]);
    let p = t.proof(&k, &k, &h);
    assert_eq!(t.verify(&t.kd(), &p, &h2), Err(()));
    let bare = {
        let mut v = std::vec::Vec::from(pk(&k));
        v.extend_from_slice(&k.sign(&h).to_bytes());
        Bytes::from_slice(&t.e, &v)
    };
    assert_eq!(t.verify(&t.kd(), &bare, &h), Err(()));
}

#[test]
fn one_session_signature_serves_one_seat() {
    let t = setup();
    let second =
        t.e.register(PrimeSeat, (t.account.clone(), bn(&t.e, &pk(&sk(2)))));
    let c2 = PrimeSeatClient::new(&t.e, &second);
    let k = sk(9);
    t.live(&k);
    let h2 = ghash(
        &NET,
        &raw(&t.e, &t.account),
        &raw(&t.e, &second),
        &pk(&k),
        NOW - 120,
        NOW + 3600,
    );
    let sig = sk(2).sign(&h2).to_bytes();
    let g = c2.try_grant(
        &bn(&t.e, &pk(&k)),
        &(NOW - 120),
        &(NOW + 3600),
        &bn(&t.e, &pk(&sk(2))),
        &bn(&t.e, &sig),
    );
    assert!(matches!(g, Ok(Ok(()))));
    let h = [5u8; 32];
    let p = t.proof(&k, &k, &h);
    assert_eq!(t.verify(&t.kd(), &p, &h), Ok(true));
    let on_second = c2.try_verify(&Bytes::from_array(&t.e, &h), &t.kd(), &p);
    assert!(on_second.is_err());
    assert_eq!(t.check(&t.seat, &k, &k, &t.no_ctx()), Ok(()));
    assert!(t.check(&second, &k, &k, &t.no_ctx()).is_ok());
    let sig = k.sign(&sha(&[&raw(&t.e, &t.seat), &[9u8; 32]])).to_bytes();
    let wrong = t.e.try_invoke_contract_check_auth::<Error>(
        &second,
        &bn(&t.e, &[9u8; 32]),
        (bn(&t.e, &pk(&k)), bn(&t.e, &sig)).into_val(&t.e),
        &t.no_ctx(),
    );
    assert!(is_crypto(&wrong));
}

#[test]
fn canonical_keys_are_one_constant_per_seat() {
    let t = setup();
    let second =
        t.e.register(PrimeSeat, (Address::generate(&t.e), bn(&t.e, &pk(&sk(2)))));
    let keys = Vec::from_array(
        &t.e,
        [
            Bytes::from_array(&t.e, &[1]),
            Bytes::from_array(&t.e, &[2, 3]),
            t.kd(),
        ],
    );
    let out = t.client.batch_canonicalize_key(&keys);
    assert_eq!(out.len(), 3);
    assert_eq!(out.get(0), out.get(1));
    assert_eq!(out.get(1), out.get(2));
    assert_eq!(
        PrimeSeatClient::new(&t.e, &second).batch_canonicalize_key(&keys),
        out
    );
    assert_eq!(t.client.batch_canonicalize_key(&Vec::new(&t.e)).len(), 0);
}

#[test]
fn check_auth_ignores_the_contexts_because_a_delegated_seat_sees_only_the_accounts_own() {
    let t = setup();
    let k = sk(9);
    t.live(&k);
    let nested = Context::Contract(ContractContext {
        contract: t.account.clone(),
        fn_name: Symbol::new(&t.e, "__check_auth"),
        args: Vec::new(&t.e),
    });
    let other = Context::Contract(ContractContext {
        contract: Address::generate(&t.e),
        fn_name: Symbol::new(&t.e, "transfer"),
        args: Vec::new(&t.e),
    });
    let ctx = Vec::from_array(&t.e, [nested, other]);
    assert_eq!(t.check(&t.seat, &k, &k, &ctx), Ok(()));
}
