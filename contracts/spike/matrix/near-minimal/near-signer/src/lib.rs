//! prime-near-signer: gives an ed25519 wallet that cannot sign NEAR transactions (Freighter, Phantom) NEAR MPC
//! signatures under keys only it controls. The wallet signs one readable text per request; this contract checks it
//! and asks the MPC to sign `payload` under the path "<wallet key hex>/<path>" (predecessor: this contract).
//!
//! The wallet signs: "Prime NEAR signer\ncontract: <this>\npath: <path>\ndomain: <id>\npayload: <hex>"
//!   sep53 = true:  Freighter signMessage (ed25519 over sha256("Stellar Signed Message:\n" + text))
//!   sep53 = false: Phantom signMessage (ed25519 over the text)
//! Stateless: replaying a request only yields another signature over the same payload. The caller attaches the MPC deposit.
use near_sdk::{env, near, require, serde_json::json, AccountId, Gas, GasWeight, Promise};

const MPC: &str = match option_env!("PRIME_MPC") { Some(m) => m, None => "v1.signer-prod.testnet" };

#[near(contract_state)]
#[derive(Default)]
pub struct Signer;

#[near]
impl Signer {
    #[payable]
    pub fn sign(&mut self, key: String, sep53: bool, path: String, domain_id: u32, payload: String, signature: String) -> Promise {
        let k: [u8; 32] = hex::decode(&key).ok().and_then(|b| b.try_into().ok()).unwrap_or_else(|| env::panic_str("key"));
        let s: [u8; 64] = hex::decode(&signature).ok().and_then(|b| b.try_into().ok()).unwrap_or_else(|| env::panic_str("signature"));
        let text = format!("Prime NEAR signer\ncontract: {}\npath: {path}\ndomain: {domain_id}\npayload: {payload}", env::current_account_id());
        let msg = if sep53 { env::sha256([b"Stellar Signed Message:\n".as_slice(), text.as_bytes()].concat()) } else { text.into_bytes() };
        require!(env::ed25519_verify(&s, &msg, &k), "not signed by this key");
        let payload_v2 = if domain_id == 0 { json!({ "Ecdsa": payload }) } else { json!({ "Eddsa": payload }) };
        let args = json!({ "request": { "path": format!("{}/{path}", hex::encode(k)), "payload_v2": payload_v2, "domain_id": domain_id } });
        Promise::new(MPC.parse::<AccountId>().unwrap())
            .function_call_weight("sign", args.to_string().into_bytes(), env::attached_deposit(), Gas::from_tgas(0), GasWeight(1))
    }
}
