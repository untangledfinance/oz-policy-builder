//! Shared predicates: one owner-mutable predicate many accounts' rules reference.
//!
//! An owner keeps a predicate at `(owner, policy_id)` (`set_shared_predicate`,
//! `remove_shared_predicate`). A rule references it when its install payload's
//! predicate is the XDR of `(owner, policy_id)` instead of a predicate; the
//! payload hash is then the hash of that reference, so the account's signers
//! commit to the source, not to bytes its owner may change. These tests pin:
//!
//! - propagation: an owner update is what the next `enforce` evaluates, with no
//!   re-install, and the account's OZ rule is untouched;
//! - opt-in and revoke: only the account's own install sets or clears the
//!   reference, and a re-install moves it or goes back to an inline predicate;
//! - fail-closed: a missing, removed, over-limit or undecodable shared predicate
//!   refuses at `enforce` (and at install);
//! - authority isolation: the owner changes the constraint only; signers,
//!   executor, nonce and the account's own authorisation stay the account's;
//! - no chains: the store holds predicates only, never a reference.

extern crate alloc;
mod common;

use alloc::vec::Vec as StdVec;
use common::{addr, node, sym, vec as scvec, xdr_bytes};
use policy_interpreter::{
    ContextRule, ContextRuleType, Limits, PolicyInstallParams, PolicyInterpreter,
    PolicyInterpreterClient, Signer, Source, StoredDoc,
};
use soroban_sdk::auth::{Context, ContractContext};
use soroban_sdk::testutils::{storage::Persistent as _, Address as _, MockAuth, MockAuthInvoke};
use soroban_sdk::xdr::{ScErrorType, ScVal, ToXdr};
use soroban_sdk::{symbol_short, Address, Bytes, BytesN, Env, IntoVal, Symbol, Val, Vec};

// ---- predicates ----

fn fn_is(name: &str) -> ScVal {
    node(
        "eq",
        alloc::vec![scvec(alloc::vec![sym("call_fn")]), sym(name)],
    )
}

fn or(kids: StdVec<ScVal>) -> ScVal {
    node("or", alloc::vec![scvec(kids)])
}

/// `call_fn in [names]`.
fn fn_in(names: &[&str]) -> ScVal {
    let hay = names.iter().map(|n| sym(n)).collect();
    node(
        "in",
        alloc::vec![scvec(alloc::vec![sym("call_fn")]), scvec(hay)],
    )
}

// ---- fixture ----

struct World {
    env: Env,
    interpreter: Address,
    account: Address,
    owner: Address,
    executor: Address,
    venue: Address,
    admin: Signer,
    agent: Signer,
}

impl World {
    fn new() -> Self {
        Self::with_limits(common::DEFAULT)
    }

    fn with_limits(limits: Limits) -> Self {
        let env = Env::default();
        let interpreter = env.register(PolicyInterpreter, (limits,));
        World {
            interpreter,
            account: Address::generate(&env),
            owner: Address::generate(&env),
            executor: Address::generate(&env),
            venue: Address::generate(&env),
            admin: Signer::Delegated(Address::generate(&env)),
            agent: Signer::Delegated(Address::generate(&env)),
            env,
        }
    }

    fn client(&self) -> PolicyInterpreterClient<'_> {
        PolicyInterpreterClient::new(&self.env, &self.interpreter)
    }

    fn rule(&self, id: u32, scope: &Address, signers: Vec<Signer>) -> ContextRule {
        ContextRule {
            id,
            context_type: ContextRuleType::CallContract(scope.clone()),
            name: soroban_sdk::String::from_str(&self.env, "rule"),
            signers,
            signer_ids: Vec::new(&self.env),
            policies: soroban_sdk::vec![&self.env, self.interpreter.clone()],
            policy_ids: soroban_sdk::vec![&self.env, 0u32],
            valid_until: None,
        }
    }

    fn keyed(&self, id: u32) -> ContextRule {
        self.rule(
            id,
            &self.venue,
            soroban_sdk::vec![&self.env, self.agent.clone()],
        )
    }

    fn agents(&self) -> Vec<Signer> {
        soroban_sdk::vec![&self.env, self.agent.clone()]
    }

    fn none(&self) -> Vec<Signer> {
        Vec::new(&self.env)
    }

    /// The reference a rule installs to follow `owner`'s shared predicate `id`.
    fn source(&self, owner: &Address, id: u32) -> ScVal {
        scvec(alloc::vec![addr(&self.env, owner), ScVal::U32(id)])
    }

    fn params_bytes(&self, nonce: u32, predicate: Bytes) -> PolicyInstallParams {
        let predicate_hash: BytesN<32> = self.env.crypto().sha256(&predicate).into();
        PolicyInstallParams {
            grammar_version: 7,
            install_nonce: nonce,
            predicate,
            predicate_hash,
            policy_admins: soroban_sdk::vec![&self.env, self.admin.clone()],
        }
    }

    fn install(&self, nonce: u32, predicate: &ScVal, rule: &ContextRule) -> Option<u32> {
        self.env.mock_all_auths();
        let p = self.params_bytes(nonce, xdr_bytes(&self.env, predicate));
        code(self.client().try_install(&p, rule, &self.account))
    }

    /// `owner` stores `predicate` at `(owner, id)`, with every auth mocked.
    fn share(&self, owner: &Address, id: u32, predicate: &ScVal) -> Option<u32> {
        self.share_bytes(owner, id, &xdr_bytes(&self.env, predicate))
    }

    fn share_bytes(&self, owner: &Address, id: u32, predicate: &Bytes) -> Option<u32> {
        self.env.mock_all_auths();
        code(
            self.client()
                .try_set_shared_predicate(owner, &id, predicate),
        )
    }

    fn unshare(&self, owner: &Address, id: u32) -> Option<u32> {
        self.env.mock_all_auths();
        code(self.client().try_remove_shared_predicate(owner, &id))
    }

    fn bind(&self, rule: &ContextRule) -> Option<u32> {
        self.env.mock_all_auths();
        let key = (self.account.clone(), rule.id);
        code(self.client().try_bind_executor(&key, &self.executor))
    }

    fn ctx(&self, contract: &Address, f: &str) -> Context {
        Context::Contract(ContractContext {
            contract: contract.clone(),
            fn_name: Symbol::new(&self.env, f),
            args: Vec::new(&self.env),
        })
    }

    fn call(&self, f: &str) -> Context {
        self.ctx(&self.venue, f)
    }

    /// `enforce` with exactly the authorisations listed: the account's always,
    /// the executor's grant of `(account, context)` when `granted`.
    fn enforce(
        &self,
        ctx: &Context,
        authed: &Vec<Signer>,
        rule: &ContextRule,
        granted: bool,
    ) -> Outcome {
        let args: Vec<Val> = (
            ctx.clone(),
            authed.clone(),
            rule.clone(),
            self.account.clone(),
        )
            .into_val(&self.env);
        let account = MockAuth {
            address: &self.account,
            invoke: &MockAuthInvoke {
                contract: &self.interpreter,
                fn_name: "enforce",
                args,
                sub_invokes: &[],
            },
        };
        let grant = MockAuth {
            address: &self.executor,
            invoke: &MockAuthInvoke {
                contract: &self.interpreter,
                fn_name: "enforce",
                args: (self.account.clone(), ctx.clone()).into_val(&self.env),
                sub_invokes: &[],
            },
        };
        match granted {
            true => self.env.mock_auths(&[account, grant]),
            false => self.env.mock_auths(&[account]),
        };
        outcome(self.client().try_enforce(ctx, authed, rule, &self.account))
    }

    fn doc(&self, id: u32) -> StoredDoc {
        self.env.as_contract(&self.interpreter, || {
            self.env
                .storage()
                .persistent()
                .get(&(self.account.clone(), id))
                .unwrap()
        })
    }

    fn shared_key(&self, owner: &Address, id: u32) -> (Symbol, Address, u32) {
        (symbol_short!("shared"), owner.clone(), id)
    }
}

#[derive(Debug, PartialEq, Eq)]
enum Outcome {
    Permit,
    Code(u32),
    /// The host refused an authorisation (no contract error).
    Unauthorised,
}

fn outcome<T: core::fmt::Debug, E: core::fmt::Debug>(
    r: Result<T, Result<soroban_sdk::Error, E>>,
) -> Outcome {
    match r {
        Ok(_) => Outcome::Permit,
        Err(Ok(e)) if e.is_type(ScErrorType::Contract) => Outcome::Code(e.get_code()),
        Err(Ok(e)) if e.is_type(ScErrorType::Auth) || e.is_type(ScErrorType::Context) => {
            Outcome::Unauthorised
        }
        other => panic!("unexpected outcome {other:?}"),
    }
}

fn code<T, E>(r: Result<T, Result<soroban_sdk::Error, E>>) -> Option<u32> {
    match r {
        Ok(_) => None,
        Err(Ok(e)) => Some(e.get_code()),
        Err(Err(_)) => Some(u32::MAX),
    }
}

// ---- the store ----

/// Setting and removing need the owner's own authorisation, and nobody else's
/// stands in for it.
#[test]
fn only_the_owner_sets_or_removes_its_shared_predicate() {
    let w = World::new();
    let bytes = xdr_bytes(&w.env, &fn_is("submit"));
    let stranger = Address::generate(&w.env);
    let invoke = |f: &'static str, args: Vec<Val>| MockAuthInvoke {
        contract: &w.interpreter,
        fn_name: f,
        args,
        sub_invokes: &[],
    };
    let set_args: Vec<Val> = (w.owner.clone(), 1u32, bytes.clone()).into_val(&w.env);
    let set = invoke("set_shared_predicate", set_args);
    w.env.mock_auths(&[MockAuth {
        address: &stranger,
        invoke: &set,
    }]);
    let r = w.client().try_set_shared_predicate(&w.owner, &1, &bytes);
    assert_eq!(outcome(r), Outcome::Unauthorised);
    w.env.mock_auths(&[MockAuth {
        address: &w.owner,
        invoke: &set,
    }]);
    w.client().set_shared_predicate(&w.owner, &1, &bytes);

    let rm_args: Vec<Val> = (w.owner.clone(), 1u32).into_val(&w.env);
    let rm = invoke("remove_shared_predicate", rm_args);
    w.env.mock_auths(&[MockAuth {
        address: &stranger,
        invoke: &rm,
    }]);
    let r = w.client().try_remove_shared_predicate(&w.owner, &1);
    assert_eq!(outcome(r), Outcome::Unauthorised);
    w.env.mock_auths(&[MockAuth {
        address: &w.owner,
        invoke: &rm,
    }]);
    w.client().remove_shared_predicate(&w.owner, &1);
}

/// A shared predicate is validated when it is set, against the hard ceilings
/// (it belongs to no instance's limits): it must decode, carry a selector leaf
/// and fit the ceiling byte cap.
#[test]
fn set_validates_against_the_ceilings() {
    let w = World::new();
    // Not XDR at all: the host's parser refuses it before any check.
    assert!(w.share_bytes(&w.owner, 1, &Bytes::new(&w.env)).is_some());
    assert_eq!(w.share(&w.owner, 1, &ScVal::U32(5)), Some(201));
    let no_selector = node("eq", alloc::vec![ScVal::U32(1), ScVal::U32(1)]);
    assert_eq!(w.share(&w.owner, 1, &no_selector), Some(216));
    let over = Bytes::from_slice(&w.env, &[0u8; 40 * 1024 + 1]);
    assert_eq!(w.share_bytes(&w.owner, 1, &over), Some(207));
    // Wider than this instance's limits (32 `in` entries) but within the
    // ceilings (64): accepted here, refused where a rule follows it (below).
    let names: StdVec<alloc::string::String> = (0..40).map(|i| alloc::format!("f{i}")).collect();
    let refs: StdVec<&str> = names.iter().map(|s| s.as_str()).collect();
    assert_eq!(w.share(&w.owner, 1, &fn_in(&refs)), None);
}

/// No chains: a reference is not a predicate, so the store refuses one, and a
/// shared predicate can never point at another.
#[test]
fn a_shared_predicate_cannot_reference_another() {
    let w = World::new();
    let other = Address::generate(&w.env);
    assert_eq!(w.share(&other, 9, &fn_is("submit")), None);
    assert_eq!(w.share(&w.owner, 1, &w.source(&other, 9)), Some(201));
}

/// Setting extends the entry's TTL, so the owner keeps it alive by re-setting.
#[test]
fn set_extends_the_shared_entry() {
    let w = World::new();
    w.share(&w.owner, 1, &fn_is("submit"));
    let ttl = w.env.as_contract(&w.interpreter, || {
        w.env
            .storage()
            .persistent()
            .get_ttl(&w.shared_key(&w.owner, 1))
    });
    assert!(ttl >= 518_400, "ttl {ttl}");
}

/// The shared key cannot alias a rule's: `(owner, id)` shared and the rule
/// `(owner, id)` are separate entries, and writing one leaves the other.
#[test]
fn shared_and_rule_entries_never_alias() {
    let w = World::new();
    let rule = w.keyed(1);
    assert_eq!(w.install(1, &fn_is("submit"), &rule), None);
    // The account itself owns shared predicate 1 too.
    assert_eq!(w.share(&w.account, 1, &fn_is("withdraw")), None);
    let doc = w.doc(1);
    assert_eq!(doc.predicate_bytes, xdr_bytes(&w.env, &fn_is("submit")));
    assert_eq!(doc.source, Source::Inline);
    assert_eq!(
        w.enforce(&w.call("submit"), &w.agents(), &rule, false),
        Outcome::Permit
    );
    assert_eq!(w.unshare(&w.account, 1), None);
    assert_eq!(
        w.enforce(&w.call("submit"), &w.agents(), &rule, false),
        Outcome::Permit
    );
}

// ---- install: opting in ----

/// A rule references a shared predicate by installing `(owner, id)` as its
/// predicate. The doc stores the source and no predicate of its own.
#[test]
fn a_rule_installs_a_reference() {
    let w = World::new();
    w.share(&w.owner, 7, &fn_is("submit"));
    let rule = w.keyed(1);
    assert_eq!(w.install(1, &w.source(&w.owner, 7), &rule), None);
    let doc = w.doc(1);
    assert_eq!(doc.source, Source::Shared(w.owner.clone(), 7));
    assert!(doc.predicate_bytes.is_empty());
}

/// The payload hash binds the source: it is the hash of the reference, so a
/// payload naming another source under it, or carrying the shared bytes'
/// hash, is 208.
#[test]
fn the_payload_hash_commits_to_the_source() {
    let w = World::new();
    let other = Address::generate(&w.env);
    w.share(&w.owner, 7, &fn_is("submit"));
    w.share(&other, 7, &fn_is("submit"));
    let rule = w.keyed(1);
    w.env.mock_all_auths();

    let mut p = w.params_bytes(1, xdr_bytes(&w.env, &w.source(&w.owner, 7)));
    p.predicate = xdr_bytes(&w.env, &w.source(&other, 7));
    assert_eq!(
        code(w.client().try_install(&p, &rule, &w.account)),
        Some(208)
    );

    let mut p = w.params_bytes(1, xdr_bytes(&w.env, &w.source(&w.owner, 7)));
    p.predicate_hash = w
        .env
        .crypto()
        .sha256(&xdr_bytes(&w.env, &fn_is("submit")))
        .into();
    assert_eq!(
        code(w.client().try_install(&p, &rule, &w.account)),
        Some(208)
    );
    // The canonical reference is the XDR of the `(Address, u32)` tuple.
    assert_eq!(
        xdr_bytes(&w.env, &w.source(&w.owner, 7)),
        (w.owner.clone(), 7u32).to_xdr(&w.env)
    );
}

/// Opting into nothing fails closed: a reference to a missing entry is 206.
#[test]
fn a_reference_to_a_missing_predicate_does_not_install() {
    let w = World::new();
    let rule = w.keyed(1);
    assert_eq!(w.install(1, &w.source(&w.owner, 7), &rule), Some(206));
}

/// Install holds the shared predicate to the account's limits and to its own
/// install checks, as it does an inline one.
#[test]
fn install_holds_the_shared_predicate_to_the_accounts_limits() {
    let w = World::new();
    let names: StdVec<alloc::string::String> = (0..40).map(|i| alloc::format!("f{i}")).collect();
    let refs: StdVec<&str> = names.iter().map(|s| s.as_str()).collect();
    w.share(&w.owner, 7, &fn_in(&refs));
    assert_eq!(w.install(1, &w.source(&w.owner, 7), &w.keyed(1)), Some(201));
}

/// Nobody installs a reference on another account's rule: install needs the
/// account's own authorisation, and the owner's is not it.
#[test]
fn an_owner_cannot_point_another_accounts_rule_at_its_predicate() {
    let w = World::new();
    w.share(&w.owner, 7, &fn_is("submit"));
    let rule = w.keyed(1);
    let p = w.params_bytes(1, xdr_bytes(&w.env, &w.source(&w.owner, 7)));
    let args: Vec<Val> = (p.clone(), rule.clone(), w.account.clone()).into_val(&w.env);
    w.env.mock_auths(&[MockAuth {
        address: &w.owner,
        invoke: &MockAuthInvoke {
            contract: &w.interpreter,
            fn_name: "install",
            args,
            sub_invokes: &[],
        },
    }]);
    let r = w.client().try_install(&p, &rule, &w.account);
    assert_eq!(outcome(r), Outcome::Unauthorised);
}

// ---- propagation ----

/// The owner's update is what the next `enforce` evaluates, with no
/// re-install, and the account's OZ rule is the same value throughout.
#[test]
fn an_owner_update_propagates_without_a_reinstall() {
    let w = World::new();
    w.share(&w.owner, 7, &fn_is("submit"));
    let rule = w.keyed(1);
    w.install(1, &w.source(&w.owner, 7), &rule);
    let (submit, withdraw) = (w.call("submit"), w.call("withdraw"));
    assert_eq!(
        w.enforce(&submit, &w.agents(), &rule, false),
        Outcome::Permit
    );
    assert_eq!(
        w.enforce(&withdraw, &w.agents(), &rule, false),
        Outcome::Code(100)
    );

    let before = w.doc(1);
    assert_eq!(w.share(&w.owner, 7, &fn_is("withdraw")), None);
    assert_eq!(
        w.enforce(&submit, &w.agents(), &rule, false),
        Outcome::Code(100)
    );
    assert_eq!(
        w.enforce(&withdraw, &w.agents(), &rule, false),
        Outcome::Permit
    );
    // Nothing of the account's moved: nonce, signers hash, master set,
    // executor and source are the install's.
    let after = w.doc(1);
    assert_eq!(after.nonce, before.nonce);
    assert_eq!(after.signers_hash, before.signers_hash);
    assert_eq!(after.master_set, before.master_set);
    assert_eq!(after.executor, before.executor);
    assert_eq!(after.source, before.source);
}

/// Many accounts follow one predicate; one update reaches them all.
#[test]
fn one_update_reaches_every_referencing_account() {
    let w = World::new();
    let second = World {
        account: Address::generate(&w.env),
        env: w.env.clone(),
        interpreter: w.interpreter.clone(),
        owner: w.owner.clone(),
        executor: w.executor.clone(),
        venue: w.venue.clone(),
        admin: w.admin.clone(),
        agent: w.agent.clone(),
    };
    w.share(&w.owner, 7, &fn_is("submit"));
    let rule = w.keyed(3);
    w.install(1, &w.source(&w.owner, 7), &rule);
    second.install(1, &second.source(&w.owner, 7), &rule);
    w.share(&w.owner, 7, &fn_is("repay"));
    for x in [&w, &second] {
        assert_eq!(
            x.enforce(&x.call("repay"), &x.agents(), &rule, false),
            Outcome::Permit
        );
        assert_eq!(
            x.enforce(&x.call("submit"), &x.agents(), &rule, false),
            Outcome::Code(100)
        );
    }
}

// ---- revoke ----

/// The account leaves by re-installing: back to an inline predicate, after
/// which owner updates no longer reach it, or onto another source.
#[test]
fn a_reinstall_revokes_or_moves_the_reference() {
    let w = World::new();
    let other = Address::generate(&w.env);
    w.share(&w.owner, 7, &fn_is("submit"));
    w.share(&other, 2, &fn_is("repay"));
    let rule = w.keyed(1);
    w.install(1, &w.source(&w.owner, 7), &rule);

    assert_eq!(w.install(2, &fn_is("borrow"), &rule), None);
    assert_eq!(w.doc(1).source, Source::Inline);
    w.share(&w.owner, 7, &fn_is("borrow"));
    w.share(&w.owner, 7, &fn_is("withdraw"));
    assert_eq!(
        w.enforce(&w.call("withdraw"), &w.agents(), &rule, false),
        Outcome::Code(100)
    );
    assert_eq!(
        w.enforce(&w.call("borrow"), &w.agents(), &rule, false),
        Outcome::Permit
    );

    assert_eq!(w.install(3, &w.source(&other, 2), &rule), None);
    assert_eq!(w.doc(1).source, Source::Shared(other, 2));
    assert_eq!(
        w.enforce(&w.call("repay"), &w.agents(), &rule, false),
        Outcome::Permit
    );
    assert_eq!(
        w.enforce(&w.call("withdraw"), &w.agents(), &rule, false),
        Outcome::Code(100)
    );
}

// ---- fail-closed at enforce ----

/// A removed shared predicate refuses every referencing rule (206), and a new
/// set at the same key brings them back.
#[test]
fn a_removed_shared_predicate_refuses_206() {
    let w = World::new();
    w.share(&w.owner, 7, &fn_is("submit"));
    let rule = w.keyed(1);
    w.install(1, &w.source(&w.owner, 7), &rule);
    assert_eq!(w.unshare(&w.owner, 7), None);
    assert_eq!(
        w.enforce(&w.call("submit"), &w.agents(), &rule, false),
        Outcome::Code(206)
    );
    w.share(&w.owner, 7, &fn_is("submit"));
    assert_eq!(
        w.enforce(&w.call("submit"), &w.agents(), &rule, false),
        Outcome::Permit
    );
}

/// An update within the ceilings but past the account's own limits refuses at
/// that account's `enforce`: the byte cap (207) and the decode caps (201).
#[test]
fn an_update_past_the_accounts_limits_refuses() {
    let small = Limits {
        max_reads: 1,
        max_leaves: 4,
        max_predicate_bytes: 256,
        max_elems: 2,
        max_in_operands: 2,
        max_depth: 2,
    };
    let w = World::with_limits(small);
    w.share(&w.owner, 7, &fn_is("submit"));
    let rule = w.keyed(1);
    assert_eq!(w.install(1, &w.source(&w.owner, 7), &rule), None);
    let submit = w.call("submit");
    assert_eq!(
        w.enforce(&submit, &w.agents(), &rule, false),
        Outcome::Permit
    );

    // 3 `in` entries: over this instance's 2.
    w.share(&w.owner, 7, &fn_in(&["submit", "a", "b"]));
    assert_eq!(
        w.enforce(&submit, &w.agents(), &rule, false),
        Outcome::Code(201)
    );
    // Over this instance's 256 bytes.
    let names: StdVec<alloc::string::String> =
        (0..30).map(|i| alloc::format!("function{i}")).collect();
    let mut refs: StdVec<&str> = names.iter().map(|s| s.as_str()).collect();
    refs.push("submit");
    w.share(&w.owner, 7, &fn_in(&refs));
    assert_eq!(
        w.enforce(&submit, &w.agents(), &rule, false),
        Outcome::Code(207)
    );
    // Depth 3: over this instance's 2.
    let deep = node(
        "and",
        alloc::vec![scvec(alloc::vec![node(
            "or",
            alloc::vec![scvec(alloc::vec![fn_is("submit")])]
        )])],
    );
    w.share(&w.owner, 7, &deep);
    assert_eq!(
        w.enforce(&submit, &w.agents(), &rule, false),
        Outcome::Code(201)
    );
}

/// Bytes no set accepted (written straight to storage) refuse at `enforce`
/// rather than being trusted because they sit in the store.
#[test]
fn undecodable_shared_bytes_refuse_201() {
    let w = World::new();
    w.share(&w.owner, 7, &fn_is("submit"));
    let rule = w.keyed(1);
    w.install(1, &w.source(&w.owner, 7), &rule);
    for junk in [
        xdr_bytes(&w.env, &ScVal::U32(5)),
        xdr_bytes(&w.env, &w.source(&w.owner, 7)),
    ] {
        w.env.as_contract(&w.interpreter, || {
            w.env
                .storage()
                .persistent()
                .set(&w.shared_key(&w.owner, 7), &junk);
        });
        assert_eq!(
            w.enforce(&w.call("submit"), &w.agents(), &rule, false),
            Outcome::Code(201)
        );
    }
}

// ---- authority isolation ----

/// The owner widens the constraint only: the rule's own signers are still
/// required (210 with nobody authenticated, 204 once the signer set moves),
/// and `enforce` still needs the account's own authorisation.
#[test]
fn a_permissive_update_never_replaces_the_accounts_signers() {
    let w = World::new();
    w.share(&w.owner, 7, &fn_is("submit"));
    let rule = w.keyed(1);
    w.install(1, &w.source(&w.owner, 7), &rule);
    w.share(&w.owner, 7, &fn_in(&["submit", "withdraw", "transfer"]));
    let transfer = w.call("transfer");
    assert_eq!(
        w.enforce(&transfer, &w.none(), &rule, false),
        Outcome::Code(210)
    );
    let owner_as_signer = soroban_sdk::vec![&w.env, Signer::Delegated(w.owner.clone())];
    let hijacked = w.rule(1, &w.venue, owner_as_signer.clone());
    assert_eq!(
        w.enforce(&transfer, &owner_as_signer, &hijacked, false),
        Outcome::Code(204)
    );
    // Only the account authorises `enforce`; the owner's authorisation is not it.
    let args: Vec<Val> = (
        transfer.clone(),
        w.agents(),
        rule.clone(),
        w.account.clone(),
    )
        .into_val(&w.env);
    w.env.mock_auths(&[MockAuth {
        address: &w.owner,
        invoke: &MockAuthInvoke {
            contract: &w.interpreter,
            fn_name: "enforce",
            args,
            sub_invokes: &[],
        },
    }]);
    let r = w
        .client()
        .try_enforce(&transfer, &w.agents(), &rule, &w.account);
    assert_eq!(outcome(r), Outcome::Unauthorised);
}

/// A keyless rule that follows a shared predicate still needs its executor's
/// grant, and the owner cannot bind the rule (that needs the account and its
/// master set).
#[test]
fn a_keyless_referenced_rule_still_needs_the_binding_and_the_grant() {
    let w = World::new();
    w.share(&w.owner, 7, &fn_is("submit"));
    let rule = w.rule(1, &w.venue, w.none());
    w.install(1, &w.source(&w.owner, 7), &rule);
    let submit = w.call("submit");
    assert_eq!(
        w.enforce(&submit, &w.none(), &rule, true),
        Outcome::Code(210)
    );

    let args: Vec<Val> = ((w.account.clone(), 1u32), w.owner.clone()).into_val(&w.env);
    w.env.mock_auths(&[MockAuth {
        address: &w.owner,
        invoke: &MockAuthInvoke {
            contract: &w.interpreter,
            fn_name: "bind_executor",
            args,
            sub_invokes: &[],
        },
    }]);
    let r = w
        .client()
        .try_bind_executor(&(w.account.clone(), 1), &w.owner);
    assert_eq!(outcome(r), Outcome::Unauthorised);

    assert_eq!(w.bind(&rule), None);
    assert_eq!(w.enforce(&submit, &w.none(), &rule, true), Outcome::Permit);
    assert_eq!(
        w.enforce(&submit, &w.none(), &rule, false),
        Outcome::Unauthorised
    );
}

/// The Option A backstop holds the fetched predicate: a run rule following a
/// shared predicate refuses (221) once its owner stops pinning `run`, and
/// `bind_executor` refuses a reference that does not pin it.
#[test]
fn the_run_pin_backstop_holds_the_shared_predicate() {
    let w = World::new();
    w.share(&w.owner, 7, &fn_is("run"));
    let rule = w.rule(1, &w.executor, w.none());
    assert_eq!(w.install(1, &w.source(&w.owner, 7), &rule), None);
    assert_eq!(w.bind(&rule), None);
    let run = w.ctx(&w.executor, "run");
    assert_eq!(w.enforce(&run, &w.none(), &rule, false), Outcome::Permit);

    w.share(
        &w.owner,
        7,
        &or(alloc::vec![fn_is("run"), fn_is("execute")]),
    );
    let execute = w.ctx(&w.executor, "execute");
    assert_eq!(
        w.enforce(&execute, &w.none(), &rule, true),
        Outcome::Code(221)
    );
    assert_eq!(w.enforce(&run, &w.none(), &rule, false), Outcome::Code(221));

    // A fresh rule onto the unpinned predicate cannot be bound.
    let fresh = w.rule(2, &w.executor, w.none());
    assert_eq!(w.install(1, &w.source(&w.owner, 7), &fresh), None);
    assert_eq!(w.bind(&fresh), Some(221));
    // And a re-install under a binding refuses it too.
    w.share(&w.owner, 7, &fn_is("run"));
    assert_eq!(w.bind(&fresh), None);
    w.share(&w.owner, 8, &fn_is("execute"));
    assert_eq!(w.install(2, &w.source(&w.owner, 8), &fresh), Some(221));
}
