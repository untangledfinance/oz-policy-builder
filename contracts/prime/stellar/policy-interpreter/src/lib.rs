#![no_std]

//! Policy interpreter - the single audited Soroban contract that evaluates a
//! predicate supplied as install data.

extern crate alloc;

#[used]
#[allow(dead_code)]
static __SOROBAN_ALLOC_KEEP: alloc::vec::Vec<u8> = alloc::vec::Vec::new();

pub mod dsl;
#[cfg(test)]
mod dsl_tests;
pub mod storage;
#[cfg(test)]
mod test;
pub mod types;

pub use dsl::{CompareOp, DenyReason, EvalContext, EvalDecision, Leaf, Node};
pub use storage::{PolicyError, RuleKey, StoredDoc};
pub use types::{ContextRule, ContextRuleType, PolicyInstallParams, Signer};

use soroban_sdk::{auth::Context, contract, contractimpl, Address, BytesN, Env, IntoVal, Vec};

use crate::types::MAX_SIGNERS;

/// Grammar version this interpreter implements. A new condition type means a
/// new grammar version, which means a new interpreter at a new address - never
/// an upgrade of this one.
///
/// Bumped to 2 when the `oracle_price` / `oracle_threshold` leaves were
/// retired, then to 3 when the grammar was reduced to what the synthesiser
/// actually emits. Removing a leaf variant changes the predicate wire format,
/// so any previously-installed doc carrying a retired variant is refused at
/// install by the version mismatch gate. See `dsl.rs` for the current grammar.
///
/// Bumped to 4 when `or`, `lt`, `gt`, `gte` and the `call_arg_scaled` leaf
/// were added. Widening the grammar rather than narrowing it means a v3
/// document would still decode here, but the version gate refuses it anyway:
/// a v3 builder cannot know whether the interpreter it is addressing speaks
/// the wider grammar, and letting it guess is how a policy silently means
/// something other than what its author reviewed.
///
/// Bumped to 5 when the Policy Signer role was separated from the operators.
/// The predicate grammar is unchanged, but the install ABI is not:
/// `PolicyInstallParams` gained `policy_admins`, so a v4 builder's install
/// document no longer describes what this contract stores. The version gate
/// refuses the skew before a half-understood install can appoint an admin
/// set the author never reviewed.
///
/// Bumped to 6 when the predicate learned to address a BATCH. Grammar 5 is
/// handed a flattened projection of one call and pins amounts by slot index;
/// `call_path` reaches into the request itself, so a rule names the call, the
/// argument and the field it means - and can therefore tie two arguments of a
/// batch to each other, which a projection cannot express. The wire format of
/// a predicate changes with it, so a v5 document does not decode here and the
/// version gate refuses it.
///
/// Bumped to 7 when the predicate learned to read other contracts and the
/// clock. `read(contract, fn, args, path)` calls a fixed function of a fixed
/// contract with literal arguments; `now` is the ledger timestamp; and
/// `scaled(src, num, den, add)` replaces `call_arg_scaled(index, num, den)`
/// with a computed value over any value leaf. `call_arg_scaled` no longer
/// decodes, so a v6 document is refused by the version gate. `enforce` now
/// performs cross-contract calls, which v6 never did.
pub const SELF_VERSION: u32 = 7;

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
        let root = match dsl::decode(e, &install_params.predicate) {
            Ok(n) => n,
            Err(_) => storage::deny(e, storage::PolicyError::MalformedPredicate),
        };

        // (c2) The rule's signers (the operators) stay bounded: `enforce`
        //      re-hashes the set on every permit, so the same size and shape
        //      limits apply even though they no longer become the master set.
        require_usable_signer_set(e, &context_rule.signers);

        // (c2b) The Policy Signer role: the master set is APPOINTED via
        //      `policy_admins`, not captured from the rule's signers. It must
        //      be able to authorise later admin-gated calls, so the same
        //      usability rules apply to it.
        require_usable_signer_set(e, &install_params.policy_admins);

        // (c2c) A Default-scoped rule matches every operation on the account,
        //      including its own administration, so the predicate would be the
        //      only fence around `add_context_rule` itself - and a weakened
        //      predicate would hand the operators the admin surface. Scoped
        //      rules only.
        if matches!(context_rule.context_type, ContextRuleType::Default) {
            storage::deny(e, storage::PolicyError::DefaultContextNotSupported);
        }

        // (d4) Minimum constraint. A predicate carrying no selector leaf -
        //      literals on both sides of every compare - is trivially true
        //      or trivially false at install time, so it would permit
        //      everything or nothing forever. Refuse it so a no-constraint
        //      policy cannot install under any name.
        if !dsl::has_selector_leaf(&root) {
            storage::deny(e, storage::PolicyError::SelectorLeafRequired);
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
            require_master(e, stored_master);
            // A re-install must present the SAME admin set it is authorised
            // by. Changing who administers the mandate is rotation's job,
            // with its own two-party authorisation; letting a re-install
            // smuggle a new set in would bypass that.
            if *stored_master != install_params.policy_admins {
                storage::deny(e, storage::PolicyError::MasterAuthRequired);
            }
        }
        if install_params.install_nonce != stored_nonce.saturating_add(1) {
            storage::deny(e, storage::PolicyError::NonceReplay);
        }

        let executor = e
            .storage()
            .persistent()
            .get::<_, storage::StoredDoc>(&key.doc_key())
            .and_then(|doc| doc.executor);
        let signers_hash = storage::sha256_of_signer_set(e, &context_rule.signers);
        let master_set = prior_master.unwrap_or_else(|| install_params.policy_admins.clone());

        e.storage().persistent().set(
            &key.doc_key(),
            &storage::StoredDoc {
                predicate_bytes: install_params.predicate,
                executor,
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

    /// Bind every execution child rule before enabling its agent; preserve on reinstall.
    pub fn bind_executor(e: &Env, rule: (Address, u32), executor: Address) {
        rule.0.require_auth();
        let key = storage::RuleKey::new(rule.0, rule.1);
        let p = e.storage().persistent();
        require_master(e, &p.get(&key.master_set_key()).unwrap());
        let mut doc: storage::StoredDoc = p.get(&key.doc_key()).unwrap();
        doc.executor = Some(executor);
        p.set(&key.doc_key(), &doc);
        extend_state_ttl(e, &key);
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
        // Require bound-adapter approval of this exact account/context.
        if let Some(executor) = &doc.executor {
            executor.require_auth_for_args((smart_account, context.clone()).into_val(e));
        }
        let stored_signers_hash: BytesN<32> =
            match e.storage().persistent().get(&key.signers_hash_key()) {
                Some(h) => h,
                None => storage::deny(e, storage::PolicyError::MissingState),
            };
        let current_signers_hash = storage::sha256_of_signer_set(e, &context_rule.signers);
        if current_signers_hash != stored_signers_hash {
            storage::deny(e, storage::PolicyError::RuleSignersChanged);
        }

        let predicate_root = match dsl::decode(e, &doc.predicate_bytes) {
            Ok(n) => n,
            Err(_) => storage::deny(e, storage::PolicyError::MalformedPredicate),
        };

        // Before the predicate check. A deny panics and the host rolls this
        // back with the rest of the frame, so only a permit keeps the bump.
        extend_state_ttl(e, &key);

        let Context::Contract(call) = &context else {
            storage::deny(e, storage::PolicyError::MissingState)
        };
        match dsl::evaluate(e, &predicate_root, call) {
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
        require_master(e, &master_set);
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
        // Two-party rotation. The current admins consent to their
        // replacement, and the account (the Owner's rule) co-signs - without
        // the account, the admin set would be self-perpetuating and the
        // Owner would have no on-chain veto over who administers the
        // mandate.
        smart_account.require_auth();
        require_master(e, &old_set);
        // The same rules install applies. Rotating into a set that cannot
        //      authorise anything is unrecoverable: rotation and `uninstall`
        //      are both gated on `require_master`.
        require_usable_signer_set(e, &new_set);

        e.storage()
            .persistent()
            .set(&key.master_set_key(), &new_set);

        // `signers_hash` stays untouched: it pins the rule's OPERATORS from
        // install, and rotation changes who ADMINISTERS the mandate, never
        // who executes it. Operator changes go through a re-install, which
        // both the account and the admins authorise.
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
fn extend_state_ttl(e: &Env, key: &storage::RuleKey) {
    let p = e.storage().persistent();
    for k in [
        key.doc_key(),
        key.nonce_key(),
        key.signers_hash_key(),
        key.master_set_key(),
    ] {
        if p.has(&k) {
            p.extend_ttl(&k, storage::TTL_BUMP_THRESHOLD, storage::TTL_BUMP_TO);
        }
    }
}

/// Call `require_auth` on every signer in `master_set`. If any one is not
/// authorised, Soroban reverts the tx before this returns.
///
/// An EMPTY set is refused rather than treated as satisfied. Iterating an
/// empty set calls `require_auth` zero times, which is not "authorised by
/// nobody" - it is no authorisation at all, and it let anyone re-install an
/// arbitrary predicate on such a rule. OpenZeppelin permits a context rule
/// with zero signers as long as it carries at least one policy
/// (`smart_account/storage.rs`: `signer_ids.is_empty() && policy_ids.is_empty()`),
/// so this is reachable, not hypothetical. The guard lives here so no caller
/// can obtain a silently no-op check.
pub fn require_master(e: &Env, master_set: &Vec<Signer>) {
    if master_set.is_empty() {
        storage::deny(e, storage::PolicyError::EmptySignerSet);
    }
    master_set.iter().for_each(|s| s.address().require_auth());
}
