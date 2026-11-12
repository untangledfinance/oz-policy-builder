//! The largest rules every audit lens could build, installed into the REAL wasm
//! and run against the Soroban network limits. `install`, `enforce` and `check`
//! must each stay inside them whatever the verdict - with a 20% margin, so a fee
//! or limit change does not turn a deployed rule into one that can never run -
//! under two sets of limits: the defaults, and the CEILINGS the
//! constructor allows (8 reads, 400 weighted leaves, the byte ceiling, 64
//! elements, 64 `in` entries, depth 8), each case sized to its limits so the
//! rule is as large as the deployment permits.
//!
//! The network limits are `NET` below, read from the live config settings of
//! testnet and mainnet (identical for every field used here; see the report in
//! the commit that introduced the ceilings). The contract-data entry cap, the
//! write bytes, the footprint, the memory and CPU come from the host's own
//! accounting (`cost_estimate().resources()`), the transaction size from a real
//! envelope built around the call (`install_tx_size`).
//!
//! The wasm is built, not rebuilt, here, and the test FAILS without one (a skip
//! proves nothing). Build it first: `./build-wasm.sh` (or `cargo build --release
//! --target wasm32v1-none`), then `cargo test --release --test worst_case --
//! --nocapture` prints the table. It reads
//! `$CARGO_TARGET_DIR/wasm32v1-none/release/policy_interpreter.wasm`, or
//! `INTERPRETER_WASM`.
//! `SKIP_WORST_CASE=1` skips it on purpose (a plain `cargo test` without a
//! wasm). A wasm older than the source is not detected: build before running.

extern crate alloc;
mod common;

use alloc::vec::Vec as StdVec;

use policy_interpreter::{
    ContextRule, ContextRuleType, Limits, PolicyInstallParams, PolicyInterpreterClient, Signer,
};
use soroban_sdk::auth::{Context, ContractContext};
use soroban_sdk::testutils::{Address as _, EnvTestConfig};
use soroban_sdk::token::StellarAssetClient;
use soroban_sdk::xdr as x;
use soroban_sdk::xdr::{
    ContractId, FromXdr, Hash, Int128Parts, Limits as XdrLimits, ScAddress, ScBytes, ScMap,
    ScMapEntry, ScString, ScSymbol, ScVal, ScVec, ToXdr, VecM, WriteXdr,
};
use soroban_sdk::{Address, Bytes, BytesN, Env, IntoVal, Symbol, Val, Vec as SorobanVec};

/// The network's per-transaction limits (`getLedgerEntries` of the CONFIG_SETTING
/// entries, 2026-10-16: identical on testnet and mainnet for every field here).
struct Net {
    cpu: u64,
    mem: u64,
    read_entries: u64,
    read_bytes: u64,
    write_entries: u64,
    write_bytes: u64,
    footprint: u64,
    entry_bytes: u64,
    tx_bytes: u64,
}
const NET: Net = Net {
    cpu: 400_000_000,
    mem: 41_943_040,
    read_entries: 200,
    read_bytes: 200_000,
    write_entries: 200,
    write_bytes: 132_096,
    footprint: 400,
    entry_bytes: 65_536,
    tx_bytes: 132_096,
};
/// Used / limit, at most this many percent.
const MARGIN: u64 = 80;

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
/// `account(i)`, for `run`, where a local of that name hides the function.
fn placeholder(i: u32) -> ScVal {
    account(i)
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
    /// Contracts the rule reads, registered before install (`read` targets).
    reads: u32,
    permit: bool,
}

/// XDR length of a value: the size of the predicate bytes it becomes.
fn xdr_len(v: &ScVal) -> usize {
    WriteXdr::to_xdr(v, XdrLimits::none()).unwrap().len()
}

/// The largest `f(n)` that still fits `cap` bytes (`f` grows with `n`): a rule
/// that fills the byte limit it is built for, whatever that limit is.
fn fit(cap: u32, f: impl Fn(usize) -> ScVal) -> ScVal {
    let ok = |n| xdr_len(&f(n)) <= cap as usize;
    let (mut lo, mut hi) = (1, 2);
    while ok(hi) {
        (lo, hi) = (hi, hi * 2);
    }
    while hi - lo > 1 {
        let mid = (lo + hi) / 2;
        (lo, hi) = if ok(mid) { (mid, hi) } else { (lo, mid) };
    }
    f(lo)
}

/// A `read` of `balance(holder)` on the n-th registered token (`token(n)`).
fn balance_of(n: u32) -> ScVal {
    tup(&[
        sym("read"),
        account(1_000 + n),
        sym("balance"),
        tup(&[account(2_000 + n)]),
    ])
}

fn cases(l: &Limits) -> StdVec<Case> {
    let mut v = StdVec::new();
    let (bytes_cap, leaves, elems, ins) = (
        l.max_predicate_bytes,
        l.max_leaves as usize,
        l.max_elems as usize,
        l.max_in_operands as usize,
    );
    // `permit`: the rule is built so evaluation runs to the end and permits; the rest
    // deny after all their work (decode-bound, or every branch of an `or` tried).
    let mut add = |name, rule, args, permit| {
        v.push(Case {
            name,
            rule,
            args,
            reads: 0,
            permit,
        })
    };
    let e0 = || elem(&[]);

    // decode cost: constants with many elements and one leaf
    add(
        "bare vec of voids, filling the byte cap",
        fit(bytes_cap, |n| {
            and(&[advance(), cmp("eq", arg(0), voids(n))])
        }),
        alloc::vec![num(1)],
        false,
    );
    add(
        "bare vec of [void], filling the byte cap",
        fit(bytes_cap, |n| {
            and(&[
                advance(),
                cmp("eq", arg(0), list(n, |_| tup(&[ScVal::Void]))),
            ])
        }),
        alloc::vec![num(1)],
        false,
    );
    add(
        "lit([Name, voids...]), filling the byte cap",
        fit(bytes_cap, |n| {
            let mut enum_val = alloc::vec![sym("Name")];
            enum_val.extend((0..n).map(|_| ScVal::Void));
            and(&[advance(), cmp("eq", arg(0), lit(tup(&enum_val)))])
        }),
        alloc::vec![num(1)],
        false,
    );
    let depth = l.max_depth as usize;
    add(
        "bare vec nested to max depth, filling the byte cap",
        fit(bytes_cap, |n| {
            and(&[
                advance(),
                cmp("eq", arg(0), list(n, |_| nest(depth - 2, ScVal::Void))),
            ])
        }),
        alloc::vec![num(1)],
        false,
    );
    add(
        "in over max_in_operands bare vecs of voids",
        fit(bytes_cap, |n| {
            and(&[
                advance(),
                set(
                    "in",
                    arg(0),
                    &(0..ins).map(|_| voids(n)).collect::<StdVec<_>>(),
                ),
            ])
        }),
        alloc::vec![num(1)],
        false,
    );
    add(
        "bare vec of voids as a map-key step, filling the byte cap",
        fit(bytes_cap, |n| {
            and(&[
                advance(),
                cmp("eq", path(&[ScVal::U32(0), voids(n)]), num(5)),
            ])
        }),
        alloc::vec![tup(&[num(5)])],
        false,
    );

    // constants compared once per element of a quantifier body: as many
    // two-leaf compares as the leaf cap leaves room for, each carrying a
    // constant of about a third of the byte cap
    let over = || path(&[ScVal::U32(0)]);
    let cmps = (leaves - 3) / (2 * elems);
    let u32s_of = |len: usize| u32s(len as u32, false);
    let body_of = |n: usize, mk: &dyn Fn(usize) -> ScVal| {
        and(&[
            advance(),
            quant(
                "all",
                over(),
                and(&(0..cmps)
                    .map(|k| cmp("ne", e0(), mk(n - k)))
                    .collect::<StdVec<_>>()),
            ),
        ])
    };
    let u32_lit = |n: usize| lit(u32s_of(n));
    let same_typed = |len: usize| {
        tup(&(0..elems)
            .map(|_| u32s(len as u32, true))
            .collect::<StdVec<_>>())
    };
    let fit_n = fit_count(bytes_cap, |n| body_of(n, &u32_lit));
    add(
        "body compares of big u32 vecs, same-typed elements",
        body_of(fit_n, &u32_lit),
        alloc::vec![same_typed(fit_n)],
        true,
    );
    add(
        "body compares of big u32 vecs, number elements",
        body_of(fit_n, &u32_lit),
        alloc::vec![list(elems, |i| num(i as i128))],
        true,
    );
    let big = |n: usize| lit(list(n, |i| num((1i128 << 100) + i as i128)));
    let fit_big = fit_count(bytes_cap, |n| body_of(n, &big));
    add(
        "body compares of big i128 vecs",
        body_of(fit_big, &big),
        alloc::vec![list(elems, |_| list(fit_big, |i| num((1i128 << 100)
            + i as i128
            + 1)))],
        true,
    );
    add(
        "body ne(elem, lit(bytes)), bytes elements",
        fit(bytes_cap, |n| {
            and(&[
                advance(),
                quant("all", over(), cmp("ne", e0(), lit(bytes(n)))),
            ])
        }),
        alloc::vec![list(elems, |_| bytes(bytes_cap as usize - 1_100))],
        true,
    );
    add(
        "body ne(elem, lit(addresses)), address-vec elements",
        fit(bytes_cap, |n| {
            and(&[
                advance(),
                quant(
                    "all",
                    over(),
                    cmp("ne", e0(), lit(list(n, |i| account(i as u32)))),
                ),
            ])
        }),
        alloc::vec![list(elems, |_| list(1_000, |i| account(i as u32 + 1)))],
        true,
    );
    add(
        "body in(elem, 5 addresses) over max_elems addresses",
        and(&[
            advance(),
            quant(
                "all",
                over(),
                set("in", e0(), &(0..5).map(account).collect::<StdVec<_>>()),
            ),
        ]),
        alloc::vec![list(elems, |_| account(4))],
        true,
    );

    // a sum walks max_elems elements however it is written
    let deep = |d: usize| list(elems, |i| nest(d, num(i as i128)));
    let steps8 = zeros(8);
    let total = || sum(over(), &steps8);
    let sums = (leaves - 2) / (2 * elems + 2);
    add(
        "gte(sum, sum) as often as the leaf cap allows, 8-step paths",
        and(&core::iter::once(advance())
            .chain((0..sums).map(|_| cmp("gte", total(), total())))
            .collect::<StdVec<_>>()),
        alloc::vec![deep(8)],
        true,
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
        "max_leaves/2 compares, 8-step paths (index, then 7 map keys), 16 keys per map",
        and(&(0..leaves / 2)
            .map(|_| cmp("eq", path(&walk), num(5)))
            .collect::<StdVec<_>>()),
        alloc::vec![keyed],
        true,
    );
    add(
        "max_leaves/2 - 1 compares of 2 leaves, 8-step vec paths",
        and(&(0..leaves / 2 - 1)
            .map(|_| cmp("eq", path(&zeros(8)), num(5)))
            .collect::<StdVec<_>>()),
        alloc::vec![nest(7, num(5))],
        true,
    );

    // caller-sized needles: as many `in` sets of
    // max_in_operands entries as the leaf cap allows
    let sets = leaves / (ins + 1);
    let hay = |s: usize| {
        (0..ins)
            .map(|i| account((s + i) as u32))
            .collect::<StdVec<_>>()
    };
    add(
        "in x max_in_operands addresses, 30 KB bytes needle",
        or(&(0..sets)
            .map(|i| set("in", arg(0), &hay(i * 100)))
            .collect::<StdVec<_>>()),
        alloc::vec![bytes(30_000)],
        false,
    );
    // the largest argument a transaction can carry (about 132 KB), against the
    // same sets: compared by the host, never serialised
    add(
        "in x max_in_operands addresses, 100 KB bytes needle",
        or(&(0..sets)
            .map(|i| set("in", arg(0), &hay(i * 100)))
            .collect::<StdVec<_>>()),
        alloc::vec![bytes(100_000)],
        false,
    );
    // a vector and a map the same size, against vectors and maps of their own kind
    let like = |n: usize| {
        (0..ins)
            .map(|i| list(2, |k| ScVal::U32((n + i * 2 + k) as u32)))
            .collect::<StdVec<_>>()
    };
    add(
        "in x max_in_operands vecs, 12,000-element vec needle (96 KB)",
        or(&(0..sets)
            .map(|i| set("in", arg(0), &like(i * 100)))
            .collect::<StdVec<_>>()),
        alloc::vec![list(12_000, |i| ScVal::U32(i as u32))],
        false,
    );
    add(
        "in x max_in_operands maps, 4,000-entry map needle (96 KB)",
        or(&(0..sets)
            .map(|i| {
                let hay = (0..ins)
                    .map(|j| lit(map(&[(ScVal::U32((i * 100 + j) as u32), ScVal::U32(0))])))
                    .collect::<StdVec<_>>();
                set("in", arg(0), &hay)
            })
            .collect::<StdVec<_>>()),
        alloc::vec![map(&(0..4_000)
            .map(|i| (ScVal::U32(i), ScVal::U32(i)))
            .collect::<StdVec<_>>())],
        false,
    );
    add(
        "nin x max_in_operands addresses, 100 KB string needle",
        and(&(0..sets)
            .map(|i| set("nin", arg(0), &hay(i * 100)))
            .collect::<StdVec<_>>()),
        alloc::vec![ScVal::String(ScString(
            alloc::vec![b'a'; 100_000].try_into().unwrap()
        ))],
        true,
    );

    // depth: `and` nested to max_depth with long paths at every level, and a
    // `scaled` nested to max_depth inside as many compares as the cap allows
    let level = |_: usize| cmp("eq", path(&zeros(8)), num(0));
    let scaled_to = |d: usize| {
        (0..d).fold(num(1), |x, _| {
            tup(&[sym("scaled"), x, num(1), num(1), num(0)])
        })
    };
    // a `scaled` of depth d is 3 leaves a level and one more at the bottom, beside
    // the `call_arg` it is compared with
    let nest_cost = 3 * (depth - 1) + 2;
    let per_level = (leaves - nest_cost) / 2 / (depth - 1);
    let deepest = cmp("gte", arg(1), scaled_to(depth - 1));
    let tower = (0..depth - 2).fold(
        and(&core::iter::once(deepest)
            .chain((0..per_level).map(level))
            .collect::<StdVec<_>>()),
        |inner, _| {
            and(&core::iter::once(inner)
                .chain((0..per_level).map(level))
                .collect::<StdVec<_>>())
        },
    );
    add(
        "and nested to max_depth, long paths at every level, a deepest scaled",
        tower,
        alloc::vec![nest(7, num(0)), num(1)],
        true,
    );
    add(
        "compares of a scaled nested to max_depth",
        and(&(0..leaves / nest_cost)
            .map(|_| cmp("gte", arg(0), scaled_to(depth - 1)))
            .collect::<StdVec<_>>()),
        alloc::vec![num(1)],
        true,
    );

    // reads: max_reads distinct tokens read in one rule, beside a quantifier
    // and a sum that spend most of the leaf budget
    let reads = l.max_reads;
    let mut kids = alloc::vec![advance()];
    kids.extend((0..reads).map(|n| cmp("gte", balance_of(n), num(0))));
    let spare = leaves - 2 - 2 * reads as usize;
    let body_cmps = spare.saturating_sub(elems + 2) / (2 * elems);
    kids.push(cmp("gte", sum(over(), &[]), num(0)));
    kids.push(quant(
        "all",
        over(),
        and(&(0..body_cmps.max(1))
            .map(|_| cmp("gte", e0(), num(0)))
            .collect::<StdVec<_>>()),
    ));
    v.push(Case {
        name: "max_reads distinct token reads + a quantifier + a sum",
        rule: and(&kids),
        args: alloc::vec![list(elems, |i| num(i as i128 + 1))],
        reads,
        permit: true,
    });
    v
}

/// The largest `n` for which `f(n)` fits `cap` bytes.
fn fit_count(cap: u32, f: impl Fn(usize) -> ScVal) -> usize {
    let ok = |n| xdr_len(&f(n)) <= cap as usize;
    let (mut lo, mut hi) = (3, 6);
    while ok(hi) {
        (lo, hi) = (hi, hi * 2);
    }
    while hi - lo > 1 {
        let mid = (lo + hi) / 2;
        (lo, hi) = if ok(mid) { (mid, hi) } else { (lo, mid) };
    }
    lo
}

fn wasm() -> Option<StdVec<u8>> {
    let path = std::env::var("INTERPRETER_WASM").ok().or_else(|| {
        let dir = std::env::var("CARGO_TARGET_DIR")
            .unwrap_or_else(|_| concat!(env!("CARGO_MANIFEST_DIR"), "/target").into());
        Some(alloc::format!(
            "{dir}/wasm32v1-none/release/policy_interpreter.wasm"
        ))
    })?;
    std::fs::read(path).ok()
}

/// What one call used, from the host's own accounting.
#[derive(Clone, Copy, Debug, Default)]
struct Used {
    cpu: u64,
    mem: u64,
    read_entries: u64,
    write_entries: u64,
    write_bytes: u64,
}

fn used(env: &Env) -> Used {
    let r = env.cost_estimate().resources();
    Used {
        cpu: r.instructions as u64,
        mem: r.mem_bytes as u64,
        read_entries: u64::from(r.disk_read_entries + r.memory_read_entries),
        write_entries: u64::from(r.write_entries),
        write_bytes: u64::from(r.write_bytes),
    }
}

struct Run {
    install: Used,
    enforce: Used,
    check: Used,
    /// Size of the stored rule entry (key and value), the contract-data entry cap's subject.
    entry_bytes: u64,
    predicate_bytes: usize,
}

fn rule_for(env: &Env, target: &Address, signers: &SorobanVec<Signer>) -> ContextRule {
    ContextRule {
        id: 1,
        context_type: ContextRuleType::CallContract(target.clone()),
        name: soroban_sdk::String::from_str(env, "rule"),
        signers: signers.clone(),
        signer_ids: SorobanVec::new(env),
        policies: SorobanVec::new(env),
        policy_ids: SorobanVec::new(env),
        valid_until: None,
    }
}

/// `Err(code)` when the interpreter refused the install.
fn run(code: &[u8], case: &Case, l: &Limits) -> Result<Run, u32> {
    let env = Env::new_with_config(EnvTestConfig {
        capture_snapshot_at_drop: false,
    });
    env.mock_all_auths_allowing_non_root_auth();
    env.cost_estimate().disable_resource_limits();
    env.cost_estimate().budget().reset_unlimited();
    let policy = env.register(code, (*l,));
    let client = PolicyInterpreterClient::new(&env, &policy);
    let account = Address::generate(&env);
    let target = Address::generate(&env);
    let signers = soroban_sdk::vec![&env, Signer::Delegated(account.clone())];
    let rule = rule_for(&env, &target, &signers);
    // Each token the rule reads is a real Stellar asset contract with a holder
    // that has a balance, swapped in for the rule's placeholder addresses.
    let as_scval = |a: &Address| {
        let v: Val = a.into_val(&env);
        ScVal::from_xdr(&env, &v.to_xdr(&env)).unwrap()
    };
    let mut rule_val = case.rule.clone();
    for n in 0..case.reads {
        let token = env.register_stellar_asset_contract_v2(Address::generate(&env));
        let holder = Address::generate(&env);
        StellarAssetClient::new(&env, &token.address()).mint(&holder, &5);
        rule_val = swap(
            &rule_val,
            &placeholder(1_000 + n),
            &as_scval(&token.address()),
        );
        rule_val = swap(&rule_val, &placeholder(2_000 + n), &as_scval(&holder));
    }
    let val: Val = rule_val.into_val(&env);
    let predicate: Bytes = val.to_xdr(&env);
    assert!(
        predicate.len() <= l.max_predicate_bytes,
        "{}: {} bytes",
        case.name,
        predicate.len()
    );
    let hash: BytesN<32> = env.crypto().sha256(&predicate).into();
    let params = PolicyInstallParams {
        grammar_version: 7,
        install_nonce: 1,
        predicate: predicate.clone(),
        predicate_hash: hash,
        policy_admins: signers.clone(),
    };
    if let Err(e) = client.try_install(&params, &rule, &account) {
        return Err(match e {
            Ok(e) => e.get_code(),
            Err(_) => u32::MAX,
        });
    }
    let install = used(&env);
    let doc: policy_interpreter::StoredDoc = env
        .as_contract(&policy, || {
            env.storage().persistent().get(&(account.clone(), 1u32))
        })
        .expect("stored");
    let entry_bytes = (doc.to_xdr(&env).len() + (account.clone(), 1u32).to_xdr(&env).len()) as u64;
    let args: StdVec<Val> = case.args.iter().map(|a| a.clone().into_val(&env)).collect();
    let context = Context::Contract(ContractContext {
        contract: target,
        fn_name: Symbol::new(&env, "advance"),
        args: SorobanVec::from_slice(&env, &args),
    });
    env.cost_estimate().budget().reset_unlimited();
    // The verdict does not matter: a deny is as costly as a permit.
    let verdict = client.try_enforce(&context, &signers, &rule, &account);
    let enforce = used(&env);
    // A rule meant to run to its end must permit: a deny partway would measure less.
    assert!(
        !case.permit || verdict.is_ok(),
        "{}: enforce should permit, got {verdict:?}",
        case.name
    );
    // `check` decodes as install does and evaluates as enforce does, in one call.
    env.cost_estimate().budget().reset_unlimited();
    let _ = client.try_check(&predicate, &context);
    let check = used(&env);
    Ok(Run {
        install,
        enforce,
        check,
        entry_bytes,
        predicate_bytes: predicate.len() as usize,
    })
}

fn swap(v: &ScVal, from: &ScVal, to: &ScVal) -> ScVal {
    match v {
        _ if v == from => to.clone(),
        ScVal::Vec(Some(items)) => tup(&items
            .iter()
            .map(|x| swap(x, from, to))
            .collect::<StdVec<_>>()),
        other => other.clone(),
    }
}

fn pct(used: u64, limit: u64) -> u64 {
    used * 100 / limit
}

/// One call's use against the network limits, with the margin. A failure names the
/// case, the call and the limit.
fn within(case: &str, call: &str, u: Used) {
    let checks = [
        ("CPU instructions", u.cpu, NET.cpu),
        ("memory bytes", u.mem, NET.mem),
        ("ledger read entries", u.read_entries, NET.read_entries),
        ("ledger write entries", u.write_entries, NET.write_entries),
        ("ledger write bytes", u.write_bytes, NET.write_bytes),
        (
            "footprint entries",
            u.read_entries + u.write_entries,
            NET.footprint,
        ),
    ];
    for (what, used, limit) in checks {
        assert!(
            used * 100 <= limit * MARGIN,
            "{case}: {call} uses {used} {what} of {limit} ({}%; at most {MARGIN}%)",
            pct(used, limit)
        );
    }
}

fn check_all(code: &[u8], l: &Limits, label: &str) -> (Used, Used) {
    // Every entry an enforce reads, were they all archived and so read from disk:
    // the stored rule, the interpreter's code and a generous 2 KB for the rest. This
    // does NOT cover what the rule's `read` targets cost if THEY are archived: each
    // archived instance, code or entry a read touches is restored by the transaction
    // and counts toward both the read and the write limit (on testnet, three views of
    // two archived OctoLend contracts needed 151 KB of the 132 KB write limit). The
    // assumption here is that read targets are live; the README says they must be kept so.
    let disk = |entry: u64| entry + code.len() as u64 + 2_048;
    let (mut worst_enforce, mut worst_install) = (Used::default(), Used::default());
    for case in cases(l) {
        let r =
            run(code, &case, l).unwrap_or_else(|c| panic!("{}: install refused ({c})", case.name));
        eprintln!(
            "{label} {:<66} {:>7} B  install {:>3}% cpu {:>3}% mem | enforce {:>3}% cpu {:>3}% mem | check {:>3}% cpu | entry {:>6} B ({}%) | rd {} wr {} ({} B)",
            case.name,
            r.predicate_bytes,
            pct(r.install.cpu, NET.cpu),
            pct(r.install.mem, NET.mem),
            pct(r.enforce.cpu, NET.cpu),
            pct(r.enforce.mem, NET.mem),
            pct(r.check.cpu, NET.cpu),
            r.entry_bytes,
            pct(r.entry_bytes, NET.entry_bytes),
            r.enforce.read_entries,
            r.install.write_entries,
            r.install.write_bytes,
        );
        within(case.name, "install", r.install);
        within(case.name, "enforce", r.enforce);
        within(case.name, "check", r.check);
        assert!(
            r.entry_bytes * 100 <= NET.entry_bytes * MARGIN,
            "{}: the stored rule is {} bytes of the {} entry cap",
            case.name,
            r.entry_bytes,
            NET.entry_bytes
        );
        assert!(
            disk(r.entry_bytes) * 100 <= NET.read_bytes * MARGIN,
            "{}: {} bytes read from disk if archived, of {}",
            case.name,
            disk(r.entry_bytes),
            NET.read_bytes
        );
        if r.enforce.cpu > worst_enforce.cpu {
            worst_enforce = r.enforce;
        }
        if r.install.cpu > worst_install.cpu {
            worst_install = r.install;
        }
    }
    (worst_install, worst_enforce)
}

fn the_wasm() -> Option<StdVec<u8>> {
    let code = wasm();
    if code.is_none() {
        // A skipped run is a run that proves nothing, so it is an error unless
        // the environment says the wasm is deliberately absent.
        assert!(
            std::env::var("SKIP_WORST_CASE").is_ok_and(|v| v == "1"),
            "worst_case: no wasm. Build it (./build-wasm.sh, or cargo build --release \
             --target wasm32v1-none), point INTERPRETER_WASM at it, or set SKIP_WORST_CASE=1"
        );
        eprintln!("worst_case: skipped (SKIP_WORST_CASE=1)");
    }
    code
}

#[test]
fn the_largest_rules_stay_inside_the_transaction_limits_at_the_defaults() {
    let Some(code) = the_wasm() else { return };
    let (i, e) = check_all(&code, &common::DEFAULT, "default");
    eprintln!(
        "worst case at the defaults: install {} CPU, enforce {} CPU / {} bytes",
        i.cpu, e.cpu, e.mem
    );
}

/// Every limit at its ceiling at once. A ceiling that cannot pass here with the
/// margin is too high: lower it in `Limits::in_range`, and say why in its doc.
#[test]
fn the_largest_rules_stay_inside_the_transaction_limits_at_the_ceilings() {
    let Some(code) = the_wasm() else { return };
    let (i, e) = check_all(&code, &common::CEILING, "ceiling");
    eprintln!(
        "worst case at the ceilings: install {} CPU, enforce {} CPU / {} bytes",
        i.cpu, e.cpu, e.mem
    );
    // What each of `max_reads` reads may cost its callee, beside the interpreter's own work.
    let room = NET.cpu * MARGIN / 100 - e.cpu;
    eprintln!(
        "callee room: {} CPU for the {} reads together",
        room,
        common::CEILING.max_reads
    );
}

/// One execution-adapter `Call` as its `execute` receives it: the wire map a
/// `#[contracttype]` struct becomes (symbol keys, sorted), with `target` the
/// listed venue and `function_name` the pinned function. The batch a self-scoped
/// rule authorises is a vector of these.
fn call_map(target: &ScVal, function: &str) -> ScVal {
    let empty = tup(&[]);
    map(&[
        (sym("args"), empty.clone()),
        (sym("executor_authorizations"), empty),
        (sym("function_name"), sym(function)),
        (sym("target"), target.clone()),
    ])
}

/// A keyless rule scoped to `executor`, carrying the interpreter as its policy:
/// the shape `bind_executor` and the keyless-gate path accept.
fn self_scoped_rule(env: &Env, interpreter: &Address, executor: &Address) -> ContextRule {
    ContextRule {
        id: 1,
        context_type: ContextRuleType::CallContract(executor.clone()),
        name: soroban_sdk::String::from_str(env, "rule"),
        signers: SorobanVec::new(env),
        signer_ids: SorobanVec::new(env),
        policies: soroban_sdk::vec![env, interpreter.clone()],
        policy_ids: soroban_sdk::vec![env, 0u32],
        valid_until: None,
    }
}

/// The pinned immediate-`execute` batch predicate for `m` calls: on every path
/// to a permit `call_fn == execute`, `args[2] == 0`, `len(args[0]) == m`, and
/// the target and function name of each of calls `0..m` an `eq` of a constant -
/// exactly the self-scoped shape `pins_own` accepts (221).
fn batch_predicate(targets: &[ScVal]) -> ScVal {
    batch_predicate_padded(targets, 0, 0)
}

/// `wrap(x)` nested `depth` deep: a chain of single-child `and`s. Legal (the
/// decoder accepts a one-child `and`) and leaf-free, so it fills bytes and depth
/// without a leaf - the padding the verifier used to drive the OLD quadratic
/// `pins_own` to its ceiling.
fn nest_and(depth: u32, inner: ScVal) -> ScVal {
    (0..depth).fold(inner, |v, _| and(&[v]))
}

/// The pinned batch predicate (see `batch_predicate`), with the first
/// `wrap_count` of the per-call `eq` conjuncts each wrapped `wrap_depth` deep in
/// single-child `and`s. `wrap_* == 0` is the flat shape; padding reproduces the
/// byte-and-depth-filling worst case the verifier built.
fn batch_predicate_padded(targets: &[ScVal], wrap_depth: u32, wrap_count: usize) -> ScVal {
    let m = targets.len() as u32;
    let mut kids = alloc::vec![
        cmp("eq", tup(&[sym("call_fn")]), sym("execute")),
        cmp("eq", path(&[ScVal::U32(2)]), ScVal::U32(0)),
        cmp(
            "eq",
            path(&[ScVal::U32(0), ScVal::Bool(true)]),
            ScVal::U32(m)
        ),
    ];
    for (i, t) in targets.iter().enumerate() {
        let i = i as u32;
        let t_eq = cmp(
            "eq",
            path(&[ScVal::U32(0), ScVal::U32(i), sym("target")]),
            t.clone(),
        );
        let f_eq = cmp(
            "eq",
            path(&[ScVal::U32(0), ScVal::U32(i), sym("function_name")]),
            sym("ping"),
        );
        // Wrap the leading conjuncts (both the target and the function `eq`).
        let wrap = |k, eq| {
            if k < wrap_count {
                nest_and(wrap_depth, eq)
            } else {
                eq
            }
        };
        kids.push(wrap(2 * i as usize, t_eq));
        kids.push(wrap(2 * i as usize + 1, f_eq));
    }
    and(&kids)
}

/// The largest batch (most calls) a self-scoped rule can hold under `l`: bounded
/// by the leaf cap (each call adds two `eq`s) and the byte cap together.
fn largest_batch_m(env: &Env, code: &[u8], l: &Limits, targets: &[ScVal]) -> u32 {
    let installs = |m: usize| -> bool {
        let e = Env::new_with_config(EnvTestConfig {
            capture_snapshot_at_drop: false,
        });
        e.mock_all_auths_allowing_non_root_auth();
        e.cost_estimate().disable_resource_limits();
        e.cost_estimate().budget().reset_unlimited();
        let policy = e.register(code, (*l,));
        let client = PolicyInterpreterClient::new(&e, &policy);
        let account = Address::generate(&e);
        let executor = Address::generate(&e);
        let rule = self_scoped_rule(&e, &policy, &executor);
        let predicate: Bytes = {
            let v: Val = batch_predicate(&targets[..m]).into_val(&e);
            v.to_xdr(&e)
        };
        if predicate.len() > l.max_predicate_bytes {
            return false;
        }
        let hash: BytesN<32> = e.crypto().sha256(&predicate).into();
        let params = PolicyInstallParams {
            grammar_version: 7,
            install_nonce: 1,
            predicate,
            predicate_hash: hash,
            policy_admins: soroban_sdk::vec![&e, Signer::Delegated(Address::generate(&e))],
        };
        client.try_install(&params, &rule, &account).is_ok()
            && client
                .try_bind_executor(&(account, rule.id), &executor)
                .is_ok()
    };
    let _ = env;
    let (mut lo, mut hi) = (1usize, targets.len());
    while lo < hi {
        let mid = (lo + hi).div_ceil(2);
        if installs(mid) {
            lo = mid;
        } else {
            hi = mid - 1;
        }
    }
    lo as u32
}

/// The largest number of leading conjuncts a padded predicate can wrap
/// `wrap_depth` deep and still install and bind under `l` (bounded by the byte
/// cap; the leaf and depth caps are fixed as `wrap_count` grows).
fn largest_wrap_count(code: &[u8], l: &Limits, targets: &[ScVal], wrap_depth: u32) -> usize {
    let installs = |wrap_count: usize| -> bool {
        let e = Env::new_with_config(EnvTestConfig {
            capture_snapshot_at_drop: false,
        });
        e.mock_all_auths_allowing_non_root_auth();
        e.cost_estimate().disable_resource_limits();
        e.cost_estimate().budget().reset_unlimited();
        let policy = e.register(code, (*l,));
        let client = PolicyInterpreterClient::new(&e, &policy);
        let account = Address::generate(&e);
        let executor = Address::generate(&e);
        let rule = self_scoped_rule(&e, &policy, &executor);
        let predicate: Bytes = {
            let v: Val = batch_predicate_padded(targets, wrap_depth, wrap_count).into_val(&e);
            v.to_xdr(&e)
        };
        if predicate.len() > l.max_predicate_bytes {
            return false;
        }
        let hash: BytesN<32> = e.crypto().sha256(&predicate).into();
        let params = PolicyInstallParams {
            grammar_version: 7,
            install_nonce: 1,
            predicate,
            predicate_hash: hash,
            policy_admins: soroban_sdk::vec![&e, Signer::Delegated(Address::generate(&e))],
        };
        client.try_install(&params, &rule, &account).is_ok()
            && client
                .try_bind_executor(&(account, rule.id), &executor)
                .is_ok()
    };
    let (mut lo, mut hi) = (0usize, 2 * targets.len());
    while lo < hi {
        let mid = (lo + hi).div_ceil(2);
        if installs(mid) {
            lo = mid;
        } else {
            hi = mid - 1;
        }
    }
    lo
}

struct BatchRun {
    install: Used,
    bind: Used,
    enforce: Used,
    bytes: usize,
}

/// Install the self-scoped rule for `predicate`, bind the executor, then enforce
/// the matching batch with the executor's word, measuring each call.
fn measure_batch(code: &[u8], l: &Limits, targets: &[ScVal], predicate: &ScVal) -> BatchRun {
    let env = Env::new_with_config(EnvTestConfig {
        capture_snapshot_at_drop: false,
    });
    env.mock_all_auths_allowing_non_root_auth();
    env.cost_estimate().disable_resource_limits();
    env.cost_estimate().budget().reset_unlimited();
    let policy = env.register(code, (*l,));
    let client = PolicyInterpreterClient::new(&env, &policy);
    let account = Address::generate(&env);
    let executor = Address::generate(&env);
    let rule = self_scoped_rule(&env, &policy, &executor);
    let predicate_bytes: Bytes = {
        let v: Val = predicate.clone().into_val(&env);
        v.to_xdr(&env)
    };
    let bytes = predicate_bytes.len() as usize;
    assert!(
        bytes as u32 <= l.max_predicate_bytes,
        "predicate {bytes} B over the cap"
    );
    let hash: BytesN<32> = env.crypto().sha256(&predicate_bytes).into();
    let params = PolicyInstallParams {
        grammar_version: 7,
        install_nonce: 1,
        predicate: predicate_bytes,
        predicate_hash: hash,
        policy_admins: soroban_sdk::vec![&env, Signer::Delegated(Address::generate(&env))],
    };
    env.cost_estimate().budget().reset_unlimited();
    client
        .try_install(&params, &rule, &account)
        .expect("install")
        .expect("install ok");
    let install = used(&env);

    env.cost_estimate().budget().reset_unlimited();
    client
        .try_bind_executor(&(account.clone(), rule.id), &executor)
        .expect("bind")
        .expect("bind ok");
    let bind = used(&env);

    // The batch the rule authorises: `execute([ping -> each venue], [], 0)`.
    let calls = tup(&targets
        .iter()
        .map(|t| call_map(t, "ping"))
        .collect::<StdVec<_>>());
    let calls_val: Val = calls.into_val(&env);
    let empty_val: Val = tup(&[]).into_val(&env);
    let wait_val: Val = ScVal::U32(0).into_val(&env);
    let mut args: SorobanVec<Val> = SorobanVec::new(&env);
    args.push_back(calls_val);
    args.push_back(empty_val);
    args.push_back(wait_val);
    let context = Context::Contract(ContractContext {
        contract: executor.clone(),
        fn_name: Symbol::new(&env, "execute"),
        args,
    });
    let none: SorobanVec<Signer> = SorobanVec::new(&env);
    env.cost_estimate().budget().reset_unlimited();
    let verdict = client.try_enforce(&context, &none, &rule, &account);
    let enforce = used(&env);
    assert!(
        verdict.is_ok(),
        "bound enforce should permit, got {verdict:?}"
    );
    BatchRun {
        install,
        bind,
        enforce,
        bytes,
    }
}

/// INTERP-01: the bound, self-scoped batch rule that runs `pins_own` on every
/// `enforce` - install a keyless rule scoped to its executor, bind the executor,
/// then enforce with the executor's word. This path was never in the ceilings
/// table (`cases` installs keyed, unbound rules and never binds), and it is the
/// one the quadratic `pins_own` blew up: on the OLD code a bound `enforce` cost
/// 125.9M CPU on the flat shape and up to 366.1M (91.5% of the limit) on a
/// padded one, where the table claimed 62.3M. Measured here on the flat shape
/// AND on the byte-and-depth-filling padded shape the verifier used; with the
/// single-pass `pins_own` both stay well inside the margin even at the ceilings.
#[test]
fn a_bound_self_scoped_batch_rule_stays_inside_the_limits_at_the_ceilings() {
    let Some(code) = the_wasm() else { return };
    let code = code.as_slice();
    let l = common::CEILING;
    let env = Env::default();

    // Real targets for the pinned calls; the batch uses the very same addresses,
    // so it matches the rule and `enforce` runs to a permit (the costly path).
    let as_scval = |a: &Address| {
        let v: Val = a.into_val(&env);
        ScVal::from_xdr(&env, &v.to_xdr(&env)).unwrap()
    };
    let venues: StdVec<Address> = (0..130).map(|_| Address::generate(&env)).collect();
    let all_targets: StdVec<ScVal> = venues.iter().map(as_scval).collect();
    let m = largest_batch_m(&env, code, &l, &all_targets) as usize;
    let targets = &all_targets[..m];

    // Flat shape: the m=98 path the auditors measured at 125.9M on the old code.
    let flat = measure_batch(code, &l, targets, &batch_predicate(targets));
    // Padded shape: leading conjuncts wrapped as deep as the depth cap allows,
    // filling the byte cap - the verifier's 366.1M worst on the old code.
    let wrap_depth = l.max_depth - 2;
    let wrap_count = largest_wrap_count(code, &l, targets, wrap_depth);
    let padded = measure_batch(
        code,
        &l,
        targets,
        &batch_predicate_padded(targets, wrap_depth, wrap_count),
    );

    for (label, r) in [("flat", &flat), ("padded", &padded)] {
        eprintln!(
            "bound self-scoped batch at the ceilings ({label}, m={m}, {} B): \
             install {} CPU ({}%), bind {} CPU ({}%), enforce {} CPU ({}%) / {} mem",
            r.bytes,
            r.install.cpu,
            pct(r.install.cpu, NET.cpu),
            r.bind.cpu,
            pct(r.bind.cpu, NET.cpu),
            r.enforce.cpu,
            pct(r.enforce.cpu, NET.cpu),
            r.enforce.mem,
        );
    }
    eprintln!("padded wrap: {wrap_count} conjuncts wrapped {wrap_depth} deep");
    for (label, r) in [("flat", flat), ("padded", padded)] {
        within(label, "install", r.install);
        within(label, "bind", r.bind);
        within(label, "enforce", r.enforce);
    }
}

/// OZ's reference multisig smart account, as deployed (committed bytes).
const OZ_ACCOUNT_WASM: &[u8] = include_bytes!("fixtures/multisig_account_example.wasm");

/// The footprint a real simulation of policy-synth's `buildInstall` returned (see the
/// header of the file): read-only keys, read-write keys and the unsigned envelope's size.
const FOOTPRINT: &str = include_str!("fixtures/install-footprint.txt");

fn recorded_footprint() -> (StdVec<x::LedgerKey>, StdVec<x::LedgerKey>, usize) {
    let key =
        |l: &str| <x::LedgerKey as x::ReadXdr>::from_xdr_base64(l, XdrLimits::none()).unwrap();
    let with = |tag: &str| {
        FOOTPRINT
            .lines()
            .filter_map(|l| l.strip_prefix(tag))
            .map(key)
            .collect::<StdVec<_>>()
    };
    let size = FOOTPRINT
        .lines()
        .find_map(|l| l.strip_prefix("size "))
        .unwrap()
        .parse()
        .unwrap();
    (with("ro "), with("rw "), size)
}

/// What a wallet adds around the install: passkey signers on the admin rule (each is a
/// signer key and a WebAuthn signature in the account's authorisation payload, and a
/// verifier contract in the footprint) and a fee bump over the whole transaction.
#[derive(Clone, Copy)]
struct Wallet {
    passkeys: u32,
    fee_bump: bool,
}

/// A real install transaction, built as `policy-synth`'s `buildSelfCall` builds it: the
/// account's `add_context_rule` (with the predicate inside the interpreter's install
/// params) as the host function, the account's own authorisation entry, which repeats the
/// same call - the predicate travels twice - with OZ's `AuthPayload` as its signature, the
/// `__check_auth` entry of the delegated signer, the footprint a real simulation returned
/// and the source account's signature; then the wallet's additions. Its size in bytes.
fn install_envelope(args: StdVec<ScVal>, account: ScAddress, wallet: Wallet) -> usize {
    let call = x::InvokeContractArgs {
        contract_address: account.clone(),
        function_name: "add_context_rule".try_into().unwrap(),
        args: args.try_into().unwrap(),
    };
    let g_account = |b: u8| {
        ScAddress::Account(x::AccountId(x::PublicKey::PublicKeyTypeEd25519(
            x::Uint256([b; 32]),
        )))
    };
    let signer = |kind: &str, who: ScAddress, key: Option<ScVal>| {
        let mut v = alloc::vec![sym(kind), ScVal::Address(who)];
        v.extend(key);
        tup(&v)
    };
    // `AuthPayload { context_rule_ids, signers }`: the source account's delegated signer
    // (empty signature: the transaction's own covers it) and each passkey's WebAuthn
    // signature (authenticator data, client data JSON and the ECDSA signature: ~400 B).
    let mut signers = alloc::vec![(
        signer("Delegated", g_account(1), None),
        ScVal::Bytes(ScBytes(StdVec::new().try_into().unwrap()))
    )];
    for i in 0..wallet.passkeys {
        let verifier = ScAddress::Contract(ContractId(Hash([0x70 + i as u8; 32])));
        let key = ScVal::Bytes(ScBytes(alloc::vec![4u8 + i as u8; 65].try_into().unwrap()));
        signers.push((
            signer("External", verifier, Some(key)),
            ScVal::Bytes(ScBytes(alloc::vec![9u8; 400].try_into().unwrap())),
        ));
    }
    let payload = map(&[
        (sym("context_rule_ids"), tup(&[ScVal::U32(0)])),
        (sym("signers"), map(&signers)),
    ]);
    let entry = |credentials, function| x::SorobanAuthorizationEntry {
        credentials,
        root_invocation: x::SorobanAuthorizedInvocation {
            function,
            sub_invocations: StdVec::new().try_into().unwrap(),
        },
    };
    let account_entry = entry(
        x::SorobanCredentials::Address(x::SorobanAddressCredentials {
            address: account.clone(),
            nonce: i64::MAX,
            signature_expiration_ledger: u32::MAX,
            signature: payload,
        }),
        x::SorobanAuthorizedFunction::ContractFn(call.clone()),
    );
    let check_auth = entry(
        x::SorobanCredentials::SourceAccount,
        x::SorobanAuthorizedFunction::ContractFn(x::InvokeContractArgs {
            contract_address: account,
            function_name: "__check_auth".try_into().unwrap(),
            args: alloc::vec![bytes(32)].try_into().unwrap(),
        }),
    );
    let (mut read_only, read_write, _) = recorded_footprint();
    // each distinct verifier contract is read: its instance and its code
    for i in 0..2 * wallet.passkeys.min(1) {
        read_only.push(read_only[i as usize].clone());
    }
    let tx = x::Transaction {
        source_account: x::MuxedAccount::Ed25519(x::Uint256([1; 32])),
        fee: u32::MAX,
        seq_num: x::SequenceNumber(i64::MAX),
        cond: x::Preconditions::None,
        memo: x::Memo::None,
        operations: alloc::vec![x::Operation {
            source_account: None,
            body: x::OperationBody::InvokeHostFunction(x::InvokeHostFunctionOp {
                host_function: x::HostFunction::InvokeContract(call),
                auth: alloc::vec![account_entry, check_auth].try_into().unwrap(),
            }),
        }]
        .try_into()
        .unwrap(),
        ext: x::TransactionExt::V1(x::SorobanTransactionData {
            ext: x::SorobanTransactionDataExt::V0,
            resources: x::SorobanResources {
                footprint: x::LedgerFootprint {
                    read_only: read_only.try_into().unwrap(),
                    read_write: read_write.try_into().unwrap(),
                },
                instructions: u32::MAX,
                disk_read_bytes: u32::MAX,
                write_bytes: u32::MAX,
            },
            resource_fee: i64::MAX,
        }),
    };
    let signature = || {
        alloc::vec![x::DecoratedSignature {
            hint: x::SignatureHint([0; 4]),
            signature: x::Signature(alloc::vec![0u8; 64].try_into().unwrap()),
        }]
        .try_into()
        .unwrap()
    };
    let inner = x::TransactionV1Envelope {
        tx,
        signatures: signature(),
    };
    let envelope = if wallet.fee_bump {
        x::TransactionEnvelope::TxFeeBump(x::FeeBumpTransactionEnvelope {
            tx: x::FeeBumpTransaction {
                fee_source: x::MuxedAccount::Ed25519(x::Uint256([2; 32])),
                fee: i64::MAX,
                inner_tx: x::FeeBumpTransactionInnerTx::Tx(inner),
                ext: x::FeeBumpTransactionExt::V0,
            },
            signatures: signature(),
        })
    } else {
        x::TransactionEnvelope::Tx(inner)
    };
    WriteXdr::to_xdr(&envelope, XdrLimits::none())
        .unwrap()
        .len()
}

/// The path a deployment takes: OpenZeppelin's real account adds the rule, with 15
/// operators and 16 policy admins (the most each allows), the interpreter's real
/// wasm installs the largest predicate the byte ceiling allows. The call, the stored
/// entry and the transaction around it, as a real wallet sends it, must fit the
/// network with the margin.
#[test]
fn the_largest_install_through_the_account_fits_a_transaction() {
    let Some(code) = the_wasm() else { return };
    let l = common::CEILING;
    let env = Env::new_with_config(EnvTestConfig {
        capture_snapshot_at_drop: false,
    });
    env.mock_all_auths();
    env.cost_estimate().disable_resource_limits();
    env.cost_estimate().budget().reset_unlimited();
    let interpreter = env.register(code.as_slice(), (l,));
    let owner = Address::generate(&env);
    let signers: SorobanVec<Val> =
        soroban_sdk::vec![&env, Signer::Delegated(owner.clone()).into_val(&env)];
    let account = env.register(
        OZ_ACCOUNT_WASM,
        (signers, soroban_sdk::Map::<Address, Val>::new(&env)),
    );
    let people = |n: u32| {
        (0..n)
            .map(|_| Signer::Delegated(Address::generate(&env)))
            .collect::<StdVec<_>>()
    };
    let admins = SorobanVec::from_slice(&env, &people(16));
    let operators: SorobanVec<Val> = SorobanVec::from_slice(
        &env,
        &people(15)
            .iter()
            .map(|s| s.into_val(&env))
            .collect::<StdVec<Val>>(),
    );
    let biggest = cases(&l).into_iter().next().unwrap();
    let predicate: Bytes = {
        let v: Val = biggest.rule.clone().into_val(&env);
        v.to_xdr(&env)
    };
    let hash: BytesN<32> = env.crypto().sha256(&predicate).into();
    let params = PolicyInstallParams {
        grammar_version: 7,
        install_nonce: 1,
        predicate: predicate.clone(),
        predicate_hash: hash,
        policy_admins: admins,
    };
    let mut policies = soroban_sdk::Map::<Address, Val>::new(&env);
    policies.set(interpreter.clone(), params.into_val(&env));
    let scope = policy_interpreter::ContextRuleType::CallContract(Address::generate(&env));
    let args: SorobanVec<Val> = soroban_sdk::vec![
        &env,
        scope.into_val(&env),
        soroban_sdk::String::from_str(&env, "agent-rule").into_val(&env),
        Option::<u32>::None.into_val(&env),
        operators.into_val(&env),
        policies.into_val(&env),
    ];
    let _: Val = env.invoke_contract(
        &account,
        &Symbol::new(&env, "add_context_rule"),
        args.clone(),
    );
    let u = used(&env);
    within("install through the account", "add_context_rule", u);
    let doc: policy_interpreter::StoredDoc = env
        .as_contract(&interpreter, || {
            env.storage().persistent().get(&(account.clone(), 1u32))
        })
        .expect("stored");
    let _ = doc;
    let scvals: StdVec<ScVal> = args
        .iter()
        .map(|a| ScVal::from_xdr(&env, &a.to_xdr(&env)).unwrap())
        .collect();
    let to_sc = |a: &Address| {
        let v: Val = a.into_val(&env);
        ScVal::from_xdr(&env, &v.to_xdr(&env)).unwrap()
    };
    let ScVal::Address(account_sc) = to_sc(&account) else {
        panic!()
    };
    // The model must be the real thing: the plain wallet's envelope (the recorded one
    // is unsigned: one 76-byte signature apart) within 1% of what a real simulation built.
    let (_, _, recorded) = recorded_footprint();
    let plain = Wallet {
        passkeys: 0,
        fee_bump: false,
    };
    let modelled = install_envelope(scvals.clone(), account_sc.clone(), plain) - 76;
    assert!(
        modelled.abs_diff(recorded) * 100 <= recorded,
        "the modelled envelope is {modelled} B, a real one was {recorded} B"
    );
    // The worst a wallet adds: three passkeys on the admin rule and a fee bump.
    let wallets = [
        ("plain wallet", plain),
        (
            "fee bump",
            Wallet {
                passkeys: 0,
                fee_bump: true,
            },
        ),
        (
            "1 passkey",
            Wallet {
                passkeys: 1,
                fee_bump: false,
            },
        ),
        (
            "3 passkeys + fee bump",
            Wallet {
                passkeys: 3,
                fee_bump: true,
            },
        ),
    ];
    for (what, w) in wallets {
        let size = install_envelope(scvals.clone(), account_sc.clone(), w) as u64;
        eprintln!(
            "install through the account ({what}): predicate {} B, {} CPU ({}%), {} bytes memory, write {} entries / {} B, tx {} B ({}% of {})",
            predicate.len(),
            u.cpu,
            pct(u.cpu, NET.cpu),
            u.mem,
            u.write_entries,
            u.write_bytes,
            size,
            pct(size, NET.tx_bytes),
            NET.tx_bytes
        );
        assert!(
            size * 100 <= NET.tx_bytes * MARGIN,
            "{what}: the install transaction is {size} bytes of {} (at most {MARGIN}%)",
            NET.tx_bytes
        );
    }
}

/// `Signer::Delegated(addr)` in the account's own encoding.
fn delegated(env: &Env, addr: &Address) -> Val {
    let mut v: SorobanVec<Val> = SorobanVec::new(env);
    v.push_back(Symbol::new(env, "Delegated").into_val(env));
    v.push_back(addr.to_val());
    v.into_val(env)
}

/// The `max_reads` contracts a rule reads are REAL wasm contracts, each its own instance
/// with its own VM when read (a Stellar asset contract, as in `check_all`, is built in
/// and has none), and `contexts` of them are authorised by ONE `__check_auth` of the
/// real OZ account, so they share one transaction's budget. What that call used.
fn authorise_contexts(code: &[u8], contexts: u32) -> Used {
    let l = common::CEILING;
    let env = Env::new_with_config(EnvTestConfig {
        capture_snapshot_at_drop: false,
    });
    env.mock_all_auths_allowing_non_root_auth();
    env.cost_estimate().disable_resource_limits();
    env.cost_estimate().budget().reset_unlimited();
    let interpreter = env.register(code, (l,));
    let owner = Address::generate(&env);
    let signers: SorobanVec<Val> = soroban_sdk::vec![&env, delegated(&env, &owner)];
    let account = env.register(
        OZ_ACCOUNT_WASM,
        (signers.clone(), soroban_sdk::Map::<Address, Val>::new(&env)),
    );
    let as_scval = |a: &Address| {
        let v: Val = a.into_val(&env);
        ScVal::from_xdr(&env, &v.to_xdr(&env)).unwrap()
    };
    // gte(read(target n, grammar_version), 1) for each of max_reads interpreters (62 KB
    // of wasm each), beside the pin.
    let mut rule = alloc::vec![advance()];
    let mut targets = StdVec::new();
    for n in 0..l.max_reads {
        let target = env.register(code, (common::DEFAULT,));
        targets.push((placeholder(1_000 + n), as_scval(&target)));
        rule.push(cmp(
            "gte",
            tup(&[
                sym("read"),
                placeholder(1_000 + n),
                sym("grammar_version"),
                tup(&[]),
            ]),
            num(1),
        ));
    }
    let mut rule = and(&rule);
    for (from, to) in &targets {
        rule = swap(&rule, from, to);
    }
    let predicate: Bytes = {
        let v: Val = rule.into_val(&env);
        v.to_xdr(&env)
    };
    let params = PolicyInstallParams {
        grammar_version: 7,
        install_nonce: 1,
        predicate_hash: env.crypto().sha256(&predicate).into(),
        predicate,
        policy_admins: soroban_sdk::vec![&env, Signer::Delegated(owner.clone())],
    };
    let mut policies = soroban_sdk::Map::<Address, Val>::new(&env);
    policies.set(interpreter, params.into_val(&env));
    let venue = Address::generate(&env);
    let scope = policy_interpreter::ContextRuleType::CallContract(venue.clone());
    let args: SorobanVec<Val> = soroban_sdk::vec![
        &env,
        scope.into_val(&env),
        soroban_sdk::String::from_str(&env, "reads").into_val(&env),
        Option::<u32>::None.into_val(&env),
        signers.into_val(&env),
        policies.into_val(&env),
    ];
    let _: Val = env.invoke_contract(&account, &Symbol::new(&env, "add_context_rule"), args);
    // `AuthPayload { context_rule_ids: [1; contexts], signers: {Delegated(owner): ""} }`
    let mut who: soroban_sdk::Map<Val, Bytes> = soroban_sdk::Map::new(&env);
    who.set(delegated(&env, &owner), Bytes::new(&env));
    let mut payload: soroban_sdk::Map<Symbol, Val> = soroban_sdk::Map::new(&env);
    payload.set(
        Symbol::new(&env, "context_rule_ids"),
        SorobanVec::from_slice(&env, &alloc::vec![1u32; contexts as usize]).into_val(&env),
    );
    payload.set(Symbol::new(&env, "signers"), who.into_val(&env));
    let one = Context::Contract(ContractContext {
        contract: venue,
        fn_name: Symbol::new(&env, "advance"),
        args: SorobanVec::new(&env),
    });
    let all = SorobanVec::from_slice(&env, &alloc::vec![one; contexts as usize]);
    env.cost_estimate().budget().reset_unlimited();
    env.try_invoke_contract_check_auth::<soroban_sdk::Error>(
        &account,
        &BytesN::from_array(&env, &[7u8; 32]),
        payload.into_val(&env),
        &all,
    )
    .expect("every context is permitted");
    used(&env)
}

/// How many of these contexts one transaction can hold WITH the 20% margin, and how many
/// at all: the numbers the README states.
const CONTEXTS_WITH_MARGIN: u32 = 2;
const CONTEXTS_AT_ALL: u32 = 3;

/// `max_reads` reads of real wasm contracts in one rule, authorised in several contexts of
/// one transaction: each context's reads run again (the memo is per `enforce`) and each
/// read of a wasm contract holds its VM, so memory, not CPU, bounds how many contexts fit.
#[test]
fn eight_reads_of_wasm_contracts_fit_a_budgeted_number_of_contexts_per_transaction() {
    let Some(code) = the_wasm() else { return };
    let (mut with_margin, mut at_all) = (0, 0);
    for n in 1..=CONTEXTS_AT_ALL + 1 {
        let u = authorise_contexts(&code, n);
        eprintln!(
            "{n} context(s) x {} wasm reads: {} CPU ({}%), {} bytes memory ({}%)",
            common::CEILING.max_reads,
            u.cpu,
            pct(u.cpu, NET.cpu),
            u.mem,
            pct(u.mem, NET.mem)
        );
        if u.cpu <= NET.cpu && u.mem <= NET.mem {
            at_all = n;
        }
        if u.cpu * 100 <= NET.cpu * MARGIN && u.mem * 100 <= NET.mem * MARGIN {
            with_margin = n;
        }
    }
    assert_eq!(
        (with_margin, at_all),
        (CONTEXTS_WITH_MARGIN, CONTEXTS_AT_ALL),
        "the README's context budget is out of date"
    );
}
