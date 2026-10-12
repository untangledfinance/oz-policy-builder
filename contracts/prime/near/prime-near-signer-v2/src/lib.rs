//! prime-near-signer v2: gives a wallet on another chain NEAR MPC signatures under keys only it controls, for the
//! Prime seat grants and votes. The caller sends typed fields; this contract parses each into fixed bytes (refusing any
//! spelling that is not canonical), renders the readable text, checks the wallet's signature over that text, applies the
//! time rules and asks the MPC to sign the chain hash it computes from the same fields. No request carries a free payload.
//!
//! Wallet text signatures: Sep53 = Freighter signMessage (ed25519 over sha256("Stellar Signed Message:\n" + text)),
//! Raw = Phantom signMessage (ed25519 over the text), Eip191 = MetaMask personal_sign. Stateless.
use near_sdk::{env, near, require, serde_json::json, AccountId, Gas, GasWeight, Promise};

mod hash;
mod render;
#[cfg(test)]
mod tests;

use hash::hexn;

const MPC: &str = match option_env!("PRIME_MPC") {
    Some(m) => m,
    None => "v1.signer-prod.testnet",
};

#[near(serializers=[json])]
#[derive(Clone, Copy, PartialEq, Debug)]
pub enum Scheme {
    Sep53,
    Raw,
    Eip191,
}

#[near(serializers=[json])]
#[derive(Clone, Copy, PartialEq, Debug)]
pub enum Chain {
    BaseSepolia,
    SolanaDevnet,
    StellarTestnet,
}

impl Chain {
    fn label(self) -> &'static str {
        ["Base Sepolia (84532)", "Solana devnet", "Stellar testnet"][self as usize]
    }
    fn slug(self) -> &'static str {
        ["evm", "solana", "stellar"][self as usize]
    }
}

#[near(serializers=[json])]
#[derive(Clone, Copy, PartialEq, Debug)]
pub enum Scope {
    Votes,
    RulesOnly,
}

#[near(serializers=[json])]
#[derive(Clone, Copy, PartialEq, Debug)]
pub enum Op {
    Call,
    DelegateCall,
}

#[near(serializers=[json])]
pub struct Meta {
    pub key: String,
    pub signer: bool,
    pub writable: bool,
}

#[near(serializers=[json])]
pub struct Ix {
    pub program: String,
    pub accounts: Vec<Meta>,
    pub data: String,
}

#[near(serializers=[json])]
pub struct SafeVote {
    pub safe: String,
    pub seat: String,
    pub to: String,
    pub value: String,
    pub data: String,
    pub operation: Op,
    pub nonce: u64,
}

#[near(serializers=[json])]
pub struct SolanaVote {
    pub settings: String,
    pub seat: String,
    pub consensus: String,
    pub index: u64,
    pub valid_until: u64,
    pub instruction: Ix,
}

#[near(serializers=[json])]
pub enum Request {
    Grant {
        chain: Chain,
        account: String,
        seat: String,
        key: String,
        start: u64,
        end: u64,
        scope: Scope,
    },
    End {
        chain: Chain,
        account: String,
        seat: String,
        key: String,
    },
    SafeVote(SafeVote),
    SolanaVote(SolanaVote),
}

pub struct Plan {
    pub text: String,
    pub path: String,
    pub domain: u32,
    pub payload: [u8; 32],
}

/// Parses and renders a request into the text to sign, the key path, the MPC domain and the 32-byte chain hash.
pub fn plan(wallet: &str, scheme: Scheme, request: &Request, now: u64, me: &str) -> Plan {
    if scheme == Scheme::Eip191 {
        hexn::<20>(wallet, "0x", "wallet");
    } else {
        hexn::<32>(wallet, "", "wallet");
    }
    let (chain, account, (text, payload)) = match request {
        Request::Grant {
            chain,
            account,
            seat,
            key,
            start,
            end,
            scope,
        } => {
            require!(*start <= now + 300, "start");
            require!(end > start && end - start <= 604_800, "window");
            let text = render::grant(*chain, [account, seat, key], *start, *end, *scope, me);
            (
                *chain,
                account,
                (text, hash::grant(*chain, account, seat, key, *start, *end)),
            )
        }
        Request::End {
            chain,
            account,
            seat,
            key,
        } => (
            *chain,
            account,
            (
                render::end(*chain, account, seat, key, me),
                hash::grant(*chain, account, seat, key, 0, 0),
            ),
        ),
        Request::SafeVote(v) => (Chain::BaseSepolia, &v.safe, render::safe(v, me)),
        Request::SolanaVote(v) => {
            require!(v.valid_until <= now + 900, "valid_until");
            (Chain::SolanaDevnet, &v.settings, render::solana(v, me))
        }
    };
    let domain = if chain == Chain::BaseSepolia { 0 } else { 1 };
    Plan {
        text,
        path: format!("{wallet}/prime:{}:{account}", chain.slug()),
        domain,
        payload,
    }
}

fn verify(scheme: Scheme, wallet: &str, text: &str, sig: &[u8]) -> bool {
    if scheme == Scheme::Eip191 {
        let v = sig.get(64).copied().unwrap_or(0);
        let digest = env::keccak256_array(
            [
                b"\x19Ethereum Signed Message:\n".as_slice(),
                text.len().to_string().as_bytes(),
                text.as_bytes(),
            ]
            .concat(),
        );
        let signer = (sig.len() == 65 && (27..=28).contains(&v))
            .then(|| env::ecrecover(&digest, &sig[..64], v - 27, true))
            .flatten();
        return signer
            .is_some_and(|pk| format!("0x{}", hex::encode(&env::keccak256(pk)[12..])) == wallet);
    }
    let Ok(s) = <[u8; 64]>::try_from(sig) else {
        return false;
    };
    let msg = if scheme == Scheme::Sep53 {
        env::sha256([b"Stellar Signed Message:\n".as_slice(), text.as_bytes()].concat())
    } else {
        text.as_bytes().to_vec()
    };
    env::ed25519_verify(&s, &msg, &hexn::<32>(wallet, "", "wallet"))
}

#[near(contract_state)]
#[derive(Default)]
pub struct Signer;

#[near]
impl Signer {
    #[payable]
    pub fn sign(
        &mut self,
        wallet: String,
        scheme: Scheme,
        request: Request,
        signature: String,
    ) -> Promise {
        let me = env::current_account_id();
        let p = plan(
            &wallet,
            scheme,
            &request,
            env::block_timestamp() / 1_000_000_000,
            me.as_str(),
        );
        require!(
            verify(
                scheme,
                &wallet,
                &p.text,
                &hex::decode(&signature).unwrap_or_default()
            ),
            "signature"
        );
        let alg = if p.domain == 0 { "Ecdsa" } else { "Eddsa" };
        let args = json!({ "request": { "path": p.path, "payload_v2": { alg: hex::encode(p.payload) }, "domain_id": p.domain } });
        Promise::new(
            MPC.parse::<AccountId>()
                .unwrap_or_else(|_| env::panic_str("mpc")),
        )
        .function_call_weight(
            "sign",
            args.to_string().into_bytes(),
            env::attached_deposit(),
            Gas::from_tgas(0),
            GasWeight(1),
        )
    }
}
