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
#![no_std]
use pinocchio::{
    account_info::AccountInfo, cpi::slice_invoke_signed, instruction::{AccountMeta, Instruction, Seed, Signer}, no_allocator, nostd_panic_handler, program_entrypoint,
    program_error::ProgramError as E, pubkey::{find_program_address, Pubkey}, sysvars::{clock::Clock, rent::Rent, Sysvar}, ProgramResult,
};
use pinocchio_pubkey::pubkey;

program_entrypoint!(process);
no_allocator!();
nostd_panic_handler!();

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
    need(w >= 1 && m <= n && settings.owner() == &SQUADS && read::<32>(settings, 24)? == [0; 32], 5)?;
    let vault = |i: u8| find_program_address(&[b"smart_account", settings.key(), b"smart_account", &[i]], &SQUADS).0;
    let seed = &d[44..52];
    let bump = [find_program_address(&[b"gate", ms.key(), settings.key(), seed], pid).1];
    let (len, signer) = (d.len() + 127, [Seed::from(b"gate"), Seed::from(ms.key()), Seed::from(settings.key()), Seed::from(seed), Seed::from(&bump)]);
    // Transfer, Allocate and Assign (not CreateAccount, which refuses an address that already holds lamports): a stranger's pre-funding cannot block the gate (the creator pays the full rent, the donation stays in the account).
    cpi(&[0; 32], &pack::<12>(&[2, 0, 0, 0], &Rent::get()?.minimum_balance(len).to_le_bytes()), &[member, gate], 2, 2, &signer)?;
    cpi(&[0; 32], &pack::<12>(&[8, 0, 0, 0], &(len as u64).to_le_bytes()), &[gate], 1, 1, &signer)?;
    cpi(&[0; 32], &pack::<36>(&[1, 0, 0, 0], pid), &[gate], 1, 1, &signer)?;
    let (mut o, mut body) = (0, gate.try_borrow_mut_data()?);
    for x in [ms.key(), settings.key(), &vault(d[52]), &vault(d[53]), &d[..52], &bump, &d[54..]] {
        body[o..o + x.len()].copy_from_slice(x);
        o += x.len();
    }
    Ok(())
}

// d: amount u64 | not_after i64 (the batch's last second, set when the batch is built; it runs only in the window before it). a: gate, lane (signer), source (owned by the gate), destination, token program, cap PDA
fn transfer(pid: &Pubkey, a: &[AccountInfo], d: &[u8]) -> ProgramResult {
    let [gate, lane, src, dst, tok, cap] = a else { return Err(E::NotEnoughAccountKeys) };
    let g = load(pid, gate)?;
    let (agent, owners) = (lane.key() == &g[64..96], lane.key() == &g[96..128]);
    need(lane.is_signer() && (agent || owners), 1)?;
    let to = read::<32>(dst, 32)?;
    let (now, by) = (Clock::get()?.unix_timestamp, le(&d[8..16]) as i64);
    need(now <= by && by <= now + le(&g[168..172]) as i64, 4)?;
    need(if agent { now <= le(&g[160..168]) as i64 && g[181..].chunks_exact(32).any(|x| x == to) } else { to == g[128..160] }, 2)?;
    let data = pack::<9>(&[3], &d[..8]);
    if owners { return call(tok, &data, &[src, dst, gate], 2, &gate_seeds(&g)) }
    // The agent signs as the cap PDA, the delegate. A source owned by the cap PDA itself would pay with no limit, so the source must be owned by the gate.
    let bump = [find_program_address(&[b"cap", gate.key()], pid).1];
    need(read::<32>(src, 32)? == *gate.key(), 5)?;
    call(tok, &data, &[src, dst, cap], 2, &[Seed::from(b"cap"), Seed::from(gate.key()), Seed::from(&bump)])
}

// d: cap u64. a: gate, source (owned by the gate), token program, multisig, cap PDA, then the signers. One signer lowers or suspends (0) the cap; raising it takes the multisig's threshold.
// The source's close authority must be the gate or none: a holder of it could close the emptied account and open the address again as its own.
fn allow(pid: &Pubkey, a: &[AccountInfo], d: &[u8]) -> ProgramResult {
    let [gate, src, tok, ms, cap, signers @ ..] = a else { return Err(E::NotEnoughAccountKeys) };
    let g = load(pid, gate)?;
    let (m, _, w) = votes(ms, signers)?;
    let s = read::<165>(src, 0)?;
    need(ms.key() == &g[..32] && w >= if le(&s[121..129]) < le(d) { m } else { 1 }, 1)?;
    need(find_program_address(&[b"cap", gate.key()], pid).0 == *cap.key() && (s[129..133] == [0; 4] || s[133..165] == *gate.key()), 5)?;
    call(tok, &pack::<9>(&[4], d), &[src, cap, gate], 1, &gate_seeds(&g))
}

// d: the new owner and close authority. a: gate, source, token program, multisig, then the signers. The multisig's threshold hands the account back, close authority first (the gate signs as the
// close authority only while it is set or the gate is the owner).
fn release(pid: &Pubkey, a: &[AccountInfo], d: &[u8]) -> ProgramResult {
    let [gate, src, tok, ms, signers @ ..] = a else { return Err(E::NotEnoughAccountKeys) };
    let g = load(pid, gate)?;
    let (m, _, w) = votes(ms, signers)?;
    need(ms.key() == &g[..32] && w >= m, 1)?;
    [3, 2].iter().try_for_each(|&kind| call(tok, &pack::<35>(&[6, kind, 1], d), &[src, gate], 1, &gate_seeds(&g)))
}

fn need(ok: bool, code: u32) -> ProgramResult { ok.then_some(()).ok_or(E::Custom(code)) }

fn le(b: &[u8]) -> u64 { b.iter().rev().fold(0, |x, &y| x << 8 | y as u64) }

// `head` and `x` side by side in an array of N bytes.
fn pack<const N: usize>(head: &[u8], x: &[u8]) -> [u8; N] {
    let mut o = [0; N];
    (o[..head.len()].copy_from_slice(head), o[head.len()..].copy_from_slice(x));
    o
}

// N bytes of the account's data from `at`, as a copy.
fn read<const N: usize>(x: &AccountInfo, at: usize) -> Result<[u8; N], E> { x.try_borrow_data()?.get(at..at + N).and_then(|b| b.try_into().ok()).ok_or(E::Custom(5)) }

fn load<'a>(pid: &Pubkey, gate: &'a AccountInfo) -> Result<pinocchio::account_info::Ref<'a, [u8]>, E> {
    need(gate.owner() == pid, 5)?;
    Ok(gate.try_borrow_data()?)
}

fn gate_seeds(g: &[u8]) -> [Seed; 5] { [Seed::from(b"gate"), Seed::from(&g[..32]), Seed::from(&g[32..64]), Seed::from(&g[172..180]), Seed::from(&g[180..181])] }

// The multisig's m and n, and how many of its signer slots the signers among `a` fill (a key listed twice fills two slots, as the token program counts; unused slots hold the zero key, which cannot sign).
fn votes(ms: &AccountInfo, a: &[AccountInfo]) -> Result<(usize, usize, usize), E> {
    let d = ms.try_borrow_data()?;
    need(TOKEN.contains(ms.owner()), 5)?;
    let w = d[3..].chunks_exact(32).filter(|s| a.iter().any(|x| x.is_signer() && x.key() == *s)).count();
    Ok((d[0] as usize, d[1] as usize, w))
}

// A call to the token program: the first `w` accounts are writable and the last one signs through the seeds.
fn call(tok: &AccountInfo, data: &[u8], keys: &[&AccountInfo], w: usize, seeds: &[Seed]) -> ProgramResult {
    need(TOKEN.contains(tok.key()), 5)?;
    cpi(tok.key(), data, keys, w, 1, seeds)
}

// A cross-program call with the first `w` accounts writable and the last `s` signing.
fn cpi(prog: &Pubkey, data: &[u8], keys: &[&AccountInfo], w: usize, s: usize, seeds: &[Seed]) -> ProgramResult {
    let metas: [AccountMeta; 3] = core::array::from_fn(|i| keys.get(i).map_or(AccountMeta::readonly(prog), |k| AccountMeta::new(k.key(), i < w, i + s >= keys.len())));
    slice_invoke_signed(&Instruction { program_id: prog, accounts: &metas[..keys.len()], data }, keys, &[Signer::from(seeds)])
}
