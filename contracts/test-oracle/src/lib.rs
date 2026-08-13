#![no_std]

//! A Reflector-Pulse-compatible price feed, for TESTNET VERIFICATION ONLY.
//!
//! Stellar testnet runs a real Reflector instance, but it carries no price
//! records for the assets we test with, so every oracle read there fails
//! closed as `ORACLE_MISSING`. That proves the call binds, but it cannot
//! exercise the cases that matter: a price inside the bound, a price outside
//! it, a stale record, or two rounds that deviate too far.
//!
//! This contract implements the methods the interpreter calls - `decimals`,
//! `resolution`, `base`, `prices` - and lets a test seed exact records, so
//! each of those paths can be driven on a real network.
//!
//! It is NOT a production oracle: anyone may write to it. The interpreter
//! pins its feed address at compile time, so a build pointing here is a
//! different wasm hash than a mainnet build, and the two cannot be confused.
//!
//! ## Build / run recipe
//!
//! The interpreter's fingerprint pins `decimals`, `resolution`, AND `base`
//! (F7). The test-oracle stub must return the same base the interpreter
//! build was compiled with, or `check_fingerprint` will refuse every read
//! with `OracleFingerprintDrift` and the suite degenerates to a single
//! fail-closed path. Two supported combinations:
//!
//! ```text
//! 1. testnet (canonical for this suite):
//!    interpreter: cargo build --target wasm32v1-none --release
//!                 --features testnet
//!                 PULSE_FEED_ADDRESS=<test_oracle_address>
//!    stub init:   init(14, 300, CA2E53VHFZ6YSWQIEIPBXJQGT6VW3VKWWZO555XKRQXYJ63GEBJJGHY7)
//!                 (matches oracle::PINNED_BASE under --features testnet)
//!
//! 2. mainnet-pin build against the stub (NOT for the testnet suite):
//!    interpreter: cargo build --target wasm32v1-none --release
//!                 PULSE_FEED_ADDRESS=<test_oracle_address>
//!    stub init:   init(14, 300, CAS3J7GYLGXMF6TDJBBYYSE3HQ6BBSMLNUQ34T6TZMYMW2EVH34XOWMA)
//! ```

extern crate alloc;

use soroban_sdk::{
    contract, contractimpl, contracttype, Address, Env, String as SorobanString, Symbol, Vec,
};

/// Reflector's asset argument. Encodes as `[Symbol("Stellar"), Address]`.
#[contracttype]
#[derive(Clone, Debug)]
pub enum Asset {
    Stellar(Address),
    Other(Symbol),
}

#[contracttype]
#[derive(Clone, Debug)]
pub struct PriceData {
    pub price: i128,
    pub timestamp: u64,
}

const K_DECIMALS: u32 = 1;
const K_RESOLUTION: u32 = 2;
const K_PRICES: u32 = 3;
const K_BASE: u32 = 4;

/// Default base for the testnet-feature build: matches the value the
/// interpreter pins as `oracle::PINNED_BASE` under `--features testnet`
/// (live-probed against the testnet feed 2026-07-29; the previous XLM
/// SAC was a plan assumption the live feeds do not quote against).
/// Used as the unseeded default so a missed `init` call fails closed at
/// the fingerprint check rather than panicking on a missing value.
const DEFAULT_BASE_TESTNET: &str = "CA2E53VHFZ6YSWQIEIPBXJQGT6VW3VKWWZO555XKRQXYJ63GEBJJGHY7";

#[contract]
pub struct TestOracle;

#[contractimpl]
impl TestOracle {
    /// Seed the instance-wide fingerprint. The base MUST match the base
    /// the interpreter was compiled with - see the file-level docstring
    /// for the build/run recipe. Decimals and resolution default to the
    /// live Reflector DEX values (14, 300) when zero is passed, so an
    /// upgrade that drops the seed does not silently invalidate tests.
    pub fn init(e: &Env, decimals: u32, resolution: u32, base: Address) {
        let d = if decimals == 0 { 14 } else { decimals };
        let r = if resolution == 0 { 300 } else { resolution };
        e.storage().instance().set(&K_DECIMALS, &d);
        e.storage().instance().set(&K_RESOLUTION, &r);
        e.storage().instance().set(&K_BASE, &base);
    }

    /// Seed the records returned for an asset, newest first - the ordering
    /// the live feed uses. Prices and timestamps are parallel vectors because
    /// a `Vec` of a user-defined type is not a valid contract parameter.
    pub fn set_prices(e: &Env, asset: Address, prices: Vec<i128>, timestamps: Vec<u64>) {
        e.storage()
            .persistent()
            .set(&(K_PRICES, asset), &(prices, timestamps));
    }

    /// Remove an asset's records, so `prices` returns None the way the live
    /// feed does for an asset it does not track.
    pub fn clear_prices(e: &Env, asset: Address) {
        e.storage().persistent().remove(&(K_PRICES, asset));
    }

    pub fn decimals(e: &Env) -> u32 {
        e.storage().instance().get(&K_DECIMALS).unwrap_or(14)
    }

    pub fn resolution(e: &Env) -> u32 {
        e.storage().instance().get(&K_RESOLUTION).unwrap_or(300)
    }

    /// The asset the feed quotes against. Part of the interpreter's
    /// fingerprint. Defaults to the testnet XLM SAC when unseeded, which
    /// matches the canonical testnet-feature interpreter build; pass an
    /// explicit base to `init` to align with a different build.
    ///
    /// Returns the `Asset` enum (not a bare `Address`) - the shape the
    /// real Reflector contract sends, and the shape the interpreter's
    /// fingerprint match expects (`Asset::Stellar(addr)` for on-chain
    /// SACs, `Asset::Other(sym)` for off-chain quote units). A bare
    /// `Address` returns traps on the host-side decode: the test-oracle
    /// and the interpreter must agree on the wire shape, otherwise the
    /// fingerprint check dies before it can deny anything.
    pub fn base(e: &Env) -> Asset {
        let addr: Address = e.storage().instance().get(&K_BASE).unwrap_or_else(|| {
            Address::from_string(&SorobanString::from_str(e, DEFAULT_BASE_TESTNET))
        });
        Asset::Stellar(addr)
    }

    /// `records` is deliberately ignored: the live feed returned MORE records
    /// than requested during the live mainnet probe, and
    /// the interpreter must not depend on the count. Returning everything
    /// seeded keeps that property under test.
    pub fn prices(e: &Env, asset: Asset, records: u32) -> Option<Vec<PriceData>> {
        let _ = records;
        let key = match asset {
            Asset::Stellar(a) => a,
            Asset::Other(_) => return None,
        };
        let (prices, timestamps): (Vec<i128>, Vec<u64>) =
            e.storage().persistent().get(&(K_PRICES, key))?;
        let mut out: Vec<PriceData> = Vec::new(e);
        for i in 0..prices.len() {
            out.push_back(PriceData {
                price: prices.get(i).unwrap_or(0),
                timestamp: timestamps.get(i).unwrap_or(0),
            });
        }
        Some(out)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use soroban_sdk::testutils::Address as _;

    /// base() must return exactly what init seeded, otherwise the
    /// interpreter's fingerprint check (F7) refuses every read with
    /// OracleFingerprintDrift and the testnet suite degenerates. The
    /// return is wrapped in `Asset::Stellar` to mirror the wire shape
    /// the real Reflector contract sends - the round-trip asserts the
    /// address payload itself, not the enum tag.
    #[test]
    fn base_round_trips_through_init() {
        let e = Env::default();
        let contract_id = e.register(TestOracle, ());
        let client = TestOracleClient::new(&e, &contract_id);

        let seeded = Address::generate(&e);
        client.init(&14, &300, &seeded);
        match client.base() {
            Asset::Stellar(addr) => assert_eq!(addr, seeded),
            _ => panic!("base() returned the wrong variant"),
        }
    }

    /// When init is not called, base() must return a real value (the
    /// testnet XLM SAC default) so a missed seed fails closed at the
    /// fingerprint check rather than panicking on a missing value.
    #[test]
    fn base_defaults_when_unseeded() {
        let e = Env::default();
        let contract_id = e.register(TestOracle, ());
        let client = TestOracleClient::new(&e, &contract_id);
        let got = client.base();
        // The default is a stable testnet XLM SAC; the important property
        // is that the call returns without trapping, not the exact bytes.
        let _ = got;
    }

    /// Decimals/resolution defaults to the live Reflector DEX values
    /// (14, 300) when init is called with zeros, so a `init(0, 0, base)`
    /// does not silently lock the suite to wrong defaults. base() must
    /// wrap the seeded address in `Asset::Stellar` so the wire shape
    /// matches the live feed (see `base_round_trips_through_init`).
    #[test]
    fn init_zeros_default_to_live_reflector() {
        let e = Env::default();
        let contract_id = e.register(TestOracle, ());
        let client = TestOracleClient::new(&e, &contract_id);
        let base = Address::generate(&e);
        client.init(&0, &0, &base);
        assert_eq!(client.decimals(), 14);
        assert_eq!(client.resolution(), 300);
        match client.base() {
            Asset::Stellar(addr) => assert_eq!(addr, base),
            _ => panic!("base() returned the wrong variant"),
        }
    }
}
