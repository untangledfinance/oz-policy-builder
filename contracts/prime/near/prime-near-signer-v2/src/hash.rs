use crate::Chain;
use near_sdk::{bs58, env, require};

pub fn hexn<const N: usize>(s: &str, pre: &str, what: &str) -> [u8; N] {
    let mut o = [0; N];
    let ok = s
        .strip_prefix(pre)
        .is_some_and(|h| hex::decode_to_slice(h, &mut o).is_ok());
    require!(ok && s == format!("{pre}{}", hex::encode(o)), what);
    o
}

/// Base58 has one spelling per byte string, so a 32-byte decode is canonical.
pub fn b58(s: &str) -> [u8; 32] {
    let b = bs58::decode(s)
        .into_vec()
        .ok()
        .and_then(|v| <[u8; 32]>::try_from(v).ok());
    require!(b.is_some(), "address");
    b.unwrap_or_default()
}

/// Stellar strkey: 56 uppercase base32 characters hold version, 32 bytes and a CRC16, so one spelling per key.
fn strkey(s: &str, version: u8) -> [u8; 32] {
    let (mut acc, mut n, mut out) = (0u32, 0, Vec::new());
    for c in s.bytes() {
        let v = match c {
            b'A'..=b'Z' => c - b'A',
            b'2'..=b'7' => c - b'2' + 26,
            _ => env::panic_str("address"),
        };
        acc = acc * 32 + v as u32;
        n += 5;
        if n >= 8 {
            n -= 8;
            out.push((acc >> n) as u8);
            acc &= (1 << n) - 1;
        }
    }
    let crc = out.iter().take(33).fold(0u16, |mut c, &b| {
        c ^= (b as u16) << 8;
        for _ in 0..8 {
            c = if c & 0x8000 != 0 {
                (c << 1) ^ 0x1021
            } else {
                c << 1
            };
        }
        c
    });
    require!(
        s.len() == 56 && out[0] == version && crc.to_le_bytes() == out[33..],
        "address"
    );
    out[1..33].try_into().unwrap_or_default()
}

/// The 32-byte form of an account, seat or session key; EVM addresses are left-padded as in abi.encode.
pub fn addr(chain: Chain, key: bool, s: &str) -> [u8; 32] {
    match chain {
        Chain::BaseSepolia => {
            let mut o = [0; 32];
            o[12..].copy_from_slice(&hexn::<20>(s, "0x", "address"));
            o
        }
        Chain::SolanaDevnet => b58(s),
        Chain::StellarTestnet => strkey(s, if key { 6 << 3 } else { 2 << 3 }),
    }
}

fn word(n: u64) -> [u8; 32] {
    let mut o = [0; 32];
    o[24..].copy_from_slice(&n.to_be_bytes());
    o
}

/// What the owner's seat key signs for a grant; an End is the same hash with start and end zero.
pub fn grant(chain: Chain, account: &str, seat: &str, key: &str, start: u64, end: u64) -> [u8; 32] {
    let (a, s, k) = (
        addr(chain, false, account),
        addr(chain, false, seat),
        addr(chain, true, key),
    );
    let (st, en) = (start.to_be_bytes(), end.to_be_bytes());
    if chain == Chain::BaseSepolia {
        let ty = env::keccak256_array(b"PrimeSeatGrant(uint256 chainId,address safe,address seat,address key,uint64 start,uint64 end)");
        return env::keccak256_array(
            [
                ty.as_slice(),
                &word(84532),
                &a,
                &s,
                &k,
                &word(start),
                &word(end),
            ]
            .concat(),
        );
    }
    let net = if chain == Chain::SolanaDevnet {
        b"devnet".to_vec()
    } else {
        env::sha256(b"Test SDF Network ; September 2015")
    };
    env::sha256_array([b"prime-seat-grant".as_slice(), &net, &a, &s, &k, &st, &en].concat())
}
