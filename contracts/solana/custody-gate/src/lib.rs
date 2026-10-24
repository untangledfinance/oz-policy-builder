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
    account_info::AccountInfo, clock::Clock, entrypoint, entrypoint::ProgramResult,
    instruction::AccountMeta, instruction::Instruction, program::invoke_signed,
    program_error::ProgramError as E, pubkey, pubkey::Pubkey, rent::Rent, sysvar::Sysvar,
};

entrypoint!(process);

const SQUADS: Pubkey = pubkey!("SMRTzfY6DfH5ik3TKiyLFfXexV8uSG3d2UksSCYdunG");
const TOKEN: Pubkey = pubkey!("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const TOKEN_22: Pubkey = pubkey!("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");
const SA: &[u8] = b"smart_account";

fn process(pid: &Pubkey, a: &[AccountInfo], d: &[u8]) -> ProgramResult {
    match d.split_first() {
        Some((&0, d))
            if d.len() >= 54 && d.len() % 32 == 22 && d[52] != d[53] && d[52].min(d[53]) > 0 =>
        {
            create(pid, a, d)
        }
        Some((&1, d)) if d.len() == 16 => transfer(pid, a, d),
        Some((&2, d)) if d.len() == 8 => allow(pid, a, d),
        Some((&3, d)) if d.len() == 32 => release(pid, a, d),
        _ => Err(E::InvalidInstructionData),
    }
}

// d: recovery | until i64 | window u32 | seed 8 | agent lane u8 | owners lane u8 | destinations. a: member (a signer of the multisig, pays the rent), gate, settings, system program, multisig
fn create(pid: &Pubkey, a: &[AccountInfo], d: &[u8]) -> ProgramResult {
    let [member, gate, settings, _system, ms] =
        <&[AccountInfo; 5]>::try_from(a).map_err(|_| E::NotEnoughAccountKeys)?;
    let (m, n, w) = votes(ms, &a[..1])?;
    let ok = w >= 1 && m <= n && settings.owner == &SQUADS && read(settings, 24..56)? == [0; 32];
    need(ok, 5)?;
    let (mk, sk) = (ms.key.as_ref(), settings.key.as_ref());
    let [x, y] =
        [d[52], d[53]].map(|i| Pubkey::find_program_address(&[SA, sk, SA, &[i]], &SQUADS).0);
    let bump = [Pubkey::find_program_address(&[b"gate", mk, sk, &d[44..52]], pid).1];
    let body = [mk, sk, x.as_ref(), y.as_ref(), &d[..52], &bump, &d[54..]].concat();
    // Transfer, Allocate and Assign (not CreateAccount, which refuses an address that already holds lamports): a stranger's pre-funding cannot block the gate (the creator pays the full rent, the donation stays in the account).
    let sys = |tag: u8, x: &[u8], k: &[&AccountInfo]| {
        let (d, s) = ([&[tag, 0, 0, 0][..], x].concat(), gate_seeds(&body));
        let m = k.iter().map(|x| AccountMeta::new(*x.key, true)).collect();
        let ix = Instruction::new_with_bytes(Pubkey::default(), &d, m);
        invoke_signed(&ix, a, &[&s])
    };
    let rent = Rent::get()?.minimum_balance(body.len()).to_le_bytes();
    sys(2, &rent, &[member, gate])?;
    sys(8, &(body.len() as u64).to_le_bytes(), &[gate])?;
    sys(1, pid.as_ref(), &[gate])?;
    Ok(gate.try_borrow_mut_data()?.copy_from_slice(&body))
}

// d: amount u64 | not_after i64 (the batch's last second, set when the batch is built; it runs only in the window before it). a: gate, lane (signer), source (owned by the gate), destination, token program, cap PDA
fn transfer(pid: &Pubkey, a: &[AccountInfo], d: &[u8]) -> ProgramResult {
    let [gate, lane, src, dst, tok, cap] =
        <&[AccountInfo; 6]>::try_from(a).map_err(|_| E::NotEnoughAccountKeys)?;
    let g = load(pid, gate)?;
    let (l, gk) = (lane.key.as_ref(), gate.key.as_ref());
    let agent = l == &g[64..96];
    need(lane.is_signer && (agent || l == &g[96..128]), 1)?;
    let to = read(dst, 32..64)?;
    let (now, by) = (Clock::get()?.unix_timestamp, le(&d[8..16]) as i64);
    need(now <= by && by <= now + le(&g[168..172]) as i64, 4)?;
    let list = if agent { &g[181..] } else { &g[128..160] };
    let ok = (!agent || now <= le(&g[160..168]) as i64) && list.chunks_exact(32).any(|x| x == to);
    need(ok, 2)?;
    let data = [&[3][..], &d[..8]].concat();
    if !agent {
        return call(a, data, &[tok, src, dst, gate], 2, &gate_seeds(&g));
    }
    need(read(src, 32..64)? == gk, 5)?;
    let bump = Pubkey::find_program_address(&[b"cap", gk], pid).1;
    call(a, data, &[tok, src, dst, cap], 2, &[b"cap", gk, &[bump]])
}

// d: cap u64. a: gate, source (owned by the gate), token program, multisig, cap PDA, then the signers. One signer lowers or suspends (0) the cap; raising it takes the multisig's threshold.
// The source's close authority must be the gate or none: a holder of it could close the emptied account and open the address again as its own.
fn allow(pid: &Pubkey, a: &[AccountInfo], d: &[u8]) -> ProgramResult {
    let ([gate, src, tok, ms, cap], sig) = a.split_first_chunk().ok_or(E::NotEnoughAccountKeys)?;
    let g = load(pid, gate)?;
    let (m, _, w) = votes(ms, sig)?;
    let s = read(src, 0..165)?;
    let ok = ms.key.as_ref() == &g[..32] && w >= if le(&s[121..129]) < le(d) { m } else { 1 };
    need(ok, 1)?;
    let gk = gate.key.as_ref();
    let ok = Pubkey::find_program_address(&[b"cap", gk], pid).0 == *cap.key;
    need(ok && (s[129..133] == [0; 4] || s[133..165] == *gk), 5)?;
    let data = [&[4][..], d].concat();
    call(a, data, &[tok, src, cap, gate], 1, &gate_seeds(&g))
}

// d: the new owner and close authority. a: gate, source, token program, multisig, then the signers. The multisig's threshold hands the account back, close authority first (the gate signs as the
// close authority only while it is set or the gate is the owner).
fn release(pid: &Pubkey, a: &[AccountInfo], d: &[u8]) -> ProgramResult {
    let ([gate, src, tok, ms], sig) = a.split_first_chunk().ok_or(E::NotEnoughAccountKeys)?;
    let g = load(pid, gate)?;
    let (m, _, w) = votes(ms, sig)?;
    need(ms.key.as_ref() == &g[..32] && w >= m, 1)?;
    let (gs, c) = (gate_seeds(&g), |k: u8| [&[6, k, 1][..], d].concat());
    call(a, c(3), &[tok, src, gate], 1, &gs)?;
    call(a, c(2), &[tok, src, gate], 1, &gs)
}

fn need(ok: bool, code: u32) -> ProgramResult {
    ok.then_some(()).ok_or(E::Custom(code))
}

fn le(b: &[u8]) -> u64 {
    b.iter().rev().fold(0, |x, &y| x << 8 | y as u64)
}

fn read(x: &AccountInfo, r: std::ops::Range<usize>) -> Result<Vec<u8>, E> {
    Ok(x.try_borrow_data()?.get(r).ok_or(E::Custom(5))?.to_vec())
}

fn load(pid: &Pubkey, gate: &AccountInfo) -> Result<Vec<u8>, E> {
    need(gate.owner == pid, 5)?;
    read(gate, 0..gate.data_len())
}

fn gate_seeds(g: &[u8]) -> [&[u8]; 5] {
    [b"gate", &g[..32], &g[32..64], &g[172..180], &g[180..181]]
}

// The multisig's m and n, and how many of its signer slots the signers among `a` fill (a key listed twice fills two slots, as the token program counts; unused slots hold the zero key, which cannot sign).
fn votes(ms: &AccountInfo, a: &[AccountInfo]) -> Result<(usize, usize, usize), E> {
    let d = ms.try_borrow_data()?;
    need([TOKEN, TOKEN_22].contains(ms.owner) && d.len() == 355, 5)?;
    let signs = |s: &[u8]| a.iter().any(|x| x.is_signer && x.key.as_ref() == s);
    let w = d[3..].chunks_exact(32).filter(|s| signs(s)).count();
    Ok((d[0] as usize, d[1] as usize, w))
}

// A call to the token program: keys[0] is the program, the next `w` accounts are writable and the last one signs through the seeds.
fn call(a: &[AccountInfo], d: Vec<u8>, k: &[&AccountInfo], w: usize, s: &[&[u8]]) -> ProgramResult {
    need([TOKEN, TOKEN_22].contains(k[0].key), 5)?;
    let m = k
        .iter()
        .enumerate()
        .skip(1)
        .map(|(i, x)| AccountMeta {
            pubkey: *x.key,
            is_writable: i <= w,
            is_signer: i + 1 == k.len(),
        })
        .collect();
    invoke_signed(&Instruction::new_with_bytes(*k[0].key, &d, m), a, &[s])
}
