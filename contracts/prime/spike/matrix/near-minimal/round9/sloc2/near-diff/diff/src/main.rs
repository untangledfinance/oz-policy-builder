use ed25519_dalek::{Signer as _, SigningKey};
use near_sdk::test_utils::{get_created_receipts, VMContextBuilder};
use near_sdk::{testing_env, NearToken};
use sha2::{Digest, Sha256};
use std::panic::{catch_unwind, AssertUnwindSafe};

struct Rng(u64);
impl Rng {
    fn next(&mut self) -> u64 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 7;
        self.0 ^= self.0 << 17;
        self.0
    }
    fn below(&mut self, n: u64) -> u64 { self.next() % n }
    fn pick<'a>(&mut self, v: &'a [&'a str]) -> &'a str { v[self.below(v.len() as u64) as usize] }
}

#[derive(Clone, Debug)]
struct In { key: String, sep53: bool, path: String, domain: u32, payload: String, sig: String, deposit: u128 }

fn run_orig(i: &In) -> String {
    let base = get_created_receipts().len();
    let r = catch_unwind(AssertUnwindSafe(|| {
        let mut c = signer_orig::Signer::default();
        let _ = c.sign(i.key.clone(), i.sep53, i.path.clone(), i.domain, i.payload.clone(), i.sig.clone());
    }));
    out(r, base)
}
fn run_new(i: &In) -> String {
    let base = get_created_receipts().len();
    let r = catch_unwind(AssertUnwindSafe(|| {
        let mut c = signer_new::Signer::default();
        let _ = c.sign(i.key.clone(), i.sep53, i.path.clone(), i.domain, i.payload.clone(), i.sig.clone());
    }));
    out(r, base)
}
fn ctx(i: &In) {
    testing_env!(VMContextBuilder::new()
        .current_account_id("signer.prime-spike.testnet".parse().unwrap())
        .predecessor_account_id("relayer.testnet".parse().unwrap())
        .attached_deposit(NearToken::from_yoctonear(i.deposit))
        .prepaid_gas(near_sdk::Gas::from_tgas(300))
        .build());
}
fn out(r: Result<(), Box<dyn std::any::Any + Send>>, base: usize) -> String {
    match r {
        Ok(()) => {
            let all = get_created_receipts();
            let mut t = format!("OK {:?}", &all[base..]);
            while let Some(a) = t.find("receipt_index: ") {
                let end = a + 15 + t[a + 15..].find(|c: char| !c.is_ascii_digit()).unwrap();
                t.replace_range(a..end, "receipt_index=N");
            }
            t
        }
        Err(e) => format!("PANIC {}", e.downcast_ref::<String>().cloned().or_else(|| e.downcast_ref::<&str>().map(|s| s.to_string())).unwrap_or_default()),
    }
}

fn text(i: &In) -> String {
    format!("Prime NEAR signer\ncontract: signer.prime-spike.testnet\npath: {}\ndomain: {}\npayload: {}", i.path, i.domain, i.payload)
}
fn sign_for(sk: &SigningKey, i: &In, sep: bool) -> String {
    let t = text(i);
    let m = if sep { Sha256::digest([b"Stellar Signed Message:\n".as_slice(), t.as_bytes()].concat()).to_vec() } else { t.into_bytes() };
    hex::encode(sk.sign(&m).to_bytes())
}

fn main() {
    std::panic::set_hook(Box::new(|_| {}));
    let n: u64 = std::env::args().nth(1).and_then(|s| s.parse().ok()).unwrap_or(200_000);
    let mut r = Rng(0x9E3779B97F4A7C15);
    let paths = ["prime:evm", "prime:solana", "prime:stellar-session", "", "a\nb", "ü/é", "x".repeat(300).leak(), "p path/with/slash"];
    let payloads = ["00", "ab".repeat(32).leak(), "AB".repeat(32).leak(), "zz", "", "0xdeadbeef", "ff".repeat(64).leak(), "payload with spaces\n"];
    let (mut ok, mut panics, mut diffs) = (0u64, 0u64, 0u64);
    let mut kinds: std::collections::BTreeMap<String, u64> = Default::default();
    for c in 0..n {
        let sk = SigningKey::from_bytes(&[(r.below(250) + 1) as u8; 32]);
        let mut pubhex = hex::encode(sk.verifying_key().to_bytes());
        let mut i = In { key: pubhex.clone(), sep53: r.below(2) == 0, path: r.pick(&paths).to_string(), domain: [0, 1, 2, 7, u32::MAX][r.below(5) as usize], payload: r.pick(&payloads).to_string(), sig: String::new(), deposit: [1, 0, 2, 10u128.pow(24)][r.below(4) as usize] };
        // key variants
        match r.below(40) {
            0 => pubhex = pubhex.to_uppercase(),
            1 => pubhex.truncate(62),
            2 => pubhex.push_str("00"),
            3 => pubhex = format!("0x{pubhex}"),
            4 => pubhex.replace_range(0..1, "g"),
            5 => pubhex = String::new(),
            6 => pubhex.push('a'),
            7 => pubhex = format!(" {}", &pubhex[1..]),
            8 => pubhex = pubhex.replace(|c: char| c == 'a', "é"),
            _ => {}
        }
        i.key = pubhex;
        let signed_sep = if r.below(8) == 0 { !i.sep53 } else { i.sep53 };
        let mut sig = sign_for(&sk, &i, signed_sep);
        match r.below(50) {
            0 => sig = sig.to_uppercase(),
            1 => sig.truncate(126),
            2 => sig.push_str("00"),
            3 => sig = String::new(),
            4 => sig.replace_range(0..1, "z"),
            5 => sig = sig.replace('a', "A"),
            6 => { let other = SigningKey::from_bytes(&[251; 32]); sig = sign_for(&other, &i, i.sep53) }
            7 => { i.payload.push('0'); }
            8 => sig = format!("0x{sig}"),
            9 => sig.push('1'),
            _ => {}
        }
        i.sig = sig;
        if c % 8 == 0 { ctx(&i); }
        let (a, b) = (run_orig(&i), run_new(&i));
        if std::env::var("SHOW").is_ok() && a.starts_with("OK") { println!("{a}"); }
        *kinds.entry(if a.starts_with("OK") { "OK".into() } else { a.clone() }).or_default() += 1;
        if a.starts_with("OK") { ok += 1 } else { panics += 1 }
        if a != b {
            diffs += 1;
            if diffs <= 5 { eprintln!("DIFF case {c}: {i:?}\n orig: {a}\n new:  {b}"); }
        }
    }
    for (k, v) in &kinds { println!("  {v:>8}  {k}"); }
    println!("cases {n}: ok {ok}, panics {panics}, differences {diffs}");
    std::process::exit(if diffs == 0 { 0 } else { 1 });
}
