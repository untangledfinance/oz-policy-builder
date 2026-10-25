//! A rule scoped to the executor it is bound to may pin an IMMEDIATE `execute`
//! of a fixed batch instead of `run` (221, `pins_own`).
//!
//! An execution adapter with no gate vouches for its own immediate `execute`
//! to whoever asks it, so a keyless rule scoped to it and bound to it answers
//! any caller. Its predicate is then the only fence on what the batch calls,
//! and must fix, on every path to a permit: `call_fn == execute`, the wait
//! (argument 2) `== 0`, the number of calls `== m`, and the target and
//! function name of each of the first `m` calls (`eq`, or `in` constants).
//! These tests pin that check at `bind_executor`, at a re-install under the
//! binding, and at `enforce` against the rule the account passes, and that
//! the executor's word for the exact context is still required.

extern crate alloc;
mod common;

use alloc::vec::Vec as StdVec;
use common::{addr, node, sym, vec as scvec, xdr_bytes};
use policy_interpreter::{
    ContextRule, ContextRuleType, PolicyInstallParams, PolicyInterpreter, PolicyInterpreterClient,
    Signer,
};
use soroban_sdk::auth::{Context, ContractContext};
use soroban_sdk::testutils::{Address as _, MockAuth, MockAuthInvoke};
use soroban_sdk::xdr::{ScErrorType, ScString, ScVal};
use soroban_sdk::{contracttype, Address, BytesN, Env, IntoVal, Symbol, Val, Vec};

/// The execution adapter's `Call`, as its `execute` receives it.
#[contracttype]
#[derive(Clone)]
pub struct Call {
    pub target: Address,
    pub function_name: Symbol,
    pub args: Vec<Val>,
    pub executor_authorizations: Vec<Val>,
}

// ---- predicates ----

fn and(kids: StdVec<ScVal>) -> ScVal {
    node("and", alloc::vec![scvec(kids)])
}

fn or(kids: StdVec<ScVal>) -> ScVal {
    node("or", alloc::vec![scvec(kids)])
}

fn fn_is(name: &str) -> ScVal {
    node(
        "eq",
        alloc::vec![scvec(alloc::vec![sym("call_fn")]), sym(name)],
    )
}

/// A `call_path` of the given steps.
fn path(steps: StdVec<ScVal>) -> ScVal {
    let mut items = alloc::vec![sym("call_path")];
    items.extend(steps);
    scvec(items)
}

fn u(n: u32) -> ScVal {
    ScVal::U32(n)
}

fn eq(a: ScVal, b: ScVal) -> ScVal {
    node("eq", alloc::vec![a, b])
}

fn wait_zero() -> ScVal {
    eq(path(alloc::vec![u(2)]), u(0))
}

fn len_is(n: u32) -> ScVal {
    eq(path(alloc::vec![u(0), ScVal::Bool(true)]), u(n))
}

fn target(i: u32) -> ScVal {
    path(alloc::vec![u(0), u(i), sym("target")])
}

fn function(i: u32) -> ScVal {
    path(alloc::vec![u(0), u(i), sym("function_name")])
}

// ---- fixture ----

struct World {
    env: Env,
    interpreter: Address,
    account: Address,
    executor: Address,
    venue: Address,
    token: Address,
    other: Address,
    admin: Signer,
}

#[derive(Debug, PartialEq, Eq)]
enum Outcome {
    Permit,
    Code(u32),
    Unauthorised,
}

fn code<T, E>(r: Result<T, Result<soroban_sdk::Error, E>>) -> Option<u32> {
    match r {
        Ok(_) => None,
        Err(Ok(e)) => Some(e.get_code()),
        Err(Err(_)) => Some(u32::MAX),
    }
}

impl World {
    fn new() -> Self {
        let env = Env::default();
        let interpreter = env.register(PolicyInterpreter, (common::DEFAULT,));
        World {
            interpreter,
            account: Address::generate(&env),
            executor: Address::generate(&env),
            venue: Address::generate(&env),
            token: Address::generate(&env),
            other: Address::generate(&env),
            admin: Signer::Delegated(Address::generate(&env)),
            env,
        }
    }

    fn client(&self) -> PolicyInterpreterClient<'_> {
        PolicyInterpreterClient::new(&self.env, &self.interpreter)
    }

    fn a(&self, a: &Address) -> ScVal {
        addr(&self.env, a)
    }

    fn rule(&self, id: u32, scope: &Address) -> ContextRule {
        ContextRule {
            id,
            context_type: ContextRuleType::CallContract(scope.clone()),
            name: soroban_sdk::String::from_str(&self.env, "rule"),
            signers: Vec::new(&self.env),
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

    fn bind(&self, rule: &ContextRule) -> Option<u32> {
        self.env.mock_all_auths();
        let key = (self.account.clone(), rule.id);
        code(self.client().try_bind_executor(&key, &self.executor))
    }

    /// Install `predicate` on a fresh keyless rule scoped to the executor and
    /// bind it: what `bind_executor` says.
    fn bind_fresh(&self, id: u32, predicate: &ScVal) -> Option<u32> {
        let rule = self.rule(id, &self.executor);
        assert_eq!(self.install(1, predicate, &rule), None, "installs unbound");
        self.bind(&rule)
    }

    fn call(&self, target: &Address, f: &str) -> Call {
        Call {
            target: target.clone(),
            function_name: Symbol::new(&self.env, f),
            args: Vec::new(&self.env),
            executor_authorizations: Vec::new(&self.env),
        }
    }

    /// `execute(calls, [], wait)` on the executor.
    fn execute_ctx(&self, calls: &[Call], wait: u32) -> Context {
        let mut v = Vec::new(&self.env);
        for c in calls {
            v.push_back(c.clone());
        }
        Context::Contract(ContractContext {
            contract: self.executor.clone(),
            fn_name: Symbol::new(&self.env, "execute"),
            args: (v, Vec::<Val>::new(&self.env), wait).into_val(&self.env),
        })
    }

    /// `enforce` with nobody authenticated, the account's authorisation, and
    /// the executor's word for `(account, context)` when `granted`.
    fn enforce(&self, ctx: &Context, rule: &ContextRule, granted: bool) -> Outcome {
        let none: Vec<Signer> = Vec::new(&self.env);
        let args: Vec<Val> = (
            ctx.clone(),
            none.clone(),
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
        match self.client().try_enforce(ctx, &none, rule, &self.account) {
            Ok(Ok(())) => Outcome::Permit,
            Err(Ok(e)) if e.is_type(ScErrorType::Contract) => Outcome::Code(e.get_code()),
            Err(Ok(e)) if e.is_type(ScErrorType::Auth) || e.is_type(ScErrorType::Context) => {
                Outcome::Unauthorised
            }
            other => panic!("unexpected outcome {other:?}"),
        }
    }

    /// Two calls: `venue.submit`, then `token` or `other` `.transfer`.
    fn shape(&self) -> StdVec<ScVal> {
        alloc::vec![
            fn_is("execute"),
            wait_zero(),
            len_is(2),
            eq(target(0), self.a(&self.venue)),
            eq(function(0), sym("submit")),
            node(
                "in",
                alloc::vec![
                    target(1),
                    scvec(alloc::vec![self.a(&self.token), self.a(&self.other)])
                ]
            ),
            eq(function(1), sym("transfer")),
        ]
    }

    /// `shape` with the conjunct at `i` replaced by `with`, or dropped.
    fn shape_but(&self, i: usize, with: Option<ScVal>) -> ScVal {
        let mut kids = self.shape();
        match with {
            Some(k) => kids[i] = k,
            None => {
                kids.remove(i);
            }
        }
        and(kids)
    }
}

// ---- what pins a batch ----

/// Every way of writing the full shape binds.
#[test]
fn a_fully_pinned_immediate_batch_binds() {
    let w = World::new();
    let field = |i: u32, f: &str| scvec(alloc::vec![sym("call_arg_field"), u(0), u(i), sym(f)]);
    let lit = |v: ScVal| scvec(alloc::vec![sym("lit"), v]);
    let accepted = [
        and(w.shape()),
        // The length pinned below the calls pinned.
        w.shape_but(2, Some(len_is(1))),
        // `call_arg_len(0)` and `call_arg_field` spell the same paths.
        w.shape_but(
            2,
            Some(eq(scvec(alloc::vec![sym("call_arg_len"), u(0)]), u(2))),
        ),
        w.shape_but(3, Some(eq(field(0, "target"), w.a(&w.venue)))),
        // The wait written as an i128, a key written as `lit(symbol)`.
        w.shape_but(1, Some(eq(path(alloc::vec![u(2)]), common::i128v(0)))),
        w.shape_but(
            4,
            Some(eq(
                path(alloc::vec![u(0), u(0), lit(sym("function_name"))]),
                sym("submit"),
            )),
        ),
        // Constants on the left.
        w.shape_but(
            0,
            Some(eq(sym("execute"), scvec(alloc::vec![sym("call_fn")]))),
        ),
        // An `or` of two shapes, each pinned on its own branch.
        or(alloc::vec![and(w.shape()), w.shape_but(2, Some(len_is(1)))]),
        // Pinned inside nested `and`s, with further constraints beside them.
        and(alloc::vec![
            and(w.shape()[..3].to_vec()),
            and(w.shape()[3..].to_vec()),
            node(
                "gt",
                alloc::vec![path(alloc::vec![u(0), u(1), sym("args"), u(2)]), u(0)]
            ),
        ]),
    ];
    for (i, p) in accepted.iter().enumerate() {
        assert_eq!(w.bind_fresh(100 + i as u32, p), None, "case {i}");
    }
}

/// A path that leaves any part of the shape open is refused (221).
#[test]
fn anything_less_than_the_full_shape_is_refused_221() {
    let w = World::new();
    let string = |s: &str| ScVal::String(ScString(s.try_into().unwrap()));
    let lte = |a: ScVal, b: ScVal| node("lte", alloc::vec![a, b]);
    let open = [
        // Each conjunct dropped.
        w.shape_but(0, None),
        w.shape_but(1, None),
        w.shape_but(2, None),
        w.shape_but(3, None),
        w.shape_but(4, None),
        w.shape_but(5, None),
        w.shape_but(6, None),
        // The wait above 0, or only bounded.
        w.shape_but(1, Some(eq(path(alloc::vec![u(2)]), u(1)))),
        w.shape_but(1, Some(lte(path(alloc::vec![u(2)]), u(0)))),
        // More calls than are pinned, or a length only bounded.
        w.shape_but(2, Some(len_is(3))),
        w.shape_but(
            2,
            Some(lte(path(alloc::vec![u(0), ScVal::Bool(true)]), u(2))),
        ),
        // A target or function only excluded, or compared with another selector.
        w.shape_but(3, Some(node("ne", alloc::vec![target(0), w.a(&w.token)]))),
        w.shape_but(
            5,
            Some(node(
                "nin",
                alloc::vec![target(1), scvec(alloc::vec![w.a(&w.token)])],
            )),
        ),
        w.shape_but(3, Some(eq(target(0), target(1)))),
        // `in` on call_fn is no pin of `execute`.
        w.shape_but(
            0,
            Some(node(
                "in",
                alloc::vec![
                    scvec(alloc::vec![sym("call_fn")]),
                    scvec(alloc::vec![sym("execute")])
                ],
            )),
        ),
        // The wrong field, the right field spelled as a string, the wrong call.
        w.shape_but(
            3,
            Some(eq(
                path(alloc::vec![u(0), u(0), sym("args")]),
                w.a(&w.venue),
            )),
        ),
        w.shape_but(
            4,
            Some(eq(
                path(alloc::vec![u(0), u(0), string("function_name")]),
                sym("submit"),
            )),
        ),
        w.shape_but(3, Some(eq(target(1), w.a(&w.venue)))),
        // A path deeper than the field.
        w.shape_but(
            3,
            Some(eq(
                path(alloc::vec![u(0), u(0), sym("target"), u(0)]),
                w.a(&w.venue),
            )),
        ),
        // One `or` branch open.
        or(alloc::vec![and(w.shape()), w.shape_but(3, None)]),
        or(alloc::vec![and(w.shape()), fn_is("run"), fn_is("execute")]),
        // `run` on one branch, the batch on the other: neither on every path.
        or(alloc::vec![and(w.shape()), fn_is("run")]),
        // A quantifier over the calls pins nothing.
        and(alloc::vec![
            fn_is("execute"),
            wait_zero(),
            len_is(2),
            node(
                "all",
                alloc::vec![
                    scvec(alloc::vec![sym("call_arg"), u(0)]),
                    eq(
                        scvec(alloc::vec![sym("elem"), sym("target")]),
                        w.a(&w.venue)
                    ),
                ],
            ),
        ]),
        // The function name pinned for the second call only by an `or` of
        // branches, one of which leaves it open.
        w.shape_but(
            6,
            Some(or(alloc::vec![
                eq(function(1), sym("transfer")),
                wait_zero()
            ])),
        ),
    ];
    for (i, p) in open.iter().enumerate() {
        assert_eq!(w.bind_fresh(200 + i as u32, p), Some(221), "case {i}");
    }
}

/// The `run` pin is unchanged, and a rule scoped elsewhere keeps its own
/// predicate whatever it pins.
#[test]
fn the_run_pin_and_other_scopes_are_unchanged() {
    let w = World::new();
    assert_eq!(w.bind_fresh(1, &fn_is("run")), None);
    assert_eq!(w.bind_fresh(2, &fn_is("execute")), Some(221));
    let venue = w.rule(3, &w.venue);
    w.install(1, &fn_is("submit"), &venue);
    assert_eq!(w.bind(&venue), None);
}

// ---- re-install and enforce ----

/// Under the binding a re-install may tighten the batch, not open it.
#[test]
fn a_reinstall_under_the_binding_cannot_open_the_batch() {
    let w = World::new();
    let rule = w.rule(7, &w.executor);
    w.install(1, &and(w.shape()), &rule);
    assert_eq!(w.bind(&rule), None);
    assert_eq!(w.install(2, &w.shape_but(3, None), &rule), Some(221));
    assert_eq!(w.install(2, &w.shape_but(1, None), &rule), Some(221));
    assert_eq!(w.install(2, &w.shape_but(2, Some(len_is(1))), &rule), None);
}

/// `enforce` permits the pinned batch only with the executor's word for that
/// exact context, refuses a batch off the shape, and refuses the stored path.
#[test]
fn enforce_permits_the_pinned_batch_with_the_word() {
    let w = World::new();
    let rule = w.rule(7, &w.executor);
    w.install(1, &and(w.shape()), &rule);
    w.bind(&rule);
    let good = [w.call(&w.venue, "submit"), w.call(&w.other, "transfer")];
    let ctx = w.execute_ctx(&good, 0);
    assert_eq!(w.enforce(&ctx, &rule, true), Outcome::Permit);
    assert_eq!(w.enforce(&ctx, &rule, false), Outcome::Unauthorised);
    let off = [
        alloc::vec![w.call(&w.venue, "submit"), w.call(&w.venue, "transfer")],
        alloc::vec![w.call(&w.venue, "submit"), w.call(&w.token, "approve")],
        alloc::vec![w.call(&w.venue, "submit")],
        alloc::vec![
            w.call(&w.venue, "submit"),
            w.call(&w.token, "transfer"),
            w.call(&w.token, "transfer"),
        ],
    ];
    for (i, calls) in off.iter().enumerate() {
        let ctx = w.execute_ctx(calls, 0);
        let got = w.enforce(&ctx, &rule, true);
        // 105 is the `in` of the second target missing, 100 any other miss.
        let want = if i == 0 { 105 } else { 100 };
        assert_eq!(got, Outcome::Code(want), "case {i}");
    }
    assert_eq!(
        w.enforce(&w.execute_ctx(&good, 5), &rule, true),
        Outcome::Code(100)
    );
}

/// A direct install can misstate the scope and so skip the re-install check;
/// `enforce` checks the rule the account passes and refuses the open batch.
#[test]
fn enforce_refuses_an_open_batch_whatever_install_was_told() {
    let w = World::new();
    let real = w.rule(7, &w.executor);
    w.install(1, &and(w.shape()), &real);
    w.bind(&real);
    let forged = w.rule(7, &w.venue);
    assert_eq!(w.install(2, &w.shape_but(3, None), &forged), None);
    let good = [w.call(&w.venue, "submit"), w.call(&w.other, "transfer")];
    assert_eq!(
        w.enforce(&w.execute_ctx(&good, 0), &real, true),
        Outcome::Code(221)
    );
}
