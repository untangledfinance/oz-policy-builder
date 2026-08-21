//! Unit tests for the dsl decoder + pure evaluator.
//!
//! Covers the current `dsl` API (host-parsed `Val` walking, native
//! soroban-sdk types) and the audit-critical fail-closed branches.
//!
//! Axes:
//!   - each operator (and / in / eq / lte) with a permit case plus the deny
//!     case that operator uniquely owns
//!   - each v2 selector: call_contract, call_fn, call_arg, call_arg_len,
//!     call_arg_field
//!   - fail-closed at every entry boundary: unknown node symbol, unknown
//!     selector symbol, wrong arity, wrong ScVal type as a literal, in []
//!     at decode, call_arg index out of bounds at evaluate, garbage bytes
//!     fail-closed as malformed
//!   - caps with the exact wire codes: MAX_DEPTH 5 -> PREDICATE_TOO_DEEP,
//!     MAX_LEAVES 200 -> TOO_MANY_LEAVES, MAX_IN_OPERAND_COUNT 32 ->
//!     IN_OPERAND_LIMIT, MAX_PREDICATE_BYTES 32768 -> PREDICATE_TOO_LARGE
//!   - i128 checked semantics at the boundary

extern crate alloc;

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
        Leaf::LiteralAddress(_) => addr_scval(),
        Leaf::LiteralI128(v) => i128_scval(*v),
        Leaf::LiteralSymbol(s) => {
            // Round-trip so host and wire see the same canonical symbol bytes.
            let _: &Env = env;
            let v: Val = s.clone().into_val(env);
            ScVal::from_xdr(env, &v.to_xdr(env)).expect("sym round-trip")
        }
        Leaf::LiteralU32(v) => u32_scval(*v),
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
        CompareOp::Lte => "lte",
    }
}

// ----- Tests: operators -----------------------------------------------------

#[test]
fn op_and_all_permit_passes() {
    let env = Env::default();
    let n = Node::And(StdVec::from([
        cmp_i128(CompareOp::Eq, 10, 10),
        cmp_i128(CompareOp::Lte, 5, 10),
    ]));
    assert!(permit(evaluate(&env, &n, &empty_ctx(&env))));
}

#[test]
fn op_and_fail_fast_returns_first_violation() {
    let env = Env::default();
    let n = Node::And(StdVec::from([
        cmp_i128(CompareOp::Lte, 10, 5), // fails -> ArgMismatch
        cmp_i128(CompareOp::Eq, 5, 5),   // would also permit — but first deny short-circuits
    ]));
    assert_eq!(
        reason(evaluate(&env, &n, &empty_ctx(&env))),
        Some(DenyReason::ArgMismatch)
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
fn op_lte_permits_at_bound() {
    let env = Env::default();
    assert!(permit(evaluate(
        &env,
        &cmp_i128(CompareOp::Lte, 10, 10),
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
        op: CompareOp::Lte,
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
        reason(evaluate(&env, &n, &empty_ctx(&env))),
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
    let err = decode_with_byte_cap(&env, &bogus).expect_err("i128 in call_arg slot must deny");
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
            vec_scval(&[sym("window_spent"), addr_scval(), i128_scval(86400)]),
            i128_scval(1000),
        ]),
    );
    let err = decode_with_byte_cap(&env, &bytes).expect_err("`window_spent` must not decode");
    assert_eq!(err.code(), "MALFORMED_PREDICATE");
}

#[test]
fn selector_leaf_gate_refuses_literals_on_both_sides() {
    // The case the gate exists for: nothing about the call is read, so the
    // predicate binds nothing and would be a permanent allow.
    let n = Node::Compare {
        op: CompareOp::Eq,
        left: Leaf::LiteralU32(1),
        right: Leaf::LiteralU32(1),
    };
    assert!(!crate::dsl::has_selector_leaf(&n));
}

#[test]
fn selector_leaf_gate_sees_through_a_literal_vec() {
    // A selector wrapped in a literal vector is still a selector; without the
    // recursion the wrapper would be a bypass of the gate.
    let n = Node::In {
        needle: Leaf::LiteralVec(StdVec::from([Leaf::CallFn])),
        haystack: StdVec::from([Leaf::LiteralU32(1)]),
    };
    assert!(crate::dsl::has_selector_leaf(&n));
}
