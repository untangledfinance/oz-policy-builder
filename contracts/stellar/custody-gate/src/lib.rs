#![no_std]
//! The client's own gatekeeper. It never holds funds: it holds an allowance
//! custody granted it, and spends strictly inside that.
//!
//! WHO IT MAY PAY IS NARROWER THAN WHAT A BATCH MAY NAME. `allowed` is every
//! address a batch through the adapter may mention; `payees` is the strict
//! subset `pull` may actually pay. They differ because some addresses belong on
//! `allowed` only so a grant may name them as a policy to call - the interpreter
//! above all - and value must never land there. The constructor refuses a payee
//! that is not also on `allowed`.
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
    contract, contracterror, contractevent, contractimpl, contracttype, panic_with_error,
    symbol_short, token, Address, BytesN, Env, Executable, Symbol, Vec,
};

/// Published by `pull` after a draw settles. A custody monitor sees every move
/// out of the allowance from this, with the token and destination as topics, so
/// it can follow a payee without decoding the transfer. It is the last statement
/// of `pull`, after the caller, the code check, the payee check and the
/// transfer, so it changes no decision. The topics are documented in the README.
#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Pulled {
    #[topic]
    pub token: Address,
    #[topic]
    pub to: Address,
    pub amount: i128,
}

#[contracttype]
#[derive(Clone)]
pub struct Cfg {
    /// Whose money. The allowance is granted from here.
    pub custody: Address,
    /// The one adapter that may ask. Nothing else can call `pull`.
    pub caller: Address,
    /// The build that address must be running. Custody approves this hash.
    pub caller_code: BytesN<32>,
    /// Every address a batch through that adapter may name: call targets,
    /// arguments and the contexts grants vouch for are all checked against this.
    pub allowed: Vec<Address>,
    /// WHO `pull` MAY PAY. A strict subset of `allowed`, because value a gate
    /// moves must land only where custody chose. It leaves out any address that
    /// belongs on `allowed` only so a grant may name it as a policy to call -
    /// the policy interpreter above all, which must never receive value: a read
    /// leaf runs its target as the interpreter and keeps the effects, so funds
    /// at that address are swept by anyone who installs a rule that reads them.
    /// The constructor refuses a payee that is not also on `allowed`; keeping
    /// the interpreter off this list is the deployer's job, documented in the
    /// migration notes.
    pub payees: Vec<Address>,
}

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum E {
    DestinationNotAllowed = 1,
    WrongCallerCode = 2,
    PayeeNotAllowed = 3,
}

const CFG: Symbol = symbol_short!("cfg");

#[contract]
pub struct CustodyGate;

#[contractimpl]
impl CustodyGate {
    pub fn __constructor(e: Env, cfg: Cfg) {
        // A payee that custody never put on the perimeter could never be a
        // batch's destination anyway, so a payee off `allowed` is a mistake:
        // refuse it at creation rather than hold a list that can never pay.
        for p in cfg.payees.iter() {
            if !cfg.allowed.contains(&p) {
                panic_with_error!(&e, E::PayeeNotAllowed);
            }
        }
        e.storage().instance().set(&CFG, &cfg);
    }

    /// The perimeter, for the adapter that answers to this gate. Read-only,
    /// and the list alone so no reader has to redeclare `Cfg` to decode it.
    pub fn allowed(e: Env) -> Vec<Address> {
        let c: Cfg = e.storage().instance().get(&CFG).unwrap();
        c.allowed
    }

    /// Who `pull` may pay, for the adapter's own destination check. A subset of
    /// `allowed` that leaves out the interpreter and anything else that belongs
    /// on `allowed` only as a grant's policy, never as a place value may land.
    pub fn payees(e: Env) -> Vec<Address> {
        let c: Cfg = e.storage().instance().get(&CFG).unwrap();
        c.payees
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
        if !c.payees.contains(&to) {
            panic_with_error!(&e, E::DestinationNotAllowed);
        }
        token::Client::new(&e, &token).transfer_from(
            &e.current_contract_address(),
            &c.custody,
            &to,
            &amount,
        );
        Pulled { token, to, amount }.publish(&e);
    }
}

#[cfg(test)]
mod tests;
