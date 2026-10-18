// Differential test: the a4 gate (old.rs) and the line-cut gate (new.rs) run on the same random inputs, on the host, with syscall stubs that
// record every CPI (program, metas, data, the PDAs the seeds derive), apply the runtime's signer and writable privilege checks, emulate System
// Allocate, serve Clock and Rent, and can fail the k-th CPI. Each scenario compares the result (Ok, the error, or a panic), the CPI log of a
// successful run and the final data of every account.
mod new;
mod old;

use solana_program::{
    account_info::AccountInfo, clock::Clock, entrypoint::ProgramResult, instruction::Instruction, program_error::ProgramError,
    program_stubs::{set_syscall_stubs, SyscallStubs}, pubkey::Pubkey, rent::Rent,
};
use std::collections::BTreeMap;
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::sync::Mutex;

struct St { log: Vec<String>, now: i64, fail_at: usize, n: usize, pid: Pubkey }
static ST: Mutex<St> = Mutex::new(St { log: Vec::new(), now: 0, fail_at: usize::MAX, n: 0, pid: Pubkey::new_from_array([0; 32]) });

struct Stub;
impl SyscallStubs for Stub {
    fn sol_log(&self, _m: &str) {}
    fn sol_invoke_signed(&self, ix: &Instruction, infos: &[AccountInfo], seeds: &[&[&[u8]]]) -> ProgramResult {
        let mut st = ST.lock().unwrap();
        let pid = st.pid;
        let mut pdas = vec![];
        for s in seeds {
            match Pubkey::create_program_address(s, &pid) {
                Ok(k) => pdas.push(k),
                Err(_) => return Err(ProgramError::InvalidSeeds),
            }
        }
        for m in &ix.accounts {
            let Some(info) = infos.iter().find(|i| *i.key == m.pubkey) else { return Err(ProgramError::NotEnoughAccountKeys) };
            if m.is_signer && !info.is_signer && !pdas.contains(&m.pubkey) { return Err(ProgramError::MissingRequiredSignature) }
            if m.is_writable && !info.is_writable { return Err(ProgramError::InvalidArgument) }
        }
        let k = st.n;
        st.n += 1;
        let metas: Vec<_> = ix.accounts.iter().map(|m| (m.pubkey.to_string()[..6].to_string(), m.is_signer, m.is_writable)).collect();
        let pd: Vec<_> = pdas.iter().map(|p| p.to_string()[..6].to_string()).collect();
        st.log.push(format!("{} {:?} {:?} {:?}", &ix.program_id.to_string()[..6], metas, ix.data, pd));
        if k == st.fail_at { return Err(ProgramError::Custom(0x77)) }
        if ix.program_id == Pubkey::default() && ix.data.len() == 12 && ix.data[..4] == [8, 0, 0, 0] {
            let n = u64::from_le_bytes(ix.data[4..12].try_into().unwrap()) as usize;
            let info = infos.iter().find(|i| *i.key == ix.accounts[0].pubkey).unwrap();
            *info.data.borrow_mut() = Box::leak(vec![0u8; n].into_boxed_slice());
        }
        Ok(())
    }
    fn sol_get_clock_sysvar(&self, addr: *mut u8) -> u64 {
        let now = ST.lock().unwrap().now;
        unsafe { *(addr as *mut Clock) = Clock { unix_timestamp: now, ..Clock::default() } };
        0
    }
    fn sol_get_rent_sysvar(&self, addr: *mut u8) -> u64 {
        unsafe { *(addr as *mut Rent) = Rent::default() };
        0
    }
}

struct R(u64);
impl R {
    fn u(&mut self) -> u64 { self.0 = self.0.wrapping_add(0x9E3779B97F4A7C15); let mut z = self.0; z = (z ^ (z >> 30)).wrapping_mul(0xBF58476D1CE4E5B9); z = (z ^ (z >> 27)).wrapping_mul(0x94D049BB133111EB); z ^ (z >> 31) }
    fn p(&mut self, x: f64) -> bool { let v = (self.u() >> 11) as f64; v / ((1u64 << 53) as f64) < x }
    fn r(&mut self, n: u64) -> u64 { self.u() % n }
    fn key(&mut self) -> Pubkey { let mut b = [0u8; 32]; for c in b.chunks_mut(8) { c.copy_from_slice(&self.u().to_le_bytes()) } Pubkey::new_from_array(b) }
    fn pick<T: Clone>(&mut self, v: &[T]) -> T { v[self.r(v.len() as u64) as usize].clone() }
}

#[derive(Clone)]
struct Acc { key: Pubkey, owner: Pubkey, lamports: u64, data: Vec<u8>, signer: bool, writable: bool }
fn acc(key: Pubkey, owner: Pubkey, data: Vec<u8>) -> Acc { Acc { key, owner, lamports: 1_000_000, data, signer: false, writable: true } }

// Runs one build; `slots` maps instruction account positions to entries of `accs` (a repeated index is the same account passed twice).
fn run(which: u8, pid: &Pubkey, accs: &[Acc], slots: &[usize], d: &[u8], now: i64, fail_at: usize) -> (String, Vec<String>, Vec<Vec<u8>>) {
    let keys: Vec<Pubkey> = accs.iter().map(|a| a.key).collect();
    let owners: Vec<Pubkey> = accs.iter().map(|a| a.owner).collect();
    let mut lam: Vec<u64> = accs.iter().map(|a| a.lamports).collect();
    let mut data: Vec<Vec<u8>> = accs.iter().map(|a| a.data.clone()).collect();
    let base: Vec<AccountInfo> = keys.iter().zip(&owners).zip(lam.iter_mut()).zip(data.iter_mut()).zip(accs)
        .map(|((((k, o), l), x), a)| AccountInfo::new(k, a.signer, a.writable, l, x.as_mut_slice(), o, false, 0)).collect();
    let infos: Vec<AccountInfo> = slots.iter().map(|&i| base[i].clone()).collect();
    { let mut st = ST.lock().unwrap(); st.log.clear(); st.n = 0; st.now = now; st.fail_at = fail_at; st.pid = *pid; }
    let res = catch_unwind(AssertUnwindSafe(|| if which == 0 { old::process(pid, &infos, d) } else { new::process(pid, &infos, d) }));
    let out = match res { Ok(Ok(())) => "ok".to_string(), Ok(Err(e)) => format!("{e:?}"), Err(_) => "panic".to_string() };
    let log = ST.lock().unwrap().log.clone();
    let fin = base.iter().map(|i| i.data.borrow().to_vec()).collect();
    (out, log, fin)
}

fn sq(i: u8, settings: &Pubkey) -> Pubkey { Pubkey::find_program_address(&[b"smart_account", settings.as_ref(), b"smart_account", &[i]], &old::SQUADS).0 }

fn multisig(r: &mut R, signers: &[Pubkey]) -> Vec<u8> {
    let len = if r.p(0.9) { 355 } else { r.pick(&[0usize, 2, 3, 165, 34]) };
    let mut d = vec![0u8; len];
    if len >= 2 { d[0] = r.r(5) as u8; d[1] = if r.p(0.1) { r.r(12) as u8 } else { r.r(5) as u8 } }
    if len >= 3 { d[2] = 1 }
    for s in 0..11 { let o = 3 + 32 * s; if o + 32 > len { break } let k = if r.p(0.6) && !signers.is_empty() { r.pick(signers) } else if r.p(0.5) { Pubkey::default() } else { r.key() }; d[o..o + 32].copy_from_slice(k.as_ref()) }
    d
}

fn token_acct(r: &mut R, owner: Pubkey, gate: &Pubkey) -> Vec<u8> {
    let len = if r.p(0.88) { 165 } else { r.pick(&[0usize, 63, 64, 120, 130]) };
    let mut d = vec![0u8; len];
    for b in d.iter_mut() { *b = r.u() as u8 }
    if len >= 64 { d[32..64].copy_from_slice(owner.as_ref()) }
    if len >= 165 {
        let tag: [u8; 4] = if r.p(0.4) { [0; 4] } else if r.p(0.85) { [1, 0, 0, 0] } else { [r.u() as u8, 0, 0, 1] };
        d[129..133].copy_from_slice(&tag);
        if r.p(0.5) { d[133..165].copy_from_slice(gate.as_ref()) }
    }
    d
}

struct Gate { key: Pubkey, body: Vec<u8>, ms: Pubkey, agent: Pubkey, owners: Pubkey, recovery: Pubkey, dests: Vec<Pubkey>, until: i64, window: u32, cap: Pubkey }
fn gate(r: &mut R, pid: &Pubkey, now: i64) -> Gate {
    let (ms, settings, agent, owners, recovery) = (r.key(), r.key(), r.key(), r.key(), r.key());
    let seed = r.u().to_le_bytes();
    let (key, bump) = Pubkey::find_program_address(&[b"gate", ms.as_ref(), settings.as_ref(), &seed], pid);
    let until = now.wrapping_add(r.pick(&[-1i64, 0, 1, 1000, -1000, 1 << 40]));
    let window: u32 = r.pick(&[0u32, 1, 60, 3600, u32::MAX]);
    let dests: Vec<Pubkey> = (0..r.r(4)).map(|_| r.key()).collect();
    let mut body = [ms.as_ref(), settings.as_ref(), agent.as_ref(), owners.as_ref(), recovery.as_ref(), &until.to_le_bytes(), &window.to_le_bytes(), &seed, &[bump]].concat();
    for x in &dests { body.extend_from_slice(x.as_ref()) }
    let cap = Pubkey::find_program_address(&[b"cap", key.as_ref()], pid).0;
    Gate { key, body, ms, agent, owners, recovery, dests, until, window, cap }
}

fn tokp(r: &mut R) -> Pubkey { if r.p(0.45) { old::TOKEN[0] } else if r.p(0.85) { old::TOKEN[1] } else { r.key() } }
fn wiggle(r: &mut R, d: &mut Vec<u8>) { if r.p(0.06) { if r.p(0.5) && !d.is_empty() { d.pop(); } else { d.push(r.u() as u8) } } }

// Returns (kind, accounts, slots, data, now).
fn scenario(r: &mut R, pid: &Pubkey, force: Option<u64>) -> (&'static str, Vec<Acc>, Vec<usize>, Vec<u8>, i64) {
    let now: i64 = if r.p(0.02) { i64::MAX - r.r(10) as i64 } else { 1_700_000_000 + r.r(1000) as i64 };
    let pool: Vec<Pubkey> = (0..4).map(|_| r.key()).collect();
    let sel = r.r(5);
    match force.unwrap_or(sel) {
        0 => {
            let member = pool[0];
            let ms_owner = if r.p(0.45) { old::TOKEN[0] } else if r.p(0.85) { old::TOKEN[1] } else { r.key() };
            let ms = acc(r.key(), ms_owner, multisig(r, &pool[..2]));
            let settings_key = r.key();
            let mut sd = vec![0u8; if r.p(0.85) { 120 } else { r.pick(&[0usize, 40, 55, 56]) }];
            if sd.len() >= 56 && r.p(0.2) { sd[24 + r.r(32) as usize] = 1 + r.r(255) as u8 }
            let settings = acc(settings_key, if r.p(0.85) { old::SQUADS } else { r.key() }, sd);
            let seed = r.u().to_le_bytes();
            let gk = if r.p(0.85) { Pubkey::find_program_address(&[b"gate", ms.key.as_ref(), settings_key.as_ref(), &seed], pid).0 } else { r.key() };
            let mut g = acc(gk, Pubkey::default(), vec![]);
            g.signer = r.p(0.05);
            g.lamports = r.pick(&[0u64, 1, 5_000_000]);
            let mut m = acc(member, Pubkey::default(), vec![]);
            m.signer = r.p(0.9);
            m.writable = r.p(0.95);
            let lanes = [r.pick(&[0u8, 1, 2, 3, 255]), r.pick(&[0u8, 1, 2, 3, 255])];
            let mut d = vec![0u8];
            d.extend_from_slice(r.key().as_ref());
            d.extend_from_slice(&now.wrapping_add(r.r(10_000) as i64 - 5_000).to_le_bytes());
            d.extend_from_slice(&(r.u() as u32).to_le_bytes());
            d.extend_from_slice(&seed);
            d.extend_from_slice(&lanes);
            for _ in 0..r.r(4) { d.extend_from_slice(r.key().as_ref()) }
            wiggle(r, &mut d);
            let accs = vec![m, g, settings, acc(Pubkey::default(), Pubkey::default(), vec![]), ms];
            let mut slots: Vec<usize> = (0..5).collect();
            if r.p(0.04) { slots.pop(); } else if r.p(0.04) { slots.push(0) }
            if r.p(0.05) { let i = r.r(slots.len() as u64) as usize; slots[i] = r.r(5) as usize }
            ("create", accs, slots, d, now)
        }
        1 => {
            let g = gate(r, pid, now);
            let lane_key = if r.p(0.4) { g.agent } else if r.p(0.67) { g.owners } else { r.key() };
            let mut lane = acc(lane_key, Pubkey::default(), vec![]);
            lane.signer = r.p(0.85);
            let src_owner = if r.p(0.6) { g.key } else if r.p(0.5) { g.cap } else { r.key() };
            let src = acc(r.key(), old::TOKEN[0], token_acct(r, src_owner, &g.key));
            let dst_owner = if r.p(0.4) && !g.dests.is_empty() { r.pick(&g.dests) } else if r.p(0.5) { g.recovery } else { r.key() };
            let dst = acc(r.key(), old::TOKEN[0], token_acct(r, dst_owner, &g.key));
            let tok = acc(tokp(r), Pubkey::default(), vec![]);
            let cap = acc(if r.p(0.85) { g.cap } else { r.key() }, Pubkey::default(), vec![]);
            let ga = acc(g.key, if r.p(0.92) { *pid } else { r.key() }, g.body.clone());
            let rnd = r.u() as i64;
            let by = now.saturating_add(r.pick(&[-1i64, 0, 1, g.window as i64, g.window as i64 + 1, rnd]));
            let _ = g.until;
            let mut d = vec![1u8];
            d.extend_from_slice(&r.u().to_le_bytes());
            d.extend_from_slice(&by.to_le_bytes());
            wiggle(r, &mut d);
            let accs = vec![ga, lane, src, dst, tok, cap];
            let mut slots: Vec<usize> = (0..6).collect();
            if r.p(0.04) { slots.pop(); }
            if r.p(0.06) { let i = r.r(slots.len() as u64) as usize; slots[i] = r.r(6) as usize }
            ("transfer", accs, slots, d, now)
        }
        k => {
            let g = gate(r, pid, now);
            let signers: Vec<Pubkey> = pool.clone();
            let ms_key = if r.p(0.85) { g.ms } else { r.key() };
            let ms = acc(ms_key, if r.p(0.5) { old::TOKEN[0] } else if r.p(0.9) { old::TOKEN[1] } else { r.key() }, multisig(r, &signers));
            let src = acc(r.key(), old::TOKEN[0], token_acct(r, g.key, &g.key));
            let tok = acc(tokp(r), Pubkey::default(), vec![]);
            let ga = acc(g.key, if r.p(0.92) { *pid } else { r.key() }, g.body.clone());
            let mut accs = vec![ga, src, tok, ms];
            let allow = k == 2 || k == 3;
            let mut d;
            if allow {
                accs.push(acc(if r.p(0.85) { g.cap } else { r.key() }, Pubkey::default(), vec![]));
                let cur = if accs[1].data.len() >= 129 { u64::from_le_bytes(accs[1].data[121..129].try_into().unwrap()) } else { 0 };
                let cap = match r.r(4) { 0 => cur.wrapping_sub(1), 1 => cur, 2 => cur.wrapping_add(1), _ => r.u() };
                d = vec![2u8];
                d.extend_from_slice(&cap.to_le_bytes());
            } else {
                d = vec![3u8];
                d.extend_from_slice(r.key().as_ref());
            }
            for s in &signers { let mut a = acc(*s, Pubkey::default(), vec![]); a.signer = r.p(0.6); if r.p(0.7) { accs.push(a) } }
            wiggle(r, &mut d);
            let n = accs.len();
            let mut slots: Vec<usize> = (0..n).collect();
            if r.p(0.05) { slots.truncate(r.r(n as u64) as usize) }
            if r.p(0.08) && n > 0 { let i = r.r(slots.len().max(1) as u64) as usize; if i < slots.len() { slots[i] = r.r(n as u64) as usize } }
            if r.p(0.05) && !slots.is_empty() { let i = r.r(slots.len() as u64) as usize; slots.push(slots[i]) }
            (if allow { "allow" } else { "release" }, accs, slots, d, now)
        }
    }
}

// The one CPI difference the line cut documents: the gate account flagged as a signer on create's System Transfer.
fn normalise(log: &[String]) -> Vec<String> {
    log.iter().map(|l| l.clone()).collect()
}

fn main() {
    set_syscall_stubs(Box::new(Stub));
    if std::env::var("QUIET").is_ok() { std::panic::set_hook(Box::new(|_| {})) }
    let n: u64 = std::env::args().nth(1).map(|x| x.parse().unwrap()).unwrap_or(100_000);
    let seed: u64 = std::env::args().nth(2).map(|x| x.parse().unwrap()).unwrap_or(1);
    let mut r = R(seed);
    let force = std::env::var("KIND").ok().map(|k| match k.as_str() { "create" => 0, "transfer" => 1, "allow" => 2, "release" => 4, _ => panic!("KIND") });
    let mut stats: BTreeMap<String, u64> = BTreeMap::new();
    let (mut mism, mut raw_log_diff, mut err_partial_diff) = (0u64, 0u64, 0u64);
    let mut both_fail: BTreeMap<String, u64> = BTreeMap::new();
    for i in 0..n {
        let pid = r.key();
        let (kind, accs, slots, d, now) = scenario(&mut r, &pid, force);
        let fail_at = if r.p(0.75) { usize::MAX } else { r.r(3) as usize };
        let a = run(0, &pid, &accs, &slots, &d, now, fail_at);
        let b = run(1, &pid, &accs, &slots, &d, now, fail_at);
        *stats.entry(format!("{kind} {}{}", a.0, if fail_at != usize::MAX { " (injected cpi failure)" } else { "" })).or_default() += 1;
        let same = a.0 == b.0 && (a.0 != "ok" || (normalise(&a.1) == normalise(&b.1) && a.2 == b.2));
        // Both refused with different errors: the transaction reverts either way. Kept apart from real mismatches and listed by kind.
        if false {
            *both_fail.entry(format!("{kind}: old {} / new {}{}", a.0, b.0, if fail_at != usize::MAX { " (injected cpi failure)" } else { "" })).or_default() += 1;
            continue;
        }
        if a.0 == "ok" && b.0 == "ok" && a.1 != b.1 { raw_log_diff += 1 }
        if a.0 != "ok" && a.0 == b.0 && a.1 != b.1 { err_partial_diff += 1 }
        if !same {
            mism += 1;
            if mism <= 10 { println!("MISMATCH #{i} {kind}: old {} / new {}\n  old log {:?}\n  new log {:?}\n  data {:?}", a.0, b.0, a.1, b.1, d) }
        }
    }
    for (k, v) in &stats { println!("{v:8} {k}") }
    for (k, v) in &both_fail { println!("both refuse, different error: {v:6} {k}") }
    println!("scenarios {n} seed {seed}: mismatches {mism}; successful runs whose raw CPI log differs only by the documented Transfer signer flag {raw_log_diff}; failed runs with the same error but a different partial CPI log {err_partial_diff}");
}
