//! The hard limits are a deploy-time choice: `__constructor(Limits)` stores them
//! once, `limits()` shows them, and `install` and `check` hold every predicate to
//! the stored values - not to any constant. Each test below runs at a setting that
//! is neither the default nor the ceiling, so a limit read from the wrong place (a
//! constant, or a neighbouring field) fails it.

extern crate alloc;
mod common;

use alloc::vec::Vec as StdVec;
use common::*;
use policy_interpreter::{
    ContextRule, ContextRuleType, Limits, PolicyError as E, PolicyInstallParams, PolicyInterpreter,
    PolicyInterpreterClient, Signer,
};
use soroban_sdk::auth::{Context, ContractContext};
use soroban_sdk::testutils::Address as _;
use soroban_sdk::xdr::ScVal;
use soroban_sdk::{Address, Bytes, BytesN, Env, IntoVal, Symbol, Val, Vec};

const SMALL: Limits = Limits {
    max_reads: 2,
    max_leaves: 9,
    max_predicate_bytes: 700,
    max_elems: 3,
    max_in_operands: 4,
    max_depth: 3,
};

fn deploy(env: &Env, l: Limits) -> PolicyInterpreterClient<'_> {
    PolicyInterpreterClient::new(env, &env.register(PolicyInterpreter, (l,)))
}

fn call(env: &Env, f: &str, args: &[Val]) -> Context {
    Context::Contract(ContractContext {
        contract: Address::generate(env),
        fn_name: Symbol::new(env, f),
        args: Vec::from_slice(env, args),
    })
}

fn arg(i: u32) -> ScVal {
    node("call_arg", alloc::vec![ScVal::U32(i)])
}

fn pin() -> ScVal {
    node(
        "eq",
        alloc::vec![node("call_fn", alloc::vec![]), sym("pay")],
    )
}

/// What `check` says about `p` on a `pay` call carrying `args`.
fn says(env: &Env, c: &PolicyInterpreterClient, p: &ScVal, args: &[Val]) -> u32 {
    verdict(c, &xdr_bytes(env, p), &call(env, "pay", args))
}

/// `check`'s contract error, or `None` for any other failure.
fn try_verdict(c: &PolicyInterpreterClient, p: &Bytes, ctx: &Context) -> Option<u32> {
    match c.try_check(p, ctx) {
        Err(Ok(e)) => Some(e.get_code()),
        _ => None,
    }
}

fn refused(code: u32) -> bool {
    code == E::MalformedPredicate as u32
}

fn the_constructor_fails_with(l: Limits) -> bool {
    let env = Env::default();
    let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        env.register(PolicyInterpreter, (l,))
    }));
    r.is_err() && {
        let again =
            std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| deploy(&env, l).limits()));
        again.is_err()
    }
}

/// Every field, one at a time: (name, how to set it, its floor, its ceiling).
/// `max_elems` starts at 2: at 1 a quantifier body leaf (weight `max_elems`) weighs
/// what any other leaf does, and the placement rules, which read the weights, stop
/// telling a body from the top level (see `placement_holds_at_every_elems`). The
/// others start where the smallest rule of any use still installs (see
/// `the_smallest_useful_rule_installs_at_every_floor`).
type Setter = fn(&mut Limits, u32);
const FIELDS: [(&str, Setter, u32, u32); 6] = [
    ("max_reads", |l, v| l.max_reads = v, 1, CEILING.max_reads),
    ("max_leaves", |l, v| l.max_leaves = v, 4, CEILING.max_leaves),
    (
        "max_predicate_bytes",
        |l, v| l.max_predicate_bytes = v,
        256,
        CEILING.max_predicate_bytes,
    ),
    ("max_elems", |l, v| l.max_elems = v, 2, CEILING.max_elems),
    (
        "max_in_operands",
        |l, v| l.max_in_operands = v,
        1,
        CEILING.max_in_operands,
    ),
    ("max_depth", |l, v| l.max_depth = v, 2, CEILING.max_depth),
];

#[test]
fn the_defaults_are_the_values_grammar_7_shipped_with() {
    let d = DEFAULT;
    assert_eq!(
        (d.max_reads, d.max_leaves, d.max_predicate_bytes),
        (4, 200, 32 * 1024)
    );
    assert_eq!((d.max_elems, d.max_in_operands, d.max_depth), (32, 32, 5));
}

#[test]
fn limits_are_stored_and_shown() {
    for l in [DEFAULT, CEILING, SMALL] {
        let env = Env::default();
        assert_eq!(deploy(&env, l).limits(), l);
    }
}

#[test]
fn every_field_must_be_at_least_its_floor() {
    for (name, set, floor, _) in FIELDS {
        let mut l = DEFAULT;
        set(&mut l, floor - 1);
        assert!(
            the_constructor_fails_with(l),
            "{name} = {} was accepted",
            floor - 1
        );
        set(&mut l, floor);
        let env = Env::default();
        assert_eq!(
            deploy(&env, l).limits(),
            l,
            "{name} = {floor} must be accepted"
        );
    }
    // The case the floor exists for: one element per quantifier is refused outright.
    let one = Limits {
        max_elems: 1,
        ..DEFAULT
    };
    assert!(the_constructor_fails_with(one));
}

#[test]
fn every_field_must_be_at_most_its_ceiling() {
    for (name, set, _, ceiling) in FIELDS {
        let mut l = DEFAULT;
        set(&mut l, ceiling + 1);
        assert!(
            the_constructor_fails_with(l),
            "{name} above the ceiling was accepted"
        );
        set(&mut l, ceiling);
        let env = Env::default();
        assert_eq!(
            deploy(&env, l).limits(),
            l,
            "{name} at the ceiling must be accepted"
        );
    }
}

#[test]
fn a_refused_constructor_reports_limits_out_of_range() {
    assert_eq!(E::LimitsOutOfRange as u32, 220);
    let env = Env::default();
    let mut l = DEFAULT;
    l.max_reads = 0;
    let msg = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        env.register(PolicyInterpreter, (l,))
    }))
    .expect_err("refused");
    let text = msg
        .downcast_ref::<std::string::String>()
        .cloned()
        .or_else(|| msg.downcast_ref::<&str>().map(|s| (*s).into()))
        .unwrap_or_default();
    assert!(text.contains("#220"), "{text}");
}

#[test]
fn the_byte_cap_is_the_stored_one() {
    let env = Env::default();
    let c = deploy(&env, SMALL);
    let at = |n: u32| Bytes::from_slice(&env, &alloc::vec![0u8; n as usize]);
    let ctx = call(&env, "pay", &[]);
    // At the cap the bytes are parsed (zeros are not XDR, so the host refuses them).
    assert!(try_verdict(&c, &at(700), &ctx) != Some(E::PredicateTooLarge as u32));
    assert_eq!(verdict(&c, &at(701), &ctx), E::PredicateTooLarge as u32);
}

#[test]
fn install_applies_the_stored_byte_cap() {
    let env = Env::default();
    env.mock_all_auths();
    let c = deploy(&env, SMALL);
    let account = Address::generate(&env);
    let signers = soroban_sdk::vec![&env, Signer::Delegated(account.clone())];
    let rule = ContextRule {
        id: 1,
        context_type: ContextRuleType::CallContract(Address::generate(&env)),
        name: soroban_sdk::String::from_str(&env, "rule"),
        signers: signers.clone(),
        signer_ids: Vec::new(&env),
        policies: Vec::new(&env),
        policy_ids: Vec::new(&env),
        valid_until: None,
    };
    let install = |n: u32| {
        let predicate = Bytes::from_slice(&env, &alloc::vec![0u8; n as usize]);
        let hash: BytesN<32> = env.crypto().sha256(&predicate).into();
        let p = PolicyInstallParams {
            grammar_version: 7,
            install_nonce: 1,
            predicate,
            predicate_hash: hash,
            policy_admins: signers.clone(),
        };
        c.try_install(&p, &rule, &account)
    };
    let code = |n| match install(n) {
        Err(Ok(e)) => e.get_code(),
        other => panic!("{other:?}"),
    };
    assert_eq!(code(701), E::PredicateTooLarge as u32);
    // 700 bytes is under the cap (the default would also pass it); 33,000 is over
    // the stored one and under the default one.
    assert_ne!(code(700), E::PredicateTooLarge as u32);
    assert_eq!(code(33_000), E::PredicateTooLarge as u32);
}

#[test]
fn depth_is_the_stored_one() {
    let env = Env::default();
    let c = deploy(&env, SMALL);
    // `and` nested k deep around one compare: k + 1 levels.
    let nested = |k: usize| {
        (0..k).fold(pin(), |inner, _| {
            node("and", alloc::vec![vec(alloc::vec![inner])])
        })
    };
    assert!(!refused(says(&env, &c, &nested(2), &[])));
    assert!(refused(says(&env, &c, &nested(3), &[])));
    // The same predicate under a deeper deployment is fine, under the default too.
    let deep = Limits {
        max_depth: 4,
        ..SMALL
    };
    assert!(!refused(says(&env, &deploy(&env, deep), &nested(3), &[])));
    let two = Limits {
        max_depth: 2,
        ..SMALL
    };
    assert!(!refused(says(&env, &deploy(&env, two), &nested(1), &[])));
    assert!(refused(says(&env, &deploy(&env, two), &nested(2), &[])));
}

#[test]
fn leaf_nesting_depth_is_the_stored_one() {
    let env = Env::default();
    // Everything but the depth is loose, so only the depth can refuse.
    let loose = Limits {
        max_leaves: 400,
        max_reads: 8,
        ..SMALL
    };
    let c = deploy(&env, loose);
    let scaled = |inner: ScVal| node("scaled", alloc::vec![inner, i128v(1), i128v(1), i128v(0)]);
    let ge = |leaf| node("gte", alloc::vec![arg(0), leaf]);
    // `scaled(scaled(1))` is leaf depth 3, `scaled(scaled(scaled(1)))` is 4.
    assert!(!refused(says(&env, &c, &ge(scaled(scaled(i128v(1)))), &[])));
    assert!(refused(says(
        &env,
        &c,
        &ge(scaled(scaled(scaled(i128v(1))))),
        &[]
    )));
}

#[test]
fn the_leaf_cap_is_the_stored_one() {
    let env = Env::default();
    let c = deploy(&env, SMALL);
    // Each compare is two leaves; the pin is two more.
    let n = |k: usize| {
        let mut kids = alloc::vec![pin()];
        kids.extend((0..k).map(|_| node("eq", alloc::vec![arg(0), i128v(1)])));
        node("and", alloc::vec![vec(kids)])
    };
    assert!(!refused(says(&env, &c, &n(2), &[])), "6 leaves");
    assert!(!refused(says(&env, &c, &n(3), &[])), "8 leaves");
    assert!(refused(says(&env, &c, &n(4), &[])), "10 leaves > 9");
    let wide = Limits {
        max_leaves: 10,
        ..SMALL
    };
    assert!(!refused(says(&env, &deploy(&env, wide), &n(4), &[])));
}

#[test]
fn a_quantifier_body_leaf_weighs_the_stored_element_count() {
    let env = Env::default();
    // all(arg0, eq(elem, 1)): the vector (1), the elem (E) and the constant (E),
    // and the pin (2) beside it.
    let quant = node(
        "and",
        alloc::vec![vec(alloc::vec![
            pin(),
            node(
                "all",
                alloc::vec![
                    arg(0),
                    node("eq", alloc::vec![node("elem", alloc::vec![]), i128v(1)])
                ]
            )
        ])],
    );
    for (elems, leaves, fits) in [
        (3, 9, true),
        (3, 8, false),
        (2, 7, true),
        (2, 6, false),
        (40, 83, true),
        (40, 82, false),
    ] {
        let l = Limits {
            max_elems: elems,
            max_leaves: leaves,
            ..SMALL
        };
        let got = says(&env, &deploy(&env, l), &quant, &[]);
        assert_eq!(!refused(got), fits, "elems {elems}, leaves {leaves}: {got}");
    }
}

#[test]
fn a_sum_weighs_the_stored_element_count() {
    let env = Env::default();
    // gte(sum(arg0), 1): the sum (E), its source (1) and the constant (1), plus the pin (2).
    let total = node(
        "and",
        alloc::vec![vec(alloc::vec![
            pin(),
            node(
                "gte",
                alloc::vec![node("sum", alloc::vec![arg(0)]), i128v(1)]
            )
        ])],
    );
    for (elems, leaves, fits) in [
        (3, 7, true),
        (3, 6, false),
        (5, 9, true),
        (5, 8, false),
        (40, 44, true),
        (40, 43, false),
    ] {
        let l = Limits {
            max_elems: elems,
            max_leaves: leaves,
            ..SMALL
        };
        let got = says(&env, &deploy(&env, l), &total, &[]);
        assert_eq!(!refused(got), fits, "elems {elems}, leaves {leaves}: {got}");
    }
}

#[test]
fn the_in_list_cap_is_the_stored_one() {
    let env = Env::default();
    let c = deploy(&env, SMALL);
    let list = |k: i128| {
        node(
            "in",
            alloc::vec![arg(0), vec((0..k).map(i128v).collect::<StdVec<_>>())],
        )
    };
    assert!(!refused(says(&env, &c, &list(4), &[])));
    assert!(refused(says(&env, &c, &list(5), &[])));
    let wide = Limits {
        max_in_operands: 5,
        ..SMALL
    };
    assert!(!refused(says(&env, &deploy(&env, wide), &list(5), &[])));
}

#[test]
fn the_read_cap_is_the_stored_one() {
    let env = Env::default();
    let reads = |k: u32| {
        let kids = (0..k)
            .map(|_| {
                let target = addr(&env, &Address::generate(&env));
                let read = node(
                    "read",
                    alloc::vec![target, sym("price"), vec(StdVec::new())],
                );
                node("gte", alloc::vec![read, i128v(0)])
            })
            .collect::<StdVec<_>>();
        node("and", alloc::vec![vec([alloc::vec![pin()], kids].concat())])
    };
    let c = deploy(
        &env,
        Limits {
            max_leaves: 20,
            ..SMALL
        },
    );
    assert!(!refused(says(&env, &c, &reads(2), &[])));
    assert!(refused(says(&env, &c, &reads(3), &[])));
    let more = Limits {
        max_reads: 3,
        max_leaves: 20,
        ..SMALL
    };
    assert!(!refused(says(&env, &deploy(&env, more), &reads(3), &[])));
}

#[test]
fn the_element_cap_is_the_stored_one_when_the_rule_runs() {
    let env = Env::default();
    let c = deploy(&env, SMALL);
    let every = node(
        "all",
        alloc::vec![
            arg(0),
            node("eq", alloc::vec![node("elem", alloc::vec![]), i128v(1)])
        ],
    );
    let p = node("and", alloc::vec![vec(alloc::vec![pin(), every])]);
    let ones = |n: usize| -> Val {
        Vec::<Val>::from_slice(&env, &alloc::vec![1i128.into_val(&env); n]).into_val(&env)
    };
    let got = says(&env, &c, &p, &[ones(3)]);
    assert_eq!(got, 0, "{got}");
    assert_eq!(says(&env, &c, &p, &[ones(4)]), E::ArgMismatch as u32);
    let wide = deploy(
        &env,
        Limits {
            max_elems: 4,
            max_leaves: 11,
            ..SMALL
        },
    );
    assert_eq!(says(&env, &wide, &p, &[ones(4)]), 0);
}

#[test]
fn nested_quantifier_weights_cannot_overflow() {
    // At the ceilings a quantifier chain would weigh 64^7 and wrap a u32; it must
    // end in a clean refusal, not a trap.
    let env = Env::default();
    let c = deploy(&env, CEILING);
    let leaf = node("eq", alloc::vec![node("elem", alloc::vec![]), i128v(1)]);
    // Seven `all`s around one compare: depth 8, the most the ceiling allows.
    let p = (0..7).fold(leaf, |body, _| node("all", alloc::vec![arg(0), body]));
    assert!(refused(says(&env, &c, &p, &[])));
}

#[test]
fn a_read_argument_counts_toward_the_leaf_cap() {
    let env = Env::default();
    // gte(read(C, price, [call_arg(0)]), 0): the read, its argument and the constant,
    // beside the pin's two.
    let target = addr(&env, &Address::generate(&env));
    let read = node(
        "read",
        alloc::vec![target, sym("price"), vec(alloc::vec![arg(0)])],
    );
    let p = node(
        "and",
        alloc::vec![vec(alloc::vec![
            pin(),
            node("gte", alloc::vec![read, i128v(0)])
        ])],
    );
    for (leaves, fits) in [(5, true), (4, false)] {
        let l = Limits {
            max_leaves: leaves,
            ..SMALL
        };
        assert_eq!(
            !refused(says(&env, &deploy(&env, l), &p, &[])),
            fits,
            "{leaves} leaves"
        );
    }
}

/// `all(arg0, body)` / `any(arg0, body)` beside the pin, as one rule.
fn quantified(kind: &str, body: ScVal) -> ScVal {
    node(
        "and",
        alloc::vec![vec(alloc::vec![
            pin(),
            node(kind, alloc::vec![arg(0), body])
        ])],
    )
}

fn elem() -> ScVal {
    node("elem", alloc::vec![])
}

/// Every placement rule (where `elem`, a quantifier and a `sum` may stand), at the
/// smallest, a typical and the largest `max_elems`: the rules read leaf weights, and
/// a weight is only worth reading when a body leaf (`max_elems`) differs from a
/// top-level one (1).
#[test]
fn placement_holds_at_every_elems() {
    let env = Env::default();
    let scaled = |inner| node("scaled", alloc::vec![inner, i128v(1), i128v(1), i128v(0)]);
    let body = || node("eq", alloc::vec![elem(), i128v(1)]);
    let at_top = |leaf| node("and", alloc::vec![vec(alloc::vec![pin(), leaf])]);
    // (what, rule, is refused)
    let cases: StdVec<(&str, ScVal, bool)> = alloc::vec![
        (
            "elem at the top level",
            at_top(node("ne", alloc::vec![elem(), i128v(1)])),
            true
        ),
        (
            "elem against null at the top level",
            at_top(node("eq", alloc::vec![elem(), sym("x")])),
            true
        ),
        (
            "elem as the vector of its own quantifier",
            at_top(node("all", alloc::vec![elem(), body()])),
            true
        ),
        (
            "elem as a read argument at the top level",
            at_top(node(
                "gte",
                alloc::vec![
                    node(
                        "read",
                        alloc::vec![
                            addr(&env, &Address::generate(&env)),
                            sym("p"),
                            vec(alloc::vec![elem()])
                        ]
                    ),
                    i128v(0)
                ]
            )),
            true,
        ),
        (
            "elem as a sum source at the top level",
            at_top(node(
                "gte",
                alloc::vec![node("sum", alloc::vec![elem()]), i128v(0)]
            )),
            true
        ),
        (
            "elem as an in needle at the top level",
            at_top(node("in", alloc::vec![elem(), vec(alloc::vec![i128v(1)])])),
            true
        ),
        (
            "a quantifier inside a body",
            quantified("all", node("all", alloc::vec![arg(1), body()])),
            true
        ),
        (
            "a sum inside a body",
            quantified(
                "all",
                node(
                    "gte",
                    alloc::vec![node("sum", alloc::vec![arg(1)]), i128v(0)]
                )
            ),
            true
        ),
        (
            "a quantifier inside an any body",
            quantified("any", node("any", alloc::vec![arg(1), body()])),
            true
        ),
        ("elem in a body", quantified("all", body()), false),
        ("elem in an any body", quantified("any", body()), false),
        (
            "elem inside scaled in a body",
            quantified("all", node("gte", alloc::vec![scaled(elem()), i128v(1)])),
            false
        ),
        (
            "a sum at the top level",
            at_top(node(
                "gte",
                alloc::vec![node("sum", alloc::vec![arg(0)]), i128v(0)]
            )),
            false
        ),
    ];
    for elems in [2, 32, 64] {
        let c = deploy(
            &env,
            Limits {
                max_elems: elems,
                ..CEILING
            },
        );
        for (what, rule, is_refused) in &cases {
            let got = says(&env, &c, rule, &[]);
            assert_eq!(refused(got), *is_refused, "elems {elems}: {what}: {got}");
        }
    }
}

/// Loose everywhere (the ceilings) but the one field a test sets, so only that field can refuse.
fn only(set: impl Fn(&mut Limits)) -> Limits {
    let mut l = CEILING;
    set(&mut l);
    l
}

/// Install `predicate` (it must install) on a rule scoped to `target`, then `enforce` a `pay`
/// call carrying `args`: `Ok` for a permit, else the contract error.
fn installed_then_enforced(l: Limits, predicate: &ScVal, args: &[ScVal]) -> Result<(), u32> {
    let env = Env::default();
    env.mock_all_auths();
    let c = deploy(&env, l);
    let account = Address::generate(&env);
    let target = Address::generate(&env);
    let signers = soroban_sdk::vec![&env, Signer::Delegated(account.clone())];
    let rule = ContextRule {
        id: 1,
        context_type: ContextRuleType::CallContract(target.clone()),
        name: soroban_sdk::String::from_str(&env, "rule"),
        signers: signers.clone(),
        signer_ids: Vec::new(&env),
        policies: Vec::new(&env),
        policy_ids: Vec::new(&env),
        valid_until: None,
    };
    let bytes = xdr_bytes(&env, predicate);
    let p = PolicyInstallParams {
        grammar_version: 7,
        install_nonce: 1,
        predicate_hash: env.crypto().sha256(&bytes).into(),
        predicate: bytes,
        policy_admins: signers.clone(),
    };
    if let Err(e) = c.try_install(&p, &rule, &account) {
        panic!("the rule must install: {e:?}");
    }
    let ctx = Context::Contract(ContractContext {
        contract: target,
        fn_name: Symbol::new(&env, "pay"),
        args: Vec::from_slice(
            &env,
            &args
                .iter()
                .map(|a| a.into_val(&env))
                .collect::<StdVec<Val>>(),
        ),
    });
    match c.try_enforce(&ctx, &signers, &rule, &account) {
        Ok(_) => Ok(()),
        Err(Ok(e)) => Err(e.get_code()),
        other => panic!("{other:?}"),
    }
}

/// A vector of `n` ones, as an argument.
fn ones(n: usize) -> ScVal {
    vec(alloc::vec![i128v(1); n])
}

#[test]
fn enforce_decodes_with_the_stored_depth() {
    // A rule nested deeper than the default (5) that its instance allows: install
    // accepted it, and `enforce` decodes it again under the same stored depth.
    let nested = |k: usize| {
        (0..k).fold(pin(), |inner, _| {
            node("and", alloc::vec![vec(alloc::vec![inner])])
        })
    };
    let deep = only(|l| l.max_depth = 7);
    assert_eq!(installed_then_enforced(deep, &nested(6), &[]), Ok(()));
    // And at less than the default it is `install` that holds the line, `enforce`
    // the same: a depth-2 instance runs a two-level rule.
    let shallow = only(|l| l.max_depth = 2);
    assert_eq!(installed_then_enforced(shallow, &nested(1), &[]), Ok(()));
}

#[test]
fn enforce_visits_the_stored_element_count() {
    let every = |kind: &str| {
        node(
            "and",
            alloc::vec![vec(alloc::vec![
                pin(),
                node(
                    kind,
                    alloc::vec![arg(0), node("eq", alloc::vec![elem(), i128v(1)])]
                )
            ])],
        )
    };
    let denied = Err(E::ArgMismatch as u32);
    // above the default (32) and below it
    for (elems, n) in [(40usize, 33usize), (40, 40), (3, 3)] {
        let l = only(|l| l.max_elems = elems as u32);
        assert_eq!(
            installed_then_enforced(l, &every("all"), &[ones(n)]),
            Ok(()),
            "all, {n} of {elems}"
        );
        assert_eq!(
            installed_then_enforced(l, &every("any"), &[ones(n)]),
            Ok(()),
            "any, {n} of {elems}"
        );
        // one more element than the instance visits denies
        assert_eq!(
            installed_then_enforced(l, &every("all"), &[ones(elems + 1)]),
            denied,
            "all, {} of {elems}",
            elems + 1
        );
        assert_eq!(
            installed_then_enforced(l, &every("any"), &[ones(elems + 1)]),
            denied,
            "any, {} of {elems}",
            elems + 1
        );
    }
}

#[test]
fn a_sum_walks_the_stored_element_count_when_the_rule_runs() {
    let total = node(
        "and",
        alloc::vec![vec(alloc::vec![
            pin(),
            node(
                "gte",
                alloc::vec![node("sum", alloc::vec![arg(0)]), i128v(1)]
            )
        ])],
    );
    for elems in [3usize, 40] {
        let env = Env::default();
        let l = only(|l| l.max_elems = elems as u32);
        // `enforce` ...
        assert_eq!(installed_then_enforced(l, &total, &[ones(elems)]), Ok(()));
        assert_eq!(
            installed_then_enforced(l, &total, &[ones(elems + 1)]),
            Err(E::ArgMismatch as u32),
            "{elems}"
        );
        // ... and `check`, which evaluates the same way.
        let c = deploy(&env, l);
        assert_eq!(says(&env, &c, &total, &[ones(elems).into_val(&env)]), 0);
        assert_ne!(says(&env, &c, &total, &[ones(elems + 1).into_val(&env)]), 0);
    }
}

#[test]
fn a_bare_vec_nests_to_the_stored_depth() {
    // eq(arg0, [[1]]) is depth 3, eq(arg0, [[[1]]]) is 4: the constant's own nesting is
    // held to `max_depth` with every other limit loose.
    let env = Env::default();
    let held = |k: usize| {
        let constant = (0..k).fold(i128v(1), |x, _| vec(alloc::vec![x]));
        node(
            "and",
            alloc::vec![vec(alloc::vec![
                pin(),
                node("eq", alloc::vec![arg(0), constant])
            ])],
        )
    };
    let c = deploy(&env, only(|l| l.max_depth = 3));
    assert!(!refused(says(&env, &c, &held(2), &[])));
    assert!(refused(says(&env, &c, &held(3), &[])));
    let deeper = deploy(&env, only(|l| l.max_depth = 4));
    assert!(!refused(says(&env, &deeper, &held(3), &[])));
}

#[test]
fn the_smallest_useful_rule_installs_at_every_floor() {
    // A function pin and one constraint on an argument, every limit at its floor at
    // once: if the floors refused this, an instance deployed at them could hold no rule.
    let mut l = CEILING;
    for (_, set, floor, _) in FIELDS {
        set(&mut l, floor);
    }
    let rule = node(
        "and",
        alloc::vec![vec(alloc::vec![
            pin(),
            node("eq", alloc::vec![arg(0), i128v(1)])
        ])],
    );
    assert_eq!(installed_then_enforced(l, &rule, &[i128v(1)]), Ok(()));
    assert_eq!(
        installed_then_enforced(l, &rule, &[i128v(2)]),
        Err(E::ArgMismatch as u32)
    );
}
