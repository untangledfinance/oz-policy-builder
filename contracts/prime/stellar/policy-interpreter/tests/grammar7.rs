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
}

fn steps(path: &[Step]) -> StdVec<ScVal> {
    path.iter()
        .map(|s| match s {
            Step::I(i) => ScVal::U32(*i),
            Step::F(f) => sym(f),
        })
        .collect()
}

fn call_arg(i: u32) -> ScVal {
    tuple(alloc::vec![sym("call_arg"), ScVal::U32(i)])
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
        match self.client().try_enforce(
            &self.context(args),
            &self.rule.signers,
            &self.rule,
            &self.account,
        ) {
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
    // (7 * 1 / 2) + 10 = 3 + 10 = 13; multiplying after dividing would give 14.
    let w = World::new();
    w.arm(cmp(
        "eq",
        scaled(call_arg(0), num(1), 2, num(10)),
        call_arg(1),
    ));
    assert_eq!(w.enforce(&[7, 13]), Ok(()));
    assert_eq!(w.enforce(&[7, 14]), denied());
    // toward zero: -7 / 2 = -3, not -4.
    assert_eq!(w.enforce(&[-7, 7]), Ok(()));
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
            .map(|_| {
                cmp(
                    "gte",
                    read(&w.env, &o, "lastprice", pot(), &[Step::F("price")]),
                    num(0),
                )
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
    let rd = || read(&w.env, &o, "lastprice", pot(), &[Step::F("price")]);
    let four = scaled(rd(), scaled(rd(), rd(), 1, num(0)), 1, rd());
    assert_eq!(w.install(&rule_for(cmp("gte", four, num(0)))), Ok(()));
    let w = World::new();
    let o = oracle(&w, 1, 0);
    let rd = || read(&w.env, &o, "lastprice", pot(), &[Step::F("price")]);
    let five = scaled(rd(), scaled(rd(), rd(), 1, rd()), 1, rd());
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
    assert!(w.enforce(&[]).is_err(), "a panicking read must not permit");
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
    assert!(w.enforce(&[]).is_err());
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
    assert!(w.enforce(&[]).is_err());
}

#[test]
fn a_deny_still_denies_when_another_or_branch_cannot_resolve() {
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
