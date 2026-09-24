#![no_std]
//! The client's own gatekeeper. It never holds funds: it holds an allowance
//! custody granted it, and spends strictly inside that.
//!
//! No admin, no setter, no upgrade. Changing anything means deploying another
//! gate, which needs custody's signatures - which is the point.
//!
//! WHICH TOKENS IT MAY DRAW IS NOT CONFIGURED HERE. A SAC allowance is granted
//! per token, so a token custody never approved has nothing to spend and the
//! transfer fails on its own. A list here would only repeat that, and be one
//! more thing to get wrong.
//!
//! IT TRUSTS CODE, NOT AN ADDRESS. A Soroban contract id is hash(network,
//! deployer, salt); the code hash is not part of it. So the party who deploys
//! the adapter can put whatever it likes at the address this gate names, and
//! naming the address alone buys nothing. `caller_code` is what custody
//! actually approves, and `pull` checks it on every draw. It also means the
//! order of deployment stops mattering: this gate can be deployed and funded
//! before the adapter exists. The approved hash needs no accessor: instance
//! storage is public, so anyone can read this whole configuration off chain.
use soroban_sdk::{
    contract, contracterror, contractimpl, contracttype, panic_with_error, symbol_short, token,
    Address, BytesN, Env, Executable, Symbol, Vec,
};

#[contracttype]
#[derive(Clone)]
pub struct Cfg {
    /// Whose money. The allowance is granted from here.
    pub custody: Address,
    /// The one adapter that may ask. Nothing else can call `pull`.
    pub caller: Address,
    /// The build that address must be running. Custody approves this hash.
    pub caller_code: BytesN<32>,
    /// Every address a batch through that adapter may name.
    pub allowed: Vec<Address>,
}

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum E {
    DestinationNotAllowed = 1,
    WrongCallerCode = 2,
}

const CFG: Symbol = symbol_short!("cfg");

#[contract]
pub struct CustodyGate;

#[contractimpl]
impl CustodyGate {
    pub fn __constructor(e: Env, cfg: Cfg) {
        e.storage().instance().set(&CFG, &cfg);
    }

    /// The perimeter, for the adapter that answers to this gate. Read-only,
    /// and the list alone so no reader has to redeclare `Cfg` to decode it.
    pub fn allowed(e: Env) -> Vec<Address> {
        let c: Cfg = e.storage().instance().get(&CFG).unwrap();
        c.allowed
    }

    /// Whose money this gate spends. The adapter asks so it knows who may
    /// move it onto a successor gate.
    pub fn custody(e: Env) -> Address {
        let c: Cfg = e.storage().instance().get(&CFG).unwrap();
        c.custody
    }

    pub fn pull(e: Env, token: Address, to: Address, amount: i128) {
        let c: Cfg = e.storage().instance().get(&CFG).unwrap();
        c.caller.require_auth();
        if c.caller.executable() != Some(Executable::Wasm(c.caller_code)) {
            panic_with_error!(&e, E::WrongCallerCode);
        }
        if !c.allowed.contains(&to) {
            panic_with_error!(&e, E::DestinationNotAllowed);
        }
        token::Client::new(&e, &token).transfer_from(
            &e.current_contract_address(),
            &c.custody,
            &to,
            &amount,
        );
    }
}

#[cfg(test)]
mod tests;
