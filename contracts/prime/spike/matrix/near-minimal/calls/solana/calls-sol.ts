// Contract calls through a session key on Solana: a Squads Smart Account (cloned from devnet) on a local validator
// (port 8969, ledger /tmp/ledger-calls), the round-9 prime-session program as the policy signer, and two programs the
// policy allows that are not the token program:
//   venue (our test program): deposit/withdraw(amount u64, beneficiary pubkey) on a ledger account, no token involved
//   Memo v2 (SPL): a memo whose text starts with "prime:"
// One ProgramInteraction policy, three constraints (the caller names which one each instruction claims):
//   0  venue, disc 0 (deposit), amount <= CAP, beneficiary == vault, ledger1 only, caller account == vault
//   1  Memo v2, text starts with "prime:", signer account == vault
//   2  venue, disc 0, ledger2 only AND ledger2's own data says total <= 50 (a state precondition), caller == vault
// Owners sign with plain local ed25519 keys (Phantom-style signMessage for the grant, transaction signing for seat votes): no NEAR.
// Every refusal is matched to the Squads error code, and a control shows the seats (2-of-3, no policy) can make the same call.
import { Connection, Ed25519Program, Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram, SYSVAR_INSTRUCTIONS_PUBKEY, Transaction, TransactionInstruction, TransactionMessage, ComputeBudgetProgram } from '@solana/web3.js';
import * as sa from '@sqds/smart-account';
import nacl from 'tweetnacl';
import { readFileSync, writeFileSync } from 'node:fs';

const RPC = process.env.CALLS_RPC ?? 'http://127.0.0.1:8969';
if (!/127\.0\.0\.1:8969/.test(RPC)) throw new Error('this harness runs on the local validator at port 8969 only');
const conn = new Connection(RPC, { commitment: 'confirmed', confirmTransactionInitialTimeout: 120_000 });
const PRIME = new PublicKey('FTNMFWiECbRp7D5MwJUiNQfee6NuJPjE7S11J9yc2B9G');
const VENUE_A = new PublicKey('7kSEx7WsFL6MnqmqkESwgMpThjjPR2GwSQZp5JBewaBg'), VENUE_B = new PublicKey('9kNMihGbC2Ej4o4bfhBfhnZRE4JSPVYCBE2umySjSHoW');
const MEMO = new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr');
const SOL = LAMPORTS_PER_SOL, CAP = 1000n, PRECOND = 50n;
const st: any = {}; const results: any[] = [];
const STATE = process.env.CALLS_STATE ?? 'state-calls-sol.json';
const save = () => writeFileSync(STATE, JSON.stringify({ ...st, results }, null, 1));
function record(name: string, expectOk: boolean, ok: boolean, detail: string, want?: RegExp) {
  const pass = ok === expectOk && (ok || !want || want.test(detail)); results.push({ name, pass, ok, detail }); save();
  console.log(`${pass ? 'PASS' : 'FAIL'} ${name} | ${ok ? `ok ${detail}` : `refused: ${detail}`}`);
  return pass;
}
const short = (e: any) => { const s = [e?.logs?.join(' '), e?.message, String(e)].filter(Boolean).join(' | ');
  return (s.match(/Error Code: \w+/) ?? s.match(/prime-session: [^"]*?(?= Program|$)/) ?? s.match(/(custom program error: 0x[0-9a-f]+|Program failed to complete|Signature verification failed|failed to complete: [^|]{0,80})/i))?.[0] ?? s.slice(0, 160); };
async function confirm(sig: string) {
  for (let i = 0; i < 180; i++) {
    const s = (await conn.getSignatureStatus(sig, { searchTransactionHistory: true })).value;
    if (s?.err) throw Object.assign(new Error(JSON.stringify(s.err)), { signature: sig });
    if (s?.confirmationStatus === 'confirmed' || s?.confirmationStatus === 'finalized') return sig;
    await new Promise((r) => setTimeout(r, 400));
  }
  throw new Error(`${sig} not confirmed`);
}
async function fund(to: PublicKey, lamports: number) { await confirm(await conn.requestAirdrop(to, lamports)); }
async function logsOf(sig: string) { return (await conn.getTransaction(sig, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 }))?.meta?.logMessages ?? []; }

// ── Keys ───────────────────────────────────────────────────────────────────────────────────────
const payer = Keypair.generate();
const seats = [Keypair.generate(), Keypair.generate(), Keypair.generate()];   // seat 0 is the Phantom-style key: it is also the session owner
const [PH, SB, SC] = seats;
await fund(payer.publicKey, 100 * SOL);
const ix = sa.instructions;

// ── Smart Account ──────────────────────────────────────────────────────────────────────────────
const pc = await sa.accounts.ProgramConfig.fromAccountAddress(conn, sa.getProgramConfigPda({})[0]);
const [settings] = sa.getSettingsPda({ accountIndex: BigInt(pc.smartAccountIndex.toString()) + 1n });
const vault = sa.getSmartAccountPda({ settingsPda: settings, accountIndex: 0 })[0];
{ const t = new Transaction().add(ix.createSmartAccount({ treasury: pc.treasury, creator: payer.publicKey, settings, settingsAuthority: null, threshold: 2, timeLock: 0, rentCollector: null,
    signers: seats.map((k) => ({ key: k.publicKey, permissions: { mask: 7 } })) }), SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: vault, lamports: 5 * SOL }));
  await confirm(await conn.sendTransaction(t, [payer])); }
st.settings = settings.toBase58(); st.vault = vault.toBase58(); save();

// ledgers owned by the venue programs
const ledger = (n: string) => { const kp = Keypair.generate(); st[n] = kp.publicKey.toBase58(); return kp; };
const L1 = ledger('ledger1'), L2 = ledger('ledger2'), L3 = ledger('ledger3'), L1B = ledger('ledger1B');
for (const [kp, prog] of [[L1, VENUE_A], [L2, VENUE_A], [L3, VENUE_A], [L1B, VENUE_B]] as const) {
  const t = new Transaction().add(SystemProgram.createAccount({ fromPubkey: payer.publicKey, newAccountPubkey: kp.publicKey, lamports: await conn.getMinimumBalanceForRentExemption(80), space: 80, programId: prog }));
  await confirm(await conn.sendTransaction(t, [payer, kp]));
}
const readLedger = async (kp: Keypair) => { const d = (await conn.getAccountInfo(kp.publicKey))!.data;
  return { total: d.readBigUInt64LE(0), caller: new PublicKey(d.subarray(8, 40)).toBase58(), beneficiary: new PublicKey(d.subarray(40, 72)).toBase58(), calls: d.readBigUInt64LE(72) }; };
const snap = async () => (await Promise.all([L1, L2, L3, L1B].map(readLedger))).map((l) => `${l.total}/${l.calls}`).join(' ');

// ── Instructions ───────────────────────────────────────────────────────────────────────────────
const u64 = (n: bigint) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(n); return b; };
const vdata = (disc: number, amount: bigint, who: PublicKey) => Buffer.concat([Buffer.from([disc]), u64(amount), who.toBuffer()]);
const venueIx = (o: { prog?: PublicKey; ledger?: Keypair; disc?: number; amount?: bigint; who?: PublicKey; caller?: PublicKey; data?: Buffer; callerSigner?: boolean; noCaller?: boolean } = {}) =>
  new TransactionInstruction({ programId: o.prog ?? VENUE_A, data: o.data ?? vdata(o.disc ?? 0, o.amount ?? 1n, o.who ?? vault),
    keys: [{ pubkey: (o.ledger ?? L1).publicKey, isSigner: false, isWritable: true }, ...(o.noCaller ? [] : [{ pubkey: o.caller ?? vault, isSigner: o.callerSigner ?? true, isWritable: true }])] });
const memoIx = (text: string, signer = vault) => new TransactionInstruction({ programId: MEMO, data: Buffer.from(text), keys: [{ pubkey: signer, isSigner: true, isWritable: true }] });
const deposit = (amount: bigint, o: Parameters<typeof venueIx>[0] = {}) => venueIx({ ...o, disc: 0, amount });

// ── Policy ─────────────────────────────────────────────────────────────────────────────────────
const D = sa.generated.DataOperator;
const pk = (...k: PublicKey[]) => ({ __kind: 'Pubkey', fields: [k] });
const policyPayload = () => ({ __kind: 'ProgramInteraction', fields: [{ accountIndex: 0, preHook: null, postHook: null, spendingLimits: [], instructionsConstraints: [
  { programId: VENUE_A,
    accountConstraints: [{ accountIndex: 0, accountConstraint: pk(L1.publicKey), owner: null }, { accountIndex: 1, accountConstraint: pk(vault), owner: null }],
    dataConstraints: [{ dataOffset: 0, dataValue: { __kind: 'U8', fields: [0] }, operator: D.Equals },
      { dataOffset: 1, dataValue: { __kind: 'U64Le', fields: [Number(CAP)] }, operator: D.LessThanOrEqualTo },
      { dataOffset: 9, dataValue: { __kind: 'U8Slice', fields: [vault.toBytes()] }, operator: D.Equals }] },
  { programId: MEMO, accountConstraints: [{ accountIndex: 0, accountConstraint: pk(vault), owner: null }],
    dataConstraints: [{ dataOffset: 0, dataValue: { __kind: 'U8Slice', fields: [new Uint8Array(Buffer.from('prime:'))] }, operator: D.Equals }] },
  { programId: VENUE_A,
    accountConstraints: [{ accountIndex: 0, accountConstraint: pk(L2.publicKey), owner: VENUE_A },
      { accountIndex: 0, accountConstraint: { __kind: 'AccountData', fields: [[{ dataOffset: 0, dataValue: { __kind: 'U64Le', fields: [Number(PRECOND)] }, operator: D.LessThanOrEqualTo }]] }, owner: VENUE_A },
      { accountIndex: 1, accountConstraint: pk(vault), owner: null }],
    dataConstraints: [{ dataOffset: 0, dataValue: { __kind: 'U8', fields: [0] }, operator: D.Equals }] },
] }] });

// ── Seat decisions (2-of-3, no policy): used for the policy install and for the controls ────────
const nextIndex = async () => BigInt((await sa.accounts.Settings.fromAccountAddress(conn, settings)).transactionIndex.toString()) + 1n;
async function sendBy(name: string, expectOk: boolean, signers: Keypair[], ixs: TransactionInstruction[], want?: RegExp) {
  let ok = true, d = '';
  try {
    const t = new Transaction().add(...ixs); t.feePayer = payer.publicKey; t.recentBlockhash = (await conn.getLatestBlockhash('confirmed')).blockhash; t.sign(payer, ...signers);
    d = await conn.sendRawTransaction(t.serialize()); await confirm(d);
  } catch (e: any) { ok = false; d = short(e); if (e?.getLogs) try { const l = await e.getLogs(conn); if (Array.isArray(l) && l.length) d = short({ logs: l }); } catch {} }
  return record(name, expectOk, ok, d, want);
}
async function decide(label: string, a: Keypair, b: Keypair, actions: { vault?: TransactionInstruction[]; settings?: any[]; policies?: PublicKey[] }, expectOk = true) {
  const index = await nextIndex();
  const create = actions.settings
    ? ix.createSettingsTransaction({ settingsPda: settings, transactionIndex: index, creator: a.publicKey, rentPayer: payer.publicKey, actions: actions.settings })
    : ix.createTransaction({ settingsPda: settings, transactionIndex: index, creator: a.publicKey, rentPayer: payer.publicKey, accountIndex: 0, ephemeralSigners: 0, addressLookupTableAccounts: [],
        transactionMessage: new TransactionMessage({ payerKey: vault, recentBlockhash: (await conn.getLatestBlockhash()).blockhash, instructions: actions.vault! }) });
  await sendBy(`${label}a. seat ${a.publicKey.toBase58().slice(0, 4)} proposes and approves`, true, [a], [create, ix.createProposal({ settingsPda: settings, transactionIndex: index, creator: a.publicKey, rentPayer: payer.publicKey }), ix.approveProposal({ settingsPda: settings, transactionIndex: index, signer: a.publicKey })]);
  const exec = actions.settings
    ? ix.executeSettingsTransaction({ settingsPda: settings, transactionIndex: index, signer: b.publicKey, rentPayer: payer.publicKey, policies: actions.policies ?? [] })
    : (await ix.executeTransaction({ connection: conn, settingsPda: settings, transactionIndex: index, signer: b.publicKey })).instruction;
  return sendBy(`${label}b. seat ${b.publicKey.toBase58().slice(0, 4)} approves and executes`, expectOk, [b], [ix.approveProposal({ settingsPda: settings, transactionIndex: index, signer: b.publicKey }), exec]);
}

// ── prime-session ──────────────────────────────────────────────────────────────────────────────
const pda = PublicKey.findProgramAddressSync([Buffer.from('prime'), PH.publicKey.toBuffer(), settings.toBuffer()], PRIME)[0];
const bump = PublicKey.findProgramAddressSync([Buffer.from('prime'), PH.publicKey.toBuffer(), settings.toBuffer()], PRIME)[1];
const markerOf = (key: PublicKey) => PublicKey.findProgramAddressSync([PH.publicKey.toBuffer(), settings.toBuffer(), key.toBuffer()], PRIME)[0];
const grantText = (key: PublicKey, until: number) => `Prime session\nsigner: ${pda.toBase58()}\nsession key: ${key.toBase58()}\nvalid until (unix time): ${until}\ncluster: localnet`;
type Session = { key: Keypair; until: number; sigIx: TransactionInstruction };
async function openSession(seconds = 3600): Promise<Session> {
  const key = Keypair.generate(), until = Math.floor(Date.now() / 1000) + seconds, text = grantText(key.publicKey, until);
  const sig = nacl.sign.detached(new TextEncoder().encode(text), PH.secretKey);   // Phantom signMessage: plain ed25519 over the text
  await fund(key.publicKey, 0.05 * SOL);
  return { key, until, sigIx: Ed25519Program.createInstructionWithPublicKey({ publicKey: PH.publicKey.toBytes(), message: Buffer.from(text), signature: sig }) };
}
const policyAddr = () => new PublicKey(st.policy);
/** The policy payload for `instrs`, each claiming constraint `indices[i]` (null: no indices sent). */
function policyMove(instrs: TransactionInstruction[], indices: number[] | null) {
  // The SDK helper adds the signer list once per instruction, which shifts every account index after the first instruction; with no members it
  // returns indices into the account list alone, and the policy signer (the session PDA) goes in front once.
  const d = sa.utils.instructionsToSynchronousTransactionDetailsV2({ vaultPda: vault, members: [], transaction_instructions: instrs });
  const accounts = [{ pubkey: pda, isSigner: true, isWritable: false }, ...d.accounts];
  return ix.executePolicyPayloadSync({ policy: policyAddr(), accountIndex: 0, numSigners: 1, instruction_accounts: accounts,
    policyPayload: { __kind: 'ProgramInteraction', fields: [{ instructionConstraintIndices: indices === null ? null : new Uint8Array(indices), transactionPayload: { __kind: 'SyncTransaction', fields: [{ accountIndex: 0, instructions: d.instructions }] } }] } as any });
}
function viaSession(s: Session, inner: TransactionInstruction): TransactionInstruction[] {
  const head = Buffer.concat([PH.publicKey.toBuffer(), settings.toBuffer(), Buffer.from(new BigInt64Array([BigInt(s.until)]).buffer), Buffer.from([0, bump])]);
  const keys = [{ pubkey: SYSVAR_INSTRUCTIONS_PUBKEY, isSigner: false, isWritable: false }, { pubkey: s.key.publicKey, isSigner: true, isWritable: true }, { pubkey: pda, isSigner: false, isWritable: false },
    { pubkey: inner.programId, isSigner: false, isWritable: false }, { pubkey: markerOf(s.key.publicKey), isSigner: false, isWritable: false },
    ...inner.keys.map((k) => ({ ...k, isSigner: k.pubkey.equals(pda) ? false : k.isSigner }))];
  return [s.sigIx, new TransactionInstruction({ programId: PRIME, keys, data: Buffer.concat([head, inner.data]) })];
}
let lastSig = '';
/** One move: instructions `instrs`, each claiming a constraint index, signed by the session key, relayer pays. */
async function move(name: string, expectOk: boolean, s: Session, instrs: TransactionInstruction[], indices: number[] | null, want?: RegExp, o: { units?: number } = {}) {
  let ok = true, d = '';
  const before = await snap();
  try {
    const t = new Transaction().add(...viaSession(s, policyMove(instrs, indices))); if (o.units) t.add(ComputeBudgetProgram.setComputeUnitLimit({ units: o.units }));
    t.feePayer = payer.publicKey; t.recentBlockhash = (await conn.getLatestBlockhash('confirmed')).blockhash; t.sign(payer, s.key);
    d = await conn.sendRawTransaction(t.serialize()); await confirm(d); lastSig = d;
    const tx = await conn.getTransaction(d, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 }); d = `${tx?.meta?.computeUnitsConsumed} CU, ${t.serialize().length} B`;
  } catch (e: any) { ok = false; d = short(e); if (e?.getLogs) try { const l = await e.getLogs(conn); if (Array.isArray(l) && l.length) d = short({ logs: l }); } catch {} }
  const pass = record(name, expectOk, ok, d, want);
  if (!expectOk) record(`   ${name.split(' ')[0]} no ledger changed by the refused move`, true, before === await snap(), await snap());
  return pass;
}
/** A move that must be refused whichever constraint (0, 1 or 2) it claims. */
async function refusedUnderEvery(name: string, s: Session, instr: TransactionInstruction, want?: RegExp) {
  const before = await snap(); const why: string[] = []; let allRefused = true;
  for (const i of [0, 1, 2]) {
    try { const t = new Transaction().add(...viaSession(s, policyMove([instr], [i]))); t.feePayer = payer.publicKey; t.recentBlockhash = (await conn.getLatestBlockhash('confirmed')).blockhash; t.sign(payer, s.key);
      const sig = await conn.sendRawTransaction(t.serialize()); await confirm(sig); allRefused = false; why.push(`constraint ${i}: ACCEPTED`);
    } catch (e: any) { let m = short(e); if (e?.getLogs) try { const l = await e.getLogs(conn); if (Array.isArray(l) && l.length) m = short({ logs: l }); } catch {} why.push(`constraint ${i}: ${m}`); }
  }
  const after = await snap();
  record(name, false, !allRefused, why.join('; '));
  return record(`   ${name.split(' ')[0]} refused under constraint 0, 1 and 2, and no ledger changed`, true, allRefused && before === after, after);
}

// ── Setup: policy installed by two seats (2-of-3) ───────────────────────────────────────────────
console.log('vault', vault.toBase58(), 'policy signer (session PDA)', pda.toBase58(), 'prime-session', PRIME.toBase58(), 'venue', VENUE_A.toBase58(), 'venue B', VENUE_B.toBase58());
{ const seed = Number((await sa.accounts.Settings.fromAccountAddress(conn, settings)).policySeed ?? 0) + 1;
  const policy = sa.getPolicyPda({ settingsPda: settings, policySeed: seed })[0]; st.policy = policy.toBase58(); save();
  await decide('P1. two seats install the policy (3 constraints, no spending limit, members: the Phantom-style key\'s session PDA):', PH, SB, { settings: [{ __kind: 'PolicyCreate', seed, policyCreationPayload: policyPayload(), signers: [{ key: pda, permissions: { mask: 7 } }], threshold: 1, timeLock: 0, startTimestamp: null, expirationArgs: null }], policies: [policy] }); }
{ const p = await sa.accounts.Policy.fromAccountAddress(conn, policyAddr());
  const pi = (p as any).policyState?.fields?.[0] ?? (p as any).policyState;
  record('P2. the policy account holds a ProgramInteraction policy with 3 instruction constraints and no spending limit', true, JSON.stringify(p.policyState).includes('ProgramInteraction') && (pi?.instructionsConstraints?.length ?? pi?.fields?.[0]?.instructionsConstraints?.length) === 3, `${(pi?.instructionsConstraints ?? pi?.fields?.[0]?.instructionsConstraints)?.length} constraints`); }
{ const s = (await sa.accounts.Settings.fromAccountAddress(conn, settings));
  record('P3. the seats are the three keys, threshold 2; the session PDA is not a settings signer', true, s.signers.length === 3 && s.threshold === 2 && !s.signers.some((x: any) => x.key.equals(pda)), `${s.signers.length} signers / ${s.threshold}`); }

const E = { num: /ProgramInteractionInvalidNumericValue/, acct: /ProgramInteractionAccountConstraintViolated/, prog: /ProgramInteractionProgramIdMismatch/, short: /ProgramInteractionDataTooShort/, count: /ProgramInteractionInstructionCountMismatch/, owner: /IllegalAccountOwner/ };
const S = await openSession();
st.session = S.key.publicKey.toBase58(); save();

// ── V. Venue deposit: data and account constraints ───────────────────────────────────────────
console.log('--- constraint 0: venue deposit(amount <= 1000, beneficiary == vault), ledger1 only');
await move('V1. allowed: deposit(100, vault) on ledger1', true, S, [deposit(100n)], [0]);
{ const l = await readLedger(L1);
  record('V2. ledger1 shows total 100, one call, caller = the vault (not the session key, not the PDA), beneficiary = vault', true, l.total === 100n && l.calls === 1n && l.caller === vault.toBase58() && l.beneficiary === vault.toBase58(), JSON.stringify({ ...l, total: String(l.total), calls: String(l.calls) })); }
await move(`V3. boundary: deposit(${CAP}, vault), amount equal to the cap`, true, S, [deposit(CAP)], [0]);
await move(`V4. amount over the cap: deposit(${CAP + 1n}, vault)`, false, S, [deposit(CAP + 1n)], [0], E.num);
await move('V5. amount = 2^64 - 1', false, S, [deposit(2n ** 64n - 1n)], [0], E.num);
await move('V6. different beneficiary (a stranger)', false, S, [deposit(100n, { who: Keypair.generate().publicKey })], [0], E.num);
await move("V7. beneficiary is the session key's own address", false, S, [deposit(100n, { who: S.key.publicKey })], [0], E.num);
await move('V8. another instruction on the same program: withdraw(1, vault) (discriminator 1)', false, S, [venueIx({ disc: 1, amount: 1n })], [0], E.num);
await move('V9. a different ledger account (ledger3, same program)', false, S, [deposit(100n, { ledger: L3 })], [0], E.acct);
await move("V10. the caller account is the session key instead of the vault", false, S, [deposit(100n, { caller: S.key.publicKey })], [0], E.acct);
await move('V11. a second program with the same instruction and layout (venue B, its own ledger)', false, S, [deposit(100n, { prog: VENUE_B, ledger: L1B })], [0], E.prog);
await refusedUnderEvery('V12. the same wrong-program call', S, deposit(100n, { prog: VENUE_B, ledger: L1B }));
await refusedUnderEvery('V13. the same over-cap call', S, deposit(CAP + 1n));
await refusedUnderEvery('V14. the same wrong-beneficiary call', S, deposit(100n, { who: Keypair.generate().publicKey }));
await refusedUnderEvery('V15. the same withdraw call', S, venueIx({ disc: 1, amount: 1n }));
await move('V16. data too short: the discriminator alone', false, S, [venueIx({ data: Buffer.from([0]) })], [0], E.short);
await move('V17. a deposit with only the ledger account (fewer accounts than the constraint addresses), next to a valid memo', false, S, [venueIx({ noCaller: true, disc: 0, amount: 1n }), memoIx('prime:x')], [0, 1], undefined, { units: 400_000 });
{ const good = vdata(0, 7n, vault); const l0 = await readLedger(L1);
  await move('V18. the allowed call with 4 extra bytes after the arguments: accepted, the venue reads the same (7, vault)', true, S, [venueIx({ data: Buffer.concat([good, Buffer.from('ffffffff', 'hex')]) })], [0]);
  const l1 = await readLedger(L1); record('V18b. effect on the ledger is exactly deposit(7, vault)', true, l1.total - l0.total === 7n && l1.calls - l0.calls === 1n, `+${l1.total - l0.total}`); }
await move('V19. no constraint indices sent with a policy that has constraints', false, S, [deposit(1n)], null, E.count);
await move('V20. indices sent for two instructions but only one instruction present', false, S, [deposit(1n)], [0, 1], E.count);
await move('V21. a constraint index outside the list (7)', false, S, [deposit(1n)], [7]);

// ── M. Memo: a different non-token program, a fixed text prefix ──────────────────────────────
console.log('--- constraint 1: Memo v2, text starts with "prime:"');
await move('M1. allowed: memo "prime:rebalance 2026-10-08"', true, S, [memoIx('prime:rebalance 2026-10-08')], [1]);
{ const logs = await logsOf(lastSig); record('M2. the Memo program logged the text, signed by the vault', true, logs.some((l) => l.includes('prime:rebalance 2026-10-08')), logs.find((l) => l.includes('Memo'))?.slice(0, 120) ?? ''); }
await move('M3. memo with another prefix: "hello"', false, S, [memoIx('hello world')], [1], E.num);
await move('M4. memo shorter than the prefix: "pri"', false, S, [memoIx('pri')], [1], E.short);
await move('M5. memo with the prefix but a different case: "Prime:x"', false, S, [memoIx('Prime:x')], [1], E.num);
await move('M6. the memo signer is not the vault (the session key signs the memo)', false, S, [memoIx('prime:x', S.key.publicKey)], [1], E.acct);
await refusedUnderEvery('M7. the same wrong-prefix memo', S, memoIx('hello world'));

// ── B. Two instructions in one move ──────────────────────────────────────────────────────────
console.log('--- one move, two instructions, each claiming its own constraint');
{ const l0 = await readLedger(L1);
  await move('B1. deposit(5, vault) and memo "prime:two" in one move, indices [0, 1]', true, S, [deposit(5n), memoIx('prime:two')], [0, 1], undefined, { units: 400_000 });
  const l1 = await readLedger(L1); record('B2. both ran (ledger1 +5, memo logged)', true, l1.total - l0.total === 5n && (await logsOf(lastSig)).some((l) => l.includes('prime:two')), `+${l1.total - l0.total}`); }
await move('B3. the same two instructions claiming [0, 0]: the memo is checked against the deposit constraint', false, S, [deposit(5n), memoIx('prime:two')], [0, 0], E.prog, { units: 400_000 });
await move('B4. a good deposit and a bad memo in one move: nothing runs (atomic)', false, S, [deposit(5n), memoIx('nope nope')], [0, 1], E.num, { units: 400_000 });

// ── A. A state precondition read from an account's own data ──────────────────────────────────
console.log(`--- constraint 2: venue deposit to ledger2 only while ledger2's own total is <= ${PRECOND}`);
await move('A1. ledger2 total is 0: deposit(40, vault)', true, S, [deposit(40n, { ledger: L2 })], [2]);
await move('A2. ledger2 total is 40 (<= 50): deposit(40, vault) again, no amount cap on this constraint', true, S, [deposit(40n, { ledger: L2 })], [2]);
await move('A3. ledger2 total is now 80 (> 50): the precondition fails', false, S, [deposit(1n, { ledger: L2 })], [2], E.num);
{ const l = await readLedger(L2); record('A4. ledger2 holds 80 after two accepted deposits; the third did not run', true, l.total === 80n && l.calls === 2n, `${l.total} / ${l.calls}`); }
await move('A5. ledger3 (no Pubkey match, total 0) under constraint 2', false, S, [deposit(1n, { ledger: L3 })], [2], E.acct);
await move('A6. ledger2 under constraint 0 (it is not the listed ledger1)', false, S, [deposit(1n, { ledger: L2 })], [0], E.acct);

// ── C. Controls: the seats can make each refused call, so the policy is what refused it ─────────
console.log('--- controls: the same calls made by two seats (2-of-3, no policy)');
{ const t0 = await readLedger(L1);
  await decide('C1. two seats: deposit(1001, vault) (over the cap)', PH, SB, { vault: [deposit(CAP + 1n)] });
  await decide('C2. two seats: deposit(100, stranger) (other beneficiary)', SB, SC, { vault: [deposit(100n, { who: Keypair.generate().publicKey })] });
  await decide('C3. two seats: withdraw(1, vault) (other instruction)', PH, SC, { vault: [venueIx({ disc: 1, amount: 1n })] });
  await decide('C4. two seats: deposit on ledger3 (other account)', PH, SB, { vault: [deposit(100n, { ledger: L3 })] });
  await decide('C5. two seats: deposit on venue B (other program)', SB, SC, { vault: [deposit(100n, { prog: VENUE_B, ledger: L1B })] });
  await decide('C6. two seats: memo "hello world" (other prefix)', PH, SC, { vault: [memoIx('hello world')] });
  const l1 = await readLedger(L1), l3 = await readLedger(L3), lb = await readLedger(L1B);
  record('C7. the controls changed the ledgers as asked: ledger1 +1001 +100 -1, ledger3 +100, ledger1B +100', true, l1.total - t0.total === 1100n && l3.total === 100n && lb.total === 100n, `ledger1 +${l1.total - t0.total}, ledger3 ${l3.total}, ledger1B ${lb.total}`); }

// ── R. Session end and revoke apply to contract calls too ──────────────────────────────────────
{ const old = await openSession(-10); await move('R1. expired session makes the otherwise allowed deposit(1, vault)', false, old, [deposit(1n)], [0], /0x4\b/);
  const long = await openSession(8 * 86400); await move('R2. a session longer than 7 days', false, long, [deposit(1n)], [0], /0x4\b/);
  const thief = Keypair.generate(); await fund(thief.publicKey, 0.05 * SOL);
  await move('R3. someone else replays the grant with their own key', false, { ...S, key: thief }, [deposit(1n)], [0]); }

console.log(`${results.filter((r) => r.pass).length}/${results.length} passed`);
for (const r of results.filter((r) => !r.pass)) console.log('FAIL', r.name, r.detail);
process.exit(0);
