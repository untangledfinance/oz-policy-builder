//! prime-session: one wallet signature -> a short-lived session key that acts as the wallet's session PDA, a member
//! of the Squads Smart Account's policies only (never a settings signer), so a session key can make the moves its
//! policy allows and can never vote as a seat. Stateless: the grant is re-checked on every move by Solana's ed25519
//! program (instruction introspection). A session ends at its time (at most 7 days), when its owner revokes that one
//! key, or when the account's 2-of-3 removes the PDA from the policy.
//!
//! The owner is an ed25519 key that signs plain text: Phantom's own key (`signMessage`), or a NEAR MPC key held for
//! MetaMask (its eth-implicit NEAR account) or Freighter (through prime-near-signer); the MPC signs the text bytes.
//! PDA = ["prime", owner, settings]: one per wallet per Smart Account, so a grant works in that account only.
//! The owner signs:
//!   "Prime session\nsigner: <PDA>\nsession key: <key>\nvalid until (unix time): <t>\ncluster: <c>"
//! Revoke = the same text with t = 0. It creates an empty account at [owner, settings, key] that this program owns;
//! a move must pass that address and is refused when the account exists. Only this program can assign it, so only the
//! owner's signature can create it.
//!
//! data: owner (32) | settings (32) | t i64 | sig_ix u8 | PDA bump u8 | Smart Account instruction data
//!   accounts: [0] ix sysvar, [1] session key (signs a move), [2] PDA, [3] Smart Account program (not checked; the
//!   System program for a revoke), [4] revoked marker, [5..] the Smart Account call's accounts (the rent payer first for a revoke)
use solana_program::{
    account_info::AccountInfo, clock::Clock, entrypoint::ProgramResult, instruction::AccountMeta,
    instruction::Instruction, program::invoke_signed, program_error::ProgramError as E, pubkey,
    pubkey::Pubkey, rent::Rent, sysvar::instructions, sysvar::Sysvar,
};

solana_program::entrypoint!(process);

const ED25519: Pubkey = pubkey!("Ed25519SigVerify111111111111111111111111111");
const SMART_ACCOUNT: Pubkey = pubkey!("SMRTzfY6DfH5ik3TKiyLFfXexV8uSG3d2UksSCYdunG");
const CLUSTER: &str = env!("PRIME_CLUSTER");

// Refusals: Custom(2) revoked, or a PDA or marker address that the data does not derive; Custom(4) expired or longer
// than 7 days; Custom(7) not signed by the owner over this text; MissingRequiredSignature if the session key did not
// sign. The inner call always goes to the Smart Account program (a constant, so no other target is possible).
fn process(pid: &Pubkey, a: &[AccountInfo], d: &[u8]) -> ProgramResult {
    let (owner, settings, rest) = (&d[..32], &d[32..64], &d[64..]);
    let ([ix_sysvar, signer, pda, _smart_account, marker], tail) =
        a.split_first_chunk().ok_or(E::NotEnoughAccountKeys)?;
    let until = le(&rest[..8]) as i64;
    let (sig_ix, bump, inner) = (rest[8], rest[9], &rest[10..]);
    need(signer.is_signer || until == 0, E::MissingRequiredSignature)?;
    let text = format!(
        "Prime session\nsigner: {}\nsession key: {}\nvalid until (unix time): {}\ncluster: {}",
        pda.key, signer.key, until, CLUSTER
    );
    // The owner's signature over `text` must have been checked in this transaction by the ed25519 program instruction at sig_ix, every field read from that
    // instruction itself. `w` holds its first eight little-endian words: count and padding, signature offset and index, key offset and index, message
    // offset, size and index (an index of 0xffff means the instruction itself).
    let pre = instructions::load_instruction_at_checked(sig_ix as usize, ix_sysvar)?;
    let w: Vec<usize> = pre.data.chunks_exact(2).take(8).map(le).collect();
    let [c, _, 0xffff, k, 0xffff, o, n, 0xffff] = w[..] else {
        return Err(E::Custom(7));
    };
    let ok = pre.program_id == ED25519 && c % 256 == 1 && pre.data.get(k..k + 32) == Some(owner);
    let ok = ok && pre.data.get(o..o + n) == Some(text.as_bytes());
    need(ok, E::Custom(7))?;
    // The marker is looked up under the verified owner and settings, and `settings` must be the one the text's PDA derives from.
    let seeds = [b"prime".as_ref(), owner, settings, &[bump]];
    let (m, mb) = Pubkey::find_program_address(&[owner, settings, signer.key.as_ref()], pid);
    let ok = m == *marker.key && marker.owner != pid;
    let pk = Pubkey::create_program_address(&seeds, pid);
    need(ok && pk? == *pda.key, E::Custom(2))?;
    if until == 0 {
        let ms = [owner, settings, signer.key.as_ref(), &[mb]];
        let sys = |tag: u8, x: &[u8], metas| {
            let d = [&[tag, 0, 0, 0][..], x].concat();
            let ix = Instruction::new_with_bytes(Pubkey::default(), &d, metas);
            invoke_signed(&ix, a, &[&ms])
        };
        let rent = Rent::get()?.minimum_balance(0).to_le_bytes();
        let pay = AccountMeta::new(*tail[0].key, true);
        sys(2, &rent, vec![pay, AccountMeta::new(m, false)])?;
        return sys(1, pid.as_ref(), vec![AccountMeta::new(m, true)]);
    }
    let now = Clock::get()?.unix_timestamp;
    need(now <= until && until <= now + 7 * 86_400, E::Custom(4))?;
    let metas = tail
        .iter()
        .map(|a| AccountMeta {
            pubkey: *a.key,
            is_signer: a.key == pda.key || a.is_signer,
            is_writable: a.is_writable,
        })
        .collect();
    let ix = Instruction::new_with_bytes(SMART_ACCOUNT, inner, metas);
    invoke_signed(&ix, a, &[&seeds])
}

fn need(ok: bool, e: E) -> ProgramResult {
    ok.then_some(()).ok_or(e)
}

fn le(b: &[u8]) -> usize {
    b.iter().rev().fold(0, |x, &y| x << 8 | y as usize)
}
