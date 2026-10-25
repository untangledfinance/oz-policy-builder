//! Host tests for the custody gate. They call the program's real entrypoint on an input buffer laid out the way the runtime
//! serializes accounts, with stubbed syscalls: no validator, no Squads, no token program. Every inner call is checked with
//! the privileges the runtime would grant (a signer must sign in the transaction or be a PDA of the seeds given; a writable
//! account must be writable) and recorded. The three system program calls in `create` are carried out by the stub
//! (lamports, size, owner), so a gate made by `create` is the gate the other instructions read.
//!
//! Outside these tests: what the token program enforces once the gate's call reaches it (the cap as the delegated amount,
//! the owner on recovery, a second release), and what Squads enforces before a lane vault signs (the rule, the owners'
//! threshold). The devnet run of the same paths, 84 checks against the real programs, sits at the `archive/spike-final` tag
//! (see docs/solana.md).
//! Run: cargo test --locked
use solana_program::{
    account_info::AccountInfo,
    entrypoint::ProgramResult,
    instruction::Instruction,
    program_error::ProgramError as E,
    program_stubs::{set_syscall_stubs, SyscallStubs},
    pubkey,
    pubkey::Pubkey,
    rent::Rent,
};
use std::{cell::RefCell, sync::Once};

const PID: Pubkey = Pubkey::new_from_array([7; 32]);
const SQUADS: Pubkey = pubkey!("SMRTzfY6DfH5ik3TKiyLFfXexV8uSG3d2UksSCYdunG");
const TOKEN: Pubkey = pubkey!("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const TOKEN_22: Pubkey = pubkey!("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");
const SYSTEM: Pubkey = Pubkey::new_from_array([0; 32]);
const SA: &[u8] = b"smart_account";
const NOW: i64 = 1_800_000_000;
const DAY: i64 = 86_400;
const WINDOW: u32 = 60;
const MAX_INCREASE: usize = 10_240;

// The parties. Custody and its backup hold one slot each in the multisig, the trustee two; the threshold is 3.
const CUSTODY: Pubkey = Pubkey::new_from_array([1; 32]);
const BACKUP: Pubkey = Pubkey::new_from_array([2; 32]);
const TRUSTEE: Pubkey = Pubkey::new_from_array([3; 32]);
const AGENT: Pubkey = Pubkey::new_from_array([4; 32]);
const STRANGER: Pubkey = Pubkey::new_from_array([9; 32]);
const NEW_KEY: Pubkey = Pubkey::new_from_array([10; 32]);
const SETTINGS: Pubkey = Pubkey::new_from_array([20; 32]);
const MS: Pubkey = Pubkey::new_from_array([30; 32]);
const OTHER_MS: Pubkey = Pubkey::new_from_array([31; 32]);
const VENUE: Pubkey = Pubkey::new_from_array([40; 32]);
const VENUE_ATA: Pubkey = Pubkey::new_from_array([41; 32]);
const TRUSTEE_ATA: Pubkey = Pubkey::new_from_array([42; 32]);
const STRANGER_ATA: Pubkey = Pubkey::new_from_array([43; 32]);
const MINT: Pubkey = Pubkey::new_from_array([50; 32]);
const X: Pubkey = Pubkey::new_from_array([60; 32]);
const FAKE_PROGRAM: Pubkey = Pubkey::new_from_array([66; 32]);
const SEED: [u8; 8] = [5; 8];
const AGENT_LANE: u8 = 1;
const OWNERS_LANE: u8 = 3;

// ── the runtime stand-in ──────────────────────────────────────────────────────────────────────────

#[derive(Clone, Debug, PartialEq)]
struct Cpi {
    program: Pubkey,
    metas: Vec<(Pubkey, bool, bool)>,
    data: Vec<u8>,
    seeds: Vec<Vec<Vec<u8>>>,
}

thread_local! {
    static CLOCK: RefCell<i64> = const { RefCell::new(NOW) };
    static CALLS: RefCell<Vec<Cpi>> = const { RefCell::new(Vec::new()) };
}

struct Stubs;
impl SyscallStubs for Stubs {
    fn sol_get_clock_sysvar(&self, out: *mut u8) -> u64 {
        // Clock: slot, epoch_start_timestamp, epoch, leader_schedule_epoch, unix_timestamp
        let mut b = [0u8; 40];
        b[32..].copy_from_slice(&CLOCK.with(|c| *c.borrow()).to_le_bytes());
        unsafe { std::ptr::copy_nonoverlapping(b.as_ptr(), out, 40) };
        0
    }
    fn sol_get_rent_sysvar(&self, out: *mut u8) -> u64 {
        unsafe { *(out as *mut Rent) = Rent::default() };
        0
    }
    fn sol_invoke_signed(
        &self,
        ix: &Instruction,
        infos: &[AccountInfo],
        seeds: &[&[&[u8]]],
    ) -> ProgramResult {
        let pdas: Vec<Pubkey> = seeds
            .iter()
            .filter_map(|s| Pubkey::create_program_address(s, &PID).ok())
            .collect();
        if !infos.iter().any(|i| *i.key == ix.program_id) {
            return Err(E::NotEnoughAccountKeys);
        }
        for m in &ix.accounts {
            let info = infos
                .iter()
                .find(|i| *i.key == m.pubkey)
                .ok_or(E::NotEnoughAccountKeys)?;
            if m.is_signer && !info.is_signer && !pdas.contains(&m.pubkey) {
                return Err(E::MissingRequiredSignature);
            }
            if m.is_writable && !info.is_writable {
                return Err(E::InvalidArgument);
            }
        }
        if ix.program_id == SYSTEM {
            system(ix, infos)?;
        }
        CALLS.with(|c| {
            c.borrow_mut().push(Cpi {
                program: ix.program_id,
                metas: ix
                    .accounts
                    .iter()
                    .map(|m| (m.pubkey, m.is_signer, m.is_writable))
                    .collect(),
                data: ix.data.clone(),
                seeds: seeds
                    .iter()
                    .map(|s| s.iter().map(|p| p.to_vec()).collect())
                    .collect(),
            })
        });
        Ok(())
    }
}

/// The three system program instructions `create` uses, with the system program's own refusals: Transfer (2), Allocate (8)
/// and Assign (1). Allocate takes only an account the system program owns that holds no data, Assign one whose data is zero.
fn system(ix: &Instruction, infos: &[AccountInfo]) -> ProgramResult {
    let info = |k: &Pubkey| infos.iter().find(|i| i.key == k).unwrap();
    let tag = u32::from_le_bytes(ix.data[..4].try_into().unwrap());
    let arg = &ix.data[4..];
    let first = info(&ix.accounts[0].pubkey);
    let fresh = *first.owner == SYSTEM && first.data_is_empty();
    // the runtime lets the system program hand an account to another owner only while its data is all zero
    let zeroed = *first.owner == SYSTEM && first.data.borrow().iter().all(|&b| b == 0);
    match tag {
        2 => {
            let amount = u64::from_le_bytes(arg.try_into().unwrap());
            let to = info(&ix.accounts[1].pubkey);
            if !fresh {
                return Err(E::InvalidArgument);
            }
            if first.lamports() < amount {
                return Err(E::Custom(1)); // SystemError::ResultWithNegativeLamports
            }
            **first.try_borrow_mut_lamports()? -= amount;
            **to.try_borrow_mut_lamports()? += amount;
        }
        8 if fresh => first.resize(u64::from_le_bytes(arg.try_into().unwrap()) as usize)?,
        1 if zeroed => first.assign(&Pubkey::try_from(arg).unwrap()),
        8 | 1 => return Err(E::Custom(0)), // SystemError::AccountAlreadyInUse
        _ => return Err(E::InvalidInstructionData),
    }
    Ok(())
}

fn stubs() {
    static ONCE: Once = Once::new();
    ONCE.call_once(|| {
        set_syscall_stubs(Box::new(Stubs));
    });
}

#[derive(Clone, Debug)]
struct Acc {
    key: Pubkey,
    signer: bool,
    writable: bool,
    executable: bool,
    lamports: u64,
    data: Vec<u8>,
    owner: Pubkey,
}

struct Out {
    result: ProgramResult,
    calls: Vec<Cpi>,
    /// The accounts as the program left them, in the order passed.
    accs: Vec<Acc>,
}

impl Out {
    fn ok(self) -> Vec<Cpi> {
        assert_eq!(self.result, Ok(()));
        self.calls
    }
    fn refused(self, want: E) {
        assert_eq!(self.result, Err(want));
        assert!(
            self.calls.is_empty(),
            "a refused call must make no inner call"
        );
    }
}

/// Lays the accounts and data out as the runtime serializes them for a program (repeated keys become duplicate markers), calls
/// the program's entrypoint and reads the accounts back.
fn run(accs: &[Acc], data: &[u8], now: i64) -> Out {
    stubs();
    CLOCK.with(|c| *c.borrow_mut() = now);
    CALLS.with(|c| c.borrow_mut().clear());
    let mut b = (accs.len() as u64).to_le_bytes().to_vec();
    // for each account: the index of its first occurrence, and where its owner, lamports, length and data sit
    let mut at: Vec<(usize, [usize; 4])> = vec![];
    for (i, a) in accs.iter().enumerate() {
        if let Some(j) = accs[..i].iter().position(|x| x.key == a.key) {
            b.push(j as u8);
            b.extend([0u8; 7]);
            at.push((j, at[j].1));
            continue;
        }
        b.extend([0xff, a.signer as u8, a.writable as u8, a.executable as u8]);
        b.extend([0u8; 4]);
        b.extend(a.key.as_ref());
        let owner = b.len();
        b.extend(a.owner.as_ref());
        let lamports = b.len();
        b.extend(a.lamports.to_le_bytes());
        let len = b.len();
        b.extend((a.data.len() as u64).to_le_bytes());
        let d = b.len();
        b.extend(&a.data);
        b.extend(vec![0u8; MAX_INCREASE]);
        b.resize(b.len().next_multiple_of(8), 0);
        b.extend(0u64.to_le_bytes()); // rent epoch
        at.push((i, [owner, lamports, len, d]));
    }
    b.extend((data.len() as u64).to_le_bytes());
    b.extend(data);
    b.extend(PID.as_ref());
    // an 8-byte aligned buffer, as the runtime gives
    let mut mem = vec![0u64; b.len().div_ceil(8)];
    let p = mem.as_mut_ptr() as *mut u8;
    unsafe { std::ptr::copy_nonoverlapping(b.as_ptr(), p, b.len()) };
    let r = unsafe { gate::entrypoint(p) };
    let m = unsafe { std::slice::from_raw_parts(p, b.len()) };
    let u64_at = |o: usize| u64::from_le_bytes(m[o..o + 8].try_into().unwrap());
    let back = accs
        .iter()
        .zip(&at)
        .map(|(a, &(_, [owner, lamports, len, d]))| Acc {
            owner: Pubkey::try_from(&m[owner..owner + 32]).unwrap(),
            lamports: u64_at(lamports),
            data: m[d..d + u64_at(len) as usize].to_vec(),
            ..a.clone()
        })
        .collect();
    Out {
        result: if r == 0 { Ok(()) } else { Err(E::from(r)) },
        calls: CALLS.with(|c| c.borrow().clone()),
        accs: back,
    }
}

// ── accounts ──────────────────────────────────────────────────────────────────────────────────────

fn acc(key: Pubkey, signer: bool, writable: bool) -> Acc {
    Acc {
        key,
        signer,
        writable,
        executable: false,
        lamports: 0,
        data: vec![],
        owner: SYSTEM,
    }
}
fn wallet(key: Pubkey) -> Acc {
    Acc {
        lamports: 10_000_000_000,
        ..acc(key, true, true)
    }
}
fn signer(key: Pubkey) -> Acc {
    acc(key, true, false)
}
fn program(key: Pubkey) -> Acc {
    Acc {
        executable: true,
        ..acc(key, false, false)
    }
}
/// An SPL Token multisig: m, n, initialized, then 11 signer slots (unused slots hold the zero key).
fn multisig(key: Pubkey, owner: Pubkey, m: u8, slots: &[Pubkey]) -> Acc {
    let mut data = vec![m, slots.len() as u8, 1];
    data.extend(slots.iter().flat_map(|s| s.to_bytes()));
    data.resize(355, 0);
    Acc {
        data,
        owner,
        lamports: 1,
        ..acc(key, false, false)
    }
}
/// Custody's identity: custody, its backup and the trustee twice (weight 2), threshold 3.
fn custody_ms() -> Acc {
    multisig(MS, TOKEN, 3, &[CUSTODY, BACKUP, TRUSTEE, TRUSTEE])
}
/// A Squads settings account; bytes 24..56 hold the settings authority (zero for an autonomous account).
fn settings(owner: Pubkey, authority: Pubkey) -> Acc {
    let mut data = vec![0u8; 128];
    data[24..56].copy_from_slice(authority.as_ref());
    Acc {
        data,
        owner,
        lamports: 1,
        ..acc(SETTINGS, false, false)
    }
}
/// An SPL token account: mint, owner, amount, delegate, state, is_native, delegated amount, close authority.
fn token(key: Pubkey, owner: Pubkey, delegated: u64, close: Option<Pubkey>) -> Acc {
    let mut d = vec![0u8; 165];
    d[..32].copy_from_slice(MINT.as_ref());
    d[32..64].copy_from_slice(owner.as_ref());
    d[64..72].copy_from_slice(&1_000u64.to_le_bytes());
    d[108] = 1;
    d[121..129].copy_from_slice(&delegated.to_le_bytes());
    if let Some(c) = close {
        d[129] = 1;
        d[133..165].copy_from_slice(c.as_ref());
    }
    Acc {
        data: d,
        owner: TOKEN,
        lamports: 1,
        ..acc(key, false, true)
    }
}

fn vault(i: u8) -> Pubkey {
    Pubkey::find_program_address(&[SA, SETTINGS.as_ref(), SA, &[i]], &SQUADS).0
}
fn gate_of(ms: &Pubkey, seed: &[u8; 8]) -> (Pubkey, u8) {
    Pubkey::find_program_address(&[b"gate", ms.as_ref(), SETTINGS.as_ref(), seed], &PID)
}
fn cap_of(gate: &Pubkey) -> (Pubkey, u8) {
    Pubkey::find_program_address(&[b"cap", gate.as_ref()], &PID)
}

// ── instructions ──────────────────────────────────────────────────────────────────────────────────

/// A create instruction by custody for custody's multisig, recovery to the trustee, one listed destination (the venue).
#[derive(Clone)]
struct Create {
    member: Acc,
    gate: Pubkey,
    settings: Acc,
    ms: Acc,
    recovery: Pubkey,
    until: i64,
    window: u32,
    seed: [u8; 8],
    lanes: [u8; 2],
    dests: Vec<Pubkey>,
    data_cut: Option<usize>,
}

impl Create {
    fn new() -> Self {
        Create {
            member: wallet(CUSTODY),
            gate: gate_of(&MS, &SEED).0,
            settings: settings(SQUADS, SYSTEM),
            ms: custody_ms(),
            recovery: TRUSTEE,
            until: NOW + DAY,
            window: WINDOW,
            seed: SEED,
            lanes: [AGENT_LANE, OWNERS_LANE],
            dests: vec![VENUE],
            data_cut: None,
        }
    }
    fn data(&self) -> Vec<u8> {
        let mut d = vec![0u8];
        d.extend(self.recovery.as_ref());
        d.extend(self.until.to_le_bytes());
        d.extend(self.window.to_le_bytes());
        d.extend(self.seed);
        d.extend(self.lanes);
        d.extend(self.dests.iter().flat_map(|k| k.to_bytes()));
        if let Some(n) = self.data_cut {
            d.truncate(n);
        }
        d
    }
    fn accounts(&self) -> Vec<Acc> {
        vec![
            self.member.clone(),
            acc(self.gate, false, true),
            self.settings.clone(),
            program(SYSTEM),
            self.ms.clone(),
        ]
    }
    fn run(&self) -> Out {
        run(&self.accounts(), &self.data(), NOW)
    }
}

/// A gate made by `create` with the defaults of `Create::new`.
struct Gate {
    acc: Acc,
    bump: u8,
    cap: Pubkey,
    cap_bump: u8,
}

impl Gate {
    fn new() -> Self {
        let out = Create::new().run();
        assert_eq!(out.result, Ok(()));
        let acc = Acc {
            writable: false,
            ..out.accs[1].clone()
        };
        let (key, bump) = gate_of(&MS, &SEED);
        assert_eq!(acc.key, key);
        let (cap, cap_bump) = cap_of(&key);
        Gate {
            acc,
            bump,
            cap,
            cap_bump,
        }
    }
    fn key(&self) -> Pubkey {
        self.acc.key
    }
    fn seeds(&self) -> Vec<Vec<Vec<u8>>> {
        vec![vec![
            b"gate".to_vec(),
            MS.to_bytes().to_vec(),
            SETTINGS.to_bytes().to_vec(),
            SEED.to_vec(),
            vec![self.bump],
        ]]
    }
    fn cap_seeds(&self) -> Vec<Vec<Vec<u8>>> {
        vec![vec![
            b"cap".to_vec(),
            self.key().to_bytes().to_vec(),
            vec![self.cap_bump],
        ]]
    }
    /// The account custody handed over: owner and close authority are the gate.
    fn source(&self, delegated: u64) -> Acc {
        token(X, self.key(), delegated, Some(self.key()))
    }

    /// The agent lane pays 10 to the venue's token account, the batch's last second one window ahead.
    fn agent_move(&self) -> Move {
        Move {
            gate: self.acc.clone(),
            lane: signer(vault(AGENT_LANE)),
            src: self.source(100),
            dst: token(VENUE_ATA, VENUE, 0, None),
            tok: TOKEN,
            cap: self.cap,
            amount: 10,
            not_after: NOW + WINDOW as i64,
            now: NOW,
        }
    }
    /// The owners lane pays 300 to the recovery address (the trustee's token account).
    fn recovery_move(&self) -> Move {
        Move {
            lane: signer(vault(OWNERS_LANE)),
            dst: token(TRUSTEE_ATA, TRUSTEE, 0, None),
            amount: 300,
            ..self.agent_move()
        }
    }
    /// Sets the cap to `amount` on a source with `delegated` left, signed by `who`.
    fn allow(&self, delegated: u64, amount: u64, who: &[Pubkey]) -> Allow {
        Allow {
            gate: self.acc.clone(),
            src: self.source(delegated),
            tok: TOKEN,
            ms: custody_ms(),
            cap: self.cap,
            amount,
            signers: who.iter().map(|k| signer(*k)).collect(),
        }
    }
    /// Hands X back to NEW_KEY, signed by `who`.
    fn release(&self, who: &[Pubkey]) -> Release {
        Release {
            gate: self.acc.clone(),
            src: self.source(100),
            tok: TOKEN,
            ms: custody_ms(),
            to: NEW_KEY,
            signers: who.iter().map(|k| signer(*k)).collect(),
        }
    }
}

#[derive(Clone)]
struct Move {
    gate: Acc,
    lane: Acc,
    src: Acc,
    dst: Acc,
    tok: Pubkey,
    cap: Pubkey,
    amount: u64,
    not_after: i64,
    now: i64,
}

impl Move {
    fn run(&self) -> Out {
        let mut d = vec![1u8];
        d.extend(self.amount.to_le_bytes());
        d.extend(self.not_after.to_le_bytes());
        let accs = [
            self.gate.clone(),
            self.lane.clone(),
            self.src.clone(),
            self.dst.clone(),
            program(self.tok),
            acc(self.cap, false, false),
        ];
        run(&accs, &d, self.now)
    }
}

#[derive(Clone)]
struct Allow {
    gate: Acc,
    src: Acc,
    tok: Pubkey,
    ms: Acc,
    cap: Pubkey,
    amount: u64,
    signers: Vec<Acc>,
}

impl Allow {
    fn run(&self) -> Out {
        let mut d = vec![2u8];
        d.extend(self.amount.to_le_bytes());
        let mut accs = vec![
            self.gate.clone(),
            self.src.clone(),
            program(self.tok),
            self.ms.clone(),
            acc(self.cap, false, false),
        ];
        accs.extend(self.signers.iter().cloned());
        run(&accs, &d, NOW)
    }
}

#[derive(Clone)]
struct Release {
    gate: Acc,
    src: Acc,
    tok: Pubkey,
    ms: Acc,
    to: Pubkey,
    signers: Vec<Acc>,
}

impl Release {
    fn run(&self) -> Out {
        let mut d = vec![3u8];
        d.extend(self.to.as_ref());
        let mut accs = vec![
            self.gate.clone(),
            self.src.clone(),
            program(self.tok),
            self.ms.clone(),
        ];
        accs.extend(self.signers.iter().cloned());
        run(&accs, &d, NOW)
    }
}

fn token_transfer(amount: u64) -> Vec<u8> {
    [&[3u8][..], &amount.to_le_bytes()].concat()
}

// ── create ────────────────────────────────────────────────────────────────────────────────────────

#[test]
fn custody_creates_the_gate_and_the_account_reads_back_as_planned() {
    let c = Create::new();
    let out = c.run();
    let gate = out.accs[1].clone();
    let calls = out.ok();
    let (key, bump) = gate_of(&MS, &SEED);
    let mut want = [MS, SETTINGS, vault(AGENT_LANE), vault(OWNERS_LANE), TRUSTEE]
        .iter()
        .flat_map(|k| k.to_bytes())
        .collect::<Vec<u8>>();
    want.extend((NOW + DAY).to_le_bytes());
    want.extend(WINDOW.to_le_bytes());
    want.extend(SEED);
    want.push(bump);
    want.extend(VENUE.as_ref());
    assert_eq!(want.len(), 213);
    assert_eq!(gate.data, want);
    assert_eq!(gate.owner, PID);
    let rent = Rent::default().minimum_balance(213);
    assert_eq!(gate.lamports, rent);
    // custody pays the rent, then the gate allocates and assigns itself, signing as the PDA of its seeds
    let seeds = vec![vec![
        b"gate".to_vec(),
        MS.to_bytes().to_vec(),
        SETTINGS.to_bytes().to_vec(),
        SEED.to_vec(),
        vec![bump],
    ]];
    let tags: Vec<u8> = calls.iter().map(|c| c.data[0]).collect();
    assert_eq!(tags, vec![2, 8, 1]);
    assert!(calls
        .iter()
        .all(|c| c.program == SYSTEM && c.seeds == seeds));
    assert_eq!(
        calls[0].metas,
        vec![(CUSTODY, true, true), (key, true, true)]
    );
    assert_eq!(calls[0].data[4..], rent.to_le_bytes());
    assert_eq!(calls[1].data[4..], 213u64.to_le_bytes());
    assert_eq!(calls[2].data[4..], PID.to_bytes());
}

#[test]
fn any_one_signer_of_the_multisig_creates_a_gate() {
    for who in [BACKUP, TRUSTEE] {
        let mut c = Create::new();
        c.member = wallet(who);
        c.run().ok();
    }
}

#[test]
fn a_gate_lists_as_many_destinations_as_custody_names() {
    let mut c = Create::new();
    c.dests = vec![VENUE, pk(44), pk(45)];
    let out = c.run();
    assert_eq!(out.accs[1].data.len(), 181 + 3 * 32);
    assert_eq!(
        out.accs[1].data[181..],
        c.dests
            .iter()
            .flat_map(|k| k.to_bytes())
            .collect::<Vec<_>>()[..]
    );
    out.ok();
}

#[test]
fn a_stranger_cannot_create_a_gate_in_the_name_of_custodys_multisig() {
    let mut c = Create::new();
    c.member = wallet(STRANGER);
    c.run().refused(E::Custom(5));
}

#[test]
fn a_signer_of_the_multisig_who_does_not_sign_counts_for_nothing() {
    let mut c = Create::new();
    c.member.signer = false;
    c.run().refused(E::Custom(5));
}

#[test]
fn a_wallet_named_as_the_multisig_is_refused() {
    let mut c = Create::new();
    c.ms = Acc {
        lamports: 1,
        ..acc(CUSTODY, false, false)
    };
    c.gate = gate_of(&CUSTODY, &SEED).0;
    c.run().refused(E::Custom(5));
}

// A token account is owned by the token program and, read as a multisig, has m = 0 and a key in a signer slot (bytes 131..163
// is slot 4). The gate takes only a 355-byte account as custody's identity.
#[test]
fn a_token_account_named_as_the_multisig_is_refused() {
    let mut t = token(STRANGER_ATA, STRANGER, 0, None);
    t.data[0] = 0;
    t.data[131..163].copy_from_slice(STRANGER.as_ref());
    t.writable = false;
    let mut c = Create::new();
    c.member = wallet(STRANGER);
    c.gate = gate_of(&STRANGER_ATA, &SEED).0;
    c.ms = t;
    c.run().refused(E::Custom(5));
}

#[test]
fn a_forged_multisig_that_the_token_program_does_not_own_is_refused() {
    let mut c = Create::new();
    c.member = wallet(STRANGER);
    c.ms = multisig(OTHER_MS, FAKE_PROGRAM, 1, &[STRANGER]);
    c.gate = gate_of(&OTHER_MS, &SEED).0;
    c.run().refused(E::Custom(5));
    // the same bytes custody's multisig holds, under another owner, fare no better
    let mut c = Create::new();
    c.ms.owner = FAKE_PROGRAM;
    c.run().refused(E::Custom(5));
}

#[test]
fn a_multisig_whose_threshold_exceeds_its_signers_is_refused() {
    let mut c = Create::new();
    c.ms.data[0] = 5;
    c.run().refused(E::Custom(5));
}

#[test]
fn a_token_2022_multisig_is_accepted() {
    let mut c = Create::new();
    c.ms.owner = TOKEN_22;
    c.run().ok();
}

#[test]
fn the_account_must_be_an_autonomous_squads_account() {
    // not owned by Squads
    let mut c = Create::new();
    c.settings.owner = FAKE_PROGRAM;
    c.run().refused(E::Custom(5));
    // a settings authority could add itself as an owner
    let mut c = Create::new();
    c.settings = settings(SQUADS, STRANGER);
    c.run().refused(E::Custom(5));
    // too short to hold the field
    let mut c = Create::new();
    c.settings.data.truncate(55);
    c.run().refused(E::Custom(5));
}

#[test]
fn lane_0_equal_lanes_and_malformed_data_are_refused() {
    for lanes in [[0u8, 3], [1, 0], [2, 2]] {
        let mut c = Create::new();
        c.lanes = lanes;
        c.run().refused(E::InvalidInstructionData);
    }
    for cut in [1, 20, 54, 56, 70, 86] {
        let mut c = Create::new();
        c.data_cut = Some(cut);
        c.run().refused(E::InvalidInstructionData);
    }
    run(&Create::new().accounts(), &[9], NOW).refused(E::InvalidInstructionData);
    run(&Create::new().accounts(), &[], NOW).refused(E::InvalidInstructionData);
}

#[test]
fn a_gate_address_that_is_not_the_pda_of_its_seeds_is_not_signed_for() {
    // another seed's address, and the address of these seeds under another multisig
    for gate in [gate_of(&MS, &[6; 8]).0, gate_of(&OTHER_MS, &SEED).0, pk(70)] {
        let mut c = Create::new();
        c.gate = gate;
        c.run().refused(E::MissingRequiredSignature);
    }
}

#[test]
fn the_same_gate_cannot_be_created_twice() {
    let g = Gate::new();
    let mut accs = Create::new().accounts();
    accs[1] = Acc {
        writable: true,
        ..g.acc.clone()
    };
    let out = run(&accs, &Create::new().data(), NOW);
    assert_eq!(out.result, Err(E::Custom(0)));
}

// Transfer, Allocate and Assign rather than CreateAccount: lamports sent to the address first do not block the gate.
#[test]
fn a_donation_to_the_gate_address_does_not_block_creation() {
    let c = Create::new();
    let mut accs = c.accounts();
    accs[1].lamports = 5;
    let out = run(&accs, &c.data(), NOW);
    assert_eq!(
        out.accs[1].lamports,
        Rent::default().minimum_balance(213) + 5
    );
    assert_eq!(out.accs[1].owner, PID);
    out.ok();
}

#[test]
fn missing_accounts_are_refused() {
    let c = Create::new();
    run(&c.accounts()[..4], &c.data(), NOW).refused(E::NotEnoughAccountKeys);
}

// ── transfer: the agent lane ──────────────────────────────────────────────────────────────────────

#[test]
fn the_agent_lane_pays_a_listed_destination_through_the_cap_pda() {
    let g = Gate::new();
    let calls = g.agent_move().run().ok();
    assert_eq!(
        calls,
        vec![Cpi {
            program: TOKEN,
            metas: vec![
                (X, false, true),
                (VENUE_ATA, false, true),
                (g.cap, true, false)
            ],
            data: token_transfer(10),
            seeds: g.cap_seeds(),
        }]
    );
}

#[test]
fn the_agent_lane_pays_through_token_2022_too() {
    let g = Gate::new();
    let mut m = g.agent_move();
    m.tok = TOKEN_22;
    assert_eq!(m.run().ok()[0].program, TOKEN_22);
}

#[test]
fn the_agent_lane_cannot_pay_an_unlisted_destination() {
    let g = Gate::new();
    let mut m = g.agent_move();
    m.dst = token(STRANGER_ATA, STRANGER, 0, None);
    m.run().refused(E::Custom(2));
}

#[test]
fn the_agent_lane_cannot_pay_the_recovery_address() {
    let g = Gate::new();
    let mut m = g.agent_move();
    m.dst = token(TRUSTEE_ATA, TRUSTEE, 0, None);
    m.run().refused(E::Custom(2));
}

// The list holds the owner of the destination account, so a second account of a listed owner is paid; an account the
// venue does not own is not, whatever its address.
#[test]
fn the_destination_is_matched_by_its_owner() {
    let g = Gate::new();
    let mut m = g.agent_move();
    m.dst = token(pk(46), VENUE, 0, None);
    m.run().ok();
    let mut m = g.agent_move();
    m.dst = token(VENUE, STRANGER, 0, None);
    m.run().refused(E::Custom(2));
    let mut m = g.agent_move();
    m.dst.data.truncate(63);
    m.run().refused(E::Custom(5));
}

#[test]
fn the_agent_lane_stops_at_the_end_time() {
    let g = Gate::new();
    let until = NOW + DAY;
    let mut m = g.agent_move();
    (m.now, m.not_after) = (until, until);
    m.run().ok();
    (m.now, m.not_after) = (until + 1, until + 1);
    m.run().refused(E::Custom(2));
}

#[test]
fn a_batch_runs_only_inside_its_window() {
    let g = Gate::new();
    let w = WINDOW as i64;
    for not_after in [NOW, NOW + 1, NOW + w] {
        let mut m = g.agent_move();
        m.not_after = not_after;
        m.run().ok();
    }
    for not_after in [NOW - 1, NOW - 5, NOW + w + 1, i64::MAX, i64::MIN, -1] {
        let mut m = g.agent_move();
        m.not_after = not_after;
        m.run().refused(E::Custom(4));
    }
}

#[test]
fn only_the_two_lane_vaults_can_move_and_each_party_alone_is_refused() {
    let g = Gate::new();
    // the agent's own key, custody, the trustee, a stranger, the account itself, and Squads vaults that are no lane
    for who in [
        AGENT,
        CUSTODY,
        TRUSTEE,
        STRANGER,
        SETTINGS,
        MS,
        vault(0),
        vault(2),
    ] {
        let mut m = g.agent_move();
        m.lane = signer(who);
        m.run().refused(E::Custom(1));
    }
    // a lane vault of another account
    let other = Pubkey::find_program_address(&[SA, pk(21).as_ref(), SA, &[AGENT_LANE]], &SQUADS).0;
    let mut m = g.agent_move();
    m.lane = signer(other);
    m.run().refused(E::Custom(1));
    // the lane vault named but not signing
    for lane in [AGENT_LANE, OWNERS_LANE] {
        let mut m = g.agent_move();
        m.lane = acc(vault(lane), false, false);
        m.run().refused(E::Custom(1));
    }
}

#[test]
fn the_agent_lane_moves_only_from_an_account_the_gate_owns() {
    let g = Gate::new();
    // custody still owns it (not handed over), or a stranger does
    for owner in [CUSTODY, STRANGER, g.cap] {
        let mut m = g.agent_move();
        m.src = token(X, owner, 100, Some(g.key()));
        m.run().refused(E::Custom(5));
    }
}

#[test]
fn a_cap_pda_that_is_not_this_gates_is_not_signed_for() {
    let g = Gate::new();
    for cap in [
        cap_of(&Pubkey::default()).0,
        cap_of(&pk(70)).0,
        g.key(),
        pk(71),
    ] {
        let mut m = g.agent_move();
        m.cap = cap;
        m.run().refused(E::MissingRequiredSignature);
    }
}

#[test]
fn a_token_program_that_is_not_token_or_token_2022_is_refused() {
    let g = Gate::new();
    for mv in [g.agent_move(), g.recovery_move()] {
        let mut m = mv;
        m.tok = FAKE_PROGRAM;
        m.run().refused(E::Custom(5));
    }
}

#[test]
fn a_gate_account_the_program_does_not_own_is_refused() {
    let g = Gate::new();
    let mut m = g.agent_move();
    m.gate.owner = FAKE_PROGRAM;
    m.run().refused(E::Custom(5));
    // the same bytes at the right address but owned by the system program (never created)
    let mut m = g.agent_move();
    m.gate.owner = SYSTEM;
    m.run().refused(E::Custom(5));
}

#[test]
fn malformed_transfer_data_and_missing_accounts_are_refused() {
    let g = Gate::new();
    let m = g.agent_move();
    let accs = [
        m.gate.clone(),
        m.lane.clone(),
        m.src.clone(),
        m.dst.clone(),
        program(TOKEN),
        acc(m.cap, false, false),
    ];
    for d in [vec![1u8], vec![1; 16], vec![1; 18], vec![4; 17]] {
        run(&accs, &d, NOW).refused(E::InvalidInstructionData);
    }
    let mut d = vec![1u8];
    d.extend(10u64.to_le_bytes());
    d.extend(NOW.to_le_bytes());
    run(&accs[..5], &d, NOW).refused(E::NotEnoughAccountKeys);
}

// ── transfer: the owners lane (recovery) ──────────────────────────────────────────────────────────

#[test]
fn the_owners_lane_pays_the_recovery_address_with_the_gate_as_owner() {
    let g = Gate::new();
    let calls = g.recovery_move().run().ok();
    // the gate signs as the account's owner, not through the cap PDA, so the cap does not bound recovery
    assert_eq!(
        calls,
        vec![Cpi {
            program: TOKEN,
            metas: vec![
                (X, false, true),
                (TRUSTEE_ATA, false, true),
                (g.key(), true, false)
            ],
            data: token_transfer(300),
            seeds: g.seeds(),
        }]
    );
}

#[test]
fn recovery_runs_after_the_end_time_and_with_no_cap() {
    let g = Gate::new();
    let mut m = g.recovery_move();
    (m.now, m.not_after) = (NOW + 10 * DAY, NOW + 10 * DAY);
    m.src = g.source(0);
    m.amount = u64::MAX;
    m.run().ok();
}

#[test]
fn the_owners_lane_pays_nothing_but_the_recovery_address() {
    let g = Gate::new();
    for dst in [
        token(VENUE_ATA, VENUE, 0, None),
        token(STRANGER_ATA, STRANGER, 0, None),
    ] {
        let mut m = g.recovery_move();
        m.dst = dst;
        m.run().refused(E::Custom(2));
    }
}

#[test]
fn the_owners_lane_is_held_to_the_run_window_too() {
    let g = Gate::new();
    for not_after in [NOW - 5, NOW + WINDOW as i64 + 1] {
        let mut m = g.recovery_move();
        m.not_after = not_after;
        m.run().refused(E::Custom(4));
    }
}

// ── allow: the cap ────────────────────────────────────────────────────────────────────────────────

#[test]
fn the_first_cap_is_a_raise_and_needs_the_threshold() {
    let g = Gate::new();
    // custody alone (1 of 3), custody and the backup (2), the trustee alone (2), a stranger, the lanes: refused
    for who in [
        &[CUSTODY][..],
        &[CUSTODY, BACKUP],
        &[TRUSTEE],
        &[BACKUP],
        &[STRANGER],
        &[vault(AGENT_LANE)],
        &[vault(OWNERS_LANE)],
        &[],
    ] {
        g.allow(0, 100, who).run().refused(E::Custom(1));
    }
    for who in [
        &[CUSTODY, TRUSTEE][..],
        &[BACKUP, TRUSTEE],
        &[CUSTODY, BACKUP, TRUSTEE],
    ] {
        let calls = g.allow(0, 100, who).run().ok();
        assert_eq!(
            calls,
            vec![Cpi {
                program: TOKEN,
                metas: vec![
                    (X, false, true),
                    (g.cap, false, false),
                    (g.key(), true, false)
                ],
                data: [&[4u8][..], &100u64.to_le_bytes()].concat(),
                seeds: g.seeds(),
            }]
        );
    }
}

#[test]
fn one_signer_lowers_suspends_or_keeps_the_cap() {
    let g = Gate::new();
    g.allow(100, 5, &[CUSTODY]).run().ok();
    g.allow(100, 0, &[TRUSTEE]).run().ok();
    g.allow(100, 100, &[BACKUP]).run().ok();
    g.allow(100, 5, &[STRANGER]).run().refused(E::Custom(1));
    g.allow(100, 5, &[vault(AGENT_LANE)])
        .run()
        .refused(E::Custom(1));
}

#[test]
fn raising_a_lowered_cap_needs_the_threshold_again() {
    let g = Gate::new();
    g.allow(5, 50, &[CUSTODY]).run().refused(E::Custom(1));
    g.allow(5, 50, &[TRUSTEE]).run().refused(E::Custom(1));
    g.allow(5, 6, &[CUSTODY, BACKUP])
        .run()
        .refused(E::Custom(1));
    g.allow(5, 50, &[CUSTODY, TRUSTEE]).run().ok();
}

// The weight is the number of slots the signers fill: a key passed three times is still one slot.
#[test]
fn a_signer_passed_more_than_once_counts_once() {
    let g = Gate::new();
    g.allow(0, 100, &[CUSTODY, CUSTODY, CUSTODY])
        .run()
        .refused(E::Custom(1));
    g.allow(0, 100, &[CUSTODY, BACKUP, BACKUP])
        .run()
        .refused(E::Custom(1));
}

#[test]
fn a_multisig_signer_that_does_not_sign_counts_for_nothing() {
    let g = Gate::new();
    let mut a = g.allow(0, 100, &[CUSTODY]);
    a.signers.push(acc(TRUSTEE, false, false));
    a.run().refused(E::Custom(1));
    let mut a = g.allow(100, 5, &[]);
    a.signers.push(acc(CUSTODY, false, false));
    a.run().refused(E::Custom(1));
}

#[test]
fn only_the_gates_own_multisig_sets_the_cap() {
    let g = Gate::new();
    let mut a = g.allow(100, 5, &[STRANGER]);
    a.ms = multisig(OTHER_MS, TOKEN, 1, &[STRANGER]);
    a.run().refused(E::Custom(1));
    let mut a = g.allow(0, 100, &[STRANGER]);
    a.ms = multisig(OTHER_MS, TOKEN, 1, &[STRANGER]);
    a.run().refused(E::Custom(1));
}

#[test]
fn a_forged_multisig_cannot_set_the_cap() {
    let g = Gate::new();
    let mut a = g.allow(0, 100, &[CUSTODY]);
    a.ms.owner = FAKE_PROGRAM;
    a.run().refused(E::Custom(5));
    let mut a = g.allow(0, 100, &[CUSTODY]);
    a.ms.data.truncate(354);
    a.run().refused(E::Custom(5));
}

#[test]
fn the_cap_goes_only_to_the_gates_cap_pda() {
    let g = Gate::new();
    for cap in [cap_of(&pk(70)).0, g.key(), STRANGER] {
        let mut a = g.allow(100, 5, &[CUSTODY]);
        a.cap = cap;
        a.run().refused(E::Custom(5));
    }
}

// A holder of the close authority could close the emptied account and open the address again as its own.
#[test]
fn the_cap_is_refused_while_another_key_holds_the_close_authority() {
    let g = Gate::new();
    let mut a = g.allow(100, 5, &[CUSTODY]);
    a.src = token(X, g.key(), 100, Some(STRANGER));
    a.run().refused(E::Custom(5));
    let mut a = g.allow(100, 5, &[CUSTODY]);
    a.src = token(X, g.key(), 100, None);
    a.run().ok();
    let mut a = g.allow(100, 5, &[CUSTODY]);
    a.src.data.truncate(164);
    a.run().refused(E::Custom(5));
}

#[test]
fn a_token_program_that_is_not_token_cannot_take_the_cap() {
    let g = Gate::new();
    let mut a = g.allow(100, 5, &[CUSTODY]);
    a.tok = FAKE_PROGRAM;
    a.run().refused(E::Custom(5));
}

// ── release ───────────────────────────────────────────────────────────────────────────────────────

#[test]
fn release_needs_the_threshold_and_hands_back_the_close_authority_first() {
    let g = Gate::new();
    for who in [
        &[CUSTODY][..],
        &[CUSTODY, BACKUP],
        &[TRUSTEE],
        &[STRANGER],
        &[vault(AGENT_LANE)],
        &[vault(OWNERS_LANE)],
        &[AGENT],
        &[],
    ] {
        g.release(who).run().refused(E::Custom(1));
    }
    let calls = g.release(&[CUSTODY, TRUSTEE]).run().ok();
    let set = |kind: u8| Cpi {
        program: TOKEN,
        metas: vec![(X, false, true), (g.key(), true, false)],
        data: [&[6u8, kind, 1][..], NEW_KEY.as_ref()].concat(),
        seeds: g.seeds(),
    };
    // SetAuthority(CloseAccount) then SetAuthority(AccountOwner)
    assert_eq!(calls, vec![set(3), set(2)]);
}

#[test]
fn only_the_gates_own_multisig_releases() {
    let g = Gate::new();
    let mut r = g.release(&[STRANGER]);
    r.ms = multisig(OTHER_MS, TOKEN, 1, &[STRANGER]);
    r.run().refused(E::Custom(1));
    let mut r = g.release(&[CUSTODY, TRUSTEE]);
    r.ms.owner = FAKE_PROGRAM;
    r.run().refused(E::Custom(5));
    let mut r = g.release(&[CUSTODY, TRUSTEE]);
    r.tok = FAKE_PROGRAM;
    r.run().refused(E::Custom(5));
}

#[test]
fn malformed_allow_and_release_data_is_refused() {
    let g = Gate::new();
    let a = g.allow(0, 100, &[CUSTODY, TRUSTEE]);
    let accs = [
        g.acc.clone(),
        a.src.clone(),
        program(TOKEN),
        custody_ms(),
        acc(g.cap, false, false),
    ];
    for d in [vec![2u8; 8], vec![2u8; 10], vec![3u8; 32], vec![3u8; 34]] {
        run(&accs, &d, NOW).refused(E::InvalidInstructionData);
    }
    run(&accs[..3], &[2, 0, 0, 0, 0, 0, 0, 0, 0], NOW).refused(E::NotEnoughAccountKeys);
}

fn pk(n: u8) -> Pubkey {
    Pubkey::new_from_array([n; 32])
}
