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
pub use storage::{PolicyError, RuleKey, StoredDoc};
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
            storage::deny(e, storage::PolicyError::VersionMismatch);
        }

        // (a) Byte cap - reject before any parse work so the host never
        //     sees an oversized payload.
        if install_params.predicate.len() > dsl::MAX_PREDICATE_BYTES {
            storage::deny(e, storage::PolicyError::PredicateTooLarge);
        }

        // (b) Hash check - mandatory invariant #11. The caller supplies
        //     `sha256(predicate_bytes)` in `predicate_hash`; we recompute
        //     it against the raw bytes via the host's shа256 and refuse
        //     any mismatch. Closes the gap where a same-shape-but-
        //     different-bytes predicate could be installed under a stale
        //     hash.
        let computed_hash: BytesN<32> = e.crypto().sha256(&install_params.predicate).into();
        if computed_hash != install_params.predicate_hash {
            storage::deny(e, storage::PolicyError::PredicateHashMismatch);
        }

        // (c) Parse + decode - the host does the XDR work; we walk the
        //     resulting native `Vec<Val>`.
        let root = match dsl::decode_with_byte_cap(e, &install_params.predicate) {
            Ok(n) => n,
            Err(_) => storage::deny(e, storage::PolicyError::MalformedPredicate),
        };

        // (c2) Every rule that reaches storage carries a master set that can
        //      actually authorise a later install or uninstall.
        require_usable_signer_set(e, &context_rule.signers);

        // (d4) Minimum constraint. A predicate carrying no selector leaf -
        //      literals on both sides of every compare - is trivially true
        //      or trivially false at install time, so it would permit
        //      everything or nothing forever. Refuse it so a no-constraint
        //      policy cannot install under any name.
        if !dsl::has_selector_leaf(&root) {
            storage::deny(e, storage::PolicyError::SelectorLeafRequired);
        }

        // (d5) Slippage-floor ratios. A `call_arg_scaled` with `den == 0`
        //      would fail the division at evaluate; a non-positive ratio
        //      silently inverts the comparison, so a floor would permit the
        //      trades it was written to refuse. Refuse at install: both are
        //      properties of the predicate, knowable before it is stored.
        if dsl::validate_scaled_ratios(&root).is_err() {
            storage::deny(e, storage::PolicyError::InvalidScaledRatio);
        }

        let rule_id = context_rule.id;
        let key = storage::RuleKey::new(smart_account.clone(), rule_id);
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
                storage::deny(e, storage::PolicyError::MasterAuthRequired);
            }
        }
        if install_params.install_nonce != stored_nonce.saturating_add(1) {
            storage::deny(e, storage::PolicyError::NonceReplay);
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
            storage::deny(e, storage::PolicyError::NoAuthenticatedSigners);
        }

        let rule_id = context_rule.id;
        let key = storage::RuleKey::new(smart_account.clone(), rule_id);
        let doc: storage::StoredDoc = match e.storage().persistent().get(&key.doc_key()) {
            Some(d) => d,
            None => storage::deny(e, storage::PolicyError::MissingState),
        };
        let stored_signers_hash: BytesN<32> =
            match e.storage().persistent().get(&key.signers_hash_key()) {
                Some(h) => h,
                None => storage::deny(e, storage::PolicyError::MissingState),
            };
        let current_signers_hash = storage::sha256_of_signer_set(e, &context_rule.signers);
        if current_signers_hash != stored_signers_hash {
            storage::deny(e, storage::PolicyError::RuleSignersChanged);
        }

        let predicate_root = match dsl::decode_with_byte_cap(e, &doc.predicate_bytes) {
            Ok(n) => n,
            Err(_) => storage::deny(e, storage::PolicyError::MalformedPredicate),
        };

        // Before the predicate check. A deny panics and the host rolls this
        // back with the rest of the frame, so only a permit keeps the bump.
        state::extend_state_ttl(e, &key);

        let eval_ctx = state::build_eval_context(e, &context);
        match dsl::evaluate(e, &predicate_root, &eval_ctx) {
            dsl::EvalDecision::Permit => {}
            // Surface the SPECIFIC deny code so a review card can say
            // "not on the allowlist" rather than "predicate false"
            // (an argument mismatch). The mapping is
            // the canonical `DenyReason -> PolicyError` table in
            // `storage::PolicyError::from(DenyReason)`; `panic_deny_reason`
            // panics with that contract error so the host emits
            // `Error(Contract, N)` on the diagnostic event.
            dsl::EvalDecision::Deny(reason) => storage::deny(e, storage::PolicyError::from(reason)),
        }
    }

    pub fn uninstall(e: &Env, context_rule: ContextRule, smart_account: Address) {
        let rule_id = context_rule.id;
        let key = storage::RuleKey::new(smart_account.clone(), rule_id);
        let master_set: Vec<Signer> = match e.storage().persistent().get(&key.master_set_key()) {
            Some(s) => s,
            None => storage::deny(e, storage::PolicyError::MissingState),
        };
        auth::require_master(e, &master_set);
        if !e.storage().persistent().has(&key.doc_key()) {
            storage::deny(e, storage::PolicyError::MissingState);
        }
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
        let key = storage::RuleKey::new(smart_account.clone(), rule_id);
        let old_set: Vec<Signer> = match e.storage().persistent().get(&key.master_set_key()) {
            Some(s) => s,
            None => storage::deny(e, storage::PolicyError::MissingState),
        };
        auth::require_master(e, &old_set);
        // The same rules install applies. Rotating into a set that cannot
        //      authorise anything is unrecoverable: rotation and `uninstall`
        //      are both gated on `require_master`.
        require_usable_signer_set(e, &new_set);

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

/// Refuse a master signer set that could not authorise a later master-gated
/// call on this rule.
///
/// - Empty: `require_master` would call `require_auth` zero times, which is no
///   authorisation at all, so the rule would be unguardable. OZ permits a
///   context rule with no signers when it carries a policy, so this is
///   reachable rather than hypothetical.
/// - Oversized: `enforce` re-hashes the whole set on every permit and
///   `require_master` calls `require_auth` once per signer, so an unbounded set
///   pushes a permit past the CPU budget and bricks the rule.
/// - `External`: those signers carry a verifier address and a key, and OZ's
///   smart account checks the key. `require_master` only calls `require_auth`
///   on the verifier address, which a plain verifier contract never satisfies,
///   so such a set can never be authorised. Refusing is the fail-closed option;
///   the alternative is byte-for-byte parity with OZ's `VerifierClient::verify`.
fn require_usable_signer_set(e: &Env, signers: &Vec<Signer>) {
    if signers.is_empty() {
        storage::deny(e, storage::PolicyError::EmptySignerSet);
    }
    if signers.len() > MAX_SIGNERS {
        storage::deny(e, storage::PolicyError::TooManySigners);
    }
    if signers.iter().any(|s| matches!(s, Signer::External(_, _))) {
        storage::deny(e, storage::PolicyError::ExternalSignerNotSupported);
    }
}
