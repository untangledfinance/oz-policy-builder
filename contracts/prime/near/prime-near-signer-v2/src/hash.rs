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

pub fn hexv(s: &str) -> Vec<u8> {
    let b = s
        .strip_prefix("0x")
        .and_then(|h| hex::decode(h).ok())
        .unwrap_or_default();
    require!(s == format!("0x{}", hex::encode(&b)), "data");
    b
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

/// The Safe EIP-712 digest with the five gas and refund fields fixed at zero.
pub fn safe(
    safe: [u8; 32],
    to: [u8; 32],
    value: u128,
    data: &[u8],
    delegate: bool,
    nonce: u64,
) -> [u8; 32] {
    let k = |b: &[u8]| env::keccak256_array(b);
    let domain = k(&[
        &k(b"EIP712Domain(uint256 chainId,address verifyingContract)")[..],
        &word(84532),
        &safe,
    ]
    .concat());
    let ty = k(b"SafeTx(address to,uint256 value,bytes data,uint8 operation,uint256 safeTxGas,uint256 baseGas,uint256 gasPrice,address gasToken,address refundReceiver,uint256 nonce)");
    let v = [[0; 16].as_slice(), &value.to_be_bytes()].concat();
    let tx = k(&[
        &ty[..],
        &to,
        &v,
        &k(data),
        &word(delegate as u64),
        &[0; 160],
        &word(nonce),
    ]
    .concat());
    k(&[&[0x19, 1][..], &domain, &tx].concat())
}

/// Binds the program, every account with its flags and the data, so a vote fits exactly one instruction.
pub fn vote(
    seat: [u8; 32],
    valid_until: u64,
    program: [u8; 32],
    accounts: &[([u8; 32], bool, bool)],
    data: &[u8],
) -> [u8; 32] {
    let mut m = [program.as_slice(), &(accounts.len() as u16).to_be_bytes()].concat();
    for (key, signer, writable) in accounts {
        m.extend_from_slice(key);
        m.extend_from_slice(&[*signer as u8, *writable as u8]);
    }
    m.extend_from_slice(&(data.len() as u32).to_be_bytes());
    m.extend_from_slice(data);
    env::sha256_array(
        [
            b"prime-seat-vote".as_slice(),
            b"devnet",
            &seat,
            &valid_until.to_be_bytes(),
            &env::sha256(&m),
        ]
        .concat(),
    )
}

/// True when `key` is the Squads transaction (or proposal) address of `index` under `consensus`.
pub fn is_pda(
    key: &[u8; 32],
    program: &[u8; 32],
    consensus: &[u8; 32],
    index: u64,
    proposal: bool,
) -> bool {
    let tail: &[u8] = if proposal { b"proposal" } else { b"" };
    (0..=255u8).rev().any(|bump| {
        let seeds = [
            b"smart_account".as_slice(),
            consensus,
            b"transaction",
            &index.to_le_bytes(),
            tail,
            &[bump],
            program,
            b"ProgramDerivedAddress",
        ];
        env::sha256_array(seeds.concat()) == *key
    })
}
