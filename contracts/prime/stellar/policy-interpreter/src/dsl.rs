//! Predicate DSL decoder and evaluator. The evaluator is pure except for the
//! `read` leaf, which calls the contract it names.
//!
//! The decoder ingests raw canonical ScVal XDR bytes via `Val::from_xdr`
//! (the host does the XDR parse), then walks the resulting `Vec<Val>` tree
//! with native soroban-sdk types. The AST holds host types so the
//! evaluator can compare `Address`/`Symbol`/`Bytes` directly without
//! byte-extraction helpers.

use alloc::{boxed::Box, vec, vec::Vec};

use soroban_sdk::xdr::{FromXdr, ToXdr};
use soroban_sdk::{Address, Bytes, Env, Error, IntoVal, Map, Symbol, TryFromVal, Val};

// ---- caps (mirrors TS PREDICATE_CAPS; the Rust side is authoritative) -----

pub const MAX_DEPTH: u32 = 5;
pub const MAX_LEAVES: u32 = 200;
pub const MAX_IN_OPERAND_COUNT: u32 = 32;
/// Distinct `read` calls per predicate. Each is a cross-contract call made on
/// every `enforce` (identical reads share one), so the count is capped at decode.
pub const MAX_READS: u32 = 4;
pub const MAX_PREDICATE_BYTES: u32 = 32 * 1024;

// Tag and selector names come from the encoder verbatim (see
// `policy-synth/src/predicate/encode.ts`); an unknown one is fail-closed at
// decode time.
//
// `call_path` is a walk into the authorised call's arguments: each step is
// either a u32 index into a vector or a symbol key into a map. `call_arg_field`
// stops at a fixed depth of three; a batch puts the value a predicate cares
// about deeper than that - `calls[n].args[i]`, or Blend's
// `calls[n].args[3][0].amount`. One variable-depth leaf reaches all of them,
// which is what lets the batch be constrained HERE instead of through a
// flattened projection built outside the contract that enforces it.
/// Steps per path. Measured against the shapes a root predicate actually has
/// to reach, counting from the committed argument list:
///
///   calls[n].target                                   3
///   calls[n].args[i]                                  4
///   calls[n].args[3][0].amount        (Blend)         6
///   prime_contexts[n].args[i]                         4
///   calls[n].executor_authorizations[k]
///       .context.contract                             7
///       .context.args[i]                              8
///
/// Eight covers all of them with nothing to spare, and the cap matters because
/// a path is walked per leaf: with `MAX_LEAVES` at 200 the worst case is 1600
/// walk steps in one evaluation.
///
/// What eight does NOT reach is the inside of a NESTED sub-invocation, which
/// starts at eleven. That is deliberate rather than an oversight: the root
/// signature commits to the whole authorization tree, so nothing can be
/// appended to it after signing, and the adapter's own `check_auths` walk
/// refuses a forbidden target at ANY depth. The predicate does not need to
/// restate either.
pub const MAX_PATH_STEPS: u32 = 8;
/// Largest `scaled` denominator. It stops an absurd one (`i128::MAX`) from
/// truncating every product to zero. It does NOT stop a tiny `num / den` ratio
/// (`99 / 10^18` still floors at zero for ordinary amounts); that is the rule
/// author's to avoid.
pub const MAX_DEN: i128 = 1_000_000_000_000_000_000;
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
// Only the native test build is large: there `Env` carries the whole host, and a
// `Read` leaf holds an `Address`, a `Symbol` and a `Vec` of it. On wasm it is a
// zero-sized handle, so boxing would add code for no saving.
#[allow(clippy::large_enum_variant)]
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

/// One step of a `CallPath`: into a vector, or into a map.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PathStep {
    Index(u32),
    Field(Symbol),
    /// Terminal step: the LENGTH of the vector reached so far. Without it a
    /// predicate can pin every element a batch declares and still say nothing
    /// about an element APPENDED after it was written - which is exactly how
    /// an extra authorization slips into a signed request.
    Len,
}

/// One literal or selector leaf. Host types are stored directly so the
/// evaluator can compare without re-encoding.
///
/// `call_arg`, `call_arg_len` and `call_arg_field` are not leaves of their own:
/// the decoder lowers them to the equivalent `CallPath`, so one walker serves
/// every way of reaching into the authorised call.
#[derive(Debug, Clone)]
pub enum Leaf {
    CallContract,
    CallFn,
    /// Steps apply to the argument vector in order.
    CallPath(Vec<PathStep>),
    /// The ledger timestamp.
    Now,
    /// `read(contract, fn, args, path)`: call a fixed function of a fixed
    /// contract with literal arguments and pick a field of the result with the
    /// same steps a `CallPath` takes. Soroban has no read-only call, so the
    /// target must be a contract the policy owner trusts. A failed call or a
    /// result that is not a number resolves to nothing, which denies.
    Read(Address, Symbol, Vals, Vec<PathStep>),
    /// `[src, num, add]` and `den`: `src * num / den + add`, multiplying
    /// first, truncating toward zero, every step checked. Each of the three
    /// operands is any value leaf, nested `Scaled` included; `den` is a
    /// constant in `1..=MAX_DEN`. A constant `src` or `num` must fold to a positive
    /// value, and a constant that overflows is refused.
    Scaled(Box<[Leaf; 3]>, i128),
    LiteralAddress(Address),
    LiteralI128(i128),
    LiteralSymbol(Symbol),
    LiteralU32(u32),
    LiteralVec(Vec<Leaf>),
}

// ---- EvalContext ----

/// The authorised call: the host's own contract-context triple (contract,
/// function name, arguments).
pub use soroban_sdk::auth::ContractContext as EvalContext;

#[derive(Debug, PartialEq, Eq, Clone)]
pub enum EvalDecision {
    Permit,
    Deny(DenyReason),
}

#[derive(Debug, PartialEq, Eq, Copy, Clone)]
pub enum DenyReason {
    ArgMismatch,
    ContractScope,
    /// A `scaled` step did not fit `i128`, or its denominator was zero.
    ArithmeticOverflow,
    UnsupportedNode,
    /// `in` membership failed. Distinct from ArgMismatch so a review card can
    /// say "not on the allowlist" rather than "argument mismatch"; the
    /// reference evaluator draws the same distinction.
    NotInAllowlist,
}

impl DenyReason {
    pub const fn code(&self) -> &'static str {
        match self {
            DenyReason::ArgMismatch => "ARG_MISMATCH",
            DenyReason::ContractScope => "CONTRACT_SCOPE",
            DenyReason::ArithmeticOverflow => "ARITHMETIC_OVERFLOW",
            DenyReason::UnsupportedNode => "UNSUPPORTED_NODE",
            DenyReason::NotInAllowlist => "NOT_IN_ALLOWLIST",
        }
    }
}

// ---- Pure evaluator ----

/// Pure apart from `Leaf::Read`, which calls out to the contract it names.
pub fn evaluate(env: &Env, node: &Node, ctx: &EvalContext) -> EvalDecision {
    eval(env, node, ctx, &mut Memo::new())
        .err()
        .map_or(EvalDecision::Permit, EvalDecision::Deny)
}

/// The calls this evaluation has already made, keyed by `(contract, fn, args)`
/// and holding the raw result (`None` for a call that failed). A repeated read
/// reuses it, so a distinct call is made at most once per `enforce`.
type Memo = Vec<((Address, Symbol, Vals), Option<Val>)>;

// Decoder guarantees. The evaluator below relies on these and does not check
// them again; `decode` (install) and `decode_stored` (enforce) establish them,
// and `install` is the only writer of a stored predicate.
//
//  - `and` and `or` have at least one child; an `in` has 1..=32 entries, each a
//    constant `literal_to_val` can convert; a compare has exactly two leaves.
//  - An ordering compare (`lt`, `lte`, `gt`, `gte`) has no address, symbol or
//    vector literal on either side, and `scaled` has none as an operand.
//  - A `scaled` has exactly three operands and `den` in 1..=MAX_DEN; a constant
//    `src` or `num` is positive, and a constant product or fold never overflows.
//  - A `read` target is a contract address, its arguments are constants, and its
//    path has at most MAX_PATH_STEPS steps; a `call_path` has 1..=MAX_PATH_STEPS,
//    with `Len` only last.
//  - Node depth and leaf nesting are at most MAX_DEPTH, so recursion is bounded.
//  - Install only (not re-checked on enforce): at most MAX_LEAVES leaves, at most
//    MAX_READS distinct reads, at most MAX_PREDICATE_BYTES bytes, and at least
//    one selector leaf.

fn eval(env: &Env, node: &Node, ctx: &EvalContext, memo: &mut Memo) -> Result<(), DenyReason> {
    match node {
        Node::And(children) => children.iter().try_for_each(|c| eval(env, c, ctx, memo)),
        // Permits on the first branch that holds; when none does, reports the
        // FIRST branch's deny. "First" is wire order, and the encoder sorts
        // `or` children canonically, so the reported reason is stable for a
        // given predicate rather than an artefact of which branch happened to
        // run last. It is deliberately not tied to authoring order - the
        // canonical encoding does not preserve that.
        Node::Or(children) => {
            let mut results = children.iter().map(|c| eval(env, c, ctx, memo));
            // An empty `or` is refused at decode, so this is unreachable in
            // practice; denying is the fail-closed answer if it ever is not.
            let first = results.next().unwrap_or(Err(DenyReason::UnsupportedNode));
            // Lazy: later branches run only until one permits.
            first.or_else(|deny| results.any(|r| r.is_ok()).then_some(()).ok_or(deny))
        }
        // One `compare` node: both sides are resolved and compared once, and
        // every failure to resolve or convert is a deny.
        //
        // A selector may be compared with another selector, or with itself,
        // which is vacuously true and installs cleanly because
        // `has_selector_leaf` sees a selector. That is a way to write a
        // no-constraint policy and sits in the known-acceptable-risk column
        // rather than being caught at install.
        Node::Compare { op, left, right } => {
            // `call_contract` and `call_fn` name an identity, not a quantity,
            // so an ordering comparison over either, on either side, is a node
            // the interpreter never supported - distinct from a value that
            // merely failed to match.
            let sides = [left, right];
            let is_id = |l: &&Leaf| matches!(l, Leaf::CallContract | Leaf::CallFn);
            if *op != CompareOp::Eq && sides.iter().any(is_id) {
                return Err(DenyReason::UnsupportedNode);
            }
            // A contract-scope miss is reported as its own reason so a review
            // card can say "wrong contract" rather than "argument mismatch".
            let miss = match sides.iter().any(|l| matches!(l, Leaf::CallContract)) {
                true => DenyReason::ContractScope,
                false => DenyReason::ArgMismatch,
            };
            // A side that cannot resolve is the same miss (overflow keeps its own).
            // A side that cannot resolve is the same miss (overflow keeps its own).
            let mut side = |l| match resolve(env, l, ctx, memo) {
                Err(DenyReason::ArgMismatch) => Err(miss),
                other => other,
            };
            let (a, b) = (side(left)?, side(right)?);
            // A non-numeric operand (an address, a vector) has no ordering.
            let n = |v: &Val| val_to_i128(env, v).ok_or(miss);
            let pass = match op {
                CompareOp::Eq => val_eq(env, &a, &b),
                CompareOp::Lt => n(&a)? < n(&b)?,
                CompareOp::Lte => n(&a)? <= n(&b)?,
                CompareOp::Gt => n(&a)? > n(&b)?,
                CompareOp::Gte => n(&a)? >= n(&b)?,
            };
            pass.then_some(()).ok_or(miss)
        }
        // An opaque or undecodable needle fails closed as a membership miss,
        // not an argument mismatch: it cannot be on the allowlist because it
        // cannot be compared at all.
        Node::In { needle, haystack } => resolve(env, needle, ctx, memo)
            .is_ok_and(|x| {
                let mut hay = haystack.iter().filter_map(|h| literal_to_val(env, h).ok());
                hay.any(|h| val_eq(env, &x, &h))
            })
            .then_some(())
            .ok_or(DenyReason::NotInAllowlist),
    }
}

/// Convert a literal leaf to its `Val` form for equality comparisons.
fn literal_to_val(env: &Env, leaf: &Leaf) -> Res<Val> {
    Ok(match leaf {
        Leaf::LiteralAddress(a) => a.into_val(env),
        Leaf::LiteralI128(v) => (*v).into_val(env),
        Leaf::LiteralSymbol(s) => s.into_val(env),
        Leaf::LiteralU32(v) => (*v).into_val(env),
        Leaf::LiteralVec(elements) => {
            let vals: Res<Vec<Val>> = elements.iter().map(|e| literal_to_val(env, e)).collect();
            Vals::from_slice(env, &vals?).into_val(env)
        }
        _ => return Err(DecodeError::MalformedPredicate),
    })
}

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
///
/// Two numbers (u32, u64, i128) compare as numbers, whatever their types, the
/// same widening ordering uses; `5u32` equals `5i128`. Anything else is exact:
/// a number never equals a symbol, and an address only its own address.
fn val_eq(env: &Env, a: &Val, b: &Val) -> bool {
    if let (Some(x), Some(y)) = (val_to_i128(env, a), val_to_i128(env, b)) {
        return x == y;
    }
    let objects = a.is_object() || b.is_object();
    a.shallow_eq(b) || (objects && (*a).to_xdr(env) == (*b).to_xdr(env))
}

/// Resolve a leaf to the `Val` it denotes for the call under evaluation.
///
/// An `Err` is always a deny. `ArgMismatch` means the leaf named something
/// this call does not carry - an argument past the end, a shape other than the
/// leaf assumed, a read that failed or returned a non-number;
/// `ArithmeticOverflow` is a `scaled` step that did not fit.
fn resolve(env: &Env, leaf: &Leaf, ctx: &EvalContext, memo: &mut Memo) -> Result<Val, DenyReason> {
    let miss = DenyReason::ArgMismatch;
    Ok(match leaf {
        Leaf::CallContract => ctx.contract.clone().into_val(env),
        Leaf::CallFn => ctx.fn_name.clone().into_val(env),
        Leaf::CallPath(steps) => walk(env, ctx.args.clone().into_val(env), steps).ok_or(miss)?,
        Leaf::Now => env.ledger().timestamp().into_val(env),
        Leaf::Read(c, f, a, steps) => {
            let key = (c.clone(), f.clone(), a.clone());
            let hit = memo.iter().find(|r| r.0 == key).map(|r| r.1);
            let raw = hit.unwrap_or_else(|| {
                let call = env.try_invoke_contract::<Val, Error>(c, f, a.clone());
                let raw = call.ok().and_then(|r| r.ok());
                memo.push((key, raw));
                raw
            });
            raw.and_then(|v| walk(env, v, steps))
                .filter(|v| val_to_i128(env, v).is_some())
                .ok_or(miss)?
        }
        Leaf::Scaled(k, den) => {
            let mut n = |l: &Leaf| val_to_i128(env, &resolve(env, l, ctx, memo)?).ok_or(miss);
            let scaled = scale(n(&k[0])?, n(&k[1])?, *den, n(&k[2])?);
            scaled.ok_or(DenyReason::ArithmeticOverflow)?.into_val(env)
        }
        _ => literal_to_val(env, leaf).map_err(|_| miss)?,
    })
}

/// `src * num / den + add`: multiply, divide (truncating toward zero), add, each
/// step checked.
fn scale(src: i128, num: i128, den: i128, add: i128) -> Option<i128> {
    src.checked_mul(num)?.checked_div(den)?.checked_add(add)
}

/// A literal that is not a number: it has no order and cannot be scaled. (An
/// identity selector is refused as a `scaled` operand too, but an ordering over
/// one is still decided at `enforce`.)
fn non_number(leaf: &Leaf) -> bool {
    matches!(
        leaf,
        Leaf::LiteralAddress(_) | Leaf::LiteralSymbol(_) | Leaf::LiteralVec(_)
    )
}

/// The value of a leaf made of literals alone; `None` for anything that
/// depends on the call, the clock or another contract, and for a fold that
/// overflows (decode refuses that one, so a nested constant never does).
fn constant(leaf: &Leaf) -> Option<i128> {
    match leaf {
        Leaf::LiteralI128(v) => Some(*v),
        Leaf::LiteralU32(v) => Some(i128::from(*v)),
        Leaf::Scaled(k, den) => scale(constant(&k[0])?, constant(&k[1])?, *den, constant(&k[2])?),
        _ => None,
    }
}

/// Follow `steps` from `cur`; `None` when a step finds something else.
fn walk(env: &Env, cur: Val, steps: &[PathStep]) -> Option<Val> {
    steps.iter().try_fold(cur, |cur, step| {
        Some(match step {
            PathStep::Index(i) => to::<Vals>(env, &cur).ok()?.get(*i)?,
            PathStep::Field(f) => to::<Map<Symbol, Val>>(env, &cur).ok()?.get(f.clone())?,
            PathStep::Len => to::<Vals>(env, &cur).ok()?.len().into_val(env),
        })
    })
}

/// True when the predicate constrains at least one property of the call
/// being authorised, rather than comparing literals to literals.
///
/// A predicate with no selector leaf - literals on both sides of every
/// compare - is trivially true or trivially false at install time, so it
/// permits everything or nothing forever. `install` refuses such a predicate
/// so a no-constraint policy cannot install under any name.
///
/// Only a leaf that reads the authorised call counts. `read` and `now` do not:
/// a rule made of reads and the clock alone says nothing about the call it
/// authorises. Looks through `scaled` operands, since a selector inside one is
/// still a selector. `in` haystacks and literal vectors hold constants only (the
/// decoder refuses anything else); `leaves` visits them, and none can match.
pub fn has_selector_leaf(root: &Node) -> bool {
    let selects = |l: &&Leaf| matches!(l, Leaf::CallContract | Leaf::CallFn | Leaf::CallPath(_));
    leaves(root).iter().any(selects)
}

/// Every leaf of the tree, nested `scaled` operands and literal-vec elements
/// included.
fn leaves(node: &Node) -> Vec<&Leaf> {
    fn nested<'a>(leaf: &'a Leaf, out: &mut Vec<&'a Leaf>) {
        out.push(leaf);
        match leaf {
            Leaf::LiteralVec(inner) => inner.iter().for_each(|l| nested(l, out)),
            Leaf::Scaled(inner, _) => inner.iter().for_each(|l| nested(l, out)),
            _ => {}
        }
    }
    let top = match node {
        Node::And(kids) | Node::Or(kids) => return kids.iter().flat_map(leaves).collect(),
        Node::Compare { left, right, .. } => vec![left, right],
        Node::In { needle, haystack } => haystack.iter().chain([needle]).collect(),
    };
    let mut out = Vec::new();
    top.into_iter().for_each(|l| nested(l, &mut out));
    out
}

/// Widen a `u32`, `u64` or `i128` to `i128`, for ordering and equality. Any other
/// `Val`, `i64`, `i32` and `u128` included, is not a number here.
fn val_to_i128(env: &Env, v: &Val) -> Option<i128> {
    let wide = |_| to::<u64>(env, v).map(i128::from);
    let small = to::<u32>(env, v).map(i128::from).or_else(wide);
    small.or_else(|_| to(env, v)).ok()
}

// ============================================================================
// Decoder
// ============================================================================

/// Errors that can be raised while decoding a predicate root from the
/// canonical ScVal wire format. On chain every one of them is reported as
/// `MALFORMED_PREDICATE` (201) by `install` and `enforce`; the variants exist
/// so tests can tell the causes apart.
#[derive(Debug, PartialEq, Eq, Clone)]
pub enum DecodeError {
    /// Empty / wrong-Variant / wrong-arity / unknown op or selector
    /// symbol / `in []` at decode.
    MalformedPredicate,
    /// Depth exceeded MAX_DEPTH (5), in the node tree or in a leaf's
    /// nesting.
    PredicateTooDeep,
    /// Leaf count exceeded MAX_LEAVES (200), or DISTINCT `read` calls exceeded
    /// MAX_READS (4).
    TooManyLeaves,
    /// An `in` haystack exceeded MAX_IN_OPERAND_COUNT (32).
    InOperandLimit,
    /// Predicate payload exceeded MAX_PREDICATE_BYTES (32 KB).
    PredicateTooLarge,
}

type Res<T> = Result<T, DecodeError>;
type Vals = soroban_sdk::Vec<Val>;

/// Decode a predicate root for `install`: the byte-size cap against the raw XDR
/// (the only place the payload length is still in hand), then the structure
/// (`decode_stored`), then the count caps (leaves / distinct `read`s).
pub fn decode(env: &Env, bytes: &Bytes) -> Result<Node, DecodeError> {
    let small = bytes.len() <= MAX_PREDICATE_BYTES;
    cap(small, DecodeError::PredicateTooLarge)?;
    let root_node = decode_stored(env, bytes)?;
    let all = leaves(&root_node);
    // Reads of the same `(contract, fn, args)` are one call (see `Memo`).
    let mut calls = Vec::new();
    for l in &all {
        match l {
            Leaf::Read(c, f, a, _) if !calls.contains(&(c, f, a)) => calls.push((c, f, a)),
            _ => {}
        }
    }
    let few = all.len() <= MAX_LEAVES as usize && calls.len() <= MAX_READS as usize;
    cap(few, DecodeError::TooManyLeaves)?;
    Ok(root_node)
}

/// Decode bytes `install` already accepted, for `enforce`: the structure and its
/// depth caps, without the byte and count caps (`install` is the only writer of
/// a stored predicate, and re-counting is most of what `enforce` would spend).
pub fn decode_stored(env: &Env, bytes: &Bytes) -> Result<Node, DecodeError> {
    let v = Val::from_xdr(env, bytes).map_err(|_| DecodeError::MalformedPredicate)?;
    decode_node(env, &to(env, &v)?, 1)
}

// ---- structural decoder ----

/// Decode one node `depth` levels down from the root (the root is 1); a node
/// deeper than `MAX_DEPTH` is refused before its children are decoded.
fn decode_node(env: &Env, items: &Vals, depth: u32) -> Res<Node> {
    cap(depth <= MAX_DEPTH, DecodeError::PredicateTooDeep)?;
    let head = expect::<Symbol>(env, items, 0)?;
    // Compare via PartialEq (works on wasm; Symbol has no ToString on the wasm
    // target because the SDK hides the underlying string representation
    // behind a host object).
    let is = |name: &str| head == Symbol::new(env, name);
    use CompareOp as C;
    let names = ["eq", "lt", "lte", "gt", "gte"];
    let mut ops = names.iter().zip([C::Eq, C::Lt, C::Lte, C::Gt, C::Gte]);
    if is("and") {
        decode_children(env, items, depth).map(Node::And)
    } else if is("or") {
        decode_children(env, items, depth).map(Node::Or)
    } else if is("in") {
        ensure(items.len() == 3)?;
        let needle = leaf_at(env, items, 1)?;
        let entries: Vals = expect(env, items, 2)?;
        ensure(!entries.is_empty())?;
        let short = entries.len() <= MAX_IN_OPERAND_COUNT;
        cap(short, DecodeError::InOperandLimit)?;
        let haystack = each(&entries, |h| literal(env, &h, 1))?;
        Ok(Node::In { needle, haystack })
    } else if let Some((_, op)) = ops.find(|(name, _)| is(name)) {
        ensure(items.len() == 3)?;
        let (left, right) = (leaf_at(env, items, 1)?, leaf_at(env, items, 2)?);
        // An ordering over an address, symbol or vector literal could never permit.
        ensure(op == CompareOp::Eq || !(non_number(&left) || non_number(&right)))?;
        Ok(Node::Compare { op, left, right })
    } else {
        // Bare selector tuples at a Node position are MALFORMED.
        Err(DecodeError::MalformedPredicate)
    }
}

/// Decode the child list shared by `and` and `or`. Both carry exactly one
/// operand, a non-empty vector of child tuples; an empty list is refused
/// so neither can degenerate into a node that permits (empty `and`) or
/// denies (empty `or`) regardless of the call.
fn decode_children(env: &Env, items: &Vals, depth: u32) -> Res<Vec<Node>> {
    ensure(items.len() == 2)?;
    let children: Vals = expect(env, items, 1)?;
    ensure(!children.is_empty())?;
    each(&children, |c| decode_node(env, &to(env, &c)?, depth + 1))
}

/// Decode every element of `vals`, failing on the first that does not.
fn each<T>(vals: &Vals, f: impl FnMut(Val) -> Res<T>) -> Res<Vec<T>> {
    vals.iter().map(f).collect()
}

fn leaf_at(env: &Env, items: &Vals, i: u32) -> Res<Leaf> {
    decode_leaf(env, &at(items, i)?, 1)
}

/// Decode one leaf. `depth` is how deeply it is nested inside other
/// leaves (a literal vector, a `scaled` operand), and is capped at
/// `MAX_DEPTH` so the decoder and the evaluator both recurse a bounded
/// number of times.
fn decode_leaf(env: &Env, val: &Val, depth: u32) -> Res<Leaf> {
    cap(depth <= MAX_DEPTH, DecodeError::PredicateTooDeep)?;
    // Selector tuples are `Vec<Val>` whose head is a `Symbol` (an unknown one is
    // refused). Literal vectors are `Vec<Val>` whose head is anything else.
    if let Ok(items) = Vals::try_from_val(env, val) {
        ensure(!items.is_empty())?;
        if let Ok(sym) = expect::<Symbol>(env, &items, 0) {
            return decode_selector_leaf(env, &items, sym, depth);
        }
        // Literal vector: order preserved verbatim.
        return each(&items, |e| literal(env, &e, depth + 1)).map(Leaf::LiteralVec);
    }
    // Bare literals.
    to(env, val)
        .map(Leaf::LiteralAddress)
        .or_else(|_| to(env, val).map(Leaf::LiteralSymbol))
        .or_else(|_| to(env, val).map(Leaf::LiteralU32))
        .or_else(|_| to(env, val).map(Leaf::LiteralI128))
}

/// A leaf that must be a constant: an `in` entry or a literal-vec element.
/// Anything else would decode, count toward the caps and the selector
/// check, and then never be compared.
fn literal(env: &Env, val: &Val, depth: u32) -> Res<Leaf> {
    let leaf = decode_leaf(env, val, depth)?;
    literal_to_val(env, &leaf).map(|_| leaf)
}
fn decode_selector_leaf(env: &Env, items: &Vals, head: Symbol, depth: u32) -> Res<Leaf> {
    let is = |n: u32, name: &str| items.len() == n && head == Symbol::new(env, name);
    let step = |i| expect(env, items, i).map(PathStep::Index);
    if is(1, "call_contract") {
        Ok(Leaf::CallContract)
    } else if is(1, "call_fn") {
        Ok(Leaf::CallFn)
    } else if is(1, "now") {
        Ok(Leaf::Now)
    } else if is(2, "call_arg") {
        Ok(Leaf::CallPath(vec![step(1)?]))
    } else if is(2, "call_arg_len") {
        Ok(Leaf::CallPath(vec![step(1)?, PathStep::Len]))
    } else if is(4, "call_arg_field") {
        let field = PathStep::Field(expect(env, items, 3)?);
        Ok(Leaf::CallPath(vec![step(1)?, step(2)?, field]))
    } else if is(items.len(), "call_path") {
        Ok(Leaf::CallPath(decode_steps(env, items, 1, 1)?))
    } else if is(items.len(), "read") {
        // (read, contract, fn, [args], step...). The contract and function
        // are fixed fields, so the predicate hash pins them. Arguments
        // must be literals: a selector, a `now`, another `read` or a
        // `scaled` has no `Val` form here and is refused.
        ensure(items.len() >= 4)?;
        let arg = |a| literal_to_val(env, &decode_leaf(env, &a, depth + 1)?);
        let target: Address = expect(env, items, 1)?;
        ensure(target.clone().to_xdr(env).get(7) == Some(1))?;
        Ok(Leaf::Read(
            target,
            expect(env, items, 2)?,
            Vals::from_slice(env, &each(&expect(env, items, 3)?, arg)?),
            decode_steps(env, items, 4, 0)?,
        ))
    } else if is(items.len(), "variant") {
        // (variant, name, payload...): an enum variant literal, which the host
        // holds as the vector `[name, payload...]` (Reflector's
        // `Asset::Stellar(addr)`). A bare vector headed by a symbol is read as
        // a selector, so a variant needs its own tag. Payload entries are
        // constants, like every other literal.
        let parts = each(&items.slice(1..), |p| literal(env, &p, depth + 1))?;
        ensure(matches!(parts.first(), Some(Leaf::LiteralSymbol(_))))?;
        Ok(Leaf::LiteralVec(parts))
    } else if is(5, "scaled") {
        // (scaled, src, num, den, add). `den` is a constant and must be
        // positive: zero cannot divide, and a negative one would flip the
        // sign of every bound it scales. A literal `src` or `num` is held
        // to the same rule, for the same reason (`src * num` commutes):
        // `-99/100` turns a floor into a ceiling that permits a zero
        // output. An operand that is read from the call or a contract
        // cannot be judged here; guard it in the rule (see the README).
        let den = expect::<i128>(env, items, 3)?;
        ensure((1..=MAX_DEN).contains(&den))?;
        let operand = |i| decode_leaf(env, &at(items, i)?, depth + 1);
        let leaves = [operand(1)?, operand(2)?, operand(4)?];
        let [s, n, a] = leaves.each_ref().map(constant);
        ensure(![s, n].iter().any(|v| v.is_some_and(|v| v <= 0)))?;
        let identity = |l: &Leaf| matches!(l, Leaf::CallContract | Leaf::CallFn);
        ensure(!leaves.iter().any(|l| non_number(l) || identity(l)))?;
        // A constant that overflows would deny every call: refuse it here. The
        // product and quotient do not depend on `add`, so they are folded even
        // when it varies (as `0`; the constant addend is folded too).
        let fold = s.zip(n).map(|(s, n)| scale(s, n, den, a.unwrap_or(0)));
        ensure(fold != Some(None))?;
        Ok(Leaf::Scaled(Box::new(leaves), den))
    } else {
        // Unknown symbol at a selector position -> MALFORMED.
        Err(DecodeError::MalformedPredicate)
    }
}

/// The path steps in `items[from..]`, at most `MAX_PATH_STEPS`. A step is
/// a u32 index or a symbol key; `true` marks the length step, which must
/// be last because a length has nothing to index into. Anything else is
/// refused here rather than reinterpreted at evaluate. `min` is the fewest
/// steps: `call_path` needs one; a `read` result may be the value itself.
fn decode_steps(env: &Env, items: &Vals, from: u32, min: u32) -> Res<Vec<PathStep>> {
    ensure((min..=MAX_PATH_STEPS).contains(&(items.len() - from)))?;
    let mut steps = Vec::new();
    for n in from..items.len() {
        steps.push(if let Ok(i) = expect(env, items, n) {
            PathStep::Index(i)
        } else if expect(env, items, n).unwrap_or(false) {
            ensure(n + 1 == items.len())?;
            PathStep::Len
        } else {
            PathStep::Field(expect(env, items, n)?)
        });
    }
    Ok(steps)
}

/// Decoder side: `Err(MalformedPredicate)` unless `ok` (the contract's `deny_unless` panics).
fn ensure(ok: bool) -> Res<()> {
    cap(ok, DecodeError::MalformedPredicate)
}

/// `Ok` when `ok`, else `err`.
fn cap(ok: bool, err: DecodeError) -> Res<()> {
    ok.then_some(()).ok_or(err)
}

fn at(items: &Vals, i: u32) -> Res<Val> {
    items.get(i).ok_or(DecodeError::MalformedPredicate)
}

/// `items[i]` as a `T`; a missing item or a different type is MALFORMED.
/// The decoder is the single place that pins operand type, so a `u32` is
/// never silently widened into an `i128` slot.
fn expect<T: TryFromVal<Env, Val>>(env: &Env, items: &Vals, i: u32) -> Res<T> {
    to(env, &at(items, i)?)
}

fn to<T: TryFromVal<Env, Val>>(env: &Env, v: &Val) -> Res<T> {
    T::try_from_val(env, v).map_err(|_| DecodeError::MalformedPredicate)
}
