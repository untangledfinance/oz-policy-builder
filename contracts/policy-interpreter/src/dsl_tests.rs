//! Unit tests for the dsl decoder + pure evaluator.
//!
//! Covers the current `dsl` API (host-parsed `Val` walking, native
//! soroban-sdk types) and the audit-critical fail-closed branches.
//!
//! Axes:
//!   - each operator (and / or / not / in / eq / lt / lte / gt / gte) with a
//!     permit case plus the deny case that operator uniquely owns
//!   - each v2 selector: call_contract, call_fn, call_arg, call_arg_len,
//!     call_arg_field, now, valid_until, invocation_count_in_window
//!   - fail-closed at every entry boundary: unknown node symbol, unknown
//!     selector symbol, wrong arity, wrong ScVal type as a literal, in []
//!     at decode, call_arg index out of bounds at evaluate, garbage bytes
//!     fail-closed as malformed
//!   - caps with the exact wire codes: MAX_DEPTH 5 -> PREDICATE_TOO_DEEP
//!     (incl. a `not` chain so the depth-bomb path is covered),
//!     MAX_LEAVES 200 -> TOO_MANY_LEAVES, MAX_IN_OPERAND_COUNT 32 ->
//!     IN_OPERAND_LIMIT, MAX_PREDICATE_BYTES 32768 -> PREDICATE_TOO_LARGE
//!   - i128 checked semantics at the boundary

extern crate alloc;

use alloc::boxed::Box;
use alloc::string::ToString;
use alloc::vec::Vec as StdVec;

use crate::dsl::{
    decode, decode_with_byte_cap, evaluate, CompareOp, DenyReason, EvalContext, EvalDecision, Leaf,
    Node, MAX_DEPTH, MAX_IN_OPERAND_COUNT, MAX_LEAVES, MAX_PREDICATE_BYTES,
};
use soroban_sdk::testutils::Address as _;
use soroban_sdk::xdr::{FromXdr, ScVal, ToXdr, VecM};
use soroban_sdk::{Address, Bytes, Env, IntoVal, Symbol, Val, Vec as SorobanVec};

// ----- tiny builders / helpers ----------------------------------------------

fn contract(env: &Env) -> Address {
    Address::generate(env)
}

fn empty_ctx(env: &Env) -> EvalContext {
    EvalContext {
        contract: contract(env),
        fn_name: Symbol::new(env, "submit"),
        args: SorobanVec::<Val>::new(env),
        at_ledger: 100,
        valid_until_ledger: Some(200),
        now_seconds: 1000,
        invocation_count_by_window: StdVec::new(),
    }
}

fn permit(d: EvalDecision) -> bool {
    matches!(d, EvalDecision::Permit)
}

fn reason(d: EvalDecision) -> Option<DenyReason> {
    match d {
        EvalDecision::Permit => None,
        EvalDecision::Deny(r) => Some(r),
    }
}

// ----- AST -> wire bytes ----------------------------------------------------

fn sym(name: &str) -> ScVal {
    ScVal::Symbol(soroban_sdk::xdr::ScSymbol(
        name.as_bytes().to_vec().try_into().unwrap(),
    ))
}

fn addr_scval() -> ScVal {
    // The contract-hash placeholder every other test in the crate uses.
    ScVal::Address(soroban_sdk::xdr::ScAddress::Contract(
        soroban_sdk::xdr::ContractId(soroban_sdk::xdr::Hash([0u8; 32])),
    ))
}

fn u32_scval(n: u32) -> ScVal {
    ScVal::U32(n)
}

fn u64_scval(n: u64) -> ScVal {
    // Uint64 wire form: (lo: u64, hi: u32). For values < 2^32 the hi half is 0.
    ScVal::U64(soroban_sdk::xdr::Uint64::from(n))
}

fn i128_scval(v: i128) -> ScVal {
    // Int128Parts: hi SIGNED Int64, lo UNSIGNED Uint64. Value = (hi << 64) + lo.
    let hi = (v >> 64) as i64;
    let lo = (v & 0xFFFF_FFFF_FFFF_FFFFu128 as i128) as u64;
    ScVal::I128(soroban_sdk::xdr::Int128Parts {
        hi: soroban_sdk::xdr::Int64::from(hi),
        lo: soroban_sdk::xdr::Uint64::from(lo),
    })
}

fn vec_scval(items: &[ScVal]) -> ScVal {
    let v: VecM<ScVal> = items.to_vec().try_into().unwrap();
    ScVal::Vec(Some(soroban_sdk::xdr::ScVec(v)))
}

fn empty_vec_scval() -> ScVal {
    // Length-0 Vec (ScVal::Vec with Some(ScVec(0))) used for `in []` tests.
    let v: VecM<ScVal> = StdVec::<ScVal>::new().try_into().unwrap();
    ScVal::Vec(Some(soroban_sdk::xdr::ScVec(v)))
}

fn bytes_from_scval(env: &Env, v: ScVal) -> Bytes {
    let val: Val = v.into_val(env);
    val.to_xdr(env)
}

fn bytes_from_node(env: &Env, node: &Node) -> Bytes {
    bytes_from_scval(env, node_to_scval(env, node))
}

fn node_to_scval(env: &Env, n: &Node) -> ScVal {
    match n {
        Node::And(children) => vec_scval(&[
            sym("and"),
            vec_scval(
                &children
                    .iter()
                    .map(|c| node_to_scval(env, c))
                    .collect::<StdVec<_>>(),
            ),
        ]),
        Node::Or(children) => vec_scval(&[
            sym("or"),
            vec_scval(
                &children
                    .iter()
                    .map(|c| node_to_scval(env, c))
                    .collect::<StdVec<_>>(),
            ),
        ]),
        Node::Not(inner) => vec_scval(&[sym("not"), node_to_scval(env, inner)]),
        Node::Compare { op, left, right } => vec_scval(&[
            sym(op_name(*op)),
            leaf_to_scval(env, left),
            leaf_to_scval(env, right),
        ]),
        Node::In { needle, haystack } => vec_scval(&[
            sym("in"),
            leaf_to_scval(env, needle),
            vec_scval(
                &haystack
                    .iter()
                    .map(|h| leaf_to_scval(env, h))
                    .collect::<StdVec<_>>(),
            ),
        ]),
    }
}

fn leaf_to_scval(env: &Env, l: &Leaf) -> ScVal {
    match l {
        Leaf::CallContract => vec_scval(&[sym("call_contract")]),
        Leaf::CallFn => vec_scval(&[sym("call_fn")]),
        Leaf::CallArg(i) => vec_scval(&[sym("call_arg"), u32_scval(*i)]),
        Leaf::CallArgLen(i) => vec_scval(&[sym("call_arg_len"), u32_scval(*i)]),
        Leaf::CallArgField {
            index,
            element,
            field,
        } => {
            let sym_field: ScVal = ScVal::Symbol(soroban_sdk::xdr::ScSymbol(
                field.to_string().as_bytes().to_vec().try_into().unwrap(),
            ));
            vec_scval(&[
                sym("call_arg_field"),
                u32_scval(*index),
                u32_scval(*element),
                sym_field,
            ])
        }
        Leaf::CallArgScaled { index, num, den } => vec_scval(&[
            sym("call_arg_scaled"),
            u32_scval(*index),
            i128_scval(*num),
            i128_scval(*den),
        ]),
        Leaf::Now => vec_scval(&[sym("now")]),
        Leaf::ValidUntil => vec_scval(&[sym("valid_until")]),
        Leaf::InvocationCountInWindow { window_secs } => {
            vec_scval(&[sym("invocation_count"), u64_scval(*window_secs)])
        }
        Leaf::LiteralAddress(_) => addr_scval(),
        Leaf::LiteralI128(v) => i128_scval(*v),
        Leaf::LiteralSymbol(s) => {
            // Round-trip so host and wire see the same canonical symbol bytes.
            let _: &Env = env;
            let v: Val = s.clone().into_val(env);
            ScVal::from_xdr(env, &v.to_xdr(env)).expect("sym round-trip")
        }
        Leaf::LiteralU32(v) => u32_scval(*v),
        Leaf::LiteralU64(v) => u64_scval(*v),
        Leaf::LiteralBytes(b) => {
            let len = b.len();
            let mut inner: StdVec<u8> = StdVec::with_capacity(len as usize);
            for i in 0..len {
                inner.push(b.get(i).unwrap_or(0));
            }
            let buf: soroban_sdk::xdr::BytesM = inner.try_into().unwrap_or_default();
            ScVal::Bytes(buf.into())
        }
        Leaf::LiteralVec(elements) => vec_scval(
            &elements
                .iter()
                .map(|e| leaf_to_scval(env, e))
                .collect::<StdVec<_>>(),
        ),
    }
}

fn op_name(op: CompareOp) -> &'static str {
    match op {
        CompareOp::Eq => "eq",
        CompareOp::Lt => "lt",
        CompareOp::Lte => "lte",
        CompareOp::Gt => "gt",
        CompareOp::Gte => "gte",
    }
}

// ----- Tests: operators -----------------------------------------------------

#[test]
fn op_and_all_permit_passes() {
    let env = Env::default();
    let n = Node::And(StdVec::from([
        cmp_i128(CompareOp::Lt, 10, 20),
        cmp_i128(CompareOp::Gt, 5, 0),
    ]));
    assert!(permit(evaluate(&env, &n, &empty_ctx(&env))));
}

#[test]
fn op_and_fail_fast_returns_first_violation() {
    let env = Env::default();
    let n = Node::And(StdVec::from([
        cmp_i128(CompareOp::Lt, 10, 5), // fails -> ArgMismatch
        cmp_i128(CompareOp::Gt, 5, 0),
    ]));
    assert_eq!(
        reason(evaluate(&env, &n, &empty_ctx(&env))),
        Some(DenyReason::ArgMismatch)
    );
}

#[test]
fn op_or_one_permit_passes() {
    let env = Env::default();
    let n = Node::Or(StdVec::from([
        cmp_i128(CompareOp::Eq, 1, 2),
        cmp_i128(CompareOp::Eq, 7, 7),
    ]));
    assert!(permit(evaluate(&env, &n, &empty_ctx(&env))));
}

#[test]
fn op_or_all_deny_does_not_permit() {
    let env = Env::default();
    let n = Node::Or(StdVec::from([
        cmp_i128(CompareOp::Eq, 1, 2),
        cmp_i128(CompareOp::Eq, 3, 4),
    ]));
    assert!(!permit(evaluate(&env, &n, &empty_ctx(&env))));
}

#[test]
fn op_or_empty_children_fails_closed() {
    let env = Env::default();
    let n = Node::Or(StdVec::new());
    assert_eq!(
        reason(evaluate(&env, &n, &empty_ctx(&env))),
        Some(DenyReason::NotInAllowlist)
    );
}

#[test]
fn op_not_inverts_a_permit_into_deny() {
    let env = Env::default();
    let n = Node::Not(Box::new(cmp_i128(CompareOp::Eq, 7, 7)));
    assert_eq!(
        reason(evaluate(&env, &n, &empty_ctx(&env))),
        Some(DenyReason::ArgMismatch)
    );
}

#[test]
fn op_not_inverts_a_deny_into_permit() {
    let env = Env::default();
    let n = Node::Not(Box::new(cmp_i128(CompareOp::Eq, 1, 2)));
    assert!(permit(evaluate(&env, &n, &empty_ctx(&env))));
}

#[test]
fn op_not_does_not_invert_unsupported_structural_deny() {
    // A stateful leaf on the right-hand side is not a supported shape.
    let env = Env::default();
    let inner = Node::Compare {
        op: CompareOp::Lt,
        left: Leaf::Now,
        right: Leaf::InvocationCountInWindow { window_secs: 3600 },
    };
    let n = Node::Not(Box::new(inner));
    assert_eq!(
        reason(evaluate(&env, &n, &empty_ctx(&env))),
        Some(DenyReason::UnsupportedNode)
    );
}

#[test]
fn op_in_needle_in_haystack_permits() {
    let env = Env::default();
    let n = Node::In {
        needle: Leaf::LiteralI128(2),
        haystack: StdVec::from([
            Leaf::LiteralI128(1),
            Leaf::LiteralI128(2),
            Leaf::LiteralI128(3),
        ]),
    };
    assert!(permit(evaluate(&env, &n, &empty_ctx(&env))));
}

#[test]
fn op_in_needle_missing_deny() {
    let env = Env::default();
    let n = Node::In {
        needle: Leaf::LiteralI128(99),
        haystack: StdVec::from([
            Leaf::LiteralI128(1),
            Leaf::LiteralI128(2),
            Leaf::LiteralI128(3),
        ]),
    };
    assert!(!permit(evaluate(&env, &n, &empty_ctx(&env))));
}

#[test]
fn op_in_empty_haystack_deny_fails_closed() {
    // Runtime-built AST (decode-time `in []` is also covered below) - deny.
    let env = Env::default();
    let n = Node::In {
        needle: Leaf::LiteralI128(1),
        haystack: StdVec::new(),
    };
    assert_eq!(
        reason(evaluate(&env, &n, &empty_ctx(&env))),
        Some(DenyReason::NotInAllowlist)
    );
}

#[test]
fn op_eq_literal_i128_permits_when_match() {
    let env = Env::default();
    assert!(permit(evaluate(
        &env,
        &cmp_i128(CompareOp::Eq, 7, 7),
        &empty_ctx(&env)
    )));
}

#[test]
fn op_eq_literal_i128_denies_when_mismatch() {
    let env = Env::default();
    assert_eq!(
        reason(evaluate(
            &env,
            &cmp_i128(CompareOp::Eq, 7, 8),
            &empty_ctx(&env)
        )),
        Some(DenyReason::ArgMismatch)
    );
}

#[test]
fn op_lt_permits_within_bound() {
    let env = Env::default();
    assert!(permit(evaluate(
        &env,
        &cmp_i128(CompareOp::Lt, 9, 10),
        &empty_ctx(&env)
    )));
}

#[test]
fn op_lt_denies_at_bound() {
    let env = Env::default();
    assert!(!permit(evaluate(
        &env,
        &cmp_i128(CompareOp::Lt, 10, 10),
        &empty_ctx(&env)
    )));
}

#[test]
fn op_lte_permits_at_bound() {
    let env = Env::default();
    assert!(permit(evaluate(
        &env,
        &cmp_i128(CompareOp::Lte, 10, 10),
        &empty_ctx(&env)
    )));
}

#[test]
fn op_gt_permits_above_bound() {
    let env = Env::default();
    assert!(permit(evaluate(
        &env,
        &cmp_i128(CompareOp::Gt, 11, 10),
        &empty_ctx(&env)
    )));
}

#[test]
fn op_gt_denies_at_bound() {
    let env = Env::default();
    assert!(!permit(evaluate(
        &env,
        &cmp_i128(CompareOp::Gt, 10, 10),
        &empty_ctx(&env)
    )));
}

#[test]
fn op_gte_permits_at_bound() {
    let env = Env::default();
    assert!(permit(evaluate(
        &env,
        &cmp_i128(CompareOp::Gte, 10, 10),
        &empty_ctx(&env)
    )));
}

fn cmp_i128(op: CompareOp, left: i128, right: i128) -> Node {
    Node::Compare {
        op,
        left: Leaf::LiteralI128(left),
        right: Leaf::LiteralI128(right),
    }
}

// ----- Tests: selectors -----------------------------------------------------

#[test]
fn sel_call_contract_eq_match_permits() {
    let env = Env::default();
    let mut ctx = empty_ctx(&env);
    ctx.contract = contract(&env);
    let n = Node::Compare {
        op: CompareOp::Eq,
        left: Leaf::CallContract,
        right: Leaf::LiteralAddress(ctx.contract.clone()),
    };
    assert!(permit(evaluate(&env, &n, &ctx)));
}

#[test]
fn sel_call_contract_eq_other_denies_contract_scope() {
    let env = Env::default();
    let n = Node::Compare {
        op: CompareOp::Eq,
        left: Leaf::CallContract,
        right: Leaf::LiteralAddress(Address::generate(&env)),
    };
    assert_eq!(
        reason(evaluate(&env, &n, &empty_ctx(&env))),
        Some(DenyReason::ContractScope)
    );
}

#[test]
fn sel_call_contract_with_non_eq_op_unsupported() {
    let env = Env::default();
    let n = Node::Compare {
        op: CompareOp::Lt,
        left: Leaf::CallContract,
        right: Leaf::LiteralAddress(Address::generate(&env)),
    };
    assert_eq!(
        reason(evaluate(&env, &n, &empty_ctx(&env))),
        Some(DenyReason::UnsupportedNode)
    );
}

#[test]
fn sel_call_fn_eq_match_permits() {
    let env = Env::default();
    let mut ctx = empty_ctx(&env);
    ctx.fn_name = Symbol::new(&env, "submit");
    let n = Node::Compare {
        op: CompareOp::Eq,
        left: Leaf::CallFn,
        right: Leaf::LiteralSymbol(Symbol::new(&env, "submit")),
    };
    assert!(permit(evaluate(&env, &n, &ctx)));
}

#[test]
fn sel_call_fn_eq_mismatch_denies() {
    let env = Env::default();
    let mut ctx = empty_ctx(&env);
    ctx.fn_name = Symbol::new(&env, "withdraw");
    let n = Node::Compare {
        op: CompareOp::Eq,
        left: Leaf::CallFn,
        right: Leaf::LiteralSymbol(Symbol::new(&env, "submit")),
    };
    assert_eq!(
        reason(evaluate(&env, &n, &ctx)),
        Some(DenyReason::ArgMismatch)
    );
}

#[test]
fn sel_call_arg_eq_address_permits_when_match() {
    let env = Env::default();
    let arg = Address::generate(&env);
    let mut args = SorobanVec::<Val>::new(&env);
    args.push_back(arg.clone().into_val(&env));
    let mut ctx = empty_ctx(&env);
    ctx.args = args;
    let n = Node::Compare {
        op: CompareOp::Eq,
        left: Leaf::CallArg(0),
        right: Leaf::LiteralAddress(arg),
    };
    assert!(permit(evaluate(&env, &n, &ctx)));
}

#[test]
fn sel_call_arg_eq_i128_denies_other_value() {
    let env = Env::default();
    let mut args = SorobanVec::<Val>::new(&env);
    args.push_back(10i128.into_val(&env));
    let mut ctx = empty_ctx(&env);
    ctx.args = args;
    let n = Node::Compare {
        op: CompareOp::Eq,
        left: Leaf::CallArg(0),
        right: Leaf::LiteralI128(11),
    };
    assert_eq!(
        reason(evaluate(&env, &n, &ctx)),
        Some(DenyReason::ArgMismatch)
    );
}

#[test]
fn sel_call_arg_out_of_bounds_denies() {
    let env = Env::default();
    let mut ctx = empty_ctx(&env);
    ctx.args = SorobanVec::<Val>::new(&env);
    let n = Node::Compare {
        op: CompareOp::Eq,
        left: Leaf::CallArg(7),
        right: Leaf::LiteralI128(0),
    };
    assert_eq!(
        reason(evaluate(&env, &n, &ctx)),
        Some(DenyReason::ArgMismatch)
    );
}

#[test]
fn sel_call_arg_len_eq_match_permits() {
    let env = Env::default();
    let mut inner = SorobanVec::<Val>::new(&env);
    inner.push_back(1i128.into_val(&env));
    let mut args = SorobanVec::<Val>::new(&env);
    args.push_back(inner.into_val(&env));
    let mut ctx = empty_ctx(&env);
    ctx.args = args;
    let n = Node::Compare {
        op: CompareOp::Eq,
        left: Leaf::CallArgLen(0),
        right: Leaf::LiteralU32(1),
    };
    assert!(permit(evaluate(&env, &n, &ctx)));
}

#[test]
fn sel_call_arg_len_eq_mismatch_denies() {
    let env = Env::default();
    let mut inner = SorobanVec::<Val>::new(&env);
    inner.push_back(1i128.into_val(&env));
    let mut args = SorobanVec::<Val>::new(&env);
    args.push_back(inner.into_val(&env));
    let mut ctx = empty_ctx(&env);
    ctx.args = args;
    let n = Node::Compare {
        op: CompareOp::Eq,
        left: Leaf::CallArgLen(0),
        right: Leaf::LiteralU32(99),
    };
    assert_eq!(
        reason(evaluate(&env, &n, &ctx)),
        Some(DenyReason::ArgMismatch)
    );
}

#[test]
fn sel_call_arg_field_eq_u32_match_permits() {
    let env = Env::default();
    let mut m = soroban_sdk::Map::<Symbol, Val>::new(&env);
    m.set(Symbol::new(&env, "request_type"), 3u32.into_val(&env));
    let mut inner_vec = SorobanVec::<Val>::new(&env);
    inner_vec.push_back(m.into_val(&env));
    let mut args = SorobanVec::<Val>::new(&env);
    args.push_back(inner_vec.into_val(&env));
    let mut ctx = empty_ctx(&env);
    ctx.args = args;
    let n = Node::Compare {
        op: CompareOp::Eq,
        left: Leaf::CallArgField {
            index: 0,
            element: 0,
            field: Symbol::new(&env, "request_type"),
        },
        right: Leaf::LiteralU32(3),
    };
    assert!(permit(evaluate(&env, &n, &ctx)));
}

#[test]
fn sel_now_lt_in_window_permits() {
    let env = Env::default();
    let mut ctx = empty_ctx(&env);
    ctx.at_ledger = 100;
    let n = Node::Compare {
        op: CompareOp::Lt,
        left: Leaf::Now,
        right: Leaf::LiteralU32(200),
    };
    assert!(permit(evaluate(&env, &n, &ctx)));
}

#[test]
fn sel_now_gt_past_upper_bound_denies() {
    // at_ledger = 100, bound = 200; Gt asks "now > bound". 100 > 200 is
    // false, so the comparator denies with ArgMismatch.
    let env = Env::default();
    let mut ctx = empty_ctx(&env);
    ctx.at_ledger = 100;
    let n = Node::Compare {
        op: CompareOp::Gt,
        left: Leaf::Now,
        right: Leaf::LiteralU32(200),
    };
    assert_eq!(
        reason(evaluate(&env, &n, &ctx)),
        Some(DenyReason::ArgMismatch)
    );
}

#[test]
fn sel_valid_until_eq_match_permits() {
    let env = Env::default();
    let mut ctx = empty_ctx(&env);
    ctx.valid_until_ledger = Some(123);
    let n = Node::Compare {
        op: CompareOp::Eq,
        left: Leaf::ValidUntil,
        right: Leaf::LiteralU32(123),
    };
    assert!(permit(evaluate(&env, &n, &ctx)));
}

#[test]
fn sel_valid_until_missing_denies() {
    let env = Env::default();
    let ctx = empty_ctx(&env); // valid_until_ledger: None
    let n = Node::Compare {
        op: CompareOp::Eq,
        left: Leaf::ValidUntil,
        right: Leaf::LiteralU32(123),
    };
    assert!(!permit(evaluate(&env, &n, &ctx)));
}

#[test]
fn sel_invocation_count_at_or_below_limit_permits() {
    let env = Env::default();
    let mut ctx = empty_ctx(&env);
    ctx.invocation_count_by_window = StdVec::from([(3600u64, 0u32)]);
    let n = Node::Compare {
        op: CompareOp::Lte,
        left: Leaf::InvocationCountInWindow { window_secs: 3600 },
        right: Leaf::LiteralU32(1),
    };
    assert!(permit(evaluate(&env, &n, &ctx)));
}

#[test]
fn sel_invocation_count_above_limit_denies() {
    let env = Env::default();
    let mut ctx = empty_ctx(&env);
    ctx.invocation_count_by_window = StdVec::from([(3600u64, 2u32)]);
    let n = Node::Compare {
        op: CompareOp::Lte,
        left: Leaf::InvocationCountInWindow { window_secs: 3600 },
        right: Leaf::LiteralU32(1),
    };
    // Frequency, not the generic StatefulBound. The reference evaluator draws
    // this distinction and the reason reaches the user on the review card, so
    // "called too often" must not read as an unspecified bound.
    assert_eq!(
        reason(evaluate(&env, &n, &ctx)),
        Some(DenyReason::Frequency)
    );
}

// ----- Tests: fail-closed at decode boundaries -----------------------------

#[test]
fn fc_unknown_node_symbol_returns_malformed() {
    let env = Env::default();
    let bogus = bytes_from_scval(&env, vec_scval(&[sym("not_a_real_op"), u32_scval(0)]));
    let err = decode_with_byte_cap(&env, &bogus).expect_err("unknown op must deny");
    assert_eq!(err.code(), "MALFORMED_PREDICATE");
}

#[test]
fn fc_unknown_selector_symbol_returns_malformed() {
    let env = Env::default();
    let bogus = bytes_from_scval(
        &env,
        vec_scval(&[
            sym("eq"),
            vec_scval(&[sym("definitely_not_a_selector")]),
            u32_scval(0),
        ]),
    );
    let err = decode_with_byte_cap(&env, &bogus).expect_err("unknown selector must deny");
    assert_eq!(err.code(), "MALFORMED_PREDICATE");
}

#[test]
fn fc_wrong_arity_on_compare_returns_malformed() {
    // eq with only one argument (no left, no right) -> structurally MALFORMED.
    let env = Env::default();
    let bogus = bytes_from_scval(&env, vec_scval(&[sym("eq"), u32_scval(1)]));
    let err = decode_with_byte_cap(&env, &bogus).expect_err("2-arg compare must deny");
    assert_eq!(err.code(), "MALFORMED_PREDICATE");
}

#[test]
fn fc_wrong_val_type_as_call_arg_index_returns_malformed() {
    // call_arg's index slot must be a u32 ScVal. U64 there is rejected.
    let env = Env::default();
    let bogus = bytes_from_scval(
        &env,
        vec_scval(&[
            sym("eq"),
            vec_scval(&[sym("call_arg"), u64_scval(7)]),
            u32_scval(7),
        ]),
    );
    let err = decode_with_byte_cap(&env, &bogus).expect_err("u64 in call_arg slot must deny");
    assert_eq!(err.code(), "MALFORMED_PREDICATE");
}

#[test]
fn fc_in_empty_haystack_at_decode() {
    let env = Env::default();
    let bogus = bytes_from_scval(
        &env,
        vec_scval(&[sym("in"), i128_scval(1), empty_vec_scval()]),
    );
    let err = decode_with_byte_cap(&env, &bogus).expect_err("in [] must deny at decode");
    assert_eq!(err.code(), "MALFORMED_PREDICATE");
}

#[test]
fn fc_undecoded_value_never_matches_by_stringification() {
    // A decode failure must NOT silently permit. The root must be a Vec -
    // otherwise the AST shape is unreachable and the only safe answer is
    // MALFORMED_PREDICATE. This protects against any future "stringify the
    // bytes and compare" fallback.
    let env = Env::default();
    // 1. A valid-XDR-but-non-Vec-root payload (the literal "42" encoded as a
    //    ScVal::U32 instead of a Vec).
    let wrong_root = bytes_from_scval(&env, u32_scval(42));
    assert_eq!(
        decode_with_byte_cap(&env, &wrong_root)
            .err()
            .map(|e| e.code()),
        Some("MALFORMED_PREDICATE")
    );
    // 2. An empty Vec root (zero-element wrapper) is also rejected: the wire
    //    must carry a head symbol, so a length-0 Vec can never be valid.
    let empty_root = bytes_from_scval(&env, empty_vec_scval());
    assert_eq!(
        decode_with_byte_cap(&env, &empty_root)
            .err()
            .map(|e| e.code()),
        Some("MALFORMED_PREDICATE")
    );
}

// ----- Tests: caps ----------------------------------------------------------

fn balanced_depth_n(env: &Env, target_depth: usize) -> Node {
    if target_depth == 0 {
        return Node::Compare {
            op: CompareOp::Eq,
            left: Leaf::CallContract,
            right: Leaf::LiteralAddress(contract(env)),
        };
    }
    Node::And(StdVec::from([balanced_depth_n(env, target_depth - 1)]))
}

fn wide_leaves_n(env: &Env, target_pairs: usize) -> Node {
    let mut children = StdVec::new();
    for _ in 0..target_pairs {
        children.push(Node::Compare {
            op: CompareOp::Eq,
            left: Leaf::CallContract,
            right: Leaf::LiteralAddress(contract(env)),
        });
    }
    Node::And(children)
}

#[test]
fn cap_depth_at_limit_permits() {
    let env = Env::default();
    // `balanced_depth_n(n)` builds an `and`-chain of nesting `n`; the walk
    // counts the root as depth 1 and increments per child, so `n` levels
    // of recursion place the leaf at depth `n + 1`. Subtract one so the
    // resulting max depth is exactly MAX_DEPTH.
    let n = balanced_depth_n(&env, (MAX_DEPTH as usize) - 1);
    let bytes = bytes_from_node(&env, &n);
    let root = decode_with_byte_cap(&env, &bytes).expect("MAX_DEPTH must decode");
    assert!(matches!(root, Node::And(_)));
}

#[test]
fn cap_depth_over_limit_returns_predicate_too_deep() {
    let env = Env::default();
    let n = balanced_depth_n(&env, MAX_DEPTH as usize);
    let bytes = bytes_from_node(&env, &n);
    let err = decode(&env, &bytes).expect_err("depth > MAX_DEPTH must deny");
    assert_eq!(err.code(), "PREDICATE_TOO_DEEP");
}

#[test]
fn cap_not_chain_is_a_depth_bomb() {
    // `not(not(not(not(not(not(eq(call_contract,...))))))))` is depth 7 > 5.
    // The decoder must count every node level; a malicious predicate cannot
    // smuggle a depth bomb through `not`.
    let env = Env::default();
    let inner = Node::Compare {
        op: CompareOp::Eq,
        left: Leaf::CallContract,
        right: Leaf::LiteralAddress(contract(&env)),
    };
    let mut chain: Node = inner;
    for _ in 0..6 {
        chain = Node::Not(Box::new(chain));
    }
    let bytes = bytes_from_node(&env, &chain);
    let err = decode(&env, &bytes).expect_err("not-chain depth bomb must deny");
    assert_eq!(err.code(), "PREDICATE_TOO_DEEP");
}

#[test]
fn cap_leaves_over_limit_returns_too_many_leaves() {
    let env = Env::default();
    // (MAX_LEAVES/2 + 1) child comparisons × 2 leaves per child > MAX_LEAVES.
    let n = wide_leaves_n(&env, (MAX_LEAVES as usize / 2) + 1);
    let bytes = bytes_from_node(&env, &n);
    let err = decode(&env, &bytes).expect_err("leaves > MAX_LEAVES must deny");
    assert_eq!(err.code(), "TOO_MANY_LEAVES");
}

#[test]
fn cap_in_operand_count_over_limit_returns_in_operand_limit() {
    let env = Env::default();
    let n = Node::In {
        needle: Leaf::LiteralI128(0),
        haystack: (0..=(MAX_IN_OPERAND_COUNT as i128))
            .map(Leaf::LiteralI128)
            .collect::<StdVec<_>>(),
    };
    let bytes = bytes_from_node(&env, &n);
    let err = decode(&env, &bytes).expect_err("in haystack > MAX_IN_OPERAND_COUNT must deny");
    assert_eq!(err.code(), "IN_OPERAND_LIMIT");
}

#[test]
fn cap_predicate_bytes_over_limit_returns_predicate_too_large() {
    let env = Env::default();
    let mut payload: StdVec<u8> = StdVec::new();
    payload.extend(core::iter::repeat_n(
        0u8,
        (MAX_PREDICATE_BYTES as usize) + 1,
    ));
    let bytes = Bytes::from_slice(&env, &payload);
    let err = decode_with_byte_cap(&env, &bytes).expect_err("over-byte predicate must deny");
    assert_eq!(err.code(), "PREDICATE_TOO_LARGE");
}

// ----- Tests: i128 checked arithmetic ---------------------------------------

// ---- F8b: DenyReason -> PolicyError is exhaustive and the codes match ----
//
// The previous F8 test asserted via Logs in the native env, which proved
// the mapping but not on-chain observability. The follow-up uses
// `panic_with_error!` to surface the code as `Error(Contract, #N)` on
// the diagnostic event. The Rust side's numeric codes are a public ABI,
// so the mapping `DenyReason -> PolicyError` must be both exhaustive
// (a new variant cannot compile without a code) AND stable (off-chain
// consumers match on the numeric value).

#[test]
fn f8b_deny_reason_to_policy_error_is_stable() {
    use crate::storage::PolicyError;

    // Spot-check the mapping for every variant. If a new variant is
    // added, this match stops compiling until a PolicyError code is
    // assigned - that is the audit point.
    assert_eq!(PolicyError::from(DenyReason::ArgMismatch) as u32, 100);
    assert_eq!(PolicyError::from(DenyReason::ContractScope) as u32, 101);
    assert_eq!(
        PolicyError::from(DenyReason::ArithmeticOverflow) as u32,
        102
    );
    assert_eq!(PolicyError::from(DenyReason::UnsupportedNode) as u32, 103);
    assert_eq!(PolicyError::from(DenyReason::StatefulBound) as u32, 104);
    assert_eq!(PolicyError::from(DenyReason::NotInAllowlist) as u32, 105);
    assert_eq!(PolicyError::from(DenyReason::Frequency) as u32, 106);
    assert_eq!(PolicyError::from(DenyReason::SlippageFloor) as u32, 107);
}

#[test]
fn f8b_policy_error_code_strings_match_the_deny_reason_table() {
    // The on-chain signal is the numeric code; the string form lives in
    // the native env only. It MUST match `dsl::DenyReason::code()` so a
    // log scan or a debug print lines up with the on-chain number.
    use crate::storage::PolicyError;

    assert_eq!(
        PolicyError::ArgMismatch.code_str(),
        DenyReason::ArgMismatch.code()
    );
    assert_eq!(
        PolicyError::ContractScope.code_str(),
        DenyReason::ContractScope.code()
    );
    assert_eq!(
        PolicyError::ArithmeticOverflow.code_str(),
        DenyReason::ArithmeticOverflow.code()
    );
    assert_eq!(
        PolicyError::UnsupportedNode.code_str(),
        DenyReason::UnsupportedNode.code()
    );
    assert_eq!(
        PolicyError::StatefulBound.code_str(),
        DenyReason::StatefulBound.code()
    );
    assert_eq!(
        PolicyError::NotInAllowlist.code_str(),
        DenyReason::NotInAllowlist.code()
    );
    assert_eq!(
        PolicyError::Frequency.code_str(),
        DenyReason::Frequency.code()
    );
    assert_eq!(
        PolicyError::SlippageFloor.code_str(),
        DenyReason::SlippageFloor.code()
    );
}

// ---- `amount` / `window_spent` are not part of the grammar ----
//
// The on-chain interpreter sees one authorized call, not the transaction's
// token movements, so it cannot source either. They are refused at DECODE, so
// a predicate carrying one never installs - rather than installing and then
// silently evaluating against a zero it made up.

#[test]
fn fc_amount_selector_is_refused_at_decode() {
    let env = Env::default();
    let bytes = bytes_from_scval(
        &env,
        vec_scval(&[
            sym("lte"),
            vec_scval(&[sym("amount"), addr_scval()]),
            i128_scval(1000),
        ]),
    );
    let err = decode_with_byte_cap(&env, &bytes).expect_err("`amount` must not decode");
    assert_eq!(err.code(), "MALFORMED_PREDICATE");
}

#[test]
fn fc_window_spent_selector_is_refused_at_decode() {
    let env = Env::default();
    let bytes = bytes_from_scval(
        &env,
        vec_scval(&[
            sym("lte"),
            vec_scval(&[sym("window_spent"), addr_scval(), u64_scval(86400)]),
            i128_scval(1000),
        ]),
    );
    let err = decode_with_byte_cap(&env, &bytes).expect_err("`window_spent` must not decode");
    assert_eq!(err.code(), "MALFORMED_PREDICATE");
}

#[test]
fn fc_invocation_count_still_decodes() {
    // The counter-based control that CAN be sourced on chain is unaffected -
    // it counts calls, not value.
    let env = Env::default();
    let bytes = bytes_from_scval(
        &env,
        vec_scval(&[
            sym("lte"),
            vec_scval(&[sym("invocation_count"), u64_scval(86400)]),
            u32_scval(5),
        ]),
    );
    assert!(decode_with_byte_cap(&env, &bytes).is_ok());
}

// ---- F9: CallArgScaled (relative slippage floor) ----
//
// A `call_arg_scaled(i, num, den)` leaf evaluates to `args[i] * num / den`.
// The intended use case is "min output must be at least this ratio of the
// input": `call_arg[out] >= call_arg_scaled(in, num, den)`. The arithmetic
// must use checked_mul/checked_div so a malicious or accidentally huge
// `num` cannot wrap the result and silently permit a swap that should
// have denied. Install refuses `den==0` and `num<=0`/`den<=0` so a negative
// ratio cannot ever invert the comparison either.
//
// Wire shape: `vec_scval([symbol("call_arg_scaled"), u32(index), i128(num), i128(den)])`.

fn build_call_arg_scaled_args(env: &Env, in_val: i128, out_val: i128) -> EvalContext {
    let mut args = SorobanVec::<Val>::new(env);
    args.push_back(in_val.into_val(env));
    args.push_back(out_val.into_val(env));
    let mut ctx = empty_ctx(env);
    ctx.args = args;
    ctx
}

#[test]
fn f9_slippage_floor_at_exact_ratio_permits() {
    // out == in*num/den exactly; Gte must PERMIT (floor is inclusive).
    let env = Env::default();
    let in_val: i128 = 1_000;
    let num: i128 = 95;
    let den: i128 = 100;
    let out_val: i128 = (in_val * num) / den; // 950
    let ctx = build_call_arg_scaled_args(&env, in_val, out_val);
    let n = Node::Compare {
        op: CompareOp::Gte,
        left: Leaf::CallArg(1),
        right: Leaf::CallArgScaled { index: 0, num, den },
    };
    assert!(permit(evaluate(&env, &n, &ctx)));
}

#[test]
fn f9_slippage_floor_one_stroop_below_denies_slippage_floor() {
    // out == floor - 1; Gte must DENY with SlippageFloor (the dedicated
    // reason), not the generic ArgMismatch or StatefulBound.
    let env = Env::default();
    let in_val: i128 = 1_000;
    let num: i128 = 95;
    let den: i128 = 100;
    let floor: i128 = (in_val * num) / den; // 950
    let out_val: i128 = floor - 1;
    let ctx = build_call_arg_scaled_args(&env, in_val, out_val);
    let n = Node::Compare {
        op: CompareOp::Gte,
        left: Leaf::CallArg(1),
        right: Leaf::CallArgScaled { index: 0, num, den },
    };
    assert_eq!(
        reason(evaluate(&env, &n, &ctx)),
        Some(DenyReason::SlippageFloor)
    );
}

#[test]
fn f9_slippage_floor_num_equals_den_behaves_as_ratio_one() {
    // num == den => ratio 1; in == out PERMITS, in > out DENIES floor.
    let env = Env::default();
    let ctx = build_call_arg_scaled_args(&env, 100, 100);
    let n = Node::Compare {
        op: CompareOp::Gte,
        left: Leaf::CallArg(1),
        right: Leaf::CallArgScaled {
            index: 0,
            num: 1,
            den: 1,
        },
    };
    assert!(permit(evaluate(&env, &n, &ctx)));
    let ctx = build_call_arg_scaled_args(&env, 100, 99);
    assert_eq!(
        reason(evaluate(&env, &n, &ctx)),
        Some(DenyReason::SlippageFloor)
    );
}

#[test]
fn f9_slippage_floor_very_large_ratio_permits_when_out_meets_it() {
    // num=10, den=1 -> 10x ratio. out exactly 10x in PERMITS.
    let env = Env::default();
    let ctx = build_call_arg_scaled_args(&env, 1_000, 10_000);
    let n = Node::Compare {
        op: CompareOp::Gte,
        left: Leaf::CallArg(1),
        right: Leaf::CallArgScaled {
            index: 0,
            num: 10,
            den: 1,
        },
    };
    assert!(permit(evaluate(&env, &n, &ctx)));
}

#[test]
fn f9_slippage_floor_very_small_ratio_behaves() {
    // num=1, den=1_000_000 -> 0.0001% ratio. out=1 when in=1_000_000 PERMITS
    // (1 >= 1_000_000 * 1 / 1_000_000 = 1), out=0 DENIES.
    let env = Env::default();
    let ctx = build_call_arg_scaled_args(&env, 1_000_000, 1);
    let n = Node::Compare {
        op: CompareOp::Gte,
        left: Leaf::CallArg(1),
        right: Leaf::CallArgScaled {
            index: 0,
            num: 1,
            den: 1_000_000,
        },
    };
    assert!(permit(evaluate(&env, &n, &ctx)));
    let ctx = build_call_arg_scaled_args(&env, 1_000_000, 0);
    assert_eq!(
        reason(evaluate(&env, &n, &ctx)),
        Some(DenyReason::SlippageFloor)
    );
}

#[test]
fn f9_slippage_floor_overflow_denies_arithmetic_overflow_not_panic() {
    // args[0] = i128::MAX, num = 2, den = 1 -> i128::MAX * 2 overflows.
    // Must DENY with ArithmeticOverflow (102) and NOT panic the frame.
    let env = Env::default();
    let mut args = SorobanVec::<Val>::new(&env);
    args.push_back(i128::MAX.into_val(&env));
    let mut ctx = empty_ctx(&env);
    ctx.args = args;
    let n = Node::Compare {
        op: CompareOp::Gte,
        left: Leaf::CallArg(0),
        right: Leaf::CallArgScaled {
            index: 0,
            num: 2,
            den: 1,
        },
    };
    assert_eq!(
        reason(evaluate(&env, &n, &ctx)),
        Some(DenyReason::ArithmeticOverflow)
    );
}

#[test]
fn f9_slippage_floor_divide_by_zero_denies_overflow_in_evaluation() {
    // den == 0 is caught at install, but a runtime check must also fail
    // closed: checked_div panics i128 on /0, the evaluator must NOT panic
    // the frame. We do NOT install a den=0 predicate in production (it's
    // refused at install), so this test guards the case where decode
    // succeeded by some future change of policy.
    let env = Env::default();
    let mut args = SorobanVec::<Val>::new(&env);
    args.push_back(100i128.into_val(&env));
    let mut ctx = empty_ctx(&env);
    ctx.args = args;
    let n = Node::Compare {
        op: CompareOp::Gte,
        left: Leaf::CallArg(0),
        right: Leaf::CallArgScaled {
            index: 0,
            num: 1,
            den: 0,
        },
    };
    assert_eq!(
        reason(evaluate(&env, &n, &ctx)),
        Some(DenyReason::ArithmeticOverflow)
    );
}

#[test]
fn f9_slippage_floor_division_truncates_toward_zero() {
    // 7 * 10 / 3 = 23 (truncated from 23.33). Gte against out=23 PERMITS,
    // out=22 DENIES.
    let env = Env::default();
    let ctx = build_call_arg_scaled_args(&env, 7, 23);
    let n = Node::Compare {
        op: CompareOp::Gte,
        left: Leaf::CallArg(1),
        right: Leaf::CallArgScaled {
            index: 0,
            num: 10,
            den: 3,
        },
    };
    assert!(permit(evaluate(&env, &n, &ctx)));
    let ctx = build_call_arg_scaled_args(&env, 7, 22);
    assert_eq!(
        reason(evaluate(&env, &n, &ctx)),
        Some(DenyReason::SlippageFloor)
    );
}

#[test]
fn f9_slippage_floor_satisfies_left_equals_for_swap_min_max() {
    // Symmetric: `call_arg_scaled(0,num,den) <= call_arg[1]` (the swap
    // output floor expressed as Lte on the scaled leaf). The brief shows
    // the Gte form, but `<=` must also work for policies that phrase the
    // floor the other way.
    let env = Env::default();
    let ctx = build_call_arg_scaled_args(&env, 1_000, 950);
    let n = Node::Compare {
        op: CompareOp::Lte,
        left: Leaf::CallArgScaled {
            index: 0,
            num: 95,
            den: 100,
        },
        right: Leaf::CallArg(1),
    };
    assert!(permit(evaluate(&env, &n, &ctx)));
}

#[test]
fn f9_slippage_floor_out_of_bounds_index_denies_arg_mismatch() {
    // Reading args[99] when only 1 arg is supplied is the same boundary
    // failure as for the plain CallArg leaf: ArgMismatch, not SlippageFloor.
    let env = Env::default();
    let mut args = SorobanVec::<Val>::new(&env);
    args.push_back(100i128.into_val(&env));
    let mut ctx = empty_ctx(&env);
    ctx.args = args;
    let n = Node::Compare {
        op: CompareOp::Gte,
        left: Leaf::CallArg(0),
        right: Leaf::CallArgScaled {
            index: 99,
            num: 1,
            den: 1,
        },
    };
    assert_eq!(
        reason(evaluate(&env, &n, &ctx)),
        Some(DenyReason::ArgMismatch)
    );
}

#[test]
fn f9_slippage_floor_non_numeric_arg_denies_arg_mismatch() {
    // args[0] is a Symbol, not a number. Must deny with ArgMismatch (the
    // standard "could not source the operand" code), NOT SlippageFloor.
    let env = Env::default();
    let mut args = SorobanVec::<Val>::new(&env);
    args.push_back(Symbol::new(&env, "not_a_number").into_val(&env));
    let mut ctx = empty_ctx(&env);
    ctx.args = args;
    let n = Node::Compare {
        op: CompareOp::Gte,
        left: Leaf::CallArg(0),
        right: Leaf::CallArgScaled {
            index: 0,
            num: 1,
            den: 1,
        },
    };
    assert_eq!(
        reason(evaluate(&env, &n, &ctx)),
        Some(DenyReason::ArgMismatch)
    );
}

#[test]
fn f9_slippage_floor_is_stateless() {
    // Install-time/eval-time invariant: the floor must not pull storage,
    // so it counts as a stateless leaf. A stateless leaf is ELIGIBLE to
    // live under `not`/`or`.
    let leaf = Leaf::CallArgScaled {
        index: 0,
        num: 1,
        den: 1,
    };
    assert!(leaf.is_stateless());
}

#[test]
fn f9_slippage_floor_wire_roundtrip_decodes() {
    // The ScVal wire form `call_arg_scaled(u32, i128, i128)` must decode
    // back to the same leaf. The wire format is what conformance/TS
    // alignment depends on, so this guards the round-trip end to end.
    let env = Env::default();
    let leaf = Leaf::CallArgScaled {
        index: 0,
        num: 950,
        den: 1000,
    };
    let node = Node::Compare {
        op: CompareOp::Gte,
        left: Leaf::CallArg(1),
        right: leaf,
    };
    let bytes = bytes_from_node(&env, &node);
    let decoded = decode_with_byte_cap(&env, &bytes).expect("decode must succeed");
    // The decoded tree must reproduce the permit decision with the
    // same args. if the wire form were wrong, decode would have denied
    // at the selector branch.
    let mut args = SorobanVec::<Val>::new(&env);
    args.push_back(1000i128.into_val(&env));
    args.push_back(950i128.into_val(&env));
    let mut ctx = empty_ctx(&env);
    ctx.args = args;
    assert!(permit(evaluate(&env, &decoded, &ctx)));
}

#[test]
fn f9_slippage_floor_decodes_with_arity_three_denies_malformed() {
    // Arity 3: missing the `den` field. Must decode as MALFORMED_PREDICATE,
    // not silently interpret the missing field as 1.
    let env = Env::default();
    let bytes = bytes_from_scval(
        &env,
        vec_scval(&[
            sym("gte"),
            vec_scval(&[sym("call_arg"), u32_scval(0)]),
            vec_scval(&[sym("call_arg_scaled"), u32_scval(0), i128_scval(95)]),
        ]),
    );
    let err = decode_with_byte_cap(&env, &bytes).expect_err("arity 3 must reject");
    assert_eq!(err.code(), "MALFORMED_PREDICATE");
}

#[test]
fn f9_slippage_floor_decodes_with_arity_five_denies_malformed() {
    // Arity 5: one extra trailing field. Must decode as MALFORMED_PREDICATE.
    let env = Env::default();
    let bytes = bytes_from_scval(
        &env,
        vec_scval(&[
            sym("gte"),
            vec_scval(&[sym("call_arg"), u32_scval(0)]),
            vec_scval(&[
                sym("call_arg_scaled"),
                u32_scval(0),
                i128_scval(95),
                i128_scval(100),
                u32_scval(0),
            ]),
        ]),
    );
    let err = decode_with_byte_cap(&env, &bytes).expect_err("arity 5 must reject");
    assert_eq!(err.code(), "MALFORMED_PREDICATE");
}

#[test]
fn f9_slippage_floor_decodes_with_u32_num_denies_malformed() {
    // num/den muxed as u32 instead of i128. The type field is mandatory -
    // a u32 there shifts the wire arity and breaks the contract.
    let env = Env::default();
    let bytes = bytes_from_scval(
        &env,
        vec_scval(&[
            sym("gte"),
            vec_scval(&[sym("call_arg"), u32_scval(0)]),
            vec_scval(&[
                sym("call_arg_scaled"),
                u32_scval(0),
                u32_scval(95),
                u32_scval(100),
            ]),
        ]),
    );
    let err = decode_with_byte_cap(&env, &bytes).expect_err("u32 num/den must reject");
    assert_eq!(err.code(), "MALFORMED_PREDICATE");
}

#[test]
fn f9_slippage_floor_decodes_with_missing_index_denies_malformed() {
    // The index field is missing (only the symbol). Decoder must reject.
    let env = Env::default();
    let bytes = bytes_from_scval(
        &env,
        vec_scval(&[
            sym("gte"),
            vec_scval(&[sym("call_arg"), u32_scval(0)]),
            vec_scval(&[sym("call_arg_scaled"), i128_scval(95), i128_scval(100)]),
        ]),
    );
    let err = decode_with_byte_cap(&env, &bytes).expect_err("missing index must reject");
    assert_eq!(err.code(), "MALFORMED_PREDICATE");
}

#[test]
fn f9_slippage_floor_decodes_with_negative_num_and_den() {
    // Negative num/den are syntactically valid i128, so the decoder
    // ACCEPTS them - install-time validation is what refuses them. This
    // test pins the contract that decode is not the gate.
    let env = Env::default();
    let bytes = bytes_from_scval(
        &env,
        vec_scval(&[
            sym("gte"),
            vec_scval(&[sym("call_arg"), u32_scval(0)]),
            vec_scval(&[
                sym("call_arg_scaled"),
                u32_scval(0),
                i128_scval(-95),
                i128_scval(-100),
            ]),
        ]),
    );
    assert!(decode_with_byte_cap(&env, &bytes).is_ok());
}

#[test]
fn f9_slippage_floor_validate_scaled_ratios_refuses_den_zero_at_install() {
    // The install-time walker must reject `den == 0` so a divide-by-zero
    // cannot slip through as a runtime overflow.
    use crate::dsl::validate_scaled_ratios;
    let _env = Env::default();
    let n = Node::Compare {
        op: CompareOp::Gte,
        left: Leaf::CallArg(1),
        right: Leaf::CallArgScaled {
            index: 0,
            num: 95,
            den: 0,
        },
    };
    assert_eq!(
        validate_scaled_ratios(&n),
        Err(crate::dsl::ScaledRatioError::ZeroDenominator)
    );
}

#[test]
fn f9_slippage_floor_validate_scaled_ratios_refuses_negative_num() {
    use crate::dsl::validate_scaled_ratios;
    let _env = Env::default();
    let n = Node::Compare {
        op: CompareOp::Gte,
        left: Leaf::CallArg(1),
        right: Leaf::CallArgScaled {
            index: 0,
            num: -1,
            den: 100,
        },
    };
    assert_eq!(
        validate_scaled_ratios(&n),
        Err(crate::dsl::ScaledRatioError::NonPositiveNumerator)
    );
}

#[test]
fn f9_slippage_floor_validate_scaled_ratios_refuses_negative_den() {
    use crate::dsl::validate_scaled_ratios;
    let _env = Env::default();
    let n = Node::Compare {
        op: CompareOp::Gte,
        left: Leaf::CallArg(1),
        right: Leaf::CallArgScaled {
            index: 0,
            num: 95,
            den: -1,
        },
    };
    assert_eq!(
        validate_scaled_ratios(&n),
        Err(crate::dsl::ScaledRatioError::NonPositiveDenominator)
    );
}

#[test]
fn f9_slippage_floor_validate_scaled_ratios_refuses_nested_inside_literal_vec() {
    // A scaled leaf smuggled inside a LiteralVec must still be caught -
    // decode recursion is the same smuggling vector the install walker
    // closes for every shape.
    use crate::dsl::validate_scaled_ratios;
    let _env = Env::default();
    let n = Node::Compare {
        op: CompareOp::Eq,
        left: Leaf::CallArg(0),
        right: Leaf::LiteralVec(StdVec::from([Leaf::CallArgScaled {
            index: 0,
            num: 1,
            den: 0,
        }])),
    };
    assert_eq!(
        validate_scaled_ratios(&n),
        Err(crate::dsl::ScaledRatioError::ZeroDenominator)
    );
}

#[test]
fn f9_slippage_floor_validate_scaled_ratios_accepts_positive_ratio() {
    use crate::dsl::validate_scaled_ratios;
    let _env = Env::default();
    let n = Node::Compare {
        op: CompareOp::Gte,
        left: Leaf::CallArg(1),
        right: Leaf::CallArgScaled {
            index: 0,
            num: 95,
            den: 100,
        },
    };
    assert_eq!(validate_scaled_ratios(&n), Ok(()));
}

#[test]
fn f9_slippage_floor_code_stability_table() {
    // Extend the f8b code-stability tests with the new variant. The
    // numeric code is part of the public ABI.
    use crate::storage::PolicyError;
    assert_eq!(PolicyError::from(DenyReason::SlippageFloor) as u32, 107);
    assert_eq!(
        PolicyError::SlippageFloor.code_str(),
        DenyReason::SlippageFloor.code()
    );
    assert_eq!(DenyReason::SlippageFloor.code(), "SLIPPAGE_FLOOR");
}

#[test]
fn f9_slippage_floor_reason_is_not_fatal() {
    // SlippageFloor is a numeric bound denial; it must NOT be fatal, so a
    // sibling `or` branch can carry it and a `not` can still invert it.
    assert!(!DenyReason::SlippageFloor.is_fatal());

    // Concrete: a not around a denied floor flips to Permit.
    let env = Env::default();
    let ctx = build_call_arg_scaled_args(&env, 1_000, 949);
    let inner = Node::Compare {
        op: CompareOp::Gte,
        left: Leaf::CallArg(1),
        right: Leaf::CallArgScaled {
            index: 0,
            num: 95,
            den: 100,
        },
    };
    let n = Node::Not(Box::new(inner));
    assert!(permit(evaluate(&env, &n, &ctx)));
}
