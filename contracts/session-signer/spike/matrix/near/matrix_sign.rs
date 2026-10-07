//! One NEAR MPC signature for the wallet matrix, requested through a NEAR wallet-contract account.
//!
//! Env: WALLET = freighter (SEP-53 schema; signs via `freighter-sign.ts`, Freighter's code path)
//!             | phantom   (text-ed25519 schema; Phantom `signMessage` over readable text, local key)
//!      DOMAIN = 1 (ed25519: Stellar/Solana key; SPIKE_SIGN_HEX = message bytes)
//!             | 0 (secp256k1: EVM key; SPIKE_SIGN_HEX = 32-byte prehash)
//!      SPIKE_PATH, SPIKE_SIGN_HEX (omit to only print the derived key),
//!      NEAR_NETWORK / NEAR_ACCOUNT_ID / NEAR_PRIVATE_KEY (relayer), SEP53_CODE_HASH, TEXT_CODE_HASH.
//! Prints: ACCOUNT <near id>, PK <hex> (ed25519 32 B | secp256k1 uncompressed 64 B), ADDR 0x.. (domain 0),
//!         SIG <hex> (ed25519 64 B | secp256k1 r||s 64 B) and V <recovery id> (domain 0).
use std::{process::Command, time::Instant};

use anyhow::{Context, Result, anyhow, bail};
use defuse_crypto::{ed25519::{Ed25519, Ed25519PublicKey, Ed25519Signature, ed25519_dalek}, secp256k1::{Secp256k1, Secp256k1UncompressedPublicKey}};
use defuse_sep53::Sep53;
use defuse_wallet::{RequestMessage, SignatureSchema, offchain::OffchainMessage};
use defuse_wallet_sdk::{GlobalContractId, Proof, Wallet, WalletSigner};
use defuse_wallet_sdk::mpc::kdf::{DeriveSigner, RecoverableDeriveSigner};
use defuse_wallet_sep53::WalletSep53;
use defuse_wallet_text_ed25519::WalletTextEd25519;
use near_kit::Near;

const MPC: &str = "v1.signer-prod.testnet";
const JS_DIR: &str = "/home/ubuntu/work/near-session-spike";
const FREIGHTER: &str = "/home/ubuntu/work/near-wallet-spike/secrets/freighter-b.json";
const FREIGHTER_OWNER: &str = "/home/ubuntu/work/near-wallet-spike/secrets/freighter-a.json"; // public key only: names the NEAR account
const PHANTOM: &str = "/home/ubuntu/work/phantom-spike/secrets/phantom-test.json";

struct Freighter { key: ed25519_dalek::SigningKey }
impl Freighter {
    fn sign_text(&self, text: &str) -> Result<Proof> {
        let tmp = std::env::temp_dir().join(format!("matrix-sep53-{}.txt", std::process::id()));
        std::fs::write(&tmp, text)?;
        let out = Command::new("bun").current_dir(JS_DIR).args(["freighter-sign.ts", FREIGHTER, tmp.to_str().unwrap()]).output()?;
        std::fs::remove_file(&tmp).ok();
        if !out.status.success() { bail!("freighter-sign failed: {}", String::from_utf8_lossy(&out.stderr)) }
        let sig = ed25519_dalek::Signer::sign(&self.key, &Sep53::prehash(text));
        let js = String::from_utf8(out.stdout)?;
        if js.trim() != b64(&sig.to_bytes()) { bail!("Freighter JS and Rust SEP-53 signatures differ") }
        Ok(Ed25519Signature::from(sig).to_string())
    }
}
impl WalletSigner<WalletSep53> for Freighter {
    type Error = std::io::Error;
    fn public_key(&self) -> Ed25519PublicKey { self.key.verifying_key().into() }
    async fn sign_request_msg(&self, m: &RequestMessage) -> std::io::Result<Proof> { self.sign_text(&WalletSep53::request_text(m)).map_err(|e| std::io::Error::other(e.to_string())) }
    async fn sign_offchain_msg(&self, m: &OffchainMessage) -> std::io::Result<Proof> { self.sign_text(&WalletSep53::offchain_text(m)).map_err(|e| std::io::Error::other(e.to_string())) }
}

/// Phantom `signMessage`: plain ed25519 over the readable UTF-8 text (local key stands in for the extension).
struct Phantom { key: ed25519_dalek::SigningKey }
impl WalletSigner<WalletTextEd25519> for Phantom {
    type Error = std::io::Error;
    fn public_key(&self) -> Ed25519PublicKey { self.key.verifying_key().into() }
    async fn sign_request_msg(&self, m: &RequestMessage) -> std::io::Result<Proof> {
        Ok(Ed25519Signature::from(ed25519_dalek::Signer::sign(&self.key, WalletTextEd25519::request_text(m).as_bytes())).to_string())
    }
    async fn sign_offchain_msg(&self, m: &OffchainMessage) -> std::io::Result<Proof> {
        Ok(Ed25519Signature::from(ed25519_dalek::Signer::sign(&self.key, WalletTextEd25519::offchain_text(m).as_bytes())).to_string())
    }
}

fn b64(b: &[u8]) -> String {
    const T: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut s = String::new();
    for c in b.chunks(3) {
        let n = (c[0] as u32) << 16 | (*c.get(1).unwrap_or(&0) as u32) << 8 | *c.get(2).unwrap_or(&0) as u32;
        for i in 0..4 { s.push(if i <= c.len() { T[(n >> (18 - 6 * i) & 63) as usize] as char } else { '=' }); }
    }
    s
}

async fn run<S: SignatureSchema + 'static>(w: Wallet<S>, near: &Near) -> Result<()> where Wallet<S>: Clone {
    let id = w.account_id().clone();
    println!("ACCOUNT {id}");
    if near.view::<serde_json::Value>(id.as_str(), "w_public_key").await.is_err() { w.initialize().await?; }
    let path = std::env::var("SPIKE_PATH").context("SPIKE_PATH")?;
    let msg: Option<Vec<u8>> = std::env::var("SPIKE_SIGN_HEX").ok().map(|h| hex::decode(h)).transpose()?;
    let t = Instant::now();
    if std::env::var("DOMAIN").as_deref() == Ok("0") {
        let mpc = w.mpc_signer::<Secp256k1>(0).await?;
        let pk = Secp256k1UncompressedPublicKey::from(mpc.derive_public_key(&path));
        let addr = { use sha3::{Digest, Keccak256}; hex::encode(&Keccak256::digest(&pk.0[..])[12..]) };
        println!("PK {}\nADDR 0x{addr}", hex::encode(pk.0));
        if let Some(m) = msg {
            let prehash: [u8; 32] = m.try_into().map_err(|_| anyhow!("domain 0 needs a 32-byte prehash"))?;
            let (sig, rec) = mpc.derive_sign_recoverable(&path, &prehash).await?;
            println!("SIG {}\nV {}", hex::encode(sig.to_bytes()), rec.to_byte());
        }
    } else {
        let mpc = w.mpc_signer::<Ed25519>(1).await?;
        let pk = Ed25519PublicKey::from(mpc.derive_public_key(&path));
        println!("PK {}", hex::encode(pk.0));
        if let Some(m) = msg { println!("SIG {}", hex::encode(Ed25519Signature::from(mpc.derive_sign(&path, &m).await?).0)); }
    }
    eprintln!("mpc {:.1}s", t.elapsed().as_secs_f32());
    Ok(())
}

#[tokio::main]
async fn main() -> Result<()> {
    let near = Near::from_env()?;
    let code = |var: &str| -> Result<GlobalContractId> {
        let h: [u8; 32] = bs58::decode(std::env::var(var)?).into_vec()?.try_into().map_err(|_| anyhow!("code hash"))?;
        Ok(GlobalContractId::CodeHash(h))
    };
    let mpc_id = MPC.parse::<near_kit::AccountId>()?;
    match std::env::var("WALLET").as_deref() {
        Ok("freighter") => {
            let f: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(FREIGHTER)?)?;
            let sk = stellar_strkey::ed25519::PrivateKey::from_string(f["secret"].as_str().context("secret")?)?;
            // Run 5 moved account 0s2ee0a8… (derived from key A) to key B as an extension, and disabled A's
            // signature; Freighter (key B) acts on it as that extension.
            let fa: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(FREIGHTER_OWNER)?)?;
            let ska = stellar_strkey::ed25519::PrivateKey::from_string(fa["secret"].as_str().context("secret")?)?;
            let owner_pk: Ed25519PublicKey = ed25519_dalek::SigningKey::from_bytes(&ska.0).verifying_key().into();
            let a_id = Wallet::<WalletSep53>::new(code("SEP53_CODE_HASH")?, Freighter { key: ed25519_dalek::SigningKey::from_bytes(&ska.0) }).account_id().clone();
            let _ = owner_pk;
            let w = Wallet::<WalletSep53>::new(code("SEP53_CODE_HASH")?, Freighter { key: ed25519_dalek::SigningKey::from_bytes(&sk.0) })
                .with_client(near.clone()).with_relayer(near.clone()).with_mpc_contract_id(mpc_id)
                .as_extension_of(a_id).as_initialized_unchecked();
            run(w, &near).await
        }
        Ok("phantom") => {
            let k: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(PHANTOM)?)?;
            let raw = bs58::decode(k["secret"].as_str().context("secret")?).into_vec()?;
            let sk: [u8; 32] = raw[..32].try_into()?;
            let w = Wallet::<WalletTextEd25519>::new(code("TEXT_CODE_HASH")?, Phantom { key: ed25519_dalek::SigningKey::from_bytes(&sk) })
                .with_client(near.clone()).with_relayer(near.clone()).with_mpc_contract_id(mpc_id);
            run(w, &near).await
        }
        _ => bail!("WALLET must be freighter or phantom"),
    }
}
