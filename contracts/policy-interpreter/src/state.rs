//! Eval-context construction, counter update on permit, counter wipe on
//! uninstall.

extern crate alloc;

use alloc::vec::Vec;
use soroban_sdk::{auth::Context, Address, Env, Symbol, Val, Vec as SorobanVec};

use crate::dsl::{Leaf, Node};
use crate::storage::{RuleKey, StoredDoc, TTL_BUMP_THRESHOLD, TTL_BUMP_TO};

// ---- public API -----

/// Build the eval context for an enforce call. Pulls `Address`/`Symbol`/
/// `Vec<Val>` directly from `Context::Contract` - host types pass through
/// without the byte-extraction helpers the ScVal path needed.
pub fn build_eval_context(
    e: &Env,
    context: &Context,
    doc: &StoredDoc,
    root: &Node,
    key: &RuleKey,
    smart_account: &Address,
) -> crate::dsl::EvalContext {
    let (contract, fn_name, args) = extract_call(e, context);
    let now_seconds = e.ledger().timestamp();
    let invocation_count_by_window = read_invocation_counts(e, key, root, now_seconds);
    crate::dsl::EvalContext {
        contract,
        fn_name,
        args,
        at_ledger: e.ledger().sequence(),
        valid_until_ledger: None,
        now_seconds,
        invocation_count_by_window,
        // Resolved before the walk so the evaluator makes no cross-contract
        // calls mid-predicate. A predicate with no oracle leaves resolves to
        // an empty snapshot and costs nothing.
        // Bounds were validated as tighten-only at install; a stored value
        // that no longer validates is treated as out of range and falls back
        // to denying rather than silently widening.
        oracle_price_by_asset: crate::oracle::resolve_snapshot(
            e,
            root,
            smart_account,
            match crate::oracle::Bounds::from_params(
                doc.oracle_max_staleness_seconds,
                doc.oracle_max_deviation_bps,
                doc.oracle_max_xfeed_dev_bps,
            ) {
                Ok(b) => b,
                Err(()) => crate::storage::panic_oracle_params_out_of_range(e),
            },
        ),
    }
}

/// Extend the TTL of every persistent entry this rule depends on.
///
/// Called BEFORE the predicate check. Counter keys are bumped INDEPENDENTLY
/// of the predicate doc: they live under different keys
/// (`(account, rule_id, window)` vs `(account, rule_id)`), so a doc that stays
/// fresh through frequent use would otherwise let an infrequently-touched
/// counter archive out from under it and reset the running total - a cap that
/// silently refills.
///
/// The doc, nonce, signers_hash, and master_set share ONE lifecycle: they
/// were all written at install, and `enforce` reads signers_hash on every
/// call while every master op reads nonce + master_set. Persistent entries
/// that archive cannot be read as absent and cannot be recreated (the
/// nonce check would loop the new install), so any one of those four
/// archiving bricks the rule. Bumping them together on every permit keeps
/// the rule alive as long as it is used.
///
/// Only the keys the predicate actually references are bumped for the
/// counter set, and only ones that exist: `extend_ttl` on a missing key
/// would panic.
///
/// The doc is bumped on the cheap threshold - pay for an extension only near
/// expiry. Counters are held at the full `TTL_BUMP_TO` instead, because a
/// counter is created at whatever ledger its first permit lands on and would
/// otherwise carry a much shorter life than the doc. A counter that archives
/// while its doc is still live resets to zero and the cap silently refills,
/// so counters must never expire first. The reverse order is safe: an
/// archived doc denies with missing state.
pub fn extend_state_ttl(e: &Env, root: &Node, key: &RuleKey) {
    let p = e.storage().persistent();
    let doc_key = key.doc_key();
    if p.has(&doc_key) {
        p.extend_ttl(&doc_key, TTL_BUMP_THRESHOLD, TTL_BUMP_TO);
    }
    for k in [
        key.nonce_key(),
        key.signers_hash_key(),
        key.master_set_key(),
    ] {
        if p.has(&k) {
            p.extend_ttl(&k, TTL_BUMP_THRESHOLD, TTL_BUMP_TO);
        }
    }
    for ws in collect_invocation_count_leaves(root) {
        let k = key.invocation_count_key(ws);
        if p.has(&k) {
            p.extend_ttl(&k, TTL_BUMP_TO, TTL_BUMP_TO);
        }
    }
}

/// On permit: increment `invocation_count(ws)` by 1. Checked-add; overflow
/// denies.
pub fn commit_state_updates(e: &Env, root: &Node, ctx: &crate::dsl::EvalContext, key: &RuleKey) {
    for ws in collect_invocation_count_leaves(root) {
        let k = key.invocation_count_key(ws);
        let stored: Option<(u64, u32)> = e.storage().persistent().get(&k);
        // A call landing after the window elapsed starts a fresh one at this
        // call, rather than adding to a total that never resets.
        let (start, current) = match stored {
            Some((start, count)) if !window_elapsed(ctx.now_seconds, start, ws) => (start, count),
            _ => (ctx.now_seconds, 0),
        };
        let new_count = match current.checked_add(1) {
            Some(n) => n,
            None => crate::storage::panic_predicate_false(e),
        };
        e.storage().persistent().set(&k, &(start, new_count));
        // A counter created on this call would otherwise carry the default
        // write TTL while the doc carries TTL_BUMP_TO, so it would archive
        // first and silently reset the running total.
        e.storage()
            .persistent()
            .extend_ttl(&k, TTL_BUMP_TO, TTL_BUMP_TO);
    }
}

/// Remove every `invocation_count` counter the stored predicate references.
/// Called by `uninstall`.
pub fn remove_all_counters(e: &Env, root: &Node, key: &RuleKey) {
    for ws in collect_invocation_count_leaves(root) {
        e.storage()
            .persistent()
            .remove(&key.invocation_count_key(ws));
    }
}

// ---- call extraction -----

fn extract_call(e: &Env, context: &Context) -> (Address, Symbol, SorobanVec<Val>) {
    match context {
        Context::Contract(c) => (c.contract.clone(), c.fn_name.clone(), c.args.clone()),
        // The interpreter is only invoked from a Contract auth context;
        // any other shape panics MISSING_STATE so the tx reverts cleanly.
        _ => crate::storage::panic_missing_state(e),
    }
}

// ---- state read helpers -----

/// Invocation counts per window, read back from the counters
/// `commit_state_updates` writes.
///
/// Each counter stores `(window_start, count)`. A window that has already
/// elapsed reads as ZERO rather than carrying its total forward - otherwise
/// `invocation_count_in_window(86400) <= 5` would mean "5 calls ever" and
/// the caller would be locked out permanently once it hit the cap.
fn read_invocation_counts(e: &Env, key: &RuleKey, root: &Node, now: u64) -> Vec<(u64, u32)> {
    let mut out: Vec<(u64, u32)> = Vec::new();
    for ws in collect_invocation_count_leaves(root) {
        let stored: Option<(u64, u32)> =
            e.storage().persistent().get(&key.invocation_count_key(ws));
        let count = match stored {
            Some((start, count)) if !window_elapsed(now, start, ws) => count,
            _ => 0,
        };
        out.push((ws, count));
    }
    out
}

/// True when `now` has moved past the window that began at `start`.
///
/// Saturating: a `now` before `start` (a ledger clock moving backwards)
/// yields 0 elapsed, which keeps the current window rather than silently
/// granting a fresh one.
fn window_elapsed(now: u64, start: u64, window_secs: u64) -> bool {
    now.saturating_sub(start) >= window_secs
}

// ---- AST walks ----

/// Distinct windows the predicate references.
///
/// Deduplicated deliberately: a window is a COUNTER, not an occurrence. A
/// predicate mentioning the same window in two clauses must still count a
/// call once - otherwise `commit_state_updates` increments it twice and a
/// "3 per day" cap silently becomes 1. That fails closed, but it is still
/// the wrong number, and the shape of a predicate should not change what a
/// cap means.
pub fn collect_invocation_count_leaves(node: &Node) -> Vec<u64> {
    let mut out: Vec<u64> = Vec::new();
    walk_ic(node, &mut out);
    out
}

fn walk_ic(node: &Node, out: &mut Vec<u64>) {
    match node {
        Node::And(children) | Node::Or(children) => {
            for c in children {
                walk_ic(c, out);
            }
        }
        Node::Not(inner) => walk_ic(inner, out),
        Node::Compare { left, right, .. } => {
            push_ic(out, left);
            push_ic(out, right);
        }
        Node::In { needle, haystack } => {
            push_ic(out, needle);
            for h in haystack {
                push_ic(out, h);
            }
        }
    }
}

fn push_ic(out: &mut Vec<u64>, leaf: &Leaf) {
    if let Leaf::InvocationCountInWindow { window_secs } = leaf {
        let ws = *window_secs;
        if !out.contains(&ws) {
            out.push(ws);
        }
    }
}

/// True when the AST contains a `ValidUntil` leaf anywhere.
///
/// The interpreter can never source `valid_until_ledger` (the smart account
/// is the only place expiry lives), so a predicate that uses it would
/// silently always deny. Refuse the install instead of letting the policy
/// install as a dead rule. Walks through `LiteralVec` for the same
/// smuggling reason as `dsl::collect_oracle_leaf` (F1): a `LiteralVec`
/// can wrap a `ValidUntil` and the install path must still see it.
pub fn contains_valid_until(node: &Node) -> bool {
    fn leaf_holds(leaf: &Leaf) -> bool {
        match leaf {
            Leaf::ValidUntil => true,
            Leaf::LiteralVec(elements) => elements.iter().any(leaf_holds),
            _ => false,
        }
    }
    match node {
        Node::And(children) | Node::Or(children) => children.iter().any(contains_valid_until),
        Node::Not(inner) => contains_valid_until(inner),
        Node::Compare { left, right, .. } => leaf_holds(left) || leaf_holds(right),
        Node::In { needle, haystack } => leaf_holds(needle) || haystack.iter().any(leaf_holds),
    }
}
