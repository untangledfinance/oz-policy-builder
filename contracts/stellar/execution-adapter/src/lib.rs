#![no_std]
//! Per-Prime batching, bound to one gate or to none, with an optional wait.
//!
//! A BATCH CAN WAIT, IF THERE IS A GATE. `execute` takes how many ledgers to
//! wait. Zero runs the batch now, exactly as the previous adapter did. More
//! than zero stores it, and anyone may `run` it once that many ledgers have
//! closed - until its run window closes too. The Prime approves the wait
//! along with the batch, so nobody can shorten it afterwards, and each of the
//! Prime's rules can demand a longer one: the wait is argument 2, a plain
//! number a predicate compares.
//!
//! THE ADAPTER HAS ITS OWN FLOOR. `min_wait`, fixed at deployment, applies to
//! every caller. The owners' rule carries no predicate, so without it they -
//! and a recovery - could always pass zero; with it above zero, everything
//! waits, and custody has that long to see a move coming.
//!
//! CANCELLING IS THE PRIME'S OR CUSTODY'S. The Prime cancels through its own
//! rules, so at its own quorum; an agent's rule that permits only `execute`
//! cannot cancel anything. Custody - whoever the gate answers to - can stop a
//! move from its own funds that it did not expect. With no gate there is no
//! custody, and only the Prime cancels.
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
//! WITHOUT A GATE THERE IS NO LIST. An adapter created with no gate checks no
//! address, so the Prime can bundle its own calls - a call that must not fail,
//! then transfers of its own funds - and they all happen or none does. The
//! Prime approves every batch, and the Prime's rules see every call that asks
//! for its authorization, each against a rule of its own. A batch may not call
//! the Prime itself, which is a check on the target and not on a list.
//!
//! NOTHING HANDS THE ADAPTER'S OWN AUTHORITY FURTHER. With no list there is
//! nothing to check a grant against, so a null adapter hands out no
//! authorization as itself and acts as itself only towards the contracts it
//! calls directly. It holds nothing, and anyone the Prime's rules let call
//! `execute` can run any batch through it: it must never be sent funds or
//! given an allowance, and a rule on the Prime that this adapter signs is
//! bounded by its predicate alone.
//!
//! NOTHING WAITS. A stored batch runs under `run`, where the adapter is the
//! one asking the Prime, so the Prime's token rules would have to be signed by
//! this adapter. Those rules would answer an immediate `execute` too, where the
//! adapter is also the one asking, and an agent allowed to call `execute`
//! could move the Prime's funds through them instead of through its own capped
//! rules; for a G account a stored batch would need its signature again
//! anyway. So a null adapter takes no `min_wait` and runs every batch at once.
//!
//! Custody's funds stay out of reach: a custody gate pins the address and code
//! of its one caller, which custody derives from that same gate.
//!
//! THE ADDRESS COMMITS TO THE WAIT AND THE BINDING. Custody finds this
//! contract before it exists by deriving
//! `deployer(prime, sha256("prime.execution.adapter.v5" + XDR((gate, min_wait,
//! run_window))))` - "no gate" being a void in that tuple - and naming that
//! address on the gate. The constructor refuses to run anywhere else. The XDR
//! of a tuple spells one binding only, and `v5` keeps this build off every
//! address a `v4` adapter was derived at. The numbers are custody's
//! protection against the Prime's own owners, and the gate pins its caller's
//! address and code but not its arguments: without this check the Prime could
//! create the adapter at the named address with a `min_wait` of zero.
//! `rebind` later moves the binding to another gate on purpose; the check is
//! about what custody agreed to at creation.
//!
//! THE BINDING MOVES ONLY WITH CUSTODY'S SIGNATURE. Custody eventually
//! rotates - a new custodian, a different venue set - and its gate has no
//! setters, so a change means a new gate. Redeploying this contract too would
//! change its address and kill every band rule scoped to it, each of which
//! costs a signing ceremony to reinstall. `rebind` moves the binding instead,
//! and only the current gate's custody may call it. The Prime cannot: it can
//! neither widen the perimeter nor point this contract at a gate of its own.
//! Whether there is a gate at all is fixed at creation: a null adapter has no
//! custody to sign a `rebind`, and `rebind` takes an address, never "none".
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
    auth::InvokerContractAuthEntry, contract, contracterror, contractimpl, contracttype,
    panic_with_error, symbol_short, vec, xdr::ToXdr, Address, Bytes, Duration, Env, IntoVal, Map,
    String, Symbol, Timepoint, TryFromVal, Val, Vec, I256, U256,
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
    NoGate = 9,
    NoWait = 10,
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

/// KEPT ALIVE WHILE IT IS USED. An instance is created with the network's
/// minimum lifetime - ~7 days on testnet, ~120 on mainnet - and a write does
/// not extend it, so an adapter nobody extended archived that long after it
/// was created however busy it was. `execute` and `run` push it back out to
/// ~30 days once fewer than ~7 remain.
const KEEP_BELOW: u32 = 120_960;
const KEEP_TO: u32 = 518_400;

#[contract]
pub struct ExecutionAdapter;

#[contractimpl]
impl ExecutionAdapter {
    /// `gate` is the custody gate this adapter answers to, or none for an
    /// adapter that only bundles the Prime's own calls, which takes no
    /// `min_wait` (`NoWait`).
    /// `min_wait` is the fewest ledgers any batch waits, zero allowing none.
    /// `run_window` is how many ledgers after its wait a batch may still run:
    /// a move that sat unrun for longer was approved against a market that
    /// has since moved, and perhaps by an agent since revoked, so it lapses.
    pub fn __constructor(
        e: Env,
        prime: Address,
        gate: Option<Address>,
        min_wait: u32,
        run_window: u32,
    ) {
        if gate.is_none() && min_wait > 0 {
            panic_with_error!(&e, E::NoWait);
        }
        let mut salt = Bytes::from_slice(&e, b"prime.execution.adapter.v5");
        salt.append(&(gate.clone(), min_wait, run_window).to_xdr(&e));
        let hash = e.crypto().sha256(&salt);
        let agreed = e.deployer().with_address(prime.clone(), hash);
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
        let old = bound(&e).unwrap_or_else(|| panic_with_error!(&e, E::NoGate));
        custody(&e, &old).require_auth();
        // The successor must answer too, or the binding could never move again.
        custody(&e, &gate);
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
        e.storage().instance().extend_ttl(KEEP_BELOW, KEEP_TO);
        let prime: Address = e.storage().instance().get(&PRIME).unwrap();
        check(&e, &prime, &calls, &grants);
        let min_wait: u32 = e.storage().instance().get(&MIN_WAIT).unwrap();
        if wait < min_wait {
            panic_with_error!(&e, E::WaitTooShort);
        }
        let args: Vec<Val> = (calls.clone(), grants.clone(), wait).into_val(&e);
        if wait == 0 {
            e.authorize_as_current_contract(grants.clone());
            prime.require_auth_for_args(args);
            invoke(&e, calls);
            return None;
        }
        // WITHOUT A GATE, NOTHING WAITS: see the module comment.
        bound(&e).unwrap_or_else(|| panic_with_error!(&e, E::NoWait));
        prime.require_auth_for_args(args);
        // Overflow traps (`overflow-checks` is on in release): a wrapped
        // `run_at` would be in the past, and the batch runnable at once.
        let run_at = e.ledger().sequence() + wait;
        let id: u32 = e.storage().instance().get(&NEXT).unwrap_or(0) + 1;
        e.storage().instance().set(&NEXT, &id);
        e.storage().persistent().set(&id, &(calls, grants, run_at));
        // LIVE UNTIL ITS WINDOW CLOSES. A new entry gets the network minimum
        // (~7 days on testnet), so a longer wait would archive the move before
        // it could run. Past the network's maximum (~180 days) it still
        // archives, and is restored, not lost.
        let window: u32 = e.storage().instance().get(&WINDOW).unwrap();
        let live =
            (run_at.saturating_add(window) - e.ledger().sequence()).min(e.storage().max_ttl());
        e.storage().persistent().extend_ttl(&id, live, live);
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
        e.storage().instance().extend_ttl(KEEP_BELOW, KEEP_TO);
        let stored: Option<Stored> = e.storage().persistent().get(&id);
        let (calls, grants, run_at) =
            stored.unwrap_or_else(|| panic_with_error!(&e, E::NotScheduled));
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
    /// With no gate, `by` is the Prime.
    /// A lapsed batch can be dropped the same way, to tidy it away; a number
    /// with nothing stored under it is left as it was.
    pub fn cancel(e: Env, id: u32, by: Address) {
        let prime: Address = e.storage().instance().get(&PRIME).unwrap();
        let custody = bound(&e).map(|gate| custody(&e, &gate));
        if by != prime && Some(&by) != custody.as_ref() {
            panic_with_error!(&e, E::NotACanceller);
        }
        by.require_auth();
        e.storage().persistent().remove(&id);
    }
}

/// The one rule, applied to a whole batch before any of it runs. Validating
/// and invoking in one pass would let an early call move value while a later
/// one in the same batch was still unexamined. With no gate, only the Prime
/// as a target and any authorization handed out are refused.
fn check(e: &Env, prime: &Address, calls: &Vec<Call>, grants: &Vec<InvokerContractAuthEntry>) {
    let list = bound(e).map(|gate| {
        let mut ok: Vec<Address> = e.invoke_contract(&gate, &Symbol::new(e, "allowed"), vec![e]);
        ok.push_back(gate);
        ok
    });
    for call in calls.iter() {
        // The smart account's own `execute` would let a batch move the
        // Prime's funds with only this list to stop it, and the mandate
        // rules would never see the inner call. Calling THIS contract back
        // needs no rule: the host forbids re-entering a contract already
        // on the stack.
        if call.target == *prime {
            panic_with_error!(e, E::PrimeTarget);
        }
        if let Some(ok) = &list {
            want(e, ok, &call.target);
            call.args.iter().for_each(|v| scan(e, ok, &v));
        }
        call.executor_authorizations
            .iter()
            .for_each(|a| scan_entry(e, list.as_ref(), &a));
    }
    grants.iter().for_each(|a| scan_entry(e, list.as_ref(), &a));
}

/// The gate this adapter is bound to, if it was created with one.
fn bound(e: &Env) -> Option<Address> {
    e.storage().instance().get(&GATE).unwrap()
}

/// Whose money a gate guards.
fn custody(e: &Env, gate: &Address) -> Address {
    e.invoke_contract(gate, &Symbol::new(e, "custody"), vec![e])
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
///
/// DENY BY DEFAULT. A host object this walk cannot read is refused rather than
/// passed. A muxed address is one: a token's `transfer` takes its recipient as
/// a `MuxedAddress` and credits the account behind it, yet the value converts
/// to no type below, so a walk that only refused what it recognised let a
/// batch pay an account the gate never named. Numbers, times and symbols
/// cannot name an account and pass; so does every value that is not a host
/// object. The next object type a protocol adds is refused until this walk
/// learns it.
fn scan(e: &Env, ok: &Vec<Address>, v: &Val) {
    if let Ok(a) = Address::try_from_val(e, v) {
        want(e, ok, &a);
    } else if let Ok(list) = Vec::<Val>::try_from_val(e, v) {
        list.iter().for_each(|x| scan(e, ok, &x));
    } else if let Ok(m) = Map::<Val, Val>::try_from_val(e, v) {
        for (k, val) in m.iter() {
            scan(e, ok, &k);
            scan(e, ok, &val);
        }
    } else if let Ok(b) = Bytes::try_from_val(e, v) {
        scan_data(e, ok, &b);
    } else if let Ok(s) = String::try_from_val(e, v) {
        scan_data(e, ok, &s.to_bytes());
    } else if v.is_object() && !is_plain_object(e, v) {
        panic_with_error!(e, E::Uncheckable);
    }
}

/// A host object that holds a number, a time or a symbol and so cannot name an
/// account.
fn is_plain_object(e: &Env, v: &Val) -> bool {
    u64::try_from_val(e, v).is_ok()
        || i64::try_from_val(e, v).is_ok()
        || u128::try_from_val(e, v).is_ok()
        || i128::try_from_val(e, v).is_ok()
        || U256::try_from_val(e, v).is_ok()
        || I256::try_from_val(e, v).is_ok()
        || Timepoint::try_from_val(e, v).is_ok()
        || Duration::try_from_val(e, v).is_ok()
        || Symbol::try_from_val(e, v).is_ok()
}

/// Bytes and strings a callee could read back as an address.
///
/// This COMPARES rather than decodes. Neither conversion has a fallible form
/// inside a contract, so parsing a value that turned out not to be an address
/// would trap the whole batch instead of refusing one destination - and a
/// 32-byte hash is a perfectly ordinary venue argument. Checking how each
/// allowed address encodes costs the same and cannot trap.
///
/// Two more spellings can reach an address through a venue that decodes
/// bytes: the XDR of an address value, which `Address::from_xdr` takes (40
/// bytes for a contract, 44 for an account), and a muxed address, which
/// `MuxedAddress::from_string` builds from its 69-character `M` strkey and
/// `from_xdr` from its 48-byte XDR. A token's `transfer` credits the account
/// behind a muxed address. Data of those three XDR lengths must equal the XDR
/// of an allowed address, which a muxed one never does, and data of 69 bytes
/// is refused outright because an allowed address is never spelled that way.
///
/// Data of any other length cannot denote an address under these conversions
/// and passes untouched, so venues that take signatures, memos or identifiers
/// still work. The length decides WHICH encoding to compare before the loop
/// starts: checking every encoding for every address cost a third more on a
/// batch that carries strkeys, for no extra safety, since the others can never
/// match.
///
/// THE LIMIT OF AN ABI-BLIND WALK: a number can carry 32 key bytes. A U256
/// holding a stranger's key passes, and a venue that turned it back into bytes
/// and then into an address would pay the stranger. The rule assumes a listed
/// venue reads an address from an argument shaped like one.
fn scan_data(e: &Env, ok: &Vec<Address>, b: &Bytes) {
    // 32 bytes is the raw account key or contract id `Address::from_payload`
    // takes; 56 is the same thing spelled as the strkey `from_string` takes;
    // 40 and 44 are the XDR of a contract and an account address. The raw 32
    // bytes `from_payload` takes are the last 32 bytes of that XDR, so one
    // encoding serves both cases.
    let (strkey, xdr) = match b.len() {
        69 => panic_with_error!(e, E::AddressNotAllowed),
        56 => (true, false),
        40 | 44 | 48 => (false, true),
        32 => (false, false),
        _ => return,
    };
    let spelled = |a: Address| {
        if strkey {
            a.to_string().to_bytes() == *b
        } else {
            let x = a.to_xdr(e);
            x.slice(if xdr { 0 } else { x.len() - 32 }..) == *b
        }
    };
    if !ok.iter().any(spelled) {
        panic_with_error!(e, E::AddressNotAllowed);
    }
}

/// An authorization this contract is about to hand out as itself.
///
/// ONLY CONTRACT CALLS ARE CHECKABLE. The other two variants authorise
/// deploying a contract as this one, and carry constructor arguments this walk
/// would never look at - which is exactly the hole the address rule exists to
/// close. This contract has no reason to deploy anything, so they are refused
/// outright rather than waved through unscanned. With no gate there is no list
/// to check any of them against, so every one is refused.
fn scan_entry(e: &Env, list: Option<&Vec<Address>>, entry: &InvokerContractAuthEntry) {
    let (Some(ok), InvokerContractAuthEntry::Contract(c)) = (list, entry) else {
        panic_with_error!(e, E::Uncheckable);
    };
    want(e, ok, &c.context.contract);
    c.context.args.iter().for_each(|v| scan(e, ok, &v));
    c.sub_invocations
        .iter()
        .for_each(|sub| scan_entry(e, list, &sub));
}

#[cfg(test)]
mod tests;
