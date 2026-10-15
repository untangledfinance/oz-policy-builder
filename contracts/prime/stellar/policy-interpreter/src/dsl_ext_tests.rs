//! Tests for the generic constructs of grammar 7: `lit`, `ne`/`nin`, numeric
//! widening, `lit` map keys, call-derived read arguments and the quantifiers.
//! Predicates are built as raw ScVals, the wire form a client sends.

extern crate alloc;

use alloc::vec::Vec as StdVec;

use crate::dsl::{decode, evaluate, DecodeError, DenyReason, EvalContext, EvalDecision};
use soroban_sdk::xdr::{
    ContractId, Duration, Hash, Int128Parts, ScAddress, ScBytes, ScMap, ScMapEntry, ScString,
    ScSymbol, ScVal, ScVec, TimePoint, ToXdr, UInt128Parts, VecM,
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
fn lit_is_a_constant_in_a_variant_payload_and_a_read_argument() {
    let p = cmp(
        "eq",
        arg(0),
        tup(&[sym("variant"), sym("Tag"), lit(ScVal::Bool(true))]),
    );
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
fn nin_counts_the_needle_once_per_entry_toward_the_leaf_cap() {
    // 32 entries expand to 32 `ne` of two leaves each: 64.
    let full: StdVec<ScVal> = (0..32).map(n).collect();
    let nest: StdVec<ScVal> = (0..4).map(|_| set("nin", arg(0), &full)).collect();
    assert_eq!(refused(&and(&nest[..3])), None, "192 leaves");
    assert_eq!(
        refused(&and(&nest)),
        Some(DecodeError::TooManyLeaves),
        "256 leaves"
    );
}

// ---- D: map keys of any constant -------------------------------------------

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
