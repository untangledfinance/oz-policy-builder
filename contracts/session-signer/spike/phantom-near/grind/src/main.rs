// Finds a gas value (u64 LE at `offset` in the borsh tx) so that sha256(tx) is valid UTF-8,
// using the same validity rules as Phantom's isValidUTF8. Usage: grind <tx_hex> <offset> <gas_min> <gas_max>
use sha2::{Digest, Sha256};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;

fn valid_utf8(e: &[u8]) -> bool { std::str::from_utf8(e).is_ok() }

fn main() {
    let a: Vec<String> = std::env::args().collect();
    let tx = hex::decode(&a[1]).unwrap();
    let off: usize = a[2].parse().unwrap();
    let (lo, hi): (u64, u64) = (a[3].parse().unwrap(), a[4].parse().unwrap());
    let threads = std::thread::available_parallelism().map(|n| n.get()).unwrap_or(4) as u64;
    let found = Arc::new(AtomicBool::new(false));
    let tries = Arc::new(AtomicU64::new(0));
    let t0 = std::time::Instant::now();
    let hs: Vec<_> = (0..threads).map(|t| {
        let (mut tx, found, tries) = (tx.clone(), found.clone(), tries.clone());
        std::thread::spawn(move || {
            let mut g = lo + t;
            let mut local = 0u64;
            while g <= hi && !found.load(Ordering::Relaxed) {
                tx[off..off + 8].copy_from_slice(&g.to_le_bytes());
                let h = Sha256::digest(&tx);
                local += 1;
                if valid_utf8(&h) && !found.swap(true, Ordering::SeqCst) {
                    tries.fetch_add(local, Ordering::Relaxed);
                    return Some((g, hex::encode(h)));
                }
                g += threads;
            }
            tries.fetch_add(local, Ordering::Relaxed);
            None
        })
    }).collect();
    let r = hs.into_iter().filter_map(|h| h.join().unwrap()).next();
    let (g, h) = r.expect("not found in range");
    println!("{g} {h} {} {:.1}", tries.load(Ordering::Relaxed), t0.elapsed().as_secs_f32());
}
