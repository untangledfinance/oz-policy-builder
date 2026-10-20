//! The world `tests/oz08.rs` runs in: the wire types of OpenZeppelin's
//! smart account 0.8.0 and of the interpreter, mirrored, and the two contracts
//! the tests model (the execution adapter's authorisation calls, and a venue).
//! The account and the interpreter themselves are loaded as wasm.

#![no_std]

use soroban_sdk::auth::{Context, CustomAccountInterface, InvokerContractAuthEntry};
use soroban_sdk::crypto::Hash;
use soroban_sdk::{
    contract, contractimpl, contracttype, Address, Bytes, BytesN, Env, IntoVal, Map, Val, Vec,
};

/// What one supply moves.
pub const MOVE: i128 = 2_000_000;

// ---- the account's types (OZ `smart_account::storage` at `8e25220`) ----

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum Signer {
    Delegated(Address),
    External(Address, Bytes),
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ContextRuleType {
    Default,
    CallContract(Address),
    CreateContract(BytesN<32>),
}

#[contracttype]
#[derive(Clone, Debug)]
pub struct ContextRule {
    pub id: u32,
    pub context_type: ContextRuleType,
    pub name: soroban_sdk::String,
    pub signers: Vec<Signer>,
    pub signer_ids: Vec<u32>,
    pub policies: Vec<Address>,
    pub policy_ids: Vec<u32>,
    pub valid_until: Option<u32>,
}

/// The account's `__check_auth` signature.
#[contracttype]
#[derive(Clone, Debug)]
pub struct AuthPayload {
    pub signers: Map<Signer, Bytes>,
    pub context_rule_ids: Vec<u32>,
}

/// What a delegated signer authorises under 0.8.0, and what an external
/// signer signs the sha256 of.
#[contracttype]
#[derive(Clone, Debug, PartialEq)]
pub struct AuthDigestPreimage {
    pub account: Address,
    pub signature_payload: BytesN<32>,
    pub context_rule_ids: Vec<u32>,
}

// ---- the interpreter's types (`src/types.rs`) ----

#[contracttype]
#[derive(Clone, Debug)]
pub struct PolicyInstallParams {
    pub grammar_version: u32,
    pub install_nonce: u32,
    pub predicate: Bytes,
    pub predicate_hash: BytesN<32>,
    pub policy_admins: Vec<Signer>,
}

#[contracttype]
#[derive(Clone, Copy, Debug)]
pub struct Limits {
    pub max_reads: u32,
    pub max_leaves: u32,
    pub max_predicate_bytes: u32,
    pub max_elems: u32,
    pub max_in_operands: u32,
    pub max_depth: u32,
}

/// What grammar 7 shipped with (`tests/common/mod.rs` in the interpreter).
pub const DEFAULT: Limits = Limits {
    max_reads: 4,
    max_leaves: 200,
    max_predicate_bytes: 32 * 1024,
    max_elems: 32,
    max_in_operands: 32,
    max_depth: 5,
};

// ---- modelled contracts ----

#[contracttype]
enum Slot {
    Prime,
    Venue,
    Grants,
}

/// The authorisation calls of execution adapter v5 (`4985cd12`), without its
/// batch store, its gate or its argument checks. `run(id)` hands out the grants
/// a stored batch carries, asks the Prime for `(id)` and calls the venue, as
/// the adapter's `run` does. `execute(wait)` is the adapter's immediate path
/// with its arguments cut to the wait.
#[contract]
pub struct Executor;

#[contractimpl]
impl Executor {
    pub fn __constructor(e: Env, prime: Address, venue: Address) {
        e.storage().instance().set(&Slot::Prime, &prime);
        e.storage().instance().set(&Slot::Venue, &venue);
    }

    /// Test plumbing: the grants the batch hands out when it runs.
    pub fn arm(e: Env, grants: Vec<InvokerContractAuthEntry>) {
        e.storage().instance().set(&Slot::Grants, &grants);
    }

    pub fn run(e: Env, id: u32) {
        let prime = prime(&e);
        e.authorize_as_current_contract(grants(&e));
        prime.require_auth_for_args(soroban_sdk::vec![&e, id.into_val(&e)]);
        supply(&e, &prime);
    }

    pub fn execute(e: Env, wait: u32) {
        let prime = prime(&e);
        e.authorize_as_current_contract(grants(&e));
        prime.require_auth_for_args(soroban_sdk::vec![&e, wait.into_val(&e)]);
        supply(&e, &prime);
    }
}

fn prime(e: &Env) -> Address {
    e.storage().instance().get(&Slot::Prime).unwrap()
}

fn grants(e: &Env) -> Vec<InvokerContractAuthEntry> {
    e.storage()
        .instance()
        .get(&Slot::Grants)
        .unwrap_or(Vec::new(e))
}

fn supply(e: &Env, prime: &Address) {
    let venue: Address = e.storage().instance().get(&Slot::Venue).unwrap();
    VenueClient::new(e, &venue).submit(prime, &e.current_contract_address(), &MOVE);
}

/// A pool that asks `from`, as Blend's `submit` does, and counts what it got.
#[contract]
pub struct Venue;

#[contractimpl]
impl Venue {
    pub fn submit(e: Env, from: Address, _spender: Address, amount: i128) {
        from.require_auth();
        let total: i128 = e.storage().instance().get(&0u32).unwrap_or(0);
        e.storage().instance().set(&0u32, &(total + amount));
    }

    pub fn total(e: Env) -> i128 {
        e.storage().instance().get(&0u32).unwrap_or(0)
    }
}

/// A contract account that approves whatever reaches its `__check_auth`: a
/// delegated signer with no key. The host still matches its entry to the
/// exact call and arguments it authorises.
#[contract]
pub struct Approving;

#[contractimpl]
impl CustomAccountInterface for Approving {
    type Error = soroban_sdk::Error;
    type Signature = Val;

    fn __check_auth(
        _e: Env,
        _payload: Hash<32>,
        _signature: Val,
        _contexts: Vec<Context>,
    ) -> Result<(), soroban_sdk::Error> {
        Ok(())
    }
}
