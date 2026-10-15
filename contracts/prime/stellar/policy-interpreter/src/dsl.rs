//! Predicate DSL decoder and evaluator. The evaluator is pure except for the
//! `read` leaf, which calls the contract it names.
//!
//! The decoder ingests raw canonical ScVal XDR bytes via `Val::from_xdr`
//! (the host does the XDR parse), then walks the resulting `Vec<Val>` tree
//! with native soroban-sdk types. The AST holds host types so the
//! evaluator can compare `Address`/`Symbol`/`Bytes` directly without
//! byte-extraction helpers.

use alloc::{boxed::Box, vec, vec::Vec};

use soroban_sdk::xdr::{FromXdr, ScValType as T, ToXdr};
use soroban_sdk::{
    Address, Bytes, Duration, Env, Error, IntoVal, Map, MuxedAddress, Symbol, SymbolStr, Timepoint,
    TryFromVal, Val,
};

// ---- caps (mirrors TS PREDICATE_CAPS; the Rust side is authoritative) -----

pub const MAX_DEPTH: u32 = 5;
pub const MAX_LEAVES: u32 = 200;
pub const MAX_IN_OPERAND_COUNT: u32 = 32;
/// Distinct `read` calls per predicate. Each is a cross-contract call made when
/// `enforce` evaluates it (reads with the same constant arguments share one; a
/// read with a call-derived argument counts alone), so the count is capped at
/// decode and `enforce` makes at most this many external calls.
pub const MAX_READS: u32 = 4;
pub const MAX_PREDICATE_BYTES: u32 = 32 * 1024;
/// Elements a quantifier or `sum` visits; a longer vector denies. Decode counts
/// each leaf of a quantifier body this many times toward `MAX_LEAVES`, so the
/// worst-case work of one `enforce` stays bounded.
pub const MAX_ELEMS: u32 = 32;

// Tag and selector names come from the encoder verbatim (see
// `policy-synth/src/predicate/encode.ts`); an unknown one is fail-closed at
// decode time.
//
// `call_path` is a walk into the authorised call's arguments: each step is
// either a u32 index into a vector or a constant key into a map. `call_arg_field`
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
    Compare(CompareOp, Leaf, Leaf),
    /// `in(needle, entries)`, or `nin` when the flag is set: the needle resolves
    /// and equals one entry / none. An unresolved needle denies either way.
    In(Leaf, Vec<Leaf>, bool),
    /// `all(over, body)` / `any(over, body)`: `body` holds for every / some
    /// element of the vector `over` resolves to (`elem` leaves read the current
    /// one). `all` of nothing permits; `any` of nothing denies.
    Quant(bool, Leaf, Box<Node>),
}

#[derive(Debug, PartialEq, Eq, Copy, Clone)]
pub enum CompareOp {
    Eq,
    Ne,
    Lt,
    Lte,
    Gt,
    Gte,
}

/// One step of a `CallPath`: into a vector, or into a map.
#[derive(Debug, Clone)]
pub enum PathStep {
    Index(u32),
    /// A map key: a constant of any type (a bare symbol is the usual case;
    /// everything else is written `lit(x)`).
    Key(Val),
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
    /// contract and pick a field of the result with the same steps a `CallPath`
    /// takes. Each argument is a constant or a plain leaf resolved at `enforce`
    /// (a call path, `call_contract`, `call_fn` or `now`). Soroban has no
    /// read-only call, so the target must be a contract the policy owner
    /// trusts. A failed call, an argument that does not resolve, or a void
    /// result resolves to nothing, which denies.
    Read(Address, Symbol, Vec<Leaf>, Vec<PathStep>),
    /// `[src, num, add]` and `den`: `src * num / den + add`, multiplying
    /// first, truncating toward zero, every step checked. Each of the three
    /// operands is any value leaf, nested `Scaled` included; `den` is a
    /// constant in `1..=MAX_DEN`. A constant `src` or `num` must fold to a positive
    /// value, and a constant that overflows is refused.
    Scaled(Box<[Leaf; 3]>, i128),
    /// A constant of any type: `lit(x)` on the wire, or a bare address, symbol,
    /// number or vec of constants. Compared by value (`val_eq`).
    Lit(Val),
    /// The current element of the enclosing quantifier, walked by the steps
    /// (none: the element itself). Only a quantifier body may hold one.
    Elem(Vec<PathStep>),
    /// The `i128` sum of what the steps reach in each element of the vector the
    /// leaf resolves to: checked, and every element must be a number.
    Sum(Box<Leaf>, Vec<PathStep>),
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
pub fn evaluate(env: &Env, node: &Node, call: &EvalContext) -> EvalDecision {
    eval(env, node, &Ctx(call, ().into_val(env)), &mut Memo::new())
        .err()
        .map_or(EvalDecision::Permit, EvalDecision::Deny)
}

/// What a leaf resolves against: the authorised call (`.0`) and, inside a
/// quantifier body, the element being visited (`.1`, what `elem` reads).
struct Ctx<'a>(&'a EvalContext, Val);

/// The calls this evaluation has already made, keyed by `(contract, fn, args)`
/// and holding the raw result (`None` for a call that failed). A repeated read
/// reuses it, so a distinct call is made at most once per `enforce`.
type Memo = Vec<((Address, Symbol, Vals), Option<Val>)>;

// Decoder guarantees. The evaluator below relies on these and does not check
// them again; `decode` (install) and `decode_stored` (enforce) establish them,
// and `install` is the only writer of a stored predicate.
//
//  - `and` and `or` have at least one child; an `in` (and `nin`, which decodes to
//    `ne` against each entry) has 1..=32 entries, each a constant; a compare has
//    exactly two leaves; a quantifier has a vec leaf and a body node.
//  - An ordering compare (`lt`, `lte`, `gt`, `gte`) has no constant that is not a
//    number on either side, and `scaled` has none as an operand.
//  - A `scaled` has exactly three operands and `den` in 1..=MAX_DEN; a constant
//    `src` or `num` is positive, and a constant product or fold never overflows.
//  - A `read` target is a contract address, its arguments are constants or plain
//    leaves (never `elem`, `scaled`, `sum` or another `read`), and its path has at
//    most MAX_PATH_STEPS steps; a `call_path` has 1..=MAX_PATH_STEPS, with `Len`
//    only last.
//  - Node depth and leaf nesting are at most MAX_DEPTH, so recursion is bounded.
//  - Install only (not re-checked on enforce): at most MAX_LEAVES leaves, each leaf
//    of a quantifier body counted MAX_ELEMS times; `elem` only in a quantifier
//    body, and no `sum` or quantifier in one; at most MAX_READS distinct reads;
//    and at least one selector leaf. `install` also refuses more than
//    MAX_PREDICATE_BYTES bytes, before decoding.

fn eval(env: &Env, node: &Node, ctx: &Ctx, memo: &mut Memo) -> Result<(), DenyReason> {
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
        Node::Compare(op, left, right) => {
            // `call_contract` and `call_fn` name an identity, not a quantity,
            // so an ordering comparison over either, on either side, is a node
            // the interpreter never supported - distinct from a value that
            // merely failed to match.
            let sides = [left, right];
            let is_id = |l: &&Leaf| matches!(l, Leaf::CallContract | Leaf::CallFn);
            if !matches!(op, CompareOp::Eq | CompareOp::Ne) && sides.iter().any(is_id) {
                return Err(DenyReason::UnsupportedNode);
            }
            // A contract-scope miss is reported as its own reason so a review
            // card can say "wrong contract" rather than "argument mismatch".
            let miss = match sides.iter().any(|l| matches!(l, Leaf::CallContract)) {
                true => DenyReason::ContractScope,
                false => DenyReason::ArgMismatch,
            };
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
                CompareOp::Ne => !same(env, &a, &b, true),
                CompareOp::Lt => n(&a)? < n(&b)?,
                CompareOp::Lte => n(&a)? <= n(&b)?,
                CompareOp::Gt => n(&a)? > n(&b)?,
                CompareOp::Gte => n(&a)? >= n(&b)?,
            };
            pass.then_some(()).ok_or(miss)
        }
        // Short-circuits: `all` on the first element that fails (or cannot
        // resolve), `any` on the first that holds. `found` is whether that
        // element exists, and a permit needs it to be what the quantifier wants.
        Node::Quant(any, over, body) => {
            let items = elements(env, resolve(env, over, ctx, memo)?)?;
            let hit = |e| eval(env, body, &Ctx(ctx.0, e), memo).is_ok() == *any;
            let found = items.iter().any(hit);
            (found == *any).then_some(()).ok_or(DenyReason::ArgMismatch)
        }
        // An opaque or undecodable needle fails closed as a membership miss,
        // not an argument mismatch: it cannot be on the allowlist because it
        // cannot be compared at all.
        Node::In(needle, haystack, nin) => resolve(env, needle, ctx, memo)
            .is_ok_and(|x| {
                let hit = |h: &Val| same(env, &x, h, *nin);
                let mut hay = haystack.iter().filter_map(|h| literal_to_val(h).ok());
                hay.any(|h| hit(&h)) != *nin
            })
            .then_some(())
            .ok_or(match nin {
                true => DenyReason::ArgMismatch,
                false => DenyReason::NotInAllowlist,
            }),
    }
}

/// The `Val` of a constant leaf; anything else is MALFORMED.
fn literal_to_val(leaf: &Leaf) -> Res<Val> {
    match leaf {
        Leaf::Lit(v) => Ok(*v),
        _ => Err(DecodeError::MalformedPredicate),
    }
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
/// serialising, so this works on wasm, and `Bytes` compares by value. Two
/// vectors or two maps are compared by the host directly instead (below).
///
/// Two numbers (u32, u64, i128) compare as numbers, whatever their types, the
/// same widening ordering uses; `5u32` equals `5i128`. Only at the top level:
/// numbers inside a vector compare type included. Anything else is exact:
/// a number never equals a symbol, and an address only its own address.
fn val_eq(env: &Env, a: &Val, b: &Val) -> bool {
    // Two values of one type need no widening. `b` is only converted when `a` is
    // a number.
    if a.get_tag() != b.get_tag() {
        if let Some(same) = val_to_i128(env, a).and_then(|x| Some(x == val_to_i128(env, b)?)) {
            return same;
        }
    }
    // A vector or a map (the only kinds with no second representation) equals
    // only its own kind, by the host's structural compare. That allocates
    // nothing, where serialising allocates 20-70x the size, and a quantifier body
    // repeats it per element. Other objects keep the XDR compare: a "different
    // tags, so unequal" shortcut there would let a non-canonical form of one
    // value (a `U256Object` holding a small number) slip past `ne`.
    let coll = |v: &Val| matches!(v.get_tag().get_scval_type(), Some(T::Vec | T::Map));
    if coll(a) || coll(b) {
        return a.get_tag() == b.get_tag()
            && Vals::from_slice(env, &[*a]) == Vals::from_slice(env, &[*b]);
    }
    let objects = a.is_object() || b.is_object();
    a.shallow_eq(b) || (objects && (*a).to_xdr(env) == (*b).to_xdr(env))
}

/// `val_eq`, and with `muxed` also equal once each side is de-muxed: the test
/// behind `ne` and `nin`. The second compare only runs when a side IS a muxed
/// address, so an ordinary value is compared (and serialised) once.
fn same(env: &Env, a: &Val, b: &Val, muxed: bool) -> bool {
    let mux = |v: &Val| v.get_tag() as u8 == MUXED_ADDRESS_TAG;
    val_eq(env, a, b)
        || (muxed && (mux(a) || mux(b)) && val_eq(env, &demux(env, *a), &demux(env, *b)))
}

/// The host's tag for a muxed address object (`Tag::MuxedAddressObject`, which
/// the SDK does not export). Its scalar type is `Address`, as a plain address's is.
const MUXED_ADDRESS_TAG: u8 = 78;

/// A muxed address as the account it pays. `ne` (so `nin`) must not be passed by
/// adding a mux id to a listed account, which a SEP-41 `transfer` accepts for its
/// recipient; `eq` and `in` stay exact, so a pinned `M(exchange, id)` matches only
/// that id. Any other value, a plain address included, is returned as it is.
fn demux(env: &Env, v: Val) -> Val {
    MuxedAddress::try_from_val(env, &v).map_or(v, |m| m.address().to_val())
}

/// Resolve a leaf to the `Val` it denotes for the call under evaluation.
///
/// An `Err` is always a deny. `ArgMismatch` means the leaf named something
/// this call does not carry - an argument past the end, a shape other than the
/// leaf assumed, a read that failed or returned a non-number;
/// `ArithmeticOverflow` is a `scaled` step that did not fit.
fn resolve(env: &Env, leaf: &Leaf, ctx: &Ctx, memo: &mut Memo) -> Result<Val, DenyReason> {
    let miss = DenyReason::ArgMismatch;
    Ok(match leaf {
        Leaf::CallContract => ctx.0.contract.clone().into_val(env),
        Leaf::CallFn => ctx.0.fn_name.clone().into_val(env),
        Leaf::CallPath(steps) => walk(env, ctx.0.args.clone().into_val(env), steps).ok_or(miss)?,
        Leaf::Now => env.ledger().timestamp().into_val(env),
        Leaf::Read(c, f, a, steps) => {
            let args: Result<Vec<Val>, _> = a.iter().map(|l| resolve(env, l, ctx, memo)).collect();
            let args = Vals::from_slice(env, &args?);
            let key = (c.clone(), f.clone(), args.clone());
            let hit = memo.iter().find(|r| r.0 == key).map(|r| r.1);
            let raw = hit.unwrap_or_else(|| {
                let call = env.try_invoke_contract::<Val, Error>(c, f, args);
                let raw = call.ok().and_then(|r| r.ok());
                memo.push((key, raw));
                raw
            });
            let v = raw.and_then(|v| walk(env, v, steps));
            v.filter(|v| !v.is_void()).ok_or(miss)?
        }
        Leaf::Elem(steps) => walk(env, ctx.1, steps).ok_or(miss)?,
        Leaf::Sum(src, steps) => {
            let items = elements(env, resolve(env, src, ctx, memo)?)?;
            let add = |t: i128, e: Val| {
                let x = walk(env, e, steps).and_then(|x| val_to_i128(env, &x));
                t.checked_add(x.ok_or(miss)?)
                    .ok_or(DenyReason::ArithmeticOverflow)
            };
            items.iter().try_fold(0, add)?.into_val(env)
        }
        Leaf::Scaled(k, den) => {
            let mut n = |l: &Leaf| val_to_i128(env, &resolve(env, l, ctx, memo)?).ok_or(miss);
            let scaled = scale(n(&k[0])?, n(&k[1])?, *den, n(&k[2])?);
            scaled.ok_or(DenyReason::ArithmeticOverflow)?.into_val(env)
        }
        Leaf::Lit(v) => *v,
    })
}

/// The elements of the vector `leaf` resolves to, at most `MAX_ELEMS` of them.
fn elements(env: &Env, v: Val) -> Result<Vals, DenyReason> {
    let items = to::<Vals>(env, &v).ok().filter(|v| v.len() <= MAX_ELEMS);
    items.ok_or(DenyReason::ArgMismatch)
}

/// `src * num / den + add`: multiply, divide (truncating toward zero), add, each
/// step checked.
fn scale(src: i128, num: i128, den: i128, add: i128) -> Option<i128> {
    src.checked_mul(num)?.checked_div(den)?.checked_add(add)
}

/// A constant that is not a number: it has no order and cannot be scaled. (An
/// identity selector is refused as a `scaled` operand too, but an ordering over
/// one is still decided at `enforce`.)
fn non_number(env: &Env, leaf: &Leaf) -> bool {
    matches!(leaf, Leaf::Lit(v) if val_to_i128(env, v).is_none())
}

/// The value of a leaf made of literals alone; `None` for anything that
/// depends on the call, the clock or another contract, and for a fold that
/// overflows (decode refuses that one, so a nested constant never does).
fn constant(env: &Env, leaf: &Leaf) -> Option<i128> {
    match leaf {
        Leaf::Lit(v) => val_to_i128(env, v),
        Leaf::Scaled(k, d) => {
            let c = |l| constant(env, l);
            scale(c(&k[0])?, c(&k[1])?, *d, c(&k[2])?)
        }
        _ => None,
    }
}

/// Follow `steps` from `cur`; `None` when a step finds something else.
fn walk(env: &Env, cur: Val, steps: &[PathStep]) -> Option<Val> {
    steps.iter().try_fold(cur, |cur, step| {
        Some(match step {
            PathStep::Index(i) => to::<Vals>(env, &cur).ok()?.get(*i)?,
            PathStep::Key(k) => to::<Map<Val, Val>>(env, &cur).ok()?.get(*k)?,
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
    leaves(root).iter().any(|(l, _)| selects(l))
}

/// Every leaf of the tree, nested `scaled` operands and `read` arguments
/// included, each with its weight: how many times evaluation may reach it, which
/// is `MAX_ELEMS` for every leaf of a quantifier body, `MAX_ELEMS` for a `sum`
/// (it walks that many elements), and 1 elsewhere.
fn leaves(node: &Node) -> Vec<(&Leaf, u32)> {
    fn nested<'a>(leaf: &'a Leaf, w: u32, out: &mut Vec<(&'a Leaf, u32)>) {
        // A `sum` walks up to MAX_ELEMS elements, so it weighs that much itself.
        let sum = matches!(leaf, Leaf::Sum(..));
        out.push((leaf, if sum { w * MAX_ELEMS } else { w }));
        match leaf {
            Leaf::Scaled(inner, _) => inner.iter().for_each(|l| nested(l, w, out)),
            Leaf::Read(_, _, args, _) => args.iter().for_each(|l| nested(l, w, out)),
            Leaf::Sum(src, _) => nested(src, w, out),
            _ => {}
        }
    }
    let mut out = Vec::new();
    let top = match node {
        Node::And(kids) | Node::Or(kids) => return kids.iter().flat_map(leaves).collect(),
        Node::Compare(_, left, right) => vec![left, right],
        Node::In(needle, haystack, _) => haystack.iter().chain([needle]).collect(),
        Node::Quant(_, over, body) => {
            out.extend(leaves(body).into_iter().map(|(l, w)| (l, w * MAX_ELEMS)));
            vec![over]
        }
    };
    top.into_iter().for_each(|l| nested(l, 1, &mut out));
    out
}

/// Widen any integer `Val` to `i128`, for ordering and equality: `u32`, `i32`,
/// `u64`, `i64`, `Timepoint`, `Duration`, `i128`, and `u128` when it fits. Any
/// other `Val` (a `u128` above `i128::MAX` included) is not a number here.
fn val_to_i128(env: &Env, v: &Val) -> Option<i128> {
    // One conversion, chosen by the value's type (a failed `to::<T>` costs about
    // 300 instructions, so trying each in turn is not free).
    match v.get_tag().get_scval_type()? {
        T::U32 => to::<u32>(env, v).ok().map(i128::from),
        T::I32 => to::<i32>(env, v).ok().map(i128::from),
        T::U64 => to::<u64>(env, v).ok().map(i128::from),
        T::I64 => to::<i64>(env, v).ok().map(i128::from),
        T::Timepoint => to::<Timepoint>(env, v).ok().map(|t| t.to_unix().into()),
        T::Duration => to::<Duration>(env, v).ok().map(|d| d.to_seconds().into()),
        T::U128 => to::<u128>(env, v).ok().and_then(|x| x.try_into().ok()),
        T::I128 => to::<i128>(env, v).ok(),
        _ => None,
    }
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
}

type Res<T> = Result<T, DecodeError>;
type Vals = soroban_sdk::Vec<Val>;

/// Decode a predicate root for `install`: the structure (`decode_stored`), then
/// the count caps (leaves / distinct `read`s). The byte cap is `install`'s, which
/// refuses an oversized payload (207) before it hashes or decodes it.
pub fn decode(env: &Env, bytes: &Bytes) -> Result<Node, DecodeError> {
    let root_node = decode_stored(env, bytes)?;
    let all = leaves(&root_node);
    // Reads of the same `(contract, fn, constant args)` are one call (see `Memo`).
    // A read with a call-derived argument is its own call: its arguments resolve
    // at `enforce`, and are the same for every use of that leaf.
    let mut calls = Vec::new();
    for (l, _) in &all {
        let Leaf::Read(c, f, a, _) = l else { continue };
        let fixed: Option<Vec<Val>> = a.iter().map(|l| literal_to_val(l).ok()).collect();
        let key = (c, f, fixed.map(|v| Vals::from_slice(env, &v)));
        if key.2.is_none() || !calls.contains(&key) {
            calls.push(key);
        }
    }
    // `elem` only in a quantifier body (weight `MAX_ELEMS`); a `sum` only outside
    // one (its own weight is `MAX_ELEMS`), and a nested quantifier never.
    let placed = |(l, w): &(&Leaf, u32)| match l {
        Leaf::Elem(_) => *w == MAX_ELEMS,
        Leaf::Sum(..) => *w == MAX_ELEMS,
        _ => *w <= MAX_ELEMS,
    };
    ensure(all.iter().all(placed))?;
    let weight: u32 = all.iter().map(|(_, w)| w).sum();
    let few = weight <= MAX_LEAVES && calls.len() <= MAX_READS as usize;
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
    let head = spelled(env, &expect(env, items, 0)?)?;
    let leaf = |i| decode_leaf(env, &at(items, i)?, 1);
    use CompareOp as C;
    let ops = [("eq", C::Eq), ("ne", C::Ne), ("lt", C::Lt), ("lte", C::Lte)];
    let ops = ops.into_iter().chain([("gt", C::Gt), ("gte", C::Gte)]);
    let name: &[u8] = head.as_ref();
    let op = ops.into_iter().find(|(n, _)| n.as_bytes() == name);
    // A node is its name and, except for `and` and `or`, two operands.
    Ok(match (name, items.len(), op) {
        (b"and", _, _) => Node::And(decode_children(env, items, depth)?),
        (b"or", _, _) => Node::Or(decode_children(env, items, depth)?),
        (b"in" | b"nin", 3, _) => {
            let needle = leaf(1)?;
            let entries: Vals = expect(env, items, 2)?;
            ensure(!entries.is_empty())?;
            cap(
                entries.len() <= MAX_IN_OPERAND_COUNT,
                DecodeError::InOperandLimit,
            )?;
            let haystack = each(&entries, |h| literal(env, &h, 1).map(Leaf::Lit))?;
            Node::In(needle, haystack, name == b"nin")
        }
        (b"all" | b"any", 3, _) => {
            let body = decode_node(env, &expect(env, items, 2)?, depth + 1)?;
            Node::Quant(name == b"any", leaf(1)?, Box::new(body))
        }
        (_, 3, Some((_, op))) => {
            let (left, right) = (leaf(1)?, leaf(2)?);
            // An ordering over an address, symbol or vector literal could never permit.
            let order = !matches!(op, C::Eq | C::Ne);
            ensure(!order || !(non_number(env, &left) || non_number(env, &right)))?;
            Node::Compare(op, left, right)
        }
        // Bare selector tuples at a Node position are MALFORMED.
        _ => return Err(DecodeError::MalformedPredicate),
    })
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
            return decode_selector_leaf(env, &items, spelled(env, &sym)?.as_ref(), depth);
        }
        // A bare vec of constants is its own value: checked, not rebuilt (building
        // a host vec one push at a time is quadratic in its length).
        each(&items, |e| plain(env, &e, depth + 1))?;
        return Ok(Leaf::Lit(*val));
    }
    // Any other bare value is a constant.
    Ok(Leaf::Lit(*val))
}

/// A leaf that must be a constant: an `in` entry, or a path-step key. A vector
/// goes through `decode_leaf` (so `lit(x)` works); anything else is itself.
fn literal(env: &Env, val: &Val, depth: u32) -> Res<Val> {
    cap(depth <= MAX_DEPTH, DecodeError::PredicateTooDeep)?;
    match Vals::try_from_val(env, val) {
        Err(_) => Ok(*val),
        Ok(_) => literal_to_val(&decode_leaf(env, val, depth)?),
    }
}

/// An element of a bare vec constant: a value, or a non-empty vec that does not
/// start with a symbol (that would read as a selector; write `lit([...])` for a
/// whole constant that does), all the way down. Decoding each element as a leaf
/// costs about 35k instructions apiece, so nothing here does.
fn plain(env: &Env, val: &Val, depth: u32) -> Res<()> {
    cap(depth <= MAX_DEPTH, DecodeError::PredicateTooDeep)?;
    let Ok(items) = Vals::try_from_val(env, val) else {
        return Ok(());
    };
    ensure(!items.is_empty() && expect::<Symbol>(env, &items, 0).is_err())?;
    each(&items, |e| plain(env, &e, depth + 1)).map(|_| ())
}

/// A symbol's characters, read once. Comparing a symbol with `Symbol::new(name)`
/// instead costs a host call per name tried, and a leaf tries up to a dozen.
fn spelled(env: &Env, sym: &Symbol) -> Res<SymbolStr> {
    SymbolStr::try_from_val(env, &sym.to_symbol_val()).map_err(|_| DecodeError::MalformedPredicate)
}

// Not inlined: folded into `decode_leaf` it makes every leaf, a scalar included,
// pay for the whole frame (about 35k instructions instead of 13k).
#[inline(never)]
fn decode_selector_leaf(env: &Env, items: &Vals, head: &[u8], depth: u32) -> Res<Leaf> {
    let step = |i| expect(env, items, i).map(PathStep::Index);
    let steps = |from, min| decode_steps(env, items, from, min);
    Ok(match (head, items.len()) {
        (b"call_contract", 1) => Leaf::CallContract,
        (b"call_fn", 1) => Leaf::CallFn,
        (b"now", 1) => Leaf::Now,
        (b"call_arg", 2) => Leaf::CallPath(vec![step(1)?]),
        (b"call_arg_len", 2) => Leaf::CallPath(vec![step(1)?, PathStep::Len]),
        (b"call_arg_field", 4) => Leaf::CallPath([vec![step(1)?, step(2)?], steps(3, 1)?].concat()),
        (b"call_path", _) => Leaf::CallPath(steps(1, 1)?),
        (b"read", _) => {
            // (read, contract, fn, [args], step...). The contract and function
            // are fixed fields, so the predicate hash pins them. An argument is a
            // constant or a leaf with nothing nested in it that resolves at
            // `enforce` from the call or the clock; `elem`, `sum`, `scaled` and
            // another `read` are refused (the call count and the cost would no
            // longer be bounded by the predicate alone).
            let arg = |a| {
                let leaf = decode_leaf(env, &a, depth + 1)?;
                let ok = matches!(leaf, Leaf::Lit(_) | Leaf::CallPath(_) | Leaf::Now);
                ensure(ok || matches!(leaf, Leaf::CallContract | Leaf::CallFn)).map(|_| leaf)
            };
            let target: Address = expect(env, items, 1)?;
            ensure(target.clone().to_xdr(env).get(7) == Some(1))?;
            let (f, args) = (expect(env, items, 2)?, each(&expect(env, items, 3)?, arg)?);
            Leaf::Read(target, f, args, steps(4, 0)?)
        }
        (b"scaled", 5) => {
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
            let [s, n, a] = leaves.each_ref().map(|l| constant(env, l));
            ensure(![s, n].iter().any(|v| v.is_some_and(|v| v <= 0)))?;
            let identity = |l: &Leaf| matches!(l, Leaf::CallContract | Leaf::CallFn);
            ensure(!leaves.iter().any(|l| non_number(env, l) || identity(l)))?;
            // A constant that overflows would deny every call: refuse it here. The
            // product and quotient do not depend on `add`, so they are folded even
            // when it varies (as `0`; the constant addend is folded too).
            let fold = s.zip(n).map(|(s, n)| scale(s, n, den, a.unwrap_or(0)));
            ensure(fold != Some(None))?;
            Leaf::Scaled(Box::new(leaves), den)
        }
        (b"elem", _) => Leaf::Elem(steps(1, 0)?),
        // (sum, vec, step...): the vec is any leaf; the steps reach the number
        // inside each element (none: the element is the number).
        (b"sum", _) => {
            let src = decode_leaf(env, &at(items, 1)?, depth + 1)?;
            Leaf::Sum(Box::new(src), steps(2, 0)?)
        }
        (b"lit", 2) => Leaf::Lit(at(items, 1)?),
        // Unknown symbol at a selector position -> MALFORMED.
        _ => return Err(DecodeError::MalformedPredicate),
    })
}

/// The path steps in `items[from..]`, at most `MAX_PATH_STEPS`. A step is
/// a u32 index, `true` (the length step, which must be last because a length
/// has nothing to index into), or a constant map key: a bare symbol or any
/// `lit(x)`. Anything else is refused here rather than reinterpreted at evaluate. `min` is the fewest
/// steps: `call_path` needs one; a `read` result may be the value itself.
fn decode_steps(env: &Env, items: &Vals, from: u32, min: u32) -> Res<Vec<PathStep>> {
    ensure((min..=MAX_PATH_STEPS).contains(&items.len().saturating_sub(from)))?;
    let key = |n| literal(env, &at(items, n)?, 1).map(PathStep::Key);
    (from..items.len())
        .map(|n| match expect(env, items, n) {
            Ok(i) => Ok(PathStep::Index(i)),
            _ if expect(env, items, n) != Ok(true) => key(n),
            _ => ensure(n + 1 == items.len()).map(|_| PathStep::Len),
        })
        .collect()
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
