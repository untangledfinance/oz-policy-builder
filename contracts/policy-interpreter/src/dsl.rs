//! Predicate DSL decoder and pure evaluator.
//!
//! The decoder ingests raw canonical ScVal XDR bytes via `Val::from_xdr`
//! (the host does the XDR parse), then walks the resulting `Vec<Val>` tree
//! with native soroban-sdk types. The AST holds host types so the
//! evaluator can compare `Address`/`Symbol`/`Bytes` directly without
//! byte-extraction helpers.

extern crate alloc;

use alloc::boxed::Box;
use alloc::vec::Vec;

use soroban_sdk::xdr::ToXdr;
use soroban_sdk::{Address, Bytes, Env, IntoVal, Symbol, TryFromVal, Val, Vec as SorobanVec};

pub use dsl_decode::{decode, decode_with_byte_cap};

// ---- caps (mirrors TS PREDICATE_CAPS; the Rust side is authoritative) -----

pub const MAX_DEPTH: u32 = 5;
pub const MAX_LEAVES: u32 = 200;
pub const MAX_IN_OPERAND_COUNT: u32 = 32;
pub const MAX_PREDICATE_BYTES: u32 = 32 * 1024;

// Tag / selector name bytes. These come from the encoder verbatim (see
// `policy-synth/src/predicate/encode.ts`); an unknown tag is fail-closed at
// decode time.
const OP_AND: &[u8] = b"and";
const OP_OR: &[u8] = b"or";
const OP_NOT: &[u8] = b"not";
const OP_EQ: &[u8] = b"eq";
const OP_LT: &[u8] = b"lt";
const OP_LTE: &[u8] = b"lte";
const OP_GT: &[u8] = b"gt";
const OP_GTE: &[u8] = b"gte";
const OP_IN: &[u8] = b"in";

const SEL_CALL_CONTRACT: &[u8] = b"call_contract";
const SEL_CALL_FN: &[u8] = b"call_fn";
const SEL_CALL_ARG: &[u8] = b"call_arg";
const SEL_CALL_ARG_LEN: &[u8] = b"call_arg_len";
const SEL_CALL_ARG_FIELD: &[u8] = b"call_arg_field";
const SEL_NOW: &[u8] = b"now";

// Stateful selectors.
//
// `amount` and `window_spent` are deliberately NOT part of the grammar: the
// on-chain interpreter sees one authorized call, not the transaction's token
// movements, so it has no per-call amount to read and no way to accumulate
// one. Both symbols now fall through to the unknown-selector branch and are
// refused at install as MALFORMED_PREDICATE. Rolling spend caps belong to the
// OZ `spending_limit` primitive; a per-call cap is `call_arg_field`.

// ---- AST ----

/// One predicate node. Owned (children inside `Vec`) so the AST can be moved
/// without lifetime entanglement. Size is bounded by `MAX_DEPTH` and
/// `MAX_LEAVES`.
#[derive(Debug, Clone)]
pub enum Node {
    And(Vec<Node>),
    Or(Vec<Node>),
    Not(Box<Node>),
    Compare {
        op: CompareOp,
        left: Leaf,
        right: Leaf,
    },
    In {
        needle: Leaf,
        haystack: Vec<Leaf>,
    },
}

#[derive(Debug, PartialEq, Eq, Copy, Clone)]
pub enum CompareOp {
    Eq,
    Lt,
    Lte,
    Gt,
    Gte,
}

/// One literal or selector leaf. Host types are stored directly so the
/// evaluator can compare without re-encoding.
#[derive(Debug, Clone)]
pub enum Leaf {
    CallContract,
    CallFn,
    CallArg(u32),
    CallArgLen(u32),
    CallArgField {
        index: u32,
        element: u32,
        field: Symbol,
    },
    Now,
    LiteralAddress(Address),
    LiteralI128(i128),
    LiteralSymbol(Symbol),
    LiteralU32(u32),
    LiteralU64(u64),
    LiteralBytes(Bytes),
    LiteralVec(Vec<Leaf>),
}

// ---- EvalContext ----

#[derive(Debug, Clone)]
pub struct EvalContext {
    pub contract: Address,
    pub fn_name: Symbol,
    pub args: SorobanVec<Val>,
    pub at_ledger: u32,
    pub now_seconds: u64,
}

#[derive(Debug, PartialEq, Eq, Clone)]
pub enum EvalDecision {
    Permit,
    Deny(DenyReason),
}

#[derive(Debug, PartialEq, Eq, Copy, Clone)]
pub enum DenyReason {
    ArgMismatch,
    ContractScope,
    ArithmeticOverflow,
    UnsupportedNode,
    /// Stateful leaf denies (amount over limit, window over limit, etc.).
    StatefulBound,
    /// `in` membership failed. Distinct from ArgMismatch so a review card can
    /// say "not on the allowlist" rather than "argument mismatch"; the
    /// reference evaluator draws the same distinction.
    NotInAllowlist,
}

impl DenyReason {
    /// `UnsupportedNode` is fatal: a node the interpreter never supported
    /// must not be satisfiable by negating it. Every other variant is a
    /// ordinary deny reason - a sibling `or` may carry it, and `not` may
    /// invert it.
    pub const fn is_fatal(&self) -> bool {
        matches!(self, DenyReason::UnsupportedNode)
    }
}

impl DenyReason {
    pub const fn code(&self) -> &'static str {
        match self {
            DenyReason::ArgMismatch => "ARG_MISMATCH",
            DenyReason::ContractScope => "CONTRACT_SCOPE",
            DenyReason::ArithmeticOverflow => "ARITHMETIC_OVERFLOW",
            DenyReason::UnsupportedNode => "UNSUPPORTED_NODE",
            DenyReason::StatefulBound => "STATEFUL_BOUND",
            DenyReason::NotInAllowlist => "NOT_IN_ALLOWLIST",
        }
    }
}

// ---- Pure evaluator ----

pub fn evaluate(env: &Env, node: &Node, ctx: &EvalContext) -> EvalDecision {
    match node {
        Node::And(children) => {
            for c in children {
                match evaluate(env, c, ctx) {
                    EvalDecision::Permit => continue,
                    d @ EvalDecision::Deny(_) => return d,
                }
            }
            EvalDecision::Permit
        }
        Node::Or(children) => {
            // When every child denies, the surfaced reason is the LAST child's,
            // matching the reference evaluator. A childless `or` can never be
            // satisfied, so it fails closed as an empty allowlist.
            let mut last_deny: Option<EvalDecision> = None;
            for c in children {
                match evaluate(env, c, ctx) {
                    EvalDecision::Permit => return EvalDecision::Permit,
                    // A fatal denial (unsupported node) aborts the whole
                    // predicate: the policy cannot satisfy itself by
                    // permitting a sibling around a node the interpreter
                    // could not evaluate.
                    EvalDecision::Deny(r) if r.is_fatal() => {
                        return EvalDecision::Deny(r);
                    }
                    d @ EvalDecision::Deny(_) => last_deny = Some(d),
                }
            }
            last_deny.unwrap_or(EvalDecision::Deny(DenyReason::NotInAllowlist))
        }
        Node::Not(inner) => match evaluate(env, inner, ctx) {
            EvalDecision::Permit => EvalDecision::Deny(DenyReason::ArgMismatch),
            // A fatal denial (unsupported node) is NOT inverted - the policy
            // cannot satisfy itself by negating a node the interpreter
            // could not evaluate.
            EvalDecision::Deny(r) if r.is_fatal() => EvalDecision::Deny(r),
            EvalDecision::Deny(_) => EvalDecision::Permit,
        },
        Node::Compare { op, left, right } => eval_compare(env, *op, left, right, ctx),
        Node::In { needle, haystack } => {
            if haystack.is_empty() {
                return EvalDecision::Deny(DenyReason::NotInAllowlist);
            }
            // The needle can be either a literal (a haystack of literals) or
            // a selector leaf (e.g. call_arg[i]). Resolve via the live
            // context first; fall back to literal_to_val for pure-literal
            // needles. Both paths feed the same Val equality (host shallow_eq).
            let expected =
                resolve_selector(env, needle, ctx).or_else(|| literal_to_val(env, needle));
            // An opaque or undecodable needle fails closed as a membership
            // miss, not an argument mismatch: it cannot be on the allowlist
            // because it cannot be compared at all. The reference draws the
            // same line.
            let Some(expected) = expected else {
                return EvalDecision::Deny(DenyReason::NotInAllowlist);
            };
            for h in haystack {
                if let Some(actual) = literal_to_val(env, h) {
                    if val_eq(env, &expected, &actual) {
                        return EvalDecision::Permit;
                    }
                }
            }
            EvalDecision::Deny(DenyReason::NotInAllowlist)
        }
    }
}

/// Convert a literal leaf to its `Val` form for equality comparisons.
fn literal_to_val(env: &Env, leaf: &Leaf) -> Option<Val> {
    let v: Val = match leaf {
        Leaf::LiteralAddress(a) => a.clone().into_val(env),
        Leaf::LiteralI128(v) => (*v).into_val(env),
        Leaf::LiteralSymbol(s) => s.clone().into_val(env),
        Leaf::LiteralU32(v) => (*v).into_val(env),
        Leaf::LiteralU64(v) => (*v).into_val(env),
        Leaf::LiteralBytes(b) => b.clone().into_val(env),
        Leaf::LiteralVec(elements) => {
            let mut vals: SorobanVec<Val> = SorobanVec::new(env);
            for e in elements {
                vals.push_back(literal_to_val(env, e)?);
            }
            vals.into_val(env)
        }
        _ => return None,
    };
    Some(v)
}

/// Partial value equality. Host types compare directly via `==`; `Val`
/// equality is shallow (handles nested objects via host).
/// Compare two `Val`s BY VALUE.
///
/// `shallow_eq` compares the Val's immediate 64-bit payload. That is correct
/// for values carried inline (u32, u64, short symbols) but wrong for anything
/// the host holds as an object - Address, Bytes, longer Symbols, Vec, Map are
/// handles, so two handles to identical content compare unequal. Pinning an
/// address is exactly that case, so a shallow compare silently denied every
/// address-scoped constraint. It failed closed, which is why only a permit
/// case exposed it: the deny-case tests passed for the wrong reason.
///
/// Falling back to canonical XDR gives structural equality: two values are
/// equal precisely when they serialise identically. The host does the
/// serialising, so this works on wasm, and `Bytes` compares by value.
fn val_eq(env: &Env, a: &Val, b: &Val) -> bool {
    if a.shallow_eq(b) {
        return true;
    }
    if a.is_object() || b.is_object() {
        return (*a).to_xdr(env) == (*b).to_xdr(env);
    }
    false
}

fn eval_compare(
    env: &Env,
    op: CompareOp,
    left: &Leaf,
    right: &Leaf,
    ctx: &EvalContext,
) -> EvalDecision {
    match (left, op, right) {
        // call_contract: eq vs literal_address.
        (Leaf::CallContract, CompareOp::Eq, Leaf::LiteralAddress(expected)) => {
            if ctx.contract == *expected {
                EvalDecision::Permit
            } else {
                EvalDecision::Deny(DenyReason::ContractScope)
            }
        }
        (Leaf::CallContract, CompareOp::Eq, _) => EvalDecision::Deny(DenyReason::ContractScope),
        (Leaf::CallContract, _, _) => EvalDecision::Deny(DenyReason::UnsupportedNode),

        // call_fn: eq vs literal_symbol.
        (Leaf::CallFn, CompareOp::Eq, Leaf::LiteralSymbol(expected)) => {
            if ctx.fn_name == *expected {
                EvalDecision::Permit
            } else {
                EvalDecision::Deny(DenyReason::ArgMismatch)
            }
        }
        (Leaf::CallFn, CompareOp::Eq, _) => EvalDecision::Deny(DenyReason::ArgMismatch),
        (Leaf::CallFn, _, _) => EvalDecision::Deny(DenyReason::UnsupportedNode),

        (Leaf::CallArg(i), _, _) => eval_arg_compare(env, *i, op, right, ctx),
        (Leaf::CallArgLen(i), _, _) => eval_arg_len_compare(env, *i, op, right, ctx),
        (
            Leaf::CallArgField {
                index,
                element,
                field,
            },
            _,
            _,
        ) => eval_arg_field_compare(env, *index, *element, field, op, right, ctx),
        (Leaf::Now, _, _) => eval_numeric_compare(env, op, left, right, ctx),

        // Generic leaf-vs-leaf: resolve to a Val and compare.
        _ => {
            let actual = match resolve_selector(env, left, ctx) {
                Some(v) => v,
                None => return EvalDecision::Deny(DenyReason::ArgMismatch),
            };
            let is_vec_literal = matches!(right, Leaf::LiteralVec(_));
            if is_vec_literal && op != CompareOp::Eq {
                return EvalDecision::Deny(DenyReason::ArgMismatch);
            }
            if op == CompareOp::Eq {
                let expected = match literal_to_val(env, right) {
                    Some(v) => v,
                    None => return EvalDecision::Deny(DenyReason::ArgMismatch),
                };
                if val_eq(env, &actual, &expected) {
                    EvalDecision::Permit
                } else {
                    EvalDecision::Deny(DenyReason::ArgMismatch)
                }
            } else {
                eval_numeric_compare(env, op, left, right, ctx)
            }
        }
    }
}

/// Resolve a selector leaf to its current `Val` against the live context.
fn resolve_selector(env: &Env, leaf: &Leaf, ctx: &EvalContext) -> Option<Val> {
    match leaf {
        Leaf::CallContract => Some(ctx.contract.clone().into_val(env)),
        Leaf::CallFn => Some(ctx.fn_name.clone().into_val(env)),
        Leaf::CallArg(i) => ctx.args.get(*i),
        Leaf::CallArgLen(_) | Leaf::CallArgField { .. } => None,
        Leaf::Now => Some(ctx.at_ledger.into_val(env)),
        // Literal leaves resolve through `literal_to_val`.
        _ => literal_to_val(env, leaf),
    }
}

// ---- Stateful leaf evaluators ----

/// True when the predicate constrains at least one property of the call
/// being authorised, rather than comparing literals to literals.
///
/// A predicate with no selector leaf - literals on both sides of every
/// compare, no `call_contract`/`call_fn`/`call_arg`/`now` - is trivially
/// true or trivially false at install time, so it permits everything or
/// nothing forever. `install` refuses such a predicate so a no-constraint
/// policy cannot install under any name.
///
/// Recurses into `LiteralVec`: a selector wrapped in a literal vector is
/// still a selector.
pub fn has_selector_leaf(root: &Node) -> bool {
    fn selects(leaf: &Leaf) -> bool {
        match leaf {
            Leaf::LiteralAddress(_)
            | Leaf::LiteralI128(_)
            | Leaf::LiteralSymbol(_)
            | Leaf::LiteralU32(_)
            | Leaf::LiteralU64(_)
            | Leaf::LiteralBytes(_) => false,
            Leaf::LiteralVec(elements) => elements.iter().any(selects),
            // Every remaining variant reads something from the call under
            // evaluation, so it constrains the policy.
            _ => true,
        }
    }
    match root {
        Node::And(children) | Node::Or(children) => children.iter().any(has_selector_leaf),
        Node::Not(inner) => has_selector_leaf(inner),
        Node::Compare { left, right, .. } => selects(left) || selects(right),
        Node::In { needle, haystack } => selects(needle) || haystack.iter().any(selects),
    }
}

fn eval_arg_compare(
    env: &Env,
    idx: u32,
    op: CompareOp,
    right: &Leaf,
    ctx: &EvalContext,
) -> EvalDecision {
    let actual = match ctx.args.get(idx) {
        Some(v) => v,
        None => return EvalDecision::Deny(DenyReason::ArgMismatch),
    };
    match op {
        CompareOp::Eq => match literal_to_val(env, right) {
            Some(expected) => {
                if val_eq(env, &actual, &expected) {
                    EvalDecision::Permit
                } else {
                    EvalDecision::Deny(DenyReason::ArgMismatch)
                }
            }
            None => EvalDecision::Deny(DenyReason::ArgMismatch),
        },
        _ => eval_numeric_compare(env, op, &Leaf::CallArg(idx), right, ctx),
    }
}

fn eval_arg_len_compare(
    env: &Env,
    idx: u32,
    op: CompareOp,
    right: &Leaf,
    ctx: &EvalContext,
) -> EvalDecision {
    let actual = match ctx.args.get(idx) {
        Some(v) => v,
        None => return EvalDecision::Deny(DenyReason::ArgMismatch),
    };
    let actual_len: u32 = match SorobanVec::<Val>::try_from_val(env, &actual) {
        Ok(v) => v.len(),
        Err(_) => return EvalDecision::Deny(DenyReason::ArgMismatch),
    };
    let expected_len: u32 = match right {
        Leaf::LiteralU32(v) => *v,
        _ => return EvalDecision::Deny(DenyReason::ArgMismatch),
    };
    compare_u32(op, actual_len, expected_len)
}

fn eval_arg_field_compare(
    env: &Env,
    idx: u32,
    element: u32,
    field: &Symbol,
    op: CompareOp,
    right: &Leaf,
    ctx: &EvalContext,
) -> EvalDecision {
    let actual = match ctx.args.get(idx) {
        Some(v) => v,
        None => return EvalDecision::Deny(DenyReason::ArgMismatch),
    };
    let outer = match SorobanVec::<Val>::try_from_val(env, &actual) {
        Ok(v) => v,
        Err(_) => return EvalDecision::Deny(DenyReason::ArgMismatch),
    };
    let elem = match outer.get(element) {
        Some(v) => v,
        None => return EvalDecision::Deny(DenyReason::ArgMismatch),
    };
    let map = match soroban_sdk::Map::<Symbol, Val>::try_from_val(env, &elem) {
        Ok(m) => m,
        Err(_) => return EvalDecision::Deny(DenyReason::ArgMismatch),
    };
    let field_val = match map.get(field.clone()) {
        Some(v) => v,
        None => return EvalDecision::Deny(DenyReason::ArgMismatch),
    };
    match op {
        CompareOp::Eq => match literal_to_val(env, right) {
            Some(expected) => {
                if val_eq(env, &field_val, &expected) {
                    EvalDecision::Permit
                } else {
                    EvalDecision::Deny(DenyReason::ArgMismatch)
                }
            }
            None => EvalDecision::Deny(DenyReason::ArgMismatch),
        },
        _ => {
            let actual_int = val_to_i128(env, &field_val);
            let right_int = literal_i128(right);
            match (actual_int, right_int) {
                (Some(a), Some(b)) => {
                    let pass = match op {
                        CompareOp::Eq => a == b,
                        CompareOp::Lt => a < b,
                        CompareOp::Lte => a <= b,
                        CompareOp::Gt => a > b,
                        CompareOp::Gte => a >= b,
                    };
                    if pass {
                        EvalDecision::Permit
                    } else {
                        EvalDecision::Deny(DenyReason::ArgMismatch)
                    }
                }
                _ => EvalDecision::Deny(DenyReason::ArgMismatch),
            }
        }
    }
}

fn val_to_i128(env: &Env, v: &Val) -> Option<i128> {
    if let Ok(n) = u32::try_from_val(env, v) {
        return Some(n as i128);
    }
    if let Ok(n) = u64::try_from_val(env, v) {
        return Some(n as i128);
    }
    if let Ok(n) = i128::try_from_val(env, v) {
        return Some(n);
    }
    None
}

fn literal_i128(leaf: &Leaf) -> Option<i128> {
    match leaf {
        Leaf::LiteralU32(v) => Some(*v as i128),
        Leaf::LiteralU64(v) => Some(*v as i128),
        Leaf::LiteralI128(v) => Some(*v),
        _ => None,
    }
}

fn eval_numeric_compare(
    env: &Env,
    op: CompareOp,
    left: &Leaf,
    right: &Leaf,
    ctx: &EvalContext,
) -> EvalDecision {
    let (l, r) = match (leaf_to_i128(env, left, ctx), leaf_to_i128(env, right, ctx)) {
        (Some(l), Some(r)) => (l, r),
        _ => return EvalDecision::Deny(DenyReason::ArgMismatch),
    };
    let pass = match op {
        CompareOp::Eq => l == r,
        CompareOp::Lt => l < r,
        CompareOp::Lte => l <= r,
        CompareOp::Gt => l > r,
        CompareOp::Gte => l >= r,
    };
    if pass {
        EvalDecision::Permit
    } else {
        EvalDecision::Deny(DenyReason::ArgMismatch)
    }
}

fn leaf_to_i128(env: &Env, leaf: &Leaf, ctx: &EvalContext) -> Option<i128> {
    match leaf {
        Leaf::Now => Some(ctx.at_ledger as i128),
        Leaf::CallArg(i) => {
            let v = ctx.args.get(*i)?;
            val_to_i128(env, &v)
        }
        Leaf::LiteralU32(v) => Some(*v as i128),
        Leaf::LiteralU64(v) => Some(*v as i128),
        Leaf::LiteralI128(v) => Some(*v),
        _ => None,
    }
}

fn compare_u32(op: CompareOp, a: u32, b: u32) -> EvalDecision {
    let pass = match op {
        CompareOp::Eq => a == b,
        CompareOp::Lt => a < b,
        CompareOp::Lte => a <= b,
        CompareOp::Gt => a > b,
        CompareOp::Gte => a >= b,
    };
    if pass {
        EvalDecision::Permit
    } else {
        EvalDecision::Deny(DenyReason::ArgMismatch)
    }
}

// ============================================================================
// Decoder
// ============================================================================

mod dsl_decode {
    extern crate alloc;

    use alloc::boxed::Box;
    use alloc::vec::Vec;

    use soroban_sdk::xdr::FromXdr;
    use soroban_sdk::{Address, Bytes, Env, Symbol, TryFromVal, Val, Vec as SorobanVec};

    use super::{
        CompareOp, Leaf, Node, MAX_DEPTH, MAX_IN_OPERAND_COUNT, MAX_LEAVES, MAX_PREDICATE_BYTES,
        OP_AND, OP_EQ, OP_GT, OP_GTE, OP_IN, OP_LT, OP_LTE, OP_NOT, OP_OR, SEL_CALL_ARG,
        SEL_CALL_ARG_FIELD, SEL_CALL_ARG_LEN, SEL_CALL_CONTRACT, SEL_CALL_FN, SEL_NOW,
    };

    /// Errors that can be raised while decoding a predicate root from the
    /// canonical ScVal wire format. Every variant maps to the matching wire
    /// code via `code()`.
    #[derive(Debug, PartialEq, Eq, Clone)]
    pub enum DecodeError {
        /// Empty / wrong-Variant / wrong-arity / unknown op or selector
        /// symbol / `in []` at decode. Maps to `MALFORMED_PREDICATE`.
        MalformedPredicate,
        /// Depth exceeded MAX_DEPTH (5). Maps to `PREDICATE_TOO_DEEP`.
        PredicateTooDeep,
        /// Leaf count exceeded MAX_LEAVES (200). Maps to `TOO_MANY_LEAVES`.
        TooManyLeaves,
        /// An `in` haystack exceeded MAX_IN_OPERAND_COUNT (32).
        InOperandLimit,
        /// Predicate payload exceeded MAX_PREDICATE_BYTES (32 KB).
        PredicateTooLarge,
    }

    impl DecodeError {
        pub const fn code(&self) -> &'static str {
            match self {
                DecodeError::MalformedPredicate => "MALFORMED_PREDICATE",
                DecodeError::PredicateTooDeep => "PREDICATE_TOO_DEEP",
                DecodeError::TooManyLeaves => "TOO_MANY_LEAVES",
                DecodeError::InOperandLimit => "IN_OPERAND_LIMIT",
                DecodeError::PredicateTooLarge => "PREDICATE_TOO_LARGE",
            }
        }
    }

    impl core::fmt::Display for DecodeError {
        fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
            f.write_str(self.code())
        }
    }

    /// Decode a predicate root and re-check the cap trio
    /// (depth / leaves / `in`-operand). The byte cap is checked separately
    /// by `decode_with_byte_cap`, which is the install-time entry point.
    pub fn decode(env: &Env, bytes: &Bytes) -> Result<Node, DecodeError> {
        let v: Val = Val::from_xdr(env, bytes).map_err(|_| DecodeError::MalformedPredicate)?;
        let root: SorobanVec<Val> = SorobanVec::<Val>::try_from_val(env, &v)
            .map_err(|_| DecodeError::MalformedPredicate)?;
        if root.is_empty() {
            return Err(DecodeError::MalformedPredicate);
        }
        let root_node = decode_node(env, &root)?;
        let stats = collect_stats(&root_node);
        if stats.depth > MAX_DEPTH {
            return Err(DecodeError::PredicateTooDeep);
        }
        if stats.leaves > MAX_LEAVES {
            return Err(DecodeError::TooManyLeaves);
        }
        for in_count in stats.in_counts {
            if in_count > MAX_IN_OPERAND_COUNT {
                return Err(DecodeError::InOperandLimit);
            }
        }
        Ok(root_node)
    }

    /// Decode AND check the byte-size cap against the raw XDR bytes. This is
    /// the only enforcement point for `MAX_PREDICATE_BYTES` - `decode` cannot
    /// see how many bytes the input was, so the cap has to be applied at the
    /// install boundary where the raw payload is still in hand.
    pub fn decode_with_byte_cap(env: &Env, bytes: &Bytes) -> Result<Node, DecodeError> {
        if bytes.len() > MAX_PREDICATE_BYTES {
            return Err(DecodeError::PredicateTooLarge);
        }
        decode(env, bytes)
    }

    struct NodeStats {
        depth: u32,
        leaves: u32,
        in_counts: Vec<u32>,
    }

    fn collect_stats(node: &Node) -> NodeStats {
        let mut s = NodeStats {
            depth: 0,
            leaves: 0,
            in_counts: Vec::new(),
        };
        walk(node, 1, &mut s);
        s
    }

    fn walk(node: &Node, d: u32, s: &mut NodeStats) {
        if d > s.depth {
            s.depth = d;
        }
        match node {
            Node::And(children) | Node::Or(children) => {
                for c in children {
                    walk(c, d + 1, s);
                }
            }
            Node::Not(inner) => walk(inner, d + 1, s),
            Node::Compare { left, right, .. } => {
                s.leaves = s.leaves.saturating_add(leaf_leaves(left));
                s.leaves = s.leaves.saturating_add(leaf_leaves(right));
            }
            Node::In { needle, haystack } => {
                s.leaves = s.leaves.saturating_add(leaf_leaves(needle));
                for h in haystack {
                    s.leaves = s.leaves.saturating_add(leaf_leaves(h));
                }
                s.in_counts.push(haystack.len() as u32);
            }
        }
    }

    fn leaf_leaves(leaf: &Leaf) -> u32 {
        match leaf {
            Leaf::LiteralVec(elements) => {
                let mut n: u32 = 1;
                for e in elements {
                    n = n.saturating_add(leaf_leaves(e));
                }
                n
            }
            _ => 1,
        }
    }

    // ---- structural decoder ----

    fn decode_node(env: &Env, items: &SorobanVec<Val>) -> Result<Node, DecodeError> {
        if items.is_empty() {
            return Err(DecodeError::MalformedPredicate);
        }
        let head = items.get(0).ok_or(DecodeError::MalformedPredicate)?;
        let head_sym =
            Symbol::try_from_val(env, &head).map_err(|_| DecodeError::MalformedPredicate)?;
        // Compare via PartialEq (works on wasm; Symbol has no ToString on
        // the wasm target because the SDK hides the underlying string
        // representation behind a host object).
        if head_sym == sym_const(env, OP_AND) {
            decode_and_or(env, items, false)
        } else if head_sym == sym_const(env, OP_OR) {
            decode_and_or(env, items, true)
        } else if head_sym == sym_const(env, OP_NOT) {
            decode_not(env, items)
        } else if head_sym == sym_const(env, OP_EQ) {
            decode_compare(env, items, OP_EQ)
        } else if head_sym == sym_const(env, OP_LT) {
            decode_compare(env, items, OP_LT)
        } else if head_sym == sym_const(env, OP_LTE) {
            decode_compare(env, items, OP_LTE)
        } else if head_sym == sym_const(env, OP_GT) {
            decode_compare(env, items, OP_GT)
        } else if head_sym == sym_const(env, OP_GTE) {
            decode_compare(env, items, OP_GTE)
        } else if head_sym == sym_const(env, OP_IN) {
            decode_in(env, items)
        } else {
            // Bare selector tuples at a Node position are MALFORMED.
            Err(DecodeError::MalformedPredicate)
        }
    }

    /// Build a short host Symbol from a literal byte tag. Used for direct
    /// PartialEq dispatch in the decoder; avoids any string-conversion
    /// host call.
    fn sym_const(env: &Env, bytes: &[u8]) -> Symbol {
        // SAFETY: every literal here is a short ASCII string (≤ 9 bytes),
        // which the SDK accepts as a small (SymbolSmall) symbol.
        let s = core::str::from_utf8(bytes).expect("tag is ASCII");
        Symbol::new(env, s)
    }

    fn decode_and_or(env: &Env, items: &SorobanVec<Val>, is_or: bool) -> Result<Node, DecodeError> {
        if items.len() != 2 {
            return Err(DecodeError::MalformedPredicate);
        }
        let inner_val = items.get(1).ok_or(DecodeError::MalformedPredicate)?;
        let children_items: SorobanVec<Val> = SorobanVec::<Val>::try_from_val(env, &inner_val)
            .map_err(|_| DecodeError::MalformedPredicate)?;
        if children_items.is_empty() {
            return Err(DecodeError::MalformedPredicate);
        }
        let mut children: Vec<Node> = Vec::with_capacity(children_items.len() as usize);
        for i in 0..children_items.len() {
            let c = children_items
                .get(i)
                .ok_or(DecodeError::MalformedPredicate)?;
            children.push(decode_node(env, &single_tuple(env, &c)?)?);
        }
        if is_or {
            Ok(Node::Or(children))
        } else {
            Ok(Node::And(children))
        }
    }

    fn decode_not(env: &Env, items: &SorobanVec<Val>) -> Result<Node, DecodeError> {
        if items.len() != 2 {
            return Err(DecodeError::MalformedPredicate);
        }
        let child_val = items.get(1).ok_or(DecodeError::MalformedPredicate)?;
        let child_tuple = single_tuple(env, &child_val)?;
        let child = decode_node(env, &child_tuple)?;
        Ok(Node::Not(Box::new(child)))
    }

    fn decode_compare(
        env: &Env,
        items: &SorobanVec<Val>,
        op_name: &[u8],
    ) -> Result<Node, DecodeError> {
        if items.len() != 3 {
            return Err(DecodeError::MalformedPredicate);
        }
        let left_val = items.get(1).ok_or(DecodeError::MalformedPredicate)?;
        let right_val = items.get(2).ok_or(DecodeError::MalformedPredicate)?;
        let left = decode_leaf(env, &left_val)?;
        let right = decode_leaf(env, &right_val)?;
        let op = match op_name {
            OP_EQ => CompareOp::Eq,
            OP_LT => CompareOp::Lt,
            OP_LTE => CompareOp::Lte,
            OP_GT => CompareOp::Gt,
            OP_GTE => CompareOp::Gte,
            _ => return Err(DecodeError::MalformedPredicate),
        };
        Ok(Node::Compare { op, left, right })
    }

    fn decode_in(env: &Env, items: &SorobanVec<Val>) -> Result<Node, DecodeError> {
        if items.len() != 3 {
            return Err(DecodeError::MalformedPredicate);
        }
        let needle_val = items.get(1).ok_or(DecodeError::MalformedPredicate)?;
        let needle = decode_leaf(env, &needle_val)?;
        let haystack_val = items.get(2).ok_or(DecodeError::MalformedPredicate)?;
        let haystack_items: SorobanVec<Val> = SorobanVec::<Val>::try_from_val(env, &haystack_val)
            .map_err(|_| DecodeError::MalformedPredicate)?;
        if haystack_items.is_empty() {
            return Err(DecodeError::MalformedPredicate);
        }
        let mut haystack: Vec<Leaf> = Vec::with_capacity(haystack_items.len() as usize);
        for i in 0..haystack_items.len() {
            let h = haystack_items
                .get(i)
                .ok_or(DecodeError::MalformedPredicate)?;
            haystack.push(decode_leaf(env, &h)?);
        }
        Ok(Node::In { needle, haystack })
    }

    fn single_tuple(env: &Env, v: &Val) -> Result<SorobanVec<Val>, DecodeError> {
        SorobanVec::<Val>::try_from_val(env, v).map_err(|_| DecodeError::MalformedPredicate)
    }

    pub(super) fn decode_leaf(env: &Env, val: &Val) -> Result<Leaf, DecodeError> {
        // Selector tuples are `Vec<Val>` whose head is a `Symbol`. Literal
        // vectors are `Vec<Val>` whose head is NOT a known selector symbol.
        if let Ok(items) = SorobanVec::<Val>::try_from_val(env, val) {
            if items.is_empty() {
                return Err(DecodeError::MalformedPredicate);
            }
            let head = items.get(0).ok_or(DecodeError::MalformedPredicate)?;
            if let Ok(sym) = Symbol::try_from_val(env, &head) {
                return decode_selector_leaf(env, &items, sym);
            }
            // Literal vector: order preserved verbatim.
            let mut elems: Vec<Leaf> = Vec::with_capacity(items.len() as usize);
            for i in 0..items.len() {
                let e = items.get(i).ok_or(DecodeError::MalformedPredicate)?;
                elems.push(decode_leaf(env, &e)?);
            }
            return Ok(Leaf::LiteralVec(elems));
        }
        // Bare literals.
        if let Ok(addr) = Address::try_from_val(env, val) {
            return Ok(Leaf::LiteralAddress(addr));
        }
        if let Ok(sym) = Symbol::try_from_val(env, val) {
            return Ok(Leaf::LiteralSymbol(sym));
        }
        if let Ok(n) = u32::try_from_val(env, val) {
            return Ok(Leaf::LiteralU32(n));
        }
        if let Ok(n) = u64::try_from_val(env, val) {
            return Ok(Leaf::LiteralU64(n));
        }
        if let Ok(n) = i128::try_from_val(env, val) {
            return Ok(Leaf::LiteralI128(n));
        }
        if let Ok(b) = Bytes::try_from_val(env, val) {
            return Ok(Leaf::LiteralBytes(b));
        }
        Err(DecodeError::MalformedPredicate)
    }

    fn decode_selector_leaf(
        env: &Env,
        items: &SorobanVec<Val>,
        head: Symbol,
    ) -> Result<Leaf, DecodeError> {
        if head == sym_const(env, SEL_CALL_CONTRACT) {
            check_arity(items.len(), 1)?;
            Ok(Leaf::CallContract)
        } else if head == sym_const(env, SEL_CALL_FN) {
            check_arity(items.len(), 1)?;
            Ok(Leaf::CallFn)
        } else if head == sym_const(env, SEL_CALL_ARG) {
            check_arity(items.len(), 2)?;
            let i = expect_u32(env, items.get(1).ok_or(DecodeError::MalformedPredicate)?)?;
            Ok(Leaf::CallArg(i))
        } else if head == sym_const(env, SEL_CALL_ARG_LEN) {
            check_arity(items.len(), 2)?;
            let i = expect_u32(env, items.get(1).ok_or(DecodeError::MalformedPredicate)?)?;
            Ok(Leaf::CallArgLen(i))
        } else if head == sym_const(env, SEL_CALL_ARG_FIELD) {
            check_arity(items.len(), 4)?;
            let i = expect_u32(env, items.get(1).ok_or(DecodeError::MalformedPredicate)?)?;
            let e = expect_u32(env, items.get(2).ok_or(DecodeError::MalformedPredicate)?)?;
            let f = expect_symbol(env, items.get(3).ok_or(DecodeError::MalformedPredicate)?)?;
            Ok(Leaf::CallArgField {
                index: i,
                element: e,
                field: f,
            })
        } else if head == sym_const(env, SEL_NOW) {
            check_arity(items.len(), 1)?;
            Ok(Leaf::Now)
        } else {
            // Unknown symbol at a selector position -> MALFORMED.
            Err(DecodeError::MalformedPredicate)
        }
    }

    fn check_arity(actual: u32, expected: u32) -> Result<(), DecodeError> {
        if actual == expected {
            Ok(())
        } else {
            Err(DecodeError::MalformedPredicate)
        }
    }

    fn expect_u32(env: &Env, v: Val) -> Result<u32, DecodeError> {
        u32::try_from_val(env, &v).map_err(|_| DecodeError::MalformedPredicate)
    }
    fn expect_symbol(env: &Env, v: Val) -> Result<Symbol, DecodeError> {
        Symbol::try_from_val(env, &v).map_err(|_| DecodeError::MalformedPredicate)
    }
}
