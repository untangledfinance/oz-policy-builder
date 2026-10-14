#![no_std]

//! Policy interpreter - the single audited Soroban contract that evaluates a
//! predicate supplied as install data.

extern crate alloc;

pub mod dsl;
#[cfg(test)]
mod dsl_tests;
pub mod storage;
#[cfg(test)]
mod test;
pub mod types;
mod version;

pub use dsl::{CompareOp, DenyReason, EvalContext, EvalDecision, Leaf, Node};
pub use storage::{PolicyError, StoredDoc};
pub use types::{ContextRule, ContextRuleType, PolicyInstallParams, Signer};
pub use version::SELF_VERSION;

use soroban_sdk::xdr::ToXdr;
use soroban_sdk::{auth::Context, contract, contractimpl, Address, BytesN, Env, IntoVal, Vec};

use crate::storage::{deny, ensure, load, PolicyError as E, TTL_BUMP_THRESHOLD, TTL_BUMP_TO};

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
        let p = &install_params;
        ensure(e, p.grammar_version == SELF_VERSION, E::VersionMismatch);

        // (a) Byte cap - reject before any parse work so the host never
        //     sees an oversized payload.
        let small = p.predicate.len() <= dsl::MAX_PREDICATE_BYTES;
        ensure(e, small, E::PredicateTooLarge);

        // (b) Hash check - mandatory invariant #11. The caller supplies
        //     `sha256(predicate_bytes)` in `predicate_hash`; we recompute it
        //     against the raw bytes via the host and refuse any mismatch.
        //     Closes the gap where a same-shape-but-different-bytes predicate
        //     could be installed under a stale hash.
        let hash: BytesN<32> = e.crypto().sha256(&p.predicate).into();
        ensure(e, hash == p.predicate_hash, E::PredicateHashMismatch);

        // (c) Parse + decode - the host does the XDR work; we walk the
        //     resulting native `Vec<Val>`. The AST is rebuilt on enforce from
        //     the stored bytes; here decoding is the validation.
        let root = dsl::decode(e, &p.predicate).unwrap_or_else(|_| deny(e, E::MalformedPredicate));

        // (c2) The rule's signers (the operators) stay bounded: `enforce`
        //      re-hashes the set on every permit, so the same size and shape
        //      limits apply even though they no longer become the master set.
        require_usable_signer_set(e, &context_rule.signers);

        // (c2b) The Policy Signer role: the master set is APPOINTED via
        //      `policy_admins`, not captured from the rule's signers. It must
        //      be able to authorise later admin-gated calls, so the same
        //      usability rules apply to it.
        require_usable_signer_set(e, &p.policy_admins);

        // (c2c) A Default-scoped rule matches every operation on the account,
        //      including its own administration, so the predicate would be the
        //      only fence around `add_context_rule` itself - and a weakened
        //      predicate would hand the operators the admin surface. So does a
        //      rule scoped to the account (`add_context_rule`) or to this
        //      interpreter (`install`, `rotate_master_signer_set`). Every other
        //      scoped rule is fine.
        let scope = &context_rule.context_type;
        let own = [smart_account.clone(), e.current_contract_address()];
        let admin = matches!(scope, ContextRuleType::Default)
            || matches!(scope, ContextRuleType::CallContract(a) if own.contains(a));
        ensure(e, !admin, E::DefaultContextNotSupported);

        // (d4) Minimum constraint. A predicate carrying no selector leaf -
        //      literals on both sides of every compare - is trivially true
        //      or trivially false at install time, so it would permit
        //      everything or nothing forever. Refuse it so a no-constraint
        //      policy cannot install under any name.
        ensure(e, dsl::has_selector_leaf(&root), E::SelectorLeafRequired);

        let key = (smart_account.clone(), context_rule.id);
        let prior: Option<StoredDoc> = e.storage().persistent().get(&key);

        // The smart account must authorise EVERY install, including the
        // first one on a fresh rule id. Without this, an attacker can
        // pre-seed any (smart_account, rule_id) with their own master
        // set + predicate; the legitimate owner then cannot install
        // (needs the squatter's auth) and cannot uninstall (same), so
        // that rule id is permanently poisoned. The later `require_master`
        // call covers re-installs on top of an existing master set.
        smart_account.require_auth();

        if let Some(stored) = &prior {
            require_master(e, &stored.master_set);
            // A re-install must present the SAME admin set it is authorised
            // by. Changing who administers the mandate is rotation's job,
            // with its own two-party authorisation; letting a re-install
            // smuggle a new set in would bypass that.
            let same = stored.master_set == p.policy_admins;
            ensure(e, same, E::MasterAuthRequired);
        }
        let fresh = p.install_nonce == prior.as_ref().map_or(0, |p| p.nonce).saturating_add(1);
        ensure(e, fresh, E::NonceReplay);

        let doc = StoredDoc {
            predicate_bytes: install_params.predicate,
            executor: prior.and_then(|p| p.executor),
            nonce: install_params.install_nonce,
            signers_hash: signers_hash(e, &context_rule.signers),
            master_set: install_params.policy_admins,
        };
        e.storage().persistent().set(&key, &doc);
    }

    /// Bind every execution child rule before enabling its agent; preserve on reinstall.
    pub fn bind_executor(e: &Env, rule: (Address, u32), executor: Address) {
        rule.0.require_auth();
        let mut doc = load(e, &rule);
        require_master(e, &doc.master_set);
        doc.executor = Some(executor);
        let store = e.storage().persistent();
        store.set(&rule, &doc);
        store.extend_ttl(&rule, TTL_BUMP_THRESHOLD, TTL_BUMP_TO);
    }

    pub fn enforce(
        e: &Env,
        context: Context,
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
        let signed = !authenticated_signers.is_empty();
        ensure(e, signed, E::NoAuthenticatedSigners);

        let key = (smart_account.clone(), context_rule.id);
        let doc = load(e, &key);
        // Require bound-adapter approval of this exact account/context.
        if let Some(executor) = &doc.executor {
            executor.require_auth_for_args((smart_account, context.clone()).into_val(e));
        }
        let unchanged = signers_hash(e, &context_rule.signers) == doc.signers_hash;
        ensure(e, unchanged, E::RuleSignersChanged);

        let root = dsl::decode_stored(e, &doc.predicate_bytes)
            .unwrap_or_else(|_| deny(e, E::MalformedPredicate));

        // Before the predicate check. A deny panics and the host rolls this
        // back with the rest of the frame, so only a permit keeps the bump.
        // The rule is ONE entry, so its doc, nonce, signers hash and master
        // set share a lifecycle and cannot archive apart.
        let store = e.storage().persistent();
        store.extend_ttl(&key, TTL_BUMP_THRESHOLD, TTL_BUMP_TO);

        // The interpreter is only invoked from a Contract auth context; any
        // other shape denies MISSING_STATE so the tx reverts cleanly.
        let Context::Contract(call) = &context else {
            deny(e, E::MissingState)
        };
        // Surface the SPECIFIC deny code so a review card can say "not on the
        // allowlist" rather than "predicate false" (see `DenyReason`).
        if let dsl::EvalDecision::Deny(reason) = dsl::evaluate(e, &root, call) {
            // Exhaustive: a new `DenyReason` does not compile without its code.
            let code = match reason {
                DenyReason::ArgMismatch => E::ArgMismatch,
                DenyReason::ContractScope => E::ContractScope,
                DenyReason::ArithmeticOverflow => E::ArithmeticOverflow,
                DenyReason::UnsupportedNode => E::UnsupportedNode,
                DenyReason::NotInAllowlist => E::NotInAllowlist,
            };
            deny(e, code);
        }
    }

    pub fn uninstall(e: &Env, context_rule: ContextRule, smart_account: Address) {
        let key = (smart_account, context_rule.id);
        require_master(e, &load(e, &key).master_set);
        e.storage().persistent().remove(&key);
    }

    pub fn rotate_master_signer_set(
        e: &Env,
        smart_account: Address,
        rule_id: u32,
        new_set: Vec<Signer>,
    ) {
        let key = (smart_account.clone(), rule_id);
        let mut doc = load(e, &key);
        // Two-party rotation. The current admins consent to their
        // replacement, and the account (the Owner's rule) co-signs - without
        // the account, the admin set would be self-perpetuating and the
        // Owner would have no on-chain veto over who administers the
        // mandate.
        smart_account.require_auth();
        require_master(e, &doc.master_set);
        // The same rules install applies. Rotating into a set that cannot
        // authorise anything is unrecoverable: rotation and `uninstall` are
        // both gated on `require_master`.
        require_usable_signer_set(e, &new_set);

        // `signers_hash` stays untouched: it pins the rule's OPERATORS from
        // install, and rotation changes who ADMINISTERS the mandate, never
        // who executes it. Operator changes go through a re-install, which
        // both the account and the admins authorise.
        doc.master_set = new_set;
        e.storage().persistent().set(&key, &doc);
    }
}

/// Stable 32-byte hash of a signer set: sha256 of the canonical XDR of the
/// whole vector, so variants and key bytes are tagged and cannot alias each
/// other (a `Delegated(a)` and an `External(a, [])` hash differently).
fn signers_hash(e: &Env, signers: &Vec<Signer>) -> BytesN<32> {
    e.crypto().sha256(&signers.to_xdr(e)).into()
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
/// - This interpreter's own address: `require_auth` on it is satisfied only by
///   a call the interpreter makes itself, so no one can ever authorise as it.
fn require_usable_signer_set(e: &Env, signers: &Vec<Signer>) {
    ensure(e, !signers.is_empty(), E::EmptySignerSet);
    ensure(e, signers.len() <= types::MAX_SIGNERS, E::TooManySigners);
    let external = signers.iter().any(|s| matches!(s, Signer::External(..)));
    ensure(e, !external, E::ExternalSignerNotSupported);
    let own = Signer::Delegated(e.current_contract_address());
    ensure(e, !signers.contains(own), E::SignerIsInterpreter);
}

/// Call `require_auth` on every signer in `master_set`. If any one is not
/// authorised, Soroban reverts the tx before this returns.
///
/// Pattern: the smart_account's `__check_auth` authorises them in one batched
/// call; any unauthorised addition to the rule's signers causes it to deny and
/// the tx reverts.
///
/// An EMPTY set is refused rather than treated as satisfied. Iterating an
/// empty set calls `require_auth` zero times, which is no authorisation at
/// all, and it let anyone re-install an arbitrary predicate on such a rule.
/// The guard lives here so no caller can obtain a silently no-op check.
fn require_master(e: &Env, master_set: &Vec<Signer>) {
    ensure(e, !master_set.is_empty(), E::EmptySignerSet);
    master_set.iter().for_each(|s| match s {
        Signer::Delegated(a) | Signer::External(a, _) => a.require_auth(),
    });
}
