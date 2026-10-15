//! The largest rules every audit lens could build, installed into the REAL wasm
//! and enforced against the live mainnet limits (400M CPU instructions,
//! 41,943,040 bytes of memory per transaction). `enforce` must stay under both
//! whatever the verdict: a rule that installs and then cannot run is a rule that
//! can never permit, and the leaf budget is what is meant to rule that out.
//!
//! The wasm is built, not rebuilt, here: run
//! `cargo build --release --target wasm32v1-none` first (or set `G7_WASM`). With
//! no wasm the test skips. `cargo test --release --test worst_case -- --nocapture`
//! prints the table.

extern crate alloc;

use alloc::vec::Vec as StdVec;

use policy_interpreter::{
    ContextRule, ContextRuleType, PolicyInstallParams, PolicyInterpreterClient, Signer,
};
use soroban_sdk::auth::{Context, ContractContext};
use soroban_sdk::testutils::{Address as _, EnvTestConfig};
use soroban_sdk::xdr::{
    ContractId, Hash, Int128Parts, ScAddress, ScBytes, ScMap, ScMapEntry, ScString, ScSymbol,
    ScVal, ScVec, ToXdr, VecM,
};
use soroban_sdk::{Address, Bytes, BytesN, Env, IntoVal, Symbol, Val, Vec as SorobanVec};

const CPU_LIMIT: u64 = 400_000_000;
const MEM_LIMIT: u64 = 41_943_040;

fn sym(s: &str) -> ScVal {
    ScVal::Symbol(ScSymbol(s.as_bytes().to_vec().try_into().unwrap()))
}
fn tup(items: &[ScVal]) -> ScVal {
    let v: VecM<ScVal> = items.to_vec().try_into().unwrap();
    ScVal::Vec(Some(ScVec(v)))
}
fn num(v: i128) -> ScVal {
    ScVal::I128(Int128Parts {
        hi: (v >> 64) as i64,
        lo: v as u64,
    })
}
fn account(i: u32) -> ScVal {
    let mut h = [0u8; 32];
    h[..4].copy_from_slice(&i.to_be_bytes());
    ScVal::Address(ScAddress::Contract(ContractId(Hash(h))))
}
fn lit(x: ScVal) -> ScVal {
    tup(&[sym("lit"), x])
}
fn arg(i: u32) -> ScVal {
    tup(&[sym("call_arg"), ScVal::U32(i)])
}
fn path(steps: &[ScVal]) -> ScVal {
    let mut v = alloc::vec![sym("call_path")];
    v.extend_from_slice(steps);
    tup(&v)
}
fn elem(steps: &[ScVal]) -> ScVal {
    let mut v = alloc::vec![sym("elem")];
    v.extend_from_slice(steps);
    tup(&v)
}
fn sum(over: ScVal, steps: &[ScVal]) -> ScVal {
    let mut v = alloc::vec![sym("sum"), over];
    v.extend_from_slice(steps);
    tup(&v)
}
fn cmp(op: &str, a: ScVal, b: ScVal) -> ScVal {
    tup(&[sym(op), a, b])
}
fn set(op: &str, needle: ScVal, hay: &[ScVal]) -> ScVal {
    tup(&[sym(op), needle, tup(hay)])
}
fn and(kids: &[ScVal]) -> ScVal {
    tup(&[sym("and"), tup(kids)])
}
fn or(kids: &[ScVal]) -> ScVal {
    tup(&[sym("or"), tup(kids)])
}
fn quant(kind: &str, over: ScVal, body: ScVal) -> ScVal {
    tup(&[sym(kind), over, body])
}
fn map(entries: &[(ScVal, ScVal)]) -> ScVal {
    let mut e: StdVec<ScMapEntry> = entries
        .iter()
        .map(|(k, v)| ScMapEntry {
            key: k.clone(),
            val: v.clone(),
        })
        .collect();
    e.sort_by(|a, b| a.key.cmp(&b.key));
    ScVal::Map(Some(ScMap(e.try_into().unwrap())))
}
/// `eq(call_fn, advance)`: the selector every rule here needs.
fn advance() -> ScVal {
    cmp("eq", tup(&[sym("call_fn")]), sym("advance"))
}
fn voids(n: usize) -> ScVal {
    tup(&(0..n).map(|_| ScVal::Void).collect::<StdVec<_>>())
}
fn u32s(n: u32, tweak_last: bool) -> ScVal {
    let last = if tweak_last { n } else { n - 1 };
    tup(&(0..n)
        .map(|i| ScVal::U32(if i == n - 1 { last } else { i }))
        .collect::<StdVec<_>>())
}
fn bytes(n: usize) -> ScVal {
    ScVal::Bytes(ScBytes(alloc::vec![7u8; n].try_into().unwrap()))
}
fn list(n: usize, f: impl Fn(usize) -> ScVal) -> ScVal {
    tup(&(0..n).map(f).collect::<StdVec<_>>())
}
/// `[[[...x]]]`, `depth` levels.
fn nest(depth: usize, x: ScVal) -> ScVal {
    (0..depth).fold(x, |v, _| tup(&[v]))
}
fn zeros(n: usize) -> StdVec<ScVal> {
    (0..n).map(|_| ScVal::U32(0)).collect()
}

struct Case {
    name: &'static str,
    rule: ScVal,
    args: StdVec<ScVal>,
}

fn cases() -> StdVec<Case> {
    let mut v = StdVec::new();
    let mut add = |name, rule, args| v.push(Case { name, rule, args });
    let e0 = || elem(&[]);

    // decode cost: constants with many elements and one leaf
    add(
        "bare vec, 7,900 voids",
        and(&[advance(), cmp("eq", arg(0), voids(7_900))]),
        alloc::vec![num(1)],
    );
    add(
        "bare vec of 1,975 [void]",
        and(&[
            advance(),
            cmp("eq", arg(0), list(1_975, |_| tup(&[ScVal::Void]))),
        ]),
        alloc::vec![num(1)],
    );
    let mut enum_val = alloc::vec![sym("Name")];
    enum_val.extend((0..7_880).map(|_| ScVal::Void));
    add(
        "lit([Name, 7,880 voids])",
        and(&[advance(), cmp("eq", arg(0), lit(tup(&enum_val)))]),
        alloc::vec![num(1)],
    );
    add(
        "bare vec nested 5 deep",
        and(&[
            advance(),
            cmp("eq", arg(0), list(640, |_| nest(3, ScVal::Void))),
        ]),
        alloc::vec![num(1)],
    );

    // constants compared once per element of a quantifier body
    let over = || path(&[ScVal::U32(0)]);
    let same_typed = |len: u32| tup(&(0..32).map(|_| u32s(len, true)).collect::<StdVec<_>>());
    add(
        "body 3 x ne(elem, lit(1,150 u32s)), same-typed elements",
        and(&[
            advance(),
            quant(
                "all",
                over(),
                and(&[
                    cmp("ne", e0(), lit(u32s(1_150, false))),
                    cmp("ne", e0(), lit(u32s(1_149, false))),
                    cmp("ne", e0(), lit(u32s(1_148, false))),
                ]),
            ),
        ]),
        alloc::vec![same_typed(1_150)],
    );
    add(
        "body 3 x ne(elem, lit(1,150 u32s)), number elements",
        and(&[
            advance(),
            quant(
                "all",
                over(),
                and(&[
                    cmp("ne", e0(), lit(u32s(1_150, false))),
                    cmp("ne", e0(), lit(u32s(1_149, false))),
                    cmp("ne", e0(), lit(u32s(1_148, false))),
                ]),
            ),
        ]),
        alloc::vec![list(32, |i| num(i as i128))],
    );
    add(
        "body 3 x ne(elem, lit(460 big i128s))",
        and(&[
            advance(),
            quant(
                "all",
                over(),
                and(&[
                    cmp(
                        "ne",
                        e0(),
                        lit(list(460, |i| num((1i128 << 100) + i as i128))),
                    ),
                    cmp(
                        "ne",
                        e0(),
                        lit(list(459, |i| num((1i128 << 100) + i as i128))),
                    ),
                    cmp(
                        "ne",
                        e0(),
                        lit(list(458, |i| num((1i128 << 100) + i as i128))),
                    ),
                ]),
            ),
        ]),
        alloc::vec![list(32, |_| list(460, |i| num((1i128 << 100)
            + i as i128
            + 1)))],
    );
    add(
        "body ne(elem, lit(31 KB bytes)), bytes elements",
        and(&[
            advance(),
            quant("all", over(), cmp("ne", e0(), lit(bytes(31_000)))),
        ]),
        alloc::vec![list(32, |_| bytes(30_999))],
    );
    add(
        "body ne(elem, lit(700 addresses)), address-vec elements",
        and(&[
            advance(),
            quant(
                "all",
                over(),
                cmp("ne", e0(), lit(list(700, |i| account(i as u32)))),
            ),
        ]),
        alloc::vec![list(32, |_| list(700, |i| account(i as u32 + 1)))],
    );
    add(
        "body in(elem, 5 addresses) over 32 addresses",
        and(&[
            advance(),
            quant(
                "all",
                over(),
                set("in", e0(), &(0..5).map(account).collect::<StdVec<_>>()),
            ),
        ]),
        alloc::vec![list(32, |_| account(4))],
    );

    // a sum walks 32 elements however it is written
    let deep = |d: usize| list(32, |i| nest(d, num(i as i128)));
    let steps8 = zeros(8);
    let total = || sum(over(), &steps8);
    add(
        "3 x gte(sum, sum), 32 elements, 8-step paths (6 sums)",
        and(&[
            advance(),
            cmp("gte", total(), total()),
            cmp("gte", total(), total()),
            cmp("gte", total(), total()),
        ]),
        alloc::vec![deep(8)],
    );

    // many leaves, long paths
    let mut key_steps = StdVec::new();
    for d in 0..7 {
        key_steps.push(sym(&alloc::format!("k{d}")));
    }
    let keyed = (0..7).rev().fold(num(5), |v, d| {
        let mut m: StdVec<(ScVal, ScVal)> = (0..16)
            .map(|k| (sym(&alloc::format!("z{k}")), num(0)))
            .collect();
        m.push((sym(&alloc::format!("k{d}")), v));
        map(&m)
    });
    let mut walk = alloc::vec![ScVal::U32(0)];
    walk.extend(key_steps);
    add(
        "100 compares, 8-step paths (index, then 7 map keys), 16 keys per map",
        and(&(0..100)
            .map(|_| cmp("eq", path(&walk), num(5)))
            .collect::<StdVec<_>>()),
        alloc::vec![keyed],
    );
    add(
        "198 compares of 2 leaves (max leaves), 8-step vec paths",
        and(&(0..99)
            .map(|_| cmp("eq", path(&zeros(8)), num(5)))
            .collect::<StdVec<_>>()),
        alloc::vec![nest(7, num(5))],
    );

    // caller-sized needles (pre-existing in grammar 6)
    let hay = |s: u32| (0..32).map(|i| account(s + i)).collect::<StdVec<_>>();
    add(
        "6 x in x 32 addresses, 30 KB bytes needle",
        or(&(0..6)
            .map(|i| set("in", arg(0), &hay(i * 100)))
            .collect::<StdVec<_>>()),
        alloc::vec![bytes(30_000)],
    );
    // the largest argument a transaction can carry (about 132 KB), against the
    // same six sets: compared by the host, never serialised
    add(
        "6 x in x 32 addresses, 100 KB bytes needle",
        or(&(0..6)
            .map(|i| set("in", arg(0), &hay(i * 100)))
            .collect::<StdVec<_>>()),
        alloc::vec![bytes(100_000)],
    );
    // a vector and a map the same size, against vectors and maps of their own kind
    let like = |n: u32| {
        (0..32)
            .map(|i| list(2, |k| ScVal::U32(n + i * 2 + k as u32)))
            .collect::<StdVec<_>>()
    };
    add(
        "6 x in x 32 vecs, 12,000-element vec needle (96 KB)",
        or(&(0..6)
            .map(|i| set("in", arg(0), &like(i * 100)))
            .collect::<StdVec<_>>()),
        alloc::vec![list(12_000, |i| ScVal::U32(i as u32))],
    );
    add(
        "6 x in x 32 maps, 4,000-entry map needle (96 KB)",
        or(&(0..6)
            .map(|i| {
                let hay = (0..32)
                    .map(|j| lit(map(&[(ScVal::U32(i * 100 + j), ScVal::U32(0))])))
                    .collect::<StdVec<_>>();
                set("in", arg(0), &hay)
            })
            .collect::<StdVec<_>>()),
        alloc::vec![map(&(0..4_000)
            .map(|i| (ScVal::U32(i), ScVal::U32(i)))
            .collect::<StdVec<_>>())],
    );
    add(
        "6 x nin x 32 addresses, 100 KB string needle",
        and(&(0..6)
            .map(|i| set("nin", arg(0), &hay(i * 100)))
            .collect::<StdVec<_>>()),
        alloc::vec![ScVal::String(ScString(
            alloc::vec![b'a'; 100_000].try_into().unwrap()
        ))],
    );
    add(
        "5 x nin x 32 addresses, 30 KB bytes needle",
        and(&(0..5)
            .map(|i| set("nin", arg(0), &hay(i * 100)))
            .collect::<StdVec<_>>()),
        alloc::vec![bytes(30_000)],
    );
    v
}

fn wasm() -> Option<StdVec<u8>> {
    let path = std::env::var("G7_WASM").ok().or_else(|| {
        let dir = std::env::var("CARGO_TARGET_DIR")
            .unwrap_or_else(|_| concat!(env!("CARGO_MANIFEST_DIR"), "/target").into());
        Some(alloc::format!(
            "{dir}/wasm32v1-none/release/policy_interpreter.wasm"
        ))
    })?;
    std::fs::read(path).ok()
}

/// (install result, CPU, memory) of one enforce, and (CPU, memory) of the install.
fn run(code: &[u8], case: &Case) -> (Result<(), u32>, u64, u64, (u64, u64)) {
    let env = Env::new_with_config(EnvTestConfig {
        capture_snapshot_at_drop: false,
    });
    env.mock_all_auths_allowing_non_root_auth();
    env.cost_estimate().disable_resource_limits();
    env.cost_estimate().budget().reset_unlimited();
    let policy = env.register(code, ());
    let client = PolicyInterpreterClient::new(&env, &policy);
    let account = Address::generate(&env);
    let target = Address::generate(&env);
    let signers = soroban_sdk::vec![&env, Signer::Delegated(account.clone())];
    let rule = ContextRule {
        id: 1,
        context_type: ContextRuleType::CallContract(target.clone()),
        name: soroban_sdk::String::from_str(&env, "rule"),
        signers: signers.clone(),
        signer_ids: SorobanVec::new(&env),
        policies: SorobanVec::new(&env),
        policy_ids: SorobanVec::new(&env),
        valid_until: None,
    };
    let val: Val = case.rule.clone().into_val(&env);
    let predicate: Bytes = val.to_xdr(&env);
    assert!(
        predicate.len() <= 32 * 1024,
        "{}: {} bytes",
        case.name,
        predicate.len()
    );
    let hash: BytesN<32> = env.crypto().sha256(&predicate).into();
    let params = PolicyInstallParams {
        grammar_version: 7,
        install_nonce: 1,
        predicate,
        predicate_hash: hash,
        policy_admins: signers.clone(),
    };
    if let Err(e) = client.try_install(&params, &rule, &account) {
        let code = match e {
            Ok(e) => e.get_code(),
            Err(_) => u32::MAX,
        };
        return (Err(code), 0, 0, (0, 0));
    }
    let b = env.cost_estimate().budget();
    let install = (b.cpu_instruction_cost(), b.memory_bytes_cost());
    let args: StdVec<Val> = case.args.iter().map(|a| a.clone().into_val(&env)).collect();
    let context = Context::Contract(ContractContext {
        contract: target,
        fn_name: Symbol::new(&env, "advance"),
        args: SorobanVec::from_slice(&env, &args),
    });
    env.cost_estimate().budget().reset_unlimited();
    // The verdict does not matter: a deny is as costly as a permit.
    let _ = client.try_enforce(&context, &signers, &rule, &account);
    let b = env.cost_estimate().budget();
    (
        Ok(()),
        b.cpu_instruction_cost(),
        b.memory_bytes_cost(),
        install,
    )
}

#[test]
fn the_largest_rules_stay_inside_the_transaction_limits() {
    let Some(code) = wasm() else {
        eprintln!("worst_case: no wasm (cargo build --release --target wasm32v1-none); skipped");
        return;
    };
    let (mut cpu_max, mut mem_max) = (0, 0);
    for case in cases() {
        let (install, cpu, mem, (icpu, imem)) = run(&code, &case);
        eprintln!(
            "{:<58} install={:?} cpu={:>11} mem={:>10} (install {:>11} / {:>10})",
            case.name, install, cpu, mem, icpu, imem
        );
        // a refused install measures 0, which would pass every limit below
        assert_eq!(install, Ok(()), "{}: install refused", case.name);
        assert!(
            icpu < CPU_LIMIT && imem < MEM_LIMIT,
            "{}: install",
            case.name
        );
        assert!(cpu < CPU_LIMIT, "{}: {cpu} CPU of {CPU_LIMIT}", case.name);
        assert!(mem < MEM_LIMIT, "{}: {mem} bytes of {MEM_LIMIT}", case.name);
        (cpu_max, mem_max) = (cpu_max.max(cpu), mem_max.max(mem));
    }
    eprintln!("worst case: {cpu_max} CPU, {mem_max} bytes");
}
