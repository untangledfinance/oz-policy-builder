#![no_std]
//! Test venue for the contract-call spike (testnet). It moves no token: it keeps a ledger, so a call is proven by its
//! effect on state and by who authorized it. `submit` has the shape of a Blend pool's `submit(from, spender, to, requests)`.
use soroban_sdk::{contract, contractimpl, contracttype, symbol_short, Address, Env, Map, Vec};

#[contracttype]
#[derive(Clone, Debug)]
pub struct Request {
    pub address: Address,
    pub amount: i128,
    pub request_type: u32,
}

#[contract]
pub struct Venue;

fn bump(e: &Env, from: &Address) {
    let n: u32 = e.storage().instance().get(&symbol_short!("calls")).unwrap_or(0);
    e.storage().instance().set(&symbol_short!("calls"), &(n + 1));
    e.storage().instance().set(&symbol_short!("last"), from);
}

#[contractimpl]
impl Venue {
    pub fn deposit(e: Env, from: Address, amount: i128, on_behalf_of: Address) {
        from.require_auth();
        let mut d: Map<Address, i128> = e.storage().instance().get(&symbol_short!("dep")).unwrap_or(Map::new(&e));
        d.set(on_behalf_of.clone(), d.get(on_behalf_of).unwrap_or(0) + amount);
        e.storage().instance().set(&symbol_short!("dep"), &d);
        bump(&e, &from);
    }

    pub fn withdraw(e: Env, from: Address, amount: i128, to: Address) {
        from.require_auth();
        let mut d: Map<Address, i128> = e.storage().instance().get(&symbol_short!("dep")).unwrap_or(Map::new(&e));
        d.set(to.clone(), d.get(to).unwrap_or(0) - amount);
        e.storage().instance().set(&symbol_short!("dep"), &d);
        bump(&e, &from);
    }

    pub fn submit(e: Env, from: Address, _spender: Address, _to: Address, requests: Vec<Request>) {
        from.require_auth();
        let mut k: Map<u32, i128> = e.storage().instance().get(&symbol_short!("kind")).unwrap_or(Map::new(&e));
        for r in requests.iter() {
            k.set(r.request_type, k.get(r.request_type).unwrap_or(0) + r.amount);
        }
        e.storage().instance().set(&symbol_short!("kind"), &k);
        bump(&e, &from);
    }

    pub fn deposits(e: Env, of: Address) -> i128 {
        let d: Map<Address, i128> = e.storage().instance().get(&symbol_short!("dep")).unwrap_or(Map::new(&e));
        d.get(of).unwrap_or(0)
    }
    pub fn kind_total(e: Env, kind: u32) -> i128 {
        let k: Map<u32, i128> = e.storage().instance().get(&symbol_short!("kind")).unwrap_or(Map::new(&e));
        k.get(kind).unwrap_or(0)
    }
    pub fn calls(e: Env) -> u32 {
        e.storage().instance().get(&symbol_short!("calls")).unwrap_or(0)
    }
    pub fn last(e: Env) -> Option<Address> {
        e.storage().instance().get(&symbol_short!("last"))
    }
}
