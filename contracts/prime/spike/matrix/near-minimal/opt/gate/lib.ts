// Shared harness for the a4-min gate (gate-owned custody): local validator on port 9101, sending and checking, token and multisig helpers, the Prime Account (Squads Smart Account),
// the agent's rules and stored batches, and the builders for the gate's four instructions. GATE_ID picks the program under test (a mutant has its own program id).
import {
  AddressLookupTableProgram, ComputeBudgetProgram, Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram, Transaction, TransactionInstruction, TransactionMessage, VersionedTransaction,
} from '@solana/web3.js';
import * as sa from '@sqds/smart-account';
import {
  ACCOUNT_SIZE, AuthorityType, MULTISIG_SIZE, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, createApproveInstruction, createAssociatedTokenAccountIdempotentInstruction, createCloseAccountInstruction,
  createInitializeAccount3Instruction, createInitializeMint2Instruction, createInitializeMultisigInstruction, createMintToInstruction, createRevokeInstruction, createSetAuthorityInstruction,
  createTransferInstruction, getAccount, getAssociatedTokenAddressSync, getMinimumBalanceForRentExemptMint, getMinimumBalanceForRentExemptMultisig, MINT_SIZE,
} from '@solana/spl-token';
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
// GATE_DET=<tag>: every key and seed of the run comes from a counter, so two builds run the same transactions on the same addresses and their compute units compare exactly.
const DET = process.env.GATE_DET; let detN = 0;
export const gen = (): Keypair => (DET ? Keypair.fromSeed(createHash('sha256').update(`${DET}:${detN++}`).digest()) : Keypair.generate());
import { handOverIxs } from './setup-checks';

export const RPC = process.env.GATE_RPC ?? 'http://127.0.0.1:9101';
if (!/127\.0\.0\.1:91\d\d/.test(RPC)) throw new Error('this harness runs on a local validator at port 9101 or above only');
export const conn = new Connection(RPC, { commitment: 'confirmed', confirmTransactionInitialTimeout: 120_000 });
export const here = new URL('.', import.meta.url).pathname;
export const kp = (f: string) => Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(`${here}secrets/${f}.json`, 'utf8'))));
export const GATE_ID = process.env.GATE_ID ?? 'gate-owned';
export const MODE = process.env.GATE_MODE ?? 'mock';
export const GATE = kp(GATE_ID).publicKey, VENUE = kp('venue').publicKey, HOSTILE = kp('hostile').publicKey, PSID = kp('prime-session').publicKey;
export const SQUADS = new PublicKey('SMRTzfY6DfH5ik3TKiyLFfXexV8uSG3d2UksSCYdunG');
export const SOL = LAMPORTS_PER_SOL, U = 1_000_000n;
export const SYS = SystemProgram.programId;
export const st: any = {}; export const results: any[] = []; export const costs: Record<string, any> = {};
const STATE = process.env.GATE_STATE ?? `${here}state-${GATE_ID}-${MODE}.json`;
export const save = () => writeFileSync(STATE, JSON.stringify({ ...st, gate: GATE_ID, costs, results }, null, 1));
export const NAMES: Record<string, string> = { [GATE.toBase58()]: 'gate', [VENUE.toBase58()]: 'venue', [HOSTILE.toBase58()]: 'hostile', [PSID.toBase58()]: 'prime-session',
  [TOKEN_PROGRAM_ID.toBase58()]: 'token', [TOKEN_2022_PROGRAM_ID.toBase58()]: 'token2022', [SQUADS.toBase58()]: 'squads', '11111111111111111111111111111111': 'system' };
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
export function record(name: string, expectOk: boolean, ok: boolean, detail: string, want?: RegExp) {
  const pass = ok === expectOk && (ok || !want || want.test(detail)); results.push({ name, pass, ok, detail }); save();
  console.log(`${pass ? 'PASS' : 'FAIL'} ${name} | ${ok ? `ok ${detail}` : `refused: ${detail}`}`);
  if (!pass && process.env.GATE_STOP_ON_FAIL) { console.log('stopped at the first failing check (GATE_STOP_ON_FAIL)'); process.exit(0); }
  return pass;
}
export const check = (name: string, cond: boolean, detail = '') => record(name, true, cond, detail);
/** The program and error that refused a transaction, from its logs. */
export function explain(logs: string[], fallback: string) {
  const f = logs.find((l) => /Program \S+ failed:/.test(l));
  const esc = logs.find((l) => /signer privilege escalated|writable privilege escalated|Unknown program|already in use|reentrancy|already borrowed/i.test(l));
  if (!f) return (esc ?? fallback).slice(0, 220);
  const m = f.match(/Program (\S+) failed: (.*)$/)!; const code = logs.map((l) => l.match(/Error Code: (\w+)/)?.[1]).find(Boolean);
  return `${NAMES[m[1]] ?? m[1].slice(0, 6)}: ${code ?? m[2]}${esc && !code ? ` (${esc.replace(/^Program log: /, '').slice(0, 90)})` : ''}`;
}
export async function confirm(sig: string) {
  for (let i = 0; i < 240; i++) {
    const s = (await conn.getSignatureStatus(sig, { searchTransactionHistory: true })).value;
    if (s?.err) throw Object.assign(new Error(JSON.stringify(s.err)), { signature: sig });
    if (s?.confirmationStatus === 'confirmed' || s?.confirmationStatus === 'finalized') return sig;
    await sleep(300);
  }
  throw new Error(`${sig} not confirmed`);
}
export async function fund(to: PublicKey, sol: number) { await confirm(await conn.requestAirdrop(to, Math.round(sol * SOL))); }
export const chainNow = async (): Promise<number> => { for (let i = 0; i < 40; i++) { try { return (await conn.getBlockTime(await conn.getSlot('confirmed')))!; } catch { await sleep(300); } } throw new Error('block time unavailable'); };
export async function until(t: number) { while ((await chainNow()) <= t) await sleep(400); }
export const later = async (s = 30) => (await chainNow()) + s;

// ── keys ───────────────────────────────────────────────────────────────────────────────────────
export const payer = gen();                 // the relayer: fee payer and rent payer
export const custody = gen(), backup = gen(), trustee = gen(), stranger = gen(), newKey = gen();
export const recovery = gen(), agent = gen(), other = gen();
export const owners = [gen(), gen(), gen()], owners2 = [gen(), gen(), gen()];
await fund(payer.publicKey, 2000);
for (const k of [custody, backup, trustee, newKey]) await fund(k.publicKey, 20);
export const ix = sa.instructions;
export const m = (pubkey: PublicKey, isSigner = false, isWritable = false) => ({ pubkey, isSigner, isWritable });

// ── sending and measuring ──────────────────────────────────────────────────────────────────────
export let last: { cu?: number; bytes?: number; gateCu?: number; logs: string[]; sig?: string } = { logs: [] };
export type SendOpts = { cost?: string; quiet?: boolean; feePayer?: Keypair; units?: number; heap?: boolean };
export async function send(name: string, expectOk: boolean, ixs: TransactionInstruction[], signers: Keypair[], want?: RegExp, o: SendOpts = {}) {
  let ok = true, d = '';
  try {
    const fp = o.feePayer ?? payer;
    const pre = [...(o.units ? [ComputeBudgetProgram.setComputeUnitLimit({ units: o.units })] : []), ...(o.heap ? [ComputeBudgetProgram.requestHeapFrame({ bytes: 262_144 })] : [])];
    const t = new Transaction().add(...pre, ...ixs); t.feePayer = fp.publicKey; t.recentBlockhash = (await conn.getLatestBlockhash('confirmed')).blockhash;
    t.sign(fp, ...signers.filter((k) => !k.publicKey.equals(fp.publicKey)));
    const raw = t.serialize(); const sig = await conn.sendRawTransaction(raw); await confirm(sig);
    const tx = await conn.getTransaction(sig, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 });
    const cu = tx?.meta?.computeUnitsConsumed;
    const gateCu = (tx?.meta?.logMessages ?? []).map((l) => l.match(new RegExp(`Program ${GATE.toBase58()} consumed (\\d+)`))?.[1]).filter(Boolean).reduce((a, b) => a + Number(b), 0);
    d = `${cu} CU, ${raw.length} B${gateCu ? `, gate ${gateCu} CU` : ''}`; last = { cu, bytes: raw.length, gateCu, logs: tx?.meta?.logMessages ?? [], sig };
    if (o.cost) (costs[o.cost] ??= { samples: [] }).samples.push({ cu, bytes: raw.length, gateCu });
  } catch (e: any) {
    ok = false; let logs: string[] = e?.logs ?? []; if (!logs.length && e?.getLogs) try { logs = (await e.getLogs(conn)) ?? []; } catch {}
    if (!logs.length && e?.signature) logs = (await conn.getTransaction(e.signature, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 }))?.meta?.logMessages ?? [];
    d = explain(logs, [e?.message, String(e)].filter(Boolean).join(' | ')); last = { logs };
  }
  return o.quiet ? { ok, d } : { ok: record(name, expectOk, ok, d, want), d };
}
/** A quiet send for setup steps; throws when it fails so a broken setup stops the run at once. */
export async function must(label: string, ixs: TransactionInstruction[], signers: Keypair[], o: SendOpts = {}) {
  const r = await send(label, true, ixs, signers, undefined, { ...o, quiet: true });
  if (!r.ok) { record(`setup step ${label}`, true, false, r.d); throw new Error(`setup step failed: ${label}: ${r.d}`); }
}

// ── token helpers ──────────────────────────────────────────────────────────────────────────────
export const ata = (mint: PublicKey, owner: PublicKey, prog = TOKEN_PROGRAM_ID) => getAssociatedTokenAddressSync(mint, owner, true, prog);
export const mkAta = (mint: PublicKey, owner: PublicKey, prog = TOKEN_PROGRAM_ID) => createAssociatedTokenAccountIdempotentInstruction(payer.publicKey, ata(mint, owner, prog), owner, mint, prog);
export async function mkMint(prog = TOKEN_PROGRAM_ID) {
  const k = gen();
  await must('mint', [SystemProgram.createAccount({ fromPubkey: payer.publicKey, newAccountPubkey: k.publicKey, lamports: await getMinimumBalanceForRentExemptMint(conn), space: MINT_SIZE, programId: prog }),
    createInitializeMint2Instruction(k.publicKey, 6, payer.publicKey, null, prog)], [k]);
  return k.publicKey;
}
export const acct = (a: PublicKey, prog = TOKEN_PROGRAM_ID) => getAccount(conn, a, 'confirmed', prog);
export const bal = async (a: PublicKey, prog = TOKEN_PROGRAM_ID) => (await acct(a, prog)).amount;
export const fmt = (n: bigint) => (Number(n) / 1e6).toString();
export const info = async (a: PublicKey, prog = TOKEN_PROGRAM_ID) => {
  const x = await acct(a, prog);
  return `${fmt(x.amount)} owner ${x.owner.toBase58().slice(0, 6)} delegate ${x.delegate?.toBase58().slice(0, 6) ?? '-'} ${fmt(x.delegatedAmount)} closer ${x.closeAuthority?.toBase58().slice(0, 6) ?? '-'}`;
};
/** A token account at a fresh keypair address (not an associated account) with `owner` as owner, funded with `amount` whole tokens. `closeAuth` sets a close authority (a key) before any hand-over. */
export async function mkAcct(mint: PublicKey, owner: PublicKey, o: { prog?: PublicKey; amount?: bigint; extra?: number; closeAuth?: PublicKey; signer?: Keypair } = {}) {
  const prog = o.prog ?? TOKEN_PROGRAM_ID, k = gen();
  await must('account', [SystemProgram.createAccount({ fromPubkey: payer.publicKey, newAccountPubkey: k.publicKey, lamports: (await conn.getMinimumBalanceForRentExemption(ACCOUNT_SIZE)) + (o.extra ?? 0), space: ACCOUNT_SIZE, programId: prog }),
    createInitializeAccount3Instruction(k.publicKey, mint, owner, prog),
    ...(o.amount ? [createMintToInstruction(mint, k.publicKey, payer.publicKey, o.amount * U, [], prog)] : []),
    ...(o.closeAuth ? [createSetAuthorityInstruction(k.publicKey, owner, AuthorityType.CloseAccount, o.closeAuth, [], prog)] : [])], [k, ...(o.closeAuth && o.signer ? [o.signer] : [])]);
  return k.publicKey;
}
/** Like mkAcct, but returns the keypair of the account's address (custody can open the same address again after a close). */
export async function mkAcctKp(mint: PublicKey, owner: PublicKey, o: { prog?: PublicKey; amount?: bigint; closeAuth?: PublicKey; signer?: Keypair } = {}) {
  const prog = o.prog ?? TOKEN_PROGRAM_ID, k = gen();
  await must('account', [SystemProgram.createAccount({ fromPubkey: payer.publicKey, newAccountPubkey: k.publicKey, lamports: await conn.getMinimumBalanceForRentExemption(ACCOUNT_SIZE), space: ACCOUNT_SIZE, programId: prog }),
    createInitializeAccount3Instruction(k.publicKey, mint, owner, prog),
    ...(o.amount ? [createMintToInstruction(mint, k.publicKey, payer.publicKey, o.amount * U, [], prog)] : []),
    ...(o.closeAuth ? [createSetAuthorityInstruction(k.publicKey, owner, AuthorityType.CloseAccount, o.closeAuth, [], prog)] : [])], [k, ...(o.closeAuth && o.signer ? [o.signer] : [])]);
  return k;
}
/** The owner actions on `account` signed by `by`; `owner` is the owner address (a multisig or one key, with `by` empty for a single key that signs itself). */
export function acts(account: PublicKey, owner: PublicKey, by: Keypair[], prog = TOKEN_PROGRAM_ID) {
  const s = by.map((k) => k.publicKey);
  return {
    transfer: (dst: PublicKey, n: bigint) => createTransferInstruction(account, dst, owner, n * U, s, prog),
    approve: (del: PublicKey, n: bigint) => createApproveInstruction(account, del, owner, n * U, s, prog),
    revoke: () => createRevokeInstruction(account, owner, s, prog),
    close: (dst: PublicKey) => createCloseAccountInstruction(account, dst, owner, s, prog),
    setOwner: (to: PublicKey) => createSetAuthorityInstruction(account, owner, AuthorityType.AccountOwner, to, s, prog),
    setCloser: (to: PublicKey | null) => createSetAuthorityInstruction(account, owner, AuthorityType.CloseAccount, to, s, prog),
  };
}
export const MISSING = /token(2022)?: missing required signature for instruction/, OWNER_MISMATCH = /token(2022)?: custom program error: 0x4\b/;
export async function mkMs(label: string, signers: PublicKey[], mm: number, prog = TOKEN_PROGRAM_ID, expectOk = true, want?: RegExp, cost?: string) {
  const k = gen();
  const r = await send(label, expectOk, [SystemProgram.createAccount({ fromPubkey: payer.publicKey, newAccountPubkey: k.publicKey, lamports: await getMinimumBalanceForRentExemptMultisig(conn), space: MULTISIG_SIZE, programId: prog }),
    createInitializeMultisigInstruction(k.publicKey, signers, mm, prog)], [k], want, { cost, quiet: label === '' });
  return { key: k.publicKey, kp: k, ok: r.ok };
}

// ── the Prime Account (Squads Smart Account) ───────────────────────────────────────────────────
export class Prime {
  settings!: PublicKey;
  constructor(public owners: Keypair[], public threshold: number, public authority: PublicKey | null = null, public timeLock = 0) {}
  vault = (i: number) => sa.getSmartAccountPda({ settingsPda: this.settings, accountIndex: i })[0];
  /** A settings change decided by two owners on the asynchronous path: create, propose and approve by `a`, approve and execute by `b`. */
  async decide(label: string, a: Keypair, b: Keypair, actions: any[]) {
    const index = BigInt((await sa.accounts.Settings.fromAccountAddress(conn, this.settings)).transactionIndex.toString()) + 1n;
    const r0 = await send(`${label}a. owner creates the settings transaction, opens the proposal and approves`, true, [ix.createSettingsTransaction({ settingsPda: this.settings, transactionIndex: index, creator: a.publicKey, rentPayer: payer.publicKey, actions }),
      ix.createProposal({ settingsPda: this.settings, transactionIndex: index, creator: a.publicKey, rentPayer: payer.publicKey }), ix.approveProposal({ settingsPda: this.settings, transactionIndex: index, signer: a.publicKey })], [a]);
    const r1 = await send(`${label}b. second owner approves and executes`, true, [ix.approveProposal({ settingsPda: this.settings, transactionIndex: index, signer: b.publicKey }),
      ix.executeSettingsTransaction({ settingsPda: this.settings, transactionIndex: index, signer: b.publicKey, rentPayer: payer.publicKey, policies: [] })], [b]);
    return r0.ok && r1.ok;
  }
  /** Retries when another process took the next account index first. */
  async create() {
    for (let attempt = 0; attempt < 30; attempt++) {
      const pc = await sa.accounts.ProgramConfig.fromAccountAddress(conn, sa.getProgramConfigPda({})[0]);
      this.settings = sa.getSettingsPda({ accountIndex: BigInt(pc.smartAccountIndex.toString()) + 1n })[0];
      const r = await send('', true, [ix.createSmartAccount({ treasury: pc.treasury, creator: payer.publicKey, settings: this.settings, settingsAuthority: this.authority, threshold: this.threshold, timeLock: this.timeLock, rentCollector: null,
        signers: this.owners.map((k) => ({ key: k.publicKey, permissions: { mask: 7 } })) })], [], undefined, { quiet: true, cost: 'create Prime Account (Squads, 3 owners)' });
      if (r.ok) return this;
      await sleep(150 + Math.random() * 500);
    }
    throw new Error('could not create the Prime Account');
  }
}
export const AL = 1, OL = 3;   // the agent lane and the owners lane: vault indexes of their own; vault 0 stays free for session rules
const details = (prime: Prime, i: number, instrs: TransactionInstruction[]) => sa.utils.instructionsToSynchronousTransactionDetailsV2({ vaultPda: prime.vault(i), members: [], transaction_instructions: instrs });
const asMeta = (ks: Keypair[]) => ks.map((k) => m(k.publicKey, true));
/** The owners at their approval count sign as vault `i` (synchronous settings consensus). */
export function viaOwners(prime: Prime, signers: Keypair[], i: number, instrs: TransactionInstruction[]) {
  const d = details(prime, i, instrs);
  return ix.executeTransactionSyncV2({ settingsPda: prime.settings, accountIndex: i, numSigners: signers.length, instructions: d.instructions, instruction_accounts: [...asMeta(signers), ...d.accounts] });
}
/** The agent: the rule's policy signers sign, Squads checks the rule and signs as vault `i`. `indices`: the constraint each inner instruction claims. */
export function viaPolicy(prime: Prime, policy: PublicKey, signers: (Keypair | { publicKey: PublicKey })[], instrs: TransactionInstruction[], indices: number[] | null, i = AL) {
  const d = details(prime, i, instrs);
  return ix.executePolicyPayloadSync({ policy, accountIndex: i, numSigners: signers.length, instruction_accounts: [...signers.map((k) => m(k.publicKey, true)), ...d.accounts],
    policyPayload: { __kind: 'ProgramInteraction', fields: [{ instructionConstraintIndices: indices === null ? null : new Uint8Array(indices),
      transactionPayload: { __kind: 'SyncTransaction', fields: [{ accountIndex: i, instructions: d.instructions }] } }] } as any });
}
export const D = sa.generated.DataOperator;
export const dc = (kind: 'U8' | 'U32Le' | 'U64Le' | 'U8Slice', off: number, v: number | bigint | Uint8Array, op: any) => ({ dataOffset: off, dataValue: { __kind: kind, fields: [typeof v === 'bigint' ? Number(v) : v] }, operator: op });
export const pin = (idx: number, ...k: PublicKey[]) => ({ accountIndex: idx, accountConstraint: { __kind: 'Pubkey', fields: [k] }, owner: null });
/** The owners (two of three, synchronous settings path) install an agent or recovery rule: a ProgramInteraction policy at `lane`. */
export async function installRule(label: string, prime: Prime, constraints: any[], signers: { key: PublicKey; permissions: { mask: number } }[], threshold: number, o: { timeLock?: number; expiresAt?: number; lane?: number } = {}) {
  const seed = Number((await sa.accounts.Settings.fromAccountAddress(conn, prime.settings)).policySeed ?? 0) + 1;
  const policy = sa.getPolicyPda({ settingsPda: prime.settings, policySeed: seed })[0];
  const body = { __kind: 'ProgramInteraction', fields: [{ accountIndex: o.lane ?? AL, preHook: null, postHook: null, spendingLimits: [], instructionsConstraints: constraints }] };
  const i = ix.executeSettingsTransactionSync({ settingsPda: prime.settings, signers: [prime.owners[0].publicKey, prime.owners[1].publicKey], feePayer: payer.publicKey,
    actions: [{ __kind: 'PolicyCreate', seed, policyCreationPayload: body, signers, threshold, timeLock: o.timeLock ?? 0, startTimestamp: null, expirationArgs: o.expiresAt ? { __kind: 'Timestamp', fields: [o.expiresAt] } : null }] as any,
    remainingAccounts: [{ pubkey: policy, isSigner: false, isWritable: true }] });
  const r = await send(label, true, [i], [prime.owners[0], prime.owners[1]], undefined, { heap: true, units: 1_000_000 });
  const info = await conn.getAccountInfo(policy);
  return { policy, bytes: info?.data.length ?? 0, rent: info?.lamports ?? 0, ok: r.ok };
}
export const agentKey = (k: Keypair) => ({ key: k.publicKey, permissions: { mask: 7 } });
export const voteOnly = (k: PublicKey) => ({ key: k, permissions: { mask: 2 } });
/** A stored batch on a rule with a time lock: create, propose and approve by `creator`. `lane` is the vault the batch signs as. */
export async function store(policy: PublicKey, creator: Keypair, lane: PublicKey, instrs: TransactionInstruction[], indices: number[], laneIndex = AL) {
  const index = BigInt((await sa.accounts.Policy.fromAccountAddress(conn, policy)).transactionIndex.toString()) + 1n;
  const msg = new TransactionMessage({ payerKey: lane, recentBlockhash: PublicKey.default.toBase58(), instructions: instrs });
  const { transactionMessageBytes, compiledMessage } = sa.utils.transactionMessageToMultisigTransactionMessageBytes({ message: msg, addressLookupTableAccounts: [], smartAccountPda: lane });
  const h = compiledMessage.header, keys = compiledMessage.staticAccountKeys;
  const metas = keys.map((k, i) => ({ pubkey: k, isSigner: false, isWritable: i < h.numRequiredSignatures - h.numReadonlySignedAccounts || (i >= h.numRequiredSignatures && i < keys.length - h.numReadonlyUnsignedAccounts) }));
  const payload = { __kind: 'ProgramInteraction', fields: [{ instructionConstraintIndices: new Uint8Array(indices), transactionPayload: { __kind: 'AsyncTransaction', fields: [{ accountIndex: laneIndex, ephemeralSigners: 0, transactionMessage: transactionMessageBytes, memo: null }] } }] } as any;
  return { index, metas, ixs: [ix.createPolicyTransaction({ policy, transactionIndex: index, creator: creator.publicKey, rentPayer: payer.publicKey, accountIndex: laneIndex, policyPayload: payload }),
    ix.createProposal({ settingsPda: policy, transactionIndex: index, creator: creator.publicKey, rentPayer: payer.publicKey }), ix.approveProposal({ settingsPda: policy, transactionIndex: index, signer: creator.publicKey })] };
}
export const runStored = (policy: PublicKey, index: bigint, signer: PublicKey, metas: any[]) => ix.executePolicyTransaction({ policy, transactionIndex: index, signer, anchorRemainingAccounts: metas });
export const statusOf = async (policy: PublicKey, index: bigint) => (await sa.accounts.Proposal.fromAccountAddress(conn, sa.getProposalPda({ settingsPda: policy, transactionIndex: index })[0])).status as any;
export const propTime = async (policy: PublicKey, index: bigint) => Number((await statusOf(policy, index)).timestamp);

// ── the gate's instructions ────────────────────────────────────────────────────────────────────
export const u64 = (n: bigint) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(n); return b; };
export const u32 = (n: number) => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };
export const i64 = (n: number) => { const b = Buffer.alloc(8); b.writeBigInt64LE(BigInt(n)); return b; };
let seedCounter = 0;
/** A fresh 8-byte seed: the process id, a counter and a random tail, so parallel runs and repeated gates never share an address. */
export const newSeed = () => { const b = Buffer.alloc(8); if (DET) { b.writeUInt32BE(++seedCounter, 4); return b; } b.writeUInt16BE(process.pid & 0xffff, 0); b.writeUInt16BE(++seedCounter, 2); b.writeUInt32BE(Math.floor(Math.random() * 2 ** 32), 4); return b; };
export const gateAddr = (ms: PublicKey, settings: PublicKey, seed: Buffer, gp = GATE) => PublicKey.findProgramAddressSync([Buffer.from('gate'), ms.toBuffer(), settings.toBuffer(), seed], gp)[0];
export const capAddr = (gate: PublicKey, gp = GATE) => PublicKey.findProgramAddressSync([Buffer.from('cap'), gate.toBuffer()], gp)[0];
export type Gate = { addr: PublicKey; cap: PublicKey; ms: PublicKey; prime: Prime; seed: Buffer; gp: PublicKey };
export type CreateOpts = { seed?: Buffer; agentLane?: number; ownersLane?: number; until?: number; window?: number; recovery?: PublicKey; signer?: boolean; gate?: PublicKey; settings?: PublicKey; msAcct?: PublicKey; gp?: PublicKey; raw?: Buffer };
export const FAR = (await chainNow()) + 86_400;
/** create: `member` (a signer of the multisig `ms`) signs and pays the rent. */
export function createIx(member: PublicKey, ms: PublicKey, prime: Prime, dests: PublicKey[], o: CreateOpts = {}) {
  const gp = o.gp ?? GATE, seed = o.seed ?? Buffer.alloc(8);
  const data = o.raw ?? Buffer.concat([Buffer.from([0]), (o.recovery ?? recovery.publicKey).toBuffer(), i64(o.until ?? FAR), u32(o.window ?? 60), seed, Buffer.from([o.agentLane ?? AL, o.ownersLane ?? OL]), ...dests.map((d) => d.toBuffer())]);
  return new TransactionInstruction({ programId: gp, data, keys: [m(member, o.signer ?? true, true), m(o.gate ?? gateAddr(ms, (o.settings ?? prime.settings), seed, gp), false, true), m(o.settings ?? prime.settings), m(SYS), m(o.msAcct ?? ms)] });
}
/** Creates a gate (custody's member signs) and returns it; fails the run if the create is refused. */
export async function mkGate(ms: PublicKey, prime: Prime, dests: PublicKey[], o: CreateOpts & { member?: Keypair; label?: string; cost?: string } = {}): Promise<Gate> {
  const seed = o.seed ?? newSeed(), member = o.member ?? custody, gp = o.gp ?? GATE;
  const r = await send(o.label ?? '', true, [createIx(member.publicKey, ms, prime, dests, { ...o, seed })], [member], undefined, { quiet: !o.label, cost: o.cost });
  if (!r.ok) throw new Error(`gate create failed: ${r.d}`);
  const addr = gateAddr(ms, prime.settings, seed, gp);
  return { addr, cap: capAddr(addr, gp), ms, prime, seed, gp };
}
export type Mv = { gate: Gate; lane: PublicKey; src: PublicKey; dst: PublicKey; amount: bigint; notAfter: number; laneSigns?: boolean; tok?: PublicKey; addr?: PublicKey; cap?: PublicKey };
/** transfer: amount u64 | not_after i64. Accounts: gate, lane (signer), source, destination, token program, cap PDA. */
export const transferIx = (o: Mv) => new TransactionInstruction({ programId: o.gate.gp, data: Buffer.concat([Buffer.from([1]), u64(o.amount), i64(o.notAfter)]),
  keys: [m(o.addr ?? o.gate.addr), m(o.lane, o.laneSigns ?? true, true), m(o.src, false, true), m(o.dst, false, true), m(o.tok ?? TOKEN_PROGRAM_ID), m(o.cap ?? o.gate.cap)] });
/** allow: cap u64. Accounts: gate, source, token program, multisig, cap PDA, then the signers. */
export const allowIx = (g: Gate, src: PublicKey, cap: bigint, signers: PublicKey[], o: { tok?: PublicKey; ms?: PublicKey; capAcct?: PublicKey } = {}) => new TransactionInstruction({ programId: g.gp, data: Buffer.concat([Buffer.from([2]), u64(cap)]),
  keys: [m(g.addr), m(src, false, true), m(o.tok ?? TOKEN_PROGRAM_ID), m(o.ms ?? g.ms), m(o.capAcct ?? g.cap), ...signers.map((k) => m(k, true))] });
/** release: the new owner and close authority (32 bytes). Accounts: gate, source, token program, multisig, then the signers. */
export const releaseIx = (g: Gate, src: PublicKey, to: PublicKey, signers: PublicKey[], o: { tok?: PublicKey; ms?: PublicKey } = {}) => new TransactionInstruction({ programId: g.gp, data: Buffer.concat([Buffer.from([3]), to.toBuffer()]),
  keys: [m(g.addr), m(src, false, true), m(o.tok ?? TOKEN_PROGRAM_ID), m(o.ms ?? g.ms), ...signers.map((k) => m(k, true))] });
/** custody hands a dedicated account to the gate: close authority first, then owner, signed by the account's current owner (no close authority set) or its close authority. */
export const handOver = (g: Gate, account: PublicKey, closer: PublicKey, prog = TOKEN_PROGRAM_ID) => handOverIxs(account, closer, g.addr, prog);
/** A dedicated account of custody, funded with `amount`, handed to the gate. */
export async function mkOwned(g: Gate, mint: PublicKey, amount: bigint, o: { prog?: PublicKey; extra?: number } = {}) {
  const prog = o.prog ?? TOKEN_PROGRAM_ID, a = await mkAcct(mint, custody.publicKey, { prog, amount, extra: o.extra });
  await must('hand over', handOver(g, a, custody.publicKey, prog), [custody]);
  return a;
}
/** The multisig's threshold (custody and trustee) sets the cap. */
export const setCap = (g: Gate, src: PublicKey, cap: bigint, by: Keypair[] = [custody, trustee], tok = TOKEN_PROGRAM_ID) => must('cap', [allowIx(g, src, cap * U, by.map((k) => k.publicKey), { tok })], by);

/** Sends a signed version 0 transaction (skip preflight so a failure leaves logs on chain) and records the result. */
export async function sendV0(name: string, expectOk: boolean, vt: VersionedTransaction, o: { cost?: string; want?: RegExp } = {}) {
  let ok = true, d = '';
  try {
    const raw = vt.serialize(), sig = await conn.sendRawTransaction(raw, { skipPreflight: true }); await confirm(sig);
    const t = await conn.getTransaction(sig, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 }); d = `${t?.meta?.computeUnitsConsumed} CU, ${raw.length} B (version 0, lookup table)`;
    last = { cu: t?.meta?.computeUnitsConsumed, bytes: raw.length, logs: t?.meta?.logMessages ?? [], sig };
    if (o.cost) (costs[o.cost] ??= { samples: [] }).samples.push({ cu: t?.meta?.computeUnitsConsumed, bytes: raw.length, gateCu: 0 });
  } catch (e: any) {
    ok = false; const logs = e?.signature ? ((await conn.getTransaction(e.signature, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 }))?.meta?.logMessages ?? []) : [];
    d = explain(logs, String(e?.message ?? e)); if (process.env.GATE_DEBUG) console.log(e, logs);
  }
  return record(name, expectOk, ok, d, o.want);
}
export const E = {
  num: /ProgramInteractionInvalidNumericValue/, acct: /ProgramInteractionAccountConstraintViolated/, prog: /ProgramInteractionProgramIdMismatch/, count: /InstructionCountMismatch/,
  signers: /InvalidSignerCount/, notSigner: /NotASigner/, payload: /InvalidPayload/, lane: /gate: custom program error: 0x1\b/, dest: /gate: custom program error: 0x2\b/,
  window: /gate: custom program error: 0x4\b/, wrong: /gate: custom program error: 0x5\b/, funds: /token\w*: custom program error: 0x1\b/, t22mint: /token2022: custom program error: 0x1f\b/,
  ownerMismatch: /token\w*: custom program error: 0x4\b/, priv: /privilege escalated|MissingRequiredSignature|missing required signature/i, invalidData: /invalid instruction data/i, gateInvalid: /gate: invalid instruction data/i,
  inUse: /already in use|system: custom program error: 0x0/i,
};
export const finish = () => {
  const rows: Record<string, any> = {};
  const median = (xs: number[]) => xs.slice().sort((a, b) => a - b)[Math.floor(xs.length / 2)];
  for (const [k, v] of Object.entries(costs) as any) rows[k] = v.samples ? { cu: median(v.samples.map((x: any) => x.cu)), bytes: median(v.samples.map((x: any) => x.bytes)), gateCu: median(v.samples.map((x: any) => x.gateCu ?? 0)), n: v.samples.length } : v;
  for (const [k, v] of Object.entries(rows)) if ((costs[k] as any).samples) (costs[k] as any).median = v;
  console.log(JSON.stringify(rows, null, 1));
  const f = results.filter((r) => !r.pass); console.log(`${results.length - f.length}/${results.length} checks passed`); f.forEach((r) => console.log('FAILED', r.name, r.detail));
  save();
  return f.length;
};
export { AddressLookupTableProgram, VersionedTransaction, SystemProgram, Transaction, TransactionMessage, TransactionInstruction, Keypair, PublicKey, ComputeBudgetProgram, TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, sa, AuthorityType,
  createApproveInstruction, createCloseAccountInstruction, createMintToInstruction, createRevokeInstruction, createSetAuthorityInstruction, createTransferInstruction, createInitializeAccount3Instruction, createInitializeMultisigInstruction, ACCOUNT_SIZE, MULTISIG_SIZE };
