//! Unit tests for the dsl decoder + pure evaluator.
//!
//! Covers the current `dsl` API (host-parsed `Val` walking, native
//! soroban-sdk types) and the audit-critical fail-closed branches.
//!
//! Axes:
//!   - each operator (and / or / not / in / eq / lt / lte / gt / gte) with a
//!     permit case plus the deny case that operator uniquely owns
//!   - each v1 selector: call_contract, call_fn, call_arg, call_arg_len,
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
    decode, decode_with_byte_cap, evaluate, validate_oracle_thresholds, CompareOp, DenyReason,
    EvalContext, EvalDecision, Leaf, Node, OracleEntry, OracleThresholdError, MAX_DEPTH,
    MAX_IN_OPERAND_COUNT, MAX_LEAVES, MAX_ORACLE_THRESHOLD_DECIMALS, MAX_PREDICATE_BYTES,
};
use crate::oracle::NORMALISED_DECIMALS;
use soroban_sdk::testutils::Address as _;
use soroban_sdk::xdr::{FromXdr, ScVal, ToXdr, VecM};
use soroban_sdk::{Address, Bytes, Env, IntoVal, Symbol, Val, Vec as SorobanVec};

// ----- tiny builders / helpers ----------------------------------------------

fn contract(env: &Env) -> Address {
    Address::generate(env)
}

fn token(env: &Env) -> Address {
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
        oracle_price_by_asset: StdVec::new(),
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
        Leaf::OraclePrice(_) => vec_scval(&[sym("oracle_price"), addr_scval()]),
        Leaf::OracleThresholdI128 { value, decimals } => vec_scval(&[
            sym("oracle_threshold"),
            i128_scval(*value),
            u32_scval(*decimals),
        ]),
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
fn op_not_does_not_invert_a_fatal_oracle_deny() {
    // The empty snapshot in `empty_ctx` means the price was never resolved,
    // which is fatal. `not` must surface it rather than invert it into a
    // permit - that is how a policy would otherwise satisfy itself by
    // negating an oracle read it prevented from succeeding.
    let env = Env::default();
    let inner = Node::Compare {
        op: CompareOp::Lt,
        left: Leaf::OraclePrice(token(&env)),
        right: Leaf::LiteralI128(100),
    };
    let n = Node::Not(Box::new(inner));
    assert_eq!(
        reason(evaluate(&env, &n, &empty_ctx(&env))),
        Some(DenyReason::OracleStale)
    );
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

// ----- Tests: i128 checked arithmetic --------------------------------------

// ---- oracle_price: fatal-error semantics ----

fn oracle_ctx(env: &Env, asset: &Address, entry: OracleEntry) -> EvalContext {
    let mut ctx = empty_ctx(env);
    ctx.oracle_price_by_asset = StdVec::from([(asset.clone(), entry)]);
    ctx
}

/// `oracle_price(asset) < bound`, with the bound on the NORMALISED 9-dp basis
/// the resolver produces. Thresholds must declare their basis, so this states
/// the one these tests use.
fn oracle_lt(asset: &Address, bound: i128) -> Node {
    oracle_lt_at(asset, bound, NORMALISED_DECIMALS)
}

/// `oracle_price(asset) < bound`, with the bound on an explicit basis.
fn oracle_lt_at(asset: &Address, bound: i128, decimals: u32) -> Node {
    Node::Compare {
        op: CompareOp::Lt,
        left: Leaf::OraclePrice(asset.clone()),
        right: Leaf::OracleThresholdI128 {
            value: bound,
            decimals,
        },
    }
}

/// `oracle_price(asset) < bound` with a BARE literal - the pre-fix shape that
/// silently assumed the normalised basis.
fn oracle_lt_bare_literal(asset: &Address, bound: i128) -> Node {
    Node::Compare {
        op: CompareOp::Lt,
        left: Leaf::OraclePrice(asset.clone()),
        right: Leaf::LiteralI128(bound),
    }
}

#[test]
fn oracle_price_within_bound_permits() {
    let env = Env::default();
    let asset = token(&env);
    let ctx = oracle_ctx(
        &env,
        &asset,
        OracleEntry::Price {
            price: 50,
            timestamp_seconds: 1000,
        },
    );
    assert!(permit(evaluate(&env, &oracle_lt(&asset, 100), &ctx)));
}

#[test]
fn oracle_price_outside_bound_denies() {
    let env = Env::default();
    let asset = token(&env);
    let ctx = oracle_ctx(
        &env,
        &asset,
        OracleEntry::Price {
            price: 150,
            timestamp_seconds: 1000,
        },
    );
    assert!(!permit(evaluate(&env, &oracle_lt(&asset, 100), &ctx)));
}

#[test]
fn oracle_asset_missing_from_snapshot_is_stale_not_zero() {
    // The dangerous default: an unresolved asset must not read as price 0 and
    // satisfy `price < bound`.
    let env = Env::default();
    let asset = token(&env);
    assert_eq!(
        reason(evaluate(&env, &oracle_lt(&asset, 100), &empty_ctx(&env))),
        Some(DenyReason::OracleStale)
    );
}

#[test]
fn oracle_failure_reasons_pass_through() {
    let env = Env::default();
    let asset = token(&env);
    for r in [
        DenyReason::OracleStale,
        DenyReason::OracleMissing,
        DenyReason::OracleDeviationExceeded,
        DenyReason::OraclePaused,
        DenyReason::OracleDecimalsMismatch,
        DenyReason::OracleFingerprintDrift,
    ] {
        let ctx = oracle_ctx(&env, &asset, OracleEntry::Failed(r));
        assert_eq!(
            reason(evaluate(&env, &oracle_lt(&asset, 100), &ctx)),
            Some(r),
            "oracle failure reason must survive evaluation"
        );
        assert!(r.is_fatal(), "every oracle failure must be fatal");
    }
}

#[test]
fn oracle_non_i128_bound_is_decimals_mismatch() {
    let env = Env::default();
    let asset = token(&env);
    let ctx = oracle_ctx(
        &env,
        &asset,
        OracleEntry::Price {
            price: 50,
            timestamp_seconds: 1000,
        },
    );
    let n = Node::Compare {
        op: CompareOp::Lt,
        left: Leaf::OraclePrice(asset.clone()),
        right: Leaf::LiteralU32(100),
    };
    assert_eq!(
        reason(evaluate(&env, &n, &ctx)),
        Some(DenyReason::OracleDecimalsMismatch)
    );
}

#[test]
fn or_cannot_permit_around_a_failed_oracle_read() {
    // The whole point of "fatal": a sibling branch that would otherwise
    // permit must not mask an oracle that failed to resolve.
    let env = Env::default();
    let asset = token(&env);
    let ctx = oracle_ctx(&env, &asset, OracleEntry::Failed(DenyReason::OraclePaused));
    let n = Node::Or(StdVec::from([
        oracle_lt(&asset, 100),
        cmp_i128(CompareOp::Eq, 7, 7), // would permit on its own
    ]));
    assert_eq!(
        reason(evaluate(&env, &n, &ctx)),
        Some(DenyReason::OraclePaused)
    );
}

#[test]
fn and_surfaces_a_failed_oracle_read() {
    let env = Env::default();
    let asset = token(&env);
    let ctx = oracle_ctx(
        &env,
        &asset,
        OracleEntry::Failed(DenyReason::OracleDeviationExceeded),
    );
    let n = Node::And(StdVec::from([
        cmp_i128(CompareOp::Eq, 7, 7),
        oracle_lt(&asset, 100),
    ]));
    assert_eq!(
        reason(evaluate(&env, &n, &ctx)),
        Some(DenyReason::OracleDeviationExceeded)
    );
}

// ---- oracle install-time placement rules ----

#[test]
fn oracle_leaf_under_not_is_rejected() {
    let env = Env::default();
    let n = Node::Not(Box::new(oracle_lt(&token(&env), 100)));
    assert_eq!(
        crate::dsl::validate_oracle_placement(&n),
        Err(crate::dsl::OracleValidationError::LeafInvalidPosition)
    );
}

#[test]
fn oracle_leaf_under_or_is_rejected() {
    let env = Env::default();
    let n = Node::Or(StdVec::from([
        oracle_lt(&token(&env), 100),
        cmp_i128(CompareOp::Eq, 7, 7),
    ]));
    assert_eq!(
        crate::dsl::validate_oracle_placement(&n),
        Err(crate::dsl::OracleValidationError::LeafInvalidPosition)
    );
}

#[test]
fn oracle_leaf_nested_under_and_below_or_is_still_rejected() {
    // The restriction is about being anywhere beneath a disjunction, not just
    // an immediate child of it.
    let env = Env::default();
    let n = Node::Or(StdVec::from([
        Node::And(StdVec::from([oracle_lt(&token(&env), 100)])),
        cmp_i128(CompareOp::Eq, 7, 7),
    ]));
    assert_eq!(
        crate::dsl::validate_oracle_placement(&n),
        Err(crate::dsl::OracleValidationError::LeafInvalidPosition)
    );
}

#[test]
fn oracle_leaf_under_top_level_and_with_envelope_is_accepted() {
    let env = Env::default();
    let n = Node::And(StdVec::from([
        Node::Compare {
            op: CompareOp::Eq,
            left: Leaf::CallContract,
            right: Leaf::LiteralAddress(contract(&env)),
        },
        oracle_lt(&token(&env), 100),
    ]));
    assert_eq!(crate::dsl::validate_oracle_placement(&n), Ok(()));
}

#[test]
fn predicate_of_only_oracle_leaves_is_rejected() {
    let env = Env::default();
    let n = Node::And(StdVec::from([oracle_lt(&token(&env), 100)]));
    assert_eq!(
        crate::dsl::validate_oracle_placement(&n),
        Err(crate::dsl::OracleValidationError::MissingNonOracleEnvelope)
    );
}

#[test]
fn more_than_three_oracle_assets_exceeds_the_read_cap() {
    let env = Env::default();
    let mut children = StdVec::from([Node::Compare {
        op: CompareOp::Eq,
        left: Leaf::CallContract,
        right: Leaf::LiteralAddress(contract(&env)),
    }]);
    for _ in 0..4 {
        children.push(oracle_lt(&token(&env), 100));
    }
    let n = Node::And(children);
    assert_eq!(
        crate::dsl::validate_oracle_placement(&n),
        Err(crate::dsl::OracleValidationError::TooManyReads)
    );
}

#[test]
fn three_oracle_assets_are_within_the_read_cap() {
    let env = Env::default();
    let mut children = StdVec::from([Node::Compare {
        op: CompareOp::Eq,
        left: Leaf::CallContract,
        right: Leaf::LiteralAddress(contract(&env)),
    }]);
    for _ in 0..3 {
        children.push(oracle_lt(&token(&env), 100));
    }
    let n = Node::And(children);
    assert_eq!(crate::dsl::validate_oracle_placement(&n), Ok(()));
}

#[test]
fn repeated_reads_of_one_asset_count_once() {
    // The cap counts oracle READS, which is two per distinct asset - not two
    // per leaf. Four leaves on one asset is still a single pair of reads.
    let env = Env::default();
    let asset = token(&env);
    let mut children = StdVec::from([Node::Compare {
        op: CompareOp::Eq,
        left: Leaf::CallContract,
        right: Leaf::LiteralAddress(contract(&env)),
    }]);
    for _ in 0..4 {
        children.push(oracle_lt(&asset, 100));
    }
    let n = Node::And(children);
    assert_eq!(crate::dsl::validate_oracle_placement(&n), Ok(()));
}

#[test]
fn predicate_without_oracle_leaves_is_unaffected() {
    let env = Env::default();
    let n = Node::Not(Box::new(cmp_i128(CompareOp::Eq, 7, 7)));
    let _ = &env;
    assert_eq!(crate::dsl::validate_oracle_placement(&n), Ok(()));
}

// ---- F1: oracle leaves smuggled inside a literal_vec ----
//
// The TS encoder (packages/policy-synth/src/predicate/encode.ts, collectOracle)
// already recurses through literal vectors; the contract must do the same
// or it depends on the encoder being used. Two install-time failure modes
// when it does not:
//
//   1. The position rule (oracle under `not`/`or` is forbidden) is blind to
//      the nested leaf, so `not(eq(call_arg[0], literal_vec([oracle_price(X)])))`
//      installs. At enforce the eq compares call_arg[0] to a Val produced by
//      `literal_to_val(LiteralVec([OraclePrice(_)]))` - that call returns
//      None because the selector leaf is not a literal, so the eq denies
//      ArgMismatch, and `not(ArgMismatch)` is Permit. Any caller can satisfy
//      a policy built on this shape.
//
//   2. The per-asset read budget is blind to the nested asset, so a
//      predicate can pack more than three distinct assets into literal
//      vectors and pay no enforcement-time cost against the budget.

#[test]
fn f1_oracle_leaf_in_literal_vec_under_not_is_rejected() {
    let env = Env::default();
    let asset = token(&env);
    let n = Node::Not(Box::new(Node::Compare {
        op: CompareOp::Eq,
        left: Leaf::CallArg(0),
        right: Leaf::LiteralVec(StdVec::from([Leaf::OraclePrice(asset.clone())])),
    }));
    assert_eq!(
        crate::dsl::validate_oracle_placement(&n),
        Err(crate::dsl::OracleValidationError::LeafInvalidPosition)
    );
}

#[test]
fn f1_oracle_assets_in_literal_vec_count_towards_read_budget() {
    let env = Env::default();
    // Envelope + four distinct assets, each smuggled through a literal vec
    // on the right of an eq. The budget must see the assets; the literal-only
    // branch is a hole, not a feature.
    let mut children = StdVec::from([Node::Compare {
        op: CompareOp::Eq,
        left: Leaf::CallContract,
        right: Leaf::LiteralAddress(contract(&env)),
    }]);
    for _ in 0..4 {
        children.push(Node::Compare {
            op: CompareOp::Eq,
            left: Leaf::CallArg(0),
            right: Leaf::LiteralVec(StdVec::from([Leaf::OraclePrice(token(&env))])),
        });
    }
    let n = Node::And(children);
    assert_eq!(
        crate::dsl::validate_oracle_placement(&n),
        Err(crate::dsl::OracleValidationError::TooManyReads)
    );
}

#[test]
fn f1_oracle_collect_assets_sees_leaves_nested_in_literal_vec() {
    let env = Env::default();
    let asset = token(&env);
    let n = Node::Compare {
        op: CompareOp::Eq,
        left: Leaf::CallArg(0),
        right: Leaf::LiteralVec(StdVec::from([Leaf::OraclePrice(asset.clone())])),
    };
    let assets = crate::oracle::collect_oracle_assets(&n);
    assert!(
        assets.iter().any(|a| a == &asset),
        "oracle::collect_oracle_assets must recurse into LiteralVec"
    );
}

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
    assert_eq!(PolicyError::from(DenyReason::OracleStale) as u32, 304);
    assert_eq!(PolicyError::from(DenyReason::OracleMissing) as u32, 305);
    assert_eq!(
        PolicyError::from(DenyReason::OracleDeviationExceeded) as u32,
        306
    );
    assert_eq!(PolicyError::from(DenyReason::OraclePaused) as u32, 307);
    assert_eq!(
        PolicyError::from(DenyReason::OracleDecimalsMismatch) as u32,
        308
    );
    assert_eq!(
        PolicyError::from(DenyReason::OracleFingerprintDrift) as u32,
        309
    );
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
        PolicyError::OracleStale.code_str(),
        DenyReason::OracleStale.code()
    );
    assert_eq!(
        PolicyError::OracleMissing.code_str(),
        DenyReason::OracleMissing.code()
    );
    assert_eq!(
        PolicyError::OracleDeviationExceeded.code_str(),
        DenyReason::OracleDeviationExceeded.code()
    );
    assert_eq!(
        PolicyError::OraclePaused.code_str(),
        DenyReason::OraclePaused.code()
    );
    assert_eq!(
        PolicyError::OracleDecimalsMismatch.code_str(),
        DenyReason::OracleDecimalsMismatch.code()
    );
    assert_eq!(
        PolicyError::OracleFingerprintDrift.code_str(),
        DenyReason::OracleFingerprintDrift.code()
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
    // Install-time/eval-time invariant: the floor must not pull storage or
    // oracle state, so it counts as a stateless leaf. A stateless leaf is
    // ELIGIBLE to live under `not`/`or` (where oracle leaves are refused).
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
    // decode recursion looks the same way oracle leaves do (F1).
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
fn f9_slippage_floor_used_under_or_is_supported() {
    // The floor is stateless; it does NOT carry the fatal-deny semantics
    // an oracle leaf does, so it must be usable under `or`/`not`. The
    // oracle placement validator must not reject it.
    crate::dsl::validate_oracle_placement(&Node::Compare {
        op: CompareOp::Gte,
        left: Leaf::CallArg(1),
        right: Leaf::CallArgScaled {
            index: 0,
            num: 95,
            den: 100,
        },
    })
    .expect("no oracle leaves => Ok");

    // Now confirm it doesn't slip into the oracle-non-envelope check when
    // it is the only enforcement leaf - the non-oracle-leaves count is
    // driven by `collect_oracle_leaf`'s catch-all arm, which counts
    // selector leaves (anything that isn't a literal).
    let n = Node::Compare {
        op: CompareOp::Gte,
        left: Leaf::CallArg(0),
        right: Leaf::CallArgScaled {
            index: 1,
            num: 1,
            den: 1,
        },
    };
    crate::dsl::validate_oracle_placement(&n).expect("no oracle leaves => Ok");
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

// ---- f10: oracle threshold decimal basis (closes the fail-open case) ----
//
// Prices normalise to 9 dp. Before these, an oracle comparison's threshold was
// a bare i128 ASSUMED to be on that basis, so an author who wrote a raw 14-dp
// threshold produced a bound ~10^5 too large - `price < threshold` was
// trivially true and the policy permitted everything it was written to deny.
// That is the only fail-open case the review found. The basis is now declared.

#[test]
fn f10_oracle_threshold_on_normalised_basis_behaves_as_before() {
    let env = Env::default();
    let asset = token(&env);
    let ctx = oracle_ctx(
        &env,
        &asset,
        OracleEntry::Price {
            price: 50,
            timestamp_seconds: 1000,
        },
    );
    assert!(permit(evaluate(&env, &oracle_lt_at(&asset, 100, 9), &ctx)));
}

#[test]
fn f10_a_14_decimal_threshold_no_longer_permits_everything() {
    // THE REGRESSION THIS FIX EXISTS FOR. Price is 100 on the 9-dp basis
    // (= 0.0000001). The author means "deny above 0.0000001" and writes the
    // threshold on the 14-dp basis the raw feed uses: 100 * 10^5 = 10_000_000.
    // Read as 9-dp that bound is 10^5 too large and the compare is trivially
    // satisfied. Declared as 14-dp it means exactly what the author wrote, so
    // an equal price must NOT satisfy a strict `<`.
    let env = Env::default();
    let asset = token(&env);
    let ctx = oracle_ctx(
        &env,
        &asset,
        OracleEntry::Price {
            price: 100,
            timestamp_seconds: 1000,
        },
    );

    // Pre-fix behaviour, reproduced: the same digits read as 9-dp permit.
    assert!(permit(evaluate(
        &env,
        &oracle_lt_at(&asset, 10_000_000, 9),
        &ctx
    )));

    // Post-fix: declared as 14-dp it is the SAME magnitude as the price, so a
    // strict `<` denies instead of trivially permitting.
    assert!(!permit(evaluate(
        &env,
        &oracle_lt_at(&asset, 10_000_000, 14),
        &ctx
    )));
}

#[test]
fn f10_a_14_decimal_threshold_still_permits_a_genuinely_lower_price() {
    // The fix must not deny everything - it must mean what the author wrote.
    // Price 99 (9 dp) vs a 14-dp threshold of 100 * 10^5 = price 100 (9 dp).
    let env = Env::default();
    let asset = token(&env);
    let ctx = oracle_ctx(
        &env,
        &asset,
        OracleEntry::Price {
            price: 99,
            timestamp_seconds: 1000,
        },
    );
    assert!(permit(evaluate(
        &env,
        &oracle_lt_at(&asset, 10_000_000, 14),
        &ctx
    )));
}

#[test]
fn f10_a_bare_literal_threshold_denies_rather_than_assuming_a_basis() {
    // Fail CLOSED: an undeclared basis must never be assumed to be normalised.
    let env = Env::default();
    let asset = token(&env);
    let ctx = oracle_ctx(
        &env,
        &asset,
        OracleEntry::Price {
            price: 1,
            timestamp_seconds: 1000,
        },
    );
    assert_eq!(
        reason(evaluate(
            &env,
            &oracle_lt_bare_literal(&asset, i128::MAX),
            &ctx
        )),
        Some(DenyReason::OracleDecimalsMismatch)
    );
}

#[test]
fn f10_decimals_above_the_cap_deny() {
    let env = Env::default();
    let asset = token(&env);
    let ctx = oracle_ctx(
        &env,
        &asset,
        OracleEntry::Price {
            price: 1,
            timestamp_seconds: 1000,
        },
    );
    assert_eq!(
        reason(evaluate(
            &env,
            &oracle_lt_at(&asset, 1, MAX_ORACLE_THRESHOLD_DECIMALS + 1),
            &ctx
        )),
        Some(DenyReason::OracleThresholdDecimalsOutOfRange)
    );
}

#[test]
fn f10_the_cap_itself_is_accepted() {
    // Boundary: 18 is in range, 19 is not.
    let env = Env::default();
    let asset = token(&env);
    let ctx = oracle_ctx(
        &env,
        &asset,
        OracleEntry::Price {
            price: 1,
            timestamp_seconds: 1000,
        },
    );
    assert_ne!(
        reason(evaluate(
            &env,
            &oracle_lt_at(&asset, i128::MAX, MAX_ORACLE_THRESHOLD_DECIMALS),
            &ctx
        )),
        Some(DenyReason::OracleThresholdDecimalsOutOfRange)
    );
}

#[test]
fn f10_scaling_overflow_denies_rather_than_wrapping() {
    // i128::MAX scaled up by 10^9 cannot be represented. Deny, never wrap:
    // a wrapped bound would compare against a meaningless number.
    let env = Env::default();
    let asset = token(&env);
    let ctx = oracle_ctx(
        &env,
        &asset,
        OracleEntry::Price {
            price: 1,
            timestamp_seconds: 1000,
        },
    );
    assert_eq!(
        reason(evaluate(&env, &oracle_lt_at(&asset, i128::MAX, 0), &ctx)),
        Some(DenyReason::ArithmeticOverflow)
    );
}

#[test]
fn f10_install_validation_refuses_an_undeclared_basis() {
    let asset_env = Env::default();
    let asset = token(&asset_env);
    assert_eq!(
        validate_oracle_thresholds(&oracle_lt_bare_literal(&asset, 100)),
        Err(OracleThresholdError::BasisRequired)
    );
    assert_eq!(
        validate_oracle_thresholds(&oracle_lt_at(&asset, 100, 9)),
        Ok(())
    );
}

#[test]
fn f10_install_validation_refuses_decimals_above_the_cap() {
    let asset_env = Env::default();
    let asset = token(&asset_env);
    assert_eq!(
        validate_oracle_thresholds(&oracle_lt_at(
            &asset,
            100,
            MAX_ORACLE_THRESHOLD_DECIMALS + 1
        )),
        Err(OracleThresholdError::DecimalsOutOfRange)
    );
}

#[test]
fn f10_install_validation_recurses_into_and_or_not() {
    // A bad threshold must not hide behind a boolean node.
    let asset_env = Env::default();
    let asset = token(&asset_env);
    let bad = oracle_lt_bare_literal(&asset, 100);
    assert_eq!(
        validate_oracle_thresholds(&Node::And(StdVec::from([bad.clone()]))),
        Err(OracleThresholdError::BasisRequired)
    );
    assert_eq!(
        validate_oracle_thresholds(&Node::Or(StdVec::from([bad.clone()]))),
        Err(OracleThresholdError::BasisRequired)
    );
    assert_eq!(
        validate_oracle_thresholds(&Node::Not(Box::new(bad))),
        Err(OracleThresholdError::BasisRequired)
    );
}

#[test]
fn f10_threshold_deny_reasons_are_fatal() {
    // Every oracle deny is fatal, so `or` / `not` can never mask one.
    assert!(DenyReason::OracleThresholdDecimalsOutOfRange.is_fatal());
    assert!(DenyReason::OracleDecimalsMismatch.is_fatal());
}

#[test]
fn f10_error_codes_are_stable() {
    use crate::storage::PolicyError;
    // The numeric codes are a public ABI - off-chain code maps them to
    // sentences. Never renumber.
    assert_eq!(PolicyError::OracleThresholdBasisRequired as u32, 215);
    assert_eq!(PolicyError::OracleThresholdDecimalsOutOfRange as u32, 313);
}

#[test]
fn f10_a_threshold_below_the_normalised_basis_is_scaled_up_not_ignored() {
    // Exercises the literal-scaling arm, which a `decimals >= 9` case cannot:
    // when decimals > 9 the common basis IS decimals, so the literal is
    // multiplied by 10^0 and a broken conversion stays invisible.
    // price = 100 on the 9-dp basis. Threshold declared at 2 dp with value 1
    // means 0.01, i.e. 10_000_000 on the 9-dp basis - far above the price, so
    // `<` must PERMIT. Ignoring the declared basis would compare 100 < 1 and
    // deny, inverting the author's intent.
    let env = Env::default();
    let asset = token(&env);
    let ctx = oracle_ctx(
        &env,
        &asset,
        OracleEntry::Price {
            price: 100,
            timestamp_seconds: 1000,
        },
    );
    assert!(permit(evaluate(&env, &oracle_lt_at(&asset, 1, 2), &ctx)));
}

#[test]
fn f10_a_price_above_a_low_basis_threshold_still_denies() {
    // The mirror of the case above, so "permit" is not simply the default:
    // price = 10^9 on the 9-dp basis (= 1.0) against a 2-dp threshold of 1
    // (= 0.01). The price is higher, so `<` must DENY.
    let env = Env::default();
    let asset = token(&env);
    let ctx = oracle_ctx(
        &env,
        &asset,
        OracleEntry::Price {
            price: 1_000_000_000,
            timestamp_seconds: 1000,
        },
    );
    assert!(!permit(evaluate(&env, &oracle_lt_at(&asset, 1, 2), &ctx)));
}
