//! Host tests for prime-seat. They run the program's `process` with stubbed syscalls: no validator, no Squads. Every inner call the
//! program makes is recorded and checked with the privileges the runtime would grant. The ed25519 signature itself is checked
//! by the native program on a validator (the matrix in near-int/solana), so the signature bytes here are fillers.
//! Run: PRIME_CLUSTER=devnet cargo test
use prime_seat::process;
use solana_program::{
    account_info::AccountInfo,
    entrypoint::ProgramResult,
    hash::hashv,
    instruction::Instruction,
    program_error::ProgramError as E,
    program_stubs::{set_syscall_stubs, SyscallStubs},
    pubkey::Pubkey,
    rent::Rent,
    sysvar::instructions as sysvar_ix,
};
use std::{cell::RefCell, sync::Once};

const CLUSTER: &str = env!("PRIME_CLUSTER");
const DAY: i64 = 86_400;
const PID: Pubkey = Pubkey::new_from_array([7; 32]);
const SQUADS: Pubkey = solana_program::pubkey!("SMRTzfY6DfH5ik3TKiyLFfXexV8uSG3d2UksSCYdunG");
const ED25519: Pubkey = solana_program::pubkey!("Ed25519SigVerify111111111111111111111111111");
const SYSTEM: Pubkey = Pubkey::new_from_array([0; 32]);
const NOW: i64 = 1_800_000_000;
const MARKER_RENT: u64 = 890_880;

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
            .map(|s| Pubkey::create_program_address(s, &PID).unwrap())
            .collect();
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

fn stubs() {
    static ONCE: Once = Once::new();
    ONCE.call_once(|| {
        set_syscall_stubs(Box::new(Stubs));
    });
}

fn seat_of(owner: &Pubkey, settings: &Pubkey) -> (Pubkey, u8) {
    Pubkey::find_program_address(&[b"seat", owner.as_ref(), settings.as_ref()], &PID)
}
fn marker_of(owner: &Pubkey, settings: &Pubkey, key: &Pubkey) -> (Pubkey, u8) {
    Pubkey::find_program_address(&[owner.as_ref(), settings.as_ref(), key.as_ref()], &PID)
}
fn grant_hash(
    cluster: &str,
    settings: &Pubkey,
    seat: &Pubkey,
    key: &Pubkey,
    start: i64,
    end: i64,
) -> [u8; 32] {
    hashv(&[
        b"prime-seat-grant",
        cluster.as_bytes(),
        settings.as_ref(),
        seat.as_ref(),
        key.as_ref(),
        &start.to_be_bytes(),
        &end.to_be_bytes(),
    ])
    .to_bytes()
}
fn disc(name: &str) -> [u8; 8] {
    hashv(&[format!("global:{name}").as_bytes()]).to_bytes()[..8]
        .try_into()
        .unwrap()
}
fn pk(n: u8) -> Pubkey {
    Pubkey::new_from_array([n; 32])
}

/// What the ed25519 instruction in the transaction says: who signed what, and where its fields sit.
#[derive(Clone)]
struct Ed {
    program: Pubkey,
    count: u8,
    signer: Pubkey,
    message: Vec<u8>,
    sig_ix: u16,
    key_ix: u16,
    msg_ix: u16,
}

fn ed_data(e: &Ed) -> Vec<u8> {
    let (key_off, sig_off, msg_off) = (16u16, 48u16, 112u16);
    let mut d = vec![e.count, 0];
    for w in [
        sig_off,
        e.sig_ix,
        key_off,
        e.key_ix,
        msg_off,
        e.message.len() as u16,
        e.msg_ix,
    ] {
        d.extend(w.to_le_bytes());
    }
    d.extend(e.signer.as_ref());
    d.extend([9u8; 64]);
    d.extend(&e.message);
    d
}

/// The instructions sysvar for a transaction of [ed25519 instruction, the seat instruction].
fn sysvar_data(e: &Ed) -> Vec<u8> {
    let first = ed_data(e);
    let mut ix = vec![vec![0u8, 0], vec![0u8, 0]];
    ix[0].extend(&e.program.to_bytes());
    ix[0].extend((first.len() as u16).to_le_bytes());
    ix[0].extend(&first);
    ix[1].extend(&PID.to_bytes());
    ix[1].extend(0u16.to_le_bytes());
    let mut out = (2u16).to_le_bytes().to_vec();
    let mut off = 2 + 2 * 2;
    for i in &ix {
        out.extend((off as u16).to_le_bytes());
        off += i.len();
    }
    for i in &ix {
        out.extend(i);
    }
    out.extend(0u16.to_le_bytes());
    out
}

struct Acc {
    key: Pubkey,
    signer: bool,
    writable: bool,
    lamports: u64,
    data: Vec<u8>,
    owner: Pubkey,
}
impl Acc {
    fn new(key: Pubkey, signer: bool, writable: bool) -> Self {
        Acc {
            key,
            signer,
            writable,
            lamports: 0,
            data: vec![],
            owner: SYSTEM,
        }
    }
}

#[derive(Clone)]
struct Case {
    mode: u8,
    owner: Pubkey,
    settings: Pubkey,
    key: Pubkey,
    start: i64,
    end: i64,
    now: i64,
    inner: Vec<u8>,
    ed: Ed,
    sig_ix: u8,
    key_signs: bool,
    marker: Option<Pubkey>,
    marker_taken: bool,
    marker_lamports: u64,
    sysvar: Pubkey,
    tail: Vec<(Pubkey, bool, bool)>,
    data_cut: Option<usize>,
}

impl Case {
    /// A session action by `key` for `owner`'s seat in `settings`, signed correctly over the grant for [now - 60, now + 3600].
    fn new() -> Self {
        let (owner, settings, key) = (pk(1), pk(2), pk(3));
        let (seat, _) = seat_of(&owner, &settings);
        let (start, end) = (NOW - 60, NOW + 3600);
        let ed = Ed {
            program: ED25519,
            count: 1,
            signer: owner,
            message: grant_hash(CLUSTER, &settings, &seat, &key, start, end).to_vec(),
            sig_ix: 0xffff,
            key_ix: 0xffff,
            msg_ix: 0xffff,
        };
        Case {
            mode: 0,
            owner,
            settings,
            key,
            start,
            end,
            now: NOW,
            inner: approve(),
            ed,
            sig_ix: 0,
            key_signs: true,
            marker: None,
            marker_taken: false,
            marker_lamports: MARKER_RENT,
            sysvar: sysvar_ix::ID,
            tail: vec![
                (pk(20), false, false),
                (pk(21), true, true),
                (seat, false, false),
                (SQUADS, false, false),
            ],
            data_cut: None,
        }
    }
    fn seat(&self) -> Pubkey {
        seat_of(&self.owner, &self.settings).0
    }
    /// Re-sign the grant for the case's current fields (call after changing owner, settings, key, start or end).
    fn resign(mut self) -> Self {
        let seat = self.seat();
        let (s, e) = if self.mode == 2 {
            (0, 0)
        } else {
            (self.start, self.end)
        };
        self.ed.signer = self.owner;
        self.ed.message = grant_hash(CLUSTER, &self.settings, &seat, &self.key, s, e).to_vec();
        if self.mode == 0 {
            self.tail[2].0 = seat;
        }
        self
    }
    fn revoke() -> Self {
        let mut c = Case::new();
        c.mode = 2;
        c.inner = vec![];
        c.key_signs = false;
        c.tail = vec![(SYSTEM, false, false)];
        c.resign()
    }
    fn data(&self) -> Vec<u8> {
        let mut d = vec![self.mode];
        d.extend(self.owner.as_ref());
        d.extend(self.settings.as_ref());
        d.push(self.sig_ix);
        if self.mode == 0 {
            d.extend(self.start.to_be_bytes());
            d.extend(self.end.to_be_bytes());
        }
        d.extend(&self.inner);
        if let Some(n) = self.data_cut {
            d.truncate(n);
        }
        d
    }
    fn run(&self) -> (ProgramResult, Vec<Cpi>) {
        stubs();
        CLOCK.with(|c| *c.borrow_mut() = self.now);
        CALLS.with(|c| c.borrow_mut().clear());
        let marker_key = self
            .marker
            .unwrap_or_else(|| marker_of(&self.owner, &self.settings, &self.key).0);
        let mut sysvar = Acc::new(self.sysvar, false, false);
        sysvar.data = sysvar_data(&self.ed);
        let mut key = Acc::new(self.key, self.key_signs, false);
        key.writable = true;
        let mut marker = Acc::new(marker_key, false, true);
        marker.lamports = self.marker_lamports;
        if self.marker_taken {
            marker.owner = PID;
        }
        let mut accs = vec![sysvar, key, marker];
        accs.extend(self.tail.iter().map(|&(k, s, w)| Acc::new(k, s, w)));
        let infos: Vec<AccountInfo> = accs
            .iter_mut()
            .map(|a| {
                AccountInfo::new(
                    &a.key,
                    a.signer,
                    a.writable,
                    &mut a.lamports,
                    &mut a.data,
                    &a.owner,
                    false,
                    0,
                )
            })
            .collect();
        let r = process(&PID, &infos, &self.data());
        (r, CALLS.with(|c| c.borrow().clone()))
    }
    fn ok(&self) -> Vec<Cpi> {
        let (r, calls) = self.run();
        assert_eq!(r, Ok(()));
        calls
    }
    fn refused(&self, want: E) {
        let (r, calls) = self.run();
        assert_eq!(r, Err(want));
        assert!(calls.is_empty(), "a refused call must make no inner call");
    }
}

// Squads instruction data. Arguments after the discriminator are not read by the program except the sync payload tags.
fn squads(name: &str, args: &[u8]) -> Vec<u8> {
    [&disc(name)[..], args].concat()
}
fn approve() -> Vec<u8> {
    squads("approve_proposal", &[0])
}
/// execute_transaction_sync_v2 with a Policy payload (tag 1) of the given policy kind: account index, signer count, payload tag, kind.
fn sync(kind: u8) -> Vec<u8> {
    squads("execute_transaction_sync_v2", &[0, 1, 1, kind, 0, 0])
}

const REFUSED_BY_NAME: [&str; 32] = [
    "initialize_program_config",
    "set_program_config_authority",
    "set_program_config_smart_account_creation_fee",
    "set_program_config_treasury",
    "create_smart_account",
    "add_signer_as_authority",
    "remove_signer_as_authority",
    "set_time_lock_as_authority",
    "change_threshold_as_authority",
    "set_new_settings_authority_as_authority",
    "set_archival_authority_as_authority",
    "add_spending_limit_as_authority",
    "remove_spending_limit_as_authority",
    "create_settings_transaction",
    "create_transaction",
    "create_transaction_buffer",
    "close_transaction_buffer",
    "extend_transaction_buffer",
    "create_transaction_from_buffer",
    "create_batch",
    "add_transaction_to_batch",
    "execute_batch_transaction",
    "cancel_proposal",
    "use_spending_limit",
    "close_settings_transaction",
    "close_transaction",
    "close_empty_policy_transaction",
    "close_batch_transaction",
    "close_batch",
    "execute_transaction_sync",
    "execute_settings_transaction_sync",
    "log_event",
];
const ALLOWED_BY_NAME: [&str; 6] = [
    "create_proposal",
    "activate_proposal",
    "approve_proposal",
    "reject_proposal",
    "execute_transaction",
    "execute_settings_transaction",
];

/// Hashes from the shared vectors of prime-near-signer v2 (Solana grants and an End), made by independent code.
#[test]
fn the_grant_hash_matches_the_shared_vectors() {
    if CLUSTER != "devnet" {
        return;
    }
    let vectors: [(&str, &str, &str, i64, i64, &str); 3] = [
        (
            "9eUopsCmsKQMBUsYTBc5Lvgtchkyeq3PG6qhRW8F8rdX",
            "6pkY5EaXrYQbY145r7PwZod2oJtvQJg7uBofrj79uCMt",
            "5uqxKUEQKq414fwudjqhRAXAxHJsTMLwHgJ1j8r9NW6d",
            1791799080,
            1791827880,
            "9450e293098d0b90b0fb2acf2157456f17145f7583eab156229b559339d040b9",
        ),
        (
            "Dq6J2shjxgqyCViFSsbQdeM7xnsqiCegXFt1V2AFSJCd",
            "DEfRamAWbVDdgie15VzJqV3RQXG1jHrrHwR9oSC7zNJa",
            "HDJyKKS14YEsgNekCrFxUXj3W1nVZqKVPgexZAiR2L1D",
            2147481728,
            2147488928,
            "845c9eacff5156e3e389e06085dccc2a4801ba181bde2a19fbad2dcc61a09d7a",
        ),
        (
            "6FyDNbkjncn8WQKdAxcjUJyvbDneR1fvhzAE4WniKPEJ",
            "9Atr8tkEVAxNWELEA2crrHpCiXFjh1HqyenBwqbYjjdh",
            "5fg1uyvPYrKxoDWYe8fz1oc1QsMByjDc8jeujbSq4ZTe",
            0,
            0,
            "e6f008c41e233ff7c16f5ebbe7622c33c51290f99fe13dc22690f3d5f38592eb",
        ),
    ];
    for (settings, seat, key, start, end, want) in vectors {
        let p = |s: &str| s.parse::<Pubkey>().unwrap();
        let got = grant_hash("devnet", &p(settings), &p(seat), &p(key), start, end);
        let hex: String = got.iter().map(|b| format!("{b:02x}")).collect();
        assert_eq!(hex, want);
    }
}

// ── a session acts ────────────────────────────────────────────────────────────────────────────────

#[test]
fn a_session_forwards_the_call_to_squads_signed_by_the_seat() {
    let c = Case::new();
    let calls = c.ok();
    let (seat, bump) = seat_of(&c.owner, &c.settings);
    assert_eq!(calls.len(), 1);
    assert_eq!(calls[0].program, SQUADS);
    assert_eq!(calls[0].data, c.inner);
    assert_eq!(
        calls[0].seeds,
        vec![vec![
            b"seat".to_vec(),
            c.owner.to_bytes().to_vec(),
            c.settings.to_bytes().to_vec(),
            vec![bump]
        ]]
    );
    // the seat signs; other signers and the write flags stay as the transaction gave them; the key and the sysvar are not passed on
    assert_eq!(
        calls[0].metas,
        vec![
            (pk(20), false, false),
            (pk(21), true, true),
            (seat, true, false),
            (SQUADS, false, false)
        ]
    );
}

#[test]
fn the_seat_is_the_canonical_pda_so_a_second_pda_for_the_same_owner_never_signs() {
    let c = Case::new();
    let (seat, bump) = seat_of(&c.owner, &c.settings);
    let other = (0..bump).rev().find_map(|b| {
        Pubkey::create_program_address(
            &[b"seat", c.owner.as_ref(), c.settings.as_ref(), &[b]],
            &PID,
        )
        .ok()
    });
    let o = other.expect("a lower bump gives a second valid address for these keys");
    let mut d = c.clone();
    d.tail[2].0 = o;
    // the non-canonical address is not signed for: it stays a plain account in the call
    assert_eq!(d.ok()[0].metas[2], (o, false, false));
    assert_ne!(o, seat);
    // a seat derived with the owner and settings swapped is another address
    assert_ne!(seat, seat_of(&c.settings, &c.owner).0);
}

#[test]
fn every_allowed_squads_call_passes() {
    for name in ALLOWED_BY_NAME {
        let mut c = Case::new();
        c.inner = squads(name, &[0]);
        assert_eq!(c.ok()[0].data, c.inner, "{name}");
    }
    let mut c = Case::new();
    c.inner = squads("activate_proposal", &[]);
    c.ok();
}

#[test]
fn every_other_squads_call_is_refused() {
    for name in REFUSED_BY_NAME {
        let mut c = Case::new();
        c.inner = squads(name, &[0, 0, 0, 0]);
        c.refused(E::Custom(8));
    }
}

#[test]
fn a_session_never_creates_a_transaction_or_a_settings_transaction() {
    for name in ["create_transaction", "create_settings_transaction"] {
        let mut c = Case::new();
        c.inner = squads(name, &[0; 40]);
        c.refused(E::Custom(8));
    }
}

#[test]
fn an_unknown_discriminator_or_short_data_is_refused() {
    for inner in [
        vec![],
        vec![1, 2, 3],
        vec![0; 8],
        disc("approve_proposal")[..7].to_vec(),
    ] {
        let mut c = Case::new();
        c.inner = inner;
        c.refused(E::Custom(8));
    }
}

// Policy use is execute_transaction_sync_v2 with a Policy payload (tag 1) that is not SettingsChange (tag 3).
#[test]
fn policy_use_passes_for_every_policy_type_but_settings_change() {
    for kind in [0u8, 1, 2] {
        let mut c = Case::new();
        c.inner = sync(kind);
        assert_eq!(c.ok()[0].data, c.inner);
    }
    let mut c = Case::new();
    c.inner = sync(3);
    c.refused(E::Custom(8));
}

#[test]
fn synchronous_execution_on_the_settings_is_refused() {
    // SyncPayload::Transaction is tag 0: the settings consensus runs the vault transaction at the seat's weight alone
    let mut c = Case::new();
    c.inner = squads("execute_transaction_sync_v2", &[0, 1, 0, 4, 0, 0, 0]);
    c.refused(E::Custom(8));
    // a cut-off payload (no payload tag, or no policy kind) is refused too
    for cut in [&[0u8, 1][..], &[0, 1, 1][..]] {
        let mut c = Case::new();
        c.inner = squads("execute_transaction_sync_v2", cut);
        c.refused(E::Custom(8));
    }
}

// ── the grant ─────────────────────────────────────────────────────────────────────────────────────

#[test]
fn the_grant_must_come_from_the_ed25519_program_with_every_field_in_that_instruction() {
    let mut c = Case::new();
    c.ed.program = pk(9);
    c.refused(E::Custom(7));
    for f in 0..3 {
        let mut c = Case::new();
        match f {
            0 => c.ed.sig_ix = 0,
            1 => c.ed.key_ix = 0,
            _ => c.ed.msg_ix = 0,
        }
        c.refused(E::Custom(7));
    }
    let mut c = Case::new();
    c.ed.count = 2;
    c.refused(E::Custom(7));
    let mut c = Case::new();
    c.ed.count = 0;
    c.refused(E::Custom(7));
}

#[test]
fn the_grant_instruction_index_points_at_the_ed25519_instruction() {
    let mut c = Case::new();
    c.sig_ix = 1; // the seat instruction itself
    c.refused(E::Custom(7));
    let mut c = Case::new();
    c.sig_ix = 9; // past the last instruction
    let (r, calls) = c.run();
    assert!(r.is_err() && calls.is_empty());
}

#[test]
fn the_sysvar_must_be_the_instructions_sysvar() {
    let mut c = Case::new();
    c.sysvar = pk(99);
    let (r, calls) = c.run();
    assert!(r.is_err() && calls.is_empty());
}

#[test]
fn only_the_owner_key_can_have_signed_the_grant() {
    let mut c = Case::new();
    c.ed.signer = pk(50);
    c.refused(E::Custom(7));
}

#[test]
fn every_field_of_the_grant_is_bound() {
    let base = Case::new();
    let seat = base.seat();
    let h = |cluster: &str, settings: &Pubkey, seat: &Pubkey, key: &Pubkey, s: i64, e: i64| {
        grant_hash(cluster, settings, seat, key, s, e).to_vec()
    };
    let other = [
        h(
            "localnet-x",
            &base.settings,
            &seat,
            &base.key,
            base.start,
            base.end,
        ), // another cluster
        h(CLUSTER, &pk(60), &seat, &base.key, base.start, base.end), // another account
        h(
            CLUSTER,
            &base.settings,
            &pk(61),
            &base.key,
            base.start,
            base.end,
        ), // another seat
        h(
            CLUSTER,
            &base.settings,
            &seat,
            &pk(62),
            base.start,
            base.end,
        ), // another key
        h(
            CLUSTER,
            &base.settings,
            &seat,
            &base.key,
            base.start - 1,
            base.end,
        ), // another start
        h(
            CLUSTER,
            &base.settings,
            &seat,
            &base.key,
            base.start,
            base.end + 1,
        ), // another end
        h(
            CLUSTER,
            &base.settings,
            &seat,
            &base.key,
            base.end,
            base.start,
        ), // swapped
    ];
    for m in other {
        let mut c = Case::new();
        c.ed.message = m;
        c.refused(E::Custom(7));
    }
    let mut c = Case::new();
    c.ed.message.truncate(31);
    c.refused(E::Custom(7));
    let mut c = Case::new();
    c.ed.message.push(0);
    c.refused(E::Custom(7));
}

#[test]
fn a_grant_for_one_account_does_not_work_in_another() {
    let granted = Case::new();
    let mut c = granted.clone();
    c.settings = pk(70); // the same signature, the instruction names another account
    c.refused(E::Custom(7));
    // the owner signs for the other account too: the hash differs, because the seat and the account are both in it
    let c = Case {
        settings: pk(70),
        ..granted.clone()
    }
    .resign();
    c.ok();
    assert_ne!(
        granted.ed.message.clone(),
        Case {
            settings: pk(70),
            ..granted
        }
        .resign()
        .ed
        .message
    );
}

#[test]
fn a_grant_for_one_program_id_does_not_work_under_another() {
    // the seat is derived from the program id, so the same owner and account give another seat under another id
    let c = Case::new();
    let other =
        Pubkey::find_program_address(&[b"seat", c.owner.as_ref(), c.settings.as_ref()], &pk(8)).0;
    assert_ne!(other, c.seat());
    let mut d = c.clone();
    d.ed.message = grant_hash(CLUSTER, &c.settings, &other, &c.key, c.start, c.end).to_vec();
    d.refused(E::Custom(7));
}

// ── time ──────────────────────────────────────────────────────────────────────────────────────────

#[test]
fn the_session_runs_from_its_start_to_its_end_inclusive() {
    for now in [NOW - 60, NOW - 59, NOW + 3599, NOW + 3600] {
        Case { now, ..Case::new() }.ok();
    }
    for now in [NOW - 61, NOW + 3601] {
        Case { now, ..Case::new() }.refused(E::Custom(4));
    }
}

#[test]
fn a_session_lasts_at_most_seven_days() {
    for (start, end, ok) in [
        (NOW, NOW + 7 * DAY, true),
        (NOW, NOW + 7 * DAY + 1, false),
        (NOW - 7 * DAY, NOW, true),
        (NOW - 7 * DAY - 1, NOW, false),
    ] {
        let c = Case {
            start,
            end,
            ..Case::new()
        }
        .resign();
        if ok {
            c.ok();
        } else {
            c.refused(E::Custom(4));
        }
    }
}

#[test]
fn an_end_before_the_start_or_far_apart_is_refused_without_overflow() {
    for (start, end) in [
        (NOW, NOW - 1),
        (i64::MIN, NOW),
        (NOW, i64::MAX),
        (i64::MIN, i64::MAX),
    ] {
        Case {
            start,
            end,
            ..Case::new()
        }
        .resign()
        .refused(E::Custom(4));
    }
}

// ── who signs the transaction, the marker, the key ────────────────────────────────────────────────

#[test]
fn the_session_key_must_sign_the_transaction() {
    Case {
        key_signs: false,
        ..Case::new()
    }
    .refused(E::MissingRequiredSignature);
}

#[test]
fn the_owner_key_is_never_a_session_key() {
    let c = Case {
        key: pk(1),
        ..Case::new()
    }
    .resign();
    c.refused(E::Custom(9));
}

#[test]
fn a_revoked_key_is_refused() {
    Case {
        marker_taken: true,
        ..Case::new()
    }
    .refused(E::Custom(2));
}

#[test]
fn the_marker_must_be_the_one_the_owner_account_and_key_derive() {
    for m in [
        pk(80),
        marker_of(&pk(1), &pk(2), &pk(4)).0,
        marker_of(&pk(1), &pk(5), &pk(3)).0,
        marker_of(&pk(6), &pk(2), &pk(3)).0,
    ] {
        Case {
            marker: Some(m),
            ..Case::new()
        }
        .refused(E::Custom(2));
    }
    // the marker address is a plain derivation under this program, with the account's seat seeds not involved
    assert_ne!(
        marker_of(&pk(1), &pk(2), &pk(3)).0,
        seat_of(&pk(1), &pk(2)).0
    );
}

// ── modes and short data ──────────────────────────────────────────────────────────────────────────

#[test]
fn only_mode_zero_and_mode_two_run() {
    for mode in [1u8, 3, 4, 128, 255] {
        Case {
            mode,
            ..Case::new()
        }
        .refused(E::InvalidInstructionData);
    }
}

#[test]
fn short_data_is_refused_not_trapped() {
    for cut in [0usize, 1, 65, 66, 80] {
        let (r, calls) = Case {
            data_cut: Some(cut),
            ..Case::new()
        }
        .run();
        assert_eq!(r, Err(E::InvalidInstructionData), "cut at {cut}");
        assert!(calls.is_empty());
    }
    let (r, _) = Case {
        data_cut: Some(66 + 15),
        ..Case::new()
    }
    .run();
    assert_eq!(r, Err(E::InvalidInstructionData));
}

#[test]
fn too_few_accounts_is_refused() {
    stubs();
    let r = process(&PID, &[], &Case::new().data());
    assert_eq!(r, Err(E::NotEnoughAccountKeys));
}

// ── revoke ────────────────────────────────────────────────────────────────────────────────────────

fn marker_calls(c: &Case) -> Vec<Cpi> {
    let (m, mb) = marker_of(&c.owner, &c.settings, &c.key);
    let seeds = vec![vec![
        c.owner.to_bytes().to_vec(),
        c.settings.to_bytes().to_vec(),
        c.key.to_bytes().to_vec(),
        vec![mb],
    ]];
    // the transaction funds the marker with a System transfer of its own; the program assigns it to itself
    vec![Cpi {
        program: SYSTEM,
        metas: vec![(m, true, true)],
        data: [&[1u8, 0, 0, 0][..], PID.as_ref()].concat(),
        seeds,
    }]
}

#[test]
fn the_owners_signed_end_creates_the_marker() {
    let c = Case::revoke();
    assert_eq!(c.ok(), marker_calls(&c));
}

#[test]
fn the_key_itself_can_end_its_session_without_the_owner() {
    let mut c = Case::revoke();
    c.key_signs = true;
    c.ed.message = vec![0; 32]; // no valid owner signature at all
    assert_eq!(c.ok(), marker_calls(&c));
}

#[test]
fn an_end_needs_the_key_or_the_owner() {
    let mut c = Case::revoke();
    c.ed.signer = pk(50);
    c.refused(E::Custom(7));
    let mut c = Case::revoke();
    c.ed.message = vec![0; 32];
    c.refused(E::Custom(7));
}

#[test]
fn a_grant_signature_cannot_be_replayed_as_an_end() {
    // the owner's signature over the grant for [start, end] is public once the session starts
    let c = Case::new();
    let mut r = Case::revoke();
    r.ed.message = c.ed.message.clone();
    r.refused(E::Custom(7));
}

#[test]
fn an_end_names_the_seat_key_and_account() {
    let base = Case::revoke();
    let seat = base.seat();
    for m in [
        grant_hash("localnet-x", &base.settings, &seat, &base.key, 0, 0),
        grant_hash(CLUSTER, &pk(60), &seat, &base.key, 0, 0),
        grant_hash(CLUSTER, &base.settings, &pk(61), &base.key, 0, 0),
        grant_hash(CLUSTER, &base.settings, &seat, &pk(62), 0, 0),
    ] {
        let mut c = Case::revoke();
        c.ed.message = m.to_vec();
        c.refused(E::Custom(7));
    }
}

#[test]
fn an_owner_cannot_end_its_own_key_and_freeze_its_seat() {
    for key_signs in [false, true] {
        let c = Case {
            key: pk(1),
            key_signs,
            ..Case::revoke()
        }
        .resign();
        c.refused(E::Custom(9));
    }
}

#[test]
fn a_second_end_is_refused() {
    Case {
        marker_taken: true,
        ..Case::revoke()
    }
    .refused(E::Custom(2));
}

#[test]
fn the_end_marker_must_be_the_derived_address() {
    Case {
        marker: Some(pk(80)),
        ..Case::revoke()
    }
    .refused(E::Custom(2));
}

#[test]
fn an_end_does_not_forward_a_call_to_squads() {
    let mut c = Case::revoke();
    c.inner = approve(); // extra data after an end is not read as a call
    let calls = c.ok();
    assert!(calls.iter().all(|x| x.program == SYSTEM));
}

#[test]
fn an_end_with_an_unfunded_marker_is_refused() {
    // an unfunded empty account is dropped at the end of the transaction: the end would not last
    Case {
        marker_lamports: 0,
        ..Case::revoke()
    }
    .refused(E::InsufficientFunds);
    Case {
        marker_lamports: 1,
        ..Case::revoke()
    }
    .ok();
}
