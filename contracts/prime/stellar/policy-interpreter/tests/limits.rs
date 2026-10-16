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

/// Every field, one at a time: (name, how to set it).
type Setter = fn(&mut Limits, u32);
const FIELDS: [(&str, Setter, u32); 6] = [
    ("max_reads", |l, v| l.max_reads = v, CEILING.max_reads),
    ("max_leaves", |l, v| l.max_leaves = v, CEILING.max_leaves),
    (
        "max_predicate_bytes",
        |l, v| l.max_predicate_bytes = v,
        CEILING.max_predicate_bytes,
    ),
    ("max_elems", |l, v| l.max_elems = v, CEILING.max_elems),
    (
        "max_in_operands",
        |l, v| l.max_in_operands = v,
        CEILING.max_in_operands,
    ),
    ("max_depth", |l, v| l.max_depth = v, CEILING.max_depth),
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
fn every_field_must_be_at_least_one() {
    for (name, set, _) in FIELDS {
        let mut l = DEFAULT;
        set(&mut l, 0);
        assert!(the_constructor_fails_with(l), "{name} = 0 was accepted");
        set(&mut l, 1);
        let env = Env::default();
        assert_eq!(deploy(&env, l).limits(), l, "{name} = 1 must be accepted");
    }
}

#[test]
fn every_field_must_be_at_most_its_ceiling() {
    for (name, set, ceiling) in FIELDS {
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
    let one = Limits {
        max_depth: 1,
        ..SMALL
    };
    assert!(!refused(says(&env, &deploy(&env, one), &nested(0), &[])));
    assert!(refused(says(&env, &deploy(&env, one), &nested(1), &[])));
}

#[test]
fn leaf_nesting_depth_is_the_stored_one() {
    let env = Env::default();
    let c = deploy(&env, SMALL);
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
    for (elems, leaves, fits) in [(3, 9, true), (3, 8, false), (2, 7, true), (2, 6, false)] {
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
    for (elems, leaves, fits) in [(3, 7, true), (3, 6, false), (5, 9, true), (5, 8, false)] {
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
