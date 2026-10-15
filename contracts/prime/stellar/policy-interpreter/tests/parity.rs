//! Wire-format parity corpus for the off-chain codec (`@crediolabs/policy-synth`).
//!
//! Each case is one predicate written out three ways: the compact JSON the
//! TypeScript side speaks (`json`), the canonical XDR the contract stores
//! (`xdr`, base64), and what this contract's `check` says about it (`code`: 0
//! permit, 1xx deny, 2xx a decode or install refusal). The JSON is produced HERE,
//! from the ScVal, so the TypeScript codec is held to the contract's own bytes and
//! not to its own idea of them. The checked-in file is the contract between the
//! two sides: this test fails when it is stale, and the TypeScript tests fail when
//! the codec disagrees with it.
//!
//! Regenerate: `PARITY_WRITE=1 cargo test --test parity`.

extern crate alloc;
mod common;

use alloc::string::String;
use alloc::vec::Vec as StdVec;
use common::*;
use policy_interpreter::{PolicyInterpreter, PolicyInterpreterClient};
use soroban_sdk::auth::{Context, ContractContext};
use soroban_sdk::testutils::Address as _;
use soroban_sdk::xdr::{
    ContractId, Hash, Limits, ScAddress, ScBytes, ScMap, ScMapEntry, ScString, ScVal, WriteXdr,
};
use soroban_sdk::{Env, IntoVal, Symbol, Val, Vec};
use std::fmt::Write as _;

const FILE: &str = "../../../../packages/policy-synth/fixtures/parity/grammar7.json";

/// The compact JSON form of a value: a symbol or an address is a string, a `u32`
/// a number, a bool a bool, a vec an array, and every other type a one-key
/// object (`{"i128":"5"}`, `{"bytes":"ab"}`, `{"map":[[k,v]]}`).
fn js(v: &ScVal) -> String {
    let one = |t: &str, s: String| alloc::format!("{{\"{t}\":\"{s}\"}}");
    match v {
        ScVal::Symbol(s) => alloc::format!("\"{}\"", s.to_utf8_string_lossy()),
        ScVal::Address(a) => alloc::format!("\"{a}\""),
        ScVal::U32(n) => n.to_string(),
        ScVal::I32(n) => alloc::format!("{{\"i32\":{n}}}"),
        ScVal::Bool(b) => b.to_string(),
        ScVal::Void => "null".into(),
        ScVal::U64(n) => one("u64", n.to_string()),
        ScVal::I64(n) => one("i64", n.to_string()),
        ScVal::Timepoint(t) => one("timepoint", t.0.to_string()),
        ScVal::Duration(d) => one("duration", d.0.to_string()),
        ScVal::U128(p) => one(
            "u128",
            ((u128::from(p.hi) << 64) | u128::from(p.lo)).to_string(),
        ),
        ScVal::I128(p) => one(
            "i128",
            ((i128::from(p.hi) << 64) | i128::from(p.lo)).to_string(),
        ),
        ScVal::Bytes(b) => one(
            "bytes",
            b.0.iter().map(|x| alloc::format!("{x:02x}")).collect(),
        ),
        ScVal::String(s) => one("string", s.to_utf8_string_lossy()),
        ScVal::Vec(Some(items)) => {
            let parts: StdVec<String> = items.0.iter().map(js).collect();
            alloc::format!("[{}]", parts.join(","))
        }
        ScVal::Map(Some(m)) => {
            let parts: StdVec<String> =
                m.0.iter()
                    .map(|e| alloc::format!("[{},{}]", js(&e.key), js(&e.val)))
                    .collect();
            alloc::format!("{{\"map\":[{}]}}", parts.join(","))
        }
        other => panic!("no JSON form for {other:?}"),
    }
}

fn contract(n: u8) -> ScVal {
    ScVal::Address(ScAddress::Contract(ContractId(Hash([n; 32]))))
}

fn account(n: u8) -> ScVal {
    ScVal::Address(ScAddress::Account(soroban_sdk::xdr::AccountId(
        soroban_sdk::xdr::PublicKey::PublicKeyTypeEd25519(soroban_sdk::xdr::Uint256([n; 32])),
    )))
}

fn n(i: u32) -> ScVal {
    ScVal::U32(i)
}

fn cp(steps: StdVec<ScVal>) -> ScVal {
    node("call_path", steps)
}

fn arg(i: u32) -> ScVal {
    node("call_arg", alloc::vec![n(i)])
}

fn cmp(op: &str, a: ScVal, b: ScVal) -> ScVal {
    node(op, alloc::vec![a, b])
}

fn lit(x: ScVal) -> ScVal {
    node("lit", alloc::vec![x])
}

fn and(kids: StdVec<ScVal>) -> ScVal {
    node("and", alloc::vec![vec(kids)])
}

fn fnis() -> ScVal {
    cmp("eq", node("call_fn", alloc::vec![]), sym("pay"))
}

fn bytes(b: &[u8]) -> ScVal {
    ScVal::Bytes(ScBytes(b.to_vec().try_into().unwrap()))
}

fn text(s: &str) -> ScVal {
    ScVal::String(ScString(s.as_bytes().to_vec().try_into().unwrap()))
}

fn map(entries: StdVec<(ScVal, ScVal)>) -> ScVal {
    let m: StdVec<ScMapEntry> = entries
        .into_iter()
        .map(|(key, val)| ScMapEntry { key, val })
        .collect();
    ScVal::Map(Some(ScMap(m.try_into().unwrap())))
}

fn corpus() -> StdVec<(&'static str, ScVal)> {
    let (a, g) = (contract(1), account(2));
    let any_arg = || arg(0);
    let sel = |p: ScVal| and(alloc::vec![fnis(), p]);
    let reads = |k: u8| {
        node(
            "read",
            alloc::vec![contract(10 + k), sym("f"), vec(alloc::vec![]), n(0)],
        )
    };
    alloc::vec![
        ("eq fn", fnis()),
        (
            "ne contract",
            cmp("ne", node("call_contract", alloc::vec![]), a.clone())
        ),
        ("lt i128", sel(cmp("lt", any_arg(), i128v(-5)))),
        ("lte", sel(cmp("lte", any_arg(), i128v(5)))),
        ("gt", sel(cmp("gt", any_arg(), i128v(0)))),
        ("gte u32 const", sel(cmp("gte", any_arg(), n(7)))),
        (
            "in addresses",
            sel(node(
                "in",
                alloc::vec![arg(1), vec(alloc::vec![a.clone(), g.clone()])]
            ))
        ),
        (
            "nin symbols",
            sel(node(
                "nin",
                alloc::vec![arg(1), vec(alloc::vec![sym("a"), sym("b")])]
            ))
        ),
        (
            "or",
            or(alloc::vec![
                fnis(),
                cmp("eq", node("call_fn", alloc::vec![]), sym("other"))
            ])
        ),
        (
            "and order is kept",
            and(alloc::vec![
                cmp("eq", arg(1), n(2)),
                fnis(),
                cmp("eq", arg(0), n(1))
            ])
        ),
        (
            "or order is kept",
            or(alloc::vec![
                cmp("eq", arg(1), n(2)),
                fnis(),
                cmp("eq", arg(0), n(1))
            ])
        ),
        (
            "call_arg_len",
            sel(cmp("eq", node("call_arg_len", alloc::vec![n(2)]), n(3)))
        ),
        (
            "call_arg_field",
            sel(cmp(
                "lte",
                node("call_arg_field", alloc::vec![n(3), n(0), sym("amount")]),
                i128v(9)
            ))
        ),
        (
            "call_path symbol key and len",
            sel(cmp(
                "lte",
                cp(alloc::vec![n(3), sym("k"), ScVal::Bool(true)]),
                n(4)
            ))
        ),
        (
            "call_path lit key",
            sel(cmp("eq", cp(alloc::vec![n(0), lit(i128v(7))]), n(1)))
        ),
        (
            "call_path 8 steps",
            sel(cmp("eq", cp((0..8).map(n).collect()), n(1)))
        ),
        (
            "now bound",
            sel(cmp(
                "lte",
                node("now", alloc::vec![]),
                ScVal::U64(1_900_000_000)
            ))
        ),
        (
            "scaled",
            sel(cmp(
                "gte",
                arg(1),
                node(
                    "scaled",
                    alloc::vec![arg(0), i128v(99), i128v(100), i128v(0)]
                )
            ))
        ),
        (
            "scaled nested",
            sel(cmp(
                "gte",
                arg(1),
                node(
                    "scaled",
                    alloc::vec![
                        node("scaled", alloc::vec![arg(0), i128v(2), i128v(1), i128v(0)]),
                        i128v(3),
                        i128v(1),
                        i128v(-4)
                    ]
                )
            ))
        ),
        ("lit string", sel(cmp("eq", arg(0), lit(text("memo-1"))))),
        (
            "lit bytes",
            sel(cmp("eq", arg(0), lit(bytes(&[0xde, 0xad]))))
        ),
        ("lit bool", sel(cmp("eq", arg(0), lit(ScVal::Bool(true))))),
        ("lit u64", sel(cmp("eq", arg(0), lit(ScVal::U64(1 << 40))))),
        ("lit i64", sel(cmp("eq", arg(0), lit(ScVal::I64(-9))))),
        ("lit i32", sel(cmp("eq", arg(0), lit(ScVal::I32(-3))))),
        (
            "lit u128",
            sel(cmp(
                "eq",
                arg(0),
                lit(ScVal::U128(soroban_sdk::xdr::UInt128Parts { hi: 1, lo: 2 }))
            ))
        ),
        (
            "lit timepoint",
            sel(cmp(
                "lte",
                arg(0),
                lit(ScVal::Timepoint(soroban_sdk::xdr::TimePoint(1_800_000_000)))
            ))
        ),
        (
            "lit duration",
            sel(cmp(
                "lte",
                arg(0),
                lit(ScVal::Duration(soroban_sdk::xdr::Duration(3600)))
            ))
        ),
        (
            "lit map",
            sel(cmp(
                "eq",
                arg(0),
                lit(map(alloc::vec![(sym("amount"), i128v(5))]))
            ))
        ),
        (
            "lit map keys of three types",
            sel(cmp(
                "eq",
                arg(0),
                lit(map(alloc::vec![
                    (sym("a"), n(1)),
                    (sym("b"), n(2)),
                    (g.clone(), n(3))
                ]))
            ))
        ),
        (
            "lit map signed number keys",
            sel(cmp(
                "eq",
                arg(0),
                lit(map(alloc::vec![
                    (ScVal::I64(-2), n(1)),
                    (ScVal::I64(10), n(2))
                ]))
            ))
        ),
        (
            "lit map text keys",
            sel(cmp(
                "eq",
                arg(0),
                lit(map(alloc::vec![(text("ab"), n(1)), (text("b"), n(2))]))
            ))
        ),
        (
            "lit enum vec",
            sel(cmp(
                "eq",
                arg(0),
                lit(vec(alloc::vec![sym("Stellar"), a.clone()]))
            ))
        ),
        ("lit void", sel(cmp("ne", arg(0), lit(ScVal::Void)))),
        (
            "bare address symbol number",
            sel(node(
                "in",
                alloc::vec![
                    arg(0),
                    vec(alloc::vec![g.clone(), sym("x"), n(3), i128v(4)])
                ]
            ))
        ),
        (
            "bare vec of plain values",
            sel(cmp(
                "eq",
                arg(0),
                vec(alloc::vec![n(1), vec(alloc::vec![n(2)])])
            ))
        ),
        (
            "in with lit entries",
            sel(node(
                "in",
                alloc::vec![arg(0), vec(alloc::vec![lit(text("a")), lit(bytes(&[1]))])]
            ))
        ),
        (
            "read",
            sel(cmp(
                "gte",
                node(
                    "read",
                    alloc::vec![
                        a.clone(),
                        sym("price"),
                        vec(alloc::vec![lit(vec(alloc::vec![
                            sym("Stellar"),
                            g.clone()
                        ]))]),
                        sym("price")
                    ]
                ),
                i128v(1)
            ))
        ),
        (
            "read call-derived args",
            sel(cmp(
                "eq",
                node(
                    "read",
                    alloc::vec![
                        a.clone(),
                        sym("contains"),
                        vec(alloc::vec![
                            arg(1),
                            node("call_contract", alloc::vec![]),
                            node("now", alloc::vec![])
                        ])
                    ]
                ),
                lit(ScVal::Bool(true))
            ))
        ),
        (
            "read no path",
            sel(cmp(
                "ne",
                node(
                    "read",
                    alloc::vec![a.clone(), sym("get"), vec(alloc::vec![])]
                ),
                n(0)
            ))
        ),
        (
            "all",
            cmp(
                "all",
                cp(alloc::vec![n(0)]),
                and(alloc::vec![
                    node(
                        "in",
                        alloc::vec![
                            node("elem", alloc::vec![sym("to")]),
                            vec(alloc::vec![a.clone(), g.clone()])
                        ]
                    ),
                    cmp("gte", node("elem", alloc::vec![sym("amount")]), i128v(0))
                ])
            )
        ),
        (
            "any",
            cmp(
                "any",
                cp(alloc::vec![n(0)]),
                cmp("eq", node("elem", alloc::vec![]), sym("repay"))
            )
        ),
        (
            "all and sum",
            and(alloc::vec![
                cmp(
                    "all",
                    cp(alloc::vec![n(0)]),
                    cmp("gte", node("elem", alloc::vec![sym("amount")]), i128v(0))
                ),
                cmp(
                    "lte",
                    node("sum", alloc::vec![cp(alloc::vec![n(0)]), sym("amount")]),
                    i128v(1000)
                ),
            ])
        ),
        (
            "sum of elements",
            sel(cmp("lte", node("sum", alloc::vec![arg(0)]), i128v(5)))
        ),
        (
            "33 entries refused",
            sel(node(
                "in",
                alloc::vec![arg(0), vec((0..33).map(n).collect())]
            ))
        ),
        (
            "32 entries",
            sel(node(
                "in",
                alloc::vec![arg(0), vec((0..32).map(n).collect())]
            ))
        ),
        // ---- refusals ----
        ("unknown op", node("bogus", alloc::vec![])),
        ("empty and", node("and", alloc::vec![vec(alloc::vec![])])),
        (
            "empty in",
            sel(node("in", alloc::vec![arg(0), vec(alloc::vec![])]))
        ),
        ("eq arity", node("eq", alloc::vec![arg(0)])),
        (
            "call_arg arity",
            sel(cmp("eq", node("call_arg", alloc::vec![n(0), n(1)]), n(1)))
        ),
        (
            "selector in haystack",
            sel(node("in", alloc::vec![arg(0), vec(alloc::vec![arg(1)])]))
        ),
        ("ordering over symbol", sel(cmp("lt", arg(0), sym("x")))),
        ("ordering over address", sel(cmp("lte", arg(0), a.clone()))),
        (
            "scaled den zero",
            sel(cmp(
                "gte",
                arg(1),
                node("scaled", alloc::vec![arg(0), i128v(1), i128v(0), i128v(0)])
            ))
        ),
        (
            "scaled den too big",
            sel(cmp(
                "gte",
                arg(1),
                node(
                    "scaled",
                    alloc::vec![arg(0), i128v(1), i128v(1_000_000_000_000_000_001), i128v(0)]
                )
            ))
        ),
        (
            "scaled den u32",
            sel(cmp(
                "gte",
                arg(1),
                node("scaled", alloc::vec![arg(0), i128v(1), n(2), i128v(0)])
            ))
        ),
        (
            "scaled literal factor negative",
            sel(cmp(
                "gte",
                arg(1),
                node(
                    "scaled",
                    alloc::vec![arg(0), i128v(-99), i128v(100), i128v(0)]
                )
            ))
        ),
        (
            "read from a G account",
            sel(cmp(
                "gte",
                node("read", alloc::vec![g.clone(), sym("f"), vec(alloc::vec![])]),
                n(0)
            ))
        ),
        (
            "elem outside a body",
            sel(cmp("eq", node("elem", alloc::vec![]), n(1)))
        ),
        (
            "nested quantifier",
            cmp(
                "all",
                cp(alloc::vec![n(0)]),
                cmp(
                    "any",
                    node("elem", alloc::vec![]),
                    cmp("eq", node("elem", alloc::vec![]), n(1))
                )
            )
        ),
        (
            "sum inside a body",
            cmp(
                "all",
                cp(alloc::vec![n(0)]),
                cmp(
                    "lte",
                    node("sum", alloc::vec![node("elem", alloc::vec![])]),
                    n(1)
                )
            )
        ),
        (
            "elem as read argument",
            cmp(
                "all",
                cp(alloc::vec![n(0)]),
                cmp(
                    "eq",
                    node(
                        "read",
                        alloc::vec![
                            a.clone(),
                            sym("f"),
                            vec(alloc::vec![node("elem", alloc::vec![])])
                        ]
                    ),
                    n(1)
                )
            )
        ),
        (
            "body of eight leaves",
            cmp(
                "all",
                cp(alloc::vec![n(0)]),
                and(alloc::vec![
                    cmp("eq", node("elem", alloc::vec![n(0)]), n(1)),
                    cmp("eq", node("elem", alloc::vec![n(1)]), n(1)),
                    cmp("eq", node("elem", alloc::vec![n(2)]), n(1)),
                    cmp("eq", node("elem", alloc::vec![n(3)]), n(1))
                ])
            )
        ),
        (
            "body of six leaves",
            cmp(
                "all",
                cp(alloc::vec![n(0)]),
                and(alloc::vec![
                    cmp("eq", node("elem", alloc::vec![n(0)]), n(1)),
                    cmp("eq", node("elem", alloc::vec![n(1)]), n(1)),
                    cmp("eq", node("elem", alloc::vec![n(2)]), n(1))
                ])
            )
        ),
        (
            "too many sums",
            and(alloc::vec![
                fnis(),
                cmp("lte", node("sum", alloc::vec![arg(0)]), n(1)),
                cmp("lte", node("sum", alloc::vec![arg(1)]), n(1)),
                cmp("lte", node("sum", alloc::vec![arg(2)]), n(1)),
                cmp("lte", node("sum", alloc::vec![arg(3)]), n(1)),
                cmp("lte", node("sum", alloc::vec![arg(4)]), n(1)),
                cmp("lte", node("sum", alloc::vec![arg(5)]), n(1)),
                cmp("lte", node("sum", alloc::vec![arg(6)]), n(1))
            ])
        ),
        (
            "five distinct reads",
            and(alloc::vec![
                fnis(),
                cmp("gte", reads(0), n(0)),
                cmp("gte", reads(1), n(0)),
                cmp("gte", reads(2), n(0)),
                cmp("gte", reads(3), n(0)),
                cmp("gte", reads(4), n(0))
            ])
        ),
        (
            "four distinct reads",
            and(alloc::vec![
                fnis(),
                cmp("gte", reads(0), n(0)),
                cmp("gte", reads(1), n(0)),
                cmp("gte", reads(2), n(0)),
                cmp("gte", reads(3), n(0))
            ])
        ),
        (
            "bare map",
            sel(cmp("eq", arg(0), map(alloc::vec![(sym("a"), n(1))])))
        ),
        (
            "bare vec holding a selector",
            sel(cmp("eq", arg(0), vec(alloc::vec![n(1), arg(1)])))
        ),
        ("bare empty vec", sel(cmp("eq", arg(0), vec(alloc::vec![])))),
        (
            "call_path 9 steps",
            sel(cmp("eq", cp((0..9).map(n).collect()), n(1)))
        ),
        (
            "length step not last",
            sel(cmp(
                "eq",
                cp(alloc::vec![n(0), ScVal::Bool(true), n(1)]),
                n(1)
            ))
        ),
        (
            "call_path no steps",
            sel(cmp("eq", cp(alloc::vec![]), n(1)))
        ),
        (
            "no selector leaf",
            cmp("lt", node("now", alloc::vec![]), ScVal::U64(5))
        ),
        ("a lone number", n(5)),
        (
            "tree six deep",
            and(alloc::vec![and(alloc::vec![and(alloc::vec![and(
                alloc::vec![and(alloc::vec![fnis()])]
            )])])])
        ),
        (
            "tree five deep",
            and(alloc::vec![and(alloc::vec![and(alloc::vec![and(
                alloc::vec![fnis()]
            )])])])
        ),
    ]
}

fn or(kids: StdVec<ScVal>) -> ScVal {
    node("or", alloc::vec![vec(kids)])
}

fn render() -> String {
    let env = Env::default();
    let client = PolicyInterpreterClient::new(&env, &env.register(PolicyInterpreter, ()));
    let c = soroban_sdk::Address::generate(&env);
    let args: Vec<Val> = Vec::from_slice(&env, &[5i128.into_val(&env), 7u32.into_val(&env)]);
    let ctx = Context::Contract(ContractContext {
        contract: c,
        fn_name: Symbol::new(&env, "pay"),
        args,
    });
    let mut out = String::from("{\"cases\":[\n");
    let cases = corpus();
    for (i, (name, v)) in cases.iter().enumerate() {
        let code = client.check(&xdr_bytes(&env, v), &ctx);
        let b64 = v.to_xdr_base64(Limits::none()).unwrap();
        let sep = if i + 1 == cases.len() { "" } else { "," };
        writeln!(
            out,
            "{{\"name\":\"{name}\",\"json\":{},\"xdr\":\"{b64}\",\"code\":{code}}}{sep}",
            js(v)
        )
        .unwrap();
    }
    out.push_str("]}\n");
    out
}

#[test]
fn the_checked_in_corpus_is_current() {
    let fresh = render();
    if std::env::var("PARITY_WRITE").is_ok() {
        std::fs::create_dir_all(std::path::Path::new(FILE).parent().unwrap()).unwrap();
        std::fs::write(FILE, &fresh).unwrap();
    }
    let stored = std::fs::read_to_string(FILE).expect("fixture missing: run with PARITY_WRITE=1");
    assert_eq!(
        stored, fresh,
        "stale parity corpus: run with PARITY_WRITE=1"
    );
}
