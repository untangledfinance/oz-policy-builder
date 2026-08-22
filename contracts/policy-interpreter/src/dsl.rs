//! Predicate DSL decoder and pure evaluator.
//!
//! The decoder ingests raw canonical ScVal XDR bytes via `Val::from_xdr`
//! (the host does the XDR parse), then walks the resulting `Vec<Val>` tree
//! with native soroban-sdk types. The AST holds host types so the
//! evaluator can compare `Address`/`Symbol`/`Bytes` directly without
//! byte-extraction helpers.

extern crate alloc;

use alloc::vec::Vec;

use soroban_sdk::xdr::ToXdr;
use soroban_sdk::{Address, Env, IntoVal, Map, Symbol, TryFromVal, Val, Vec as SorobanVec};

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
// `call_arg_scaled(index, num, den)` evaluates to `args[index] * num / den`,
// truncating toward zero. It is the only leaf whose value is COMPUTED from
// the call rather than read from it, and the only selector the grammar
// permits on the right-hand side of a compare - which is what lets a swap
// policy bound its output against its own input (`out >= in * num / den`)
// instead of against a constant that would pin the policy to one trade size.
// `checked_mul`/`checked_div` throughout, so a hostile ratio denies rather
// than wrapping.
const SEL_CALL_ARG_SCALED: &[u8] = b"call_arg_scaled";

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
    /// `args[index] * num / den`, truncating toward zero. See
    /// `SEL_CALL_ARG_SCALED` for why this leaf exists.
    CallArgScaled {
        index: u32,
        num: i128,
        den: i128,
    },
    LiteralAddress(Address),
    LiteralI128(i128),
    LiteralSymbol(Symbol),
    LiteralU32(u32),
    LiteralVec(Vec<Leaf>),
}

// ---- EvalContext ----

#[derive(Debug, Clone)]
pub struct EvalContext {
    pub contract: Address,
    pub fn_name: Symbol,
    pub args: SorobanVec<Val>,
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
    /// A `call_arg_scaled` product or quotient did not fit `i128`, or its
    /// denominator was zero at evaluate.
    ArithmeticOverflow,
    UnsupportedNode,
    /// `in` membership failed. Distinct from ArgMismatch so a review card can
    /// say "not on the allowlist" rather than "argument mismatch"; the
    /// reference evaluator draws the same distinction.
    NotInAllowlist,
    /// A comparison against a `call_arg_scaled` operand failed. Distinct from
    /// ArgMismatch for the same reason NotInAllowlist is: the review card
    /// should read as the policy the author wrote.
    SlippageFloor,
}

impl DenyReason {
    pub const fn code(&self) -> &'static str {
        match self {
            DenyReason::ArgMismatch => "ARG_MISMATCH",
            DenyReason::ContractScope => "CONTRACT_SCOPE",
            DenyReason::ArithmeticOverflow => "ARITHMETIC_OVERFLOW",
            DenyReason::UnsupportedNode => "UNSUPPORTED_NODE",
            DenyReason::NotInAllowlist => "NOT_IN_ALLOWLIST",
            DenyReason::SlippageFloor => "SLIPPAGE_FLOOR",
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
        // The first child's deny is the reported one. Reporting the LAST
        // would name whichever branch happened to be written last, which is
        // not the branch the author was most likely reaching for.
        Node::Or(children) => {
            let mut first_deny: Option<EvalDecision> = None;
            for c in children {
                match evaluate(env, c, ctx) {
                    EvalDecision::Permit => return EvalDecision::Permit,
                    d @ EvalDecision::Deny(_) => {
                        if first_deny.is_none() {
                            first_deny = Some(d);
                        }
                    }
                }
            }
            // An empty `or` is refused at decode, so this is unreachable in
            // practice; denying is the fail-closed answer if it ever is not.
            first_deny.unwrap_or(EvalDecision::Deny(DenyReason::UnsupportedNode))
        }
        Node::Compare { op, left, right } => eval_compare(env, *op, left, right, ctx),
        Node::In { needle, haystack } => {
            if haystack.is_empty() {
                return EvalDecision::Deny(DenyReason::NotInAllowlist);
            }
            // The needle can be either a literal (a haystack of literals) or
            // a selector leaf (e.g. call_arg[i]). Resolve via the live
            // context first; fall back to literal_to_val for pure-literal
            // needles. Both paths feed the same Val equality (host shallow_eq).
            let expected = resolve(env, needle, ctx);
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

/// Evaluate one `compare` node.
///
/// Both sides are reduced to a `Val` and compared once. The left side may be
/// any leaf, including a selector, and is resolved against the call under
/// evaluation; the right side must be a literal, which is what keeps the
/// grammar from expressing selector-to-selector comparisons.
///
/// Every failure to resolve or convert is a deny. The reason is a property of
/// the left leaf, so it is chosen once up front rather than at each exit.
///
/// `call_arg_scaled` is the one exception to "the right side must be a
/// literal". It is dispatched before that rule is applied, on either side,
/// because a slippage floor has no constant to bound against.
fn eval_compare(
    env: &Env,
    op: CompareOp,
    left: &Leaf,
    right: &Leaf,
    ctx: &EvalContext,
) -> EvalDecision {
    // Scaled operands first, so the dedicated reasons (ArithmeticOverflow,
    // SlippageFloor) reach the review card instead of a generic mismatch.
    // Right-hand dispatch leads because `out >= in * num / den` is the
    // canonical swap form.
    if let Leaf::CallArgScaled { index, num, den } = right {
        return eval_scaled_arg_compare(env, op, left, *index, *num, *den, true, ctx);
    }
    if let Leaf::CallArgScaled { index, num, den } = left {
        return eval_scaled_arg_compare(env, op, right, *index, *num, *den, false, ctx);
    }
    // `call_contract` and `call_fn` name an identity, not a quantity, so an
    // ordering comparison over either is a node the interpreter never
    // supported - distinct from a value that merely failed to match.
    if op != CompareOp::Eq && matches!(left, Leaf::CallContract | Leaf::CallFn) {
        return EvalDecision::Deny(DenyReason::UnsupportedNode);
    }
    // A contract-scope miss is reported as its own reason so a review card can
    // say "wrong contract" rather than "argument mismatch".
    let miss = if matches!(left, Leaf::CallContract) {
        DenyReason::ContractScope
    } else {
        DenyReason::ArgMismatch
    };
    let (Some(actual), Some(expected)) = (resolve(env, left, ctx), literal_to_val(env, right))
    else {
        return EvalDecision::Deny(miss);
    };
    let pass = match op {
        CompareOp::Eq => val_eq(env, &actual, &expected),
        // A non-numeric operand (an address, a vector) has no ordering, so
        // every ordering op shares one numeric-widening path.
        CompareOp::Lt | CompareOp::Lte | CompareOp::Gt | CompareOp::Gte => {
            match (val_to_i128(env, &actual), val_to_i128(env, &expected)) {
                (Some(a), Some(b)) => match op {
                    CompareOp::Lt => a < b,
                    CompareOp::Lte => a <= b,
                    CompareOp::Gt => a > b,
                    CompareOp::Gte => a >= b,
                    CompareOp::Eq => unreachable!("Eq is handled above"),
                },
                _ => return EvalDecision::Deny(miss),
            }
        }
    };
    if pass {
        EvalDecision::Permit
    } else {
        EvalDecision::Deny(miss)
    }
}

/// Evaluate a comparison with a `call_arg_scaled` leaf on one side.
///
/// The scaled side is `args[index] * num / den`, truncating toward zero.
/// Arithmetic that does not fit denies with `ArithmeticOverflow` rather than
/// panicking the frame; a comparison that simply fails denies with
/// `SlippageFloor`.
///
/// `scaled_on_right` says which side the scaled leaf came from, so the
/// operator is applied in the order the author wrote it:
///   - `true`  => `other <op> scaled`, the canonical `out >= in * num / den`
///   - `false` => `scaled <op> other`
///
/// Scaled-versus-scaled is refused: chaining two computed operands has no
/// meaning a review card could state plainly.
#[allow(clippy::too_many_arguments)]
fn eval_scaled_arg_compare(
    env: &Env,
    op: CompareOp,
    other: &Leaf,
    index: u32,
    num: i128,
    den: i128,
    scaled_on_right: bool,
    ctx: &EvalContext,
) -> EvalDecision {
    if matches!(other, Leaf::CallArgScaled { .. }) {
        return EvalDecision::Deny(DenyReason::UnsupportedNode);
    }
    // Out-of-bounds or non-numeric source both surface as ArgMismatch: the
    // operand could not be READ, which is a different failure from a floor
    // that was read and not met.
    let Some(raw) = ctx.args.get(index) else {
        return EvalDecision::Deny(DenyReason::ArgMismatch);
    };
    let Some(input) = val_to_i128(env, &raw) else {
        return EvalDecision::Deny(DenyReason::ArgMismatch);
    };
    // Install refuses a zero or non-positive ratio, so this is belt and
    // braces: a future regression in that gate must not panic the frame.
    if den == 0 {
        return EvalDecision::Deny(DenyReason::ArithmeticOverflow);
    }
    let Some(scaled) = input.checked_mul(num).and_then(|p| p.checked_div(den)) else {
        return EvalDecision::Deny(DenyReason::ArithmeticOverflow);
    };
    let Some(other_val) = resolve(env, other, ctx).and_then(|v| val_to_i128(env, &v)) else {
        return EvalDecision::Deny(DenyReason::ArgMismatch);
    };
    let (lhs, rhs) = if scaled_on_right {
        (other_val, scaled)
    } else {
        (scaled, other_val)
    };
    let pass = match op {
        CompareOp::Eq => lhs == rhs,
        CompareOp::Lt => lhs < rhs,
        CompareOp::Lte => lhs <= rhs,
        CompareOp::Gt => lhs > rhs,
        CompareOp::Gte => lhs >= rhs,
    };
    if pass {
        EvalDecision::Permit
    } else {
        EvalDecision::Deny(DenyReason::SlippageFloor)
    }
}

/// Resolve a leaf to the `Val` it denotes for the call under evaluation.
///
/// `None` means the leaf named something this call does not carry - an
/// argument index past the end, an argument whose shape is not what the leaf
/// assumed, an absent map field. Every caller turns `None` into a deny, so an
/// unresolvable leaf is always fail-closed.
fn resolve(env: &Env, leaf: &Leaf, ctx: &EvalContext) -> Option<Val> {
    match leaf {
        Leaf::CallContract => Some(ctx.contract.clone().into_val(env)),
        Leaf::CallFn => Some(ctx.fn_name.clone().into_val(env)),
        Leaf::CallArg(i) => ctx.args.get(*i),
        Leaf::CallArgLen(i) => {
            let items = SorobanVec::<Val>::try_from_val(env, &ctx.args.get(*i)?).ok()?;
            Some(items.len().into_val(env))
        }
        Leaf::CallArgField {
            index,
            element,
            field,
        } => {
            let outer = SorobanVec::<Val>::try_from_val(env, &ctx.args.get(*index)?).ok()?;
            let map = Map::<Symbol, Val>::try_from_val(env, &outer.get(*element)?).ok()?;
            map.get(field.clone())
        }
        _ => literal_to_val(env, leaf),
    }
}

/// True when the predicate constrains at least one property of the call
/// being authorised, rather than comparing literals to literals.
///
/// A predicate with no selector leaf - literals on both sides of every
/// compare - is trivially true or trivially false at install time, so it
/// permits everything or nothing forever. `install` refuses such a predicate
/// so a no-constraint policy cannot install under any name.
///
/// Recurses into `LiteralVec`: a selector wrapped in a literal vector is
/// still a selector.
pub fn has_selector_leaf(root: &Node) -> bool {
    fn selects(leaf: &Leaf) -> bool {
        match leaf {
            Leaf::LiteralAddress(_)
            | Leaf::LiteralI128(_)
            | Leaf::LiteralSymbol(_)
            | Leaf::LiteralU32(_) => false,
            Leaf::LiteralVec(elements) => elements.iter().any(selects),
            // Every remaining variant reads something from the call under
            // evaluation, so it constrains the policy.
            _ => true,
        }
    }
    match root {
        Node::And(children) | Node::Or(children) => children.iter().any(has_selector_leaf),
        Node::Compare { left, right, .. } => selects(left) || selects(right),
        Node::In { needle, haystack } => selects(needle) || haystack.iter().any(selects),
    }
}

/// Why a predicate is not installable on slippage-floor grounds.
#[derive(Debug, PartialEq, Eq, Copy, Clone)]
pub enum ScaledRatioError {
    /// `den == 0`. The division would fail at evaluate; refusing here is
    /// loud once rather than a rule that denies forever.
    ZeroDenominator,
    /// `num <= 0` or `den <= 0`. A negative ratio silently INVERTS the
    /// comparison, so a floor permits exactly what it was written to refuse.
    NonPositiveRatio,
}

/// Refuse a `call_arg_scaled` whose ratio cannot express a floor.
///
/// Checked at install rather than only at evaluate because both failures are
/// properties of the predicate itself, knowable the moment it is written.
pub fn validate_scaled_ratios(root: &Node) -> Result<(), ScaledRatioError> {
    fn leaf(l: &Leaf) -> Result<(), ScaledRatioError> {
        match l {
            Leaf::CallArgScaled { num, den, .. } => {
                if *den == 0 {
                    return Err(ScaledRatioError::ZeroDenominator);
                }
                if *num <= 0 || *den < 0 {
                    return Err(ScaledRatioError::NonPositiveRatio);
                }
                Ok(())
            }
            Leaf::LiteralVec(elements) => {
                for e in elements {
                    leaf(e)?;
                }
                Ok(())
            }
            _ => Ok(()),
        }
    }
    match root {
        Node::And(children) | Node::Or(children) => {
            for c in children {
                validate_scaled_ratios(c)?;
            }
        }
        Node::Compare { left, right, .. } => {
            leaf(left)?;
            leaf(right)?;
        }
        Node::In { needle, haystack } => {
            leaf(needle)?;
            for h in haystack {
                leaf(h)?;
            }
        }
    }
    Ok(())
}

/// Widen any integral `Val` the host may carry to `i128` for ordering.
fn val_to_i128(env: &Env, v: &Val) -> Option<i128> {
    if let Ok(n) = u32::try_from_val(env, v) {
        return Some(i128::from(n));
    }
    if let Ok(n) = u64::try_from_val(env, v) {
        return Some(i128::from(n));
    }
    i128::try_from_val(env, v).ok()
}

// ============================================================================
// Decoder
// ============================================================================

mod dsl_decode {
    extern crate alloc;

    use alloc::vec::Vec;

    use soroban_sdk::xdr::FromXdr;
    use soroban_sdk::{Address, Bytes, Env, Symbol, TryFromVal, Val, Vec as SorobanVec};

    use super::{
        CompareOp, Leaf, Node, MAX_DEPTH, MAX_IN_OPERAND_COUNT, MAX_LEAVES, MAX_PREDICATE_BYTES,
        OP_AND, OP_EQ, OP_GT, OP_GTE, OP_IN, OP_LT, OP_LTE, OP_OR, SEL_CALL_ARG,
        SEL_CALL_ARG_FIELD, SEL_CALL_ARG_LEN, SEL_CALL_ARG_SCALED, SEL_CALL_CONTRACT, SEL_CALL_FN,
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
        let mut stats = NodeStats::default();
        walk(&root_node, 1, &mut stats);
        if stats.depth > MAX_DEPTH {
            return Err(DecodeError::PredicateTooDeep);
        }
        if stats.leaves > MAX_LEAVES {
            return Err(DecodeError::TooManyLeaves);
        }
        if stats.max_in_operands > MAX_IN_OPERAND_COUNT {
            return Err(DecodeError::InOperandLimit);
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

    #[derive(Default)]
    struct NodeStats {
        depth: u32,
        leaves: u32,
        max_in_operands: u32,
    }

    fn walk(node: &Node, d: u32, s: &mut NodeStats) {
        if d > s.depth {
            s.depth = d;
        }
        match node {
            Node::And(children) | Node::Or(children) => {
                for c in children {
                    walk(c, d.saturating_add(1), s);
                }
            }
            Node::Compare { left, right, .. } => {
                s.leaves = s.leaves.saturating_add(leaf_leaves(left));
                s.leaves = s.leaves.saturating_add(leaf_leaves(right));
            }
            Node::In { needle, haystack } => {
                s.leaves = s.leaves.saturating_add(leaf_leaves(needle));
                for h in haystack {
                    s.leaves = s.leaves.saturating_add(leaf_leaves(h));
                }
                let operands = u32::try_from(haystack.len()).unwrap_or(u32::MAX);
                if operands > s.max_in_operands {
                    s.max_in_operands = operands;
                }
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
            decode_children(env, items).map(Node::And)
        } else if head_sym == sym_const(env, OP_OR) {
            decode_children(env, items).map(Node::Or)
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

    /// Decode the child list shared by `and` and `or`. Both carry exactly one
    /// operand, a non-empty vector of child tuples; an empty list is refused
    /// so neither can degenerate into a node that permits (empty `and`) or
    /// denies (empty `or`) regardless of the call.
    fn decode_children(env: &Env, items: &SorobanVec<Val>) -> Result<Vec<Node>, DecodeError> {
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
        Ok(children)
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
        if let Ok(n) = i128::try_from_val(env, val) {
            return Ok(Leaf::LiteralI128(n));
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
        } else if head == sym_const(env, SEL_CALL_ARG_SCALED) {
            // Arity 4: (symbol, u32 index, i128 num, i128 den). The decoder
            // is the single place that validates type and presence, so a
            // hand-crafted tuple carrying a u32 in the num/den slot is
            // refused here rather than reinterpreted at evaluate.
            check_arity(items.len(), 4)?;
            let i = expect_u32(env, items.get(1).ok_or(DecodeError::MalformedPredicate)?)?;
            let num = expect_i128(env, items.get(2).ok_or(DecodeError::MalformedPredicate)?)?;
            let den = expect_i128(env, items.get(3).ok_or(DecodeError::MalformedPredicate)?)?;
            Ok(Leaf::CallArgScaled { index: i, num, den })
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
    fn expect_i128(env: &Env, v: Val) -> Result<i128, DecodeError> {
        i128::try_from_val(env, &v).map_err(|_| DecodeError::MalformedPredicate)
    }
    fn expect_symbol(env: &Env, v: Val) -> Result<Symbol, DecodeError> {
        Symbol::try_from_val(env, &v).map_err(|_| DecodeError::MalformedPredicate)
    }
}
