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

/// The default limits (`tests/common/mod.rs` in the interpreter).
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

/// The authorisation calls of the execution adapter (`4985cd12`), without its
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

// ---- the no-gate liquidation world (`tests/nogate.rs`) ----

/// The execution adapter's `Call` (`execution-adapter/src/lib.rs`).
#[contracttype]
#[derive(Clone)]
pub struct Call {
    pub target: Address,
    pub function_name: soroban_sdk::Symbol,
    pub args: Vec<Val>,
    pub executor_authorizations: Vec<InvokerContractAuthEntry>,
}

#[contracttype]
enum MarketSlot {
    Asset,
    Debt(Address),
    Cover(Address),
    Collateral(Address),
    Price,
    Updated,
}

/// A lending market as the liquidation meets it: `repay` pulls the borrowed
/// asset from the borrower (a nested request of the borrower, as OctoLend's
/// does), `withdraw_collateral` asks the borrower, and the rule reads the
/// debt, the cover, a price and when it was set.
#[contract]
pub struct Market;

#[contractimpl]
impl Market {
    pub fn __constructor(e: Env, asset: Address) {
        e.storage().instance().set(&MarketSlot::Asset, &asset);
    }

    /// Test plumbing: a position and a price.
    pub fn set(e: Env, who: Address, debt: i128, cover: i128, price: i128) {
        let s = e.storage().instance();
        s.set(&MarketSlot::Debt(who.clone()), &debt);
        s.set(&MarketSlot::Cover(who.clone()), &cover);
        s.set(&MarketSlot::Collateral(who), &debt);
        s.set(&MarketSlot::Price, &price);
        s.set(&MarketSlot::Updated, &e.ledger().timestamp());
    }

    pub fn repay(e: Env, borrower: Address, amount: i128) {
        borrower.require_auth();
        let asset: Address = e.storage().instance().get(&MarketSlot::Asset).unwrap();
        soroban_sdk::token::TokenClient::new(&e, &asset).transfer(
            &borrower,
            e.current_contract_address(),
            &amount,
        );
        let key = MarketSlot::Debt(borrower);
        let debt: i128 = e.storage().instance().get(&key).unwrap_or(0);
        e.storage().instance().set(&key, &(debt - amount));
    }

    pub fn withdraw_collateral(e: Env, borrower: Address, amount: i128) {
        borrower.require_auth();
        let key = MarketSlot::Collateral(borrower);
        let held: i128 = e.storage().instance().get(&key).unwrap_or(0);
        e.storage().instance().set(&key, &(held - amount));
    }

    pub fn debt(e: Env, who: Address) -> i128 {
        e.storage()
            .instance()
            .get(&MarketSlot::Debt(who))
            .unwrap_or(0)
    }

    pub fn cover(e: Env, who: Address) -> i128 {
        e.storage()
            .instance()
            .get(&MarketSlot::Cover(who))
            .unwrap_or(0)
    }

    pub fn collateral(e: Env, who: Address) -> i128 {
        e.storage()
            .instance()
            .get(&MarketSlot::Collateral(who))
            .unwrap_or(0)
    }

    pub fn price(e: Env) -> i128 {
        e.storage().instance().get(&MarketSlot::Price).unwrap_or(0)
    }

    pub fn updated(e: Env) -> u64 {
        e.storage()
            .instance()
            .get(&MarketSlot::Updated)
            .unwrap_or(0)
    }
}

/// A custody gate as the adapter asks it: the list it pays and its custody.
#[contract]
pub struct Gate;

#[contractimpl]
impl Gate {
    pub fn __constructor(e: Env, allowed: Vec<Address>, custody: Address) {
        e.storage().instance().set(&0u32, &allowed);
        e.storage().instance().set(&1u32, &custody);
    }

    pub fn allowed(e: Env) -> Vec<Address> {
        e.storage().instance().get(&0u32).unwrap()
    }

    pub fn custody(e: Env) -> Address {
        e.storage().instance().get(&1u32).unwrap()
    }
}

/// Asks `executor` for its word on `(account, context)`, as the interpreter's
/// `enforce` does, from a call the executor did not make directly: `Relay`
/// calls it. A probe of how long an executor's words live.
#[contract]
pub struct Asker;

#[contractimpl]
impl Asker {
    pub fn enforce(e: Env, executor: Address, account: Address, context: Context) {
        executor.require_auth_for_args((account, context).into_val(&e));
    }
}

#[contract]
pub struct Relay;

#[contractimpl]
impl Relay {
    pub fn go(e: Env, asker: Address, executor: Address, account: Address, context: Context) {
        AskerClient::new(&e, &asker).enforce(&executor, &account, &context);
    }
}

/// The probe's control: hands out `words` as itself, as an adapter does, then
/// has `Relay` ask it - so a live word is seen to pass the probe.
#[contract]
pub struct Granter;

#[contractimpl]
impl Granter {
    pub fn go(
        e: Env,
        words: Vec<InvokerContractAuthEntry>,
        relay: Address,
        asker: Address,
        account: Address,
        context: Context,
    ) {
        e.authorize_as_current_contract(words);
        RelayClient::new(&e, &relay).go(&asker, &e.current_contract_address(), &account, &context);
    }
}
