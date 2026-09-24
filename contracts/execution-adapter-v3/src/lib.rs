#![no_std]
//! Per-Prime batching, bound to one gate for life.
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
//! WHERE THIS CONTRACT LIVES IS THE DEPLOYER'S PROBLEM, NOT ITS OWN. Custody
//! finds it before it exists by deriving
//! `deployer(prime, sha256("prime.execution.adapter.v3" + gate))` and naming
//! that address on the gate. The convention belongs in the deployment tooling:
//! an adapter deployed anywhere else is simply inert, because the gate demands
//! authorization from the address it named and gets none. `rebind` breaks the
//! address-to-gate correspondence deliberately anyway, so it was never an
//! invariant this contract could hold.
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
    contractimpl, contracttype, panic_with_error, symbol_short, vec, Address, Bytes, Env, IntoVal,
    Map, String, Symbol, TryFromVal, Val, Vec,
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
}

const PRIME: Symbol = symbol_short!("prime");
const GATE: Symbol = symbol_short!("gate");

#[contract]
pub struct ExecutionAdapter;

#[contractimpl]
impl ExecutionAdapter {
    pub fn __constructor(e: Env, prime: Address, gate: Address) {
        e.storage().instance().set(&PRIME, &prime);
        e.storage().instance().set(&GATE, &gate);
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
    /// mistyped argument left the adapter unusable AND unrebindable - and the
    /// Prime cannot deploy a replacement, because an OZ smart account deploys
    /// exactly one contract through rule 0. Measured on testnet: rebound to a
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

    /// Returns nothing: the batch is built with fixed arguments, so no caller
    /// can act on a result, and carrying one back costs a host object per call.
    pub fn execute(e: Env, calls: Vec<Call>, grants: Vec<InvokerContractAuthEntry>) {
        let prime: Address = e.storage().instance().get(&PRIME).unwrap();
        let gate: Address = e.storage().instance().get(&GATE).unwrap();
        let mut ok: Vec<Address> = e.invoke_contract(&gate, &Symbol::new(&e, "allowed"), vec![&e]);
        ok.push_back(gate);
        for call in calls.iter() {
            // The smart account's own `execute` would let a batch move the
            // Prime's funds with only this list to stop it, and the mandate
            // rules would never see the inner call. Calling THIS contract back
            // needs no rule: the host forbids re-entering a contract already
            // on the stack.
            if call.target == prime {
                panic_with_error!(&e, E::PrimeTarget);
            }
            want(&e, &ok, &call.target);
            for v in call.args.iter() {
                scan(&e, &ok, &v);
            }
            for entry in call.executor_authorizations.iter() {
                scan_entry(&e, &ok, &entry);
            }
        }
        for entry in grants.iter() {
            scan_entry(&e, &ok, &entry);
        }
        // EVERY call is checked before ANY of them runs. Validating and
        // invoking in one pass would let an early call move value while a
        // later one in the same batch was still unexamined.
        let args: Vec<Val> = vec![&e, calls.clone().into_val(&e), grants.clone().into_val(&e)];
        e.authorize_as_current_contract(grants);
        prime.require_auth_for_args(args);
        for call in calls.iter() {
            if !call.executor_authorizations.is_empty() {
                e.authorize_as_current_contract(call.executor_authorizations);
            }
            e.invoke_contract::<Val>(&call.target, &call.function_name, call.args);
        }
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
