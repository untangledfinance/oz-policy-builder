extern crate std;
use super::*;
use soroban_sdk::{
    address_payload::AddressPayload,
    testutils::{
        storage::{Instance as _, Persistent as _},
        Address as _, Ledger as _,
    },
    xdr::ToXdr,
    Bytes, IntoVal, String as SString,
};

/// Stands in for the custody gate: the adapter only ever asks it two things.
#[contract]
pub struct FixtureGate;

#[contractimpl]
impl FixtureGate {
    pub fn __constructor(e: Env, allowed: Vec<Address>, custody: Address) {
        e.storage().instance().set(&symbol_short!("a"), &allowed);
        e.storage().instance().set(&symbol_short!("c"), &custody);
    }
    pub fn allowed(e: Env) -> Vec<Address> {
        e.storage().instance().get(&symbol_short!("a")).unwrap()
    }
    pub fn custody(e: Env) -> Address {
        e.storage().instance().get(&symbol_short!("c")).unwrap()
    }
    pub fn ping(_e: Env) {}
    /// Counts its calls, so a test can see whether a batch actually ran.
    pub fn bump(e: Env) {
        let n: u32 = e.storage().instance().get(&symbol_short!("n")).unwrap_or(0);
        e.storage().instance().set(&symbol_short!("n"), &(n + 1));
    }
    pub fn count(e: Env) -> u32 {
        e.storage().instance().get(&symbol_short!("n")).unwrap_or(0)
    }
    pub fn one(_e: Env, _a: Val) {}
    pub fn two(_e: Env, _a: Val, _b: Val) {}
}

/// A contract that is not a gate: it answers neither `allowed` nor `custody`.
#[contract]
pub struct Bystander;

#[contractimpl]
impl Bystander {
    pub fn ping(_e: Env) {}
}

struct World {
    e: Env,
    adapter: Address,
    gate: Address,
    prime: Address,
    custody: Address,
    stranger: Address,
}

fn world() -> World {
    world_with(0, 100)
}

fn world_with(min_wait: u32, run_window: u32) -> World {
    let e = Env::default();
    e.ledger().set_sequence_number(1_000);
    e.mock_all_auths();
    let prime = Address::generate(&e);
    let custody = Address::generate(&e);
    let stranger = Address::generate(&e);
    // `allowed` names the gate's own perimeter; the adapter adds the gate.
    let allowed = Vec::from_array(&e, [custody.clone(), prime.clone()]);
    let gate = e.register(FixtureGate, (allowed, custody.clone()));
    let at = agreed_address(&e, &prime, &gate, min_wait, run_window);
    let adapter = e.register_at(
        &at,
        ExecutionAdapter,
        (prime.clone(), gate.clone(), min_wait, run_window),
    );
    World {
        e,
        adapter,
        gate,
        prime,
        custody,
        stranger,
    }
}

fn call_to(e: &Env, target: &Address, f: &str, args: Vec<Val>) -> Call {
    Call {
        target: target.clone(),
        function_name: Symbol::new(e, f),
        args,
        executor_authorizations: Vec::new(e),
    }
}

type Outcome = Result<
    Result<(), soroban_sdk::ConversionError>,
    Result<soroban_sdk::Error, soroban_sdk::InvokeError>,
>;

fn run(w: &World, calls: Vec<Call>) -> Outcome {
    ExecutionAdapterClient::new(&w.e, &w.adapter)
        .try_execute(&calls, &Vec::new(&w.e), &0)
        .map(|r| r.map(|_| ()))
}

fn refused(w: &World, calls: Vec<Call>, want: E) {
    match run(w, calls) {
        Err(Ok(got)) => assert_eq!(got, soroban_sdk::Error::from_contract_error(want as u32)),
        other => panic!("expected {:?}, permitted: {}", want, other.is_ok()),
    }
}

#[test]
fn permits_a_call_to_the_gate_itself() {
    let w = world();
    let calls = Vec::from_array(&w.e, [call_to(&w.e, &w.gate, "ping", Vec::new(&w.e))]);
    assert!(run(&w, calls).is_ok());
}

#[test]
fn refuses_an_unlisted_target() {
    let w = world();
    let calls = Vec::from_array(&w.e, [call_to(&w.e, &w.stranger, "ping", Vec::new(&w.e))]);
    refused(&w, calls, E::AddressNotAllowed);
}

#[test]
fn refuses_the_prime_as_a_target() {
    let w = world();
    // The Prime is on the perimeter, so only the dedicated check can refuse it.
    let calls = Vec::from_array(&w.e, [call_to(&w.e, &w.prime, "ping", Vec::new(&w.e))]);
    refused(&w, calls, E::PrimeTarget);
}

#[test]
fn refuses_a_stranger_in_an_argument() {
    let w = world();
    let args = Vec::from_array(&w.e, [w.stranger.to_val()]);
    let calls = Vec::from_array(
        &w.e,
        [call_to(
            &w.e,
            &w.gate,
            if args.len() == 2 { "two" } else { "one" },
            args,
        )],
    );
    refused(&w, calls, E::AddressNotAllowed);
}

#[test]
fn refuses_a_stranger_buried_in_a_nested_argument() {
    let w = world();
    let inner: Vec<Val> = Vec::from_array(&w.e, [w.stranger.to_val()]);
    let mid: Vec<Val> = Vec::from_array(&w.e, [inner.into_val(&w.e)]);
    let args = Vec::from_array(&w.e, [mid.into_val(&w.e)]);
    refused(
        &w,
        Vec::from_array(
            &w.e,
            [call_to(
                &w.e,
                &w.gate,
                if args.len() == 2 { "two" } else { "one" },
                args,
            )],
        ),
        E::AddressNotAllowed,
    );
}

#[test]
fn refuses_a_stranger_written_as_a_strkey() {
    let w = world();
    let args = Vec::from_array(&w.e, [w.stranger.to_string().to_val()]);
    refused(
        &w,
        Vec::from_array(
            &w.e,
            [call_to(
                &w.e,
                &w.gate,
                if args.len() == 2 { "two" } else { "one" },
                args,
            )],
        ),
        E::AddressNotAllowed,
    );
}

#[test]
fn permits_an_allowed_address_written_as_a_strkey() {
    let w = world();
    let args = Vec::from_array(&w.e, [w.custody.to_string().to_val()]);
    assert!(run(
        &w,
        Vec::from_array(
            &w.e,
            [call_to(
                &w.e,
                &w.gate,
                if args.len() == 2 { "two" } else { "one" },
                args
            )]
        )
    )
    .is_ok());
}

#[test]
fn permits_data_that_cannot_denote_an_address() {
    let w = world();
    let blob = Bytes::from_array(&w.e, &[7u8; 64]);
    let note = SString::from_str(&w.e, "settlement 42");
    let args = Vec::from_array(&w.e, [blob.to_val(), note.to_val()]);
    assert!(run(
        &w,
        Vec::from_array(
            &w.e,
            [call_to(
                &w.e,
                &w.gate,
                if args.len() == 2 { "two" } else { "one" },
                args
            )]
        )
    )
    .is_ok());
}

#[test]
fn refuses_an_authorization_it_cannot_check() {
    let w = world();
    let deploy = InvokerContractAuthEntry::CreateContractHostFn(
        soroban_sdk::auth::CreateContractHostFnContext {
            executable: soroban_sdk::auth::ContractExecutable::Wasm(
                soroban_sdk::BytesN::from_array(&w.e, &[0u8; 32]),
            ),
            salt: soroban_sdk::BytesN::from_array(&w.e, &[1u8; 32]),
        },
    );
    let mut c = call_to(&w.e, &w.gate, "ping", Vec::new(&w.e));
    c.executor_authorizations = Vec::from_array(&w.e, [deploy]);
    refused(&w, Vec::from_array(&w.e, [c]), E::Uncheckable);
}

#[test]
fn the_binding_moves_only_with_the_gate_custody() {
    let w = world();
    let allowed = Vec::from_array(&w.e, [w.custody.clone()]);
    let successor = w.e.register(FixtureGate, (allowed, w.custody.clone()));
    ExecutionAdapterClient::new(&w.e, &w.adapter).rebind(&successor);
    let bound: Address = w.e.as_contract(&w.adapter, || {
        w.e.storage()
            .instance()
            .get(&symbol_short!("gate"))
            .unwrap()
    });
    assert_eq!(bound, successor);
}

/// A successor that cannot answer `custody` would be FINAL: `execute` reads
/// `allowed` from the binding and `rebind` reads `custody`, so an address that
/// is neither leaves the adapter unusable and unrebindable; recovery means a
/// whole new gate generation, and every rule scoped to the old adapter address
/// dies with it. Reproduced on testnet before the check existed: rebound to a
/// SAC, both calls failed Error(Value, InvalidInput) for good.
#[test]
#[should_panic]
fn a_successor_that_is_not_a_gate_is_refused() {
    let w = world();
    // A contract with neither entry point - the shape a mistyped address takes.
    let not_a_gate = w.e.register(Bystander, ());
    ExecutionAdapterClient::new(&w.e, &w.adapter).rebind(&not_a_gate);
}

#[test]
fn the_binding_is_unchanged_after_a_refused_rebind() {
    let w = world();
    let not_a_gate = w.e.register(Bystander, ());
    let attempt = ExecutionAdapterClient::new(&w.e, &w.adapter).try_rebind(&not_a_gate);
    assert!(attempt.is_err());
    let bound: Address = w.e.as_contract(&w.adapter, || {
        w.e.storage()
            .instance()
            .get(&symbol_short!("gate"))
            .unwrap()
    });
    assert_eq!(bound, w.gate);
}

/// THE LENGTHS THE ADDRESS WALK COMPARES OR REFUSES ARE THE WHOLE
/// CONSTRUCTIBLE SET, and this is the tripwire for the strkey one. A contract
/// can build an `Address` from data four ways: `from_string` and
/// `from_string_bytes`, which take a 56-character G or C strkey,
/// `from_payload`, which takes the raw 32 bytes, and `from_xdr`, which takes the
/// XDR of an address value (40 bytes for a contract, 44 for an account). A
/// muxed address has two more spellings, both refused outright by the walk: the
/// 69-character `M` strkey that `MuxedAddress::from_string` takes, and its
/// 48-byte XDR. `Address::from_string` itself refuses the `M` strkey - "unexpected
/// strkey length" - which is what this test holds. If a protocol ever widens
/// what it accepts, this test fails and `scan_data` needs the new length.
#[test]
#[should_panic]
fn a_muxed_strkey_is_not_an_address_this_host_can_build() {
    let e = Env::default();
    let muxed = "MBSRYJ7BNJNEOCMQ5EBAJOTSLHWAOQXSSUUYECRU7KWZVXGAZ5PXGAIBAEAQCAIBAGQ7A";
    assert_eq!(muxed.len(), 69);
    Address::from_string(&SString::from_str(&e, muxed));
}

/// Where custody expects the adapter: the Prime deploys it, and the salt
/// commits to the gate and both numbers.
fn agreed_address(e: &Env, prime: &Address, gate: &Address, min_wait: u32, window: u32) -> Address {
    derived(e, prime, Some(gate.clone()), min_wait, window, "v5")
}

/// The derivation of either adapter version. `v5`, this one, hashes the XDR
/// of the tuple `(gate, min_wait, window)`, "no gate" being a void; `v4`, the
/// deployed build, hashed the XDR of each part in turn.
fn derived(
    e: &Env,
    prime: &Address,
    gate: Option<Address>,
    min_wait: u32,
    window: u32,
    version: &str,
) -> Address {
    let mut b = Bytes::from_slice(e, b"prime.execution.adapter.");
    b.append(&Bytes::from_slice(e, version.as_bytes()));
    if version == "v5" {
        b.append(&(gate, min_wait, window).to_xdr(e));
    } else {
        b.append(&gate.to_xdr(e));
        b.append(&min_wait.to_xdr(e));
        b.append(&window.to_xdr(e));
    }
    e.deployer()
        .with_address(prime.clone(), e.crypto().sha256(&b))
        .deployed_address()
}

fn creation_refused(at: impl FnOnce(&Env, &Address, &Address) -> Address, args: (u32, u32)) {
    let e = Env::default();
    let prime = Address::generate(&e);
    let custody = Address::generate(&e);
    let gate = e.register(FixtureGate, (Vec::<Address>::new(&e), custody));
    let at = at(&e, &prime, &gate);
    let attempt = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        e.register_at(
            &at,
            ExecutionAdapter,
            (prime.clone(), gate.clone(), args.0, args.1),
        );
    }));
    assert!(
        attempt.is_err(),
        "the adapter was created where custody did not agree"
    );
}

#[test]
fn a_lower_minimum_than_the_address_commits_to_is_refused() {
    // Custody named the adapter for a minimum wait of 17280; the Prime tries 0.
    creation_refused(|e, p, g| agreed_address(e, p, g, 17_280, 100), (0, 100));
}

#[test]
fn a_different_window_than_the_address_commits_to_is_refused() {
    creation_refused(|e, p, g| agreed_address(e, p, g, 0, 100), (0, 1_000_000));
}

#[test]
fn an_address_that_is_not_derived_at_all_is_refused() {
    creation_refused(|e, _, _| Address::generate(e), (0, 100));
}

// ---------------------------------------------------------------- waiting ---

fn client(w: &World) -> ExecutionAdapterClient<'_> {
    ExecutionAdapterClient::new(&w.e, &w.adapter)
}

fn bump_batch(w: &World) -> Vec<Call> {
    Vec::from_array(&w.e, [call_to(&w.e, &w.gate, "bump", Vec::new(&w.e))])
}

fn count(w: &World) -> u32 {
    FixtureGateClient::new(&w.e, &w.gate).count()
}

fn advance(w: &World, ledgers: u32) {
    let now = w.e.ledger().sequence();
    w.e.ledger().set_sequence_number(now + ledgers);
}

fn contract_error<T: core::fmt::Debug, C: core::fmt::Debug>(
    got: Result<T, Result<soroban_sdk::Error, C>>,
    want: E,
) {
    match got {
        Err(Ok(e)) => assert_eq!(e, soroban_sdk::Error::from_contract_error(want as u32)),
        other => panic!("expected {:?}, got {:?}", want, other),
    }
}

fn no_grants(w: &World) -> Vec<InvokerContractAuthEntry> {
    Vec::new(&w.e)
}

#[test]
fn a_zero_wait_runs_the_batch_at_once() {
    let w = world();
    assert_eq!(
        client(&w).execute(&bump_batch(&w), &no_grants(&w), &0),
        None
    );
    assert_eq!(count(&w), 1);
}

#[test]
fn a_wait_stores_the_batch_and_it_runs_once_the_wait_is_over() {
    let w = world();
    let id = client(&w).execute(&bump_batch(&w), &no_grants(&w), &10);
    assert_eq!(id, Some(1));
    assert_eq!(count(&w), 0, "nothing runs while it waits");

    advance(&w, 9);
    contract_error(client(&w).try_run(&1), E::NotRunnable);

    advance(&w, 1);
    client(&w).run(&1);
    assert_eq!(count(&w), 1);

    // It runs once: the second attempt finds nothing stored.
    contract_error(client(&w).try_run(&1), E::NotScheduled);
    assert_eq!(count(&w), 1);
}

#[test]
fn each_stored_batch_gets_the_next_number() {
    let w = world();
    assert_eq!(
        client(&w).execute(&bump_batch(&w), &no_grants(&w), &5),
        Some(1)
    );
    assert_eq!(
        client(&w).execute(&bump_batch(&w), &no_grants(&w), &5),
        Some(2)
    );
    // A batch run at once takes no number.
    assert_eq!(
        client(&w).execute(&bump_batch(&w), &no_grants(&w), &0),
        None
    );
    assert_eq!(
        client(&w).execute(&bump_batch(&w), &no_grants(&w), &5),
        Some(3)
    );
}

#[test]
fn the_prime_approves_the_wait_with_the_batch() {
    let w = world();
    let calls = bump_batch(&w);
    client(&w).execute(&calls, &no_grants(&w), &10);
    let auths = w.e.auths();
    let (who, inv) = auths.first().expect("the Prime authorised the schedule");
    assert_eq!(*who, w.prime);
    let soroban_sdk::testutils::AuthorizedFunction::Contract((contract, f, args)) = &inv.function
    else {
        panic!("expected a contract call")
    };
    assert_eq!(*contract, w.adapter);
    assert_eq!(*f, Symbol::new(&w.e, "execute"));
    let want: Vec<Val> = vec![
        &w.e,
        calls.into_val(&w.e),
        no_grants(&w).into_val(&w.e),
        10u32.into_val(&w.e),
    ];
    assert_eq!(*args, want);
}

#[test]
fn the_adapter_minimum_binds_every_caller() {
    let w = world_with(5, 100);
    contract_error(
        client(&w).try_execute(&bump_batch(&w), &no_grants(&w), &0),
        E::WaitTooShort,
    );
    contract_error(
        client(&w).try_execute(&bump_batch(&w), &no_grants(&w), &4),
        E::WaitTooShort,
    );
    assert_eq!(
        client(&w).execute(&bump_batch(&w), &no_grants(&w), &5),
        Some(1)
    );
    assert_eq!(count(&w), 0);
}

#[test]
fn a_batch_runs_up_to_the_last_ledger_of_its_window() {
    let w = world_with(0, 3);
    client(&w).execute(&bump_batch(&w), &no_grants(&w), &10);
    advance(&w, 13);
    client(&w).run(&1);
    assert_eq!(count(&w), 1);
}

#[test]
fn a_batch_lapses_after_its_window() {
    let w = world_with(0, 3);
    client(&w).execute(&bump_batch(&w), &no_grants(&w), &10);
    advance(&w, 14);
    contract_error(client(&w).try_run(&1), E::NotRunnable);
    assert_eq!(count(&w), 0);
    // A lapsed batch can still be tidied away.
    client(&w).cancel(&1, &w.prime);
}

#[test]
fn a_run_window_of_zero_leaves_exactly_the_ready_ledger() {
    let w = world_with(0, 0);
    client(&w).execute(&bump_batch(&w), &no_grants(&w), &10);
    advance(&w, 11);
    contract_error(client(&w).try_run(&1), E::NotRunnable);
    let w = world_with(0, 0);
    client(&w).execute(&bump_batch(&w), &no_grants(&w), &10);
    advance(&w, 10);
    client(&w).run(&1);
    assert_eq!(count(&w), 1);
}

#[test]
fn a_wait_past_the_last_ledger_is_refused() {
    let w = world();
    assert!(client(&w)
        .try_execute(&bump_batch(&w), &no_grants(&w), &u32::MAX)
        .is_err());
}

#[test]
fn the_prime_can_cancel_a_waiting_batch() {
    let w = world();
    client(&w).execute(&bump_batch(&w), &no_grants(&w), &10);
    client(&w).cancel(&1, &w.prime);
    let (who, _) =
        w.e.auths()
            .first()
            .cloned()
            .expect("cancelling needs approval");
    assert_eq!(who, w.prime);
    advance(&w, 10);
    contract_error(client(&w).try_run(&1), E::NotScheduled);
    assert_eq!(count(&w), 0);
}

#[test]
fn custody_can_cancel_a_ready_batch() {
    let w = world();
    client(&w).execute(&bump_batch(&w), &no_grants(&w), &10);
    advance(&w, 12);
    client(&w).cancel(&1, &w.custody);
    contract_error(client(&w).try_run(&1), E::NotScheduled);
    assert_eq!(count(&w), 0);
}

#[test]
fn nobody_else_can_cancel() {
    let w = world();
    client(&w).execute(&bump_batch(&w), &no_grants(&w), &10);
    contract_error(client(&w).try_cancel(&1, &w.stranger), E::NotACanceller);
    advance(&w, 10);
    client(&w).run(&1);
    assert_eq!(count(&w), 1);
}

#[test]
fn a_batch_is_checked_before_it_is_stored() {
    let w = world();
    let calls = Vec::from_array(&w.e, [call_to(&w.e, &w.stranger, "ping", Vec::new(&w.e))]);
    contract_error(
        client(&w).try_execute(&calls, &no_grants(&w), &10),
        E::AddressNotAllowed,
    );
}

#[test]
fn a_batch_is_checked_again_against_the_gate_bound_when_it_runs() {
    let w = world();
    // Allowed by the gate it was scheduled under: the custody address.
    let args = Vec::from_array(&w.e, [w.custody.to_val()]);
    let calls = Vec::from_array(&w.e, [call_to(&w.e, &w.gate, "one", args)]);
    client(&w).execute(&calls, &no_grants(&w), &10);

    // Custody rebinds to a gate that no longer lists itself or the old gate.
    let narrower =
        w.e.register(FixtureGate, (Vec::<Address>::new(&w.e), w.custody.clone()));
    client(&w).rebind(&narrower);
    advance(&w, 10);
    contract_error(client(&w).try_run(&1), E::AddressNotAllowed);
}

#[test]
fn running_asks_the_prime_to_approve_the_run() {
    let w = world();
    client(&w).execute(&bump_batch(&w), &no_grants(&w), &10);
    advance(&w, 10);
    client(&w).run(&1);
    let (who, inv) =
        w.e.auths()
            .first()
            .cloned()
            .expect("the Prime approved the run");
    assert_eq!(who, w.prime);
    let soroban_sdk::testutils::AuthorizedFunction::Contract((contract, f, args)) = inv.function
    else {
        panic!("expected a contract call")
    };
    assert_eq!(contract, w.adapter);
    assert_eq!(f, Symbol::new(&w.e, "run"));
    assert_eq!(args, vec![&w.e, 1u32.into_val(&w.e)]);
}

#[test]
fn a_stored_move_lives_until_its_window_closes() {
    let w = world_with(0, 100);
    // Longer than the minimum lifetime a new entry gets in this environment.
    let min = w.e.as_contract(&w.adapter, || {
        w.e.storage().persistent().set(&999u32, &1u32);
        w.e.storage().persistent().get_ttl(&999u32)
    });
    let wait = min + 5_000;
    client(&w).execute(&bump_batch(&w), &no_grants(&w), &wait);
    let ttl =
        w.e.as_contract(&w.adapter, || w.e.storage().persistent().get_ttl(&1u32));
    assert!(
        ttl >= wait + 100,
        "lives {ttl} ledgers, needs {}",
        wait + 100
    );
    // A short wait keeps the minimum; nothing is shortened.
    client(&w).execute(&bump_batch(&w), &no_grants(&w), &10);
    let ttl =
        w.e.as_contract(&w.adapter, || w.e.storage().persistent().get_ttl(&2u32));
    assert_eq!(ttl, min);
}

#[test]
fn using_the_adapter_keeps_its_instance_alive() {
    let w = world();
    let before =
        w.e.as_contract(&w.adapter, || w.e.storage().instance().get_ttl());
    assert!(before < KEEP_BELOW);
    client(&w).execute(&bump_batch(&w), &no_grants(&w), &0);
    let after =
        w.e.as_contract(&w.adapter, || w.e.storage().instance().get_ttl());
    assert_eq!(after, KEEP_TO);
}

/// The Stellar Asset Contract's protocol-23 `transfer`: `to` is a
/// MuxedAddress, and the account behind it is credited.
#[contract]
pub struct MuxToken;

#[contractimpl]
impl MuxToken {
    pub fn transfer(e: Env, from: Address, to: soroban_sdk::MuxedAddress, amount: i128) {
        from.require_auth();
        let k = to.address();
        let b: i128 = e.storage().persistent().get(&k).unwrap_or(0);
        e.storage().persistent().set(&k, &(b + amount));
    }
    pub fn balance(e: Env, of: Address) -> i128 {
        e.storage().persistent().get(&of).unwrap_or(0)
    }
}

mod muxed {
    use super::*;
    use soroban_sdk::{Map, MuxedAddress};

    const M: &str = "MBSRYJ7BNJNEOCMQ5EBAJOTSLHWAOQXSSUUYECRU7KWZVXGAZ5PXGAIBAEAQCAIBAGQ7A";

    struct Muxed {
        w: World,
        token: Address,
    }

    fn setup(min_wait: u32) -> Muxed {
        let e = Env::default();
        e.ledger().set_sequence_number(1_000);
        e.mock_all_auths();
        let prime = Address::generate(&e);
        let custody = Address::generate(&e);
        let stranger = Address::generate(&e);
        let token = e.register(MuxToken, ());
        let allowed = Vec::from_array(&e, [custody.clone(), prime.clone(), token.clone()]);
        let gate = e.register(FixtureGate, (allowed, custody.clone()));
        let at = agreed_address(&e, &prime, &gate, min_wait, 100);
        let adapter = e.register_at(
            &at,
            ExecutionAdapter,
            (prime.clone(), gate.clone(), min_wait, 100u32),
        );
        Muxed {
            w: World {
                e,
                adapter,
                gate,
                prime,
                custody,
                stranger,
            },
            token,
        }
    }

    fn transfer_to(m: &Muxed, to: Val) -> Vec<Call> {
        let e = &m.w.e;
        let args = Vec::from_array(e, [m.w.prime.to_val(), to, 100i128.into_val(e)]);
        Vec::from_array(e, [call_to(e, &m.token, "transfer", args)])
    }

    fn paid(m: &Muxed, who: &Address) -> i128 {
        MuxTokenClient::new(&m.w.e, &m.token).balance(who)
    }

    #[test]
    fn a_plain_stranger_is_refused() {
        let m = setup(0);
        let calls = transfer_to(&m, m.w.stranger.to_val());
        refused(&m.w, calls, E::AddressNotAllowed);
        assert_eq!(paid(&m, &m.w.stranger), 0);
    }

    #[test]
    fn a_muxed_stranger_is_refused_and_not_paid() {
        let m = setup(0);
        let muxed = MuxedAddress::from_str(&m.w.e, M);
        let underlying = muxed.address();
        let calls = transfer_to(&m, muxed.to_val());
        refused(&m.w, calls, E::Uncheckable);
        assert_eq!(paid(&m, &underlying), 0);
    }

    #[test]
    fn a_muxed_stranger_is_refused_before_it_is_stored() {
        let m = setup(720);
        let muxed = MuxedAddress::from_str(&m.w.e, M);
        let underlying = muxed.address();
        let calls = transfer_to(&m, muxed.to_val());
        contract_error(
            client(&m.w).try_execute(&calls, &no_grants(&m.w), &720),
            E::Uncheckable,
        );
        advance(&m.w, 720);
        contract_error(client(&m.w).try_run(&1), E::NotScheduled);
        assert_eq!(paid(&m, &underlying), 0);
    }

    #[test]
    fn a_muxed_value_buried_in_a_vec_or_map_is_refused() {
        let m = setup(0);
        let e = &m.w.e;
        let muxed = MuxedAddress::from_str(e, M);
        let nested: Vec<Val> = Vec::from_array(e, [muxed.to_val()]);
        refused(
            &m.w,
            Vec::from_array(
                e,
                [call_to(
                    e,
                    &m.w.gate,
                    "one",
                    Vec::from_array(e, [nested.to_val()]),
                )],
            ),
            E::Uncheckable,
        );
        let mut map: Map<Val, Val> = Map::new(e);
        map.set(1u32.into_val(e), muxed.to_val());
        refused(
            &m.w,
            Vec::from_array(
                e,
                [call_to(
                    e,
                    &m.w.gate,
                    "one",
                    Vec::from_array(e, [map.to_val()]),
                )],
            ),
            E::Uncheckable,
        );
    }

    #[test]
    fn a_muxed_strkey_as_text_or_bytes_is_refused() {
        let m = setup(0);
        let e = &m.w.e;
        let as_string = SString::from_str(e, M);
        let as_bytes = Bytes::from_slice(e, M.as_bytes());
        for v in [as_string.to_val(), as_bytes.to_val()] {
            let calls = Vec::from_array(e, [call_to(e, &m.w.gate, "one", Vec::from_array(e, [v]))]);
            refused(&m.w, calls, E::AddressNotAllowed);
        }
    }

    #[test]
    fn ordinary_values_still_pass() {
        let m = setup(0);
        let e = &m.w.e;
        let args: Vec<Val> = Vec::from_array(
            e,
            [
                u64::MAX.into_val(e),
                i64::MIN.into_val(e),
                u128::MAX.into_val(e),
                i128::MIN.into_val(e),
                7u32.into_val(e),
                true.into_val(e),
                symbol_short!("ok").into_val(e),
                Symbol::new(e, "a_longer_symbol_name").into_val(e),
                ().into_val(e),
                Bytes::from_slice(e, &[7u8; 68]).into_val(e),
                SString::from_str(e, "memo").into_val(e),
            ],
        );
        for a in args.iter() {
            let calls = Vec::from_array(e, [call_to(e, &m.w.gate, "one", Vec::from_array(e, [a]))]);
            assert!(run(&m.w, calls).is_ok());
        }
    }
}

/// A listed venue that reads a Bytes argument back as an address from its XDR.
#[contract]
pub struct XdrPay;

#[contractimpl]
impl XdrPay {
    pub fn pay(e: Env, to: Bytes, amount: i128) {
        use soroban_sdk::xdr::FromXdr as _;
        let who = Address::from_xdr(&e, &to).unwrap();
        let b: i128 = e.storage().persistent().get(&who).unwrap_or(0);
        e.storage().persistent().set(&who, &(b + amount));
    }
    pub fn balance(e: Env, of: Address) -> i128 {
        e.storage().persistent().get(&of).unwrap_or(0)
    }
}

mod xdr_bytes {
    use super::*;
    use soroban_sdk::MuxedAddress;

    const M: &str = "MBSRYJ7BNJNEOCMQ5EBAJOTSLHWAOQXSSUUYECRU7KWZVXGAZ5PXGAIBAEAQCAIBAGQ7A";

    fn setup(min_wait: u32) -> (World, Address, Address) {
        let e = Env::default();
        e.ledger().set_sequence_number(1_000);
        e.mock_all_auths();
        let prime = Address::generate(&e);
        let custody = Address::generate(&e);
        let stranger = Address::generate(&e);
        let token = e.register(MuxToken, ());
        let venue = e.register(XdrPay, ());
        let allowed = Vec::from_array(
            &e,
            [custody.clone(), prime.clone(), token.clone(), venue.clone()],
        );
        let gate = e.register(FixtureGate, (allowed, custody.clone()));
        let at = agreed_address(&e, &prime, &gate, min_wait, 100);
        let adapter = e.register_at(
            &at,
            ExecutionAdapter,
            (prime.clone(), gate.clone(), min_wait, 100u32),
        );
        let w = World {
            e,
            adapter,
            gate,
            prime,
            custody,
            stranger,
        };
        (w, token, venue)
    }

    fn pay_bytes(w: &World, venue: &Address, to: Bytes) -> Vec<Call> {
        let e = &w.e;
        let args = Vec::from_array(e, [to.to_val(), 100i128.into_val(e)]);
        Vec::from_array(e, [call_to(e, venue, "pay", args)])
    }

    #[test]
    fn the_xdr_of_a_stranger_is_refused_and_not_paid() {
        let (w, _, venue) = setup(0);
        let xdr = w.stranger.clone().to_xdr(&w.e);
        assert!(xdr.len() == 40 || xdr.len() == 44);
        refused(&w, pay_bytes(&w, &venue, xdr), E::AddressNotAllowed);
        assert_eq!(XdrPayClient::new(&w.e, &venue).balance(&w.stranger), 0);
    }

    #[test]
    fn both_xdr_lengths_of_an_address_are_refused() {
        let (w, _, venue) = setup(0);
        let e = &w.e;
        let key = soroban_sdk::BytesN::from_array(e, &[9u8; 32]);
        let contract = Address::from_payload(e, AddressPayload::ContractIdHash(key.clone()));
        let account = Address::from_payload(e, AddressPayload::AccountIdPublicKeyEd25519(key));
        assert_eq!(contract.clone().to_xdr(e).len(), 40);
        assert_eq!(account.clone().to_xdr(e).len(), 44);
        for stranger in [contract, account] {
            refused(
                &w,
                pay_bytes(&w, &venue, stranger.to_xdr(e)),
                E::AddressNotAllowed,
            );
        }
    }

    #[test]
    fn the_xdr_of_a_muxed_address_is_refused() {
        let (w, _, venue) = setup(0);
        let xdr = MuxedAddress::from_str(&w.e, M).to_xdr(&w.e);
        assert_eq!(xdr.len(), 48);
        refused(&w, pay_bytes(&w, &venue, xdr), E::AddressNotAllowed);
    }

    #[test]
    fn the_xdr_of_a_listed_address_still_passes() {
        let (w, _, venue) = setup(0);
        let xdr = w.custody.clone().to_xdr(&w.e);
        assert!(run(&w, pay_bytes(&w, &venue, xdr)).is_ok());
        assert_eq!(XdrPayClient::new(&w.e, &venue).balance(&w.custody), 100);
    }

    #[test]
    fn data_of_other_lengths_near_those_still_passes() {
        let (w, _, venue) = setup(0);
        for len in [39u32, 41, 43, 45, 47, 49, 68, 70] {
            let data = Bytes::from_slice(&w.e, &std::vec![7u8; len as usize]);
            let args = Vec::from_array(&w.e, [data.to_val()]);
            let calls = Vec::from_array(&w.e, [call_to(&w.e, &w.gate, "one", args)]);
            assert!(run(&w, calls).is_ok(), "length {len} refused");
        }
        let _ = venue;
    }

    /// `run` checks again before it invokes anything. A stored muxed batch
    /// cannot arrive through `execute` on this build, so it is written
    /// straight into the adapter's storage, the way one stored by an earlier
    /// build would sit there.
    #[test]
    fn run_refuses_a_stored_muxed_batch() {
        let (w, token, _) = setup(720);
        let e = &w.e;
        let muxed = MuxedAddress::from_str(e, M);
        let args = Vec::from_array(e, [w.prime.to_val(), muxed.to_val(), 100i128.into_val(e)]);
        let calls = Vec::from_array(e, [call_to(e, &token, "transfer", args)]);
        let stored: Stored = (calls, Vec::new(e), 1_000 + 720);
        e.as_contract(&w.adapter, || e.storage().persistent().set(&1u32, &stored));
        advance(&w, 720);
        contract_error(client(&w).try_run(&1), E::Uncheckable);
        assert_eq!(MuxTokenClient::new(e, &token).balance(&muxed.address()), 0);
    }
}

/// An adapter created with no gate: no address is checked, so the Prime can
/// bundle its own calls, and the binding can never change.
mod null_gate {
    use super::*;
    use soroban_sdk::{testutils::AuthorizedFunction, MuxedAddress};

    /// Stands in for any contract a bundle calls first: `hello(true)` fails.
    #[contract]
    pub struct Hello;

    #[contractimpl]
    impl Hello {
        pub fn hello(_e: Env, fail: bool) -> u32 {
            assert!(!fail, "hello failed");
            7
        }
    }

    struct Null {
        e: Env,
        adapter: Address,
        prime: Address,
        stranger: Address,
        token: Address,
        hello: Address,
    }

    fn null_world() -> Null {
        let e = Env::default();
        e.ledger().set_sequence_number(1_000);
        e.mock_all_auths();
        let prime = Address::generate(&e);
        let stranger = Address::generate(&e);
        let token = e.register(MuxToken, ());
        let hello = e.register(Hello, ());
        let at = derived(&e, &prime, None, 0, 100, "v5");
        let adapter = e.register_at(
            &at,
            ExecutionAdapter,
            (prime.clone(), None::<Address>, 0u32, 100u32),
        );
        Null {
            e,
            adapter,
            prime,
            stranger,
            token,
            hello,
        }
    }

    fn c(n: &Null) -> ExecutionAdapterClient<'_> {
        ExecutionAdapterClient::new(&n.e, &n.adapter)
    }

    fn hello(n: &Null, fail: bool) -> Call {
        call_to(
            &n.e,
            &n.hello,
            "hello",
            Vec::from_array(&n.e, [fail.into_val(&n.e)]),
        )
    }

    /// `token.transfer(prime, to, 100)`: the Prime's own funds.
    fn pay(n: &Null, to: Val) -> Call {
        let args = Vec::from_array(&n.e, [n.prime.to_val(), to, 100i128.into_val(&n.e)]);
        call_to(&n.e, &n.token, "transfer", args)
    }

    fn paid(n: &Null, who: &Address) -> i128 {
        MuxTokenClient::new(&n.e, &n.token).balance(who)
    }

    fn none(n: &Null) -> Vec<InvokerContractAuthEntry> {
        Vec::new(&n.e)
    }

    fn gate_of(n: &Null) -> Option<Address> {
        n.e.as_contract(&n.adapter, || {
            n.e.storage()
                .instance()
                .get::<_, Option<Address>>(&symbol_short!("gate"))
                .flatten()
        })
    }

    #[test]
    fn the_batch_runs_with_no_address_checked() {
        let n = null_world();
        let muxed = MuxedAddress::from_str(
            &n.e,
            "MBSRYJ7BNJNEOCMQ5EBAJOTSLHWAOQXSSUUYECRU7KWZVXGAZ5PXGAIBAEAQCAIBAGQ7A",
        );
        let calls = Vec::from_array(
            &n.e,
            [
                hello(&n, false),
                pay(&n, n.stranger.to_val()),
                pay(&n, muxed.to_val()),
            ],
        );
        assert_eq!(c(&n).execute(&calls, &none(&n), &0), None);
        assert_eq!(paid(&n, &n.stranger), 100);
        assert_eq!(paid(&n, &muxed.address()), 100);
        assert_eq!(gate_of(&n), None);
    }

    #[test]
    fn nothing_moves_when_a_call_fails() {
        let n = null_world();
        for calls in [
            [hello(&n, true), pay(&n, n.stranger.to_val())],
            [pay(&n, n.stranger.to_val()), hello(&n, true)],
        ] {
            let calls = Vec::from_array(&n.e, calls);
            assert!(c(&n).try_execute(&calls, &none(&n), &0).is_err());
            assert_eq!(paid(&n, &n.stranger), 0);
        }
    }

    #[test]
    fn one_approval_by_the_prime_covers_its_own_calls() {
        let n = null_world();
        let calls = Vec::from_array(
            &n.e,
            [
                hello(&n, false),
                pay(&n, n.stranger.to_val()),
                pay(&n, n.stranger.to_val()),
            ],
        );
        c(&n).execute(&calls, &none(&n), &0);
        let auths = n.e.auths();
        assert_eq!(auths.len(), 1, "one approval, by the Prime");
        let (who, inv) = &auths[0];
        assert_eq!(*who, n.prime);
        let AuthorizedFunction::Contract((contract, f, _)) = &inv.function else {
            panic!("expected a contract call")
        };
        assert_eq!((contract, f), (&n.adapter, &Symbol::new(&n.e, "execute")));
        assert_eq!(inv.sub_invocations.len(), 2, "both transfers sit under it");
        assert_eq!(paid(&n, &n.stranger), 200);
    }

    #[test]
    fn the_prime_is_still_refused_as_a_target() {
        let n = null_world();
        let calls = Vec::from_array(&n.e, [call_to(&n.e, &n.prime, "ping", Vec::new(&n.e))]);
        contract_error(c(&n).try_execute(&calls, &none(&n), &0), E::PrimeTarget);
    }

    /// A null adapter holds nothing and acts as itself only towards the
    /// contracts it calls directly: with no list there is nothing to check an
    /// authorization against, so it hands none out.
    #[test]
    fn it_hands_out_no_authorization_as_itself() {
        let n = null_world();
        let entry = InvokerContractAuthEntry::Contract(soroban_sdk::auth::SubContractInvocation {
            context: soroban_sdk::auth::ContractContext {
                contract: n.token.clone(),
                fn_name: Symbol::new(&n.e, "transfer"),
                args: Vec::new(&n.e),
            },
            sub_invocations: Vec::new(&n.e),
        });
        let entries = Vec::from_array(&n.e, [entry]);
        let batch = Vec::from_array(&n.e, [hello(&n, false)]);
        contract_error(c(&n).try_execute(&batch, &entries, &0), E::Uncheckable);
        let mut call = hello(&n, false);
        call.executor_authorizations = entries;
        let batch = Vec::from_array(&n.e, [call]);
        contract_error(c(&n).try_execute(&batch, &none(&n), &0), E::Uncheckable);
    }

    /// A stored batch of the Prime's own funds would run under rules this
    /// adapter signs, which nothing else bounds without a list.
    #[test]
    fn nothing_waits() {
        let n = null_world();
        let calls = Vec::from_array(&n.e, [pay(&n, n.stranger.to_val())]);
        contract_error(c(&n).try_execute(&calls, &none(&n), &1), E::NoWait);
        let stored =
            n.e.as_contract(&n.adapter, || n.e.storage().persistent().has(&1u32));
        assert!(!stored);
        n.e.ledger()
            .set_sequence_number(n.e.ledger().sequence() + 1);
        contract_error(c(&n).try_run(&1), E::NotScheduled);
        assert_eq!(paid(&n, &n.stranger), 0);
    }

    #[test]
    fn a_null_adapter_with_a_minimum_wait_is_never_created() {
        let e = Env::default();
        let prime = Address::generate(&e);
        let at = derived(&e, &prime, None, 10, 100, "v5");
        let attempt = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            e.register_at(
                &at,
                ExecutionAdapter,
                (prime.clone(), None::<Address>, 10u32, 100u32),
            );
        }));
        assert!(attempt.is_err());
    }

    #[test]
    fn only_the_prime_cancels() {
        let n = null_world();
        contract_error(c(&n).try_cancel(&1, &n.stranger), E::NotACanceller);
        c(&n).cancel(&1, &n.prime);
        let (who, _) =
            n.e.auths()
                .first()
                .cloned()
                .expect("cancelling needs approval");
        assert_eq!(who, n.prime);
    }

    #[test]
    fn a_null_adapter_can_never_be_bound() {
        let n = null_world();
        let gate =
            n.e.register(FixtureGate, (Vec::<Address>::new(&n.e), n.prime.clone()));
        contract_error(c(&n).try_rebind(&gate), E::NoGate);
        assert_eq!(gate_of(&n), None);
    }

    #[test]
    fn a_gated_adapter_can_never_become_null() {
        let w = world();
        let attempt = w.e.try_invoke_contract::<(), soroban_sdk::Error>(
            &w.adapter,
            &Symbol::new(&w.e, "rebind"),
            vec![&w.e, ().into_val(&w.e)],
        );
        assert!(attempt.is_err());
        let bound: Address = w.e.as_contract(&w.adapter, || {
            w.e.storage()
                .instance()
                .get(&symbol_short!("gate"))
                .unwrap()
        });
        assert_eq!(bound, w.gate);
    }

    /// No gate, a gate, and the v4 derivation all give different addresses,
    /// so the constructor refuses to run where another binding was agreed.
    #[test]
    fn each_binding_has_its_own_address() {
        let e = Env::default();
        let prime = Address::generate(&e);
        let gate = e.register(FixtureGate, (Vec::<Address>::new(&e), prime.clone()));
        let null = derived(&e, &prime, None, 0, 100, "v5");
        let gated = derived(&e, &prime, Some(gate.clone()), 0, 100, "v5");
        let v4 = derived(&e, &prime, Some(gate.clone()), 0, 100, "v4");
        assert!(null != gated && gated != v4 && null != v4);
        assert_eq!(None::<Address>.to_xdr(&e).len(), 4, "a void value");
        for (at, binding) in [
            (&gated, None),
            (&null, Some(gate.clone())),
            (&v4, Some(gate)),
        ] {
            let attempt = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                e.register_at(at, ExecutionAdapter, (prime.clone(), binding, 0u32, 100u32));
            }));
            assert!(attempt.is_err(), "created where another binding was agreed");
        }
    }
}

/// The fifth spelling `scan_data` compares: the raw 32 bytes of an account key
/// or contract id, which `Address::from_payload` takes.
mod raw_keys {
    use super::*;

    fn raw(a: &Address) -> Bytes {
        match a.to_payload() {
            Some(AddressPayload::ContractIdHash(p))
            | Some(AddressPayload::AccountIdPublicKeyEd25519(p)) => Bytes::from(p),
            None => panic!("no payload"),
        }
    }

    fn one(w: &World, data: Bytes) -> Vec<Call> {
        let args = Vec::from_array(&w.e, [data.to_val()]);
        Vec::from_array(&w.e, [call_to(&w.e, &w.gate, "one", args)])
    }

    #[test]
    fn the_raw_key_of_a_stranger_is_refused() {
        let w = world();
        let data = raw(&w.stranger);
        assert_eq!(data.len(), 32);
        refused(&w, one(&w, data), E::AddressNotAllowed);
    }

    #[test]
    fn the_raw_key_of_a_listed_address_passes() {
        let w = world();
        assert!(run(&w, one(&w, raw(&w.custody))).is_ok());
    }
}

/// The grant walk steps into sub-invocations (review-opb26 L1): with a gate,
/// that step is all that stops a grant whose second level names a stranger.
mod grant_depth {
    use super::*;
    use soroban_sdk::auth::{ContractContext, SubContractInvocation};

    fn entry(
        e: &Env,
        to: &Address,
        subs: Vec<InvokerContractAuthEntry>,
    ) -> InvokerContractAuthEntry {
        InvokerContractAuthEntry::Contract(SubContractInvocation {
            context: ContractContext {
                contract: to.clone(),
                fn_name: Symbol::new(e, "ping"),
                args: Vec::new(e),
            },
            sub_invocations: subs,
        })
    }

    #[test]
    fn a_stranger_in_a_grant_sub_invocation_is_refused() {
        let w = world();
        let inner = Vec::from_array(&w.e, [entry(&w.e, &w.stranger, Vec::new(&w.e))]);
        let grants = Vec::from_array(&w.e, [entry(&w.e, &w.gate, inner)]);
        let calls = Vec::from_array(&w.e, [call_to(&w.e, &w.gate, "ping", Vec::new(&w.e))]);
        contract_error(
            client(&w).try_execute(&calls, &grants, &0),
            E::AddressNotAllowed,
        );
        let mut c = call_to(&w.e, &w.gate, "ping", Vec::new(&w.e));
        let inner = Vec::from_array(&w.e, [entry(&w.e, &w.stranger, Vec::new(&w.e))]);
        c.executor_authorizations = Vec::from_array(&w.e, [entry(&w.e, &w.gate, inner)]);
        refused(&w, Vec::from_array(&w.e, [c]), E::AddressNotAllowed);
    }

    #[test]
    fn a_listed_grant_sub_invocation_passes() {
        let w = world();
        let inner = Vec::from_array(&w.e, [entry(&w.e, &w.custody, Vec::new(&w.e))]);
        let grants = Vec::from_array(&w.e, [entry(&w.e, &w.gate, inner)]);
        let calls = Vec::from_array(&w.e, [call_to(&w.e, &w.gate, "ping", Vec::new(&w.e))]);
        assert!(client(&w).try_execute(&calls, &grants, &0).is_ok());
    }
}

/// A callee two levels down that asks this adapter for its authorization.
#[contract]
pub struct Needy;

#[contractimpl]
impl Needy {
    pub fn need(e: Env, who: Address) {
        who.require_auth();
        let n: u32 = e.storage().instance().get(&symbol_short!("n")).unwrap_or(0);
        e.storage().instance().set(&symbol_short!("n"), &(n + 1));
    }
    pub fn count(e: Env) -> u32 {
        e.storage().instance().get(&symbol_short!("n")).unwrap_or(0)
    }
}

/// Calls `Needy.need(who)`, so the adapter is not `Needy`'s direct caller.
#[contract]
pub struct Relay;

#[contractimpl]
impl Relay {
    pub fn go(e: Env, needy: Address, who: Address) {
        NeedyClient::new(&e, &needy).need(&who);
    }
}

/// A Prime whose own check asks the adapter for its authorization, the way
/// an OpenZeppelin account's rule signed by the adapter does: it calls
/// `Needy.need(adapter)` from `__check_auth` when it was created with `needy`.
#[contract]
pub struct AskingPrime;

#[contractimpl]
impl AskingPrime {
    pub fn __constructor(e: Env, needy: Option<Address>) {
        e.storage().instance().set(&symbol_short!("needy"), &needy);
    }
}

#[contractimpl]
impl soroban_sdk::auth::CustomAccountInterface for AskingPrime {
    type Signature = ();
    type Error = soroban_sdk::Error;

    #[allow(non_snake_case)]
    fn __check_auth(
        e: Env,
        _payload: soroban_sdk::crypto::Hash<32>,
        _signature: (),
        contexts: Vec<soroban_sdk::auth::Context>,
    ) -> Result<(), soroban_sdk::Error> {
        let needy: Option<Address> = e.storage().instance().get(&symbol_short!("needy")).unwrap();
        if let (Some(needy), Some(soroban_sdk::auth::Context::Contract(c))) =
            (needy, contexts.get(0))
        {
            NeedyClient::new(&e, &needy).need(&c.contract);
        }
        Ok(())
    }
}

/// Grants and `executor_authorizations` reach the code that asks for them
/// (review-opb26 L2). Nothing is mocked: the Prime signs a real entry, and
/// the adapter's authorization holds only if the adapter handed it out.
///
/// A batch's grants live for the adapter's next sub-call, which is the
/// Prime's `__check_auth` for the batch: that is where a rule signed by the
/// adapter asks for it. A call's `executor_authorizations` live for that
/// call.
mod handed_out {
    use super::*;
    use soroban_sdk::{
        auth::{ContractContext, SubContractInvocation},
        xdr::{
            InvokeContractArgs, ScAddress, ScSymbol, ScVal, SorobanAddressCredentials,
            SorobanAuthorizationEntry, SorobanAuthorizedFunction, SorobanAuthorizedInvocation,
            SorobanCredentials, VecM,
        },
        TryFromVal,
    };

    struct H {
        e: Env,
        adapter: Address,
        prime: Address,
        relay: Address,
        needy: Address,
    }

    /// `asks`: whether the Prime's own check asks the adapter.
    fn setup(asks: bool) -> H {
        let e = Env::default();
        e.ledger().set_sequence_number(1_000);
        let custody = Address::generate(&e);
        let relay = e.register(Relay, ());
        let needy = e.register(Needy, ());
        let prime = e.register(AskingPrime, (asks.then(|| needy.clone()),));
        // The adapter's address derives from the gate, and the gate must list
        // that address because `need` names it: create the gate, then write
        // its list.
        let gate = e.register(FixtureGate, (Vec::<Address>::new(&e), custody));
        let at = agreed_address(&e, &prime, &gate, 0, 100);
        let allowed = Vec::from_array(&e, [relay.clone(), needy.clone(), at.clone()]);
        e.as_contract(&gate, || {
            e.storage().instance().set(&symbol_short!("a"), &allowed)
        });
        let adapter = e.register_at(&at, ExecutionAdapter, (prime.clone(), gate, 0u32, 100u32));
        H {
            e,
            adapter,
            prime,
            relay,
            needy,
        }
    }

    fn need(h: &H) -> InvokerContractAuthEntry {
        InvokerContractAuthEntry::Contract(SubContractInvocation {
            context: ContractContext {
                contract: h.needy.clone(),
                fn_name: Symbol::new(&h.e, "need"),
                args: Vec::from_array(&h.e, [h.adapter.to_val()]),
            },
            sub_invocations: Vec::new(&h.e),
        })
    }

    fn go(h: &H) -> Call {
        let args = Vec::from_array(&h.e, [h.needy.to_val(), h.adapter.to_val()]);
        call_to(&h.e, &h.relay, "go", args)
    }

    /// `execute(calls, grants, 0)` with the Prime's own signed entry.
    fn try_run(h: &H, calls: &Vec<Call>, grants: &Vec<InvokerContractAuthEntry>) -> bool {
        let args: Vec<Val> = (calls.clone(), grants.clone(), 0u32).into_val(&h.e);
        let args: std::vec::Vec<ScVal> = args
            .iter()
            .map(|v| ScVal::try_from_val(&h.e, &v).unwrap())
            .collect();
        h.e.set_auths(&[SorobanAuthorizationEntry {
            credentials: SorobanCredentials::Address(SorobanAddressCredentials {
                address: ScAddress::from(&h.prime),
                nonce: 7,
                signature_expiration_ledger: 2_000,
                signature: ScVal::Void,
            }),
            root_invocation: SorobanAuthorizedInvocation {
                function: SorobanAuthorizedFunction::ContractFn(InvokeContractArgs {
                    contract_address: ScAddress::from(&h.adapter),
                    function_name: ScSymbol("execute".try_into().unwrap()),
                    args: args.try_into().unwrap(),
                }),
                sub_invocations: VecM::default(),
            },
        }]);
        ExecutionAdapterClient::new(&h.e, &h.adapter)
            .try_execute(calls, grants, &0)
            .is_ok()
    }

    fn served(h: &H) -> u32 {
        NeedyClient::new(&h.e, &h.needy).count()
    }

    #[test]
    fn a_call_s_executor_authorizations_reach_its_callee() {
        let h = setup(false);
        let none = Vec::new(&h.e);
        assert!(!try_run(&h, &Vec::from_array(&h.e, [go(&h)]), &none));
        let mut c = go(&h);
        c.executor_authorizations = Vec::from_array(&h.e, [need(&h)]);
        assert!(try_run(&h, &Vec::from_array(&h.e, [c]), &none));
        assert_eq!(served(&h), 1);
    }

    #[test]
    fn the_batch_grants_reach_the_prime_s_check() {
        let h = setup(true);
        let calls = Vec::new(&h.e);
        assert!(!try_run(&h, &calls, &Vec::new(&h.e)));
        assert!(try_run(&h, &calls, &Vec::from_array(&h.e, [need(&h)])));
        assert_eq!(served(&h), 1);
    }
}
