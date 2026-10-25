//! Referenced rules: a rule of account B follows the predicate of an existing
//! rule `(A, rule_id)` on this interpreter.
//!
//! B opts in by installing the XDR of `(A, rule_id)` as its predicate; the
//! payload hash is then the hash of that reference, so B's admins commit to the
//! source, not to bytes A may change. A changes its predicate by its own
//! re-install (A's authorisation and A's master set), and B follows from its
//! next `enforce`. These tests pin:
//!
//! - propagation: A's re-install is what B's next `enforce` evaluates, with no
//!   action by B, for every account that references the rule;
//! - opt-in and revoke: only B's own install sets, moves or clears the source;
//! - fail-closed: a missing, removed, chained or undecodable source refuses;
//! - authority isolation: only the predicate is shared. B's signers, binding,
//!   executor grant and authorisation are B's; A's are never used for B;
//! - no chains: a referenced rule that is itself a reference refuses;
//! - the TTL of the referenced rule is extended by B's permits only.

extern crate alloc;
mod common;

use alloc::vec::Vec as StdVec;
use common::{addr, node, sym, vec as scvec, xdr_bytes};
use policy_interpreter::{
    ContextRule, ContextRuleType, PolicyInstallParams, PolicyInterpreter, PolicyInterpreterClient,
    Signer, Source, StoredDoc,
};
use soroban_sdk::auth::{Context, ContractContext};
use soroban_sdk::testutils::{
    storage::Persistent as _, Address as _, Ledger as _, MockAuth, MockAuthInvoke,
};
use soroban_sdk::xdr::{ScErrorType, ScVal, ToXdr};
use soroban_sdk::{Address, Bytes, BytesN, Env, IntoVal, Symbol, Val, Vec};

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

// ---- fixture ----

/// One interpreter; account `a` owns the referenced rule, `b` references it.
struct World {
    env: Env,
    interpreter: Address,
    a: Address,
    b: Address,
    executor: Address,
    venue: Address,
    /// Each account's master set (one admin each).
    admin_a: Signer,
    admin_b: Signer,
    agent_a: Signer,
    agent_b: Signer,
}

/// A's rule id.
const RA: u32 = 4;
/// B's rule id.
const RB: u32 = 1;

impl World {
    fn new() -> Self {
        let env = Env::default();
        let interpreter = env.register(PolicyInterpreter, (common::DEFAULT,));
        let g = || Address::generate(&env);
        World {
            interpreter,
            a: g(),
            b: g(),
            executor: g(),
            venue: g(),
            admin_a: Signer::Delegated(g()),
            admin_b: Signer::Delegated(g()),
            agent_a: Signer::Delegated(g()),
            agent_b: Signer::Delegated(g()),
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

    fn rule_a(&self) -> ContextRule {
        self.rule(RA, &self.venue, self.signers(&self.agent_a))
    }

    fn rule_b(&self) -> ContextRule {
        self.rule(RB, &self.venue, self.signers(&self.agent_b))
    }

    fn signers(&self, s: &Signer) -> Vec<Signer> {
        soroban_sdk::vec![&self.env, s.clone()]
    }

    fn none(&self) -> Vec<Signer> {
        Vec::new(&self.env)
    }

    fn admin_of(&self, account: &Address) -> Signer {
        match account == &self.a {
            true => self.admin_a.clone(),
            false => self.admin_b.clone(),
        }
    }

    /// The reference to `(account, id)` a rule installs as its predicate.
    fn reference(&self, account: &Address, id: u32) -> ScVal {
        scvec(alloc::vec![addr(&self.env, account), ScVal::U32(id)])
    }

    fn params(&self, account: &Address, nonce: u32, predicate: &ScVal) -> PolicyInstallParams {
        let predicate = xdr_bytes(&self.env, predicate);
        let predicate_hash: BytesN<32> = self.env.crypto().sha256(&predicate).into();
        PolicyInstallParams {
            grammar_version: 7,
            install_nonce: nonce,
            predicate,
            predicate_hash,
            policy_admins: soroban_sdk::vec![&self.env, self.admin_of(account)],
        }
    }

    /// `account` installs `predicate` on `rule`, with every auth mocked.
    fn install(
        &self,
        account: &Address,
        nonce: u32,
        predicate: &ScVal,
        rule: &ContextRule,
    ) -> Option<u32> {
        self.env.mock_all_auths();
        let p = self.params(account, nonce, predicate);
        code(self.client().try_install(&p, rule, account))
    }

    /// A installs or re-installs its rule `RA` with `predicate`.
    fn set_a(&self, nonce: u32, predicate: &ScVal) -> Option<u32> {
        self.install(&self.a, nonce, predicate, &self.rule_a())
    }

    /// B's rule `RB` references `(A, RA)`.
    fn follow_a(&self, nonce: u32) -> Option<u32> {
        self.install(&self.b, nonce, &self.reference(&self.a, RA), &self.rule_b())
    }

    fn bind(&self, account: &Address, id: u32) -> Option<u32> {
        self.env.mock_all_auths();
        code(
            self.client()
                .try_bind_executor(&(account.clone(), id), &self.executor),
        )
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

    /// `enforce` for B with exactly the authorisations listed: B's always,
    /// the executor's grant of `(B, context)` when `granted`.
    fn enforce(
        &self,
        ctx: &Context,
        authed: &Vec<Signer>,
        rule: &ContextRule,
        granted: bool,
    ) -> Outcome {
        let args: Vec<Val> =
            (ctx.clone(), authed.clone(), rule.clone(), self.b.clone()).into_val(&self.env);
        let account = MockAuth {
            address: &self.b,
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
                args: (self.b.clone(), ctx.clone()).into_val(&self.env),
                sub_invokes: &[],
            },
        };
        match granted {
            true => self.env.mock_auths(&[account, grant]),
            false => self.env.mock_auths(&[account]),
        };
        outcome(self.client().try_enforce(ctx, authed, rule, &self.b))
    }

    /// B's keyed rule with B's agent authenticated, no grant.
    fn b_does(&self, f: &str) -> Outcome {
        let agents = self.signers(&self.agent_b);
        self.enforce(&self.call(f), &agents, &self.rule_b(), false)
    }

    fn doc(&self, account: &Address, id: u32) -> StoredDoc {
        self.env.as_contract(&self.interpreter, || {
            let key = (account.clone(), id);
            self.env.storage().persistent().get(&key).unwrap()
        })
    }

    fn ttl(&self, account: &Address, id: u32) -> u32 {
        self.env.as_contract(&self.interpreter, || {
            let key = (account.clone(), id);
            self.env.storage().persistent().get_ttl(&key)
        })
    }

    /// One mocked authorisation of `address` for `f(args)` on the interpreter.
    fn only<'a>(&self, address: &'a Address, invoke: &'a MockAuthInvoke<'a>) -> MockAuth<'a> {
        MockAuth { address, invoke }
    }

    fn invoke<'a>(&'a self, f: &'a str, args: Vec<Val>) -> MockAuthInvoke<'a> {
        MockAuthInvoke {
            contract: &self.interpreter,
            fn_name: f,
            args,
            sub_invokes: &[],
        }
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

// ---- opting in ----

/// B's install of a reference stores the source and no predicate of its own.
#[test]
fn a_rule_installs_a_reference_to_another_rule() {
    let w = World::new();
    assert_eq!(w.set_a(1, &fn_is("submit")), None);
    assert_eq!(w.follow_a(1), None);
    let doc = w.doc(&w.b, RB);
    assert_eq!(doc.source, Source::Rule(w.a.clone(), RA));
    assert!(doc.predicate_bytes.is_empty());
    // A's own rule is untouched and inline.
    assert_eq!(w.doc(&w.a, RA).source, Source::Inline);
    assert_eq!(w.b_does("submit"), Outcome::Permit);
    assert_eq!(w.b_does("withdraw"), Outcome::Code(100));
}

/// The payload hash binds the source: a payload naming another rule under
/// it, or carrying the hash of A's predicate bytes, is 208.
#[test]
fn the_payload_hash_commits_to_the_reference() {
    let w = World::new();
    w.set_a(1, &fn_is("submit"));
    w.install(
        &w.a,
        1,
        &fn_is("withdraw"),
        &w.rule(RA + 1, &w.venue, w.none()),
    );
    w.env.mock_all_auths();
    let rule = w.rule_b();

    let mut p = w.params(&w.b, 1, &w.reference(&w.a, RA));
    p.predicate = xdr_bytes(&w.env, &w.reference(&w.a, RA + 1));
    assert_eq!(code(w.client().try_install(&p, &rule, &w.b)), Some(208));

    let mut p = w.params(&w.b, 1, &w.reference(&w.a, RA));
    let a_bytes = xdr_bytes(&w.env, &fn_is("submit"));
    p.predicate_hash = w.env.crypto().sha256(&a_bytes).into();
    assert_eq!(code(w.client().try_install(&p, &rule, &w.b)), Some(208));

    // The canonical reference is the XDR of the `(Address, u32)` tuple.
    assert_eq!(
        xdr_bytes(&w.env, &w.reference(&w.a, RA)),
        (w.a.clone(), RA).to_xdr(&w.env)
    );
}

/// Referencing a rule that does not exist does not install (206).
#[test]
fn a_reference_to_a_missing_rule_does_not_install() {
    let w = World::new();
    assert_eq!(w.follow_a(1), Some(206));
}

/// Nobody installs a reference on B's rule but B: A's authorisation (or
/// anyone else's) is not B's.
#[test]
fn a_cannot_set_bs_source() {
    let w = World::new();
    w.set_a(1, &fn_is("submit"));
    let rule = w.rule_b();
    let p = w.params(&w.b, 1, &w.reference(&w.a, RA));
    let args: Vec<Val> = (p.clone(), rule.clone(), w.b.clone()).into_val(&w.env);
    let inv = w.invoke("install", args);
    let admin_a = match &w.admin_a {
        Signer::Delegated(x) => x.clone(),
        _ => unreachable!(),
    };
    w.env
        .mock_auths(&[w.only(&w.a, &inv), w.only(&admin_a, &inv)]);
    let r = w.client().try_install(&p, &rule, &w.b);
    assert_eq!(outcome(r), Outcome::Unauthorised);
    // Re-pointing B's existing reference needs B's master set too.
    assert_eq!(w.follow_a(1), None);
    let p = w.params(&w.b, 2, &fn_is("withdraw"));
    let args: Vec<Val> = (p.clone(), rule.clone(), w.b.clone()).into_val(&w.env);
    let inv = w.invoke("install", args);
    w.env.mock_auths(&[w.only(&w.b, &inv)]);
    let r = w.client().try_install(&p, &rule, &w.b);
    assert_eq!(outcome(r), Outcome::Unauthorised);
    assert_eq!(w.doc(&w.b, RB).source, Source::Rule(w.a.clone(), RA));
}

/// B's own rule-shape guards still run on B's rule at B's install.
#[test]
fn bs_rule_shape_guards_still_apply() {
    let w = World::new();
    w.set_a(1, &fn_is("submit"));
    let reference = w.reference(&w.a, RA);
    let mut admin = w.rule_b();
    admin.context_type = ContextRuleType::Default;
    assert_eq!(w.install(&w.b, 1, &reference, &admin), Some(218));
    let own = w.rule(RB, &w.b, w.signers(&w.agent_b));
    assert_eq!(w.install(&w.b, 1, &reference, &own), Some(218));
    let ext = Signer::External(Address::generate(&w.env), Bytes::new(&w.env));
    let ext_rule = w.rule(RB, &w.venue, w.signers(&ext));
    assert_eq!(w.install(&w.b, 1, &reference, &ext_rule), Some(212));
}

// ---- propagation ----

/// A's re-install is what B's next `enforce` evaluates: no action by B, the
/// same rule id, and B's record unchanged.
#[test]
fn as_reinstall_propagates_to_b() {
    let w = World::new();
    w.set_a(1, &fn_is("submit"));
    w.follow_a(1);
    assert_eq!(w.b_does("submit"), Outcome::Permit);
    let before = w.doc(&w.b, RB);

    assert_eq!(w.set_a(2, &fn_is("withdraw")), None);
    assert_eq!(w.b_does("submit"), Outcome::Code(100));
    assert_eq!(w.b_does("withdraw"), Outcome::Permit);
    assert_eq!(w.set_a(3, &fn_is("repay")), None);
    assert_eq!(w.b_does("withdraw"), Outcome::Code(100));
    assert_eq!(w.b_does("repay"), Outcome::Permit);

    let after = w.doc(&w.b, RB);
    assert_eq!(after.nonce, before.nonce);
    assert_eq!(after.signers_hash, before.signers_hash);
    assert_eq!(after.master_set, before.master_set);
    assert_eq!(after.executor, before.executor);
    assert_eq!(after.source, before.source);
    assert_eq!(after.predicate_bytes, before.predicate_bytes);
}

/// Many accounts reference one rule; one re-install reaches them all.
#[test]
fn one_reinstall_reaches_every_referencing_account() {
    let w = World::new();
    w.set_a(1, &fn_is("submit"));
    let others: StdVec<World> = (0..3)
        .map(|_| World {
            b: Address::generate(&w.env),
            env: w.env.clone(),
            interpreter: w.interpreter.clone(),
            a: w.a.clone(),
            executor: w.executor.clone(),
            venue: w.venue.clone(),
            admin_a: w.admin_a.clone(),
            admin_b: w.admin_b.clone(),
            agent_a: w.agent_a.clone(),
            agent_b: w.agent_b.clone(),
        })
        .collect();
    for x in &others {
        assert_eq!(x.follow_a(1), None);
    }
    w.set_a(2, &fn_is("repay"));
    for x in &others {
        assert_eq!(x.b_does("repay"), Outcome::Permit);
        assert_eq!(x.b_does("submit"), Outcome::Code(100));
    }
}

/// A's re-install keeps A's own two-party authorisation: A alone, A's admin
/// alone, and B are each refused.
#[test]
fn as_reinstall_needs_as_own_two_party_auth() {
    let w = World::new();
    w.set_a(1, &fn_is("submit"));
    w.follow_a(1);
    let rule = w.rule_a();
    let p = w.params(&w.a, 2, &fn_is("transfer"));
    let args: Vec<Val> = (p.clone(), rule.clone(), w.a.clone()).into_val(&w.env);
    let inv = w.invoke("install", args);
    let admin_a = match &w.admin_a {
        Signer::Delegated(x) => x.clone(),
        _ => unreachable!(),
    };
    for auths in [
        alloc::vec![w.only(&w.a, &inv)],
        alloc::vec![w.only(&admin_a, &inv)],
        alloc::vec![w.only(&w.b, &inv)],
    ] {
        w.env.mock_auths(&auths);
        assert_eq!(
            outcome(w.client().try_install(&p, &rule, &w.a)),
            Outcome::Unauthorised
        );
    }
    assert_eq!(w.b_does("transfer"), Outcome::Code(100));
    w.env
        .mock_auths(&[w.only(&w.a, &inv), w.only(&admin_a, &inv)]);
    w.client().install(&p, &rule, &w.a);
    assert_eq!(w.b_does("transfer"), Outcome::Permit);
}

// ---- revoke ----

/// B leaves by re-installing: back to an inline predicate, after which A's
/// updates no longer reach it, or onto another rule.
#[test]
fn bs_reinstall_revokes_or_moves_the_reference() {
    let w = World::new();
    w.set_a(1, &fn_is("submit"));
    w.install(
        &w.a,
        1,
        &fn_is("repay"),
        &w.rule(RA + 1, &w.venue, w.none()),
    );
    w.follow_a(1);

    assert_eq!(w.install(&w.b, 2, &fn_is("borrow"), &w.rule_b()), None);
    assert_eq!(w.doc(&w.b, RB).source, Source::Inline);
    w.set_a(2, &fn_is("withdraw"));
    assert_eq!(w.b_does("withdraw"), Outcome::Code(100));
    assert_eq!(w.b_does("borrow"), Outcome::Permit);

    let other = w.reference(&w.a, RA + 1);
    assert_eq!(w.install(&w.b, 3, &other, &w.rule_b()), None);
    assert_eq!(w.doc(&w.b, RB).source, Source::Rule(w.a.clone(), RA + 1));
    assert_eq!(w.b_does("repay"), Outcome::Permit);
    assert_eq!(w.b_does("withdraw"), Outcome::Code(100));
}

// ---- fail-closed ----

/// A uninstalling its rule refuses every rule referencing it (206); A's
/// install again brings them back.
#[test]
fn an_uninstalled_source_refuses_206() {
    let w = World::new();
    w.set_a(1, &fn_is("submit"));
    w.follow_a(1);
    w.env.mock_all_auths();
    w.client().uninstall(&w.rule_a(), &w.a);
    assert_eq!(w.b_does("submit"), Outcome::Code(206));
    w.set_a(1, &fn_is("submit"));
    assert_eq!(w.b_does("submit"), Outcome::Permit);
}

/// A source document whose bytes do not decode under B's limits refuses: not
/// XDR of a predicate (201), nested past the depth cap (201).
#[test]
fn undecodable_or_over_limit_source_bytes_refuse_201() {
    let w = World::new();
    w.set_a(1, &fn_is("submit"));
    w.follow_a(1);
    let mut deep = fn_is("submit");
    for _ in 0..common::DEFAULT.max_depth {
        deep = or(alloc::vec![deep]);
    }
    for junk in [xdr_bytes(&w.env, &ScVal::U32(5)), xdr_bytes(&w.env, &deep)] {
        let mut doc = w.doc(&w.a, RA);
        doc.predicate_bytes = junk;
        w.env.as_contract(&w.interpreter, || {
            w.env.storage().persistent().set(&(w.a.clone(), RA), &doc);
        });
        assert_eq!(w.b_does("submit"), Outcome::Code(201));
    }
}

// ---- no chains ----

/// A reference to a rule that is itself a reference is refused at install and
/// at `enforce` (201): one level only.
#[test]
fn a_chain_is_refused() {
    let w = World::new();
    w.set_a(1, &fn_is("submit"));
    w.follow_a(1);
    // C -> B -> A at install.
    let c = Address::generate(&w.env);
    let rule_c = w.rule(9, &w.venue, w.signers(&w.agent_b));
    assert_eq!(w.install(&c, 1, &w.reference(&w.b, RB), &rule_c), Some(201));
    // A turns its rule into a reference after B followed it: B now refuses.
    let x = Address::generate(&w.env);
    w.install(&x, 1, &fn_is("submit"), &w.rule(2, &w.venue, w.none()));
    assert_eq!(w.set_a(2, &w.reference(&x, 2)), None);
    assert_eq!(w.b_does("submit"), Outcome::Code(201));
    // The source is what refuses, not only the empty bytes a reference
    // stores: a referenced doc that is a reference AND carries a valid
    // predicate (no install writes one) refuses too.
    let mut doc = w.doc(&w.a, RA);
    doc.predicate_bytes = xdr_bytes(&w.env, &fn_is("submit"));
    w.env.as_contract(&w.interpreter, || {
        w.env.storage().persistent().set(&(w.a.clone(), RA), &doc);
    });
    assert_eq!(w.b_does("submit"), Outcome::Code(201));
}

/// A rule pointed at itself is a chain of one: it refuses.
#[test]
fn a_self_reference_is_refused() {
    let w = World::new();
    assert_eq!(w.install(&w.b, 1, &fn_is("submit"), &w.rule_b()), None);
    assert_eq!(w.b_does("submit"), Outcome::Permit);
    // The prior inline doc satisfies install's lookup; the stored rule then
    // points at itself, which `enforce` refuses.
    assert_eq!(
        w.install(&w.b, 2, &w.reference(&w.b, RB), &w.rule_b()),
        None
    );
    assert_eq!(w.b_does("submit"), Outcome::Code(201));
    // Installing it again is refused at install: the source is now a reference.
    assert_eq!(
        w.install(&w.b, 3, &w.reference(&w.b, RB), &w.rule_b()),
        Some(201)
    );
}

// ---- authority isolation ----

/// Only B authorises B's `enforce`; A's authorisation does not.
#[test]
fn a_cannot_enforce_as_b() {
    let w = World::new();
    w.set_a(1, &fn_is("submit"));
    w.follow_a(1);
    let ctx = w.call("submit");
    let agents = w.signers(&w.agent_b);
    let args: Vec<Val> = (ctx.clone(), agents.clone(), w.rule_b(), w.b.clone()).into_val(&w.env);
    let inv = w.invoke("enforce", args);
    w.env.mock_auths(&[w.only(&w.a, &inv)]);
    let r = w.client().try_enforce(&ctx, &agents, &w.rule_b(), &w.b);
    assert_eq!(outcome(r), Outcome::Unauthorised);
}

/// A's signers and binding are never B's: A's agent cannot stand in for B's
/// (204), A's binding does not make B's keyless rule bound (210), and B's
/// unbound rule needs no grant from A's executor.
#[test]
fn as_signers_and_executor_are_never_used_for_b() {
    let w = World::new();
    w.set_a(1, &fn_is("submit"));
    assert_eq!(w.bind(&w.a, RA), None);
    w.follow_a(1);
    let submit = w.call("submit");

    // B's keyed rule permits with B's agent and no grant from A's executor.
    assert_eq!(w.b_does("submit"), Outcome::Permit);
    // A's agent in B's rule: the signer hash is B's.
    let hijacked = w.rule(RB, &w.venue, w.signers(&w.agent_a));
    let agents_a = w.signers(&w.agent_a);
    assert_eq!(
        w.enforce(&submit, &agents_a, &hijacked, true),
        Outcome::Code(204)
    );

    // A keyless B rule referencing A's bound rule is still unbound itself.
    let keyless = w.rule(RB + 1, &w.venue, w.none());
    let reference = w.reference(&w.a, RA);
    assert_eq!(w.install(&w.b, 1, &reference, &keyless), None);
    assert_eq!(
        w.enforce(&submit, &w.none(), &keyless, true),
        Outcome::Code(210)
    );
    // Bound by B, it needs the grant of B's own context.
    assert_eq!(w.bind(&w.b, RB + 1), None);
    assert_eq!(
        w.enforce(&submit, &w.none(), &keyless, true),
        Outcome::Permit
    );
    assert_eq!(
        w.enforce(&submit, &w.none(), &keyless, false),
        Outcome::Unauthorised
    );
}

/// A cannot bind B's rule: binding needs B and B's master set.
#[test]
fn a_cannot_bind_bs_rule() {
    let w = World::new();
    w.set_a(1, &fn_is("submit"));
    w.follow_a(1);
    let key = (w.b.clone(), RB);
    let args: Vec<Val> = (key.clone(), w.a.clone()).into_val(&w.env);
    let inv = w.invoke("bind_executor", args);
    w.env.mock_auths(&[w.only(&w.a, &inv)]);
    let r = w.client().try_bind_executor(&key, &w.a);
    assert_eq!(outcome(r), Outcome::Unauthorised);
    assert_eq!(w.doc(&w.b, RB).executor, None);
}

/// The run-pin backstop holds the fetched predicate: B's run rule following
/// A's rule refuses (221) once A's re-install stops pinning `run`, at
/// `enforce`, at `bind_executor` and at B's re-install under the binding.
#[test]
fn the_run_pin_backstop_holds_the_referenced_predicate() {
    let w = World::new();
    w.set_a(1, &fn_is("run"));
    let run_rule = w.rule(RB, &w.executor, w.none());
    let reference = w.reference(&w.a, RA);
    assert_eq!(w.install(&w.b, 1, &reference, &run_rule), None);
    assert_eq!(w.bind(&w.b, RB), None);
    let run = w.ctx(&w.executor, "run");
    assert_eq!(
        w.enforce(&run, &w.none(), &run_rule, false),
        Outcome::Permit
    );

    w.set_a(2, &or(alloc::vec![fn_is("run"), fn_is("execute")]));
    let execute = w.ctx(&w.executor, "execute");
    assert_eq!(
        w.enforce(&execute, &w.none(), &run_rule, true),
        Outcome::Code(221)
    );
    assert_eq!(
        w.enforce(&run, &w.none(), &run_rule, false),
        Outcome::Code(221)
    );
    // B's re-install under the binding refuses the unpinned source.
    assert_eq!(w.install(&w.b, 2, &reference, &run_rule), Some(221));
    // A fresh self-scoped rule onto it cannot be bound.
    let fresh = w.rule(RB + 1, &w.executor, w.none());
    assert_eq!(w.install(&w.b, 1, &reference, &fresh), None);
    assert_eq!(w.bind(&w.b, RB + 1), Some(221));
}

// ---- TTL ----

/// B's permit extends the referenced rule's entry as well as its own; a
/// denied `enforce` extends neither.
#[test]
fn bs_permit_extends_the_referenced_entry() {
    let w = World::new();
    w.set_a(1, &fn_is("submit"));
    w.follow_a(1);
    let start = w.ttl(&w.a, RA);
    assert!(start > 100, "ttl {start}");
    w.env.ledger().with_mut(|l| l.sequence_number += start - 50);
    assert!(w.ttl(&w.a, RA) < 100);

    let low = w.ttl(&w.a, RA);
    assert_eq!(w.b_does("withdraw"), Outcome::Code(100));
    assert_eq!(w.ttl(&w.a, RA), low);
    assert_eq!(w.b_does("submit"), Outcome::Permit);
    assert!(w.ttl(&w.a, RA) >= 518_400, "ttl {}", w.ttl(&w.a, RA));
    assert!(w.ttl(&w.b, RB) >= 518_400);
}
