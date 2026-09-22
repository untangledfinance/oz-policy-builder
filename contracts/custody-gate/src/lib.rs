#![no_std]
//! The institution's own contract. It holds the SAC allowance on their
//! custody account, so Prime holds none, and it answers exactly one question:
//! MAY FUNDS GO THERE?
//!
//! It knows nothing about Prime, adapters, interpreters or policies. Two
//! addresses and two lists: who may ask, which assets it may touch, and where
//! funds may land.
//!
//! WHICH ASSET IS PART OF WHAT IT IS. `pull` takes the token as an argument,
//! so a gate that did not name its assets could be asked for any asset the
//! custody account had granted it an allowance for - the destination was
//! bound per gate while the amount was bound per asset, and nothing tied the
//! asset a policy named to the asset the gate drew. Naming them here closes
//! that at the gate, whatever any policy above it remembers to pin.
//!
//! AMOUNT IS NOT BOUNDED HERE, and that is deliberate. It is bounded by the
//! allowance the custody account granted - one per asset, enforced by the
//! asset's own contract - and by the mandate Prime enforces. Holding a third
//! number here would duplicate the first, let the two drift, and make raising
//! a limit a redeployment: this contract has no setter, so its address would
//! change and every policy naming it would have to be re-pointed. A limit
//! lives where it can be raised in one custody transaction.
//!
//! It has no admin, no setter and no upgrade: to change the assets or the
//! destinations, deploy another one and re-approve. Re-approving is the
//! custody signing ceremony either way, so the change and its authorisation
//! are one act.
use soroban_sdk::{contract, contractimpl, contracttype, symbol_short, token, Address, Env, Symbol, Vec};

#[contracttype]
#[derive(Clone)]
pub struct Cfg {
    pub custody: Address,
    /// The only address allowed to ask. Satisfied by the contract-invoker
    /// rule, so no signature is needed and no ABI is assumed.
    pub caller: Address,
    /// Where funds may land.
    pub allowed: Vec<Address>,
    /// Which assets may be drawn. Each carries its own limit and expiry, in
    /// its own allowance on its own contract.
    pub assets: Vec<Address>,
}

const CFG: Symbol = symbol_short!("cfg");

#[contract]
pub struct CustodyGate;

#[contractimpl]
impl CustodyGate {
    pub fn __constructor(e: Env, cfg: Cfg) {
        e.storage().instance().set(&CFG, &cfg);
    }

    pub fn pull(e: Env, token: Address, to: Address, amount: i128) {
        let c: Cfg = e.storage().instance().get(&CFG).unwrap();
        c.caller.require_auth();
        assert!(c.assets.contains(&token), "asset");
        assert!(c.allowed.contains(&to), "destination");
        token::Client::new(&e, &token).transfer_from(
            &e.current_contract_address(),
            &c.custody,
            &to,
            &amount,
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use soroban_sdk::testutils::Address as _;
    use soroban_sdk::{token, vec, Env};

    struct F {
        e: Env,
        gate: Address,
        sac: Address,
        custody: Address,
        allowed: Address,
    }

    fn setup() -> F {
        let e = Env::default();
        e.mock_all_auths();
        let custody = Address::generate(&e);
        let caller = Address::generate(&e);
        let allowed = Address::generate(&e);
        let admin = Address::generate(&e);
        let sac = e.register_stellar_asset_contract_v2(admin.clone()).address();
        token::StellarAssetClient::new(&e, &sac).mint(&custody, &100);
        let gate = e.register(
            CustodyGate,
            (Cfg {
                custody: custody.clone(),
                caller: caller.clone(),
                allowed: vec![&e, allowed.clone()],
                assets: vec![&e, sac.clone()],
            },),
        );
        token::Client::new(&e, &sac).approve(&custody, &gate, &50, &10_000);
        F { e, gate, sac, custody, allowed }
    }

    #[test]
    fn pulls_to_an_allowed_destination() {
        let f = setup();
        CustodyGateClient::new(&f.e, &f.gate).pull(&f.sac, &f.allowed, &7);
        assert_eq!(token::Client::new(&f.e, &f.sac).balance(&f.custody), 93);
        assert_eq!(token::Client::new(&f.e, &f.sac).balance(&f.allowed), 7);
    }

    /// With no authorization supplied at all, `caller.require_auth()` bites.
    /// The happy paths above run under `mock_all_auths`, so without this one
    /// nothing here would show that the caller gate does anything.
    #[test]
    fn refuses_a_caller_that_did_not_authorize() {
        let f = setup();
        f.e.set_auths(&[]);
        assert!(CustodyGateClient::new(&f.e, &f.gate)
            .try_pull(&f.sac, &f.allowed, &7)
            .is_err());
        assert_eq!(token::Client::new(&f.e, &f.sac).balance(&f.custody), 100);
    }

    /// The hole this list exists to close: `pull` takes the token as an
    /// argument, so without it a gate could be asked for any asset the custody
    /// account had granted it an allowance for.
    #[test]
    fn refuses_an_asset_not_on_the_list() {
        let f = setup();
        let admin = Address::generate(&f.e);
        let other = f.e.register_stellar_asset_contract_v2(admin).address();
        token::StellarAssetClient::new(&f.e, &other).mint(&f.custody, &100);
        token::Client::new(&f.e, &other).approve(&f.custody, &f.gate, &50, &10_000);
        assert!(CustodyGateClient::new(&f.e, &f.gate)
            .try_pull(&other, &f.allowed, &7)
            .is_err());
        assert_eq!(token::Client::new(&f.e, &other).balance(&f.custody), 100);
    }

    #[test]
    fn refuses_a_destination_not_on_the_list() {
        let f = setup();
        let elsewhere = Address::generate(&f.e);
        assert!(CustodyGateClient::new(&f.e, &f.gate)
            .try_pull(&f.sac, &elsewhere, &7)
            .is_err());
        assert_eq!(token::Client::new(&f.e, &f.sac).balance(&f.custody), 100);
    }

    /// The allowance is the ceiling the custody account set, and the gate
    /// does not re-state it: the SAC refuses on its own.
    #[test]
    fn cannot_spend_past_the_allowance() {
        let f = setup();
        assert!(CustodyGateClient::new(&f.e, &f.gate)
            .try_pull(&f.sac, &f.allowed, &51)
            .is_err());
        assert_eq!(token::Client::new(&f.e, &f.sac).balance(&f.custody), 100);
    }
}
