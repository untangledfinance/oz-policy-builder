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
    program::invoke_signed, program_error::ProgramError as E, pubkey::Pubkey, rent::Rent, sysvar::Sysvar,
};

entrypoint!(process);

const SQUADS: Pubkey = solana_program::pubkey!("SMRTzfY6DfH5ik3TKiyLFfXexV8uSG3d2UksSCYdunG");
const TOKEN: [Pubkey; 2] = [
    solana_program::pubkey!("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"),
    solana_program::pubkey!("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"),
];

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
    let autonomous = settings.try_borrow_data()?.get(24..56) == Some(&[0; 32][..]);
    if w < 1 || m > n || settings.owner != &SQUADS || !autonomous { return Err(E::Custom(5)) }
    let vault = |i: u8| Pubkey::find_program_address(&[b"smart_account", settings.key.as_ref(), b"smart_account", &[i]], &SQUADS).0;
    let seeds = [b"gate".as_ref(), ms.key.as_ref(), settings.key.as_ref(), &d[44..52]];
    let bump = Pubkey::find_program_address(&seeds, pid).1;
    let body = [ms.key.as_ref(), settings.key.as_ref(), vault(d[52]).as_ref(), vault(d[53]).as_ref(), &d[..52], &[bump], &d[54..]].concat();
    let top = Rent::get()?.minimum_balance(body.len()).to_le_bytes();
    // Transfer, Allocate and Assign (not CreateAccount, which refuses an address that already holds lamports): a stranger's pre-funding cannot block the gate (the creator pays the full rent, the donation stays in the account).
    let (g, system) = (|signer: bool| AccountMeta { pubkey: *gate.key, is_signer: signer, is_writable: true }, Pubkey::default());
    for (data, metas) in [
        ([&[2, 0, 0, 0][..], &top].concat(), vec![AccountMeta::new(*member.key, true), g(false)]),
        ([&[8, 0, 0, 0][..], &(body.len() as u64).to_le_bytes()].concat(), vec![g(true)]),
        ([&[1, 0, 0, 0][..], pid.as_ref()].concat(), vec![g(true)]),
    ] { invoke_signed(&Instruction::new_with_bytes(system, &data, metas), a, &[&[seeds[0], seeds[1], seeds[2], seeds[3], &[bump]]])? }
    gate.try_borrow_mut_data()?.copy_from_slice(&body);
    Ok(())
}

// d: amount u64 | not_after i64 (the batch's last second, set when the batch is built; it runs only in the window before it). a: gate, lane (signer), source (owned by the gate), destination, token program, cap PDA
fn transfer(pid: &Pubkey, a: &[AccountInfo], d: &[u8]) -> ProgramResult {
    let [gate, lane, src, dst, tok, cap] = a else { return Err(E::NotEnoughAccountKeys) };
    let g = load(pid, gate)?;
    let (agent, owners) = (lane.key.as_ref() == &g[64..96], lane.key.as_ref() == &g[96..128]);
    if !lane.is_signer || !(agent || owners) { return Err(E::Custom(1)) }
    let to = dst.try_borrow_data()?.get(32..64).ok_or(E::Custom(5))?.to_vec();
    let (now, by) = (Clock::get()?.unix_timestamp, i64::from_le_bytes(d[8..16].try_into().unwrap()));
    if now > by || by > now + u32::from_le_bytes(g[168..172].try_into().unwrap()) as i64 { return Err(E::Custom(4)) }
    if !(if agent { now <= i64::from_le_bytes(g[160..168].try_into().unwrap()) && g[181..].chunks_exact(32).any(|x| x == to) } else { to == g[128..160] }) { return Err(E::Custom(2)) }
    let metas = |auth: &AccountInfo| vec![AccountMeta::new(*src.key, false), AccountMeta::new(*dst.key, false), AccountMeta::new_readonly(*auth.key, true)];
    let data = [&[3][..], &d[..8]].concat();
    if owners { return call(a, tok, &data, metas(gate), &[b"gate", &g[..32], &g[32..64], &g[172..180], &g[180..181]]) }
    // The agent signs as the cap PDA, the delegate. A source owned by the cap PDA itself would pay with no limit, so the source must be owned by the gate.
    let bump = Pubkey::find_program_address(&[b"cap", gate.key.as_ref()], pid).1;
    if src.try_borrow_data()?.get(32..64) != Some(gate.key.as_ref()) { return Err(E::Custom(5)) }
    call(a, tok, &data, metas(cap), &[b"cap", gate.key.as_ref(), &[bump]])
}

// d: cap u64. a: gate, source (owned by the gate), token program, multisig, cap PDA, then the signers. One signer lowers or suspends (0) the cap; raising it takes the multisig's threshold.
// The source's close authority must be the gate or none: a holder of it could close the emptied account and open the address again as its own.
fn allow(pid: &Pubkey, a: &[AccountInfo], d: &[u8]) -> ProgramResult {
    let [gate, src, tok, ms, cap, signers @ ..] = a else { return Err(E::NotEnoughAccountKeys) };
    let g = load(pid, gate)?;
    let (m, _, w) = votes(ms, signers)?;
    let s = src.try_borrow_data()?.get(..165).ok_or(E::Custom(5))?.to_vec();
    let raise = u64::from_le_bytes(s[121..129].try_into().unwrap()) < u64::from_le_bytes(d.try_into().unwrap());
    if ms.key.as_ref() != &g[..32] || w < if raise { m } else { 1 } { return Err(E::Custom(1)) }
    let key = Pubkey::find_program_address(&[b"cap", gate.key.as_ref()], pid).0;
    if key != *cap.key || s[129..133] != [0; 4] && s[133..165] != *gate.key.as_ref() { return Err(E::Custom(5)) }
    let metas = vec![AccountMeta::new(*src.key, false), AccountMeta::new_readonly(key, false), AccountMeta::new_readonly(*gate.key, true)];
    call(a, tok, &[&[4][..], d].concat(), metas, &[b"gate", &g[..32], &g[32..64], &g[172..180], &g[180..181]])
}

// d: the new owner and close authority. a: gate, source, token program, multisig, then the signers. The multisig's threshold hands the account back, close authority first (the gate signs as the
// close authority only while it is set or the gate is the owner).
fn release(pid: &Pubkey, a: &[AccountInfo], d: &[u8]) -> ProgramResult {
    let [gate, src, tok, ms, signers @ ..] = a else { return Err(E::NotEnoughAccountKeys) };
    let g = load(pid, gate)?;
    let (m, _, w) = votes(ms, signers)?;
    if ms.key.as_ref() != &g[..32] || w < m { return Err(E::Custom(1)) }
    for kind in [3, 2] {
        let metas = vec![AccountMeta::new(*src.key, false), AccountMeta::new_readonly(*gate.key, true)];
        call(a, tok, &[&[6, kind, 1][..], d].concat(), metas, &[b"gate", &g[..32], &g[32..64], &g[172..180], &g[180..181]])?
    }
    Ok(())
}

fn load(pid: &Pubkey, gate: &AccountInfo) -> Result<Vec<u8>, E> {
    if gate.owner != pid { return Err(E::Custom(5)) }
    Ok(gate.try_borrow_data()?.to_vec())
}

// The multisig's m and n, and how many of its signer slots the signers among `a` fill (a key listed twice fills two slots, as the token program counts; unused slots hold the zero key, which cannot sign).
fn votes(ms: &AccountInfo, a: &[AccountInfo]) -> Result<(usize, usize, usize), E> {
    let d = ms.try_borrow_data()?;
    if !TOKEN.contains(ms.owner) { return Err(E::Custom(5)) }
    let w = d[3..].chunks_exact(32).filter(|s| a.iter().any(|x| x.is_signer && x.key.as_ref() == *s)).count();
    Ok((d[0] as usize, d[1] as usize, w))
}

// A call to the token program signed by one of the gate's PDAs.
fn call(a: &[AccountInfo], tok: &AccountInfo, data: &[u8], metas: Vec<AccountMeta>, seeds: &[&[u8]]) -> ProgramResult {
    if !TOKEN.contains(tok.key) { return Err(E::Custom(5)) }
    invoke_signed(&Instruction::new_with_bytes(*tok.key, data, metas), a, &[seeds])
}
