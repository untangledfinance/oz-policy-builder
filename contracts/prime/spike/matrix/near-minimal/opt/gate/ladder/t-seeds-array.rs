//! gate (owned, no queue): custody hands the owner AND the close authority of a dedicated token account to this program's gate PDA (SPL SetAuthority, close authority first). Only the
//! gate signs for the account, in three ways: the Prime Account's agent lane pays destinations on the list fixed at creation, until the end time, within the cap, with a not-after inside
//! custody's run window; the Prime Account's owners lane pays the recovery address at any time and is not bounded by the cap; custody's multisig releases the account back to a key it names.
//! The cap is the SPL delegated amount held by a second PDA (the cap PDA), so the token program enforces it on agent moves while recovery signs as the owner.
//! Waits, cancels and approvals live in the Prime Account's Squads rules: a rule with a time lock stores the whole batch and runs it as one transaction.
//!
//! gate account (PDA ["gate", multisig, settings, seed]): multisig | settings | agent lane | owners lane | recovery | until i64 | window u32 | seed 8 | bump | destinations (32 each)
//!   multisig = custody's identity, an SPL Token multisig (custody plus a trustee): any one signer creates the gate and lowers the cap, its threshold raises the cap and releases accounts.
//!   lane vaults = Squads vaults of `settings` (not 0, where session rules sign), different from each other.
//!   cap PDA = ["cap", gate]: the delegate of every account the gate owns.
//! Instructions: 0 create, 1 transfer, 2 allow (the cap), 3 release.
//! Errors: Custom(1) caller is not a lane or not enough signers of the multisig, 2 destination not allowed (or the gate has ended), 4 outside the batch's run window, 5 wrong account.
//! `settings` must be an autonomous Squads account (no settings authority): that authority could add itself as an owner.
use solana_program::{
    account_info::AccountInfo, clock::Clock, entrypoint, entrypoint::ProgramResult, instruction::{AccountMeta, Instruction},
    program::invoke_signed, program_error::ProgramError as E, pubkey, pubkey::Pubkey, rent::Rent, sysvar::Sysvar,
};

entrypoint!(process);

const SQUADS: Pubkey = pubkey!("SMRTzfY6DfH5ik3TKiyLFfXexV8uSG3d2UksSCYdunG");
const TOKEN: [Pubkey; 2] = [pubkey!("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"), pubkey!("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb")];

fn process(pid: &Pubkey, a: &[AccountInfo], d: &[u8]) -> ProgramResult {
    match d.split_first() {
        Some((&0, d)) if d.len() >= 54 && d.len() % 32 == 22 && d[52] != d[53] && d[52] != 0 && d[53] != 0 => create(pid, a, d),
        Some((&1, d)) if d.len() == 16 => transfer(pid, a, d),
        Some((&2, d)) if d.len() == 8 => allow(pid, a, d),
        Some((&3, d)) if d.len() == 32 => release(pid, a, d),
        _ => Err(E::InvalidInstructionData),
    }
}

// d: recovery | until i64 | window u32 | seed 8 | agent lane u8 | owners lane u8 | destinations. a: member (a signer of the multisig, pays the rent), gate, settings, system program, multisig
fn create(pid: &Pubkey, a: &[AccountInfo], d: &[u8]) -> ProgramResult {
    let [member, gate, settings, _system, ms] = a else { return Err(E::NotEnoughAccountKeys) };
    let (m, n, w) = votes(ms, &a[..1])?;
    need(w >= 1 && m <= n && settings.owner == &SQUADS && read(settings, 24..56)? == [0; 32], 5)?;
    let vault = |i: u8| Pubkey::find_program_address(&[b"smart_account", settings.key.as_ref(), b"smart_account", &[i]], &SQUADS).0;
    let seeds = [b"gate".as_ref(), ms.key.as_ref(), settings.key.as_ref(), &d[44..52]];
    let bump = [Pubkey::find_program_address(&seeds, pid).1];
    let body = [ms.key.as_ref(), settings.key.as_ref(), vault(d[52]).as_ref(), vault(d[53]).as_ref(), &d[..52], &bump, &d[54..]].concat();
    // Transfer, Allocate and Assign (not CreateAccount, which refuses an address that already holds lamports): a stranger's pre-funding cannot block the gate (the creator pays the full rent, the donation stays in the account).
    let sys = |tag: u8, x: &[u8], keys: &[&AccountInfo]| cpi(a, &Pubkey::default(), &[&[tag, 0, 0, 0][..], x].concat(), keys, keys.len(), keys.len(), &[seeds[0], seeds[1], seeds[2], seeds[3], &bump]);
    sys(2, &Rent::get()?.minimum_balance(body.len()).to_le_bytes(), &[member, gate])?;
    sys(8, &(body.len() as u64).to_le_bytes(), &[gate])?;
    sys(1, pid.as_ref(), &[gate])?;
    gate.try_borrow_mut_data()?.copy_from_slice(&body);
    Ok(())
}

// d: amount u64 | not_after i64 (the batch's last second, set when the batch is built; it runs only in the window before it). a: gate, lane (signer), source (owned by the gate), destination, token program, cap PDA
fn transfer(pid: &Pubkey, a: &[AccountInfo], d: &[u8]) -> ProgramResult {
    let [gate, lane, src, dst, tok, cap] = a else { return Err(E::NotEnoughAccountKeys) };
    let g = load(pid, gate)?;
    let (agent, owners) = (lane.key.as_ref() == &g[64..96], lane.key.as_ref() == &g[96..128]);
    need(lane.is_signer && (agent || owners), 1)?;
    let to = read(dst, 32..64)?;
    let (now, by) = (Clock::get()?.unix_timestamp, le(&d[8..16]) as i64);
    need(now <= by && by <= now + le(&g[168..172]) as i64, 4)?;
    need(if agent { now <= le(&g[160..168]) as i64 && g[181..].chunks_exact(32).any(|x| x == to) } else { to == g[128..160] }, 2)?;
    let data = [&[3][..], &d[..8]].concat();
    if owners { return call(a, tok, &data, &[src, dst, gate], 2, &gate_seeds(&g)) }
    // The agent signs as the cap PDA, the delegate. A source owned by the cap PDA itself would pay with no limit, so the source must be owned by the gate.
    let bump = Pubkey::find_program_address(&[b"cap", gate.key.as_ref()], pid).1;
    need(read(src, 32..64)? == gate.key.as_ref(), 5)?;
    call(a, tok, &data, &[src, dst, cap], 2, &[b"cap", gate.key.as_ref(), &[bump]])
}

// d: cap u64. a: gate, source (owned by the gate), token program, multisig, cap PDA, then the signers. One signer lowers or suspends (0) the cap; raising it takes the multisig's threshold.
// The source's close authority must be the gate or none: a holder of it could close the emptied account and open the address again as its own.
fn allow(pid: &Pubkey, a: &[AccountInfo], d: &[u8]) -> ProgramResult {
    let [gate, src, tok, ms, cap, signers @ ..] = a else { return Err(E::NotEnoughAccountKeys) };
    let g = load(pid, gate)?;
    let (m, _, w) = votes(ms, signers)?;
    let s = read(src, 0..165)?;
    need(ms.key.as_ref() == &g[..32] && w >= if le(&s[121..129]) < le(d) { m } else { 1 }, 1)?;
    need(Pubkey::find_program_address(&[b"cap", gate.key.as_ref()], pid).0 == *cap.key && (s[129..133] == [0; 4] || s[133..165] == *gate.key.as_ref()), 5)?;
    call(a, tok, &[&[4][..], d].concat(), &[src, cap, gate], 1, &gate_seeds(&g))
}

// d: the new owner and close authority. a: gate, source, token program, multisig, then the signers. The multisig's threshold hands the account back, close authority first (the gate signs as the
// close authority only while it is set or the gate is the owner).
fn release(pid: &Pubkey, a: &[AccountInfo], d: &[u8]) -> ProgramResult {
    let [gate, src, tok, ms, signers @ ..] = a else { return Err(E::NotEnoughAccountKeys) };
    let g = load(pid, gate)?;
    let (m, _, w) = votes(ms, signers)?;
    need(ms.key.as_ref() == &g[..32] && w >= m, 1)?;
    [3, 2].iter().try_for_each(|kind| call(a, tok, &[&[6, *kind, 1][..], d].concat(), &[src, gate], 1, &gate_seeds(&g)))
}

fn need(ok: bool, code: u32) -> ProgramResult { ok.then_some(()).ok_or(E::Custom(code)) }

fn le(b: &[u8]) -> u64 { b.iter().rev().fold(0, |x, &y| x << 8 | y as u64) }

fn read(x: &AccountInfo, r: std::ops::Range<usize>) -> Result<Vec<u8>, E> { x.try_borrow_data()?.get(r).map(<[u8]>::to_vec).ok_or(E::Custom(5)) }

fn load(pid: &Pubkey, gate: &AccountInfo) -> Result<Vec<u8>, E> {
    need(gate.owner == pid, 5)?;
    read(gate, 0..gate.data_len())
}

fn gate_seeds(g: &[u8]) -> [&[u8]; 5] { [b"gate", &g[..32], &g[32..64], &g[172..180], &g[180..181]] }

// The multisig's m and n, and how many of its signer slots the signers among `a` fill (a key listed twice fills two slots, as the token program counts; unused slots hold the zero key, which cannot sign).
fn votes(ms: &AccountInfo, a: &[AccountInfo]) -> Result<(usize, usize, usize), E> {
    let d = ms.try_borrow_data()?;
    need(TOKEN.contains(ms.owner), 5)?;
    let w = d[3..].chunks_exact(32).filter(|s| a.iter().any(|x| x.is_signer && x.key.as_ref() == *s)).count();
    Ok((d[0] as usize, d[1] as usize, w))
}

// A call to the token program: the first `w` accounts are writable and the last one signs through the seeds.
fn call(a: &[AccountInfo], tok: &AccountInfo, data: &[u8], keys: &[&AccountInfo], w: usize, seeds: &[&[u8]]) -> ProgramResult {
    need(TOKEN.contains(tok.key), 5)?;
    cpi(a, tok.key, data, keys, w, 1, seeds)
}

// invoke_signed with the first `w` accounts writable and the last `s` signing.
fn cpi(a: &[AccountInfo], prog: &Pubkey, data: &[u8], keys: &[&AccountInfo], w: usize, s: usize, seeds: &[&[u8]]) -> ProgramResult {
    let accounts = keys.iter().enumerate().map(|(i, k)| AccountMeta { pubkey: *k.key, is_writable: i < w, is_signer: i + s >= keys.len() }).collect();
    invoke_signed(&Instruction { program_id: *prog, accounts, data: data.to_vec() }, a, &[seeds])
}
