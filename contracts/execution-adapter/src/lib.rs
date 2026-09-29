#![no_std]
//! Per-Prime batching, bound to one gate for life, with an optional wait.
//!
//! A BATCH CAN WAIT. `execute` takes how many ledgers to wait. Zero runs the
//! batch now, exactly as the previous adapter did. More than zero stores it,
//! and anyone may `run` it once that many ledgers have closed - until its run
//! window closes too. The Prime approves the wait along with the batch, so
//! nobody can shorten it afterwards, and each of the Prime's rules can demand
//! a longer one: the wait is argument 2, a plain number a predicate compares.
//!
//! THE ADAPTER HAS ITS OWN FLOOR. `min_wait`, fixed at deployment, applies to
//! every caller. The owners' rule carries no predicate, so without it they -
//! and a recovery - could always pass zero; with it above zero, everything
//! waits, and custody has that long to see a move coming.
//!
//! CANCELLING IS THE PRIME'S OR CUSTODY'S. The Prime cancels through its own
//! rules, so at its own quorum; an agent's rule that permits only `execute`
//! cannot cancel anything. Custody - whoever the gate answers to - can stop a
//! move from its own funds that it did not expect.
//!
//! A STORED BATCH RUNS UNDER THE PRIME'S "RUN" RULE. `run` asks the Prime to
//! approve `run(id)`, and the Prime answers through a rule scoped to this
//! adapter, signed by it, whose predicate permits `run` alone - see `run`.
//! Without that rule a stored batch cannot run; without its predicate the
//! rule would let anyone have this adapter approve an immediate `execute`.
//!
//! WHAT RUNS IS WHAT WAS APPROVED. The batch is stored whole, not hashed, so
//! whoever runs it names only its number and cannot vary a single argument.
//! It is checked again when it runs, against the gate this adapter is bound to
//! THEN: custody may have rebound it to a narrower gate while it waited.
//!
//! ONE RULE: a batch may not mention an address the gate does not name.
//! Every call target, every argument, anything nested inside one, and every
//! authorization handed to a callee is checked against that list. Where value
//! can go therefore does not depend on this contract understanding any
//! venue's ABI - which it cannot, and which is why guarding only its own
//! token balance left a venue free to pay a stranger out of our position.
//!
//! THE GATE IS NOT AN ARGUMENT. It is fixed at deployment, so there is nothing
//! to pass, nothing to omit and nothing to substitute.
//!
//! THE ADDRESS COMMITS TO THE WAIT. Custody finds this contract before it
//! exists by deriving
//! `deployer(prime, sha256("prime.execution.adapter.v4" + gate + min_wait +
//! run_window))` - each part in its XDR encoding - and naming that address on
//! the gate. The constructor refuses to run anywhere else. The numbers are
//! custody's protection against the Prime's own owners, and the gate pins its
//! caller's address and code but not its arguments: without this check the
//! Prime could create the adapter at the named address with a `min_wait` of
//! zero. `rebind` later moves the binding to another gate on purpose; the
//! check is about what custody agreed to at creation.
//!
//! THE BINDING MOVES ONLY WITH CUSTODY'S SIGNATURE. Custody eventually
//! rotates - a new custodian, a different venue set - and its gate has no
//! setters, so a change means a new gate. Redeploying this contract too would
//! change its address and kill every band rule scoped to it, each of which
//! costs a signing ceremony to reinstall. `rebind` moves the binding instead,
//! and only the current gate's custody may call it. The Prime cannot: it can
//! neither widen the perimeter nor point this contract at a gate of its own.
//!
//! THERE IS NO DEPTH LIMIT EITHER. The host stops long before the walk needs
//! to: a value nested a couple of hundred deep cannot be preflighted and one
//! nested a thousand deep cannot even be encoded into a transaction. A limit
//! here refused nothing the host would have allowed through, and refused
//! legitimate arguments that merely happened to be deeper than a guess.
//!
//! THERE IS NO BATCH-SIZE CAP. Gas and transaction size already bound a batch:
//! 150 calls costs about a third of the ledger's instruction budget and 400
//! will not fit in a transaction, and whoever submits it pays. A number here
//! would only refuse legitimate batches that happened to be one call longer
//! than somebody once guessed.
//!
//! THERE ARE NO GETTERS. Instance storage is public: anyone can read which
//! Prime and which gate this contract is bound to straight off the ledger, so
//! an accessor would only be a second way to say the same thing.
use soroban_sdk::{
    address_payload::AddressPayload, auth::InvokerContractAuthEntry, contract, contracterror,
    contractimpl, contracttype, panic_with_error, symbol_short, vec, xdr::ToXdr, Address, Bytes,
    Env, IntoVal, Map, String, Symbol, TryFromVal, Val, Vec,
};

#[contracttype]
#[derive(Clone)]
pub struct Call {
    pub target: Address,
    pub function_name: Symbol,
    pub args: Vec<Val>,
    /// What the callee may do as this contract. Checked like everything else.
    pub executor_authorizations: Vec<InvokerContractAuthEntry>,
}

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum E {
    PrimeTarget = 1,
    AddressNotAllowed = 2,
    Uncheckable = 3,
    WaitTooShort = 4,
    NotScheduled = 5,
    NotRunnable = 6,
    NotACanceller = 7,
    NotWhereAgreed = 8,
}

/// A batch waiting to run, stored under its number: the calls, the grants,
/// and the ledger it becomes runnable on. It stays runnable through
/// `run_at + run_window`, both inclusive.
type Stored = (Vec<Call>, Vec<InvokerContractAuthEntry>, u32);

const PRIME: Symbol = symbol_short!("prime");
const GATE: Symbol = symbol_short!("gate");
const MIN_WAIT: Symbol = symbol_short!("min_wait");
const WINDOW: Symbol = symbol_short!("window");
const NEXT: Symbol = symbol_short!("next");

#[contract]
pub struct ExecutionAdapter;

#[contractimpl]
impl ExecutionAdapter {
    /// `min_wait` is the fewest ledgers any batch waits, zero allowing none.
    /// `run_window` is how many ledgers after its wait a batch may still run:
    /// a move that sat unrun for longer was approved against a market that
    /// has since moved, and perhaps by an agent since revoked, so it lapses.
    pub fn __constructor(e: Env, prime: Address, gate: Address, min_wait: u32, run_window: u32) {
        let mut salt = Bytes::from_slice(&e, b"prime.execution.adapter.v4");
        salt.append(&gate.clone().to_xdr(&e));
        salt.append(&min_wait.to_xdr(&e));
        salt.append(&run_window.to_xdr(&e));
        let agreed = e
            .deployer()
            .with_address(prime.clone(), e.crypto().sha256(&salt));
        if agreed.deployed_address() != e.current_contract_address() {
            panic_with_error!(&e, E::NotWhereAgreed);
        }
        e.storage().instance().set(&PRIME, &prime);
        e.storage().instance().set(&GATE, &gate);
        e.storage().instance().set(&MIN_WAIT, &min_wait);
        e.storage().instance().set(&WINDOW, &run_window);
    }

    /// Point this contract at a successor gate. Authorised by the custody the
    /// CURRENT gate answers to, which is the only party whose money is at
    /// stake. After this the address no longer derives from the binding; the
    /// derivation was only ever how custody found this contract before it
    /// existed, and what the gate actually checks is caller and code.
    ///
    /// THE SUCCESSOR IS ASKED WHO IT ANSWERS TO BEFORE THE BINDING MOVES, and
    /// that one call is what keeps this reversible. An address that cannot
    /// answer `custody` could never be rebound away from either, so a single
    /// mistyped argument left the adapter unusable AND unrebindable. Recovery
    /// means abandoning it for a whole new gate generation, and every rule
    /// scoped to the old adapter address dies with it. Measured on testnet:
    /// rebound to a
    /// SAC, both `execute` and the next `rebind` failed
    /// `Error(Value, InvalidInput)` for good. Checking `allowed` too would buy
    /// nothing: a successor missing THAT is merely unusable, and custody can
    /// still rebind away from it.
    pub fn rebind(e: Env, gate: Address) {
        let old: Address = e.storage().instance().get(&GATE).unwrap();
        let custody: Symbol = Symbol::new(&e, "custody");
        let who: Address = e.invoke_contract(&old, &custody, vec![&e]);
        who.require_auth();
        let _: Address = e.invoke_contract(&gate, &custody, vec![&e]);
        e.storage().instance().set(&GATE, &gate);
    }

    /// Run the batch now (`wait` zero) or store it to run once `wait` more
    /// ledgers have closed, returning its number.
    ///
    /// The Prime approves `(calls, grants, wait)`: the batch keeps the first
    /// two argument positions it has always had, so every rule's paths into it
    /// are unchanged, and the wait is covered by the same approval.
    pub fn execute(
        e: Env,
        calls: Vec<Call>,
        grants: Vec<InvokerContractAuthEntry>,
        wait: u32,
    ) -> Option<u32> {
        let prime: Address = e.storage().instance().get(&PRIME).unwrap();
        check(&e, &prime, &calls, &grants);
        let min_wait: u32 = e.storage().instance().get(&MIN_WAIT).unwrap();
        if wait < min_wait {
            panic_with_error!(&e, E::WaitTooShort);
        }
        let args: Vec<Val> = vec![
            &e,
            calls.clone().into_val(&e),
            grants.clone().into_val(&e),
            wait.into_val(&e),
        ];
        if wait == 0 {
            e.authorize_as_current_contract(grants.clone());
            prime.require_auth_for_args(args);
            invoke(&e, calls);
            return None;
        }
        prime.require_auth_for_args(args);
        // Overflow traps (`overflow-checks` is on in release): a wrapped
        // `run_at` would be in the past, and the batch runnable at once.
        let run_at = e.ledger().sequence() + wait;
        let id: u32 = e.storage().instance().get(&NEXT).unwrap_or(0) + 1;
        e.storage().instance().set(&NEXT, &id);
        // A persistent entry outlives any sensible wait by default, and one
        // that archives is restored, not lost.
        let stored: Stored = (calls, grants, run_at);
        e.storage().persistent().set(&id, &stored);
        Some(id)
    }

    /// Run a stored batch whose wait is over. Anyone may: what runs was fixed
    /// when the Prime approved it, so the caller chooses only when, within the
    /// window.
    ///
    /// THE PRIME APPROVES THE RUN, THROUGH A RULE THIS ADAPTER SIGNS. A venue
    /// that asks the Prime for authorization mid-batch - Blend's `submit` -
    /// is answered by a rule whose signer is this adapter, and the smart
    /// account checks a contract signer with `require_auth_for_args`, which a
    /// contract passes only when it is the one that asked the Prime. At once,
    /// `execute` asks, and the venue's request sits inside that approval. Here
    /// nobody would have asked first, the venue would be asking, and the
    /// adapter's signature would fail (measured on testnet:
    /// `Error(Auth, InvalidAction)`). So `run` asks, for `(id)`, and the Prime
    /// answers it with a rule scoped to this adapter, signed by it, whose
    /// predicate permits `run` and nothing else. No key signs; any submitter
    /// can build the entry. The predicate is what keeps that rule from
    /// approving an immediate `execute` or a `cancel` the same way.
    pub fn run(e: Env, id: u32) {
        let (calls, grants, run_at): Stored = e
            .storage()
            .persistent()
            .get(&id)
            .unwrap_or_else(|| panic_with_error!(&e, E::NotScheduled));
        let window: u32 = e.storage().instance().get(&WINDOW).unwrap();
        let now = e.ledger().sequence();
        if now < run_at || now > run_at.saturating_add(window) {
            panic_with_error!(&e, E::NotRunnable);
        }
        // Gone before anything runs, so it runs once. A call cannot reach
        // this contract again anyway: the host refuses re-entry.
        e.storage().persistent().remove(&id);
        let prime: Address = e.storage().instance().get(&PRIME).unwrap();
        check(&e, &prime, &calls, &grants);
        e.authorize_as_current_contract(grants);
        prime.require_auth_for_args(vec![&e, id.into_val(&e)]);
        invoke(&e, calls);
    }

    /// Drop a stored batch, waiting or ready, before it runs. `by` is the
    /// Prime or the custody the current gate answers to, and must approve.
    /// A lapsed batch can be dropped the same way, to tidy it away; a number
    /// with nothing stored under it is left as it was.
    pub fn cancel(e: Env, id: u32, by: Address) {
        let prime: Address = e.storage().instance().get(&PRIME).unwrap();
        let gate: Address = e.storage().instance().get(&GATE).unwrap();
        let custody: Address = e.invoke_contract(&gate, &Symbol::new(&e, "custody"), vec![&e]);
        if by != prime && by != custody {
            panic_with_error!(&e, E::NotACanceller);
        }
        by.require_auth();
        e.storage().persistent().remove(&id);
    }
}

/// The one rule, applied to a whole batch before any of it runs. Validating
/// and invoking in one pass would let an early call move value while a later
/// one in the same batch was still unexamined.
fn check(e: &Env, prime: &Address, calls: &Vec<Call>, grants: &Vec<InvokerContractAuthEntry>) {
    let gate: Address = e.storage().instance().get(&GATE).unwrap();
    let mut ok: Vec<Address> = e.invoke_contract(&gate, &Symbol::new(e, "allowed"), vec![e]);
    ok.push_back(gate);
    for call in calls.iter() {
        // The smart account's own `execute` would let a batch move the
        // Prime's funds with only this list to stop it, and the mandate
        // rules would never see the inner call. Calling THIS contract back
        // needs no rule: the host forbids re-entering a contract already
        // on the stack.
        if call.target == *prime {
            panic_with_error!(e, E::PrimeTarget);
        }
        want(e, &ok, &call.target);
        for v in call.args.iter() {
            scan(e, &ok, &v);
        }
        for entry in call.executor_authorizations.iter() {
            scan_entry(e, &ok, &entry);
        }
    }
    for entry in grants.iter() {
        scan_entry(e, &ok, &entry);
    }
}

fn invoke(e: &Env, calls: Vec<Call>) {
    for call in calls.iter() {
        if !call.executor_authorizations.is_empty() {
            e.authorize_as_current_contract(call.executor_authorizations);
        }
        e.invoke_contract::<Val>(&call.target, &call.function_name, call.args);
    }
}

fn want(e: &Env, ok: &Vec<Address>, a: &Address) {
    if !ok.contains(a) {
        panic_with_error!(e, E::AddressNotAllowed);
    }
}

/// Every address in a value, however deeply it is buried - and a refusal for
/// anything that could be carrying one out of sight.
fn scan(e: &Env, ok: &Vec<Address>, v: &Val) {
    if let Ok(a) = Address::try_from_val(e, v) {
        want(e, ok, &a);
    } else if let Ok(list) = Vec::<Val>::try_from_val(e, v) {
        for x in list.iter() {
            scan(e, ok, &x);
        }
    } else if let Ok(m) = Map::<Val, Val>::try_from_val(e, v) {
        for (k, val) in m.iter() {
            scan(e, ok, &k);
            scan(e, ok, &val);
        }
    } else if let Ok(b) = Bytes::try_from_val(e, v) {
        scan_data(e, ok, &b);
    } else if let Ok(s) = String::try_from_val(e, v) {
        scan_data(e, ok, &s.to_bytes());
    }
}

/// Bytes and strings a callee could read back as an address.
///
/// This COMPARES rather than decodes. Neither conversion has a fallible form
/// inside a contract, so parsing a value that turned out not to be an address
/// would trap the whole batch instead of refusing one destination - and a
/// 32-byte hash is a perfectly ordinary venue argument. Checking how each
/// allowed address encodes costs the same and cannot trap.
///
/// Data of any other length cannot denote an address under either conversion
/// and passes untouched, so venues that take signatures, memos or identifiers
/// still work. The length decides WHICH encoding to compare before the loop
/// starts: checking both for every address cost a third more on a batch that
/// carries strkeys, for no extra safety, since the other one can never match.
fn scan_data(e: &Env, ok: &Vec<Address>, b: &Bytes) {
    // 32 bytes is the raw account key or contract id `Address::from_payload`
    // takes; 56 is the same thing spelled as the strkey `from_string` takes.
    let strkey = b.len() == 56;
    if !strkey && b.len() != 32 {
        return;
    }
    for a in ok.iter() {
        let hit = if strkey {
            a.to_string().to_bytes() == *b
        } else if let Some(
            AddressPayload::AccountIdPublicKeyEd25519(p) | AddressPayload::ContractIdHash(p),
        ) = a.to_payload()
        {
            Bytes::from(p) == *b
        } else {
            false
        };
        if hit {
            return;
        }
    }
    panic_with_error!(e, E::AddressNotAllowed);
}

/// An authorization this contract is about to hand out as itself.
///
/// ONLY CONTRACT CALLS ARE CHECKABLE. The other two variants authorise
/// deploying a contract as this one, and carry constructor arguments this walk
/// would never look at - which is exactly the hole the address rule exists to
/// close. This contract has no reason to deploy anything, so they are refused
/// outright rather than waved through unscanned.
fn scan_entry(e: &Env, ok: &Vec<Address>, entry: &InvokerContractAuthEntry) {
    let InvokerContractAuthEntry::Contract(c) = entry else {
        panic_with_error!(e, E::Uncheckable);
    };
    want(e, ok, &c.context.contract);
    for v in c.context.args.iter() {
        scan(e, ok, &v);
    }
    for sub in c.sub_invocations.iter() {
        scan_entry(e, ok, &sub);
    }
}

#[cfg(test)]
mod tests;
