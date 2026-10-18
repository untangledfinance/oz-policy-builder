//! The codec and `check` corpus: shapes at the edges of the wire format (every value
//! type, map keys the host sorts by type and by value, refusals the decoder owns, the
//! caps), each as the host's own canonical bytes with what `check` says and what a real
//! install + enforce says. The two must agree, and the TypeScript codec must reproduce
//! the bytes and accept or refuse exactly as the contract does
//! (`packages/policy-synth/src/wire.test.ts`).
//!
//!     PARITY_WRITE=1 cargo test --test accuracy   # rewrite fixtures/parity/accuracy.json
extern crate alloc;
mod common;
use alloc::vec::Vec as StdVec;
use common::*;
use policy_interpreter::{
    ContextRule, ContextRuleType, PolicyInstallParams, PolicyInterpreter, PolicyInterpreterClient,
    Signer,
};
use soroban_sdk::auth::{Context, ContractContext};
use soroban_sdk::testutils::Address as _;
use soroban_sdk::xdr::ToXdr;
use soroban_sdk::xdr::{self as x, Limits, ReadXdr, ScAddress, ScVal};
use soroban_sdk::{contract, contractimpl, Address, Env, IntoVal, Map, Symbol, Val, Vec};
use std::fmt::Write as _;

#[contract]
pub struct Oracle;
#[contractimpl]
impl Oracle {
    pub fn f(_e: &Env, a: u32) -> u32 {
        a + 1
    }
    pub fn g(_e: &Env) -> u32 {
        9
    }
}

fn n(i: u32) -> ScVal {
    ScVal::U32(i)
}
fn arg(i: u32) -> ScVal {
    node("call_arg", alloc::vec![n(i)])
}
fn cmp(op: &str, a: ScVal, b: ScVal) -> ScVal {
    node(op, alloc::vec![a, b])
}
fn lit(v: ScVal) -> ScVal {
    node("lit", alloc::vec![v])
}
fn and(k: StdVec<ScVal>) -> ScVal {
    node("and", alloc::vec![vec(k)])
}
fn or(k: StdVec<ScVal>) -> ScVal {
    node("or", alloc::vec![vec(k)])
}
fn fnis() -> ScVal {
    cmp("eq", node("call_fn", alloc::vec![]), sym("pay"))
}
fn sel(p: ScVal) -> ScVal {
    and(alloc::vec![fnis(), p])
}
fn contract_(b: u8) -> ScVal {
    ScVal::Address(ScAddress::Contract(x::ContractId(x::Hash([b; 32]))))
}
fn account(b: u8) -> ScVal {
    ScVal::Address(ScAddress::Account(x::AccountId(
        x::PublicKey::PublicKeyTypeEd25519(x::Uint256([b; 32])),
    )))
}
fn muxed(b: u8, id: u64) -> ScVal {
    ScVal::Address(ScAddress::MuxedAccount(x::MuxedEd25519Account {
        id,
        ed25519: x::Uint256([b; 32]),
    }))
}
fn bytes(b: &[u8]) -> ScVal {
    ScVal::Bytes(x::ScBytes(b.to_vec().try_into().unwrap()))
}
fn text(b: &[u8]) -> ScVal {
    ScVal::String(x::ScString(b.to_vec().try_into().unwrap()))
}
fn u128v(v: u128) -> ScVal {
    ScVal::U128(x::UInt128Parts {
        hi: (v >> 64) as u64,
        lo: v as u64,
    })
}
fn i256max() -> ScVal {
    ScVal::I256(x::Int256Parts {
        hi_hi: i64::MAX,
        hi_lo: u64::MAX,
        lo_hi: u64::MAX,
        lo_lo: u64::MAX,
    })
}
fn i256min() -> ScVal {
    ScVal::I256(x::Int256Parts {
        hi_hi: i64::MIN,
        hi_lo: 0,
        lo_hi: 0,
        lo_lo: 0,
    })
}
fn u256max() -> ScVal {
    ScVal::U256(x::UInt256Parts {
        hi_hi: u64::MAX,
        hi_lo: u64::MAX,
        lo_hi: u64::MAX,
        lo_lo: u64::MAX,
    })
}
fn elem(s: StdVec<ScVal>) -> ScVal {
    node("elem", s)
}
fn scaled(a: ScVal, b: ScVal, d: i128, c: ScVal) -> ScVal {
    node("scaled", alloc::vec![a, b, i128v(d), c])
}

/// A host-sorted map: built through soroban Map (sorted on insert), keys inserted in reverse.
fn hmap(env: &Env, mut kv: StdVec<(ScVal, ScVal)>) -> ScVal {
    kv.reverse();
    let mut m: Map<Val, Val> = Map::new(env);
    for (k, v) in kv {
        let kk: Val = k.into_val(env);
        let vv: Val = v.into_val(env);
        m.set(kk, vv);
    }
    let b = m.to_val().to_xdr(env);
    let mut raw = alloc::vec![0u8; b.len() as usize];
    b.copy_into_slice(&mut raw);
    ScVal::from_xdr(raw, Limits::none()).unwrap()
}

fn cases(env: &Env, oracle: &ScVal) -> StdVec<(String, ScVal)> {
    let a = contract_(1);
    let g = account(2);
    let eqlit = |v: ScVal| sel(cmp("eq", arg(0), lit(v)));
    let mut c: StdVec<(&str, ScVal)> = alloc::vec![
        // ---- every value type, via lit ----
        ("void", eqlit(ScVal::Void)),
        ("bool", eqlit(ScVal::Bool(false))),
        ("u32 max", eqlit(n(u32::MAX))),
        ("i32 min", eqlit(ScVal::I32(i32::MIN))),
        ("i32 max", eqlit(ScVal::I32(i32::MAX))),
        ("u64 max", eqlit(ScVal::U64(u64::MAX))),
        ("i64 min", eqlit(ScVal::I64(i64::MIN))),
        (
            "timepoint max",
            eqlit(ScVal::Timepoint(x::TimePoint(u64::MAX)))
        ),
        ("duration", eqlit(ScVal::Duration(x::Duration(7)))),
        ("u128 max", eqlit(u128v(u128::MAX))),
        ("i128 min", eqlit(i128v(i128::MIN))),
        ("i128 max", eqlit(i128v(i128::MAX))),
        ("u256 max", eqlit(u256max())),
        ("i256 min", eqlit(i256min())),
        ("i256 max", eqlit(i256max())),
        ("bytes empty", eqlit(bytes(&[]))),
        ("bytes 300", eqlit(bytes(&[0xab; 300]))),
        ("string empty", eqlit(text(b""))),
        ("string utf8", eqlit(text("héllo €".as_bytes()))),
        ("string non-utf8", eqlit(text(&[0xff, 0xfe, 0x41]))),
        (
            "symbol 32",
            sel(cmp("eq", arg(0), sym("abcdefghijklmnopqrstuvwxyz012345")))
        ),
        ("symbol empty", sel(cmp("eq", arg(0), sym("")))),
        ("address G", sel(cmp("eq", arg(0), g.clone()))),
        ("address C", sel(cmp("eq", arg(0), a.clone()))),
        ("address M", sel(cmp("ne", arg(0), muxed(3, 42)))),
        ("vec empty lit", eqlit(vec(alloc::vec![]))),
        (
            "vec nested lit",
            eqlit(vec(alloc::vec![
                vec(alloc::vec![sym("x"), n(1)]),
                ScVal::Void
            ]))
        ),
        ("lit inside lit", eqlit(lit(n(1)))),
        // ---- map key ordering (host-sorted) ----
        (
            "map bytes keys of different length",
            eqlit(hmap(
                env,
                alloc::vec![(bytes(&[0xff]), n(1)), (bytes(&[0, 0]), n(2))]
            ))
        ),
        (
            "map vec keys of different length",
            eqlit(hmap(
                env,
                alloc::vec![
                    (vec(alloc::vec![n(5)]), n(1)),
                    (vec(alloc::vec![n(3), n(1)]), n(2))
                ]
            ))
        ),
        (
            "map string keys",
            eqlit(hmap(
                env,
                alloc::vec![
                    (text(b"b"), n(1)),
                    (text(b"ab"), n(2)),
                    (text(b"abc"), n(3))
                ]
            ))
        ),
        (
            "map symbol keys",
            eqlit(hmap(
                env,
                alloc::vec![(sym("zz"), n(1)), (sym("a"), n(2)), (sym("aa"), n(3))]
            ))
        ),
        (
            "map i128 keys",
            eqlit(hmap(
                env,
                alloc::vec![
                    (i128v(1), n(1)),
                    (i128v(-1), n(2)),
                    (i128v(i128::MIN), n(3))
                ]
            ))
        ),
        (
            "map u64 keys",
            eqlit(hmap(
                env,
                alloc::vec![(ScVal::U64(u64::MAX), n(1)), (ScVal::U64(1), n(2))]
            ))
        ),
        (
            "map i32 keys",
            eqlit(hmap(
                env,
                alloc::vec![(ScVal::I32(1), n(1)), (ScVal::I32(-1), n(2))]
            ))
        ),
        (
            "map address keys",
            eqlit(hmap(
                env,
                alloc::vec![(a.clone(), n(1)), (g.clone(), n(2)), (account(1), n(3))]
            ))
        ),
        (
            "map mixed keys",
            eqlit(hmap(
                env,
                alloc::vec![
                    (sym("s"), n(1)),
                    (n(3), n(2)),
                    (ScVal::Bool(true), n(3)),
                    (ScVal::Void, n(4)),
                    (text(b"t"), n(5)),
                    (bytes(&[1]), n(6))
                ]
            ))
        ),
        (
            "map map keys",
            eqlit(hmap(
                env,
                alloc::vec![
                    (hmap(env, alloc::vec![(n(1), n(1)), (n(2), n(2))]), n(1)),
                    (hmap(env, alloc::vec![(n(9), n(9))]), n(2))
                ]
            ))
        ),
        (
            "map bool keys",
            eqlit(hmap(
                env,
                alloc::vec![(ScVal::Bool(true), n(1)), (ScVal::Bool(false), n(2))]
            ))
        ),
        // ---- every operator and selector ----
        (
            "or order kept",
            or(alloc::vec![cmp("eq", arg(0), i128v(9)), fnis()])
        ),
        ("ne", sel(cmp("ne", arg(1), n(8)))),
        ("lt", sel(cmp("lt", arg(0), i128v(6)))),
        ("lte", sel(cmp("lte", arg(0), i128v(5)))),
        ("gt", sel(cmp("gt", arg(0), i128v(4)))),
        ("gte", sel(cmp("gte", arg(0), i128v(5)))),
        (
            "in",
            sel(node(
                "in",
                alloc::vec![arg(1), vec(alloc::vec![n(7), lit(n(9))])]
            ))
        ),
        (
            "nin",
            sel(node(
                "nin",
                alloc::vec![arg(3), vec(alloc::vec![g.clone()])]
            ))
        ),
        (
            "in miss",
            sel(node("in", alloc::vec![arg(1), vec(alloc::vec![n(1)])]))
        ),
        (
            "call_contract miss",
            cmp("eq", node("call_contract", alloc::vec![]), a.clone())
        ),
        (
            "ordering over call_fn",
            cmp("lt", node("call_fn", alloc::vec![]), n(1))
        ),
        (
            "now",
            sel(cmp("gte", node("now", alloc::vec![]), ScVal::U64(0)))
        ),
        (
            "call_arg_len",
            sel(cmp("eq", node("call_arg_len", alloc::vec![n(2)]), n(2)))
        ),
        (
            "call_arg_field",
            sel(cmp(
                "eq",
                node("call_arg_field", alloc::vec![n(2), n(0), sym("amount")]),
                i128v(4)
            ))
        ),
        (
            "call_arg_field len step",
            sel(cmp(
                "eq",
                node("call_arg_field", alloc::vec![n(2), n(0), ScVal::Bool(true)]),
                n(2)
            ))
        ),
        (
            "call_path lit key",
            sel(cmp(
                "eq",
                node("call_path", alloc::vec![n(2), n(1), lit(sym("amount"))]),
                i128v(6)
            ))
        ),
        (
            "call_path len",
            sel(cmp(
                "eq",
                node("call_path", alloc::vec![n(2), ScVal::Bool(true)]),
                n(2)
            ))
        ),
        (
            "all",
            node(
                "all",
                alloc::vec![
                    arg(2),
                    cmp("lte", elem(alloc::vec![sym("amount")]), i128v(6))
                ]
            )
        ),
        (
            "all miss",
            node(
                "all",
                alloc::vec![
                    arg(2),
                    cmp("lte", elem(alloc::vec![sym("amount")]), i128v(5))
                ]
            )
        ),
        (
            "any",
            node(
                "any",
                alloc::vec![arg(2), cmp("eq", elem(alloc::vec![sym("to")]), g.clone())]
            )
        ),
        (
            "sum",
            sel(cmp(
                "lte",
                node("sum", alloc::vec![arg(2), sym("amount")]),
                i128v(10)
            ))
        ),
        (
            "sum miss",
            sel(cmp(
                "lte",
                node("sum", alloc::vec![arg(2), sym("amount")]),
                i128v(9)
            ))
        ),
        (
            "scaled",
            sel(cmp("gte", arg(0), scaled(arg(1), i128v(1), 2, i128v(1))))
        ),
        (
            "scaled nested",
            sel(cmp(
                "gte",
                arg(0),
                scaled(scaled(arg(1), i128v(2), 3, i128v(0)), i128v(1), 1, i128v(0))
            ))
        ),
        (
            "read const",
            sel(cmp(
                "eq",
                node(
                    "read",
                    alloc::vec![oracle.clone(), sym("g"), vec(alloc::vec![])]
                ),
                n(9)
            ))
        ),
        (
            "read call arg",
            sel(cmp(
                "eq",
                node(
                    "read",
                    alloc::vec![oracle.clone(), sym("f"), vec(alloc::vec![arg(1)])]
                ),
                n(8)
            ))
        ),
        (
            "read missing contract",
            sel(cmp(
                "eq",
                node("read", alloc::vec![a.clone(), sym("g"), vec(alloc::vec![])]),
                n(9)
            ))
        ),
        // ---- probes where TS validate may diverge ----
        (
            "call_arg index i128",
            sel(cmp("eq", node("call_arg", alloc::vec![i128v(0)]), i128v(5)))
        ),
        (
            "call_arg index symbol",
            sel(cmp("eq", node("call_arg", alloc::vec![sym("a")]), i128v(5)))
        ),
        (
            "call_arg_len index i128",
            sel(cmp("eq", node("call_arg_len", alloc::vec![i128v(2)]), n(2)))
        ),
        (
            "call_arg_field index symbol",
            sel(cmp(
                "eq",
                node("call_arg_field", alloc::vec![sym("x"), n(0), sym("amount")]),
                i128v(4)
            ))
        ),
        (
            "call_arg_field second index symbol",
            sel(cmp(
                "eq",
                node("call_arg_field", alloc::vec![n(2), sym("x"), sym("amount")]),
                i128v(4)
            ))
        ),
        (
            "scaled over call_contract",
            sel(cmp(
                "gte",
                arg(0),
                scaled(node("call_contract", alloc::vec![]), i128v(1), 1, i128v(0))
            ))
        ),
        (
            "scaled addend call_fn",
            sel(cmp(
                "gte",
                arg(0),
                scaled(arg(1), i128v(1), 1, node("call_fn", alloc::vec![]))
            ))
        ),
        (
            "ordering over u128 above i128 max",
            sel(cmp("lt", arg(0), u128v(1u128 << 127)))
        ),
        (
            "ordering over u128 at i128 max",
            sel(cmp("lt", arg(0), u128v((1u128 << 127) - 1)))
        ),
        (
            "scaled src u128 above i128 max",
            sel(cmp(
                "gte",
                arg(0),
                scaled(u128v(1u128 << 127), i128v(1), 1, arg(1))
            ))
        ),
        (
            "scaled constant product overflows",
            sel(cmp(
                "gte",
                arg(0),
                scaled(i128v(i128::MAX), i128v(2), 1, arg(1))
            ))
        ),
        (
            "scaled nested constant src non-positive",
            sel(cmp(
                "gte",
                arg(0),
                scaled(
                    scaled(i128v(1), i128v(1), 1, i128v(-5)),
                    i128v(1),
                    1,
                    arg(1)
                )
            ))
        ),
        (
            "path key bare map",
            sel(cmp(
                "eq",
                node(
                    "call_path",
                    alloc::vec![n(2), hmap(env, alloc::vec![(sym("a"), n(1))])]
                ),
                n(1)
            ))
        ),
        (
            "path key vec of empty vec",
            sel(cmp(
                "eq",
                node(
                    "call_path",
                    alloc::vec![n(2), vec(alloc::vec![vec(alloc::vec![])])]
                ),
                n(1)
            ))
        ),
        (
            "path key bare vec",
            sel(cmp(
                "eq",
                node("call_path", alloc::vec![n(2), vec(alloc::vec![n(1), n(2)])]),
                n(1)
            ))
        ),
        (
            "six sums in three compares (198)",
            and(alloc::vec![
                cmp(
                    "lte",
                    node("sum", alloc::vec![arg(2), sym("amount")]),
                    node("sum", alloc::vec![arg(2), sym("amount")])
                ),
                cmp(
                    "lte",
                    node("sum", alloc::vec![arg(2), sym("amount")]),
                    node("sum", alloc::vec![arg(2), sym("amount")])
                ),
                cmp(
                    "gte",
                    node("sum", alloc::vec![arg(2), sym("amount")]),
                    node("sum", alloc::vec![arg(2), sym("amount")])
                )
            ])
        ),
        (
            "read args 5 and lit(5) are one call",
            and(core::iter::once(fnis())
                .chain((1..=4u32).map(|i| cmp(
                    "gte",
                    node(
                        "read",
                        alloc::vec![oracle.clone(), sym("f"), vec(alloc::vec![n(i)])]
                    ),
                    n(0)
                )))
                .chain(core::iter::once(cmp(
                    "gte",
                    node(
                        "read",
                        alloc::vec![oracle.clone(), sym("f"), vec(alloc::vec![lit(n(1))])]
                    ),
                    n(0)
                )))
                .collect())
        ),
        (
            "read fn is an address",
            sel(cmp(
                "gte",
                node(
                    "read",
                    alloc::vec![oracle.clone(), g.clone(), vec(alloc::vec![])]
                ),
                n(0)
            ))
        ),
        (
            "read fn is an empty symbol",
            sel(cmp(
                "gte",
                node(
                    "read",
                    alloc::vec![oracle.clone(), sym(""), vec(alloc::vec![])]
                ),
                n(0)
            ))
        ),
        (
            "in haystack not a vec",
            sel(node("in", alloc::vec![arg(1), n(7)]))
        ),
        (
            "in haystack lit map entry",
            sel(node(
                "in",
                alloc::vec![
                    arg(1),
                    vec(alloc::vec![lit(hmap(env, alloc::vec![(sym("a"), n(1))]))])
                ]
            ))
        ),
        (
            "nin 33 entries",
            sel(node(
                "nin",
                alloc::vec![arg(1), vec((0..33).map(n).collect())]
            ))
        ),
        (
            "in 32 entries",
            sel(node(
                "in",
                alloc::vec![arg(1), vec((0..32).map(n).collect())]
            ))
        ),
        (
            "node depth 5",
            and(alloc::vec![and(alloc::vec![and(alloc::vec![and(
                alloc::vec![fnis()]
            )])])])
        ),
        (
            "node depth 6",
            and(alloc::vec![and(alloc::vec![and(alloc::vec![and(
                alloc::vec![and(alloc::vec![fnis()])]
            )])])])
        ),
        (
            "read target muxed",
            sel(cmp(
                "gte",
                node(
                    "read",
                    alloc::vec![muxed(1, 1), sym("g"), vec(alloc::vec![])]
                ),
                n(0)
            ))
        ),
        (
            "read target account",
            sel(cmp(
                "gte",
                node("read", alloc::vec![g.clone(), sym("g"), vec(alloc::vec![])]),
                n(0)
            ))
        ),
        (
            "call_path step false key",
            sel(cmp(
                "eq",
                node("call_path", alloc::vec![n(2), ScVal::Bool(false)]),
                n(1)
            ))
        ),
        (
            "call_path step void key",
            sel(cmp(
                "eq",
                node("call_path", alloc::vec![n(2), ScVal::Void]),
                n(1)
            ))
        ),
        (
            "elem in read arg in body",
            node(
                "all",
                alloc::vec![
                    arg(2),
                    cmp(
                        "eq",
                        node(
                            "read",
                            alloc::vec![
                                oracle.clone(),
                                sym("f"),
                                vec(alloc::vec![elem(alloc::vec![])])
                            ]
                        ),
                        n(1)
                    )
                ]
            )
        ),
        (
            "sum over sum source",
            sel(cmp(
                "lte",
                node("sum", alloc::vec![node("sum", alloc::vec![arg(2)])]),
                n(1)
            ))
        ),
        (
            "quantifier over lit, body reads call",
            node(
                "all",
                alloc::vec![
                    lit(vec(alloc::vec![n(1)])),
                    cmp("eq", elem(alloc::vec![]), arg(1))
                ]
            )
        ),
        (
            "lit with a selector inside",
            sel(cmp("eq", arg(0), lit(arg(1))))
        ),
        (
            "bare vec head address",
            sel(cmp("eq", arg(0), vec(alloc::vec![g.clone(), n(1)])))
        ),
        (
            "scaled den 0",
            sel(cmp("gte", arg(0), scaled(arg(1), i128v(1), 0, i128v(0))))
        ),
        (
            "scaled den above cap",
            sel(cmp(
                "gte",
                arg(0),
                scaled(arg(1), i128v(1), 1_000_000_000_000_000_001, i128v(0))
            ))
        ),
        (
            "scaled lit factor negative",
            sel(cmp(
                "gte",
                arg(0),
                scaled(arg(1), lit(i128v(-2)), 1, i128v(0))
            ))
        ),
        ("eq u32 vs i128 top-level", sel(cmp("eq", arg(1), i128v(7)))),
    ];
    // sum weight edge: Rust 32+1 per sum leaf. One sum compare (34) + 83 compares of 2 = 200.
    let mut k = alloc::vec![cmp(
        "lte",
        node("sum", alloc::vec![arg(2), sym("amount")]),
        i128v(100)
    )];
    for i in 0..83u32 {
        k.push(cmp("gte", arg(0), i128v(i as i128 - 100)));
    }
    c.push(("sum + 83 compares = 200", and(k.clone())));
    k.push(cmp("gte", arg(0), i128v(-1)));
    c.push(("sum + 84 compares = 202", and(k)));
    c.into_iter().map(|(a, b)| (String::from(a), b)).collect()
}

const FILE: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../../packages/policy-synth/fixtures/parity/accuracy.json"
);

fn render() -> (String, usize) {
    let env = Env::default();
    env.mock_all_auths_allowing_non_root_auth();
    let id = env.register(PolicyInterpreter, (common::DEFAULT,));
    let client = PolicyInterpreterClient::new(&env, &id);
    let oracle_addr = env.register(Oracle, ());
    let oracle = addr(&env, &oracle_addr);
    let target = Address::generate(&env);
    let account_a = Address::generate(&env);
    let gv: Val = account(2).into_val(&env);
    let amap = |amt: i128, to: Val| {
        let mut m: Map<Symbol, Val> = Map::new(&env);
        m.set(Symbol::new(&env, "amount"), amt.into_val(&env));
        m.set(Symbol::new(&env, "to"), to);
        m.to_val()
    };
    let reqs: Vec<Val> = Vec::from_slice(
        &env,
        &[amap(4, gv), amap(6, account_a.clone().into_val(&env))],
    );
    let args: Vec<Val> = Vec::from_slice(
        &env,
        &[
            5i128.into_val(&env),
            7u32.into_val(&env),
            reqs.to_val(),
            account_a.clone().into_val(&env),
        ],
    );
    let ctx = Context::Contract(ContractContext {
        contract: target.clone(),
        fn_name: Symbol::new(&env, "pay"),
        args,
    });
    let signers = soroban_sdk::vec![&env, Signer::Delegated(account_a.clone())];
    let mut out = String::from("{\"cases\":[\n");
    let all = cases(&env, &oracle);
    let mut disagree = 0;
    for (i, (name, v)) in all.iter().enumerate() {
        let b = xdr_bytes(&env, v);
        let mut raw = alloc::vec![0u8; b.len() as usize];
        b.copy_into_slice(&mut raw);
        let check = i64::from(verdict(&client, &b, &ctx));
        let rule = ContextRule {
            id: i as u32 + 1,
            context_type: ContextRuleType::CallContract(target.clone()),
            name: soroban_sdk::String::from_str(&env, "r"),
            signers: signers.clone(),
            signer_ids: Vec::new(&env),
            policies: Vec::new(&env),
            policy_ids: Vec::new(&env),
            valid_until: None,
        };
        let params = PolicyInstallParams {
            grammar_version: 7,
            install_nonce: 1,
            predicate_hash: env.crypto().sha256(&b).into(),
            predicate: b.clone(),
            policy_admins: signers.clone(),
        };
        let real: i64 = match client.try_install(&params, &rule, &account_a) {
            Err(Ok(e)) => i64::from(e.get_code()),
            Err(Err(_)) => -2,
            Ok(_) => match client.try_enforce(&ctx, &signers, &rule, &account_a) {
                Ok(_) => 0,
                Err(Ok(e)) => i64::from(e.get_code()),
                Err(Err(_)) => -3,
            },
        };
        if real != check {
            disagree += 1;
        }
        let sep = if i + 1 == all.len() { "" } else { "," };
        writeln!(
            out,
            "{{\"name\":\"{name}\",\"xdr\":\"{}\",\"check\":{check},\"installEnforce\":{real}}}{sep}",
            base64(&raw)
        )
        .unwrap();
    }
    out.push_str("]}\n");
    (out, disagree)
}

/// `check` says what a real install followed by an enforce says, case by case, and the
/// checked-in corpus is the one these cases produce.
#[test]
fn check_agrees_with_install_and_enforce_and_the_corpus_is_current() {
    let (fresh, disagree) = render();
    assert_eq!(disagree, 0, "check and install + enforce disagree");
    if std::env::var("PARITY_WRITE").is_ok() {
        std::fs::create_dir_all(std::path::Path::new(FILE).parent().unwrap()).unwrap();
        std::fs::write(FILE, &fresh).unwrap();
    }
    let stored = std::fs::read_to_string(FILE).expect("fixture missing: run with PARITY_WRITE=1");
    assert_eq!(
        stored, fresh,
        "stale accuracy corpus: run with PARITY_WRITE=1"
    );
}

fn base64(b: &[u8]) -> String {
    const T: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut s = String::new();
    for ch in b.chunks(3) {
        let v = [ch[0], *ch.get(1).unwrap_or(&0), *ch.get(2).unwrap_or(&0)];
        let n = (u32::from(v[0]) << 16) | (u32::from(v[1]) << 8) | u32::from(v[2]);
        for j in 0..4 {
            if j <= ch.len() {
                s.push(T[((n >> (18 - 6 * j)) & 63) as usize] as char)
            } else {
                s.push('=')
            }
        }
    }
    s
}
