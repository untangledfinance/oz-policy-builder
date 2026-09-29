extern crate std;
use super::*;
use soroban_sdk::{
    testutils::{Address as _, Ledger as _},
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
    let adapter = e.register(
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

/// THE TWO LENGTHS THE ADDRESS WALK COMPARES ARE THE WHOLE CONSTRUCTIBLE SET,
/// and this is the tripwire that says so. A contract can build an `Address`
/// from data three ways: `from_string` and `from_string_bytes`, which take a
/// 56-character G or C strkey, and `from_payload`, which takes the raw 32
/// bytes. A muxed strkey is 69 characters and the host refuses it outright -
/// "unexpected strkey length" - so there is no third encoding for the walk to
/// miss. If a protocol ever widens what `from_string` accepts, this test fails
/// and `scan_data` needs the new length.
#[test]
#[should_panic]
fn a_muxed_strkey_is_not_an_address_this_host_can_build() {
    let e = Env::default();
    let muxed = "MBSRYJ7BNJNEOCMQ5EBAJOTSLHWAOQXSSUUYECRU7KWZVXGAZ5PXGAIBAEAQCAIBAGQ7A";
    assert_eq!(muxed.len(), 69);
    Address::from_string(&SString::from_str(&e, muxed));
}

#[test]
fn the_deployment_convention_derives_the_address_custody_names() {
    // Tooling computes this; the contract no longer asserts it, but the
    // formula is the one the gate's `caller` has to be set to.
    let e = Env::default();
    let prime = Address::generate(&e);
    let gate = Address::generate(&e);
    let mut b = Bytes::from_slice(&e, b"prime.execution.adapter.v4");
    b.append(&gate.clone().to_xdr(&e));
    let derived = e
        .deployer()
        .with_address(prime.clone(), e.crypto().sha256(&b))
        .deployed_address();
    assert_ne!(derived, prime);
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
