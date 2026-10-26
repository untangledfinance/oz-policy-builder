#![no_std]

//! Policy interpreter - the single audited Soroban contract that evaluates a
//! predicate supplied as install data.

extern crate alloc;

pub mod dsl;
#[cfg(test)]
mod dsl_ext_tests;
#[cfg(test)]
mod dsl_tests;
pub mod storage;
#[cfg(test)]
mod test;
pub mod types;
mod version;

pub use dsl::{CompareOp, DenyReason, EvalContext, EvalDecision, Leaf, Node};
pub use storage::{PolicyError, Source, StoredDoc};
pub use types::{ContextRule, ContextRuleType, Limits, PolicyInstallParams, Signer};
pub use version::SELF_VERSION;

use soroban_sdk::xdr::{FromXdr, ToXdr};
use soroban_sdk::{
    auth::Context, contract, contractimpl, symbol_short, Address, Bytes, BytesN, Env, IntoVal,
    Symbol, TryFromVal, Val, Vec,
};

use crate::storage::{deny, deny_unless, load, PolicyError as E, TTL_BUMP_THRESHOLD, TTL_BUMP_TO};

#[contract]
pub struct PolicyInterpreter;

#[contractimpl]
impl PolicyInterpreter {
    /// Fix the hard limits for the life of this instance (see `Limits`).
    pub fn __constructor(e: &Env, limits: Limits) {
        deny_unless(e, limits.in_range(), E::LimitsOutOfRange);
        e.storage().instance().set(&storage::LIMITS, &limits);
    }

    /// The limits this instance was deployed with.
    pub fn limits(e: &Env) -> Limits {
        storage::load_limits(e)
    }

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
        deny_unless(e, p.grammar_version == SELF_VERSION, E::VersionMismatch);

        // (a) Byte cap - reject before any parse work so the host never
        //     sees an oversized payload.
        let lim = storage::load_limits(e);
        let small = p.predicate.len() <= lim.max_predicate_bytes;
        deny_unless(e, small, E::PredicateTooLarge);

        // (b) Hash check - mandatory invariant #11. The caller supplies
        //     `sha256(predicate_bytes)` in `predicate_hash`; we recompute it
        //     against the raw bytes via the host and refuse any mismatch.
        //     Closes the gap where a same-shape-but-different-bytes predicate
        //     could be installed under a stale hash.
        let hash: BytesN<32> = e.crypto().sha256(&p.predicate).into();
        deny_unless(e, hash == p.predicate_hash, E::PredicateHashMismatch);

        // (c) Parse + decode - the host does the XDR work; we walk the
        //     resulting native `Vec<Val>`. The AST is rebuilt on enforce from
        //     the stored bytes; here decoding is the validation.
        //     A payload that is the XDR of `(account, rule_id)` (never a
        //     predicate: a node starts with its name) makes this rule follow
        //     that rule's predicate, so the hash in (b) commits to the source,
        //     not to bytes its own admins may re-install. The predicate it
        //     names now gets every check below.
        let source =
            reference(e, &p.predicate).map_or(Source::Inline, |(a, id)| Source::Rule(a, id));
        let bytes = predicate(e, &source, &p.predicate);
        let root = dsl::decode(e, &bytes, &lim).unwrap_or_else(|_| deny(e, E::MalformedPredicate));

        // (c2) The rule's signers (the operators) stay bounded: `enforce`
        //      re-hashes the set on every permit, so the same size and shape
        //      limits apply even though they are not the master set.
        //      An empty set is a keyless rule: `enforce` permits one only while
        //      it is bound to an executor (see there), so it installs.
        if !context_rule.signers.is_empty() {
            require_usable_signer_set(e, &context_rule.signers);
        }

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
        deny_unless(e, !admin, E::DefaultContextNotSupported);

        // (d4) Minimum constraint. A predicate carrying no selector leaf -
        //      literals on both sides of every compare - is trivially true
        //      or trivially false at install time, so it would permit
        //      everything or nothing forever. Refuse it so a no-constraint
        //      policy cannot install under any name.
        deny_unless(e, dsl::has_selector_leaf(&root), E::SelectorLeafRequired);

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
            deny_unless(e, same, E::MasterAuthRequired);
        }
        let fresh = p.install_nonce == prior.as_ref().map_or(0, |p| p.nonce).saturating_add(1);
        deny_unless(e, fresh, E::NonceReplay);

        // A re-install keeps the binding, so it must not weaken a self-scoped
        // rule's predicate under it (see `bind_executor`).
        let executor = prior.and_then(|p| p.executor);
        let called = called_contract(scope);
        let open = executor.is_some() && executor == called && !pins_own(e, &root);
        deny_unless(e, !open, E::RunNotPinned);

        let doc = StoredDoc {
            predicate_bytes: match source {
                Source::Rule(..) => Bytes::new(e),
                Source::Inline => install_params.predicate,
            },
            source,
            executor,
            nonce: install_params.install_nonce,
            signers_hash: signers_hash(e, &context_rule.signers),
            master_set: install_params.policy_admins,
            scope: called,
        };
        e.storage().persistent().set(&key, &doc);
    }

    /// Bind every execution child rule before enabling its agent; preserve on reinstall.
    ///
    /// A rule scoped to the executor it is bound to answers that executor's own
    /// requests, so its predicate must pin `call_fn == run`, or an immediate
    /// `execute` of a fixed batch (221, `pins_own`). The scope is the one
    /// install recorded; `enforce` checks the account's own rule again.
    pub fn bind_executor(e: &Env, rule: (Address, u32), executor: Address) {
        rule.0.require_auth();
        let mut doc = load(e, &rule);
        require_master(e, &doc.master_set);
        if doc.scope.as_ref() == Some(&executor) {
            let lim = storage::load_limits(e);
            let bytes = predicate(e, &doc.source, &doc.predicate_bytes);
            let root = dsl::decode_stored(e, &bytes, &lim)
                .unwrap_or_else(|_| deny(e, E::MalformedPredicate));
            deny_unless(e, pins_own(e, &root), E::RunNotPinned);
        }
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
        // `enforce` writes (the TTL bump below) and, through a `read`, may
        // change state in the contracts it reads, so it must be reachable only
        // through the account it guards: anyone could otherwise drive a
        // predicate's reads on the account's behalf and keep a rule alive.
        // OpenZeppelin's own audited spending-limit policy opens with the same
        // requirement (accounts/src/policies/spending_limit.rs).
        smart_account.require_auth();

        let key = (smart_account.clone(), context_rule.id);
        let doc = load(e, &key);

        // An enforcement that authenticated nobody is an authorisation only
        // for a KEYLESS rule: one that lists no signer, is bound to an
        // executor, and has this interpreter as its only policy. Its authority
        // is the binding and the predicate. A rule that lists a signer reaches
        // here with nobody authenticated when the payload leaves the signer
        // out (OZ leaves the count to the policy), and stays refused. With one
        // policy, OZ's `remove_policy` cannot strip the predicate: a rule with
        // no signer and no policy is refused there (NoSignersAndPolicies).
        if authenticated_signers.is_empty() {
            let keyless = doc.executor.is_some()
                && context_rule.signers.is_empty()
                && context_rule.policies.len() == 1;
            deny_unless(e, keyless, E::NoAuthenticatedSigners);
        }

        // A rule following another reads that rule's predicate here (one
        // entry), and only its predicate: every check below is this rule's.
        let lim = storage::load_limits(e);
        let bytes = predicate(e, &doc.source, &doc.predicate_bytes);
        let root =
            dsl::decode_stored(e, &bytes, &lim).unwrap_or_else(|_| deny(e, E::MalformedPredicate));

        if let Some(executor) = &doc.executor {
            // The scope here is the account's own record of the rule, which
            // no install argument can misstate: a rule scoped to its executor
            // must pin `run` or a whole immediate batch, whatever
            // `bind_executor` and `install` were told.
            let own = called_contract(&context_rule.context_type).as_ref() == Some(executor);
            deny_unless(e, !own || pins_own(e, &root), E::RunNotPinned);
            // Require bound-adapter approval of this exact account/context,
            // except for the executor's own `run`: a context naming the
            // executor exists only because its code asked the account, so that
            // request is its approval. Only `run` is taken that way; an
            // `execute` or a `cancel` still needs a grant the executor hands
            // out: a gated adapter cannot spell one for its own `execute` (the
            // grant would contain itself), and a no-gate adapter hands one out
            // only inside an immediate `execute`, storing nothing.
            let run = matches!(&context, Context::Contract(c)
                if own && c.contract == *executor && c.fn_name == run_fn());
            if !run {
                executor.require_auth_for_args((smart_account, context.clone()).into_val(e));
            }
        }
        let unchanged = signers_hash(e, &context_rule.signers) == doc.signers_hash;
        deny_unless(e, unchanged, E::RuleSignersChanged);

        // Before the predicate check. A deny panics and the host rolls this
        // back with the rest of the frame, so only a permit keeps the bump.
        // The rule is ONE entry, so its doc, nonce, signers hash and master
        // set share a lifecycle and cannot archive apart.
        // A referenced rule must not archive under the rules that follow it.
        let store = e.storage().persistent();
        store.extend_ttl(&key, TTL_BUMP_THRESHOLD, TTL_BUMP_TO);
        if let Source::Rule(a, id) = doc.source {
            store.extend_ttl(&(a, id), TTL_BUMP_THRESHOLD, TTL_BUMP_TO);
        }

        // The interpreter is only invoked from a Contract auth context; any
        // other shape denies MISSING_STATE so the tx reverts cleanly.
        let Context::Contract(call) = &context else {
            deny(e, E::MissingState)
        };
        // Surface the SPECIFIC deny code so a review card can say "not on the
        // allowlist" rather than "predicate false" (see `DenyReason`).
        if let dsl::EvalDecision::Deny(reason) = dsl::evaluate(e, &root, call, &lim) {
            deny(e, deny_code(reason));
        }
    }

    /// Dry run for the off-chain builder: decode `predicate` with install's
    /// checks and evaluate it against `context`. It ALWAYS fails, with the
    /// verdict as the contract error: `0` permits, any other number is the
    /// code `install` or `enforce` would have raised. Failing is the point: a
    /// transaction that submits `check` rolls every effect of a `read` back, so
    /// the interpreter is no free, unauthenticated caller of other contracts.
    /// The builder reads the verdict from the simulation's error. No storage,
    /// no auth.
    pub fn check(e: &Env, predicate: soroban_sdk::Bytes, context: Context) {
        let Context::Contract(call) = &context else {
            deny(e, E::MissingState)
        };
        let lim = storage::load_limits(e);
        let code = if predicate.len() > lim.max_predicate_bytes {
            E::PredicateTooLarge as u32
        } else if let Ok(root) = dsl::decode(e, &predicate, &lim) {
            if !dsl::has_selector_leaf(&root) {
                E::SelectorLeafRequired as u32
            } else {
                match dsl::evaluate(e, &root, call, &lim) {
                    dsl::EvalDecision::Permit => 0,
                    dsl::EvalDecision::Deny(reason) => deny_code(reason) as u32,
                }
            }
        } else {
            E::MalformedPredicate as u32
        };
        soroban_sdk::panic_with_error!(e, soroban_sdk::Error::from_contract_error(code))
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

/// The error code a `DenyReason` is reported as. Exhaustive: a new reason does
/// not compile without its code.
fn deny_code(reason: DenyReason) -> E {
    match reason {
        DenyReason::ArgMismatch => E::ArgMismatch,
        DenyReason::ContractScope => E::ContractScope,
        DenyReason::ArithmeticOverflow => E::ArithmeticOverflow,
        DenyReason::UnsupportedNode => E::UnsupportedNode,
        DenyReason::NotInAllowlist => E::NotInAllowlist,
    }
}

/// The `(account, rule_id)` an install payload names instead of a predicate.
/// Only a short payload is tried (a reference is about 60 bytes), so a large
/// predicate is not parsed twice. The length is checked first: the SDK's tuple
/// conversion traps rather than failing on a vector of another length.
fn reference(e: &Env, bytes: &Bytes) -> Option<(Address, u32)> {
    if bytes.len() > 128 {
        return None;
    }
    let v: Vec<Val> = Vec::try_from_val(e, &Val::from_xdr(e, bytes).ok()?).ok()?;
    let pair = (v.len() == 2).then(|| <(Address, u32)>::try_from_val(e, &v.to_val()));
    pair?.ok()
}

/// The predicate bytes a rule evaluates: its own, or the referenced rule's
/// (missing is `206`). One level only: a referenced rule that is itself a
/// reference is `201`, so nothing chains or loops.
fn predicate(e: &Env, source: &Source, own: &Bytes) -> Bytes {
    let Source::Rule(a, id) = source else {
        return own.clone();
    };
    let doc = load(e, &(a.clone(), *id));
    deny_unless(e, doc.source == Source::Inline, E::MalformedPredicate);
    doc.predicate_bytes
}

/// The function a self-scoped executor rule may approve: the executor's `run`.
fn run_fn() -> Symbol {
    symbol_short!("run")
}

/// Whether `root` permits only what a rule scoped to its own executor may
/// approve. The executor's `run` (see `dsl::pins_call_fn`), or an IMMEDIATE
/// `execute` whose whole batch shape is fixed: on every path to a permit
/// `call_fn == execute`, the wait (argument 2) `== 0`, the number of calls
/// `== m` for a constant `m`, and the target and function name of each of
/// calls `0..m` an `eq` or `in` of constants (see `dsl::pins`). An executor
/// with no gate vouches for its own immediate `execute` to anyone, so such a
/// rule is the only fence around which contracts and functions a batch it
/// approves may call; arguments, grants and reads stay the predicate's to
/// bound. A gated executor never vouches for its own `execute`, so there a
/// rule of this shape binds but never passes.
fn pins_own(e: &Env, root: &dsl::Node) -> bool {
    use dsl::PathStep::{Index, Key, Len};
    if dsl::pins_call_fn(e, root, &run_fn()) {
        return true;
    }
    let pinned = |steps: &[dsl::PathStep], ok: &dyn Fn(&Val) -> bool, set: bool| {
        dsl::pins(root, &|l| dsl::is_call_path(e, l, steps), ok, set)
    };
    let any = |_: &Val| true;
    let zero = |v: &Val| dsl::number(e, v) == Some(0);
    let execute = dsl::pins_call_fn(e, root, &symbol_short!("execute"));
    if !(execute && pinned(&[Index(2)], &zero, false)) {
        return false;
    }
    // Count the leading calls whose target and function are both pinned; the
    // length must be pinned to no more than that. Each one pinned takes a leaf
    // of its own, so the count stops within `max_leaves`.
    let (target, function) = (symbol_short!("target"), Symbol::new(e, "function_name"));
    let mut m: u32 = 0;
    while [&target, &function].iter().all(|field| {
        let at = [Index(0), Index(m), Key(field.to_val())];
        pinned(&at, &any, true)
    }) {
        m += 1;
    }
    let short = |v: &Val| dsl::number(e, v).is_some_and(|n| n <= i128::from(m));
    pinned(&[Index(0), Len], &short, false)
}

/// The contract a `CallContract` scope names; none for any other scope.
fn called_contract(scope: &ContextRuleType) -> Option<Address> {
    match scope {
        ContextRuleType::CallContract(a) => Some(a.clone()),
        _ => None,
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
    deny_unless(e, !signers.is_empty(), E::EmptySignerSet);
    deny_unless(e, signers.len() <= types::MAX_SIGNERS, E::TooManySigners);
    let external = signers.iter().any(|s| matches!(s, Signer::External(..)));
    deny_unless(e, !external, E::ExternalSignerNotSupported);
    let own = Signer::Delegated(e.current_contract_address());
    deny_unless(e, !signers.contains(own), E::SignerIsInterpreter);
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
    deny_unless(e, !master_set.is_empty(), E::EmptySignerSet);
    master_set.iter().for_each(|s| match s {
        Signer::Delegated(a) | Signer::External(a, _) => a.require_auth(),
    });
}
