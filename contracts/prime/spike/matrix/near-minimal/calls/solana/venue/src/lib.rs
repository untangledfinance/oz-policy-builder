//! Test venue for the contract-call spike (local validator only). It moves no token: it keeps a ledger, so a call is
//! proven by its effect on state and by who signed, not by a transfer.
//!   data: 0 deposit | 1 withdraw, then amount u64 LE, then a beneficiary pubkey (32)
//!   accounts: [0] ledger (writable, owned by this program), [1] caller (signer)
//!   ledger: total u64 @0 | last caller @8 | last beneficiary @40 | calls u64 @72
use solana_program::{account_info::AccountInfo, entrypoint, entrypoint::ProgramResult, program_error::ProgramError, pubkey::Pubkey};

entrypoint!(process);

fn process(program_id: &Pubkey, accounts: &[AccountInfo], data: &[u8]) -> ProgramResult {
    let [ledger, caller, ..] = accounts else { return Err(ProgramError::NotEnoughAccountKeys) };
    if ledger.owner != program_id || !caller.is_signer || data.len() < 41 { return Err(ProgramError::InvalidArgument) }
    let amount = u64::from_le_bytes(data[1..9].try_into().unwrap());
    let mut l = ledger.try_borrow_mut_data()?;
    let total = u64::from_le_bytes(l[0..8].try_into().unwrap());
    let total = match data[0] { 0 => total.checked_add(amount), 1 => total.checked_sub(amount), _ => None }.ok_or(ProgramError::InvalidInstructionData)?;
    l[0..8].copy_from_slice(&total.to_le_bytes());
    l[8..40].copy_from_slice(caller.key.as_ref());
    l[40..72].copy_from_slice(&data[9..41]);
    let calls = u64::from_le_bytes(l[72..80].try_into().unwrap()) + 1;
    l[72..80].copy_from_slice(&calls.to_le_bytes());
    Ok(())
}
