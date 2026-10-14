//! Predicate DSL decoder and evaluator. The evaluator is pure except for the
//! `read` leaf, which calls the contract it names.
//!
//! The decoder ingests raw canonical ScVal XDR bytes via `Val::from_xdr`
//! (the host does the XDR parse), then walks the resulting `Vec<Val>` tree
//! with native soroban-sdk types. The AST holds host types so the
//! evaluator can compare `Address`/`Symbol`/`Bytes` directly without
//! byte-extraction helpers.

extern crate alloc;

use alloc::{boxed::Box, vec, vec::Vec};

use soroban_sdk::xdr::{FromXdr, ToXdr};
use soroban_sdk::{
    Address, Bytes, Env, Error, IntoVal, Map, Symbol, TryFromVal, Val, Vec as SorobanVec,
};

// ---- caps (mirrors TS PREDICATE_CAPS; the Rust side is authoritative) -----

pub const MAX_DEPTH: u32 = 5;
pub const MAX_LEAVES: u32 = 200;
pub const MAX_IN_OPERAND_COUNT: u32 = 32;
/// `read` leaves per predicate. Each is a cross-contract call made on every
/// `enforce`, so the count is capped at decode.
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
    Read(Address, Symbol, SorobanVec<Val>, Vec<PathStep>),
    /// `[src, num, add]` and `den`: `src * num / den + add`, multiplying
    /// first, truncating toward zero, every step checked. Each of the three
    /// operands is any value leaf, nested `Scaled` included; `den` is a
    /// constant, positive by decode. A literal `num` must be positive too.
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
    eval(env, node, ctx)
        .err()
        .map_or(EvalDecision::Permit, EvalDecision::Deny)
}

fn eval(env: &Env, node: &Node, ctx: &EvalContext) -> Result<(), DenyReason> {
    match node {
        Node::And(children) => children.iter().try_for_each(|c| eval(env, c, ctx)),
        // Permits on the first branch that holds; when none does, reports the
        // FIRST branch's deny. "First" is wire order, and the encoder sorts
        // `or` children canonically, so the reported reason is stable for a
        // given predicate rather than an artefact of which branch happened to
        // run last. It is deliberately not tied to authoring order - the
        // canonical encoding does not preserve that.
        Node::Or(children) => {
            let mut first_deny = None;
            for c in children {
                match eval(env, c, ctx) {
                    Err(reason) => first_deny = first_deny.or(Some(reason)),
                    permit => return permit,
                }
            }
            // An empty `or` is refused at decode, so this is unreachable in
            // practice; denying is the fail-closed answer if it ever is not.
            Err(first_deny.unwrap_or(DenyReason::UnsupportedNode))
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
            // so an ordering comparison over either is a node the interpreter
            // never supported - distinct from a value that merely failed to
            // match.
            if *op != CompareOp::Eq && matches!(left, Leaf::CallContract | Leaf::CallFn) {
                return Err(DenyReason::UnsupportedNode);
            }
            // A contract-scope miss is reported as its own reason so a review
            // card can say "wrong contract" rather than "argument mismatch".
            let miss = if matches!(left, Leaf::CallContract) {
                DenyReason::ContractScope
            } else {
                DenyReason::ArgMismatch
            };
            let (a, b) = (resolve(env, left, ctx)?, resolve(env, right, ctx)?);
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
        Node::In { needle, haystack } => resolve(env, needle, ctx)
            .is_ok_and(|x| {
                let mut hay = haystack.iter().filter_map(|h| literal_to_val(env, h));
                hay.any(|h| val_eq(env, &x, &h))
            })
            .then_some(())
            .ok_or(DenyReason::NotInAllowlist),
    }
}

/// Convert a literal leaf to its `Val` form for equality comparisons.
fn literal_to_val(env: &Env, leaf: &Leaf) -> Option<Val> {
    Some(match leaf {
        Leaf::LiteralAddress(a) => a.into_val(env),
        Leaf::LiteralI128(v) => (*v).into_val(env),
        Leaf::LiteralSymbol(s) => s.into_val(env),
        Leaf::LiteralU32(v) => (*v).into_val(env),
        Leaf::LiteralVec(elements) => {
            let vals: Option<Vec<Val>> = elements.iter().map(|e| literal_to_val(env, e)).collect();
            SorobanVec::from_slice(env, &vals?).into_val(env)
        }
        _ => return None,
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
fn val_eq(env: &Env, a: &Val, b: &Val) -> bool {
    let objects = a.is_object() || b.is_object();
    a.shallow_eq(b) || (objects && (*a).to_xdr(env) == (*b).to_xdr(env))
}

/// Resolve a leaf to the `Val` it denotes for the call under evaluation.
///
/// An `Err` is always a deny. `ArgMismatch` means the leaf named something
/// this call does not carry - an argument past the end, a shape other than the
/// leaf assumed, a read that failed or returned a non-number;
/// `ArithmeticOverflow` is a `scaled` step that did not fit.
fn resolve(env: &Env, leaf: &Leaf, ctx: &EvalContext) -> Result<Val, DenyReason> {
    let miss = DenyReason::ArgMismatch;
    Ok(match leaf {
        Leaf::CallContract => ctx.contract.clone().into_val(env),
        Leaf::CallFn => ctx.fn_name.clone().into_val(env),
        Leaf::CallPath(steps) => walk(env, ctx.args.clone().into_val(env), steps).ok_or(miss)?,
        Leaf::Now => env.ledger().timestamp().into_val(env),
        Leaf::Read(contract, func, args, steps) => env
            .try_invoke_contract::<Val, Error>(contract, func, args.clone())
            .ok()
            .and_then(|r| r.ok())
            .and_then(|v| walk(env, v, steps))
            .filter(|v| val_to_i128(env, v).is_some())
            .ok_or(miss)?,
        Leaf::Scaled(k, den) => {
            let n = |l: &Leaf| resolve(env, l, ctx).and_then(|v| val_to_i128(env, &v).ok_or(miss));
            let (src, num, add) = (n(&k[0])?, n(&k[1])?, n(&k[2])?);
            src.checked_mul(num)
                .and_then(|p| p.checked_div(*den))
                .and_then(|q| q.checked_add(add))
                .ok_or(DenyReason::ArithmeticOverflow)?
                .into_val(env)
        }
        _ => literal_to_val(env, leaf).ok_or(miss)?,
    })
}

/// Follow `steps` from `cur`; `None` when a step finds something else.
fn walk(env: &Env, cur: Val, steps: &[PathStep]) -> Option<Val> {
    let vec = |v: &Val| SorobanVec::<Val>::try_from_val(env, v).ok();
    steps.iter().try_fold(cur, |cur, step| {
        Some(match step {
            PathStep::Index(i) => vec(&cur)?.get(*i)?,
            PathStep::Field(f) => Map::<Symbol, Val>::try_from_val(env, &cur)
                .ok()?
                .get(f.clone())?,
            PathStep::Len => vec(&cur)?.len().into_val(env),
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
/// authorises. Recurses into `scaled` operands, since a selector inside one is
/// still a selector. `in` haystacks and literal vectors hold constants only
/// (the decoder refuses anything else), so they are not searched.
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
    match node {
        Node::And(children) | Node::Or(children) => children.iter().flat_map(leaves).collect(),
        Node::Compare { left, right, .. } => {
            let mut out = Vec::new();
            [left, right].into_iter().for_each(|l| nested(l, &mut out));
            out
        }
        Node::In { needle, haystack } => {
            let mut out = Vec::new();
            [needle]
                .into_iter()
                .chain(haystack)
                .for_each(|l| nested(l, &mut out));
            out
        }
    }
}

fn depth(node: &Node) -> u32 {
    match node {
        Node::And(children) | Node::Or(children) => {
            1 + children.iter().map(depth).max().unwrap_or(0)
        }
        _ => 1,
    }
}

/// Widen any integral `Val` the host may carry to `i128` for ordering.
fn val_to_i128(env: &Env, v: &Val) -> Option<i128> {
    let small = u32::try_from_val(env, v).map(i128::from).ok();
    let wide = || u64::try_from_val(env, v).map(i128::from).ok();
    small
        .or_else(wide)
        .or_else(|| i128::try_from_val(env, v).ok())
}

// ============================================================================
// Decoder
// ============================================================================

/// Errors that can be raised while decoding a predicate root from the
/// canonical ScVal wire format. Every variant maps to the matching wire
/// code via `code()`.
#[derive(Debug, PartialEq, Eq, Clone)]
pub enum DecodeError {
    /// Empty / wrong-Variant / wrong-arity / unknown op or selector
    /// symbol / `in []` at decode. Maps to `MALFORMED_PREDICATE`.
    MalformedPredicate,
    /// Depth exceeded MAX_DEPTH (5), in the node tree or in a leaf's
    /// nesting. Maps to `PREDICATE_TOO_DEEP`.
    PredicateTooDeep,
    /// Leaf count exceeded MAX_LEAVES (200), or `read` count exceeded
    /// MAX_READS (4). Maps to `TOO_MANY_LEAVES`.
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

type Res<T> = Result<T, DecodeError>;
type Vals = SorobanVec<Val>;

/// Decode a predicate root, checking the byte-size cap against the raw XDR
/// (the only place the payload length is still in hand) and then the cap trio
/// (depth / leaves / `read`s). `in` haystacks are capped as they decode.
pub fn decode(env: &Env, bytes: &Bytes) -> Result<Node, DecodeError> {
    if bytes.len() > MAX_PREDICATE_BYTES {
        return Err(DecodeError::PredicateTooLarge);
    }
    let v = Val::from_xdr(env, bytes).map_err(|_| DecodeError::MalformedPredicate)?;
    let root_node = decode_node(env, &to(env, &v)?)?;
    let all = leaves(&root_node);
    let reads = all.iter().filter(|l| matches!(l, Leaf::Read(..))).count();
    if depth(&root_node) > MAX_DEPTH {
        return Err(DecodeError::PredicateTooDeep);
    }
    if all.len() > MAX_LEAVES as usize || reads > MAX_READS as usize {
        return Err(DecodeError::TooManyLeaves);
    }
    Ok(root_node)
}

// ---- structural decoder ----

fn decode_node(env: &Env, items: &Vals) -> Res<Node> {
    let head = expect::<Symbol>(env, items, 0)?;
    // Compare via PartialEq (works on wasm; Symbol has no ToString on the wasm
    // target because the SDK hides the underlying string representation
    // behind a host object).
    let is = |name: &str| head == Symbol::new(env, name);
    let ops = [
        ("eq", CompareOp::Eq),
        ("lt", CompareOp::Lt),
        ("lte", CompareOp::Lte),
        ("gt", CompareOp::Gt),
        ("gte", CompareOp::Gte),
    ];
    if is("and") {
        decode_children(env, items).map(Node::And)
    } else if is("or") {
        decode_children(env, items).map(Node::Or)
    } else if is("in") {
        decode_in(env, items)
    } else if let Some((_, op)) = ops.into_iter().find(|(name, _)| is(name)) {
        ensure(items.len() == 3)?;
        let (left, right) = (leaf_at(env, items, 1)?, leaf_at(env, items, 2)?);
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
fn decode_children(env: &Env, items: &Vals) -> Res<Vec<Node>> {
    ensure(items.len() == 2)?;
    let children: Vals = expect(env, items, 1)?;
    ensure(!children.is_empty())?;
    each(&children, |c| decode_node(env, &to(env, &c)?))
}

/// Decode every element of `vals`, failing on the first that does not.
fn each<T>(vals: &Vals, f: impl FnMut(Val) -> Res<T>) -> Res<Vec<T>> {
    vals.iter().map(f).collect()
}

fn leaf_at(env: &Env, items: &Vals, i: u32) -> Res<Leaf> {
    decode_leaf(env, &at(items, i)?, 1)
}

fn decode_in(env: &Env, items: &Vals) -> Res<Node> {
    ensure(items.len() == 3)?;
    let needle = leaf_at(env, items, 1)?;
    let entries: Vals = expect(env, items, 2)?;
    ensure(!entries.is_empty())?;
    if entries.len() > MAX_IN_OPERAND_COUNT {
        return Err(DecodeError::InOperandLimit);
    }
    let haystack = each(&entries, |h| literal(env, &h, 1))?;
    Ok(Node::In { needle, haystack })
}

/// Decode one leaf. `depth` is how deeply it is nested inside other
/// leaves (a literal vector, a `scaled` operand), and is capped at
/// `MAX_DEPTH` so the decoder and the evaluator both recurse a bounded
/// number of times.
fn decode_leaf(env: &Env, val: &Val, depth: u32) -> Res<Leaf> {
    if depth > MAX_DEPTH {
        return Err(DecodeError::PredicateTooDeep);
    }
    // Selector tuples are `Vec<Val>` whose head is a `Symbol`. Literal
    // vectors are `Vec<Val>` whose head is NOT a known selector symbol.
    if let Ok(items) = SorobanVec::<Val>::try_from_val(env, val) {
        ensure(!items.is_empty())?;
        if let Ok(sym) = expect::<Symbol>(env, &items, 0) {
            return decode_selector_leaf(env, &items, sym, depth);
        }
        // Literal vector: order preserved verbatim.
        return each(&items, |e| literal(env, &e, depth + 1)).map(Leaf::LiteralVec);
    }
    // Bare literals.
    Address::try_from_val(env, val)
        .map(Leaf::LiteralAddress)
        .ok()
        .or_else(|| Symbol::try_from_val(env, val).map(Leaf::LiteralSymbol).ok())
        .or_else(|| u32::try_from_val(env, val).map(Leaf::LiteralU32).ok())
        .or_else(|| i128::try_from_val(env, val).map(Leaf::LiteralI128).ok())
        .ok_or(DecodeError::MalformedPredicate)
}

/// A leaf that must be a constant: an `in` entry or a literal-vec element.
/// Anything else would decode, count toward the caps and the selector
/// check, and then never be compared.
fn literal(env: &Env, val: &Val, depth: u32) -> Res<Leaf> {
    let leaf = decode_leaf(env, val, depth)?;
    literal_to_val(env, &leaf).ok_or(DecodeError::MalformedPredicate)?;
    Ok(leaf)
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
        let arg = |a: Val| {
            let leaf = decode_leaf(env, &a, depth + 1)?;
            literal_to_val(env, &leaf).ok_or(DecodeError::MalformedPredicate)
        };
        let args: Vals = expect(env, items, 3)?;
        Ok(Leaf::Read(
            expect(env, items, 1)?,
            expect(env, items, 2)?,
            SorobanVec::from_slice(env, &each(&args, arg)?),
            decode_steps(env, items, 4, 0)?,
        ))
    } else if is(5, "scaled") {
        // (scaled, src, num, den, add). `den` is a constant and must be
        // positive: zero cannot divide, and a negative one would flip the
        // sign of every bound it scales. A literal `src` or `num` is held
        // to the same rule, for the same reason (`src * num` commutes):
        // `-99/100` turns a floor into a ceiling that permits a zero
        // output. An operand that is read from the call or a contract
        // cannot be judged here; guard it in the rule (see the README).
        let den = expect::<i128>(env, items, 3)?;
        ensure(den > 0)?;
        let operand = |i| decode_leaf(env, &at(items, i)?, depth + 1);
        let leaves = [operand(1)?, operand(2)?, operand(4)?];
        let non_positive = |l: &Leaf| matches!(l, Leaf::LiteralI128(..=0) | Leaf::LiteralU32(0));
        ensure(!leaves[..2].iter().any(non_positive))?;
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

fn ensure(ok: bool) -> Res<()> {
    ok.then_some(()).ok_or(DecodeError::MalformedPredicate)
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
