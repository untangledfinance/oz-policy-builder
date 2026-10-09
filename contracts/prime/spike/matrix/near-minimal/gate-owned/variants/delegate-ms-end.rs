//! gate (delegate, no queue): custody's token accounts are owned by an SPL Token multisig (custody's key, a trustee, optionally a backup). The multisig approves this program's
//! PDA as delegate on each account; the delegated amount is the cap and the token program enforces it. Funds leave through the gate only when the Prime Account's lane vault signs
//! `transfer`: to a token account whose owner is on the list fixed at creation, until the gate's end time, or to the recovery address at any time, and never beyond the cap.
//! Waits, cancels and approvals live in the Prime Account's Squads rules: a rule with a time lock stores the whole batch and runs it as one transaction.
//!
//! gate account (PDA ["gate", multisig, settings, seed]): multisig | settings | lane | recovery | until i64 | window u32 | seed 8 | bump | destinations (32 each)
//!   multisig = the SPL multisig that owns the source accounts; any one of its signers may create the gate (and pays its rent).
//!   lane = Squads vault `l` of `settings` (not 0, where session rules sign): agent rules created with that account_index, or the owners at their approval count, sign as it.
//!   until = unix time after which venue draws stop (recovery stays open). window = custody's run window: a call runs only in the last `window` seconds before the not-after its batch carries.
//! Errors: Custom(1) caller is not the lane, 2 destination not allowed (or the gate has ended), 4 outside the batch's run window (past its not-after, or more than the gate's window before it), 5 wrong account.
//! Custody's emergency stop: any one signer of the multisig ends the gate with `end` (venue draws stop at once, recovery stays open); nobody can undo it, so a resume takes M signers and a new gate.
//! `settings` must be an autonomous Squads account (no settings authority): that authority could add itself as an owner.
//! The multisig must belong to the same token program as the source accounts. A source with a close authority is refused: custody could keep it through the hand-over, close the
//! drawn-empty account and reopen the address as its own to receive the venue's proceeds alone.
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
        Some((&0, d)) if d.len() >= 53 && d.len() % 32 == 21 && d[52] != 0 => create(pid, a, d),
        Some((&1, d)) if d.len() == 16 => transfer(pid, a, d),
        Some((&2, [])) => end(a),
        _ => Err(E::InvalidInstructionData),
    }
}

// d: recovery | until i64 | window u32 | seed 8 | lane u8 | destinations. a: member (a signer of the multisig, pays the rent), gate, settings, system program, multisig
fn create(pid: &Pubkey, a: &[AccountInfo], d: &[u8]) -> ProgramResult {
    let [member, gate, settings, _system, ms] = a else { return Err(E::NotEnoughAccountKeys) };
    let autonomous = settings.try_borrow_data()?.get(24..56) == Some(&[0; 32][..]);
    if !member.is_signer || !signs_for(ms, member.key) || settings.owner != &SQUADS || !autonomous { return Err(E::Custom(5)) }
    let lane = Pubkey::find_program_address(&[b"smart_account", settings.key.as_ref(), b"smart_account", &d[52..53]], &SQUADS).0;
    let seeds = [b"gate".as_ref(), ms.key.as_ref(), settings.key.as_ref(), &d[44..52]];
    let bump = Pubkey::find_program_address(&seeds, pid).1; // CreateAccount needs the gate's signature, which only the derived address gets
    let body = [ms.key.as_ref(), settings.key.as_ref(), lane.as_ref(), &d[..52], &[bump], &d[53..]].concat();
    let data = [&[0, 0, 0, 0][..], &Rent::get()?.minimum_balance(body.len()).to_le_bytes(), &(body.len() as u64).to_le_bytes(), pid.as_ref()].concat();
    let ix = Instruction::new_with_bytes(Pubkey::default(), &data, vec![AccountMeta::new(*member.key, true), AccountMeta::new(*gate.key, true)]); // System CreateAccount
    invoke_signed(&ix, a, &[&[seeds[0], seeds[1], seeds[2], seeds[3], &[bump]]])?;
    gate.try_borrow_mut_data()?.copy_from_slice(&body);
    Ok(())
}

// d: amount u64 | not_after i64 (the batch's last second, set when the batch is built; it runs only in the window before it). a: gate, lane (signer), source (its owner approved the gate), destination, token program
fn transfer(pid: &Pubkey, a: &[AccountInfo], d: &[u8]) -> ProgramResult {
    let [gate, lane, src, dst, tok] = a else { return Err(E::NotEnoughAccountKeys) };
    if gate.owner != pid { return Err(E::Custom(5)) }
    let g = gate.try_borrow_data()?.to_vec();
    if !lane.is_signer || lane.key.as_ref() != &g[64..96] { return Err(E::Custom(1)) }
    let to = dst.try_borrow_data()?.get(32..64).ok_or(E::Custom(5))?.to_vec();
    let now = Clock::get()?.unix_timestamp;
    let (by, window) = (i64::from_le_bytes(d[8..16].try_into().unwrap()), u32::from_le_bytes(g[136..140].try_into().unwrap()) as i64);
    if now > by || by > now + window { return Err(E::Custom(4)) }
    let live = now <= i64::from_le_bytes(g[128..136].try_into().unwrap());
    if to != g[96..128] && !(live && g[149..].chunks_exact(32).any(|x| x == to)) { return Err(E::Custom(2)) }
    if !TOKEN.contains(tok.key) { return Err(E::Custom(5)) }
    if src.try_borrow_data()?.get(129..133) != Some(&[0; 4][..]) { return Err(E::Custom(5)) }
    let metas = vec![AccountMeta::new(*src.key, false), AccountMeta::new(*dst.key, false), AccountMeta::new_readonly(*gate.key, true)];
    invoke_signed(&Instruction::new_with_bytes(*tok.key, &[&[3][..], &d[..8]].concat(), metas), a, &[&[b"gate", &g[..32], &g[32..64], &g[140..148], &g[148..149]]])
}

// a: gate (writable), signer, multisig. Any one signer of the gate's multisig ends the gate: venue draws stop at once and recovery stays open.
fn end(a: &[AccountInfo]) -> ProgramResult {
    let [gate, signer, ms] = a else { return Err(E::NotEnoughAccountKeys) };
    let mut g = gate.try_borrow_mut_data()?;
    if !signer.is_signer || ms.key.as_ref() != &g[..32] || !signs_for(ms, signer.key) { return Err(E::Custom(1)) }
    g[128..136].fill(0);
    Ok(())
}

// Whether `k` is one of the signers of `ms`, an SPL multisig of Token or Token-2022 (355 bytes: m, n, initialized flag, 11 signer slots).
fn signs_for(ms: &AccountInfo, k: &Pubkey) -> bool {
    let Ok(d) = ms.try_borrow_data() else { return false };
    TOKEN.contains(ms.owner) && d[3..].chunks_exact(32).take(d[1] as usize).any(|s| s == k.as_ref())
}
