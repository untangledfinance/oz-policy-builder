//! Eval-context construction and TTL upkeep for the rule's stored entries.
//!
//! The interpreter holds no per-call counters: every predicate leaf is
//! answered from the authorized call itself, so `enforce` reads no mutable
//! state and writes none. The only persistent entries are the ones install
//! wrote, and their lifetime is managed here.

use soroban_sdk::{auth::Context, Address, Env, Symbol, Val, Vec as SorobanVec};

use crate::storage::{RuleKey, StoredDoc, TTL_BUMP_THRESHOLD, TTL_BUMP_TO};

// ---- public API -----

/// Build the eval context for an enforce call. Pulls `Address`/`Symbol`/
/// `Vec<Val>` directly from `Context::Contract` - host types pass through
/// without the byte-extraction helpers the ScVal path needed.
pub fn build_eval_context(
    e: &Env,
    context: &Context,
    _doc: &StoredDoc,
    _smart_account: &Address,
) -> crate::dsl::EvalContext {
    let (contract, fn_name, args) = extract_call(e, context);
    crate::dsl::EvalContext {
        contract,
        fn_name,
        args,
        at_ledger: e.ledger().sequence(),
        now_seconds: e.ledger().timestamp(),
    }
}

/// Extend the TTL of every persistent entry this rule depends on.
///
/// Called BEFORE the predicate check. The doc, nonce, signers_hash, and
/// master_set share ONE lifecycle: they were all written at install, and
/// `enforce` reads signers_hash on every call while every master op reads
/// nonce + master_set. Persistent entries that archive cannot be read as
/// absent and cannot be recreated (the nonce check would loop the new
/// install), so any one of those four archiving bricks the rule. Bumping
/// them together on every permit keeps the rule alive as long as it is used.
///
/// Only keys that exist are bumped: `extend_ttl` on a missing key panics.
pub fn extend_state_ttl(e: &Env, key: &RuleKey) {
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
