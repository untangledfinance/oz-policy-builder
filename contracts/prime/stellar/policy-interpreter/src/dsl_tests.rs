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
//!     MAX_LEAVES 200 -> TooManyLeaves, MAX_IN_OPERAND_COUNT 32 ->
//!     IN_OPERAND_LIMIT, MAX_PREDICATE_BYTES 32768 -> PREDICATE_TOO_LARGE
//!   - i128 checked semantics at the boundary

extern crate alloc;

use alloc::string::ToString;
use alloc::vec::Vec as StdVec;

use crate::dsl::{
    decode, evaluate, CompareOp, DenyReason, EvalContext, EvalDecision, Leaf, Node, PathStep,
    MAX_DEPTH, MAX_IN_OPERAND_COUNT, MAX_LEAVES, MAX_PATH_STEPS, MAX_PREDICATE_BYTES, MAX_READS,
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
        Node::Or(children) => vec_scval(&[
            sym("or"),
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
        Leaf::CallPath(steps) => {
            let mut items = alloc::vec![sym("call_path")];
            items.extend(steps_scval(steps));
            vec_scval(&items)
        }
        Leaf::Now => vec_scval(&[sym("now")]),
        Leaf::Read(contract, func, args, steps) => {
            let mut items = alloc::vec![
                sym("read"),
                scval_of(env, contract.clone()),
                scval_of(env, func.clone()),
                scval_of(env, args.clone()),
            ];
            items.extend(steps_scval(steps));
            vec_scval(&items)
        }
        Leaf::Scaled(k, den) => vec_scval(&[
            sym("scaled"),
            leaf_to_scval(env, &k[0]),
            leaf_to_scval(env, &k[1]),
            i128_scval(*den),
            leaf_to_scval(env, &k[2]),
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
        Leaf::LiteralVec(elements) => vec_scval(
            &elements
                .iter()
                .map(|e| leaf_to_scval(env, e))
                .collect::<StdVec<_>>(),
        ),
    }
}

fn scval_of<T: IntoVal<Env, Val>>(env: &Env, v: T) -> ScVal {
    let v: Val = v.into_val(env);
    ScVal::from_xdr(env, &v.to_xdr(env)).expect("round-trip")
}

fn steps_scval(steps: &[PathStep]) -> StdVec<ScVal> {
    steps
        .iter()
        .map(|st| match st {
            PathStep::Index(i) => u32_scval(*i),
            PathStep::Len => ScVal::Bool(true),
            PathStep::Field(f) => ScVal::Symbol(soroban_sdk::xdr::ScSymbol(
                f.to_string().as_bytes().to_vec().try_into().unwrap(),
            )),
        })
        .collect()
}

fn call_arg(i: u32) -> Leaf {
    Leaf::CallPath(alloc::vec![PathStep::Index(i)])
}

fn call_arg_len(i: u32) -> Leaf {
    Leaf::CallPath(alloc::vec![PathStep::Index(i), PathStep::Len])
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
        left: call_arg(0),
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
        left: call_arg(0),
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
        left: call_arg(7),
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
        left: call_arg_len(0),
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
        left: call_arg_len(0),
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
        left: Leaf::CallPath(alloc::vec![
            PathStep::Index(0),
            PathStep::Index(0),
            PathStep::Field(Symbol::new(&env, "request_type")),
        ]),
        right: Leaf::LiteralU32(3),
    };
    assert!(permit(evaluate(&env, &n, &ctx)));
}

/// One call inside a batch, shaped the way the adapter hands it over:
/// `args[0]` is the vector of calls, each a map with an `args` vector.
fn batch_ctx(env: &Env, amounts: &[u32]) -> SorobanVec<Val> {
    let mut calls = SorobanVec::<Val>::new(env);
    for a in amounts {
        let mut inner = SorobanVec::<Val>::new(env);
        inner.push_back(1u32.into_val(env));
        inner.push_back(2u32.into_val(env));
        inner.push_back((*a).into_val(env));
        let mut m = soroban_sdk::Map::<Symbol, Val>::new(env);
        m.set(Symbol::new(env, "args"), inner.into_val(env));
        calls.push_back(m.into_val(env));
    }
    let mut args = SorobanVec::<Val>::new(env);
    args.push_back(calls.into_val(env));
    args
}

fn at(env: &Env, element: u32, index_in_args: u32) -> Leaf {
    Leaf::CallPath(alloc::vec![
        PathStep::Index(0),
        PathStep::Index(element),
        PathStep::Field(Symbol::new(env, "args")),
        PathStep::Index(index_in_args),
    ])
}

#[test]
fn sel_call_path_reaches_one_argument_of_one_call() {
    let env = Env::default();
    let mut ctx = empty_ctx(&env);
    ctx.args = batch_ctx(&env, &[7]);
    let n = Node::Compare {
        op: CompareOp::Eq,
        left: at(&env, 0, 2),
        right: Leaf::LiteralU32(7),
    };
    assert!(permit(evaluate(&env, &n, &ctx)));
}

/// The reason this leaf exists: a cross-call constraint the interpreter can
/// state directly, instead of comparing two indices into a flattened
/// projection the adapter had to build.
#[test]
fn sel_call_path_expresses_a_cross_call_equality() {
    let env = Env::default();
    let equal = Node::Compare {
        op: CompareOp::Eq,
        left: at(&env, 0, 2),
        right: at(&env, 1, 2),
    };

    let mut same = empty_ctx(&env);
    same.args = batch_ctx(&env, &[7, 7]);
    assert!(permit(evaluate(&env, &equal, &same)));

    let mut differ = empty_ctx(&env);
    differ.args = batch_ctx(&env, &[7, 6]);
    assert_eq!(
        reason(evaluate(&env, &equal, &differ)),
        Some(DenyReason::ArgMismatch)
    );
}

#[test]
fn sel_call_path_out_of_range_denies() {
    let env = Env::default();
    let mut ctx = empty_ctx(&env);
    ctx.args = batch_ctx(&env, &[7]);
    let n = Node::Compare {
        op: CompareOp::Eq,
        left: at(&env, 0, 9),
        right: Leaf::LiteralU32(7),
    };
    assert!(!permit(evaluate(&env, &n, &ctx)));
}

#[test]
fn sel_call_path_with_no_steps_is_malformed() {
    let env = Env::default();
    // Wrapped in a node: a bare leaf is malformed whatever its steps say, so
    // an unwrapped case would pass without testing the step rule at all.
    let bogus = bytes_from_scval(
        &env,
        vec_scval(&[sym("eq"), vec_scval(&[sym("call_path")]), u32_scval(1)]),
    );
    let err = decode(&env, &bogus).expect_err("a path with no steps must be refused");
    assert_eq!(err, crate::dsl::DecodeError::MalformedPredicate);
}

/// Blend's shape: `calls[n].args[3][0].amount`, five steps deep. This is the
/// depth `call_arg_field` could not reach, and the reason the adapter used to
/// flatten the request.
#[test]
fn sel_call_path_reaches_a_nested_request_amount() {
    let env = Env::default();
    let mut req = soroban_sdk::Map::<Symbol, Val>::new(&env);
    req.set(Symbol::new(&env, "amount"), 42i128.into_val(&env));
    let mut reqs = SorobanVec::<Val>::new(&env);
    reqs.push_back(req.into_val(&env));
    let mut inner = SorobanVec::<Val>::new(&env);
    inner.push_back(reqs.into_val(&env));
    let mut call = soroban_sdk::Map::<Symbol, Val>::new(&env);
    call.set(Symbol::new(&env, "args"), inner.into_val(&env));
    let mut calls = SorobanVec::<Val>::new(&env);
    calls.push_back(call.into_val(&env));
    let mut args = SorobanVec::<Val>::new(&env);
    args.push_back(calls.into_val(&env));
    let mut ctx = empty_ctx(&env);
    ctx.args = args;

    let n = Node::Compare {
        op: CompareOp::Eq,
        left: Leaf::CallPath(alloc::vec![
            PathStep::Index(0),
            PathStep::Index(0),
            PathStep::Field(Symbol::new(&env, "args")),
            PathStep::Index(0),
            PathStep::Index(0),
            PathStep::Field(Symbol::new(&env, "amount")),
        ]),
        right: Leaf::LiteralI128(42),
    };
    assert!(permit(evaluate(&env, &n, &ctx)));
}

/// The length step: what catches an element appended to a vector the
/// predicate otherwise pinned element by element.
#[test]
fn sel_call_path_len_reads_a_nested_vector_length() {
    let env = Env::default();
    let mut ctx = empty_ctx(&env);
    ctx.args = batch_ctx(&env, &[7, 7]);
    let len_of_calls = Leaf::CallPath(alloc::vec![PathStep::Index(0), PathStep::Len]);
    assert!(permit(evaluate(
        &env,
        &Node::Compare {
            op: CompareOp::Eq,
            left: len_of_calls.clone(),
            right: Leaf::LiteralU32(2),
        },
        &ctx
    )));
    assert_eq!(
        reason(evaluate(
            &env,
            &Node::Compare {
                op: CompareOp::Eq,
                left: len_of_calls,
                right: Leaf::LiteralU32(3),
            },
            &ctx
        )),
        Some(DenyReason::ArgMismatch)
    );
}

#[test]
fn sel_call_path_len_must_be_the_last_step() {
    let env = Env::default();
    let bogus = bytes_from_scval(
        &env,
        vec_scval(&[
            sym("eq"),
            vec_scval(&[sym("call_path"), ScVal::Bool(true), u32_scval(0)]),
            u32_scval(1),
        ]),
    );
    let err = decode(&env, &bogus).expect_err("a step after len must be refused");
    assert_eq!(err, crate::dsl::DecodeError::MalformedPredicate);
}

// ---- call_path, adversarially -----------------------------------------------
//
// The leaf walks a caller-supplied path into caller-supplied data. Every way
// that walk can go wrong must DENY, never panic and never read something it
// was not pointed at.

fn path_leaf(steps: alloc::vec::Vec<PathStep>) -> Leaf {
    Leaf::CallPath(steps)
}

fn denies_with(env: &Env, ctx: &EvalContext, left: Leaf) -> bool {
    !permit(evaluate(
        env,
        &Node::Compare {
            op: CompareOp::Eq,
            left,
            right: Leaf::LiteralU32(1),
        },
        ctx,
    ))
}

#[test]
fn call_path_wrong_step_kind_denies_rather_than_panics() {
    let env = Env::default();
    let mut ctx = empty_ctx(&env);
    ctx.args = batch_ctx(&env, &[7]);

    // A map key where a vector index belongs.
    assert!(denies_with(
        &env,
        &ctx,
        path_leaf(alloc::vec![PathStep::Field(Symbol::new(&env, "nope"))])
    ));
    // A vector index where a map key belongs.
    assert!(denies_with(
        &env,
        &ctx,
        path_leaf(alloc::vec![
            PathStep::Index(0),
            PathStep::Index(0),
            PathStep::Index(0)
        ])
    ));
    // A key that is not in the map.
    assert!(denies_with(
        &env,
        &ctx,
        path_leaf(alloc::vec![
            PathStep::Index(0),
            PathStep::Index(0),
            PathStep::Field(Symbol::new(&env, "absent"))
        ])
    ));
    // An index past the end.
    assert!(denies_with(
        &env,
        &ctx,
        path_leaf(alloc::vec![PathStep::Index(0), PathStep::Index(99)])
    ));
}

#[test]
fn call_path_len_on_a_non_vector_denies() {
    let env = Env::default();
    let mut ctx = empty_ctx(&env);
    ctx.args = batch_ctx(&env, &[7]);
    // `calls[0]` is a map, not a vector.
    assert!(denies_with(
        &env,
        &ctx,
        path_leaf(alloc::vec![
            PathStep::Index(0),
            PathStep::Index(0),
            PathStep::Len
        ])
    ));
}

/// A bare leaf is not a predicate - the root must be a node - so every decode
/// case below wraps the path in a comparison. Without that wrapper these
/// tests pass whatever the step count is, which is no test at all.
fn eq_node_with_path(steps: usize) -> ScVal {
    let mut items = alloc::vec![sym("call_path")];
    for _ in 0..steps {
        items.push(u32_scval(0));
    }
    vec_scval(&[sym("eq"), vec_scval(&items), u32_scval(1)])
}

#[test]
fn call_path_refuses_more_steps_than_the_cap() {
    let env = Env::default();
    let err = decode(
        &env,
        &bytes_from_scval(&env, eq_node_with_path((MAX_PATH_STEPS + 1) as usize)),
    )
    .expect_err("a path longer than the cap must be refused");
    assert_eq!(err, crate::dsl::DecodeError::MalformedPredicate);
}

#[test]
fn call_path_accepts_exactly_the_cap() {
    let env = Env::default();
    decode(
        &env,
        &bytes_from_scval(&env, eq_node_with_path(MAX_PATH_STEPS as usize)),
    )
    .expect("a path at exactly the cap must decode");
}

#[test]
fn call_path_step_of_an_unsupported_type_is_malformed() {
    let env = Env::default();
    let bogus = vec_scval(&[
        sym("eq"),
        vec_scval(&[sym("call_path"), u32_scval(0), i128_scval(3)]),
        u32_scval(1),
    ]);
    let err =
        decode(&env, &bytes_from_scval(&env, bogus)).expect_err("an i128 step must be refused");
    assert_eq!(err, crate::dsl::DecodeError::MalformedPredicate);
}

/// Documented, not desired. Resolving both operands is what makes a
/// cross-call equality expressible; the same change lets a predicate compare
/// a selector with ITSELF, which is true for every call and installs cleanly
/// because a selector is present. This test exists so the property is known
/// and pinned rather than discovered later.
#[test]
fn call_path_compared_with_itself_is_vacuously_true() {
    let env = Env::default();
    let mut ctx = empty_ctx(&env);
    ctx.args = batch_ctx(&env, &[7]);
    let same = path_leaf(alloc::vec![
        PathStep::Index(0),
        PathStep::Index(0),
        PathStep::Field(Symbol::new(&env, "args")),
        PathStep::Index(2),
    ]);
    let n = Node::Compare {
        op: CompareOp::Eq,
        left: same.clone(),
        right: same,
    };
    assert!(permit(evaluate(&env, &n, &ctx)));
    assert!(
        crate::dsl::has_selector_leaf(&n),
        "and install does not catch it"
    );
}

#[test]
fn fc_unknown_node_symbol_returns_malformed() {
    let env = Env::default();
    let bogus = bytes_from_scval(&env, vec_scval(&[sym("not_a_real_op"), u32_scval(0)]));
    let err = decode(&env, &bogus).expect_err("unknown op must deny");
    assert_eq!(err, crate::dsl::DecodeError::MalformedPredicate);
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
    let err = decode(&env, &bogus).expect_err("unknown selector must deny");
    assert_eq!(err, crate::dsl::DecodeError::MalformedPredicate);
}

#[test]
fn fc_wrong_arity_on_compare_returns_malformed() {
    // eq with only one argument (no left, no right) -> structurally MALFORMED.
    let env = Env::default();
    let bogus = bytes_from_scval(&env, vec_scval(&[sym("eq"), u32_scval(1)]));
    let err = decode(&env, &bogus).expect_err("2-arg compare must deny");
    assert_eq!(err, crate::dsl::DecodeError::MalformedPredicate);
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
    let err = decode(&env, &bogus).expect_err("i128 in call_arg slot must deny");
    assert_eq!(err, crate::dsl::DecodeError::MalformedPredicate);
}

#[test]
fn fc_in_empty_haystack_at_decode() {
    let env = Env::default();
    let bogus = bytes_from_scval(
        &env,
        vec_scval(&[sym("in"), i128_scval(1), empty_vec_scval()]),
    );
    let err = decode(&env, &bogus).expect_err("in [] must deny at decode");
    assert_eq!(err, crate::dsl::DecodeError::MalformedPredicate);
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
        decode(&env, &wrong_root).err(),
        Some(crate::dsl::DecodeError::MalformedPredicate)
    );
    // 2. An empty Vec root (zero-element wrapper) is also rejected: the wire
    //    must carry a head symbol, so a length-0 Vec can never be valid.
    let empty_root = bytes_from_scval(&env, empty_vec_scval());
    assert_eq!(
        decode(&env, &empty_root).err(),
        Some(crate::dsl::DecodeError::MalformedPredicate)
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
    let root = decode(&env, &bytes).expect("MAX_DEPTH must decode");
    assert!(matches!(root, Node::And(_)));
}

#[test]
fn cap_depth_over_limit_returns_predicate_too_deep() {
    let env = Env::default();
    let n = balanced_depth_n(&env, MAX_DEPTH as usize);
    let bytes = bytes_from_node(&env, &n);
    let err = decode(&env, &bytes).expect_err("depth > MAX_DEPTH must deny");
    assert_eq!(err, crate::dsl::DecodeError::PredicateTooDeep);
}

#[test]
fn cap_leaves_over_limit_returns_too_many_leaves() {
    let env = Env::default();
    // (MAX_LEAVES/2 + 1) child comparisons × 2 leaves per child > MAX_LEAVES.
    let n = wide_leaves_n(&env, (MAX_LEAVES as usize / 2) + 1);
    let bytes = bytes_from_node(&env, &n);
    let err = decode(&env, &bytes).expect_err("leaves > MAX_LEAVES must deny");
    assert_eq!(err, crate::dsl::DecodeError::TooManyLeaves);
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
    assert_eq!(err, crate::dsl::DecodeError::InOperandLimit);
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
    let err = decode(&env, &bytes).expect_err("over-byte predicate must deny");
    assert_eq!(err, crate::dsl::DecodeError::PredicateTooLarge);
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
    let err = decode(&env, &bytes).expect_err("`amount` must not decode");
    assert_eq!(err, crate::dsl::DecodeError::MalformedPredicate);
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
    let err = decode(&env, &bytes).expect_err("`window_spent` must not decode");
    assert_eq!(err, crate::dsl::DecodeError::MalformedPredicate);
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

// ----- Tests: v4 operators (or / lt / gt / gte) ------------------------------

#[test]
fn op_or_first_child_permit_short_circuits() {
    let env = Env::default();
    let n = Node::Or(StdVec::from([
        cmp_i128(CompareOp::Eq, 5, 5),   // permits
        cmp_i128(CompareOp::Eq, 1, 999), // would deny, never reached
    ]));
    assert!(permit(evaluate(&env, &n, &empty_ctx(&env))));
}

#[test]
fn op_or_last_child_permit_still_permits() {
    let env = Env::default();
    let n = Node::Or(StdVec::from([
        cmp_i128(CompareOp::Eq, 1, 999),
        cmp_i128(CompareOp::Eq, 2, 998),
        cmp_i128(CompareOp::Eq, 7, 7), // the only permit
    ]));
    assert!(permit(evaluate(&env, &n, &empty_ctx(&env))));
}

#[test]
fn op_or_all_deny_reports_the_first_childs_reason() {
    // The reported reason must come from the FIRST branch in wire order, not
    // the last one evaluated. Pinning it makes the deny code a stable
    // property of the predicate; letting it fall out of iteration order would
    // make the review card's reason depend on evaluation accident.
    let env = Env::default();
    let n = Node::Or(StdVec::from([
        Node::In {
            needle: Leaf::LiteralI128(9),
            haystack: StdVec::from([Leaf::LiteralI128(1)]),
        }, // NotInAllowlist
        cmp_i128(CompareOp::Lte, 10, 5), // ArgMismatch
    ]));
    assert_eq!(
        reason(evaluate(&env, &n, &empty_ctx(&env))),
        Some(DenyReason::NotInAllowlist)
    );
}

#[test]
fn op_or_nested_under_and_permits_when_one_branch_holds() {
    let env = Env::default();
    let n = Node::And(StdVec::from([
        cmp_i128(CompareOp::Eq, 1, 1),
        Node::Or(StdVec::from([
            cmp_i128(CompareOp::Eq, 2, 3),
            cmp_i128(CompareOp::Eq, 4, 4),
        ])),
    ]));
    assert!(permit(evaluate(&env, &n, &empty_ctx(&env))));
}

#[test]
fn op_lt_is_strict_at_the_bound() {
    let env = Env::default();
    assert!(permit(evaluate(
        &env,
        &cmp_i128(CompareOp::Lt, 9, 10),
        &empty_ctx(&env)
    )));
    assert_eq!(
        reason(evaluate(
            &env,
            &cmp_i128(CompareOp::Lt, 10, 10),
            &empty_ctx(&env)
        )),
        Some(DenyReason::ArgMismatch),
        "lt must DENY at the bound; permitting there would make it lte"
    );
}

#[test]
fn op_gt_is_strict_at_the_bound() {
    let env = Env::default();
    assert!(permit(evaluate(
        &env,
        &cmp_i128(CompareOp::Gt, 11, 10),
        &empty_ctx(&env)
    )));
    assert_eq!(
        reason(evaluate(
            &env,
            &cmp_i128(CompareOp::Gt, 10, 10),
            &empty_ctx(&env)
        )),
        Some(DenyReason::ArgMismatch)
    );
}

#[test]
fn op_gte_permits_at_the_bound() {
    let env = Env::default();
    assert!(permit(evaluate(
        &env,
        &cmp_i128(CompareOp::Gte, 10, 10),
        &empty_ctx(&env)
    )));
    assert_eq!(
        reason(evaluate(
            &env,
            &cmp_i128(CompareOp::Gte, 9, 10),
            &empty_ctx(&env)
        )),
        Some(DenyReason::ArgMismatch)
    );
}

#[test]
fn ordering_op_over_call_contract_is_unsupported() {
    // An identity has no ordering. This must stay distinct from a value that
    // merely failed to match, so a review card does not report a grammar
    // mistake as a policy violation.
    let env = Env::default();
    let ctx = empty_ctx(&env);
    for op in [CompareOp::Lt, CompareOp::Lte, CompareOp::Gt, CompareOp::Gte] {
        let n = Node::Compare {
            op,
            left: Leaf::CallContract,
            right: Leaf::LiteralAddress(ctx.contract.clone()),
        };
        assert_eq!(
            reason(evaluate(&env, &n, &ctx)),
            Some(DenyReason::UnsupportedNode),
            "ordering over call_contract must be UnsupportedNode"
        );
    }
}

// ----- Tests: scaled ---------------------------------------------------------

/// `args = [in, out]` as i128, the shape a swap policy bounds.
fn swap_ctx(env: &Env, input: i128, output: i128) -> EvalContext {
    let mut ctx = empty_ctx(env);
    let mut args = SorobanVec::<Val>::new(env);
    args.push_back(input.into_val(env));
    args.push_back(output.into_val(env));
    ctx.args = args;
    ctx
}

/// `scaled(src, num, den, add)`.
fn scaled(src: Leaf, num: Leaf, den: i128, add: Leaf) -> Leaf {
    Leaf::Scaled(alloc::boxed::Box::new([src, num, add]), den)
}

/// `scaled(call_arg(0), num, den, 0)` - the grammar-6 `call_arg_scaled`.
fn arg_scaled(num: i128, den: i128) -> Leaf {
    scaled(
        call_arg(0),
        Leaf::LiteralI128(num),
        den,
        Leaf::LiteralI128(0),
    )
}

fn compare(op: CompareOp, left: Leaf, right: Leaf) -> Node {
    Node::Compare { op, left, right }
}

/// The canonical floor: `call_arg(1) >= scaled(call_arg(0), num, den, 0)`.
fn floor_node(num: i128, den: i128) -> Node {
    compare(CompareOp::Gte, call_arg(1), arg_scaled(num, den))
}

#[test]
fn scaled_floor_permits_output_above_the_ratio() {
    let env = Env::default();
    // 99% floor: 1000 in -> needs >= 990 out. 995 clears it.
    let ctx = swap_ctx(&env, 1000, 995);
    assert!(permit(evaluate(&env, &floor_node(99, 100), &ctx)));
}

#[test]
fn scaled_floor_denies_output_below_the_ratio() {
    let env = Env::default();
    let ctx = swap_ctx(&env, 1000, 989);
    assert_eq!(
        reason(evaluate(&env, &floor_node(99, 100), &ctx)),
        Some(DenyReason::ArgMismatch),
        "a floor miss is an ordinary comparison miss now that scaled is a number"
    );
}

#[test]
fn scaled_floor_permits_exactly_at_the_ratio() {
    let env = Env::default();
    let ctx = swap_ctx(&env, 1000, 990);
    assert!(permit(evaluate(&env, &floor_node(99, 100), &ctx)));
}

#[test]
fn scaled_truncates_toward_zero() {
    let env = Env::default();
    // 1000 * 1 / 3 = 333.33 -> 333. An output of exactly 333 must clear a
    // >= floor; if the division rounded UP to 334 this would deny.
    let ctx = swap_ctx(&env, 1000, 333);
    assert!(permit(evaluate(&env, &floor_node(1, 3), &ctx)));
    // and toward zero, not toward minus infinity: -1000 / 3 = -333.
    let ctx = swap_ctx(&env, -1000, -333);
    assert!(permit(evaluate(&env, &floor_node(1, 3), &ctx)));
    let ctx = swap_ctx(&env, -1000, -334);
    assert!(!permit(evaluate(&env, &floor_node(1, 3), &ctx)));
}

#[test]
fn scaled_multiplies_before_it_divides() {
    // 7 * 3 / 2 = 10; dividing first would give 3 * 3 = 9.
    let env = Env::default();
    let n = compare(CompareOp::Eq, arg_scaled(3, 2), call_arg(1));
    assert!(permit(evaluate(&env, &n, &swap_ctx(&env, 7, 10))));
    assert!(!permit(evaluate(&env, &n, &swap_ctx(&env, 7, 9))));
}

#[test]
fn scaled_adds_after_the_division() {
    // 7 * 1 / 2 + 5 = 3 + 5 = 8.
    let env = Env::default();
    let s = scaled(call_arg(0), Leaf::LiteralI128(1), 2, Leaf::LiteralI128(5));
    let n = compare(CompareOp::Eq, s, call_arg(1));
    assert!(permit(evaluate(&env, &n, &swap_ctx(&env, 7, 8))));
}

#[test]
fn scaled_on_the_left_compares_in_written_order() {
    // `scaled(...) <= call_arg(1)` is the mirror of the canonical form and
    // must agree with it.
    let env = Env::default();
    let n = compare(CompareOp::Lte, arg_scaled(99, 100), call_arg(1));
    assert!(permit(evaluate(&env, &n, &swap_ctx(&env, 1000, 995))));
    assert_eq!(
        reason(evaluate(&env, &n, &swap_ctx(&env, 1000, 989))),
        Some(DenyReason::ArgMismatch)
    );
}

#[test]
fn scaled_versus_scaled_compares_two_numbers() {
    // Grammar 6 refused this. Both sides resolve to a plain number now.
    let env = Env::default();
    let n = compare(CompareOp::Gte, arg_scaled(1, 1), arg_scaled(1, 2));
    assert!(permit(evaluate(&env, &n, &swap_ctx(&env, 10, 10))));
    let n = compare(CompareOp::Lt, arg_scaled(1, 1), arg_scaled(1, 2));
    assert!(!permit(evaluate(&env, &n, &swap_ctx(&env, 10, 10))));
}

#[test]
fn scaled_operands_may_all_be_selectors() {
    // src, num and add are each any value leaf: here args[0] * args[1] / 1
    // + args[2] over three call arguments.
    let env = Env::default();
    let mut ctx = swap_ctx(&env, 6, 7);
    ctx.args.push_back(8i128.into_val(&env));
    let s = scaled(call_arg(0), call_arg(1), 1, call_arg(2));
    let n = compare(CompareOp::Eq, s, Leaf::LiteralI128(50));
    assert!(permit(evaluate(&env, &n, &ctx)));
}

#[test]
fn scaled_overflow_denies_rather_than_panicking() {
    let env = Env::default();
    // i128::MAX * 2 cannot fit; checked_mul must deny, not wrap or trap.
    let ctx = swap_ctx(&env, i128::MAX, 1);
    assert_eq!(
        reason(evaluate(&env, &floor_node(2, 1), &ctx)),
        Some(DenyReason::ArithmeticOverflow)
    );
}

#[test]
fn scaled_add_overflow_denies_rather_than_wrapping() {
    let env = Env::default();
    let s = scaled(call_arg(0), Leaf::LiteralI128(1), 1, Leaf::LiteralI128(1));
    let n = compare(CompareOp::Gte, call_arg(1), s);
    assert_eq!(
        reason(evaluate(&env, &n, &swap_ctx(&env, i128::MAX, 0))),
        Some(DenyReason::ArithmeticOverflow)
    );
}

#[test]
fn an_overflow_in_a_nested_scaled_reaches_the_top() {
    let env = Env::default();
    let inner = scaled(call_arg(0), Leaf::LiteralI128(2), 1, Leaf::LiteralI128(0));
    let outer = scaled(inner, Leaf::LiteralI128(1), 1, Leaf::LiteralI128(0));
    let n = compare(CompareOp::Gte, call_arg(1), outer);
    assert_eq!(
        reason(evaluate(&env, &n, &swap_ctx(&env, i128::MAX, 0))),
        Some(DenyReason::ArithmeticOverflow)
    );
}

#[test]
fn scaled_zero_denominator_denies_at_evaluate() {
    // Decode refuses this, so reaching the evaluator means the decode gate
    // regressed. It must still deny rather than divide by zero.
    let env = Env::default();
    let ctx = swap_ctx(&env, 1000, 995);
    assert_eq!(
        reason(evaluate(&env, &floor_node(99, 0), &ctx)),
        Some(DenyReason::ArithmeticOverflow)
    );
}

#[test]
fn scaled_division_overflow_denies_rather_than_wrapping() {
    // `i128::MIN / -1` is the only division that overflows i128. Decode refuses
    // a negative denominator; if that gate ever regresses, the evaluator must
    // still deny rather than wrap to a garbage bound.
    let env = Env::default();
    let ctx = swap_ctx(&env, i128::MIN, 0);
    assert_eq!(
        reason(evaluate(&env, &floor_node(1, -1), &ctx)),
        Some(DenyReason::ArithmeticOverflow)
    );
}

#[test]
fn scaled_index_out_of_bounds_is_arg_mismatch() {
    let env = Env::default();
    let s = scaled(call_arg(9), Leaf::LiteralI128(1), 1, Leaf::LiteralI128(0));
    let n = compare(CompareOp::Gte, call_arg(1), s);
    assert_eq!(
        reason(evaluate(&env, &n, &swap_ctx(&env, 10, 10))),
        Some(DenyReason::ArgMismatch)
    );
}

#[test]
fn scaled_non_numeric_source_is_arg_mismatch() {
    let env = Env::default();
    let mut ctx = empty_ctx(&env);
    let mut args = SorobanVec::<Val>::new(&env);
    args.push_back(contract(&env).into_val(&env)); // an address, not a number
    args.push_back(100i128.into_val(&env));
    ctx.args = args;
    assert_eq!(
        reason(evaluate(&env, &floor_node(1, 1), &ctx)),
        Some(DenyReason::ArgMismatch)
    );
}

#[test]
fn scaled_ordering_ops_keep_their_strictness_at_the_bound() {
    // 1000 * 99 / 100 = 990 exactly. Each operator must behave at the bound
    // the same way it does against a literal: a STRICT floor written as
    // `out > in * num/den` has to refuse an exactly-at-bound trade, and a
    // non-strict one has to allow it. Collapsing the two silently turns a
    // strict policy into a permissive one.
    let env = Env::default();
    let ctx = swap_ctx(&env, 1000, 990);
    let at_bound =
        |op: CompareOp| evaluate(&env, &compare(op, call_arg(1), arg_scaled(99, 100)), &ctx);
    assert!(permit(at_bound(CompareOp::Gte)), "gte permits at the bound");
    assert!(permit(at_bound(CompareOp::Lte)), "lte permits at the bound");
    assert!(permit(at_bound(CompareOp::Eq)), "eq permits at the bound");
    assert_eq!(
        reason(at_bound(CompareOp::Gt)),
        Some(DenyReason::ArgMismatch),
        "gt must DENY at the bound; permitting there silently weakens a strict floor"
    );
    assert_eq!(
        reason(at_bound(CompareOp::Lt)),
        Some(DenyReason::ArgMismatch),
        "lt must DENY at the bound"
    );
}

// ----- Tests: now ------------------------------------------------------------

#[test]
fn now_is_the_ledger_timestamp() {
    use soroban_sdk::testutils::Ledger as _;
    let env = Env::default();
    env.ledger().with_mut(|l| l.timestamp = 1_000);
    let ctx = empty_ctx(&env);
    // A clock is meant to be bounded, so these order it; `eq` compares numbers
    // by value too, so the u64 timestamp equals an i128 of the same value.
    let ge = compare(CompareOp::Gte, Leaf::Now, Leaf::LiteralI128(1_000));
    let gt = compare(CompareOp::Gt, Leaf::Now, Leaf::LiteralI128(1_000));
    let eq = compare(CompareOp::Eq, Leaf::Now, Leaf::LiteralI128(1_000));
    assert!(permit(evaluate(&env, &ge, &ctx)));
    assert!(permit(evaluate(&env, &eq, &ctx)));
    assert!(!permit(evaluate(&env, &gt, &ctx)));
    env.ledger().with_mut(|l| l.timestamp = 1_001);
    assert!(!permit(evaluate(&env, &eq, &ctx)));
    assert!(permit(evaluate(&env, &gt, &ctx)));
}

#[test]
fn now_composes_with_scaled() {
    use soroban_sdk::testutils::Ledger as _;
    let env = Env::default();
    env.ledger().with_mut(|l| l.timestamp = 1_000);
    // now - 300 <= call_arg(0)
    let window = scaled(Leaf::Now, Leaf::LiteralI128(1), 1, Leaf::LiteralI128(-300));
    let n = compare(CompareOp::Lte, window, call_arg(0));
    assert!(permit(evaluate(&env, &n, &swap_ctx(&env, 700, 0))));
    assert!(!permit(evaluate(&env, &n, &swap_ctx(&env, 699, 0))));
}

// ----- Tests: the selector gate under grammar 7 -------------------------------

fn dummy_read(env: &Env) -> Leaf {
    dummy_read_of(env, 0)
}

/// A read whose single `u32` argument is `n`: distinct `n`, distinct call.
fn dummy_read_of(env: &Env, n: u32) -> Leaf {
    Leaf::Read(
        contract(env),
        Symbol::new(env, "price"),
        soroban_sdk::vec![env, n.into_val(env)],
        StdVec::new(),
    )
}

#[test]
fn scaled_over_a_selector_counts_as_a_selector() {
    // It reads the call, so a predicate made only of it is still constrained.
    assert!(crate::dsl::has_selector_leaf(&floor_node(99, 100)));
}

#[test]
fn scaled_over_literals_does_not() {
    let lits = scaled(
        Leaf::LiteralI128(1),
        Leaf::LiteralI128(1),
        1,
        Leaf::LiteralI128(1),
    );
    assert!(!crate::dsl::has_selector_leaf(&compare(
        CompareOp::Gte,
        lits,
        Leaf::LiteralI128(0)
    )));
}

#[test]
fn read_and_now_do_not_count_as_selectors() {
    let env = Env::default();
    let reads = compare(CompareOp::Gte, dummy_read(&env), Leaf::Now);
    assert!(!crate::dsl::has_selector_leaf(&reads));
    let dressed = compare(
        CompareOp::Gte,
        scaled(dummy_read(&env), Leaf::Now, 1, Leaf::Now),
        Leaf::LiteralI128(0),
    );
    assert!(!crate::dsl::has_selector_leaf(&dressed));
    let both = Node::And(StdVec::from([reads, floor_node(1, 1)]));
    assert!(crate::dsl::has_selector_leaf(&both));
}

// ----- Tests: decode of the grammar-7 leaves -----------------------------------

#[test]
fn decode_refuses_a_non_positive_denominator() {
    let env = Env::default();
    for den in [0, -1, i128::MIN] {
        let err = decode(&env, &bytes_from_node(&env, &floor_node(99, den)))
            .expect_err("den <= 0 must not decode");
        assert_eq!(
            err,
            crate::dsl::DecodeError::MalformedPredicate,
            "den = {den}"
        );
    }
    // The denominator is refused wherever the leaf sits.
    let hidden = Node::Or(StdVec::from([
        cmp_i128(CompareOp::Eq, 1, 1),
        floor_node(1, 0),
    ]));
    assert!(decode(&env, &bytes_from_node(&env, &hidden)).is_err());
}

#[test]
fn decode_refuses_a_non_positive_literal_numerator() {
    let env = Env::default();
    for num in [0, -1, i128::MIN] {
        let err = decode(&env, &bytes_from_node(&env, &floor_node(num, 100)))
            .expect_err("a literal num <= 0 must not decode");
        assert_eq!(
            err,
            crate::dsl::DecodeError::MalformedPredicate,
            "num = {num}"
        );
    }
    // ... wherever the leaf sits, and as a u32 literal too.
    let hidden = Node::Or(StdVec::from([
        cmp_i128(CompareOp::Eq, 1, 1),
        floor_node(-1, 100),
    ]));
    assert!(decode(&env, &bytes_from_node(&env, &hidden)).is_err());
    let zero = scaled(call_arg(0), Leaf::LiteralU32(0), 1, Leaf::LiteralI128(0));
    let n = compare(CompareOp::Gte, call_arg(1), zero);
    assert!(decode(&env, &bytes_from_node(&env, &n)).is_err());
}

#[test]
fn decode_refuses_a_non_positive_literal_source() {
    // `src * num` commutes, so the constant written first is held to the same
    // rule as the one written second.
    let env = Env::default();
    let zero = Leaf::LiteralI128(0);
    let with_src = |src: Leaf| {
        let s = scaled(src, call_arg(0), 100, Leaf::LiteralI128(1));
        compare(CompareOp::Gte, call_arg(1), s)
    };
    for src in [0, -1, -99, i128::MIN] {
        let n = with_src(Leaf::LiteralI128(src));
        let err = decode(&env, &bytes_from_node(&env, &n))
            .expect_err("a literal src <= 0 must not decode");
        assert_eq!(
            err,
            crate::dsl::DecodeError::MalformedPredicate,
            "src = {src}"
        );
    }
    assert!(decode(&env, &bytes_from_node(&env, &with_src(Leaf::LiteralU32(0)))).is_err());
    let hidden = Node::Or(StdVec::from([
        cmp_i128(CompareOp::Eq, 1, 1),
        with_src(Leaf::LiteralI128(-1)),
    ]));
    assert!(decode(&env, &bytes_from_node(&env, &hidden)).is_err());
    // The selector-cancelling form: `scaled(0, arg, 1, 0) >= 0`.
    let vacuous = compare(
        CompareOp::Gte,
        scaled(zero.clone(), call_arg(0), 1, zero.clone()),
        zero,
    );
    assert!(decode(&env, &bytes_from_node(&env, &vacuous)).is_err());
    // A positive or variable source is fine.
    assert!(decode(
        &env,
        &bytes_from_node(&env, &with_src(Leaf::LiteralI128(1)))
    )
    .is_ok());
    assert!(decode(&env, &bytes_from_node(&env, &with_src(call_arg(1)))).is_ok());
}

#[test]
fn decode_accepts_a_positive_or_a_variable_numerator() {
    // A numerator that is read from the call cannot be judged at install, so
    // it is allowed; so is a negative literal `add`, which is how a
    // subtraction is written. (A rule using a variable `num` should guard it,
    // see the README.)
    let env = Env::default();
    assert!(decode(&env, &bytes_from_node(&env, &floor_node(1, 100))).is_ok());
    let variable = scaled(call_arg(0), call_arg(1), 1, Leaf::LiteralI128(-300));
    let n = compare(CompareOp::Gte, call_arg(1), variable);
    assert!(decode(&env, &bytes_from_node(&env, &n)).is_ok());
}

#[test]
fn decode_refuses_non_constant_entries_in_an_in_haystack() {
    // They would count toward the caps and satisfy the selector gate, and then
    // never be compared.
    let env = Env::default();
    for bad in [
        call_arg(0),
        Leaf::CallFn,
        Leaf::Now,
        dummy_read(&env),
        scaled(call_arg(0), Leaf::LiteralI128(1), 1, Leaf::LiteralI128(0)),
        Leaf::LiteralVec(StdVec::from([Leaf::CallFn])),
    ] {
        let n = Node::In {
            needle: call_arg(0),
            haystack: StdVec::from([Leaf::LiteralI128(1), bad]),
        };
        let err = decode(&env, &bytes_from_node(&env, &n)).expect_err("non-constant entry");
        assert_eq!(err, crate::dsl::DecodeError::MalformedPredicate);
    }
    let ok = Node::In {
        needle: call_arg(0),
        haystack: StdVec::from([
            Leaf::LiteralI128(1),
            Leaf::LiteralVec(StdVec::from([Leaf::LiteralU32(2)])),
        ]),
    };
    assert!(decode(&env, &bytes_from_node(&env, &ok)).is_ok());
}

#[test]
fn decode_refuses_non_constant_elements_in_a_literal_vec() {
    let env = Env::default();
    for bad in [call_arg(0), Leaf::Now, dummy_read(&env)] {
        let n = compare(
            CompareOp::Eq,
            call_arg(1),
            Leaf::LiteralVec(StdVec::from([Leaf::LiteralU32(1), bad])),
        );
        let err = decode(&env, &bytes_from_node(&env, &n)).expect_err("non-constant element");
        assert_eq!(err, crate::dsl::DecodeError::MalformedPredicate);
    }
    // nested one level down, too
    let inner = Leaf::LiteralVec(StdVec::from([Leaf::CallFn]));
    let n = compare(
        CompareOp::Eq,
        call_arg(1),
        Leaf::LiteralVec(StdVec::from([inner])),
    );
    assert!(decode(&env, &bytes_from_node(&env, &n)).is_err());
}

#[test]
fn decode_lowers_call_arg_leaves_to_paths() {
    // `call_arg`, `call_arg_len` and `call_arg_field` stay on the wire but are
    // decoded as the `call_path` they are shorthand for.
    let env = Env::default();
    let node = decode(
        &env,
        &bytes_from_scval(
            &env,
            vec_scval(&[
                sym("eq"),
                vec_scval(&[
                    sym("call_arg_field"),
                    u32_scval(1),
                    u32_scval(2),
                    sym("amount"),
                ]),
                u32_scval(5),
            ]),
        ),
    )
    .unwrap();
    let Node::Compare { left, .. } = node else {
        panic!("compare")
    };
    let Leaf::CallPath(steps) = left else {
        panic!("path")
    };
    assert_eq!(
        steps,
        StdVec::from([
            PathStep::Index(1),
            PathStep::Index(2),
            PathStep::Field(Symbol::new(&env, "amount"))
        ])
    );
}

fn read_wire(args: StdVec<ScVal>, path: StdVec<ScVal>) -> ScVal {
    let mut items = StdVec::from([sym("read"), addr_scval(), sym("price"), vec_scval(&args)]);
    items.extend(path);
    vec_scval(&[sym("gte"), vec_scval(&items), i128_scval(0)])
}

#[test]
fn wire_read_round_trips_and_may_have_an_empty_path() {
    let env = Env::default();
    let with_path = read_wire(StdVec::from([sym("POT")]), StdVec::from([sym("price")]));
    let Node::Compare { left, .. } = decode(&env, &bytes_from_scval(&env, with_path)).unwrap()
    else {
        panic!("compare")
    };
    let Leaf::Read(_, func, args, path) = left else {
        panic!("read")
    };
    assert_eq!(func, Symbol::new(&env, "price"));
    assert_eq!(args.len(), 1);
    assert_eq!(path.len(), 1);
    // no arguments, no path: the result is the value itself.
    let bare = read_wire(StdVec::new(), StdVec::new());
    assert!(decode(&env, &bytes_from_scval(&env, bare)).is_ok());
}

#[test]
fn wire_read_with_fewer_than_four_items_is_malformed() {
    let env = Env::default();
    let short = vec_scval(&[
        sym("gte"),
        vec_scval(&[sym("read"), addr_scval(), sym("price")]),
        i128_scval(0),
    ]);
    let err = decode(&env, &bytes_from_scval(&env, short)).expect_err("arity");
    assert_eq!(err, crate::dsl::DecodeError::MalformedPredicate);
}

#[test]
fn wire_read_refuses_non_literal_arguments() {
    let env = Env::default();
    let inner = vec_scval(&[sym("call_arg"), u32_scval(0)]);
    for bad in [
        inner,
        vec_scval(&[sym("now")]),
        vec_scval(&[sym("call_contract")]),
    ] {
        let wire = read_wire(StdVec::from([bad]), StdVec::new());
        let err = decode(&env, &bytes_from_scval(&env, wire)).expect_err("literal only");
        assert_eq!(err, crate::dsl::DecodeError::MalformedPredicate);
    }
}

#[test]
fn wire_read_must_not_take_an_address_or_symbol_from_the_call() {
    let env = Env::default();
    let wire = vec_scval(&[
        sym("gte"),
        vec_scval(&[
            sym("read"),
            vec_scval(&[sym("call_arg"), u32_scval(0)]),
            sym("price"),
            vec_scval(&[]),
        ]),
        i128_scval(0),
    ]);
    assert!(decode(&env, &bytes_from_scval(&env, wire)).is_err());
}

#[test]
fn wire_read_path_is_capped() {
    let env = Env::default();
    let steps = |n: usize| (0..n).map(|_| u32_scval(0)).collect::<StdVec<_>>();
    let ok = read_wire(StdVec::new(), steps(MAX_PATH_STEPS as usize));
    assert!(decode(&env, &bytes_from_scval(&env, ok)).is_ok());
    let long = read_wire(StdVec::new(), steps(MAX_PATH_STEPS as usize + 1));
    assert!(decode(&env, &bytes_from_scval(&env, long)).is_err());
}

#[test]
fn wire_read_count_is_capped_at_four() {
    let env = Env::default();
    let read_node = |n: usize| {
        Node::And(
            (0..n as u32)
                .map(|i| compare(CompareOp::Gte, dummy_read_of(&env, i), Leaf::LiteralI128(0)))
                .collect(),
        )
    };
    assert!(decode(&env, &bytes_from_node(&env, &read_node(MAX_READS as usize))).is_ok());
    let err = decode(
        &env,
        &bytes_from_node(&env, &read_node(MAX_READS as usize + 1)),
    )
    .expect_err("a fifth distinct read");
    assert_eq!(err, crate::dsl::DecodeError::TooManyLeaves);
    // Identical reads are one call: any number of them decode.
    let one = dummy_read(&env);
    let same = Node::And(
        (0..2 * MAX_READS)
            .map(|_| compare(CompareOp::Gte, one.clone(), Leaf::LiteralI128(0)))
            .collect(),
    );
    assert!(decode(&env, &bytes_from_node(&env, &same)).is_ok());
}

#[test]
fn wire_scaled_leaf_nesting_is_capped_at_max_depth() {
    let env = Env::default();
    let nest = |n: u32| {
        let mut leaf = Leaf::LiteralI128(1);
        for _ in 0..n {
            leaf = scaled(leaf, Leaf::LiteralI128(1), 1, Leaf::LiteralI128(0));
        }
        compare(CompareOp::Gte, call_arg(0), leaf)
    };
    assert!(decode(&env, &bytes_from_node(&env, &nest(MAX_DEPTH - 1))).is_ok());
    let err = decode(&env, &bytes_from_node(&env, &nest(MAX_DEPTH))).expect_err("too deep");
    assert_eq!(err, crate::dsl::DecodeError::PredicateTooDeep);
}

#[test]
fn wire_scaled_leaves_count_toward_the_leaf_cap() {
    // Each compare is five leaves (`call_arg`, a `scaled` and its three
    // operands), so forty are exactly 200 and one more compare tips the
    // predicate over MAX_LEAVES.
    let env = Env::default();
    let one = || {
        scaled(
            Leaf::LiteralI128(1),
            Leaf::LiteralI128(1),
            1,
            Leaf::LiteralI128(1),
        )
    };
    let n = |count: usize| {
        Node::And(
            (0..count)
                .map(|_| compare(CompareOp::Gte, call_arg(0), one()))
                .collect(),
        )
    };
    // each compare is 1 (call_arg) + 4 = 5 leaves
    assert!(decode(&env, &bytes_from_node(&env, &n(40))).is_ok());
    let err = decode(&env, &bytes_from_node(&env, &n(41))).expect_err("over the leaf cap");
    assert_eq!(err, crate::dsl::DecodeError::TooManyLeaves);
}

// ----- Tests: v4 wire round-trips --------------------------------------------

#[test]
fn wire_or_round_trips() {
    let env = Env::default();
    let n = Node::Or(StdVec::from([
        cmp_i128(CompareOp::Eq, 1, 1),
        cmp_i128(CompareOp::Gt, 3, 2),
    ]));
    let decoded = decode(&env, &bytes_from_node(&env, &n)).expect("or must decode");
    assert!(matches!(decoded, Node::Or(ref c) if c.len() == 2));
    assert!(permit(evaluate(&env, &decoded, &empty_ctx(&env))));
}

#[test]
fn wire_ordering_ops_round_trip() {
    let env = Env::default();
    for (op, l, r) in [
        (CompareOp::Lt, 1i128, 2i128),
        (CompareOp::Lte, 2, 2),
        (CompareOp::Gt, 3, 2),
        (CompareOp::Gte, 2, 2),
    ] {
        let n = cmp_i128(op, l, r);
        let decoded = decode(&env, &bytes_from_node(&env, &n)).expect("op must decode");
        assert!(
            permit(evaluate(&env, &decoded, &empty_ctx(&env))),
            "{} must permit after a wire round-trip",
            op_name(op)
        );
    }
}

#[test]
fn wire_scaled_round_trips() {
    let env = Env::default();
    let n = floor_node(99, 100);
    let decoded = decode(&env, &bytes_from_node(&env, &n)).expect("scaled leaf must decode");
    assert!(permit(evaluate(&env, &decoded, &swap_ctx(&env, 1000, 995))));
    assert_eq!(
        reason(evaluate(&env, &decoded, &swap_ctx(&env, 1000, 900))),
        Some(DenyReason::ArgMismatch)
    );
}

#[test]
fn wire_empty_or_is_malformed() {
    // An empty `or` would deny regardless of the call; refuse it at the
    // boundary rather than store a rule that can never permit.
    let env = Env::default();
    let n = Node::Or(StdVec::new());
    let err = decode(&env, &bytes_from_node(&env, &n)).expect_err("empty or must deny");
    assert_eq!(err, crate::dsl::DecodeError::MalformedPredicate);
}

#[test]
fn wire_scaled_wrong_arity_is_malformed() {
    let env = Env::default();
    // Four items where the leaf needs five: (sym, src, num, den) with no add.
    let leaf = vec_scval(&[
        sym("scaled"),
        leaf_to_scval(&env, &call_arg(0)),
        i128_scval(99),
        i128_scval(100),
    ]);
    let node = vec_scval(&[sym("gte"), leaf_to_scval(&env, &call_arg(1)), leaf]);
    let err = decode(&env, &bytes_from_scval(&env, node)).expect_err("arity must be checked");
    assert_eq!(err, crate::dsl::DecodeError::MalformedPredicate);
}

#[test]
fn wire_scaled_rejects_u32_in_the_denominator_slot() {
    // The decoder is the single place that pins operand TYPE. A u32 in the
    // den slot must not be silently widened into an i128 constant.
    let env = Env::default();
    let leaf = vec_scval(&[
        sym("scaled"),
        leaf_to_scval(&env, &call_arg(0)),
        i128_scval(99),
        u32_scval(100),
        i128_scval(0),
    ]);
    let node = vec_scval(&[sym("gte"), leaf_to_scval(&env, &call_arg(1)), leaf]);
    let err = decode(&env, &bytes_from_scval(&env, node)).expect_err("den must be an i128");
    assert_eq!(err, crate::dsl::DecodeError::MalformedPredicate);
}

#[test]
fn wire_grammar_6_call_arg_scaled_is_refused() {
    let env = Env::default();
    let leaf = vec_scval(&[
        sym("call_arg_scaled"),
        u32_scval(0),
        i128_scval(99),
        i128_scval(100),
    ]);
    let node = vec_scval(&[sym("gte"), leaf_to_scval(&env, &call_arg(1)), leaf]);
    let err = decode(&env, &bytes_from_scval(&env, node)).expect_err("retired leaf");
    assert_eq!(err, crate::dsl::DecodeError::MalformedPredicate);
}

#[test]
fn wire_or_counts_toward_the_depth_cap() {
    // `or` nests like `and`, so it must be walked by the same cap logic.
    let env = Env::default();
    let mut n = cmp_i128(CompareOp::Eq, 1, 1);
    for _ in 0..MAX_DEPTH {
        n = Node::Or(StdVec::from([n]));
    }
    let err = decode(&env, &bytes_from_node(&env, &n)).expect_err("deep or must deny");
    assert_eq!(err, crate::dsl::DecodeError::PredicateTooDeep);
}

#[test]
fn op_or_with_no_children_denies_when_evaluated_directly() {
    // Unreachable through decode, which refuses an empty `or`, but `evaluate`
    // is a public entry point. The fallback has to be a DENY: permitting
    // would make a malformed predicate look like an allowed call.
    let env = Env::default();
    let n = Node::Or(StdVec::new());
    assert_eq!(
        reason(evaluate(&env, &n, &empty_ctx(&env))),
        Some(DenyReason::UnsupportedNode)
    );
}
