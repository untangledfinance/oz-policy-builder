//! Tests for the generic constructs of grammar 7: `lit`, `ne`/`nin`, numeric
//! widening, `lit` map keys, call-derived read arguments and the quantifiers.
//! Predicates are built as raw ScVals, the wire form a client sends.

// `&[x.clone()]` reads better than `from_ref` in one-line fixtures.
#![allow(clippy::cloned_ref_to_slice_refs)]

extern crate alloc;

use alloc::vec::Vec as StdVec;

use crate::dsl::{decode, evaluate, DecodeError, DenyReason, EvalContext, EvalDecision};
use soroban_sdk::xdr::{
    AccountId, ContractId, Duration, Hash, Int128Parts, MuxedEd25519Account, PublicKey, ScAddress,
    ScBytes, ScMap, ScMapEntry, ScString, ScSymbol, ScVal, ScVec, TimePoint, ToXdr, UInt128Parts,
    Uint256, VecM,
};
use soroban_sdk::{Address, Env, IntoVal, Symbol, TryFromVal, Val, Vec as SorobanVec};

pub(crate) fn sym(s: &str) -> ScVal {
    ScVal::Symbol(ScSymbol(s.as_bytes().to_vec().try_into().unwrap()))
}

pub(crate) fn tup(items: &[ScVal]) -> ScVal {
    let v: VecM<ScVal> = items.to_vec().try_into().unwrap();
    ScVal::Vec(Some(ScVec(v)))
}

pub(crate) fn n(v: i128) -> ScVal {
    ScVal::I128(Int128Parts {
        hi: (v >> 64) as i64,
        lo: v as u64,
    })
}

pub(crate) fn u128v(v: u128) -> ScVal {
    ScVal::U128(UInt128Parts {
        hi: (v >> 64) as u64,
        lo: v as u64,
    })
}

pub(crate) fn text(s: &str) -> ScVal {
    ScVal::String(ScString(s.as_bytes().to_vec().try_into().unwrap()))
}

pub(crate) fn blob(b: &[u8]) -> ScVal {
    ScVal::Bytes(ScBytes(b.to_vec().try_into().unwrap()))
}

pub(crate) fn account(tag: u8) -> ScVal {
    ScVal::Address(ScAddress::Contract(ContractId(Hash([tag; 32]))))
}

pub(crate) fn map(entries: &[(ScVal, ScVal)]) -> ScVal {
    let mut e: StdVec<ScMapEntry> = entries
        .iter()
        .map(|(k, v)| ScMapEntry {
            key: k.clone(),
            val: v.clone(),
        })
        .collect();
    e.sort_by(|a, b| a.key.cmp(&b.key));
    ScVal::Map(Some(ScMap(e.try_into().unwrap())))
}

pub(crate) fn lit(x: ScVal) -> ScVal {
    tup(&[sym("lit"), x])
}

pub(crate) fn arg(i: u32) -> ScVal {
    tup(&[sym("call_arg"), ScVal::U32(i)])
}

pub(crate) fn path(steps: &[ScVal]) -> ScVal {
    let mut v = alloc::vec![sym("call_path")];
    v.extend_from_slice(steps);
    tup(&v)
}

pub(crate) fn cmp(op: &str, a: ScVal, b: ScVal) -> ScVal {
    tup(&[sym(op), a, b])
}

pub(crate) fn set(op: &str, needle: ScVal, hay: &[ScVal]) -> ScVal {
    tup(&[sym(op), needle, tup(hay)])
}

pub(crate) fn and(kids: &[ScVal]) -> ScVal {
    tup(&[sym("and"), tup(kids)])
}

fn raw(env: &Env, pred: &ScVal) -> soroban_sdk::Bytes {
    let v: Val = pred.clone().into_val(env);
    v.to_xdr(env)
}

pub(crate) fn ctx(env: &Env, args: &[ScVal]) -> EvalContext {
    let vals: StdVec<Val> = args.iter().map(|a| a.clone().into_val(env)).collect();
    EvalContext {
        contract: Address::try_from_val(env, &account(0)).unwrap(),
        fn_name: Symbol::new(env, "go"),
        args: SorobanVec::from_slice(env, &vals),
    }
}

/// Decode at install strictness, then evaluate against `args`.
pub(crate) fn run(env: &Env, pred: &ScVal, args: &[ScVal]) -> Result<EvalDecision, DecodeError> {
    let node = decode(env, &raw(env, pred))?;
    Ok(evaluate(env, &node, &ctx(env, args)))
}

pub(crate) fn permits(pred: &ScVal, args: &[ScVal]) -> bool {
    let env = Env::default();
    run(&env, pred, args).expect("decodes") == EvalDecision::Permit
}

pub(crate) fn denies(pred: &ScVal, args: &[ScVal]) -> bool {
    !permits(pred, args)
}

pub(crate) fn refused(pred: &ScVal) -> Option<DecodeError> {
    let env = Env::default();
    decode(&env, &raw(&env, pred)).err()
}

const MALFORMED: Option<DecodeError> = Some(DecodeError::MalformedPredicate);

// ---- A: lit ----------------------------------------------------------------

#[test]
fn lit_matches_a_string_by_value_and_by_type() {
    let p = cmp("eq", arg(0), lit(text("USDC")));
    assert!(permits(&p, &[text("USDC")]));
    assert!(denies(&p, &[text("XLM")]));
    assert!(denies(&p, &[sym("USDC")]), "a symbol is not a string");
}

#[test]
fn lit_matches_bytes() {
    let p = cmp("eq", arg(0), lit(blob(&[1, 2, 3])));
    assert!(permits(&p, &[blob(&[1, 2, 3])]));
    assert!(denies(&p, &[blob(&[1, 2, 4])]));
    assert!(denies(&p, &[blob(&[1, 2])]));
}

#[test]
fn lit_matches_a_bool() {
    let p = cmp("eq", arg(0), lit(ScVal::Bool(true)));
    assert!(permits(&p, &[ScVal::Bool(true)]));
    assert!(denies(&p, &[ScVal::Bool(false)]));
    assert!(denies(&p, &[n(1)]), "1 is not true");
}

#[test]
fn lit_u64_is_a_number_like_any_other() {
    let p = cmp("eq", arg(0), lit(ScVal::U64(5)));
    assert!(permits(&p, &[ScVal::U64(5)]));
    assert!(permits(&p, &[n(5)]), "numbers compare by value");
    assert!(denies(&p, &[ScVal::U64(6)]));
    let order = cmp("lte", arg(0), lit(ScVal::U64(5)));
    assert!(permits(&order, &[n(4)]) && denies(&order, &[n(6)]));
}

#[test]
fn lit_matches_a_whole_map_and_works_in_in() {
    let m = map(&[(sym("a"), n(1))]);
    assert!(permits(&cmp("eq", arg(0), lit(m.clone())), &[m.clone()]));
    assert!(denies(
        &cmp("eq", arg(0), lit(m)),
        &[map(&[(sym("a"), n(2))])]
    ));
    let p = set("in", arg(0), &[lit(text("a")), lit(text("b"))]);
    assert!(permits(&p, &[text("b")]) && denies(&p, &[text("c")]));
}

#[test]
fn lit_is_a_constant_in_a_read_argument_and_an_enum_payload() {
    // an enum value is `lit([Tag, true])`: data, never a selector
    let p = cmp("eq", arg(0), lit(tup(&[sym("Tag"), ScVal::Bool(true)])));
    assert!(permits(&p, &[tup(&[sym("Tag"), ScVal::Bool(true)])]));
    assert!(denies(&p, &[tup(&[sym("Tag"), ScVal::Bool(false)])]));
    let read = tup(&[sym("read"), account(7), sym("f"), tup(&[lit(text("x"))])]);
    assert_eq!(refused(&cmp("eq", arg(0), read)), None);
}

#[test]
fn lit_must_be_a_number_to_be_ordered_or_scaled() {
    for bad in [text("1"), ScVal::Bool(true), blob(&[1]), u128v(u128::MAX)] {
        assert_eq!(refused(&cmp("lt", lit(bad.clone()), arg(0))), MALFORMED);
        let scaled = tup(&[sym("scaled"), lit(bad), n(1), n(1), n(0)]);
        assert_eq!(refused(&cmp("lt", scaled, arg(0))), MALFORMED);
    }
}

#[test]
fn lit_takes_exactly_one_operand() {
    assert_eq!(refused(&cmp("eq", arg(0), tup(&[sym("lit")]))), MALFORMED);
    let two = tup(&[sym("lit"), n(1), n(2)]);
    assert_eq!(refused(&cmp("eq", arg(0), two)), MALFORMED);
}

#[test]
fn bare_constants_are_still_accepted() {
    assert!(permits(&cmp("eq", arg(0), n(5)), &[n(5)]));
    assert!(permits(&cmp("eq", arg(0), account(1)), &[account(1)]));
    assert!(permits(&cmp("eq", arg(0), sym("x")), &[sym("x")]));
    let bare = tup(&[n(1), n(2)]);
    assert!(permits(&cmp("eq", arg(0), bare.clone()), &[bare]));
}

#[test]
fn a_symbol_headed_vec_is_data_inside_lit() {
    let data = tup(&[sym("call_fn")]);
    let p = cmp("eq", arg(0), lit(data.clone()));
    assert!(permits(&p, &[data]) && denies(&p, &[sym("call_fn")]));
}

// ---- C: numeric widening ---------------------------------------------------

/// The same number 5 (and 9, -3) in every integer type the host has.
fn forms(v: i64) -> StdVec<ScVal> {
    let mut all = alloc::vec![ScVal::I64(v), ScVal::I32(v as i32), n(i128::from(v))];
    if v >= 0 {
        all.extend([
            ScVal::Timepoint(TimePoint(v as u64)),
            ScVal::Duration(Duration(v as u64)),
            u128v(v as u128),
            ScVal::U64(v as u64),
            ScVal::U32(v as u32),
        ]);
    }
    all
}

#[test]
fn every_integer_type_equals_the_same_number() {
    let eq = cmp("eq", arg(0), n(5));
    let hay = set("in", arg(0), &[n(1), n(5)]);
    for five in forms(5) {
        assert!(permits(&eq, &[five.clone()]), "{five:?}");
        assert!(permits(&hay, &[five]));
    }
    for six in forms(6) {
        assert!(denies(&eq, &[six.clone()]) && denies(&hay, &[six]));
    }
}

#[test]
fn every_integer_type_orders_as_a_number() {
    let le = cmp("lte", arg(0), n(10));
    let gt = cmp("gt", arg(0), n(10));
    for nine in forms(9) {
        assert!(permits(&le, &[nine.clone()]) && denies(&gt, &[nine]));
    }
    for eleven in forms(11) {
        assert!(denies(&le, &[eleven.clone()]) && permits(&gt, &[eleven]));
    }
    let neg = cmp("lt", arg(0), n(0));
    for minus in forms(-3) {
        assert!(permits(&neg, &[minus]));
    }
}

#[test]
fn a_narrow_literal_equals_a_wide_argument() {
    let p = cmp("eq", arg(0), lit(ScVal::Duration(Duration(300))));
    assert!(permits(&p, &[ScVal::I64(300)]) && denies(&p, &[ScVal::I64(301)]));
}

#[test]
fn scaled_accepts_the_widened_types() {
    let p = cmp("eq", tup(&[sym("scaled"), arg(0), n(2), n(1), n(0)]), n(10));
    for five in forms(5) {
        assert!(permits(&p, &[five]));
    }
}

#[test]
fn a_u128_that_does_not_fit_i128_is_not_a_number() {
    let big = u128v(i128::MAX as u128 + 1);
    assert!(denies(&cmp("gte", arg(0), n(0)), &[big.clone()]));
    assert!(denies(&cmp("lte", arg(0), n(i128::MAX)), &[big.clone()]));
    assert!(denies(&cmp("eq", arg(0), n(i128::MAX)), &[big.clone()]));
    assert!(denies(&set("in", arg(0), &[n(i128::MAX)]), &[big.clone()]));
    let edge = u128v(i128::MAX as u128);
    assert!(permits(&cmp("eq", arg(0), n(i128::MAX)), &[edge]));
    // Not a number, but still a value: it equals itself exactly.
    assert!(permits(&cmp("eq", arg(0), lit(big.clone())), &[big]));
    assert!(denies(&cmp("eq", arg(0), lit(u128v(1))), &[u128v(2)]));
}

#[test]
fn non_integers_are_still_not_numbers() {
    for other in [ScVal::Bool(true), text("5"), sym("five"), ScVal::Void] {
        assert!(denies(&cmp("gte", arg(0), n(0)), &[other.clone()]));
        assert!(denies(&cmp("eq", arg(0), n(5)), &[other]));
    }
}

// ---- B: ne / nin -----------------------------------------------------------

fn reason(pred: &ScVal, args: &[ScVal]) -> Option<DenyReason> {
    let env = Env::default();
    match run(&env, pred, args).expect("decodes") {
        EvalDecision::Permit => None,
        EvalDecision::Deny(r) => Some(r),
    }
}

#[test]
fn nin_is_a_denylist() {
    let p = set("nin", arg(0), &[account(1), account(2)]);
    assert!(permits(&p, &[account(3)]));
    assert!(denies(&p, &[account(1)]));
    assert!(
        denies(&p, &[account(2)]),
        "every entry counts, not just the first"
    );
}

#[test]
fn nin_denies_when_the_needle_cannot_resolve() {
    let p = set("nin", arg(3), &[account(1)]);
    assert!(
        denies(&p, &[account(3)]),
        "no argument 3: not 'not in the list'"
    );
    assert!(denies(&p, &[]));
    // A failed read is unresolved too.
    let read = tup(&[sym("read"), account(7), sym("f"), tup(&[])]);
    assert!(denies(&set("nin", read, &[n(1)]), &[n(0)]));
}

#[test]
fn nin_and_ne_use_the_same_numeric_equality_as_eq_and_in() {
    let nin = set("nin", arg(0), &[n(5), n(7)]);
    for five in forms(5) {
        assert!(denies(&nin, &[five]));
    }
    for six in forms(6) {
        assert!(permits(&nin, &[six]));
    }
    let ne = cmp("ne", arg(0), n(5));
    for five in forms(5) {
        assert!(denies(&ne, &[five]));
    }
    assert!(permits(&ne, &[n(6)]));
}

#[test]
fn ne_permits_only_a_resolved_difference() {
    let p = cmp("ne", arg(1), account(1));
    assert!(permits(&p, &[n(0), account(2)]), "a different address");
    assert!(denies(&p, &[n(0), account(1)]), "the same address");
    assert!(
        denies(&p, &[n(0)]),
        "no argument 1: unresolved is not different"
    );
    assert!(permits(&p, &[n(0), n(9)]), "a different type is different");
}

#[test]
fn ne_on_the_call_selectors() {
    assert!(permits(
        &cmp("ne", tup(&[sym("call_fn")]), sym("other")),
        &[]
    ));
    let same = cmp("ne", tup(&[sym("call_fn")]), sym("go"));
    assert_eq!(reason(&same, &[]), Some(DenyReason::ArgMismatch));
    let other = cmp("ne", tup(&[sym("call_contract")]), account(9));
    assert!(permits(&other, &[]));
    let own = cmp("ne", tup(&[sym("call_contract")]), account(0));
    assert_eq!(reason(&own, &[]), Some(DenyReason::ContractScope));
}

#[test]
fn ne_with_an_unresolvable_side_denies_on_either_side() {
    assert!(denies(&cmp("ne", arg(4), n(1)), &[n(0)]));
    assert!(denies(&cmp("ne", n(1), arg(4)), &[n(0)]));
    assert!(denies(&cmp("ne", arg(4), arg(5)), &[n(0)]));
}

#[test]
fn ordering_over_a_selector_identity_is_still_unsupported() {
    let p = cmp("lt", tup(&[sym("call_fn")]), n(1));
    assert_eq!(reason(&p, &[]), Some(DenyReason::UnsupportedNode));
}

#[test]
fn nin_keeps_the_in_caps() {
    assert_eq!(refused(&set("nin", arg(0), &[])), MALFORMED);
    let many: StdVec<ScVal> = (0..33).map(n).collect();
    assert_eq!(
        refused(&set("nin", arg(0), &many)),
        Some(DecodeError::InOperandLimit)
    );
    let full: StdVec<ScVal> = (0..32).map(n).collect();
    assert_eq!(refused(&set("nin", arg(0), &full)), None);
}

#[test]
fn nin_costs_its_needle_once_and_each_entry_one_leaf() {
    // needle + 32 entries = 33 leaves, however the needle is written.
    let full: StdVec<ScVal> = (0..32).map(n).collect();
    let six: StdVec<ScVal> = (0..6).map(|_| set("nin", arg(0), &full)).collect();
    assert_eq!(refused(&and(&six)), None, "198 leaves");
    let seven: StdVec<ScVal> = (0..7).map(|_| set("nin", arg(0), &full)).collect();
    assert_eq!(
        refused(&and(&seven)),
        Some(DecodeError::TooManyLeaves),
        "231"
    );
    // a needle that is itself four leaves is counted once, not per entry
    let scaled = tup(&[sym("scaled"), arg(0), n(2), n(1), n(0)]);
    let big = set("nin", scaled, &full);
    let rest: StdVec<ScVal> = (0..20).map(|_| cmp("eq", arg(1), n(1))).collect();
    let fits = [alloc::vec![big.clone()], rest.clone()].concat();
    assert_eq!(refused(&and(&fits)), None, "36 + 40 leaves");
}

#[test]
fn nin_in_a_body_holds_five_entries_like_in() {
    let over = path(&[ScVal::U32(0)]);
    let body = |k: i128| {
        all_of(
            over.clone(),
            set("nin", elem(&[]), &(0..k).map(n).collect::<StdVec<_>>()),
        )
    };
    assert_eq!(refused(&body(5)), None);
    assert_eq!(refused(&body(6)), Some(DecodeError::TooManyLeaves));
}

#[test]
fn nin_resolves_a_read_needle_once() {
    // A call-derived read is its own call at decode: `nin` over it must spend
    // one read slot, not one per entry (a registry-backed denylist).
    let read = tup(&[sym("read"), account(7), sym("f"), tup(&[arg(0)])]);
    let entries: StdVec<ScVal> = (0..32).map(n).collect();
    assert_eq!(refused(&set("nin", read.clone(), &entries)), None);
    let other = tup(&[sym("read"), account(8), sym("g"), tup(&[arg(0)])]);
    let three = [
        set("nin", read.clone(), &entries),
        cmp("eq", other.clone(), n(1)),
        cmp("eq", other.clone(), n(1)),
        cmp("eq", other, n(1)),
    ];
    assert_eq!(refused(&and(&three)), None, "4 call-derived reads");
    let five = [
        alloc::vec![set("nin", read.clone(), &entries)],
        (0..4)
            .map(|i| {
                tup(&[
                    sym("eq"),
                    tup(&[sym("read"), account(9), sym("h"), tup(&[arg(i)])]),
                    n(1),
                ])
            })
            .collect(),
    ]
    .concat();
    assert_eq!(
        refused(&and(&five)),
        Some(DecodeError::TooManyLeaves),
        "a fifth distinct call"
    );
}

#[test]
fn nin_denies_with_arg_mismatch_whichever_side_is_a_selector() {
    let own = set("nin", tup(&[sym("call_contract")]), &[account(0)]);
    assert_eq!(reason(&own, &[]), Some(DenyReason::ArgMismatch));
    assert_eq!(
        reason(&set("nin", arg(0), &[n(1)]), &[n(1)]),
        Some(DenyReason::ArgMismatch)
    );
    assert_eq!(
        reason(&set("nin", arg(5), &[n(1)]), &[n(1)]),
        Some(DenyReason::ArgMismatch)
    );
}

#[test]
fn an_address_keyed_map_is_walked_with_a_lit_key() {
    let book = |a: i128, b: i128| map(&[(account(1), n(a)), (account(2), n(b))]);
    let cap = cmp("lte", path(&[ScVal::U32(0), lit(account(1))]), n(150));
    assert!(permits(&cap, &[book(100, 900)]));
    assert!(
        denies(&cap, &[book(151, 0)]),
        "the key's own value, not the other"
    );
    assert!(denies(&cap, &[map(&[(account(3), n(1))])]), "key absent");
    assert!(denies(&cap, &[n(5)]), "not a map");
    let second = cmp("eq", path(&[ScVal::U32(0), lit(account(2))]), n(900));
    assert!(permits(&second, &[book(100, 900)]) && denies(&second, &[book(100, 1)]));
}

#[test]
fn a_bare_address_or_symbol_is_a_key_too() {
    let by_addr = cmp("eq", path(&[ScVal::U32(0), account(1)]), n(7));
    assert!(permits(&by_addr, &[map(&[(account(1), n(7))])]));
    let by_sym = cmp("eq", path(&[ScVal::U32(0), sym("fee")]), n(7));
    assert!(permits(&by_sym, &[map(&[(sym("fee"), n(7))])]));
    assert!(denies(&by_sym, &[map(&[(sym("tax"), n(7))])]));
}

#[test]
fn a_numeric_key_needs_lit_because_a_bare_u32_is_an_index() {
    let m = map(&[(ScVal::U32(7), n(5))]);
    let keyed = cmp("eq", path(&[ScVal::U32(0), lit(ScVal::U32(7))]), n(5));
    assert!(permits(&keyed, &[m.clone()]));
    let bare = cmp("eq", path(&[ScVal::U32(0), ScVal::U32(7)]), n(5));
    assert!(
        denies(&bare, &[m.clone()]),
        "a bare u32 indexes a vec, never a map"
    );
    let vec = tup(&[n(0), n(0), n(0), n(0), n(0), n(0), n(0), n(5)]);
    assert!(permits(&bare, &[vec.clone()]) && denies(&keyed, &[vec]));
    // The key's type is part of it: an i128 7 is not a u32 7.
    let wide = cmp("eq", path(&[ScVal::U32(0), n(7)]), n(5));
    assert!(denies(&wide, &[m]));
    assert!(permits(&wide, &[map(&[(n(7), n(5))])]));
}

#[test]
fn text_bool_and_bytes_keys() {
    for (k, other) in [
        (text("usd"), text("eur")),
        (ScVal::Bool(true), ScVal::Bool(false)),
        (blob(&[1, 2]), blob(&[1, 3])),
    ] {
        let p = cmp("eq", path(&[ScVal::U32(0), lit(k.clone())]), n(1));
        assert!(permits(&p, &[map(&[(k.clone(), n(1))])]));
        assert!(denies(&p, &[map(&[(other, n(1))])]));
    }
}

#[test]
fn a_step_that_is_not_a_constant_is_refused() {
    let selector = path(&[ScVal::U32(0), tup(&[sym("call_fn")])]);
    assert_eq!(refused(&cmp("eq", selector, n(1))), MALFORMED);
    let bad = path(&[ScVal::U32(0), tup(&[sym("lit")])]);
    assert_eq!(refused(&cmp("eq", bad, n(1))), MALFORMED);
}

#[test]
fn len_is_still_only_the_last_step() {
    let ok = cmp("eq", path(&[ScVal::U32(0), ScVal::Bool(true)]), n(2));
    assert!(permits(&ok, &[tup(&[n(1), n(1)])]));
    let mid = cmp(
        "eq",
        path(&[ScVal::U32(0), ScVal::Bool(true), ScVal::U32(0)]),
        n(2),
    );
    assert_eq!(refused(&mid), MALFORMED);
}

// ---- F: quantifiers --------------------------------------------------------

fn all_of(over: ScVal, body: ScVal) -> ScVal {
    tup(&[sym("all"), over, body])
}

fn any_of(over: ScVal, body: ScVal) -> ScVal {
    tup(&[sym("any"), over, body])
}

fn elem(steps: &[ScVal]) -> ScVal {
    let mut v = alloc::vec![sym("elem")];
    v.extend_from_slice(steps);
    tup(&v)
}

fn sum(over: ScVal, steps: &[ScVal]) -> ScVal {
    let mut v = alloc::vec![sym("sum"), over];
    v.extend_from_slice(steps);
    tup(&v)
}

fn list(items: &[ScVal]) -> ScVal {
    tup(items)
}

const CAP: usize = crate::dsl::MAX_ELEMS as usize;

fn payment(to: u8, amount: i128) -> ScVal {
    map(&[(sym("to"), account(to)), (sym("amount"), n(amount))])
}

/// Multi-recipient payout: every recipient is approved, no amount is negative
/// (so the total cannot be lowered by one), and the batch total is at most 1000.
/// The body has 5 leaves (160 of the 200 budget), the vector 1 and the total 34
/// (a `sum` weighs `MAX_ELEMS`, as it walks that many elements): 195.
fn payout_rule() -> ScVal {
    let body = and(&[
        set("in", elem(&[sym("to")]), &[account(1), account(2)]),
        cmp("gte", elem(&[sym("amount")]), n(0)),
    ]);
    and(&[
        all_of(path(&[ScVal::U32(0)]), body),
        cmp(
            "lte",
            sum(path(&[ScVal::U32(0)]), &[sym("amount")]),
            n(1000),
        ),
    ])
}

#[test]
fn payout_permits_approved_recipients_within_the_total() {
    let p = payout_rule();
    assert!(permits(&p, &[list(&[payment(1, 400), payment(2, 600)])]));
    assert!(permits(&p, &[list(&[payment(2, 1000)])]));
    assert!(permits(&p, &[list(&[payment(1, 0)])]));
}

#[test]
fn payout_refuses_each_way_of_breaking_a_rule() {
    let p = payout_rule();
    let one = |pay: ScVal| [list(&[pay])];
    assert!(
        denies(&p, &[list(&[payment(1, 100), payment(9, 100)])]),
        "stranger"
    );
    assert!(
        denies(&p, &[list(&[payment(9, 100), payment(1, 100)])]),
        "stranger first"
    );
    assert!(denies(&p, &one(payment(1, -1))), "a negative amount");
    // the negative one is what would lower the total of a larger payment
    assert!(
        denies(&p, &[list(&[payment(1, 1500), payment(2, -600)])]),
        "net 900"
    );
    assert!(denies(&p, &one(payment(1, 1001))), "over the total");
    assert!(
        denies(&p, &one(map(&[(sym("to"), account(1))]))),
        "no amount"
    );
    assert!(denies(&p, &one(n(5))), "element is not a map");
    assert!(denies(&p, &[n(5)]), "not a vector");
    assert!(denies(&p, &[]), "no argument");
}

#[test]
fn payout_total_is_checked_at_its_boundary() {
    let p = payout_rule();
    assert!(
        permits(&p, &[list(&[payment(1, 500), payment(2, 500)])]),
        "exactly 1000"
    );
    assert!(
        denies(&p, &[list(&[payment(1, 500), payment(2, 501)])]),
        "1001"
    );
}

#[test]
fn a_sum_weighs_as_many_leaves_as_it_walks_elements() {
    // gte(sum(v), 0) is a sum (32) + its vector (1) + the constant (1): 34 leaves.
    let total = || cmp("gte", sum(path(&[ScVal::U32(0)]), &[]), n(0));
    let sums = |k: usize| and(&(0..k).map(|_| total()).collect::<StdVec<_>>());
    assert_eq!(refused(&sums(5)), None, "170 leaves");
    assert_eq!(
        refused(&sums(6)),
        Some(DecodeError::TooManyLeaves),
        "204 leaves"
    );
}

/// Adapter batch of any length: every call targets an approved contract, and at
/// least one of them is `repay`.
fn batch_rule() -> ScVal {
    let calls = path(&[ScVal::U32(0)]);
    and(&[
        all_of(
            calls.clone(),
            set("in", elem(&[sym("target")]), &[account(1), account(2)]),
        ),
        any_of(
            calls,
            cmp("eq", elem(&[sym("function_name")]), sym("repay")),
        ),
    ])
}

/// The execution adapter's `Call`: target, function_name, args and
/// executor_authorizations.
fn call(target: u8, f: &str) -> ScVal {
    map(&[
        (sym("target"), account(target)),
        (sym("function_name"), sym(f)),
        (sym("args"), tup(&[])),
        (sym("executor_authorizations"), tup(&[])),
    ])
}

/// `len` calls, the last of which is `last`.
fn batch(len: usize, last: ScVal) -> ScVal {
    let mut calls: StdVec<ScVal> = (1..len).map(|_| call(1, "supply")).collect();
    if len > 0 {
        calls.push(last);
    }
    list(&calls)
}

#[test]
fn a_batch_of_any_length_up_to_the_cap_is_judged_element_by_element() {
    let p = batch_rule();
    for len in [1, 2, 8, CAP] {
        assert!(permits(&p, &[batch(len, call(2, "repay"))]), "len {len}");
        assert!(
            denies(&p, &[batch(len, call(2, "supply"))]),
            "len {len}: no repay"
        );
        assert!(
            denies(&p, &[batch(len, call(9, "repay"))]),
            "len {len}: target"
        );
    }
}

#[test]
fn a_batch_over_the_cap_is_refused_even_if_every_element_is_fine() {
    let p = batch_rule();
    assert!(denies(&p, &[batch(CAP + 1, call(2, "repay"))]));
    assert!(denies(&p, &[batch(CAP + 100, call(2, "repay"))]));
    assert!(permits(&p, &[batch(CAP, call(2, "repay"))]));
}

#[test]
fn an_empty_batch_has_nothing_to_repay() {
    let p = batch_rule();
    assert!(denies(&p, &[batch(0, call(1, "repay"))]));
    // `all` of nothing holds; it is `any` that fails.
    let only_all = all_of(path(&[ScVal::U32(0)]), cmp("eq", elem(&[]), n(1)));
    assert!(permits(&only_all, &[list(&[])]));
    let only_any = any_of(path(&[ScVal::U32(0)]), cmp("eq", elem(&[]), n(1)));
    assert!(denies(&only_any, &[list(&[])]));
}

#[test]
fn the_element_cap_applies_to_all_any_and_sum() {
    let ones = |len: usize| list(&(0..len).map(|_| n(1)).collect::<StdVec<_>>());
    let over = path(&[ScVal::U32(0)]);
    let all = all_of(over.clone(), cmp("eq", elem(&[]), n(1)));
    let any = any_of(over.clone(), cmp("eq", elem(&[]), n(1)));
    let total = cmp("gte", sum(over, &[]), n(0));
    for p in [&all, &any, &total] {
        assert!(permits(p, &[ones(CAP)]));
        assert!(denies(p, &[ones(CAP + 1)]));
    }
}

#[test]
fn a_swap_route_is_checked_with_a_bare_elem() {
    let route = path(&[ScVal::U32(1)]);
    let p = and(&[
        all_of(
            route.clone(),
            set("in", elem(&[]), &[account(1), account(2), account(3)]),
        ),
        cmp("eq", path(&[ScVal::U32(1), ScVal::U32(0)]), arg(0)),
        cmp("lte", path(&[ScVal::U32(1), ScVal::Bool(true)]), n(3)),
    ]);
    let hops = |h: &[u8]| list(&h.iter().map(|t| account(*t)).collect::<StdVec<_>>());
    assert!(permits(&p, &[account(1), hops(&[1, 2, 3])]));
    assert!(permits(&p, &[account(2), hops(&[2, 1])]));
    assert!(
        denies(&p, &[account(1), hops(&[1, 9, 3])]),
        "a hop off the list"
    );
    assert!(
        denies(&p, &[account(1), hops(&[2, 3])]),
        "wrong first token"
    );
    assert!(denies(&p, &[account(1), hops(&[1, 2, 3, 1])]), "four hops");
    assert!(
        denies(&p, &[account(1), account(1)]),
        "route is not a vector"
    );
}

#[test]
fn an_unresolvable_element_fails_all_and_is_skipped_by_any() {
    let by_key = |q: fn(ScVal, ScVal) -> ScVal| {
        q(path(&[ScVal::U32(0)]), cmp("eq", elem(&[sym("k")]), n(7)))
    };
    let good = map(&[(sym("k"), n(7))]);
    let bare = map(&[(sym("other"), n(7))]);
    // `all`: the element without the key cannot make the body true.
    assert!(permits(
        &by_key(all_of),
        &[list(&[good.clone(), good.clone()])]
    ));
    assert!(denies(
        &by_key(all_of),
        &[list(&[good.clone(), bare.clone()])]
    ));
    // `any`: it does not count, and does not stop a later element counting.
    assert!(permits(
        &by_key(any_of),
        &[list(&[bare.clone(), good.clone()])]
    ));
    assert!(denies(&by_key(any_of), &[list(&[bare.clone(), bare])]));
    assert!(
        denies(&by_key(any_of), &[list(&[n(1), n(2)])]),
        "elements that are not maps"
    );
}

#[test]
fn a_quantifier_over_something_that_is_not_a_vec_denies() {
    for over in [
        path(&[ScVal::U32(0)]),
        n(5),
        lit(text("abc")),
        lit(map(&[])),
    ] {
        for q in [all_of, any_of] {
            let p = q(over.clone(), cmp("eq", elem(&[]), n(1)));
            assert!(denies(&p, &[n(5)]) && denies(&p, &[]) && denies(&p, &[text("abc")]));
        }
    }
}

#[test]
fn sum_adds_numbers_of_every_integer_type() {
    let total = |want: i128| cmp("eq", sum(path(&[ScVal::U32(0)]), &[]), n(want));
    let mixed = list(&[
        ScVal::U32(1),
        ScVal::I64(-3),
        ScVal::U64(10),
        n(100),
        u128v(5),
        ScVal::I32(7),
    ]);
    assert!(permits(&total(120), &[mixed.clone()]));
    assert!(denies(&total(121), &[mixed]));
    assert!(permits(&total(0), &[list(&[])]), "the sum of nothing is 0");
    // usable anywhere a value is: as a `scaled` operand and on the left of a compare
    let scaled = tup(&[
        sym("scaled"),
        sum(path(&[ScVal::U32(0)]), &[]),
        n(2),
        n(1),
        n(0),
    ]);
    assert!(permits(&cmp("eq", scaled, n(12)), &[list(&[n(2), n(4)])]));
}

#[test]
fn sum_is_an_error_when_an_element_is_not_a_number_or_the_total_overflows() {
    let total = cmp("gte", sum(path(&[ScVal::U32(0)]), &[]), n(i128::MIN));
    assert!(denies(&total, &[list(&[n(1), text("2")])]), "a string");
    assert!(
        denies(&total, &[list(&[n(1), u128v(u128::MAX)])]),
        "a u128 that does not fit"
    );
    assert!(denies(&total, &[list(&[n(1), ScVal::Void])]), "void");
    assert!(
        permits(&total, &[list(&[n(i128::MAX), n(-1)])]),
        "no overflow at the edge"
    );
    let overflow = [n(i128::MAX), n(1)];
    assert!(denies(&total, &[list(&overflow)]));
    assert_eq!(
        reason(
            &cmp("eq", sum(path(&[ScVal::U32(0)]), &[]), n(0)),
            &[list(&overflow)]
        ),
        Some(DenyReason::ArithmeticOverflow)
    );
    let under = [n(i128::MIN), n(-1)];
    assert!(denies(&total, &[list(&under)]));
    // a missing field is not a zero
    let keyed = cmp("gte", sum(path(&[ScVal::U32(0)]), &[sym("v")]), n(0));
    assert!(denies(
        &keyed,
        &[list(&[map(&[(sym("v"), n(1))]), map(&[])])]
    ));
}

#[test]
fn quantifiers_do_not_nest_and_sum_stays_out_of_a_body() {
    let over = path(&[ScVal::U32(0)]);
    let inner = all_of(elem(&[]), cmp("eq", elem(&[]), n(1)));
    for q in [all_of, any_of] {
        // inside the body directly, and under `and`
        assert_eq!(refused(&q(over.clone(), inner.clone())), MALFORMED);
        assert_eq!(
            refused(&q(
                over.clone(),
                and(&[inner.clone(), cmp("eq", elem(&[]), n(1))])
            )),
            MALFORMED
        );
        let in_sum = cmp("lte", elem(&[]), sum(over.clone(), &[]));
        assert_eq!(
            refused(&q(over.clone(), in_sum)),
            MALFORMED,
            "sum in a body"
        );
        let nested_sum = cmp(
            "lte",
            elem(&[]),
            tup(&[sym("scaled"), sum(over.clone(), &[]), n(1), n(1), n(0)]),
        );
        assert_eq!(
            refused(&q(over.clone(), nested_sum)),
            MALFORMED,
            "sum inside scaled inside a body"
        );
    }
    // the same pieces are fine outside one
    assert_eq!(
        refused(&and(&[
            all_of(over.clone(), cmp("eq", elem(&[]), n(1))),
            cmp("lte", sum(over, &[]), n(9))
        ])),
        None
    );
}

#[test]
fn elem_outside_a_body_is_refused() {
    let over = path(&[ScVal::U32(0)]);
    assert_eq!(refused(&cmp("eq", elem(&[]), n(1))), MALFORMED);
    assert_eq!(refused(&cmp("eq", arg(0), elem(&[sym("k")]))), MALFORMED);
    // the vector a quantifier walks is outside its own body
    assert_eq!(
        refused(&all_of(elem(&[]), cmp("eq", arg(0), n(1)))),
        MALFORMED
    );
    // so is a `sum` over an element, even if a quantifier is elsewhere
    let outside = and(&[
        all_of(over.clone(), cmp("eq", elem(&[]), n(1))),
        cmp("eq", sum(elem(&[]), &[]), n(1)),
    ]);
    assert_eq!(refused(&outside), MALFORMED);
    // a quantifier body cannot hand the element to a read
    let read = tup(&[sym("read"), account(7), sym("f"), tup(&[elem(&[])])]);
    assert_eq!(refused(&all_of(over, cmp("eq", read, n(1)))), MALFORMED);
}

#[test]
fn a_quantifier_must_still_constrain_the_call() {
    // over a call path: a selector
    let ok = all_of(path(&[ScVal::U32(0)]), cmp("eq", elem(&[]), n(1)));
    let env = Env::default();
    let node = decode(&env, &raw(&env, &ok)).unwrap();
    assert!(crate::dsl::has_selector_leaf(&node));
    // over a constant vector: not
    let none = all_of(lit(list(&[n(1)])), cmp("eq", elem(&[]), n(1)));
    let node = decode(&env, &raw(&env, &none)).unwrap();
    assert!(!crate::dsl::has_selector_leaf(&node));
    // a call-derived leaf inside the body counts as well
    let body = all_of(lit(list(&[n(1)])), cmp("eq", elem(&[]), arg(0)));
    assert!(crate::dsl::has_selector_leaf(
        &decode(&env, &raw(&env, &body)).unwrap()
    ));
}

/// `1` for the vector, 32 per body leaf, plus `rest` leaves outside.
fn budget(body_leaves: usize, rest_compares: usize, rest_in: bool) -> ScVal {
    let mut body: StdVec<ScVal> = (0..body_leaves / 2)
        .map(|_| cmp("eq", elem(&[]), n(1)))
        .collect();
    if body_leaves % 2 == 1 {
        body.push(set("in", elem(&[]), &[n(1)]));
    }
    let mut rest: StdVec<ScVal> = (0..rest_compares)
        .map(|_| cmp("eq", arg(0), n(1)))
        .collect();
    if rest_in {
        rest.push(set("in", arg(0), &[n(1), n(2)]));
    }
    let mut all = alloc::vec![all_of(path(&[ScVal::U32(0)]), and(&body))];
    all.extend(rest);
    and(&all)
}

#[test]
fn each_body_leaf_counts_thirty_two_times_toward_the_leaf_cap() {
    let cap = crate::dsl::MAX_LEAVES as usize;
    // 6 body leaves: 1 + 6 * 32 = 193; 7 more leaves outside make exactly 200.
    assert_eq!(refused(&budget(6, 2, true)), None, "200 leaves");
    assert_eq!(
        refused(&budget(6, 4, false)),
        Some(DecodeError::TooManyLeaves),
        "201"
    );
    assert_eq!(refused(&budget(6, 3, false)), None, "199");
    // 7 body leaves is 225 by itself.
    assert_eq!(
        refused(&budget(7, 0, false)),
        Some(DecodeError::TooManyLeaves)
    );
    assert_eq!(cap, 200);
}

#[test]
fn nesting_is_refused_even_when_the_inner_body_has_no_elem() {
    // Weight 32 x 32 would also trip the leaf cap, but the refusal does not
    // depend on the cap: it is the structure that is not allowed.
    let over = path(&[ScVal::U32(0)]);
    let inner = all_of(path(&[ScVal::U32(1)]), cmp("eq", arg(2), n(1)));
    for q in [all_of, any_of] {
        assert_eq!(refused(&q(over.clone(), inner.clone())), MALFORMED);
    }
    // and one made of nothing but `elem` leaves, which no per-leaf count can see
    let only_elem = all_of(elem(&[]), cmp("eq", elem(&[]), elem(&[])));
    assert_eq!(refused(&all_of(over, only_elem)), MALFORMED);
}

#[test]
fn quantifiers_take_exactly_a_vec_and_a_body() {
    let over = path(&[ScVal::U32(0)]);
    let body = cmp("eq", elem(&[]), n(1));
    for q in ["all", "any"] {
        assert_eq!(refused(&tup(&[sym(q), over.clone()])), MALFORMED, "no body");
        assert_eq!(
            refused(&tup(&[sym(q), over.clone(), body.clone(), body.clone()])),
            MALFORMED
        );
        assert_eq!(
            refused(&tup(&[sym(q), over.clone(), n(1)])),
            MALFORMED,
            "body not a node"
        );
        assert_eq!(refused(&tup(&[sym(q), over.clone(), body.clone()])), None);
    }
    // a `sum` needs its vec; extra steps are steps, not operands
    assert_eq!(refused(&cmp("eq", tup(&[sym("sum")]), n(1))), MALFORMED);
}

#[test]
fn a_quantifier_over_a_non_vec_does_not_become_an_empty_one() {
    // `all` of nothing permits, so a non-vec turned into "nothing" would permit.
    let p = all_of(path(&[ScVal::U32(0)]), cmp("eq", elem(&[]), n(1)));
    for not_a_vec in [n(0), text("x"), map(&[]), ScVal::Void, ScVal::Bool(true)] {
        assert!(denies(&p, &[not_a_vec]));
    }
    assert!(permits(&p, &[list(&[])]));
}

#[test]
fn a_bare_false_step_is_a_key_and_only_true_is_the_length() {
    let m = map(&[(ScVal::Bool(false), n(9))]);
    let by_false = cmp("eq", path(&[ScVal::U32(0), ScVal::Bool(false)]), n(9));
    assert!(permits(&by_false, &[m]));
    let by_true = cmp("eq", path(&[ScVal::U32(0), ScVal::Bool(true)]), n(1));
    assert!(permits(&by_true, &[list(&[n(0)])]));
}

#[test]
fn leaf_nesting_is_capped_through_sum_and_read_arguments() {
    let depth = crate::dsl::MAX_DEPTH as usize;
    // sum(sum(...sum(path))): each sum's vec is one level deeper
    let chain = |n_sums: usize| {
        let mut leaf = path(&[ScVal::U32(0)]);
        for _ in 0..n_sums {
            leaf = sum(leaf, &[]);
        }
        cmp("gte", leaf, n(0))
    };
    assert_eq!(refused(&chain(depth - 1)), None);
    assert_eq!(refused(&chain(depth)), Some(DecodeError::PredicateTooDeep));
    // a bare vec of vecs as a read argument is a constant of nested leaves
    let nested = |levels: usize| {
        let mut v = n(1);
        for _ in 0..levels {
            v = tup(&[v]);
        }
        let read = tup(&[sym("read"), account(7), sym("f"), tup(&[v])]);
        cmp("eq", arg(0), read)
    };
    assert_eq!(refused(&nested(3)), None);
    assert_eq!(refused(&nested(4)), Some(DecodeError::PredicateTooDeep));
}

// ---- audit follow-ups: object-form integers, arities, depth ----------------

#[test]
fn integers_too_big_for_the_inline_form_still_widen() {
    // Above 2^56 the host holds these as objects, not inline values.
    let cases = [
        (ScVal::U64(u64::MAX), n(i128::from(u64::MAX))),
        (ScVal::I64(i64::MIN), n(i128::from(i64::MIN))),
        (
            ScVal::Timepoint(TimePoint(u64::MAX)),
            n(i128::from(u64::MAX)),
        ),
        (ScVal::Duration(Duration(1 << 60)), n(1 << 60)),
        (u128v(1 << 100), n(1 << 100)),
    ];
    for (big, same) in cases {
        assert!(
            permits(&cmp("eq", arg(0), same.clone()), &[big.clone()]),
            "{big:?}"
        );
        assert!(
            permits(&cmp("gte", arg(0), same.clone()), &[big.clone()]),
            "{big:?}"
        );
        assert!(
            denies(&cmp("ne", arg(0), same.clone()), &[big.clone()]),
            "{big:?}"
        );
        assert!(
            denies(&set("nin", arg(0), &[same.clone()]), &[big.clone()]),
            "{big:?}"
        );
        assert!(permits(&set("in", arg(0), &[same]), &[big]));
    }
}

#[test]
fn an_in_whose_needle_cannot_resolve_denies() {
    assert!(denies(&set("in", arg(7), &[n(1)]), &[n(1)]));
    assert_eq!(
        reason(&set("in", arg(7), &[n(1)]), &[n(1)]),
        Some(DenyReason::NotInAllowlist)
    );
}

#[test]
fn an_extra_operand_is_refused() {
    assert_eq!(refused(&tup(&[sym("eq"), arg(0), n(1), n(2)])), MALFORMED);
    assert_eq!(
        refused(&tup(&[sym("in"), arg(0), tup(&[n(1)]), n(2)])),
        MALFORMED
    );
    let extra = tup(&[sym("call_arg"), ScVal::U32(0), ScVal::U32(1)]);
    assert_eq!(refused(&cmp("eq", extra, n(1))), MALFORMED);
    let u = ScVal::U32;
    let field = tup(&[sym("call_arg_field"), u(0), u(0), sym("a"), sym("b")]);
    assert_eq!(refused(&cmp("eq", field, n(1))), MALFORMED);
}

#[test]
fn a_quantifier_body_counts_toward_node_depth() {
    let over = path(&[ScVal::U32(0)]);
    let mut body = cmp("eq", elem(&[]), n(1));
    // all(1) > and(2) > and(3) > and(4) > eq(5) fits; one more `and` is 6 deep.
    for _ in 0..3 {
        body = and(&[body]);
    }
    assert_eq!(refused(&all_of(over.clone(), body.clone())), None);
    assert_eq!(
        refused(&all_of(over, and(&[body]))),
        Some(DecodeError::PredicateTooDeep)
    );
}

// ---- X1: a muxed address is the account it pays -----------------------------

fn g(tag: u8) -> ScVal {
    ScVal::Address(ScAddress::Account(AccountId(
        PublicKey::PublicKeyTypeEd25519(Uint256([tag; 32])),
    )))
}

fn muxed(tag: u8, id: u64) -> ScVal {
    ScVal::Address(ScAddress::MuxedAccount(MuxedEd25519Account {
        id,
        ed25519: Uint256([tag; 32]),
    }))
}

#[test]
fn a_muxed_form_of_a_denylisted_address_is_still_denied() {
    // SEP-41 `transfer(from, to: MuxedAddress, amount)`: the token credits M(G, id) to G.
    let bad = g(0xBB);
    let rules = [
        set("nin", arg(1), &[bad.clone()]),
        cmp("ne", arg(1), bad.clone()),
        cmp("ne", bad.clone(), arg(1)),
        all_of(path(&[ScVal::U32(0)]), cmp("ne", elem(&[]), bad.clone())),
        all_of(
            path(&[ScVal::U32(0)]),
            set("nin", elem(&[]), &[bad.clone()]),
        ),
    ];
    for (i, p) in rules.iter().enumerate() {
        let call = |to: ScVal| {
            if i < 3 {
                [n(0), to]
            } else {
                [list(&[to]), n(0)]
            }
        };
        assert!(denies(p, &call(bad.clone())), "rule {i}: plain");
        assert!(denies(p, &call(muxed(0xBB, 7))), "rule {i}: muxed, id 7");
        assert!(denies(p, &call(muxed(0xBB, 0))), "rule {i}: muxed, id 0");
        assert!(permits(p, &call(g(0xAA))), "rule {i}: other account");
        assert!(
            permits(p, &call(muxed(0xAA, 7))),
            "rule {i}: other muxed account"
        );
    }
}

#[test]
fn a_muxed_entry_in_a_denylist_denies_its_account_in_any_form() {
    let p = set("nin", arg(0), &[muxed(0xBB, 7)]);
    assert!(denies(&p, &[muxed(0xBB, 7)]));
    assert!(denies(&p, &[muxed(0xBB, 8)]), "same account, another id");
    assert!(denies(&p, &[g(0xBB)]));
    assert!(permits(&p, &[g(0xAA)]));
}

#[test]
fn eq_and_in_stay_exact_for_muxed_addresses() {
    // De-muxing here would let M(exchange, other id) match a pinned deposit.
    let pinned = cmp("eq", arg(0), muxed(0xBB, 12345));
    assert!(permits(&pinned, &[muxed(0xBB, 12345)]));
    assert!(denies(&pinned, &[muxed(0xBB, 1)]));
    assert!(denies(&pinned, &[g(0xBB)]));
    assert!(denies(&cmp("eq", arg(0), g(0xBB)), &[muxed(0xBB, 12345)]));
    let listed = set("in", arg(0), &[g(0xBB)]);
    assert!(permits(&listed, &[g(0xBB)]) && denies(&listed, &[muxed(0xBB, 1)]));
}

#[test]
fn ne_still_permits_what_differs_and_denies_what_cannot_resolve() {
    assert!(permits(&cmp("ne", arg(0), g(0xBB)), &[n(5)]));
    assert!(permits(&cmp("ne", arg(0), g(0xBB)), &[text("x")]));
    assert!(denies(&cmp("ne", arg(3), g(0xBB)), &[g(0xAA)]));
}

// ---- X2: a bare vec of constants is the vec of what its elements decode to ---

#[test]
fn a_bare_vec_holds_plain_values_and_lit_goes_around_the_whole() {
    // `lit` or a selector inside a bare vec is refused, not half-decoded: the
    // vec is its own value, so what is written is what is compared.
    let inner = lit(n(7));
    assert_eq!(refused(&cmp("eq", arg(0), tup(&[n(5), inner]))), MALFORMED);
    let tagged = tup(&[sym("Tag"), n(1)]);
    assert_eq!(
        refused(&cmp("eq", arg(0), tup(&[n(5), tagged.clone()]))),
        MALFORMED
    );
    assert_eq!(
        refused(&set("nin", arg(0), &[tup(&[n(5), lit(n(7))])])),
        MALFORMED
    );
    // the whole constant through `lit` is the way, and compares as written
    let whole = lit(tup(&[n(5), tagged.clone()]));
    let value = tup(&[n(5), tagged]);
    assert!(permits(&cmp("eq", arg(0), whole.clone()), &[value.clone()]));
    assert!(permits(
        &set("in", arg(0), &[whole.clone()]),
        &[value.clone()]
    ));
    assert!(denies(
        &set("nin", arg(0), &[whole.clone()]),
        &[value.clone()]
    ));
    assert!(denies(&cmp("ne", arg(0), whole), &[value]));
    // plain nested vecs are fine, and empty ones are not
    assert!(permits(
        &cmp("eq", arg(0), tup(&[n(1), tup(&[n(2)])])),
        &[tup(&[n(1), tup(&[n(2)])])]
    ));
    assert_eq!(
        refused(&cmp("eq", arg(0), tup(&[n(1), tup(&[])]))),
        MALFORMED
    );
}

#[test]
fn call_arg_field_takes_its_field_as_a_call_path_step_does() {
    let u = ScVal::U32;
    let args = [tup(&[map(&[(sym("a"), n(5))])])];
    let field = |k: ScVal| cmp("eq", tup(&[sym("call_arg_field"), u(0), u(0), k]), n(5));
    assert!(permits(&field(sym("a")), &args), "a bare symbol, as ever");
    assert!(permits(&field(lit(sym("a"))), &args), "lit(a) is the key a");
    assert!(denies(&field(sym("b")), &args));
    assert!(denies(&field(lit(sym("b"))), &args));
    // a selector, or a symbol-headed vec, is not a key
    assert_eq!(refused(&field(tup(&[sym("call_fn")]))), MALFORMED);
    // a non-symbol key, as in call_path
    let by_addr = [tup(&[map(&[(account(1), n(5))])])];
    assert!(permits(&field(lit(account(1))), &by_addr));
    assert!(denies(&field(lit(account(2))), &by_addr));
    // `true` is the length here too, never a key
    let len = tup(&[sym("call_arg_field"), u(0), u(0), ScVal::Bool(true)]);
    assert!(permits(&cmp("eq", len, n(1)), &[tup(&[tup(&[n(1)])])]));
}

#[test]
fn variant_is_not_a_leaf_any_more() {
    // `lit([Name, payload...])` is the same value.
    let old = tup(&[sym("variant"), sym("Tag"), n(1)]);
    assert_eq!(refused(&cmp("eq", arg(0), old)), MALFORMED);
    let p = cmp("eq", arg(0), lit(tup(&[sym("Tag"), n(1)])));
    assert!(permits(&p, &[tup(&[sym("Tag"), n(1)])]));
}
