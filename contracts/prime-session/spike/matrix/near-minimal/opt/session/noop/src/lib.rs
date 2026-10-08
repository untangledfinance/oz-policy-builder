// A program that accepts any instruction: a stand-in for "some other program" in a transaction (section F4 of psn.x.ts).
use pinocchio::{account_info::AccountInfo, entrypoint, pubkey::Pubkey, ProgramResult};
entrypoint!(process);
fn process(_: &Pubkey, _: &[AccountInfo], _: &[u8]) -> ProgramResult { Ok(()) }
