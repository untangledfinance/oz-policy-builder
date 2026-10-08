//! Host-side cross-check of pinocchio's zero-copy `Instructions` sysvar reader against the reference implementation
//! (`solana-instructions-sysvar` 2.2.2, the crate behind `solana_program::sysvar::instructions`), over generated instruction sets
//! and over the exact ed25519 precompile layout that prime-session reads (Solana docs: Precompiled Programs, Ed25519).
#[cfg(test)]
mod tests {
    use pinocchio::sysvars::instructions::{Instructions, INSTRUCTIONS_ID};
    use solana_account_info::AccountInfo;
    use solana_instruction::{BorrowedAccountMeta, BorrowedInstruction, AccountMeta, Instruction};
    use solana_instructions_sysvar::{construct_instructions_data, load_instruction_at_checked, store_current_index};
    use solana_pubkey::Pubkey;

    // a small deterministic generator: no external rng
    struct Lcg(u64);
    impl Lcg { fn next(&mut self) -> u64 { self.0 = self.0.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407); self.0 >> 33 }
        fn key(&mut self) -> Pubkey { let mut b = [0u8; 32]; for x in b.iter_mut() { *x = self.next() as u8 } Pubkey::new_from_array(b) } }

    fn sysvar_data(ixs: &[Instruction], current: u16) -> Vec<u8> {
        let borrowed: Vec<BorrowedInstruction> = ixs.iter().map(|i| BorrowedInstruction {
            program_id: &i.program_id, data: &i.data,
            accounts: i.accounts.iter().map(|a| BorrowedAccountMeta { pubkey: &a.pubkey, is_signer: a.is_signer, is_writable: a.is_writable }).collect() }).collect();
        let mut d = construct_instructions_data(&borrowed);
        d.extend_from_slice(&[0, 0]);
        let n = d.len();
        store_current_index(&mut d[..], current);
        assert_eq!(&d[n - 2..], &current.to_le_bytes());
        d
    }

    #[test]
    fn sysvar_id_matches() {
        assert_eq!(INSTRUCTIONS_ID, solana_sdk_ids::sysvar::instructions::id().to_bytes());
        assert_eq!(solana_sdk_ids::sysvar::instructions::id().to_string(), "Sysvar1nstructions1111111111111111111111111");
    }

    #[test]
    fn generated_sets_parse_the_same() {
        let mut r = Lcg(7);
        for round in 0..300 {
            let n = 1 + (r.next() % 6) as usize;
            let ixs: Vec<Instruction> = (0..n).map(|_| {
                let accounts = (0..(r.next() % 7)).map(|_| AccountMeta { pubkey: r.key(), is_signer: r.next() % 2 == 0, is_writable: r.next() % 2 == 0 }).collect();
                let len = match r.next() % 4 { 0 => 0, 1 => (r.next() % 8) as usize, 2 => (r.next() % 300) as usize, _ => (r.next() % 1200) as usize };
                Instruction { program_id: r.key(), accounts, data: (0..len).map(|_| r.next() as u8).collect() }
            }).collect();
            let cur = (r.next() % n as u64) as u16;
            let mut data = sysvar_data(&ixs, cur);
            let ours = unsafe { Instructions::new_unchecked(data.clone()) };
            assert_eq!(ours.num_instructions() as usize, n, "round {round}");
            assert_eq!(ours.load_current_index(), cur);
            let (key, owner, mut lam) = (solana_sdk_ids::sysvar::instructions::id(), solana_sdk_ids::sysvar::id(), 0u64);
            let info = AccountInfo::new(&key, false, false, &mut lam, &mut data, &owner, false, 0);
            for i in 0..n {
                let reference = load_instruction_at_checked(i, &info).unwrap();
                let got = ours.load_instruction_at(i).unwrap();
                assert_eq!(got.get_program_id().as_slice(), reference.program_id.as_ref(), "program id, round {round} ix {i}");
                assert_eq!(got.get_instruction_data(), &reference.data[..], "data, round {round} ix {i}");
                for (j, m) in reference.accounts.iter().enumerate() {
                    let g = got.get_account_meta_at(j).unwrap();
                    assert_eq!((g.key.as_slice(), g.is_signer(), g.is_writable()), (m.pubkey.as_ref(), m.is_signer, m.is_writable), "meta {j}, round {round} ix {i}");
                }
                assert!(got.get_account_meta_at(reference.accounts.len()).is_err(), "meta past the end must be refused");
            }
            // one past the last instruction: the reference answers InvalidArgument (index out of bounds), pinocchio InvalidInstructionData, the program maps it to InvalidArgument
            assert!(load_instruction_at_checked(n, &info).is_err());
            assert!(ours.load_instruction_at(n).is_err());
        }
    }

    /// The ed25519 precompile instruction exactly as `solana-ed25519-program` builds it (docs layout): [count u8, pad u8, 7 x u16 offsets..., pubkey 32, signature 64, message].
    fn ed25519_ix(pubkey: &[u8; 32], sig: &[u8; 64], msg: &[u8]) -> Vec<u8> {
        const START: u16 = 2 + 14; // header + one offsets struct
        let (pk_off, sig_off, msg_off) = (START, START + 32, START + 32 + 64);
        let mut d = vec![1u8, 0];
        for v in [sig_off, u16::MAX, pk_off, u16::MAX, msg_off, msg.len() as u16, u16::MAX] { d.extend_from_slice(&v.to_le_bytes()) }
        d.extend_from_slice(pubkey); d.extend_from_slice(sig); d.extend_from_slice(msg);
        d
    }

    /// The field reads prime-session performs (same expressions as src/lib.rs), applied to the precompile layout.
    fn signed(d: &[u8]) -> Option<(&[u8], &[u8])> {
        let u = |i: usize| d.get(i..i + 2).map(|b| u16::from_le_bytes([b[0], b[1]]) as usize);
        let own = d.first() == Some(&1) && [u(4), u(8), u(14)].iter().all(|&i| i == Some(0xffff));
        if !own { return None }
        (|| Some((d.get(u(6)?..u(6)? + 32)?, d.get(u(10)?..u(10)? + u(12)?)?)))()
    }

    #[test]
    fn ed25519_fields_are_where_the_docs_say() {
        let (pk, sig) = ([7u8; 32], [9u8; 64]);
        let msg = b"Prime session\nsigner: X\nsession key: Y\nvalid until (unix time): 1\ncluster: localnet";
        let d = ed25519_ix(&pk, &sig, msg);
        let (p, m) = signed(&d).expect("own-instruction offsets");
        assert_eq!((p, m), (&pk[..], &msg[..]));
        // an offset pointing at another instruction (index != 0xffff) is refused, as is a count other than 1
        for at in [4usize, 8, 14] { let mut e = d.clone(); e[at] = 0; e[at + 1] = 0; assert!(signed(&e).is_none(), "index at {at}"); }
        let mut e = d.clone(); e[0] = 2; assert!(signed(&e).is_none());
        // offsets that run past the instruction data give None, never a panic
        let mut e = d.clone(); e[10] = 0xff; e[11] = 0xff; assert!(signed(&e).is_none());
        assert!(signed(&d[..10]).is_none());
        // the same instruction inside a full sysvar image, read through pinocchio
        let ixs = vec![
            Instruction { program_id: Pubkey::new_unique(), accounts: vec![], data: vec![2, 1, 0, 0, 0] },
            Instruction { program_id: solana_sdk_ids::ed25519_program::id(), accounts: vec![], data: d.clone() },
            Instruction { program_id: Pubkey::new_unique(), accounts: vec![AccountMeta::new(Pubkey::new_unique(), true)], data: vec![1; 150] },
        ];
        let data = sysvar_data(&ixs, 2);
        let ours = unsafe { Instructions::new_unchecked(data) };
        let at1 = ours.load_instruction_at(1).unwrap();
        assert_eq!(at1.get_program_id().as_slice(), solana_sdk_ids::ed25519_program::id().as_ref());
        assert_eq!(signed(at1.get_instruction_data()), Some((&pk[..], &msg[..])));
        assert_ne!(ours.load_instruction_at(0).unwrap().get_program_id().as_slice(), solana_sdk_ids::ed25519_program::id().as_ref());
    }

    /// The grant text is built from five8 base58 and a decimal i64 where the old program used `Pubkey`'s Display and `format!`; the bytes must match for every key and time.
    #[test]
    fn grant_text_equals_the_format_the_old_program_used() {
        let mut r = Lcg(99);
        let mut keys: Vec<[u8; 32]> = vec![[0; 32], [255; 32], { let mut k = [0; 32]; k[31] = 1; k }, { let mut k = [0; 32]; k[0] = 1; k }, { let mut k = [0; 32]; k[..5].fill(0); k[5] = 9; k }];
        for _ in 0..20_000 { keys.push(r.key().to_bytes()) }
        for k in &keys {
            let mut out = [0u8; 44];
            let n = five8::encode_32(k, &mut out) as usize;
            assert_eq!(std::str::from_utf8(&out[..n]).unwrap(), Pubkey::new_from_array(*k).to_string());
        }
        for until in [0i64, 1, -1, 9, 10, 99, 100, 1_790_000_000, i64::MAX, i64::MIN, -86_400, 7 * 86_400] {
            assert_eq!(until.to_string(), format!("{}", until));
        }
    }
}
