//! Grammar 7 end to end: `read`, `now` and `scaled`, through the real `install`
//! and `enforce` entry points, against mock oracle / token / pool contracts.
//!
//! The four PayFi checks each get a permitting and a refusing case, then the
//! safety properties that make a cross-contract read tolerable: the caps, the
//! literal-only arguments, the fail-closed paths, and re-entry.

extern crate alloc;

use alloc::vec::Vec as StdVec;

use policy_interpreter::{
    ContextRule, ContextRuleType, PolicyError, PolicyInstallParams, PolicyInterpreter,
    PolicyInterpreterClient, Signer,
};
use soroban_sdk::auth::{Context, ContractContext};
use soroban_sdk::testutils::{Address as _, Ledger as _};
use soroban_sdk::xdr::{FromXdr as _, ScVal, ToXdr, VecM};
use soroban_sdk::{
    contract, contractimpl, contracttype, Address, Bytes, BytesN, Env, IntoVal, Symbol, Val,
    Vec as SorobanVec,
};

// ---- mock contracts --------------------------------------------------------

#[contracttype]
#[derive(Clone)]
pub struct PriceData {
    pub price: i128,
    pub timestamp: u64,
}

/// A price oracle shaped like Reflector's `lastprice`: a struct, or void for an
/// asset it does not know.
#[contract]
pub struct Oracle;

#[contractimpl]
impl Oracle {
    pub fn __constructor(e: &Env, price: i128, timestamp: u64) {
        e.storage()
            .instance()
            .set(&0u32, &PriceData { price, timestamp });
    }

    pub fn lastprice(e: &Env, asset: Symbol) -> Option<PriceData> {
        if asset == Symbol::new(e, "POT") {
            e.storage().instance().get(&0u32)
        } else {
            None
        }
    }

    /// Not a number.
    pub fn name(e: &Env) -> Symbol {
        Symbol::new(e, "oracle")
    }

    pub fn boom(_e: &Env) -> i128 {
        panic!("oracle is down")
    }
}

/// Reflector's asset key: `Stellar(contract)` or `Other(symbol)`. A Soroban enum
/// is the vec `[name, payload...]` on the wire.
#[contracttype]
#[derive(Clone, PartialEq)]
pub enum Asset {
    Stellar(Address),
    Other(Symbol),
}

/// The exact Reflector price-feed signature: `lastprice(asset: Asset) ->
/// Option<PriceData>`. It answers for the one asset it was built with and
/// returns `None` (void on the wire) for any other.
#[contract]
pub struct Reflector;

#[contractimpl]
impl Reflector {
    pub fn __constructor(e: &Env, asset: Asset, price: i128, timestamp: u64) {
        e.storage().instance().set(&0u32, &asset);
        e.storage()
            .instance()
            .set(&1u32, &PriceData { price, timestamp });
    }

    /// How many times `lastprice` has run (a committed counter, so it is only
    /// visible after a permit).
    pub fn calls(e: &Env) -> u32 {
        e.storage().instance().get(&2u32).unwrap_or(0)
    }

    pub fn lastprice(e: &Env, asset: Asset) -> Option<PriceData> {
        e.storage()
            .instance()
            .set(&2u32, &(Reflector::calls(e) + 1));
        let known: Asset = e.storage().instance().get(&0u32).unwrap();
        if asset == known {
            e.storage().instance().get(&1u32)
        } else {
            None
        }
    }
}

/// A token with one balance, enough for the first-loss check.
#[contract]
pub struct Token;

#[contractimpl]
impl Token {
    pub fn __constructor(e: &Env, holder: Address, balance: i128) {
        e.storage().instance().set(&holder, &balance);
    }

    pub fn balance(e: &Env, id: Address) -> i128 {
        e.storage().instance().get(&id).unwrap_or(0)
    }
}

/// The lending pool the policy guards: it reports its own debt and collateral.
#[contract]
pub struct Pool;

#[contractimpl]
impl Pool {
    pub fn __constructor(e: &Env, debt: i128, collateral: i128) {
        e.storage().instance().set(&0u32, &debt);
        e.storage().instance().set(&1u32, &collateral);
    }

    pub fn debt(e: &Env) -> i128 {
        e.storage().instance().get(&0u32).unwrap()
    }

    pub fn collateral(e: &Env) -> i128 {
        e.storage().instance().get(&1u32).unwrap()
    }
}

/// A contract that calls `enforce` from inside its own frame, so it is on the
/// call stack while the policy runs - the position an authorised call's target
/// is in when the host asks the account to authorise it.
#[contract]
pub struct Caller;

#[contractimpl]
impl Caller {
    pub fn go(e: &Env, policy: Address, context: Context, rule: ContextRule, account: Address) {
        let signers = rule.signers.clone();
        PolicyInterpreterClient::new(e, &policy).enforce(&context, &signers, &rule, &account);
    }

    pub fn peek(_e: &Env) -> i128 {
        1
    }
}

// ---- predicate builders ----------------------------------------------------

fn sym(s: &str) -> ScVal {
    ScVal::Symbol(soroban_sdk::xdr::ScSymbol(
        s.as_bytes().to_vec().try_into().unwrap(),
    ))
}

fn tuple(items: StdVec<ScVal>) -> ScVal {
    let v: VecM<ScVal> = items.try_into().expect("vec");
    ScVal::Vec(Some(soroban_sdk::xdr::ScVec(v)))
}

fn num(v: i128) -> ScVal {
    ScVal::I128(soroban_sdk::xdr::Int128Parts {
        hi: (v >> 64) as i64,
        lo: (v as u128 & u128::from(u64::MAX)) as u64,
    })
}

fn addr(env: &Env, a: &Address) -> ScVal {
    let v: Val = a.into_val(env);
    ScVal::from_xdr(env, &v.to_xdr(env)).unwrap()
}

/// A path step: an index, a field, or the length.
enum Step {
    I(u32),
    F(&'static str),
    Len,
}

fn steps(path: &[Step]) -> StdVec<ScVal> {
    path.iter()
        .map(|s| match s {
            Step::I(i) => ScVal::U32(*i),
            Step::F(f) => sym(f),
            Step::Len => ScVal::Bool(true),
        })
        .collect()
}

fn call_arg(i: u32) -> ScVal {
    tuple(alloc::vec![sym("call_arg"), ScVal::U32(i)])
}

fn call_path(path: &[Step]) -> ScVal {
    let mut items = alloc::vec![sym("call_path")];
    items.extend(steps(path));
    tuple(items)
}

fn call_fn() -> ScVal {
    tuple(alloc::vec![sym("call_fn")])
}

fn now() -> ScVal {
    tuple(alloc::vec![sym("now")])
}

fn read(env: &Env, target: &Address, func: &str, args: StdVec<ScVal>, path: &[Step]) -> ScVal {
    let mut items = alloc::vec![sym("read"), addr(env, target), sym(func), tuple(args)];
    items.extend(steps(path));
    tuple(items)
}

fn scaled(src: ScVal, n: ScVal, den: i128, add: ScVal) -> ScVal {
    tuple(alloc::vec![sym("scaled"), src, n, num(den), add])
}

fn cmp(op: &str, a: ScVal, b: ScVal) -> ScVal {
    tuple(alloc::vec![sym(op), a, b])
}

fn all(children: StdVec<ScVal>) -> ScVal {
    tuple(alloc::vec![sym("and"), tuple(children)])
}

/// `eq(call_fn, "advance")` - the selector leaf every rule here needs, since a
/// rule made of reads alone is refused at install.
fn is_advance() -> ScVal {
    cmp("eq", call_fn(), sym("advance"))
}

/// The one rule: `advance` AND the check under test.
fn rule_for(check: ScVal) -> ScVal {
    all(alloc::vec![is_advance(), check])
}

// ---- harness ---------------------------------------------------------------

struct World {
    env: Env,
    policy: Address,
    account: Address,
    rule: ContextRule,
    target: Address,
}

impl World {
    fn new() -> Self {
        let env = Env::default();
        // `enforce` is called from inside another contract in the re-entry
        // tests, so its `require_auth` is not a root-level one.
        env.mock_all_auths_allowing_non_root_auth();
        let policy = env.register(PolicyInterpreter, ());
        let account = Address::generate(&env);
        let signers = soroban_sdk::vec![&env, Signer::Delegated(account.clone())];
        let target = Address::generate(&env);
        let rule = ContextRule {
            id: 1,
            context_type: ContextRuleType::CallContract(target.clone()),
            name: soroban_sdk::String::from_str(&env, "rule"),
            signers,
            signer_ids: SorobanVec::new(&env),
            policies: SorobanVec::new(&env),
            policy_ids: SorobanVec::new(&env),
            valid_until: None,
        };
        World {
            env,
            policy,
            account,
            rule,
            target,
        }
    }

    fn client(&self) -> PolicyInterpreterClient<'_> {
        PolicyInterpreterClient::new(&self.env, &self.policy)
    }

    /// Install `predicate`, returning the contract error code if refused.
    fn install(&self, predicate: &ScVal) -> Result<(), u32> {
        let val: Val = predicate.into_val(&self.env);
        let bytes: Bytes = val.to_xdr(&self.env);
        let hash: BytesN<32> = self.env.crypto().sha256(&bytes).into();
        let params = PolicyInstallParams {
            grammar_version: 7,
            install_nonce: 1,
            predicate: bytes,
            predicate_hash: hash,
            policy_admins: self.rule.signers.clone(),
        };
        match self
            .client()
            .try_install(&params, &self.rule, &self.account)
        {
            Ok(_) => Ok(()),
            Err(Ok(e)) => Err(e.get_code()),
            Err(Err(e)) => panic!("install trapped: {e:?}"),
        }
    }

    fn context(&self, args: &[i128]) -> Context {
        let mut v = SorobanVec::<Val>::new(&self.env);
        for a in args {
            v.push_back((*a).into_val(&self.env));
        }
        Context::Contract(ContractContext {
            contract: self.target.clone(),
            fn_name: Symbol::new(&self.env, "advance"),
            args: v,
        })
    }

    /// Run `enforce` on an authorised `advance(args)`.
    fn enforce(&self, args: &[i128]) -> Verdict {
        self.enforce_context(&self.context(args))
    }

    fn enforce_context(&self, context: &Context) -> Verdict {
        match self
            .client()
            .try_enforce(context, &self.rule.signers, &self.rule, &self.account)
        {
            Ok(_) => Ok(()),
            Err(Ok(e)) => Err(Some(e)),
            Err(Err(_)) => Err(None),
        }
    }

    /// Install a rule that must be accepted.
    fn arm(&self, check: ScVal) {
        self.install(&rule_for(check)).expect("rule installs");
    }
}

fn oracle(w: &World, price: i128, timestamp: u64) -> Address {
    w.env.register(Oracle, (price, timestamp))
}

fn pot() -> StdVec<ScVal> {
    alloc::vec![sym("POT")]
}

/// What `enforce` did: `Ok(())` permit, `Err(Some(e))` a contract error,
/// `Err(None)` a host trap.
type Verdict = Result<(), Option<soroban_sdk::Error>>;

fn refused(e: PolicyError) -> Verdict {
    Err(Some(soroban_sdk::Error::from_contract_error(e as u32)))
}

fn denied() -> Verdict {
    refused(PolicyError::ArgMismatch)
}

// ---- PayFi 1: price floor --------------------------------------------------

fn price_floor(w: &World, oracle: &Address, p_min: i128) -> ScVal {
    cmp(
        "gte",
        read(&w.env, oracle, "lastprice", pot(), &[Step::F("price")]),
        num(p_min),
    )
}

#[test]
fn price_floor_permits_at_or_above_the_floor() {
    let w = World::new();
    let o = oracle(&w, 100, 0);
    w.arm(price_floor(&w, &o, 100));
    assert_eq!(w.enforce(&[]), Ok(()));
}

#[test]
fn price_floor_refuses_below_the_floor() {
    let w = World::new();
    let o = oracle(&w, 99, 0);
    w.arm(price_floor(&w, &o, 100));
    assert_eq!(w.enforce(&[]), denied());
}

// ---- PayFi 2: exact live-price LTV after the advance -----------------------

/// `debt + B <= 92% * price * (coll + P)`, with debt, coll and price read and
/// B, P taken from the call: `advance(B, P, T)`.
fn ltv(w: &World, pool: &Address, oracle: &Address) -> ScVal {
    let debt = read(&w.env, pool, "debt", alloc::vec![], &[]);
    let coll = read(&w.env, pool, "collateral", alloc::vec![], &[]);
    let price = read(&w.env, oracle, "lastprice", pot(), &[Step::F("price")]);
    let after_advance = scaled(debt, num(1), 1, call_arg(0)); // debt + B
    let pledged = scaled(coll, num(1), 1, call_arg(1)); // coll + P
    let ninety_two = scaled(pledged, num(92), 1, num(0)); // 92 * (coll + P)
    cmp(
        "lte",
        after_advance,
        scaled(price, ninety_two, 100, num(0)), // price * 92 * (coll + P) / 100
    )
}

fn ltv_world(price: i128) -> (World, Address, Address) {
    let w = World::new();
    let pool = w.env.register(Pool, (900i128, 600i128));
    let o = oracle(&w, price, 0);
    (w, pool, o)
}

#[test]
fn ltv_permits_when_the_advance_stays_within_92_percent() {
    // price 2: capacity 0.92 * 2 * 600 = 1104; debt 900 + B 100 = 1000.
    let (w, pool, o) = ltv_world(2);
    w.arm(ltv(&w, &pool, &o));
    assert_eq!(w.enforce(&[100, 0, 0]), Ok(()));
    // exactly at the bound: 900 + 204 = 1104.
    assert_eq!(w.enforce(&[204, 0, 0]), Ok(()));
}

#[test]
fn ltv_counts_collateral_pledged_in_the_same_call() {
    // B = 300 breaks the bound on its own (1200 > 1104) but pledging P = 100
    // lifts capacity to 0.92 * 2 * 700 = 1288.
    let (w, pool, o) = ltv_world(2);
    w.arm(ltv(&w, &pool, &o));
    assert_eq!(w.enforce(&[300, 0, 0]), denied());
    assert_eq!(w.enforce(&[300, 100, 0]), Ok(()));
}

#[test]
fn ltv_refuses_one_over_the_bound() {
    let (w, pool, o) = ltv_world(2);
    w.arm(ltv(&w, &pool, &o));
    assert_eq!(w.enforce(&[205, 0, 0]), denied());
}

#[test]
fn ltv_follows_the_live_price() {
    // The same advance that passed at price 2 is refused once the oracle says 1:
    // capacity 0.92 * 1 * 600 = 552 < 1000.
    let (w, pool, o) = ltv_world(1);
    w.arm(ltv(&w, &pool, &o));
    assert_eq!(w.enforce(&[100, 0, 0]), denied());
}

// ---- PayFi 3: first-loss floor ---------------------------------------------

fn first_loss(w: &World, tusd: &Address, custody: &Address, float: i128) -> ScVal {
    cmp(
        "gte",
        read(
            &w.env,
            tusd,
            "balance",
            alloc::vec![addr(&w.env, custody)],
            &[],
        ),
        scaled(call_arg(2), num(1), 1, num(float)), // FLOAT + T
    )
}

fn first_loss_world(balance: i128) -> (World, Address, Address) {
    let w = World::new();
    let custody = Address::generate(&w.env);
    let tusd = w.env.register(Token, (custody.clone(), balance));
    (w, tusd, custody)
}

#[test]
fn first_loss_permits_when_custody_holds_the_float_plus_the_top_up() {
    let (w, tusd, custody) = first_loss_world(1_050);
    w.arm(first_loss(&w, &tusd, &custody, 1_000));
    assert_eq!(w.enforce(&[0, 0, 50]), Ok(()));
}

#[test]
fn first_loss_refuses_when_the_top_up_would_dip_into_the_float() {
    let (w, tusd, custody) = first_loss_world(1_050);
    w.arm(first_loss(&w, &tusd, &custody, 1_000));
    assert_eq!(w.enforce(&[0, 0, 51]), denied());
}

#[test]
fn first_loss_reads_the_balance_of_the_address_named_in_the_predicate() {
    // A different holder has nothing, so the same rule refuses.
    let (w, tusd, _) = first_loss_world(1_050);
    let stranger = Address::generate(&w.env);
    w.arm(first_loss(&w, &tusd, &stranger, 0));
    assert_eq!(w.enforce(&[0, 0, 1]), denied());
}

// ---- PayFi 4: freshness ----------------------------------------------------

fn fresh(w: &World, oracle: &Address) -> ScVal {
    cmp(
        "gte",
        read(&w.env, oracle, "lastprice", pot(), &[Step::F("timestamp")]),
        scaled(now(), num(1), 1, num(-300)), // now - 300
    )
}

#[test]
fn freshness_permits_a_price_inside_the_window() {
    let w = World::new();
    w.env.ledger().with_mut(|l| l.timestamp = 10_000);
    let o = oracle(&w, 1, 9_700); // exactly 300 old
    w.arm(fresh(&w, &o));
    assert_eq!(w.enforce(&[]), Ok(()));
}

#[test]
fn freshness_refuses_a_stale_price() {
    let w = World::new();
    w.env.ledger().with_mut(|l| l.timestamp = 10_000);
    let o = oracle(&w, 1, 9_699); // 301 old
    w.arm(fresh(&w, &o));
    assert_eq!(w.enforce(&[]), denied());
}

#[test]
fn freshness_tracks_the_ledger_clock() {
    let w = World::new();
    let o = oracle(&w, 1, 9_700);
    w.env.ledger().with_mut(|l| l.timestamp = 10_000);
    w.arm(fresh(&w, &o));
    assert_eq!(w.enforce(&[]), Ok(()));
    w.env.ledger().with_mut(|l| l.timestamp = 10_001);
    assert_eq!(w.enforce(&[]), denied());
}

// ---- safety: arithmetic ----------------------------------------------------

#[test]
fn overflow_denies_with_its_own_reason() {
    let w = World::new();
    // args[0] * args[1] / 1 + 0 >= 0
    w.arm(cmp(
        "gte",
        scaled(call_arg(0), call_arg(1), 1, num(0)),
        num(0),
    ));
    assert_eq!(w.enforce(&[2, 3]), Ok(()));
    let overflow = || refused(PolicyError::ArithmeticOverflow);
    assert_eq!(w.enforce(&[i128::MAX, 2]), overflow(), "mul overflows");
    assert_eq!(w.enforce(&[i128::MIN, -1]), overflow(), "mul overflows");
}

#[test]
fn an_overflowing_add_denies_rather_than_wrapping() {
    let w = World::new();
    w.arm(cmp(
        "gte",
        scaled(call_arg(0), num(1), 1, call_arg(1)),
        num(0),
    ));
    assert_eq!(
        w.enforce(&[i128::MAX, 1]),
        refused(PolicyError::ArithmeticOverflow)
    );
    assert_eq!(
        w.enforce(&[i128::MIN, -1]),
        refused(PolicyError::ArithmeticOverflow)
    );
}

#[test]
fn scaled_multiplies_first_then_truncates_toward_zero_then_adds() {
    // (7 * 3 / 2) + 10 = 10 + 10 = 20; dividing first would give 9 + 10 = 19.
    let w = World::new();
    w.arm(cmp(
        "eq",
        scaled(call_arg(0), num(3), 2, num(10)),
        call_arg(1),
    ));
    assert_eq!(w.enforce(&[7, 20]), Ok(()));
    assert_eq!(w.enforce(&[7, 19]), denied());
    // toward zero: -7 * 3 / 2 = -10 (floor would be -11), plus 10 is 0.
    assert_eq!(w.enforce(&[-7, 0]), Ok(()));
    assert_eq!(w.enforce(&[-7, -1]), denied());
}

#[test]
fn nesting_gives_products_and_powers() {
    // x^3 = scaled(x, scaled(x, x, 1, 0), 1, 0)
    let w = World::new();
    let cube = scaled(
        call_arg(0),
        scaled(call_arg(0), call_arg(0), 1, num(0)),
        1,
        num(0),
    );
    w.arm(cmp("eq", cube, call_arg(1)));
    assert_eq!(w.enforce(&[5, 125]), Ok(()));
    assert_eq!(w.enforce(&[5, 124]), denied());
}

#[test]
fn a_non_numeric_operand_denies() {
    let w = World::new();
    // `call_fn` is a symbol, not a number.
    w.arm(cmp("gte", scaled(call_fn(), num(1), 1, num(0)), num(0)));
    assert_eq!(w.enforce(&[]), denied());
}

// ---- safety: install-time refusals -----------------------------------------

const MALFORMED: Result<(), u32> = Err(PolicyError::MalformedPredicate as u32);
const SELECTOR_REQUIRED: Result<(), u32> = Err(PolicyError::SelectorLeafRequired as u32);

#[test]
fn a_non_positive_denominator_is_refused_at_install() {
    let w = World::new();
    for den in [0, -1] {
        let r = rule_for(cmp("gte", scaled(call_arg(0), num(1), den, num(0)), num(0)));
        assert_eq!(w.install(&r), MALFORMED, "den = {den}");
    }
}

#[test]
fn up_to_four_reads_install_and_a_fifth_is_refused() {
    let w = World::new();
    let o = oracle(&w, 1, 0);
    let r = |n: usize| {
        let reads = (0..n)
            .map(|i| {
                let asset = alloc::vec![sym(&alloc::format!("A{i}"))];
                let r = read(&w.env, &o, "lastprice", asset, &[Step::F("price")]);
                cmp("gte", r, num(0))
            })
            .collect();
        rule_for(all(reads))
    };
    assert_eq!(w.install(&r(4)), Ok(()));
    assert_eq!(w.install(&r(5)), MALFORMED);
}

#[test]
fn reads_nested_in_scaled_count_toward_the_cap() {
    // Reads folded into one expression are still reads: four install, five do not.
    let w = World::new();
    let o = oracle(&w, 1, 0);
    let rd = |i: u32| {
        let asset = alloc::vec![sym(&alloc::format!("A{i}"))];
        read(&w.env, &o, "lastprice", asset, &[Step::F("price")])
    };
    let four = scaled(rd(0), scaled(rd(1), rd(2), 1, num(0)), 1, rd(3));
    assert_eq!(w.install(&rule_for(cmp("gte", four, num(0)))), Ok(()));
    let w = World::new();
    let o = oracle(&w, 1, 0);
    let rd = |i: u32| {
        let asset = alloc::vec![sym(&alloc::format!("A{i}"))];
        read(&w.env, &o, "lastprice", asset, &[Step::F("price")])
    };
    let five = scaled(rd(0), scaled(rd(1), rd(2), 1, rd(3)), 1, rd(4));
    assert_eq!(w.install(&rule_for(cmp("gte", five, num(0)))), MALFORMED);
}

#[test]
fn read_arguments_must_be_literals() {
    let w = World::new();
    let o = oracle(&w, 1, 0);
    let target = |args: StdVec<ScVal>| {
        rule_for(cmp(
            "gte",
            read(&w.env, &o, "lastprice", args, &[Step::F("price")]),
            num(0),
        ))
    };
    assert_eq!(w.install(&target(alloc::vec![sym("POT")])), Ok(()));
    // a selector, the clock, a computed value, and a nested read
    let nested = read(&w.env, &o, "lastprice", alloc::vec![sym("POT")], &[]);
    let computed = scaled(num(1), num(1), 1, num(0));
    for bad in [call_arg(0), now(), computed, nested] {
        assert_eq!(w.install(&target(alloc::vec![bad])), MALFORMED);
    }
}

#[test]
fn the_read_target_and_function_must_be_literals() {
    let w = World::new();
    // contract position holds a selector, not an address
    let r = tuple(alloc::vec![
        sym("read"),
        call_arg(0),
        sym("lastprice"),
        tuple(alloc::vec![])
    ]);
    assert_eq!(w.install(&rule_for(cmp("gte", r, num(0)))), MALFORMED);
    // function position holds a selector, not a symbol
    let o = oracle(&w, 1, 0);
    let r = tuple(alloc::vec![
        sym("read"),
        addr(&w.env, &o),
        call_arg(0),
        tuple(alloc::vec![])
    ]);
    assert_eq!(w.install(&rule_for(cmp("gte", r, num(0)))), MALFORMED);
}

#[test]
fn a_read_path_is_capped_at_eight_steps() {
    let w = World::new();
    let o = oracle(&w, 1, 0);
    let path = |n: usize| (0..n).map(|_| Step::I(0)).collect::<StdVec<_>>();
    let rd = |n| {
        rule_for(cmp(
            "gte",
            read(&w.env, &o, "lastprice", pot(), &path(n)),
            num(0),
        ))
    };
    assert_eq!(w.install(&rd(8)), Ok(()));
    let w = World::new();
    let o = oracle(&w, 1, 0);
    let rd = rule_for(cmp(
        "gte",
        read(&w.env, &o, "lastprice", pot(), &path(9)),
        num(0),
    ));
    assert_eq!(w.install(&rd), MALFORMED);
}

#[test]
fn scaled_nesting_is_capped() {
    // `n` scaled leaves nested inside each other put the innermost literals at
    // depth n + 1, and a leaf deeper than 5 is refused.
    let nest = |n: usize| {
        let mut leaf = num(1);
        for _ in 0..n {
            leaf = scaled(leaf, num(1), 1, num(0));
        }
        rule_for(cmp("gte", call_arg(0), leaf))
    };
    assert_eq!(World::new().install(&nest(4)), Ok(()));
    assert_eq!(World::new().install(&nest(5)), MALFORMED);
}

#[test]
fn a_rule_of_reads_and_the_clock_alone_is_refused() {
    // It would say nothing about the call it authorises.
    let w = World::new();
    let o = oracle(&w, 1, 0);
    let reads_only = cmp(
        "gte",
        read(&w.env, &o, "lastprice", pot(), &[Step::F("price")]),
        num(0),
    );
    assert_eq!(w.install(&reads_only), SELECTOR_REQUIRED);
    let clock_only = cmp("gte", now(), num(0));
    assert_eq!(w.install(&clock_only), SELECTOR_REQUIRED);
    // ... including when dressed up in `scaled`.
    let dressed = cmp("gte", scaled(now(), num(1), 1, num(0)), num(0));
    assert_eq!(w.install(&dressed), SELECTOR_REQUIRED);
    // The same read beside a real selector installs.
    assert_eq!(w.install(&rule_for(reads_only)), Ok(()));
}

#[test]
fn a_selector_inside_scaled_still_counts_as_one() {
    let w = World::new();
    assert_eq!(
        w.install(&cmp("gte", scaled(call_arg(0), num(1), 1, num(0)), num(0))),
        Ok(())
    );
}

#[test]
fn a_grammar_6_scaled_leaf_no_longer_decodes() {
    let w = World::new();
    let old = tuple(alloc::vec![
        sym("call_arg_scaled"),
        ScVal::U32(0),
        num(99),
        num(100)
    ]);
    assert_eq!(w.install(&cmp("gte", call_arg(1), old)), MALFORMED);
}

// ---- safety: reads that cannot produce a number ----------------------------

#[test]
fn a_void_result_denies() {
    // The oracle answers void for an asset it does not know.
    let w = World::new();
    let o = oracle(&w, 100, 0);
    let unknown = cmp(
        "gte",
        read(
            &w.env,
            &o,
            "lastprice",
            alloc::vec![sym("NOPE")],
            &[Step::F("price")],
        ),
        num(0),
    );
    w.arm(unknown);
    assert_eq!(w.enforce(&[]), denied());
}

#[test]
fn a_void_result_denies_even_under_eq() {
    // Two voids are "equal"; the read must not resolve at all.
    let w = World::new();
    let o = oracle(&w, 100, 0);
    let rd = || read(&w.env, &o, "lastprice", alloc::vec![sym("NOPE")], &[]);
    w.arm(cmp("eq", rd(), rd()));
    assert_eq!(w.enforce(&[]), denied());
}

#[test]
fn a_non_numeric_result_denies_even_under_eq() {
    let w = World::new();
    let o = oracle(&w, 100, 0);
    let rd = || read(&w.env, &o, "name", alloc::vec![], &[]);
    w.arm(cmp("eq", rd(), rd()));
    assert_eq!(w.enforce(&[]), denied());
}

#[test]
fn a_missing_field_denies() {
    let w = World::new();
    let o = oracle(&w, 100, 0);
    w.arm(cmp(
        "gte",
        read(&w.env, &o, "lastprice", pot(), &[Step::F("volume")]),
        num(0),
    ));
    assert_eq!(w.enforce(&[]), denied());
}

#[test]
fn a_read_that_panics_denies() {
    let w = World::new();
    let o = oracle(&w, 100, 0);
    w.arm(cmp(
        "gte",
        read(&w.env, &o, "boom", alloc::vec![], &[]),
        num(0),
    ));
    assert_eq!(
        w.enforce(&[]),
        denied(),
        "a panicking read denies as an unresolved operand, it does not trap"
    );
}

#[test]
fn a_read_of_a_missing_function_denies() {
    let w = World::new();
    let o = oracle(&w, 100, 0);
    w.arm(cmp(
        "gte",
        read(&w.env, &o, "nope", alloc::vec![], &[]),
        num(0),
    ));
    assert_eq!(w.enforce(&[]), denied());
}

#[test]
fn a_read_of_an_address_with_no_contract_denies() {
    let w = World::new();
    let nobody = Address::generate(&w.env);
    w.arm(cmp(
        "gte",
        read(&w.env, &nobody, "balance", alloc::vec![], &[]),
        num(0),
    ));
    assert_eq!(w.enforce(&[]), denied());
}

#[test]
fn an_or_permits_through_a_branch_that_cannot_resolve() {
    // `or` falls through a branch that cannot resolve to the next one.
    let w = World::new();
    let o = oracle(&w, 100, 0);
    let dead = cmp("gte", read(&w.env, &o, "boom", alloc::vec![], &[]), num(0));
    let live = price_floor(&w, &o, 100);
    w.arm(tuple(alloc::vec![
        sym("or"),
        tuple(alloc::vec![dead, live])
    ]));
    assert_eq!(w.enforce(&[]), Ok(()));
}

// ---- safety: re-entry ------------------------------------------------------

/// Run `enforce` from inside `caller`'s frame, so `caller` is on the stack.
fn enforce_from(w: &World, caller: &Address) -> Verdict {
    let go = soroban_sdk::vec![
        &w.env,
        w.policy.to_val(),
        w.context(&[]).into_val(&w.env),
        w.rule.clone().into_val(&w.env),
        w.account.to_val(),
    ];
    match w.env.try_invoke_contract::<(), soroban_sdk::Error>(
        caller,
        &Symbol::new(&w.env, "go"),
        go,
    ) {
        Ok(_) => Ok(()),
        Err(Ok(e)) => Err(Some(e)),
        Err(Err(_)) => Err(None),
    }
}

#[test]
fn a_read_of_a_contract_on_the_call_stack_denies() {
    let w = World::new();
    let caller = w.env.register(Caller, ());
    w.arm(cmp(
        "gte",
        read(&w.env, &caller, "peek", alloc::vec![], &[]),
        num(0),
    ));
    assert_eq!(
        enforce_from(&w, &caller),
        denied(),
        "the host refuses re-entry, so the read cannot resolve and the call is denied"
    );
}

#[test]
fn the_same_rule_permits_when_the_read_target_is_not_on_the_stack() {
    // The control: identical shape, but the read goes to a contract that is not
    // an ancestor, so it is the re-entry that denies above and nothing else.
    let w = World::new();
    let caller = w.env.register(Caller, ());
    let other = w.env.register(Pool, (5i128, 5i128));
    w.arm(cmp(
        "gte",
        read(&w.env, &other, "debt", alloc::vec![], &[]),
        num(0),
    ));
    assert_eq!(enforce_from(&w, &caller), Ok(()));
}

// ---- the version gate ------------------------------------------------------

#[test]
fn a_grammar_6_document_is_refused_by_the_version_gate() {
    let w = World::new();
    let val: Val = rule_for(cmp("gte", call_arg(0), num(0))).into_val(&w.env);
    let bytes: Bytes = val.to_xdr(&w.env);
    let hash: BytesN<32> = w.env.crypto().sha256(&bytes).into();
    let params = PolicyInstallParams {
        grammar_version: 6,
        install_nonce: 1,
        predicate: bytes,
        predicate_hash: hash,
        policy_admins: w.rule.signers.clone(),
    };
    let res = w.client().try_install(&params, &w.rule, &w.account);
    assert_eq!(
        res.err().map(|e| e.unwrap().get_code()),
        Some(PolicyError::VersionMismatch as u32)
    );
}

// ---- authoring guards ------------------------------------------------------

/// The LTV rule with the guards the README recommends beside variable
/// operands: the price must be positive (a zero or negative multiplier makes an
/// upper bound trivial) and the advance and the pledge must not be negative.
fn guarded_ltv(w: &World, pool: &Address, oracle: &Address) -> ScVal {
    let price = || read(&w.env, oracle, "lastprice", pot(), &[Step::F("price")]);
    all(alloc::vec![
        cmp("gt", price(), num(0)),
        cmp("gte", call_path(&[Step::I(0)]), num(0)),
        cmp("gte", call_path(&[Step::I(1)]), num(0)),
        ltv(w, pool, oracle),
    ])
}

#[test]
fn a_negative_amount_slips_through_an_unguarded_ltv_rule() {
    // The hazard the guard exists for: B = -500 "advances" a negative amount,
    // which lowers the debt side and passes the bound.
    let (w, pool, o) = ltv_world(2);
    w.arm(ltv(&w, &pool, &o));
    assert_eq!(w.enforce(&[-500, 0, 0]), Ok(()));
}

#[test]
fn a_negative_amount_is_refused_when_the_guard_is_present() {
    let (w, pool, o) = ltv_world(2);
    w.arm(guarded_ltv(&w, &pool, &o));
    assert_eq!(w.enforce(&[-500, 0, 0]), denied());
    assert_eq!(w.enforce(&[100, -1, 0]), denied(), "a negative pledge too");
    assert_eq!(w.enforce(&[100, 0, 0]), Ok(()), "the guard costs nothing");
}

#[test]
fn a_non_positive_price_is_refused_when_the_guard_is_present() {
    let (w, pool, o) = ltv_world(0);
    w.arm(guarded_ltv(&w, &pool, &o));
    assert_eq!(w.enforce(&[100, 0, 0]), denied());
}

#[test]
fn a_subtraction_is_written_by_moving_the_term_across_the_comparison() {
    // `ts >= now - 300` is `ts + 300 >= now`: `num` cannot be negative, but
    // `add` is any value.
    let w = World::new();
    w.env.ledger().with_mut(|l| l.timestamp = 10_000);
    let o = oracle(&w, 1, 9_700);
    let ts = read(&w.env, &o, "lastprice", pot(), &[Step::F("timestamp")]);
    w.arm(cmp("gte", scaled(ts, num(1), 1, num(300)), now()));
    assert_eq!(w.enforce(&[]), Ok(()));
    w.env.ledger().with_mut(|l| l.timestamp = 10_001);
    assert_eq!(w.enforce(&[]), denied());
}

#[test]
fn a_variable_numerator_is_accepted_and_a_literal_one_is_not() {
    let w = World::new();
    let variable = scaled(call_arg(0), call_arg(1), 1, num(0));
    assert_eq!(w.install(&rule_for(cmp("gte", variable, num(0)))), Ok(()));
    for n in [0, -1] {
        let literal = scaled(call_arg(0), num(n), 1, num(0));
        let w = World::new();
        assert_eq!(w.install(&rule_for(cmp("gte", literal, num(0)))), MALFORMED);
    }
}

#[test]
fn a_literal_source_is_held_to_the_same_rule_as_a_literal_numerator() {
    // `src * num` commutes: `scaled(-99, arg, 100, 0)` is the zero-output swap
    // with the multiplicands written the other way round, and
    // `scaled(0, arg, 1, 0) >= 0` cancels the selector.
    for s in [0, -1, -99] {
        let w = World::new();
        let swap = cmp("gte", call_arg(1), scaled(num(s), call_arg(0), 100, num(0)));
        assert_eq!(w.install(&rule_for(swap)), MALFORMED, "src = {s}");
    }
    let w = World::new();
    let vacuous = cmp("gte", scaled(num(0), call_arg(0), 1, num(0)), num(0));
    assert_eq!(w.install(&rule_for(vacuous)), MALFORMED);
    let w = World::new();
    let ok = cmp(
        "gte",
        call_arg(1),
        scaled(num(99), call_arg(0), 100, num(0)),
    );
    assert_eq!(w.install(&rule_for(ok)), Ok(()));
}

#[test]
fn a_constant_multiplicand_is_refused_when_it_folds_to_zero_or_less() {
    // `scaled(1, 1, 1, -100)` is the constant -99 however it is spelled, in
    // either multiplicand slot; so is a nested zero.
    let neg = || scaled(num(1), num(1), 1, num(-100));
    let zero = || scaled(num(1), num(1), 1, num(-1));
    for bad in [neg(), zero()] {
        let a = scaled(call_arg(0), bad.clone(), 100, num(0));
        let b = scaled(bad, call_arg(0), 100, num(0));
        for s in [a, b] {
            let w = World::new();
            assert_eq!(w.install(&rule_for(cmp("gte", call_arg(1), s))), MALFORMED);
        }
    }
    // A constant that folds positive is fine; one that overflows would deny
    // every call, so it is refused instead of installing.
    let w = World::new();
    let pos = scaled(num(2), num(3), 1, num(0));
    w.arm(cmp(
        "gte",
        call_arg(1),
        scaled(call_arg(0), pos, 100, num(0)),
    ));
    let w = World::new();
    let big = scaled(num(i128::MAX), num(2), 1, num(0));
    let r = cmp(
        "gte",
        call_arg(1),
        scaled(call_arg(0), big.clone(), 100, num(0)),
    );
    assert_eq!(w.install(&rule_for(r)), MALFORMED);
    assert_eq!(
        w.install(&rule_for(cmp("gte", call_arg(1), big))),
        MALFORMED
    );
}

#[test]
fn den_is_capped_at_max_den_which_stops_i128_max_but_not_a_tiny_ratio() {
    let rule = |den| {
        rule_for(cmp(
            "gte",
            call_arg(1),
            scaled(call_arg(0), num(99), den, num(0)),
        ))
    };
    let w = World::new();
    assert_eq!(w.install(&rule(policy_interpreter::dsl::MAX_DEN)), Ok(()));
    // What the cap does not stop: 99 / 10^18 floors at zero for ordinary
    // amounts, so a zero output passes. Avoiding that ratio is the author's.
    assert_eq!(w.enforce(&[1_000_000, 0]), Ok(()));
    for den in [policy_interpreter::dsl::MAX_DEN + 1, i128::MAX] {
        assert_eq!(World::new().install(&rule(den)), MALFORMED, "den = {den}");
    }
}

#[test]
fn a_read_target_must_be_a_contract_address() {
    // A G-account makes the host abort the whole enforce instead of failing the
    // call, even inside an `or`; refuse it at install so it denies cleanly.
    let w = World::new();
    let g = Address::from_str(
        &w.env,
        "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN7",
    );
    let r = read(&w.env, &g, "balance", alloc::vec![], &[]);
    assert_eq!(
        w.install(&rule_for(cmp("gte", r.clone(), num(0)))),
        MALFORMED
    );
    let or = tuple(alloc::vec![
        sym("or"),
        tuple(alloc::vec![cmp("gte", r, num(0)), is_advance()])
    ]);
    assert_eq!(w.install(&or), MALFORMED);
}

#[test]
fn a_muxed_account_is_not_a_read_target_either() {
    use soroban_sdk::xdr::{MuxedEd25519Account, ScAddress, Uint256};
    let w = World::new();
    let muxed = ScAddress::MuxedAccount(MuxedEd25519Account {
        id: 1,
        ed25519: Uint256([7; 32]),
    });
    let target = tuple(alloc::vec![
        sym("read"),
        ScVal::Address(muxed),
        sym("balance"),
        tuple(alloc::vec![])
    ]);
    assert_eq!(w.install(&rule_for(cmp("gte", target, num(0)))), MALFORMED);
}

#[test]
fn floors_truncate_toward_zero_so_they_are_lenient_by_under_one_unit() {
    // 101 * 99 / 100 = 99.99 truncates to 99, so an output of 99 passes a
    // floor of 99.99; an exact floor is written cross-multiplied.
    let w = World::new();
    w.arm(cmp(
        "gte",
        call_arg(1),
        scaled(call_arg(0), num(99), 100, num(0)),
    ));
    assert_eq!(w.enforce(&[101, 99]), Ok(()));
    let w = World::new();
    let exact = cmp(
        "gte",
        scaled(call_arg(1), num(100), 1, num(0)),
        scaled(call_arg(0), num(99), 1, num(0)),
    );
    w.arm(exact);
    assert_eq!(w.enforce(&[101, 99]), denied());
    assert_eq!(w.enforce(&[101, 100]), Ok(()));
}

#[test]
fn in_haystacks_and_literal_vecs_hold_constants_only() {
    let w = World::new();
    let o = oracle(&w, 1, 0);
    let rd = read(&w.env, &o, "lastprice", pot(), &[]);
    let hay = |entry: ScVal| {
        tuple(alloc::vec![
            sym("in"),
            call_arg(0),
            tuple(alloc::vec![num(1), entry])
        ])
    };
    assert_eq!(w.install(&rule_for(hay(num(2)))), Ok(()));
    for bad in [call_arg(0), call_fn(), now(), rd] {
        assert_eq!(w.install(&rule_for(hay(bad))), MALFORMED);
    }
}

// ---- a batch: reads are taken before the batch runs ------------------------

/// What the adapter hands the policy: `execute(calls, grants, wait)`, each call
/// a map with `target`, `function_name` and `args`.
fn batch_context(w: &World, functions: &[&str]) -> Context {
    batch_context_waiting(w, functions, 0)
}

/// The same, with `wait` ledgers before the batch may run.
fn batch_context_waiting(w: &World, functions: &[&str], wait: u32) -> Context {
    batch_context_with(w, functions, wait, &w.target, 0, 0)
}

/// The full shape: each call goes to `target` with `nargs` arguments and
/// `nauth` executor authorisations.
fn batch_context_with(
    w: &World,
    functions: &[&str],
    wait: u32,
    target: &Address,
    nargs: u32,
    nauth: u32,
) -> Context {
    let list = |n: u32| {
        let mut v = SorobanVec::<Val>::new(&w.env);
        (0..n).for_each(|i| v.push_back(i.into_val(&w.env)));
        v.into_val(&w.env)
    };
    let mut calls = SorobanVec::<Val>::new(&w.env);
    for f in functions {
        let mut c = soroban_sdk::Map::<Symbol, Val>::new(&w.env);
        c.set(Symbol::new(&w.env, "target"), target.to_val());
        c.set(
            Symbol::new(&w.env, "function_name"),
            Symbol::new(&w.env, f).into_val(&w.env),
        );
        c.set(Symbol::new(&w.env, "args"), list(nargs));
        c.set(Symbol::new(&w.env, "executor_authorizations"), list(nauth));
        calls.push_back(c.into_val(&w.env));
    }
    let mut args = SorobanVec::<Val>::new(&w.env);
    args.push_back(calls.into_val(&w.env));
    args.push_back(SorobanVec::<Val>::new(&w.env).into_val(&w.env));
    args.push_back(wait.into_val(&w.env));
    Context::Contract(ContractContext {
        contract: w.target.clone(),
        fn_name: Symbol::new(&w.env, "execute"),
        args,
    })
}

fn batch_rule(w: &World, oracle: &Address, pin_shape: bool) -> ScVal {
    let mut checks = alloc::vec![
        cmp("eq", call_fn(), sym("execute")),
        price_floor(w, oracle, 100),
    ];
    if pin_shape {
        // No waiting and no grants: with `wait > 0` the rule is answered when
        // the batch is STORED, and the read would be stale when it runs.
        checks.push(cmp("eq", call_arg(2), ScVal::U32(0)));
        checks.push(cmp(
            "eq",
            call_path(&[Step::I(1), Step::Len]),
            ScVal::U32(0),
        ));
        // the whole batch: exactly one call, and it is `advance` on the target
        // with no arguments and no executor authorisations
        let first = |f: &'static str| [Step::I(0), Step::I(0), Step::F(f)];
        let len = |f: &'static str| [Step::I(0), Step::I(0), Step::F(f), Step::Len];
        checks.push(cmp(
            "eq",
            call_path(&first("target")),
            addr(&w.env, &w.target),
        ));
        checks.push(cmp("eq", call_path(&len("args")), ScVal::U32(0)));
        checks.push(cmp(
            "eq",
            call_path(&len("executor_authorizations")),
            ScVal::U32(0),
        ));
        checks.push(cmp(
            "eq",
            call_path(&[Step::I(0), Step::Len]),
            ScVal::U32(1),
        ));
        checks.push(cmp(
            "eq",
            call_path(&[Step::I(0), Step::I(0), Step::F("function_name")]),
            sym("advance"),
        ));
    }
    all(checks)
}

#[test]
fn an_unpinned_batch_lets_a_later_call_break_what_the_read_checked() {
    // The read is taken at authorisation, before ANY call of the batch runs, so
    // the price check holds for [advance] and for [advance, withdraw] alike: the
    // second call can undo the condition and the rule has already permitted.
    let w = World::new();
    let o = oracle(&w, 100, 0);
    w.install(&batch_rule(&w, &o, false)).unwrap();
    assert_eq!(w.enforce_context(&batch_context(&w, &["advance"])), Ok(()));
    assert_eq!(
        w.enforce_context(&batch_context(&w, &["advance", "withdraw"])),
        Ok(())
    );
}

#[test]
fn a_pinned_batch_refuses_an_appended_call_and_a_swapped_one() {
    let w = World::new();
    let o = oracle(&w, 100, 0);
    w.install(&batch_rule(&w, &o, true)).unwrap();
    assert_eq!(w.enforce_context(&batch_context(&w, &["advance"])), Ok(()));
    assert_eq!(
        w.enforce_context(&batch_context(&w, &["advance", "withdraw"])),
        denied()
    );
    assert_eq!(
        w.enforce_context(&batch_context(&w, &["withdraw", "advance"])),
        denied()
    );
    assert_eq!(
        w.enforce_context(&batch_context(&w, &["withdraw"])),
        denied()
    );
}

#[test]
fn a_pinned_batch_also_pins_the_target_its_args_and_executor_authorisations() {
    let w = World::new();
    let o = oracle(&w, 100, 0);
    w.install(&batch_rule(&w, &o, true)).unwrap();
    let ok = |t: &Address, a, n| batch_context_with(&w, &["advance"], 0, t, a, n);
    assert_eq!(w.enforce_context(&ok(&w.target, 0, 0)), Ok(()));
    let elsewhere = Address::generate(&w.env);
    assert_eq!(w.enforce_context(&ok(&elsewhere, 0, 0)), denied());
    assert_eq!(w.enforce_context(&ok(&w.target, 1, 0)), denied());
    assert_eq!(w.enforce_context(&ok(&w.target, 0, 1)), denied());
}

#[test]
fn a_rule_on_execute_is_answered_when_a_waiting_batch_is_stored() {
    // `wait` is the adapter's third argument. An unpinned rule permits a batch
    // that will run a million ledgers later, on the strength of a read taken now;
    // pinning `wait == 0` refuses it, and `wait == 0` still permits.
    let w = World::new();
    let o = oracle(&w, 100, 0);
    w.install(&batch_rule(&w, &o, false)).unwrap();
    let waiting = batch_context_waiting(&w, &["advance"], 1_000_000);
    assert_eq!(w.enforce_context(&waiting), Ok(()));
    let w = World::new();
    let o = oracle(&w, 100, 0);
    w.install(&batch_rule(&w, &o, true)).unwrap();
    assert_eq!(w.enforce_context(&batch_context(&w, &["advance"])), Ok(()));
    assert_eq!(
        w.enforce_context(&batch_context_waiting(&w, &["advance"], 1)),
        denied()
    );
}

// ---- reads see the state at authorisation time -----------------------------

/// A value anyone can set: a spot price, an agent-debitable balance.
#[contract]
pub struct Spot;

#[contractimpl]
impl Spot {
    pub fn set(e: &Env, p: i128) {
        e.storage().instance().set(&0u32, &p);
    }

    pub fn price(e: &Env) -> i128 {
        e.storage().instance().get(&0u32).unwrap_or(0)
    }
}

/// The submitter's wrapper: move the spot price, have the account's
/// authorisation checked (here: `enforce`), move it back - one invocation.
#[contract]
pub struct Sandwich;

#[contractimpl]
impl Sandwich {
    pub fn go(
        e: &Env,
        spot: Address,
        policy: Address,
        context: Context,
        rule: ContextRule,
        account: Address,
    ) {
        let s = SpotClient::new(e, &spot);
        let before = s.price();
        s.set(&1_000_000);
        PolicyInterpreterClient::new(e, &policy).enforce(&context, &rule.signers, &rule, &account);
        s.set(&before);
    }
}

#[test]
fn a_read_of_state_the_submitter_can_move_is_defeated_inside_one_transaction() {
    // Reads see the state at the moment the account's authorisation is checked,
    // which a submitter can arrange to follow its own earlier calls. A spot
    // value is therefore not a safe thing to read: the rule denies at the real
    // price and permits inside the wrapper, and the price is back afterwards.
    let w = World::new();
    let spot = w.env.register(Spot, ());
    let sandwich = w.env.register(Sandwich, ());
    SpotClient::new(&w.env, &spot).set(&10);
    w.arm(cmp(
        "gte",
        read(&w.env, &spot, "price", alloc::vec![], &[]),
        num(1_000),
    ));
    assert_eq!(w.enforce(&[]), denied());
    let go = SandwichClient::new(&w.env, &sandwich).try_go(
        &spot,
        &w.policy,
        &w.context(&[]),
        &w.rule,
        &w.account,
    );
    assert!(go.is_ok());
    assert_eq!(SpotClient::new(&w.env, &spot).price(), 10);
}

// ---- a Reflector-style oracle: enum argument, Option result ----------------

/// `variant(name, payload...)`.
fn variant(name: &str, payload: StdVec<ScVal>) -> ScVal {
    let mut items = alloc::vec![sym("variant"), sym(name)];
    items.extend(payload);
    tuple(items)
}

/// `lastprice(Asset::Stellar(pot))` and a field of the `PriceData` it returns.
fn reflector_read(w: &World, feed: &Address, pot: &Address, field: &'static str) -> ScVal {
    let asset = variant("Stellar", alloc::vec![addr(&w.env, pot)]);
    read(
        &w.env,
        feed,
        "lastprice",
        alloc::vec![asset],
        &[Step::F(field)],
    )
}

/// The LTV check of `ltv`, with the price leaf supplied.
fn ltv_over(w: &World, pool: &Address, price: ScVal) -> ScVal {
    let debt = read(&w.env, pool, "debt", alloc::vec![], &[]);
    let coll = read(&w.env, pool, "collateral", alloc::vec![], &[]);
    let pledged = scaled(coll, num(1), 1, call_arg(1)); // coll + P
    cmp(
        "lte",
        scaled(debt, num(1), 1, call_arg(0)), // debt + B
        scaled(price, scaled(pledged, num(92), 1, num(0)), 100, num(0)),
    )
}

/// A world with a Reflector-style feed that knows `Asset::Stellar(pot)`.
fn reflector_world(price: i128, timestamp: u64) -> (World, Address, Address) {
    let w = World::new();
    w.env.ledger().with_mut(|l| l.timestamp = 10_000);
    let pot = Address::generate(&w.env);
    let feed = w
        .env
        .register(Reflector, (Asset::Stellar(pot.clone()), price, timestamp));
    (w, feed, pot)
}

#[test]
fn a_reflector_style_feed_serves_the_price_floor() {
    let check = |price| {
        let (w, feed, pot) = reflector_world(price, 0);
        let floor = cmp("gte", reflector_read(&w, &feed, &pot, "price"), num(100));
        w.arm(floor);
        w.enforce(&[])
    };
    assert_eq!(check(100), Ok(()));
    assert_eq!(check(99), denied());
}

/// The LTV rule of `ltv_over` with the price read from the Reflector feed:
/// `debt + B <= 92% * price * (coll + P)` over a pool at debt 900, coll 600.
#[test]
fn a_reflector_style_feed_serves_the_ltv_check() {
    let (w, feed, pot) = reflector_world(2, 0);
    let pool = w.env.register(Pool, (900i128, 600i128));
    w.arm(ltv_over(
        &w,
        &pool,
        reflector_read(&w, &feed, &pot, "price"),
    ));
    // capacity 0.92 * 2 * 600 = 1,104: B = 204 sits exactly on it.
    assert_eq!(w.enforce(&[204, 0, 0]), Ok(()));
    assert_eq!(w.enforce(&[205, 0, 0]), denied());
    // ... and pledging P = 100 lifts it to 0.92 * 2 * 700 = 1,288.
    assert_eq!(w.enforce(&[300, 100, 0]), Ok(()));
    // The live price decides: at 1 the same advance is refused.
    let (w, feed, pot) = reflector_world(1, 0);
    let pool = w.env.register(Pool, (900i128, 600i128));
    w.arm(ltv_over(
        &w,
        &pool,
        reflector_read(&w, &feed, &pot, "price"),
    ));
    assert_eq!(w.enforce(&[100, 0, 0]), denied());
}

#[test]
fn a_reflector_style_feed_serves_the_freshness_check() {
    let check = |timestamp| {
        let (w, feed, pot) = reflector_world(1, timestamp);
        let stamp = reflector_read(&w, &feed, &pot, "timestamp");
        w.arm(cmp("gte", stamp, scaled(now(), num(1), 1, num(-300))));
        w.enforce(&[])
    };
    assert_eq!(check(9_700), Ok(())); // exactly 300 s old
    assert_eq!(check(9_699), denied()); // 301 s old
}

#[test]
fn the_first_loss_check_does_not_involve_the_feed() {
    // It reads a token balance, so the enum argument is not in play; kept here
    // so the four checks sit side by side.
    let (w, tusd, custody) = first_loss_world(1_050);
    w.arm(first_loss(&w, &tusd, &custody, 1_000));
    assert_eq!(w.enforce(&[0, 0, 50]), Ok(()));
    assert_eq!(w.enforce(&[0, 0, 51]), denied());
}

#[test]
fn a_none_result_denies_and_a_some_result_is_walked_by_its_path() {
    // `Some(PriceData)` arrives as the struct itself, so `price` is found.
    let w = World::new();
    let pot = Address::generate(&w.env);
    let feed = w
        .env
        .register(Reflector, (Asset::Stellar(pot.clone()), 150i128, 0u64));
    w.arm(cmp(
        "gte",
        reflector_read(&w, &feed, &pot, "price"),
        num(150),
    ));
    assert_eq!(w.enforce(&[]), Ok(()));

    // The same rule against an asset the feed does not know: `None` is void,
    // which has no `price` and denies - under `gte` and under `lte` alike.
    for op in ["gte", "lte"] {
        let w = World::new();
        let known = Address::generate(&w.env);
        let unknown = Address::generate(&w.env);
        let feed = w
            .env
            .register(Reflector, (Asset::Stellar(known), 150i128, 0u64));
        w.arm(cmp(
            op,
            reflector_read(&w, &feed, &unknown, "price"),
            num(0),
        ));
        assert_eq!(w.enforce(&[]), denied(), "{op}");
    }
    // Another variant of the same enum is `None` too (`Other` is not `Stellar`).
    let w = World::new();
    let pot = Address::generate(&w.env);
    let feed = w
        .env
        .register(Reflector, (Asset::Stellar(pot), 150i128, 0u64));
    let other = variant("Other", alloc::vec![sym("POT")]);
    let read_other = read(
        &w.env,
        &feed,
        "lastprice",
        alloc::vec![other],
        &[Step::F("price")],
    );
    w.arm(cmp("gte", read_other, num(0)));
    assert_eq!(w.enforce(&[]), denied());
}

#[test]
fn a_variant_is_a_constant_and_nothing_else() {
    let w = World::new();
    let o = oracle(&w, 1, 0);
    let rd = |arg: ScVal| {
        let r = read(
            &w.env,
            &o,
            "lastprice",
            alloc::vec![arg],
            &[Step::F("price")],
        );
        rule_for(cmp("gte", r, num(0)))
    };
    // A well-formed variant installs, with and without a payload.
    assert_eq!(
        w.install(&rd(variant("Other", alloc::vec![sym("POT")]))),
        Ok(())
    );
    let w = World::new();
    let o = oracle(&w, 1, 0);
    let unit = read(
        &w.env,
        &o,
        "lastprice",
        alloc::vec![variant("Unit", alloc::vec![])],
        &[],
    );
    assert_eq!(w.install(&rule_for(cmp("gte", unit, num(0)))), Ok(()));
    // Anything that is not a constant inside one is refused, as is a variant
    // with a non-symbol name, a bare symbol-headed vec, and a selector.
    let bad = [
        variant("Stellar", alloc::vec![call_arg(0)]),
        variant("Stellar", alloc::vec![now()]),
        variant(
            "Stellar",
            alloc::vec![variant("Inner", alloc::vec![call_fn()])],
        ),
        tuple(alloc::vec![sym("variant"), num(1), sym("Stellar")]),
        tuple(alloc::vec![sym("variant")]),
        tuple(alloc::vec![sym("Stellar"), num(1)]),
        call_arg(0),
    ];
    for b in bad {
        let w = World::new();
        let o = oracle(&w, 1, 0);
        let r = read(&w.env, &o, "lastprice", alloc::vec![b], &[Step::F("price")]);
        assert_eq!(w.install(&rule_for(cmp("gte", r, num(0)))), MALFORMED);
    }
    // The same holds where a variant is an operand rather than a read
    // argument: a selector in its payload is refused, not left to deny at
    // enforce (where it would still satisfy the selector-leaf install check).
    let w = World::new();
    let hidden = variant("Stellar", alloc::vec![call_fn()]);
    assert_eq!(w.install(&cmp("eq", hidden.clone(), hidden)), MALFORMED);
    // A variant does not count as a selector: a rule of reads and the clock
    // alone is still refused.
    let w = World::new();
    let o = oracle(&w, 1, 0);
    let r = read(
        &w.env,
        &o,
        "lastprice",
        alloc::vec![variant("A", alloc::vec![])],
        &[],
    );
    assert_eq!(
        w.install(&cmp("gte", r, num(0))),
        Err(PolicyError::SelectorLeafRequired as u32)
    );
}

#[test]
fn a_variant_literal_pins_an_enum_argument_of_the_call() {
    // `eq(call_arg(0), variant(Stellar, [pot]))`: the authorised call must
    // pass exactly that asset.
    let w = World::new();
    let pot = Address::generate(&w.env);
    w.arm(cmp(
        "eq",
        call_arg(0),
        variant("Stellar", alloc::vec![addr(&w.env, &pot)]),
    ));
    let ctx = |asset: Asset| {
        let args: SorobanVec<Val> = soroban_sdk::vec![&w.env, asset.into_val(&w.env)];
        Context::Contract(ContractContext {
            contract: w.target.clone(),
            fn_name: Symbol::new(&w.env, "advance"),
            args,
        })
    };
    assert_eq!(w.enforce_context(&ctx(Asset::Stellar(pot.clone()))), Ok(()));
    let other = Asset::Stellar(Address::generate(&w.env));
    assert_eq!(w.enforce_context(&ctx(other)), denied());
    assert_eq!(
        w.enforce_context(&ctx(Asset::Other(Symbol::new(&w.env, "POT")))),
        denied()
    );
}

// ---- identical reads are one call; the cap counts distinct calls -----------

/// All four PayFi checks as ONE predicate on the payout rule: price floor,
/// exact LTV, first-loss float and freshness. The feed is read three times
/// (price twice, timestamp once) and is one call; with debt, collateral and
/// the custody balance that is four distinct calls.
fn payfi_rule(w: &World, feed: &Address, pot: &Address) -> ScVal {
    let pool = w.env.register(Pool, (900i128, 600i128));
    let custody = Address::generate(&w.env);
    let tusd = w.env.register(Token, (custody.clone(), 1_050i128));
    let price = || reflector_read(w, feed, pot, "price");
    let fresh = cmp(
        "gte",
        reflector_read(w, feed, pot, "timestamp"),
        scaled(now(), num(1), 1, num(-300)),
    );
    all(alloc::vec![
        is_advance(),
        cmp("gte", price(), num(2)),
        ltv_over(w, &pool, price()),
        first_loss(w, &tusd, &custody, 1_000),
        fresh,
    ])
}

#[test]
fn the_four_payfi_checks_are_one_rule_and_the_feed_is_called_once() {
    // price 2, 300 s old: B <= 204 passes LTV (capacity 1,104 - 900), T <= 50.
    let (w, feed, pot) = reflector_world(2, 9_700);
    let rule = payfi_rule(&w, &feed, &pot);
    w.install(&rule)
        .expect("one predicate carries all four checks");
    assert_eq!(w.enforce(&[204, 0, 50]), Ok(()));
    let feed_calls = ReflectorClient::new(&w.env, &feed).calls();
    assert_eq!(
        feed_calls, 1,
        "price floor, LTV price and freshness share one call"
    );
}

#[test]
fn each_payfi_check_refuses_inside_the_one_rule() {
    let permit = |price, stamp, args: [i128; 3]| {
        let (w, feed, pot) = reflector_world(price, stamp);
        let rule = payfi_rule(&w, &feed, &pot);
        w.install(&rule).unwrap();
        w.enforce(&args)
    };
    assert_eq!(permit(2, 9_700, [204, 0, 50]), Ok(()));
    assert_eq!(permit(1, 9_700, [0, 0, 0]), denied(), "price floor (2)");
    assert_eq!(permit(2, 9_700, [205, 0, 0]), denied(), "LTV one over");
    assert_eq!(permit(2, 9_700, [0, 0, 51]), denied(), "first-loss float");
    assert_eq!(permit(2, 9_699, [0, 0, 0]), denied(), "stale price");
}

#[test]
fn a_fifth_distinct_read_is_refused_and_repeats_are_free() {
    let (w, feed, pot) = reflector_world(2, 9_700);
    let rule = payfi_rule(&w, &feed, &pot);
    // A fifth DISTINCT call (the feed asked about another asset) is refused.
    let other = Address::generate(&w.env);
    let fifth = reflector_read(&w, &feed, &other, "price");
    let over = all(alloc::vec![rule.clone(), cmp("gte", fifth, num(0))]);
    assert_eq!(w.install(&over), MALFORMED);
    // The same call again, any path, any number of times, installs.
    let again = |field| cmp("gte", reflector_read(&w, &feed, &pot, field), num(0));
    let repeats: StdVec<ScVal> = ["price", "timestamp", "price", "price", "timestamp"]
        .into_iter()
        .map(again)
        .collect();
    let mut checks = alloc::vec![rule];
    checks.extend(repeats);
    assert_eq!(w.install(&all(checks)), Ok(()));
    assert_eq!(w.enforce(&[204, 0, 50]), Ok(()));
    assert_eq!(ReflectorClient::new(&w.env, &feed).calls(), 1);
}

#[test]
fn a_void_shared_read_denies_every_leaf_that_uses_it() {
    // The feed does not know this asset: void for both the price and the
    // timestamp leaf, and the one memoised result denies each. (A call that
    // FAILS is `a_failed_read_is_made_once`.)
    let (w, feed, _) = reflector_world(2, 9_700);
    let unknown = Address::generate(&w.env);
    let both = all(alloc::vec![
        is_advance(),
        cmp("gte", reflector_read(&w, &feed, &unknown, "price"), num(0)),
        cmp(
            "lte",
            reflector_read(&w, &feed, &unknown, "timestamp"),
            num(i128::MAX)
        ),
    ]);
    w.install(&both).unwrap();
    assert_eq!(w.enforce(&[]), denied());
    // ... also inside an `or`, where the sibling branch still permits.
    let w = World::new();
    let unknown = Address::generate(&w.env);
    let feed = w.env.register(
        Reflector,
        (Asset::Stellar(Address::generate(&w.env)), 2i128, 0u64),
    );
    let dead = cmp("gte", reflector_read(&w, &feed, &unknown, "price"), num(0));
    let or = tuple(alloc::vec![
        sym("or"),
        tuple(alloc::vec![dead.clone(), dead, is_advance()])
    ]);
    w.install(&or).unwrap();
    assert_eq!(w.enforce(&[]), Ok(()));
}

// ---- the memo, the leaf cap and `or`: what a regression must not change ----

fn or(children: StdVec<ScVal>) -> ScVal {
    tuple(alloc::vec![sym("or"), tuple(children)])
}

/// A holder's `balance` as a floor: `balance(holder) >= floor`.
fn holds(w: &World, token: &Address, holder: &Address, floor: i128) -> ScVal {
    let balance = read(
        &w.env,
        token,
        "balance",
        alloc::vec![addr(&w.env, holder)],
        &[],
    );
    cmp("gte", balance, num(floor))
}

/// `balance(rich) >= 1000` and `balance(poor) <= 0`, or the two holders swapped.
fn two_holders(swapped: bool) -> Verdict {
    let w = World::new();
    let (rich, poor) = (Address::generate(&w.env), Address::generate(&w.env));
    let token = w.env.register(Token, (rich.clone(), 1_050i128));
    let (a, b) = if swapped {
        (&poor, &rich)
    } else {
        (&rich, &poor)
    };
    w.install(&both_with(&w, &token, a, b)).unwrap();
    w.enforce(&[])
}

#[test]
fn reads_of_one_function_with_different_arguments_are_different_calls() {
    // The memo key is (contract, fn, args). If it ignored the arguments the
    // second read would be answered with the first one's balance.
    assert_eq!(two_holders(false), Ok(()));
    assert_eq!(two_holders(true), denied());
}

fn both_with(w: &World, token: &Address, a: &Address, b: &Address) -> ScVal {
    let owes_nothing = cmp(
        "lte",
        read(&w.env, token, "balance", alloc::vec![addr(&w.env, b)], &[]),
        num(0),
    );
    all(alloc::vec![
        is_advance(),
        holds(w, token, a, 1_000),
        owes_nothing
    ])
}

/// CPU spent by one `enforce` of `or(dead reads.., advance)`, where `dead`
/// panics. `distinct` registers a fresh target per read, so none can share.
fn cost_of_dead_reads(distinct: bool) -> u64 {
    let w = World::new();
    let first = oracle(&w, 1, 0);
    let dead = |o: &Address| cmp("gte", read(&w.env, o, "boom", alloc::vec![], &[]), num(0));
    let mut branches = alloc::vec![dead(&first)];
    for _ in 1..4 {
        let o = if distinct {
            oracle(&w, 1, 0)
        } else {
            first.clone()
        };
        branches.push(dead(&o));
    }
    branches.push(is_advance());
    w.install(&or(branches)).unwrap();
    w.env.cost_estimate().budget().reset_unlimited();
    assert_eq!(w.enforce(&[]), Ok(()));
    w.env.cost_estimate().budget().cpu_instruction_cost()
}

#[test]
fn a_failed_read_is_made_once() {
    // A call that panics is remembered like any other: four identical dead
    // reads are one failed call, four distinct ones are four.
    let (same, distinct) = (cost_of_dead_reads(false), cost_of_dead_reads(true));
    assert!(
        same * 100 < distinct * 90,
        "identical dead reads cost {same}, distinct ones {distinct}: failures are not memoised"
    );
}

#[test]
fn an_or_stops_at_the_first_branch_that_permits() {
    // `or(advance, read)`: the read branch never runs, so the feed is never
    // called. With the branches the other way round it is.
    let (w, feed, pot) = reflector_world(2, 9_700);
    let live = cmp("gte", reflector_read(&w, &feed, &pot, "price"), num(0));
    w.install(&or(alloc::vec![is_advance(), live.clone()]))
        .unwrap();
    assert_eq!(w.enforce(&[]), Ok(()));
    assert_eq!(ReflectorClient::new(&w.env, &feed).calls(), 0);

    let (w, feed, pot) = reflector_world(2, 9_700);
    let live = cmp("gte", reflector_read(&w, &feed, &pot, "price"), num(0));
    w.install(&or(alloc::vec![cmp("eq", call_fn(), sym("other")), live]))
        .unwrap();
    assert_eq!(w.enforce(&[]), Ok(()));
    assert_eq!(ReflectorClient::new(&w.env, &feed).calls(), 1);
}

#[test]
fn an_or_reports_its_first_deny() {
    // Both branches deny: the reason is the first branch's, CONTRACT_SCOPE or
    // ARG_MISMATCH depending on which is written first.
    let w = World::new();
    let elsewhere = addr(&w.env, &Address::generate(&w.env));
    let scope = cmp("eq", tuple(alloc::vec![sym("call_contract")]), elsewhere);
    let mismatch = cmp("eq", call_fn(), sym("other"));
    w.install(&or(alloc::vec![scope.clone(), mismatch.clone()]))
        .unwrap();
    assert_eq!(w.enforce(&[]), refused(PolicyError::ContractScope));
    let w = World::new();
    w.install(&or(alloc::vec![mismatch, scope])).unwrap();
    assert_eq!(w.enforce(&[]), denied());
}

/// `in(call_fn, [x0.. x(n-1)])`: `1 + n` leaves.
fn member(n: usize) -> ScVal {
    let entries = (0..n).map(|i| sym(&alloc::format!("f{i}"))).collect();
    tuple(alloc::vec![sym("in"), call_fn(), tuple(entries)])
}

#[test]
fn the_leaf_cap_is_exactly_200_and_counts_in_entries() {
    // Six `in` of 32 entries are 6 * 33 = 198 leaves. A two-leaf `in` makes
    // 200 (installs); a three-leaf one makes 201 (refused). The entries must
    // count: without them the 201 would be 12.
    let w = World::new();
    let mut rule = alloc::vec![member(32); 6];
    rule.push(member(1));
    w.install(&all(rule.clone())).expect("exactly 200 leaves");
    rule.pop();
    rule.push(member(2));
    assert_eq!(w.install(&all(rule)), MALFORMED, "201 leaves");
}

#[test]
fn a_rule_scoped_to_create_contract_denies_missing_state() {
    // The interpreter only evaluates a contract call. A rule scoped to
    // `CreateContract` can carry this policy, and its context is not one.
    use soroban_sdk::auth::{ContractExecutable, CreateContractHostFnContext};
    let mut w = World::new();
    w.rule.context_type = ContextRuleType::CreateContract(BytesN::from_array(&w.env, &[1; 32]));
    w.install(&rule_for(cmp("eq", call_fn(), sym("advance"))))
        .unwrap();
    let create = Context::CreateContractHostFn(CreateContractHostFnContext {
        executable: ContractExecutable::Wasm(BytesN::from_array(&w.env, &[1; 32])),
        salt: BytesN::from_array(&w.env, &[2; 32]),
    });
    assert_eq!(
        w.enforce_context(&create),
        refused(PolicyError::MissingState)
    );
}

#[test]
fn the_interpreters_own_address_cannot_be_a_signer() {
    // `require_auth` on the interpreter is satisfied only by a call the
    // interpreter itself makes, so a master set holding it can never authorise
    // an uninstall or a rotation and the rule is bricked. Refused as 219 at
    // install (operators and admins both) and at rotation.
    let w = World::new();
    let ok = soroban_sdk::vec![&w.env, Signer::Delegated(w.account.clone())];
    let own = soroban_sdk::vec![&w.env, Signer::Delegated(w.policy.clone())];
    let predicate: Bytes = {
        let val: Val = rule_for(is_advance()).into_val(&w.env);
        val.to_xdr(&w.env)
    };
    let try_install = |operators: &SorobanVec<Signer>, admins: &SorobanVec<Signer>| {
        let params = PolicyInstallParams {
            grammar_version: 7,
            install_nonce: 1,
            predicate: predicate.clone(),
            predicate_hash: w.env.crypto().sha256(&predicate).into(),
            policy_admins: admins.clone(),
        };
        let rule = ContextRule {
            signers: operators.clone(),
            ..w.rule.clone()
        };
        w.client().try_install(&params, &rule, &w.account)
    };
    let code = |r: Result<_, Result<soroban_sdk::Error, _>>| match r {
        Ok(_) => None,
        Err(e) => e.ok().map(|e: soroban_sdk::Error| e.get_code()),
    };
    assert_eq!(code(try_install(&ok, &own)), Some(219), "as admin");
    assert_eq!(code(try_install(&own, &ok)), Some(219), "as operator");
    assert_eq!(code(try_install(&ok, &ok)), None);
    assert_eq!(
        code(
            w.client()
                .try_rotate_master_signer_set(&w.account, &1, &own)
        ),
        Some(219),
        "at rotation"
    );
}

#[test]
fn a_constant_product_that_overflows_is_refused_even_when_the_addend_varies() {
    // src * num does not depend on `add`, so 1e20 * 1e20 would deny every call
    // with ARITHMETIC_OVERFLOW whatever the call carries. Refuse it at install.
    let big = 100_000_000_000_000_000_000i128;
    let w = World::new();
    let floor = |src, n| cmp("gte", call_arg(1), scaled(num(src), num(n), 1, call_arg(0)));
    assert_eq!(w.install(&rule_for(floor(big, big))), MALFORMED);
    // Nested: the overflow is in the numerator's own constant fold.
    let nested = scaled(num(big), num(big), 1, num(0));
    assert_eq!(
        w.install(&rule_for(cmp(
            "gte",
            call_arg(1),
            scaled(nested, num(1), 1, call_arg(0))
        ))),
        MALFORMED
    );
    // A product that fits installs, with a variable addend, at the edge.
    assert_eq!(w.install(&rule_for(floor(i128::MAX, 1))), Ok(()));
    // And the addend still decides the answer: i128::MAX + 1 overflows.
    assert_eq!(w.enforce(&[1, 0]), refused(PolicyError::ArithmeticOverflow));
}
