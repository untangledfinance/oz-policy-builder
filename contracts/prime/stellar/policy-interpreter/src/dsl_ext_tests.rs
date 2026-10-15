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
use soroban_sdk::{Env, IntoVal, Symbol, Val, Vec as SorobanVec};

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
        contract: soroban_sdk::Address::from_str(
            env,
            "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM",
        ),
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
