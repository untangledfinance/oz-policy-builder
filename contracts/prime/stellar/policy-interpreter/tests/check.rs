//! `check`: the read-only dry run the off-chain builder simulates through.
//!
//! It must say what `install` and `enforce` would say, with no storage and no
//! auth: every deny code, every install-time refusal, a `read`, and agreement
//! with a real install + enforce on the same predicate and call.

extern crate alloc;
mod common;

use alloc::vec::Vec as StdVec;
use common::*;
use policy_interpreter::{
    ContextRule, ContextRuleType, PolicyError as E, PolicyInstallParams, PolicyInterpreter,
    PolicyInterpreterClient, Signer,
};
use soroban_sdk::auth::{
    Context, ContractContext, ContractExecutable, CreateContractHostFnContext,
};
use soroban_sdk::testutils::Address as _;
use soroban_sdk::xdr::ScVal;
use soroban_sdk::{contract, contractimpl, Address, BytesN, Env, IntoVal, Symbol, Val, Vec};

#[contract]
pub struct Registry;

#[contractimpl]
impl Registry {
    pub fn contains(_e: &Env, who: Address) -> bool {
        who == Address::from_str(
            _e,
            "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM",
        )
    }
}

struct W {
    env: Env,
    client: PolicyInterpreterClient<'static>,
    target: Address,
}

impl W {
    fn new() -> Self {
        // No `mock_all_auths`: `check` must not ask for any authorisation.
        let env = Env::default();
        let id = env.register(PolicyInterpreter, ());
        let client = PolicyInterpreterClient::new(&env, &id);
        let target = Address::generate(&env);
        W {
            env,
            client,
            target,
        }
    }

    fn call(&self, f: &str, args: &[Val]) -> Context {
        Context::Contract(ContractContext {
            contract: self.target.clone(),
            fn_name: Symbol::new(&self.env, f),
            args: Vec::from_slice(&self.env, args),
        })
    }

    fn check(&self, p: &ScVal, c: &Context) -> u32 {
        self.client.check(&xdr_bytes(&self.env, p), c)
    }
}

fn arg0(eqto: i128) -> ScVal {
    node(
        "eq",
        alloc::vec![node("call_arg", alloc::vec![ScVal::U32(0)]), i128v(eqto)],
    )
}

fn fn_is(name: &str) -> ScVal {
    node("eq", alloc::vec![node("call_fn", alloc::vec![]), sym(name)])
}

#[test]
fn permits_with_zero_and_denies_with_the_enforce_code() {
    let w = W::new();
    let five: Val = 5i128.into_val(&w.env);
    let ctx = w.call("pay", &[five]);
    assert_eq!(w.check(&arg0(5), &ctx), 0);
    assert_eq!(w.check(&arg0(6), &ctx), E::ArgMismatch as u32);
    let other = node(
        "eq",
        alloc::vec![
            node("call_contract", alloc::vec![]),
            addr(&w.env, &Address::generate(&w.env))
        ],
    );
    assert_eq!(w.check(&other, &ctx), E::ContractScope as u32);
    let order = node(
        "lt",
        alloc::vec![
            node("call_fn", alloc::vec![]),
            node("call_arg", alloc::vec![ScVal::U32(0)])
        ],
    );
    assert_eq!(w.check(&order, &ctx), E::UnsupportedNode as u32);
    let listed = node(
        "in",
        alloc::vec![
            node("call_arg", alloc::vec![ScVal::U32(0)]),
            vec(alloc::vec![i128v(1), i128v(2)])
        ],
    );
    assert_eq!(w.check(&listed, &ctx), E::NotInAllowlist as u32);
    let big = node(
        "scaled",
        alloc::vec![
            node("call_arg", alloc::vec![ScVal::U32(0)]),
            i128v(i128::MAX),
            i128v(1),
            i128v(0)
        ],
    );
    let overflow = node("gte", alloc::vec![big, i128v(0)]);
    assert_eq!(w.check(&overflow, &ctx), E::ArithmeticOverflow as u32);
}

#[test]
fn reports_the_install_refusals_as_codes() {
    let w = W::new();
    let ctx = w.call("pay", &[]);
    // Not a predicate (a lone number), and a predicate the decoder refuses.
    // Bytes that are not XDR at all trap in the host before the contract runs.
    assert_eq!(w.check(&ScVal::U32(5), &ctx), E::MalformedPredicate as u32);
    assert_eq!(
        w.check(&node("bogus", alloc::vec![]), &ctx),
        E::MalformedPredicate as u32
    );
    // No leaf over the call: `now` alone is not a selector.
    let clock = node("lt", alloc::vec![node("now", alloc::vec![]), i128v(5)]);
    assert_eq!(w.check(&clock, &ctx), E::SelectorLeafRequired as u32);
    // Only a contract call is checked.
    let create = Context::CreateContractHostFn(CreateContractHostFnContext {
        executable: ContractExecutable::Wasm(BytesN::from_array(&w.env, &[0; 32])),
        salt: BytesN::from_array(&w.env, &[0; 32]),
    });
    assert_eq!(w.check(&fn_is("pay"), &create), E::MissingState as u32);
}

/// The byte cap is inclusive: a predicate of exactly 32 KiB is read, one byte
/// more is refused before any parse work.
#[test]
fn byte_cap_is_inclusive() {
    let w = W::new();
    let ctx = w.call("pay", &[]);
    let sized = |n: usize| {
        let pad = ScVal::Bytes(soroban_sdk::xdr::ScBytes(
            alloc::vec![0u8; n].try_into().unwrap(),
        ));
        let p = node(
            "and",
            alloc::vec![vec(alloc::vec![
                fn_is("pay"),
                node("ne", alloc::vec![node("lit", alloc::vec![pad]), i128v(1)])
            ])],
        );
        xdr_bytes(&w.env, &p)
    };
    let base = sized(0).len() as usize;
    let exact = sized(32 * 1024 - base);
    assert_eq!(exact.len(), 32 * 1024);
    assert_eq!(w.client.check(&exact, &ctx), 0);
    let over = sized(32 * 1024 - base + 4);
    assert_eq!(w.client.check(&over, &ctx), E::PredicateTooLarge as u32);
}

#[test]
fn runs_a_read_and_needs_no_auth() {
    let w = W::new();
    let reg = w.env.register(Registry, ());
    let who = Address::from_str(
        &w.env,
        "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM",
    );
    let stranger = Address::generate(&w.env);
    let listed = node(
        "eq",
        alloc::vec![
            node(
                "read",
                alloc::vec![
                    addr(&w.env, &reg),
                    sym("contains"),
                    vec(alloc::vec![node("call_arg", alloc::vec![ScVal::U32(0)])])
                ]
            ),
            node("lit", alloc::vec![ScVal::Bool(true)]),
        ],
    );
    let p = node("and", alloc::vec![vec(alloc::vec![fn_is("pay"), listed])]);
    assert_eq!(w.check(&p, &w.call("pay", &[who.into_val(&w.env)])), 0);
    assert_eq!(
        w.check(&p, &w.call("pay", &[stranger.into_val(&w.env)])),
        E::ArgMismatch as u32
    );
}

/// `check` agrees with a real install + enforce, deny code for deny code.
#[test]
fn agrees_with_install_and_enforce() {
    let w = W::new();
    w.env.mock_all_auths_allowing_non_root_auth();
    let account = Address::generate(&w.env);
    let signers = soroban_sdk::vec![&w.env, Signer::Delegated(account.clone())];
    let five: Val = 5i128.into_val(&w.env);
    let cases: StdVec<ScVal> = alloc::vec![
        arg0(5),
        arg0(6),
        node(
            "in",
            alloc::vec![
                node("call_arg", alloc::vec![ScVal::U32(0)]),
                vec(alloc::vec![i128v(1)])
            ]
        ),
        node(
            "lt",
            alloc::vec![
                node("call_fn", alloc::vec![]),
                node("call_arg", alloc::vec![ScVal::U32(0)])
            ]
        ),
        node(
            "eq",
            alloc::vec![node("call_contract", alloc::vec![]), addr(&w.env, &account)]
        ),
        node(
            "gte",
            alloc::vec![
                node(
                    "scaled",
                    alloc::vec![
                        node("call_arg", alloc::vec![ScVal::U32(0)]),
                        i128v(i128::MAX),
                        i128v(1),
                        i128v(0)
                    ]
                ),
                i128v(0)
            ]
        ),
    ];
    for (i, p) in cases.iter().enumerate() {
        let id = i as u32 + 1;
        let rule = ContextRule {
            id,
            context_type: ContextRuleType::CallContract(w.target.clone()),
            name: soroban_sdk::String::from_str(&w.env, "r"),
            signers: signers.clone(),
            signer_ids: Vec::new(&w.env),
            policies: Vec::new(&w.env),
            policy_ids: Vec::new(&w.env),
            valid_until: None,
        };
        let bytes = xdr_bytes(&w.env, p);
        let params = PolicyInstallParams {
            grammar_version: 7,
            install_nonce: 1,
            predicate_hash: w.env.crypto().sha256(&bytes).into(),
            predicate: bytes,
            policy_admins: signers.clone(),
        };
        w.client.install(&params, &rule, &account);
        let ctx = w.call("pay", &[five]);
        let enforced = match w.client.try_enforce(&ctx, &signers, &rule, &account) {
            Ok(_) => 0,
            Err(Ok(e)) => e.get_code(),
            Err(Err(e)) => panic!("trap {e:?}"),
        };
        assert_eq!(w.check(p, &ctx), enforced, "case {i}");
    }
}
