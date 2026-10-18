//! prime-seat: the seat of a NEAR-routed owner in a Squads Smart Account. The seat is the PDA ["seat", owner, settings]; the owner is an
//! ed25519 key held by NEAR MPC, so it never signs a Solana transaction. One owner signature, a grant, lets a session key act as the
//! seat on that account for at most 7 days. The grant is checked on every call through Solana's ed25519 program (instruction
//! introspection); it signs sha256("prime-seat-grant" | cluster | settings | seat | key | be64(start) | be64(end)). An End is the
//! same hash with start and end at 0; the owner (or the key itself) ends a session by creating an empty account at the marker
//! [owner, settings, key] that this program owns, and a call must pass that address and is refused when the account exists.
//! A session may do only what a vote needs: createProposal, activateProposal, approveProposal, rejectProposal, executeTransaction,
//! executeSettingsTransaction, and policy use, which is executeTransactionSyncV2 with a policy payload of kind 0, 1 or 2 (not SettingsChange, nor any kind Squads adds).
//! It cannot create a transaction, so the content of every change comes from a native owner.
//!
//! data: mode u8 (0 session action, 2 end) | owner (32) | settings (32) | sig_ix u8 | for mode 0: start i64 | end i64 | Squads data
//!   accounts: [0] instructions sysvar, [1] session key (signs a mode 0 call), [2] marker, [3..] the Squads call's accounts (for an end:
//!   the rent payer, then the System program)
use solana_program::{
    account_info::AccountInfo, clock::Clock, entrypoint::ProgramResult, hash::hashv,
    instruction::AccountMeta, instruction::Instruction, program::invoke_signed,
    program_error::ProgramError as E, pubkey, pubkey::Pubkey, sysvar::instructions, sysvar::Sysvar,
};

solana_program::entrypoint!(process);

const ED25519: Pubkey = pubkey!("Ed25519SigVerify111111111111111111111111111");
const SMART_ACCOUNT: Pubkey = pubkey!("SMRTzfY6DfH5ik3TKiyLFfXexV8uSG3d2UksSCYdunG");
// The signed text: this domain, then the account, the seat, the session key and start and end as 8 big-endian bytes each.
const DOMAIN: &[u8] = concat!("prime-seat-grant", env!("PRIME_CLUSTER")).as_bytes();
// The ed25519 instruction's header: one signature, its offsets (signature 48, key 16, message 112, 32 bytes), all in the instruction itself.
const ED25519_HEADER: &[u8] = b"\x01\0\x30\0\xff\xff\x10\0\xff\xff\x70\0\x20\0\xff\xff";
const SYNC_V2: u64 = 0x4e80462751bb515a;
// Squads discriminators (little-endian u64): create, activate, approve, reject proposal; execute transaction; execute settings transaction
const VOTE: [u64; 6] = [
    0x16c6a0d8ae447484,
    0x15bfb946eacbba5a,
    0x9307726255666c88,
    0x19660bbf52a4a272,
    0x134418eb5b31ade7,
    0xbd8fcc1b581bd283,
];

// Refusals: Custom(2) revoked, or a marker that the data does not derive; Custom(4) not within its time, or longer than 7 days;
// Custom(7) not signed by the owner over this grant; Custom(8) a call a session may not make; Custom(9) the key is the owner.
pub fn process(pid: &Pubkey, a: &[AccountInfo], d: &[u8]) -> ProgramResult {
    let ([sysvar, key, marker], tail) = a.split_first_chunk().ok_or(E::NotEnoughAccountKeys)?;
    let (head, rest) = d.split_at_checked(66).ok_or(E::InvalidInstructionData)?;
    let (mode, owner, settings, sig_ix) = (head[0], &head[1..33], &head[33..65], head[65]);
    let (times, inner) = match mode {
        0 => rest.split_at_checked(16).ok_or(E::InvalidInstructionData)?,
        2 => (&[0; 16][..], &[][..]),
        _ => return Err(E::InvalidInstructionData),
    };
    let time = |i: usize| i64::from_be_bytes(times[i..i + 8].try_into().unwrap());
    let (start, end) = (time(0), time(8));
    let k = key.key.as_ref();
    need(k != owner, E::Custom(9))?;
    let (seat, bump) = Pubkey::find_program_address(&[b"seat", owner, settings], pid);
    let (m, mb) = Pubkey::find_program_address(&[owner, settings, k], pid);
    need(m == *marker.key && marker.owner != pid, E::Custom(2))?;
    if mode == 0 || !key.is_signer {
        let h = hashv(&[DOMAIN, settings, seat.as_ref(), k, times]);
        signed_by(owner, h.as_ref(), sig_ix as usize, sysvar)?;
    }
    if mode == 2 {
        need(marker.lamports() > 0, E::InsufficientFunds)?;
        let ix = Instruction::new_with_bytes(
            Pubkey::default(),
            &[&[1, 0, 0, 0][..], pid.as_ref()].concat(),
            vec![AccountMeta::new(m, true)],
        );
        return invoke_signed(&ix, a, &[&[owner, settings, k, &[mb]]]);
    }
    need(key.is_signer, E::MissingRequiredSignature)?;
    let now = Clock::get()?.unix_timestamp;
    let live = start <= now && now <= end && end <= start.saturating_add(7 * 86_400);
    need(live, E::Custom(4))?;
    let tag = inner.first_chunk().map_or(0, |x| u64::from_le_bytes(*x));
    let sync = tag == SYNC_V2 && matches!(inner.get(10..12), Some([1, 0..=2]));
    need(sync || VOTE.contains(&tag), E::Custom(8))?;
    let metas = tail
        .iter()
        .map(|x| AccountMeta {
            pubkey: *x.key,
            is_signer: *x.key == seat || x.is_signer,
            is_writable: x.is_writable,
        })
        .collect();
    let ix = Instruction::new_with_bytes(SMART_ACCOUNT, inner, metas);
    invoke_signed(&ix, a, &[&[b"seat", owner, settings, &[bump]]])
}

// The ed25519 program checked `who`'s signature over `msg` in the instruction at `ix` of this transaction (it sits in that
// instruction's own data, in the layout of the header above, so what is read here is what was verified).
fn signed_by(who: &[u8], msg: &[u8], ix: usize, sysvar: &AccountInfo) -> ProgramResult {
    let pre = instructions::load_instruction_at_checked(ix, sysvar)?;
    let d = &pre.data;
    let ok = pre.program_id == ED25519 && d.len() == 144 && d[..16] == *ED25519_HEADER;
    need(ok && d[16..48] == *who && d[112..] == *msg, E::Custom(7))
}

fn need(ok: bool, e: E) -> ProgramResult {
    ok.then_some(()).ok_or(e)
}
