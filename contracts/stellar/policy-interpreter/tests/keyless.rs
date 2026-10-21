//! Keyless rules bound to an executor, for OpenZeppelin 0.8.0.
//!
//! A rule with no signer, bound to an execution adapter, answers in two ways:
//! a context the adapter grants through `authorize_as_current_contract` (the
//! venue rule), or the adapter's own `run` (the run rule, scoped to the
//! adapter). These tests pin each gate on that path:
//!
//! - an empty authenticated set passes only for a rule that lists no signer,
//!   has one policy and is bound (else 210);
//! - every context except the executor's own `run` under a rule scoped to it
//!   still needs the executor's authorisation;
//! - a rule scoped to its executor must pin `call_fn == run` (221) at
//!   `bind_executor`, at a re-install under the binding, and at `enforce`
//!   against the rule the account passes;
//! - `pins_call_fn` accepts `run` only where every path to a permit pins it.

extern crate alloc;
mod common;

use alloc::vec::Vec as StdVec;
use common::{node, sym, vec as scvec, xdr_bytes};
use policy_interpreter::{
    dsl, ContextRule, ContextRuleType, PolicyInstallParams, PolicyInterpreter,
    PolicyInterpreterClient, Signer, StoredDoc,
};
use soroban_sdk::auth::{Context, ContractContext};
use soroban_sdk::testutils::{Address as _, MockAuth, MockAuthInvoke};
use soroban_sdk::xdr::{ScErrorType, ScString, ScVal};
use soroban_sdk::{Address, Bytes, BytesN, Env, IntoVal, Symbol, Val, Vec};

// ---- predicates ----

fn call_fn() -> ScVal {
    scvec(alloc::vec![sym("call_fn")])
}

fn fn_is(name: &str) -> ScVal {
    node("eq", alloc::vec![call_fn(), sym(name)])
}

fn arg0_is(n: u32) -> ScVal {
    node(
        "eq",
        alloc::vec![
            scvec(alloc::vec![sym("call_arg"), ScVal::U32(0)]),
            ScVal::U32(n)
        ],
    )
}

fn and(kids: StdVec<ScVal>) -> ScVal {
    node("and", alloc::vec![scvec(kids)])
}

fn or(kids: StdVec<ScVal>) -> ScVal {
    node("or", alloc::vec![scvec(kids)])
}

// ---- fixture ----

struct World {
    env: Env,
    interpreter: Address,
    account: Address,
    executor: Address,
    venue: Address,
    admin: Signer,
}

impl World {
    fn new() -> Self {
        let env = Env::default();
        let interpreter = env.register(PolicyInterpreter, (common::DEFAULT,));
        let account = Address::generate(&env);
        let admin = Signer::Delegated(Address::generate(&env));
        World {
            interpreter,
            account,
            executor: Address::generate(&env),
            venue: Address::generate(&env),
            admin,
            env,
        }
    }

    fn client(&self) -> PolicyInterpreterClient<'_> {
        PolicyInterpreterClient::new(&self.env, &self.interpreter)
    }

    /// A rule as the account passes it: `policies` holds the interpreter once.
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

    fn params(&self, nonce: u32, predicate: &ScVal) -> PolicyInstallParams {
        let predicate = xdr_bytes(&self.env, predicate);
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
        let p = self.params(nonce, predicate);
        code(self.client().try_install(&p, rule, &self.account))
    }

    fn bind(&self, rule: &ContextRule, executor: &Address) -> Option<u32> {
        self.env.mock_all_auths();
        let key = (self.account.clone(), rule.id);
        code(self.client().try_bind_executor(&key, executor))
    }

    fn ctx(&self, contract: &Address, f: &str, args: Vec<Val>) -> Context {
        Context::Contract(ContractContext {
            contract: contract.clone(),
            fn_name: Symbol::new(&self.env, f),
            args,
        })
    }

    fn run_ctx(&self, id: u32) -> Context {
        let args = soroban_sdk::vec![&self.env, id.into_val(&self.env)];
        self.ctx(&self.executor, "run", args)
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
        match self.client().try_enforce(ctx, authed, rule, &self.account) {
            Ok(Ok(())) => Outcome::Permit,
            Err(Ok(e)) if e.is_type(ScErrorType::Contract) => Outcome::Code(e.get_code()),
            // A missing authorisation surfaces from the test host as
            // `Error(Context, InvalidAction)` (or `Auth`). Every test that
            // expects it also runs the same call with the grant, so the
            // grant is what differs.
            Err(Ok(e)) if e.is_type(ScErrorType::Auth) || e.is_type(ScErrorType::Context) => {
                Outcome::Unauthorised
            }
            other => panic!("unexpected outcome {other:?}"),
        }
    }

    fn none(&self) -> Vec<Signer> {
        Vec::new(&self.env)
    }
}

#[derive(Debug, PartialEq, Eq)]
enum Outcome {
    Permit,
    Code(u32),
    /// The host refused an authorisation (no contract error).
    Unauthorised,
}

fn code<T, E>(r: Result<T, Result<soroban_sdk::Error, E>>) -> Option<u32> {
    match r {
        Ok(_) => None,
        Err(Ok(e)) => Some(e.get_code()),
        Err(Err(_)) => Some(u32::MAX),
    }
}

// ---- install ----

/// A rule with no signer installs: its operators are nobody, and `enforce`
/// decides when that is enough.
#[test]
fn a_rule_with_no_signer_installs() {
    let w = World::new();
    let rule = w.rule(1, &w.venue, w.none());
    assert_eq!(w.install(1, &fn_is("submit"), &rule), None);
}

/// The other operator checks still run on a set that is not empty.
#[test]
fn a_non_empty_operator_set_is_still_checked() {
    let w = World::new();
    let ext = Signer::External(Address::generate(&w.env), Bytes::new(&w.env));
    let rule = w.rule(1, &w.venue, soroban_sdk::vec![&w.env, ext]);
    assert_eq!(w.install(1, &fn_is("submit"), &rule), Some(212));
}

// ---- enforce: who may enforce with nobody authenticated ----

/// Unbound, a keyless rule is closed: nobody authenticated is no
/// authorisation, including between install and `bind_executor`.
#[test]
fn an_unbound_keyless_rule_is_refused_210() {
    let w = World::new();
    let rule = w.rule(1, &w.venue, w.none());
    w.install(1, &fn_is("submit"), &rule);
    let ctx = w.ctx(&w.venue, "submit", w.env_args());
    assert_eq!(w.enforce(&ctx, &w.none(), &rule, true), Outcome::Code(210));
}

/// Bound, a keyless venue rule permits a context the executor grants, and only
/// that: without the grant the host refuses.
#[test]
fn a_bound_keyless_venue_rule_needs_the_executors_grant() {
    let w = World::new();
    let rule = w.rule(1, &w.venue, w.none());
    w.install(1, &fn_is("submit"), &rule);
    assert_eq!(w.bind(&rule, &w.executor), None);
    let ctx = w.ctx(&w.venue, "submit", w.env_args());
    assert_eq!(w.enforce(&ctx, &w.none(), &rule, true), Outcome::Permit);
    assert_eq!(
        w.enforce(&ctx, &w.none(), &rule, false),
        Outcome::Unauthorised
    );
    // The predicate still decides.
    let other = w.ctx(&w.venue, "withdraw", w.env_args());
    assert_eq!(
        w.enforce(&other, &w.none(), &rule, true),
        Outcome::Code(100)
    );
}

/// Hazard (a): OZ hands a rule that lists a signer to its policy with nobody
/// matched when the payload leaves the signer out. Bound or not, that stays
/// 210: the binding never stands in for a key the rule asks for.
#[test]
fn a_bound_rule_that_lists_a_signer_is_refused_without_it() {
    let w = World::new();
    let agent = Signer::Delegated(Address::generate(&w.env));
    let rule = w.rule(1, &w.venue, soroban_sdk::vec![&w.env, agent.clone()]);
    w.install(1, &fn_is("submit"), &rule);
    w.bind(&rule, &w.executor);
    let ctx = w.ctx(&w.venue, "submit", w.env_args());
    assert_eq!(w.enforce(&ctx, &w.none(), &rule, true), Outcome::Code(210));
    // With the signer authenticated it is an ordinary bound rule.
    let authed = soroban_sdk::vec![&w.env, agent];
    assert_eq!(w.enforce(&ctx, &authed, &rule, true), Outcome::Permit);
}

/// U10: OZ's `remove_signer` turns a keyed bound rule into one that lists no
/// signer and has one policy, so it passes the keyless gate. The signer hash
/// `install` stored still names the agent, and that check (204) is the one
/// left between the stripped rule and a keyless permit, with the executor's
/// grant or without it on the executor's own `run`.
#[test]
fn a_keyed_bound_rule_stripped_of_its_signer_is_refused_204() {
    let w = World::new();
    let agent = Signer::Delegated(Address::generate(&w.env));
    let keyed = w.rule(5, &w.venue, soroban_sdk::vec![&w.env, agent.clone()]);
    w.install(1, &fn_is("submit"), &keyed);
    assert_eq!(w.bind(&keyed, &w.executor), None);
    let stripped = w.rule(5, &w.venue, w.none());
    let ctx = w.ctx(&w.venue, "submit", w.env_args());
    assert_eq!(
        w.enforce(&ctx, &w.none(), &stripped, true),
        Outcome::Code(204)
    );

    // The run rule the same way: A1 skips the grant, the hash still refuses.
    let run = w.rule(6, &w.executor, soroban_sdk::vec![&w.env, agent]);
    w.install(1, &fn_is("run"), &run);
    assert_eq!(w.bind(&run, &w.executor), None);
    let stripped = w.rule(6, &w.executor, w.none());
    assert_eq!(
        w.enforce(&w.run_ctx(7), &w.none(), &stripped, false),
        Outcome::Code(204)
    );
}

/// A keyless rule must have this interpreter as its only policy, so OZ's
/// `remove_policy` can never leave it with no predicate (OZ refuses a rule
/// with no signer and no policy).
#[test]
fn a_keyless_rule_with_a_second_policy_is_refused_210() {
    let w = World::new();
    let mut rule = w.rule(1, &w.venue, w.none());
    w.install(1, &fn_is("submit"), &rule);
    w.bind(&rule, &w.executor);
    rule.policies.push_back(Address::generate(&w.env));
    rule.policy_ids.push_back(1);
    let ctx = w.ctx(&w.venue, "submit", w.env_args());
    assert_eq!(w.enforce(&ctx, &w.none(), &rule, true), Outcome::Code(210));
}

/// A binding lost to an uninstall and a fresh install closes the rule again.
#[test]
fn a_keyless_rule_reinstalled_after_uninstall_is_unbound() {
    let w = World::new();
    let rule = w.rule(1, &w.venue, w.none());
    w.install(1, &fn_is("submit"), &rule);
    w.bind(&rule, &w.executor);
    w.env.mock_all_auths();
    w.client().uninstall(&rule, &w.account);
    w.install(1, &fn_is("submit"), &rule);
    let ctx = w.ctx(&w.venue, "submit", w.env_args());
    assert_eq!(w.enforce(&ctx, &w.none(), &rule, true), Outcome::Code(210));
}

// ---- the executor's own `run` (A1) ----

/// The run rule: scoped to the executor, bound to it, keyless, pinned to
/// `run`. The executor's own `run(id)` needs no grant, since the context exists
/// only because the executor's code asked the account.
#[test]
fn the_executors_own_run_needs_no_grant() {
    let w = World::new();
    let rule = w.rule(2, &w.executor, w.none());
    assert_eq!(w.install(1, &fn_is("run"), &rule), None);
    assert_eq!(w.bind(&rule, &w.executor), None);
    assert_eq!(
        w.enforce(&w.run_ctx(7), &w.none(), &rule, false),
        Outcome::Permit
    );
}

/// Every other function of the executor still needs its grant, which a batch
/// can never carry for its own `execute`, and a no-gate adapter never gives.
/// The predicate refuses it as well, once the grant is there.
#[test]
fn the_exemption_covers_run_alone() {
    let w = World::new();
    let rule = w.rule(2, &w.executor, w.none());
    w.install(1, &fn_is("run"), &rule);
    w.bind(&rule, &w.executor);
    for f in ["execute", "cancel", "rebind"] {
        let ctx = w.ctx(&w.executor, f, w.env_args());
        assert_eq!(
            w.enforce(&ctx, &w.none(), &rule, false),
            Outcome::Unauthorised,
            "{f}"
        );
        assert_eq!(w.enforce(&ctx, &w.none(), &rule, true), Outcome::Code(100));
    }
}

/// The exemption is for a rule scoped to its executor. A rule scoped elsewhere
/// that is handed a context naming the executor's `run` still needs the grant.
#[test]
fn the_exemption_needs_the_rule_scoped_to_the_executor() {
    let w = World::new();
    let rule = w.rule(1, &w.venue, w.none());
    w.install(1, &fn_is("run"), &rule);
    w.bind(&rule, &w.executor);
    assert_eq!(
        w.enforce(&w.run_ctx(7), &w.none(), &rule, false),
        Outcome::Unauthorised
    );
    assert_eq!(
        w.enforce(&w.run_ctx(7), &w.none(), &rule, true),
        Outcome::Permit
    );
}

/// A `run` on some other contract is no request of the executor.
#[test]
fn the_exemption_needs_the_context_to_name_the_executor() {
    let w = World::new();
    let rule = w.rule(2, &w.executor, w.none());
    w.install(1, &fn_is("run"), &rule);
    w.bind(&rule, &w.executor);
    let elsewhere = w.ctx(&w.venue, "run", w.env_args());
    assert_eq!(
        w.enforce(&elsewhere, &w.none(), &rule, false),
        Outcome::Unauthorised
    );
    assert_eq!(
        w.enforce(&elsewhere, &w.none(), &rule, true),
        Outcome::Permit
    );
}

// ---- the `call_fn == run` pin: bind, re-install, enforce ----

/// `bind_executor` refuses to bind a rule to the executor it is scoped to
/// unless the predicate pins `run`; a rule scoped elsewhere keeps its own
/// predicate (the venue rule pins `submit`).
#[test]
fn bind_refuses_a_self_scoped_rule_not_pinned_to_run() {
    let w = World::new();
    let open = [
        fn_is("execute"),
        arg0_is(1),
        or(alloc::vec![fn_is("run"), fn_is("execute")]),
    ];
    for (i, p) in open.iter().enumerate() {
        let rule = w.rule(10 + i as u32, &w.executor, w.none());
        assert_eq!(w.install(1, p, &rule), None);
        assert_eq!(w.bind(&rule, &w.executor), Some(221), "case {i}");
    }
    let pinned = w.rule(20, &w.executor, w.none());
    w.install(1, &and(alloc::vec![arg0_is(1), fn_is("run")]), &pinned);
    assert_eq!(w.bind(&pinned, &w.executor), None);
    // Scoped to the venue, bound to the executor: not self-scoped.
    let venue = w.rule(21, &w.venue, w.none());
    w.install(1, &fn_is("submit"), &venue);
    assert_eq!(w.bind(&venue, &w.executor), None);
    // Scoped to the executor, bound to another one: not self-scoped either.
    let elsewhere = w.rule(22, &w.executor, w.none());
    w.install(1, &fn_is("execute"), &elsewhere);
    assert_eq!(w.bind(&elsewhere, &Address::generate(&w.env)), None);
}

/// A re-install keeps the binding, so it cannot swap a pinned predicate for an
/// open one under it.
#[test]
fn a_reinstall_under_a_binding_cannot_unpin_run() {
    let w = World::new();
    let rule = w.rule(2, &w.executor, w.none());
    w.install(1, &fn_is("run"), &rule);
    w.bind(&rule, &w.executor);
    assert_eq!(w.install(2, &fn_is("execute"), &rule), Some(221));
    assert_eq!(
        w.install(2, &and(alloc::vec![fn_is("run"), arg0_is(3)]), &rule),
        None
    );
}

/// The re-install check reads the scope the caller passes, and a direct
/// install can misstate it. `enforce` then checks the scope of the rule the
/// account passes, so the open predicate still never permits.
#[test]
fn enforce_refuses_an_unpinned_self_scoped_rule_whatever_install_was_told() {
    let w = World::new();
    let real = w.rule(2, &w.executor, w.none());
    w.install(1, &fn_is("run"), &real);
    w.bind(&real, &w.executor);
    let forged = w.rule(2, &w.venue, w.none());
    assert_eq!(w.install(2, &fn_is("execute"), &forged), None);
    let execute = w.ctx(&w.executor, "execute", w.env_args());
    assert_eq!(
        w.enforce(&execute, &w.none(), &real, true),
        Outcome::Code(221)
    );
    assert_eq!(
        w.enforce(&w.run_ctx(1), &w.none(), &real, false),
        Outcome::Code(221)
    );
}

/// The same backstop for a stored document no install path wrote: bound to the
/// executor, unpinned, scope recorded as none. A keyed rule is held to it too.
#[test]
fn enforce_backstop_holds_for_a_stored_unpinned_document() {
    let w = World::new();
    let agent = Signer::Delegated(Address::generate(&w.env));
    let signers = soroban_sdk::vec![&w.env, agent];
    let rule = w.rule(3, &w.executor, signers.clone());
    let doc = StoredDoc {
        executor: Some(w.executor.clone()),
        predicate_bytes: xdr_bytes(&w.env, &fn_is("execute")),
        nonce: 1,
        signers_hash: w
            .env
            .crypto()
            .sha256(&soroban_sdk::xdr::ToXdr::to_xdr(signers.clone(), &w.env))
            .into(),
        master_set: soroban_sdk::vec![&w.env, w.admin.clone()],
        scope: None,
    };
    w.env.as_contract(&w.interpreter, || {
        w.env
            .storage()
            .persistent()
            .set(&(w.account.clone(), 3u32), &doc);
    });
    let execute = w.ctx(&w.executor, "execute", w.env_args());
    assert_eq!(
        w.enforce(&execute, &signers, &rule, true),
        Outcome::Code(221)
    );
}

/// An unbound keyed rule scoped to the adapter (the agent's rule) is untouched:
/// no binding, no pin to check.
#[test]
fn an_unbound_keyed_self_scoped_rule_is_untouched() {
    let w = World::new();
    let agent = Signer::Delegated(Address::generate(&w.env));
    let signers = soroban_sdk::vec![&w.env, agent];
    let rule = w.rule(3, &w.executor, signers.clone());
    w.install(1, &fn_is("execute"), &rule);
    let execute = w.ctx(&w.executor, "execute", w.env_args());
    assert_eq!(w.enforce(&execute, &signers, &rule, false), Outcome::Permit);
}

// ---- `pins_call_fn` ----

fn pins(env: &Env, p: &ScVal) -> bool {
    let root = dsl::decode(env, &xdr_bytes(env, p), &common::DEFAULT).expect("decodes");
    dsl::pins_call_fn(env, &root, &Symbol::new(env, "run"))
}

#[test]
fn pins_call_fn_accepts_run_on_every_path() {
    let env = Env::default();
    let ok = [
        fn_is("run"),
        node("eq", alloc::vec![sym("run"), call_fn()]),
        and(alloc::vec![arg0_is(1), fn_is("run")]),
        and(alloc::vec![
            or(alloc::vec![arg0_is(1), arg0_is(2)]),
            fn_is("run")
        ]),
        or(alloc::vec![
            fn_is("run"),
            and(alloc::vec![fn_is("run"), arg0_is(2)])
        ]),
        and(alloc::vec![or(alloc::vec![fn_is("run"), fn_is("run")])]),
        node(
            "eq",
            alloc::vec![call_fn(), scvec(alloc::vec![sym("lit"), sym("run")])],
        ),
    ];
    for (i, p) in ok.iter().enumerate() {
        assert!(pins(&env, p), "case {i}");
    }
}

#[test]
fn pins_call_fn_refuses_anything_weaker() {
    let env = Env::default();
    let quant = node(
        "all",
        alloc::vec![
            scvec(alloc::vec![sym("call_arg"), ScVal::U32(0)]),
            fn_is("run")
        ],
    );
    let run_string = ScVal::String(ScString("run".try_into().unwrap()));
    let refused = [
        fn_is("execute"),
        arg0_is(1),
        or(alloc::vec![fn_is("run"), fn_is("execute")]),
        or(alloc::vec![fn_is("run"), arg0_is(1)]),
        and(alloc::vec![
            arg0_is(1),
            or(alloc::vec![fn_is("run"), arg0_is(2)])
        ]),
        node("ne", alloc::vec![call_fn(), sym("execute")]),
        node("ne", alloc::vec![call_fn(), sym("run")]),
        node("in", alloc::vec![call_fn(), scvec(alloc::vec![sym("run")])]),
        quant,
        node("eq", alloc::vec![call_fn(), call_fn()]),
        node("eq", alloc::vec![call_fn(), run_string]),
        node(
            "eq",
            alloc::vec![scvec(alloc::vec![sym("call_contract")]), sym("run")],
        ),
    ];
    for (i, p) in refused.iter().enumerate() {
        assert!(!pins(&env, p), "case {i}");
    }
}

impl World {
    fn env_args(&self) -> Vec<Val> {
        Vec::new(&self.env)
    }
}
