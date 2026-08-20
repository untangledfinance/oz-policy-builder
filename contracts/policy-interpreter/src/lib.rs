#![no_std]

//! Policy interpreter - the single audited Soroban contract that evaluates a
//! predicate supplied as install data.

extern crate alloc;

#[used]
#[allow(dead_code)]
static __SOROBAN_ALLOC_KEEP: alloc::vec::Vec<u8> = alloc::vec::Vec::new();

pub mod auth;
pub mod dsl;
#[cfg(test)]
mod dsl_tests;
pub mod state;
pub mod storage;
pub mod types;
mod version;

pub use dsl::{decode_with_byte_cap, CompareOp, DenyReason, EvalContext, EvalDecision, Leaf, Node};
pub use storage::{PolicyError, RuleKey, StoredDoc, StoredRule};
pub use types::{ContextRule, ContextRuleType, PolicyInstallParams, Signer};
pub use version::SELF_VERSION;

use soroban_sdk::{contract, contractimpl, Address, BytesN, Env, Vec};

use crate::types::MAX_SIGNERS;

#[contract]
pub struct PolicyInterpreter;

#[contractimpl]
impl PolicyInterpreter {
    pub fn grammar_version(_e: &Env) -> u32 {
        SELF_VERSION
    }

    pub fn install(
        e: &Env,
        install_params: PolicyInstallParams,
        context_rule: ContextRule,
        smart_account: Address,
    ) {
        if install_params.grammar_version != SELF_VERSION {
            storage::panic_version_mismatch(e);
        }

        // (a) Byte cap - reject before any parse work so the host never
        //     sees an oversized payload.
        if install_params.predicate.len() > dsl::MAX_PREDICATE_BYTES {
            storage::panic_predicate_too_large(e);
        }

        // (b) Hash check - mandatory invariant #11. The caller supplies
        //     `sha256(predicate_bytes)` in `predicate_hash`; we recompute
        //     it against the raw bytes via the host's shа256 and refuse
        //     any mismatch. Closes the gap where a same-shape-but-
        //     different-bytes predicate could be installed under a stale
        //     hash.
        let computed_hash: BytesN<32> = e.crypto().sha256(&install_params.predicate).into();
        if computed_hash != install_params.predicate_hash {
            storage::panic_predicate_hash_mismatch(e);
        }

        // (c) Parse + decode - the host does the XDR work; we walk the
        //     resulting native `Vec<Val>`.
        let root = match dsl::decode_with_byte_cap(e, &install_params.predicate) {
            Ok(n) => n,
            Err(_) => storage::panic_malformed_predicate(e),
        };

        // (c2) A rule with no signers pins no master, so nobody could ever
        //      authorise a future install on it - and `require_master` would
        //      pass vacuously. OZ allows such a rule when it carries a policy,
        //      so refuse it here rather than store an unguardable state.
        if context_rule.signers.is_empty() {
            storage::panic_empty_signer_set(e);
        }

        // (c2b) Cap the master signer set. `enforce` re-hashes the whole set
        //      on every permit and `require_master` calls `require_auth`
        //      once per signer; an unbounded set pushes a permit past the
        //      CPU budget and bricks the rule. The adjacent predicate write
        //      is already capped at `MAX_PREDICATE_BYTES` (32 KB) for the
        //      same shape of problem.
        if context_rule.signers.len() > MAX_SIGNERS {
            storage::panic_too_many_signers(e);
        }

        // (c3) External signers carry a verifier address AND a key; the key
        //      is what OZ's smart account checks when authenticating them.
        //      `require_master` only ever calls `signer.address().require_auth()`
        //      on the verifier, so a rule whose master set is External cannot
        //      be authorised (a plain verifier contract never satisfies
        //      require_auth). The simplest fail-closed option is to refuse
        //      External master signers at install and document the gap;
        //      reimplementing OZ's `VerifierClient::verify` protocol in v1
        //      would require byte-for-byte parity with that contract.
        if context_rule
            .signers
            .iter()
            .any(|s| matches!(s, Signer::External(_, _)))
        {
            storage::panic_external_signer_not_supported(e);
        }

        // (d) Distinct invocation-count windows. Each window is one
        //      persistent write per permit, and Soroban's per-tx write-entry
        //      cap is 50. A predicate over the cap installs today and
        //      fails every enforce ("write ledger entries: 52 > 50"). The
        //      bound lives here so the failure is loud at install rather
        //      than silent forever after.
        if state::collect_invocation_count_leaves(&root).len() as u32
            > dsl::MAX_INVOCATION_COUNT_WINDOWS
        {
            storage::panic_too_many_invocation_windows(e);
        }

        // (d2) Refuse a `ValidUntil` leaf. The interpreter never sources
        //      valid_until_ledger (the smart account owns expiry), so any
        //      policy using it would silently always deny. Refuse at
        //      install so the failure is loud rather than perpetual.
        if state::contains_valid_until(&root) {
            storage::panic_valid_until_not_supported(e);
        }

        // (d3) Slippage-floor ratios. A `call_arg_scaled` with `den == 0`
        //      would divide by zero at runtime; with `num <= 0` or
        //      `den <= 0` would silently invert the comparison. Refuse
        //      at install so the failure is loud rather than a perpetual
        //      runtime permitter/denier.
        if dsl::validate_scaled_ratios(&root).is_err() {
            storage::panic_invalid_scaled_ratio(e);
        }

        // (d4) Minimum constraint. A predicate carrying no selector leaf -
        //      literals on both sides of every compare - is trivially true
        //      or trivially false at install time, so it would permit
        //      everything or nothing forever. Refuse it so a no-constraint
        //      policy cannot install under any name.
        if !dsl::has_selector_leaf(&root) {
            storage::panic_selector_leaf_required(e);
        }

        let rule_id = context_rule.id;
        let key = storage::RuleKey::new(e, smart_account.clone(), rule_id);
        let prior_master: Option<Vec<Signer>> = e.storage().persistent().get(&key.master_set_key());
        let stored_nonce: u32 = e
            .storage()
            .persistent()
            .get(&key.nonce_key())
            .unwrap_or_default();

        // The smart account must authorise EVERY install, including the
        // first one on a fresh rule id. Without this, an attacker can
        // pre-seed any (smart_account, rule_id) with their own master
        // set + predicate; the legitimate owner then cannot install
        // (needs the squatter's auth) and cannot uninstall (same), so
        // that rule id is permanently poisoned. The later `require_master`
        // call covers re-installs on top of an existing master set.
        smart_account.require_auth();

        if let Some(ref stored_master) = prior_master {
            auth::require_master(e, stored_master);
            if !auth::signer_sets_equal(stored_master, &context_rule.signers) {
                storage::panic_master_auth_required(e);
            }
        }
        if install_params.install_nonce != stored_nonce.saturating_add(1) {
            storage::panic_nonce_replay(e);
        }

        let signers_hash = storage::sha256_of_signer_set(e, &context_rule.signers);
        let master_set = prior_master.unwrap_or_else(|| context_rule.signers.clone());

        e.storage().persistent().set(
            &key.doc_key(),
            &storage::StoredDoc {
                predicate_bytes: install_params.predicate,
            },
        );
        e.storage()
            .persistent()
            .set(&key.nonce_key(), &install_params.install_nonce);
        e.storage()
            .persistent()
            .set(&key.signers_hash_key(), &signers_hash);
        e.storage()
            .persistent()
            .set(&key.master_set_key(), &master_set);

        // Suppress unused-variable for the decoded root on the install path -
        // decode's side effect is the validation; the AST is rebuilt on
        // enforce from the stored bytes. Keeping the bind makes the intent
        // ('we just validated these bytes will parse') explicit.
        let _ = root;
    }

    pub fn enforce(
        e: &Env,
        context: soroban_sdk::auth::Context,
        authenticated_signers: Vec<Signer>,
        context_rule: ContextRule,
        smart_account: Address,
    ) {
        // `enforce` MUTATES state - it commits counters on every permit - so
        // it must be reachable only through the account it guards. Without
        // this, anyone could call it with a permitting context and burn the
        // agent's rate limit for the window, locking the legitimate caller
        // out. OpenZeppelin's own audited spending-limit policy opens with
        // the same requirement (accounts/src/policies/spending_limit.rs).
        smart_account.require_auth();

        // An enforcement that authenticated nobody is not an authorisation.
        // OZ rejects this too; the interpreter previously ignored the
        // argument entirely.
        if authenticated_signers.is_empty() {
            storage::panic_no_authenticated_signers(e);
        }

        let rule_id = context_rule.id;
        let key = storage::RuleKey::new(e, smart_account.clone(), rule_id);
        let doc: storage::StoredDoc = match e.storage().persistent().get(&key.doc_key()) {
            Some(d) => d,
            None => storage::panic_missing_state(e),
        };
        let stored_signers_hash: BytesN<32> =
            match e.storage().persistent().get(&key.signers_hash_key()) {
                Some(h) => h,
                None => storage::panic_missing_state(e),
            };
        let current_signers_hash = storage::sha256_of_signer_set(e, &context_rule.signers);
        if current_signers_hash != stored_signers_hash {
            storage::panic_rule_signers_changed(e);
        }

        let predicate_root = match dsl::decode_with_byte_cap(e, &doc.predicate_bytes) {
            Ok(n) => n,
            Err(_) => storage::panic_malformed_predicate(e),
        };

        // Before the predicate check. A deny panics and the host rolls this
        // back with the rest of the frame, so only a permit keeps the bump.
        state::extend_state_ttl(e, &predicate_root, &key);

        let eval_ctx =
            state::build_eval_context(e, &context, &doc, &predicate_root, &key, &smart_account);
        match dsl::evaluate(e, &predicate_root, &eval_ctx) {
            dsl::EvalDecision::Permit => {
                state::commit_state_updates(e, &predicate_root, &eval_ctx, &key);
            }
            // Surface the SPECIFIC deny code so a review card can say
            // "not on the allowlist" rather than "predicate false"
            // (an argument mismatch). The mapping is
            // the canonical `DenyReason -> PolicyError` table in
            // `storage::PolicyError::from(DenyReason)`; `panic_deny_reason`
            // panics with that contract error so the host emits
            // `Error(Contract, N)` on the diagnostic event.
            dsl::EvalDecision::Deny(reason) => storage::panic_deny_reason(e, reason),
        }
    }

    pub fn uninstall(e: &Env, context_rule: ContextRule, smart_account: Address) {
        let rule_id = context_rule.id;
        let key = storage::RuleKey::new(e, smart_account.clone(), rule_id);
        let master_set: Vec<Signer> = match e.storage().persistent().get(&key.master_set_key()) {
            Some(s) => s,
            None => storage::panic_missing_state(e),
        };
        auth::require_master(e, &master_set);
        let doc: storage::StoredDoc = match e.storage().persistent().get(&key.doc_key()) {
            Some(d) => d,
            None => storage::panic_missing_state(e),
        };
        let predicate_root = match dsl::decode_with_byte_cap(e, &doc.predicate_bytes) {
            Ok(n) => n,
            Err(_) => storage::panic_malformed_predicate(e),
        };
        state::remove_all_counters(e, &predicate_root, &key);
        e.storage().persistent().remove(&key.doc_key());
        e.storage().persistent().remove(&key.nonce_key());
        e.storage().persistent().remove(&key.signers_hash_key());
        e.storage().persistent().remove(&key.master_set_key());
    }

    pub fn rotate_master_signer_set(
        e: &Env,
        smart_account: Address,
        rule_id: u32,
        new_set: Vec<Signer>,
    ) {
        let key = storage::RuleKey::new(e, smart_account.clone(), rule_id);
        let old_set: Vec<Signer> = match e.storage().persistent().get(&key.master_set_key()) {
            Some(s) => s,
            None => storage::panic_missing_state(e),
        };
        auth::require_master(e, &old_set);
        // Rotating to an empty set would leave the rule permanently
        // unguardable - the same hole from the other direction.
        if new_set.is_empty() {
            storage::panic_empty_signer_set(e);
        }
        // Same cap `install` enforces: an oversized rotation pushes the
        // same brick via re-hash and per-signer `require_auth`.
        if new_set.len() > MAX_SIGNERS {
            storage::panic_too_many_signers(e);
        }
        // Same refusal `install` applies, for the same reason: `require_master`
        // only calls `require_auth` on the signer's address, which a plain
        // verifier contract never satisfies. Without this, a rule installed
        // with a valid set could be rotated into one nobody can authorise -
        // and since rotation and `uninstall` are both gated on
        // `require_master`, that state is unrecoverable.
        if new_set.iter().any(|s| matches!(s, Signer::External(_, _))) {
            storage::panic_external_signer_not_supported(e);
        }
        e.storage()
            .persistent()
            .set(&key.master_set_key(), &new_set);

        // `enforce` compares sha256(context_rule.signers) against the hash
        // stored at install, to catch the rule's signers changing behind the
        // policy's back. Rotation is the AUTHORISED way to change them, so
        // the stored hash has to move with it - otherwise every later
        // enforce denies RULE_SIGNERS_CHANGED and the rule is bricked.
        let rotated_hash = storage::sha256_of_signer_set(e, &new_set);
        e.storage()
            .persistent()
            .set(&key.signers_hash_key(), &rotated_hash);
    }
}
