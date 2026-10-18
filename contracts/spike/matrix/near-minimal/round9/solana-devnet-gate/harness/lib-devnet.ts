// Devnet version of the a4-min harness library (gate-spike/a4-min/lib.ts): the same token, multisig, Prime Account and gate builders, pointed at Solana devnet.
// Differences from the local library: one RPC URL (devnet, genesis hash checked), the funded payer pays everything (no airdrops), test keys persist in secrets/flow-keys.json
// so a stopped run can be cleaned up, every confirmed transaction is logged with an explorer link, and the payer balance is checked every eight confirmations against the floor.
import {
  ComputeBudgetProgram, Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction, TransactionMessage,
} from '@solana/web3.js';
import * as sa from '@sqds/smart-account';
import {
  ACCOUNT_SIZE, AuthorityType, MULTISIG_SIZE, TOKEN_PROGRAM_ID, createApproveInstruction, createAssociatedTokenAccountIdempotentInstruction, createCloseAccountInstruction,
  createInitializeAccount3Instruction, createInitializeMint2Instruction, createInitializeMultisigInstruction, createMintToInstruction, createRevokeInstruction, createSetAuthorityInstruction,
  createTransferInstruction, getAccount, getAssociatedTokenAddressSync, getMinimumBalanceForRentExemptMint, getMinimumBalanceForRentExemptMultisig, MINT_SIZE,
} from '@solana/spl-token';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { conn, payer, sleep, logTx, LOGDIR, SOL } from './dev.ts';
import { handOverIxs } from './setup-checks.ts';

export { conn, payer, sleep, SOL };
export const here = new URL('.', import.meta.url).pathname;
const DEVNET_GENESIS = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';
if ((await conn.getGenesisHash()) !== DEVNET_GENESIS) throw new Error('this harness runs on Solana devnet only');
export const GATE = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(`${here}secrets/gate-program.json`, 'utf8')))).publicKey;
if (!(await conn.getAccountInfo(GATE))?.executable) throw new Error(`the gate ${GATE.toBase58()} is not deployed on devnet`);
export const SQUADS = new PublicKey('SMRTzfY6DfH5ik3TKiyLFfXexV8uSG3d2UksSCYdunG');
export const U = 1_000_000n;
export const SYS = SystemProgram.programId;
export const FLOOR = 0.05 * SOL;
export const st: any = {}; export const results: any[] = [];
const STATE = `${LOGDIR}/state-gate-devnet.json`;
export const save = () => writeFileSync(STATE, JSON.stringify({ ...st, gate: GATE.toBase58(), results }, null, 1));
const NAMES: Record<string, string> = { [GATE.toBase58()]: 'gate', [TOKEN_PROGRAM_ID.toBase58()]: 'token', [SQUADS.toBase58()]: 'squads', '11111111111111111111111111111111': 'system' };
export function record(name: string, expectOk: boolean, ok: boolean, detail: string, want?: RegExp) {
  const pass = ok === expectOk && (ok || !want || want.test(detail)); results.push({ name, pass, ok, detail }); save();
  console.log(`${pass ? 'PASS' : 'FAIL'} ${name} | ${ok ? `ok ${detail}` : `refused: ${detail}`}`);
  return pass;
}
export const check = (name: string, cond: boolean, detail = '') => record(name, true, cond, detail);
export function explain(logs: string[], fallback: string) {
  const f = logs.find((l) => /Program \S+ failed:/.test(l));
  const esc = logs.find((l) => /signer privilege escalated|writable privilege escalated|Unknown program|already in use|reentrancy|already borrowed/i.test(l));
  if (!f) return (esc ?? fallback).slice(0, 220);
  const m = f.match(/Program (\S+) failed: (.*)$/)!; const code = logs.map((l) => l.match(/Error Code: (\w+)/)?.[1]).find(Boolean);
  return `${NAMES[m[1]] ?? m[1].slice(0, 6)}: ${code ?? m[2]}${esc && !code ? ` (${esc.replace(/^Program log: /, '').slice(0, 90)})` : ''}`;
}
let tick = 0;
async function floorGuard() {
  if (++tick % 8) return;
  const bal = await conn.getBalance(payer.publicKey);
  if (bal < FLOOR) { save(); console.error(`STOP: the payer holds ${bal / SOL} SOL, below the 0.05 SOL floor`); process.exit(3); }
}
export async function confirm(sig: string) {
  for (let i = 0; i < 180; i++) {
    const s = (await conn.getSignatureStatus(sig, { searchTransactionHistory: true })).value;
    if (s?.err) throw Object.assign(new Error(JSON.stringify(s.err)), { signature: sig });
    if (s?.confirmationStatus === 'confirmed' || s?.confirmationStatus === 'finalized') { await floorGuard(); return sig; }
    await sleep(600);
  }
  throw new Error(`${sig} not confirmed after about 100 s`);
}
export const chainNow = async (): Promise<number> => { for (let i = 0; i < 40; i++) { try { return (await conn.getBlockTime(await conn.getSlot('confirmed')))!; } catch { await sleep(500); } } throw new Error('block time unavailable'); };
export const later = async (s = 45) => (await chainNow()) + s;

// ── keys: persisted so a stopped run can be cleaned up ─────────────────────────────────────────
const KEYS = `${here}secrets/flow-keys.json`;
const names = ['custody', 'backup', 'trustee', 'stranger', 'newKey', 'agent', 'owner0', 'owner1', 'owner2', 'other'];
if (!existsSync(KEYS)) writeFileSync(KEYS, JSON.stringify(Object.fromEntries(names.map((n) => [n, Array.from(Keypair.generate().secretKey)]))), { mode: 0o600 });
const stored = JSON.parse(readFileSync(KEYS, 'utf8'));
const key = (n: string) => Keypair.fromSecretKey(Uint8Array.from(stored[n]));
export const custody = key('custody'), backup = key('backup'), trustee = key('trustee'), stranger = key('stranger'), newKey = key('newKey'), agent = key('agent'), other = key('other');
export const owners = [key('owner0'), key('owner1'), key('owner2')];
export const ix = sa.instructions;
export const m = (pubkey: PublicKey, isSigner = false, isWritable = false) => ({ pubkey, isSigner, isWritable });

// ── sending ────────────────────────────────────────────────────────────────────────────────────
export let last: { cu?: number; bytes?: number; logs: string[]; sig?: string } = { logs: [] };
export type SendOpts = { quiet?: boolean; units?: number; heap?: boolean };
/** One transaction, fee payer = payer. A refused one fails in the preflight simulation and carries no signature; a confirmed one is logged with its explorer link. */
export async function send(name: string, expectOk: boolean, ixs: TransactionInstruction[], signers: Keypair[], want?: RegExp, o: SendOpts = {}) {
  let ok = true, d = '';
  try {
    const pre = [...(o.units ? [ComputeBudgetProgram.setComputeUnitLimit({ units: o.units })] : []), ...(o.heap ? [ComputeBudgetProgram.requestHeapFrame({ bytes: 262_144 })] : [])];
    const t = new Transaction().add(...pre, ...ixs); t.feePayer = payer.publicKey; t.recentBlockhash = (await conn.getLatestBlockhash('confirmed')).blockhash;
    t.sign(payer, ...signers.filter((k) => !k.publicKey.equals(payer.publicKey)));
    const raw = t.serialize(); const sig = await conn.sendRawTransaction(raw); await confirm(sig);
    const tx = await conn.getTransaction(sig, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 });
    d = `${tx?.meta?.computeUnitsConsumed} CU, ${raw.length} B, fee ${tx?.meta?.fee}`; last = { cu: tx?.meta?.computeUnitsConsumed, bytes: raw.length, logs: tx?.meta?.logMessages ?? [], sig };
    logTx(name || 'setup step', sig);
  } catch (e: any) {
    ok = false; let logs: string[] = e?.logs ?? []; if (!logs.length && e?.getLogs) try { logs = (await e.getLogs(conn)) ?? []; } catch {}
    d = explain(logs, [e?.message, String(e)].filter(Boolean).join(' | ')); last = { logs };
  }
  return o.quiet ? { ok, d } : { ok: record(name, expectOk, ok, d, want), d };
}
export async function must(label: string, ixs: TransactionInstruction[], signers: Keypair[], o: SendOpts = {}) {
  const r = await send(label, true, ixs, signers, undefined, { ...o, quiet: true });
  if (!r.ok) throw new Error(`setup step failed: ${label}: ${r.d}`);
}
export const fundFromPayer = (to: PublicKey, lamports: number, label: string) => must(label, [SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: to, lamports })], []);

// ── token helpers ──────────────────────────────────────────────────────────────────────────────
export const ata = (mint: PublicKey, owner: PublicKey, prog = TOKEN_PROGRAM_ID) => getAssociatedTokenAddressSync(mint, owner, true, prog);
export const mkAta = (mint: PublicKey, owner: PublicKey, prog = TOKEN_PROGRAM_ID) => createAssociatedTokenAccountIdempotentInstruction(payer.publicKey, ata(mint, owner, prog), owner, mint, prog);
/** A classic Token mint with 6 decimals, the payer as mint authority and no freeze authority. */
export async function mkMint(address: Keypair = Keypair.generate()) {
  await must('create the mint (classic Token, 6 decimals, no freeze authority)', [SystemProgram.createAccount({ fromPubkey: payer.publicKey, newAccountPubkey: address.publicKey, lamports: await getMinimumBalanceForRentExemptMint(conn), space: MINT_SIZE, programId: TOKEN_PROGRAM_ID }),
    createInitializeMint2Instruction(address.publicKey, 6, payer.publicKey, null, TOKEN_PROGRAM_ID)], [address]);
  return address.publicKey;
}
export const acct = (a: PublicKey) => getAccount(conn, a, 'confirmed', TOKEN_PROGRAM_ID);
export const bal = async (a: PublicKey) => (await acct(a)).amount;
export const fmt = (n: bigint) => (Number(n) / 1e6).toString();
export const info = async (a: PublicKey) => {
  const x = await acct(a);
  return `${fmt(x.amount)} owner ${x.owner.toBase58().slice(0, 6)} delegate ${x.delegate?.toBase58().slice(0, 6) ?? '-'} ${fmt(x.delegatedAmount)} closer ${x.closeAuthority?.toBase58().slice(0, 6) ?? '-'}`;
};
/** A token account at a fresh keypair address with `owner` as owner, funded with `amount` whole tokens; `closeAuth` sets a close authority first. */
export async function mkAcct(mint: PublicKey, owner: PublicKey, o: { amount?: bigint; closeAuth?: PublicKey; signer?: Keypair; label?: string } = {}) {
  const k = Keypair.generate();
  await must(o.label ?? 'create a token account', [SystemProgram.createAccount({ fromPubkey: payer.publicKey, newAccountPubkey: k.publicKey, lamports: await conn.getMinimumBalanceForRentExemption(ACCOUNT_SIZE), space: ACCOUNT_SIZE, programId: TOKEN_PROGRAM_ID }),
    createInitializeAccount3Instruction(k.publicKey, mint, owner, TOKEN_PROGRAM_ID),
    ...(o.amount ? [createMintToInstruction(mint, k.publicKey, payer.publicKey, o.amount * U, [], TOKEN_PROGRAM_ID)] : []),
    ...(o.closeAuth ? [createSetAuthorityInstruction(k.publicKey, owner, AuthorityType.CloseAccount, o.closeAuth, [], TOKEN_PROGRAM_ID)] : [])], [k, ...(o.closeAuth && o.signer ? [o.signer] : [])]);
  return k.publicKey;
}
/** The owner actions on `account` signed by `by` (the owner address is a key, or a multisig with `by` as its signers). */
export function acts(account: PublicKey, owner: PublicKey, by: Keypair[]) {
  const s = by.map((k) => k.publicKey);
  return {
    transfer: (dst: PublicKey, n: bigint) => createTransferInstruction(account, dst, owner, n * U, s),
    approve: (del: PublicKey, n: bigint) => createApproveInstruction(account, del, owner, n * U, s),
    revoke: () => createRevokeInstruction(account, owner, s),
    close: (dst: PublicKey) => createCloseAccountInstruction(account, dst, owner, s),
    setOwner: (to: PublicKey) => createSetAuthorityInstruction(account, owner, AuthorityType.AccountOwner, to, s),
    setCloser: (to: PublicKey | null) => createSetAuthorityInstruction(account, owner, AuthorityType.CloseAccount, to, s),
  };
}
export const OWNER_MISMATCH = /token: custom program error: 0x4\b/;
export async function mkMs(label: string, signers: PublicKey[], mm: number, expectOk = true, want?: RegExp) {
  const k = Keypair.generate();
  const r = await send(label, expectOk, [SystemProgram.createAccount({ fromPubkey: payer.publicKey, newAccountPubkey: k.publicKey, lamports: await getMinimumBalanceForRentExemptMultisig(conn), space: MULTISIG_SIZE, programId: TOKEN_PROGRAM_ID }),
    createInitializeMultisigInstruction(k.publicKey, signers, mm, TOKEN_PROGRAM_ID)], [k], want, { quiet: label === '' });
  return { key: k.publicKey, kp: k, ok: r.ok };
}

// ── the Prime Account (Squads Smart Account) ───────────────────────────────────────────────────
export class Prime {
  settings!: PublicKey;
  constructor(public owners: Keypair[], public threshold: number, public authority: PublicKey | null = null, public timeLock = 0) {}
  vault = (i: number) => sa.getSmartAccountPda({ settingsPda: this.settings, accountIndex: i })[0];
  /** Retries when another creator on the public Squads program took the next account index first. */
  async create(label: string) {
    for (let attempt = 0; attempt < 12; attempt++) {
      const pc = await sa.accounts.ProgramConfig.fromAccountAddress(conn, sa.getProgramConfigPda({})[0]);
      this.settings = sa.getSettingsPda({ accountIndex: BigInt(pc.smartAccountIndex.toString()) + 1n })[0];
      const r = await send(label, true, [ix.createSmartAccount({ treasury: pc.treasury, creator: payer.publicKey, settings: this.settings, settingsAuthority: this.authority, threshold: this.threshold, timeLock: this.timeLock, rentCollector: null,
        signers: this.owners.map((k) => ({ key: k.publicKey, permissions: { mask: 7 } })) })], [], undefined, { quiet: true });
      if (r.ok) return this;
      console.log(`create attempt ${attempt + 1} failed (${r.d}), retrying`); await sleep(500 + Math.random() * 1500);
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
/** The owners (two of three, synchronous settings path) install an agent rule: a ProgramInteraction policy at `lane`. */
export async function installRule(label: string, prime: Prime, constraints: any[], signers: { key: PublicKey; permissions: { mask: number } }[], threshold: number, o: { lane?: number } = {}) {
  const seed = Number((await sa.accounts.Settings.fromAccountAddress(conn, prime.settings)).policySeed ?? 0) + 1;
  const policy = sa.getPolicyPda({ settingsPda: prime.settings, policySeed: seed })[0];
  const body = { __kind: 'ProgramInteraction', fields: [{ accountIndex: o.lane ?? AL, preHook: null, postHook: null, spendingLimits: [], instructionsConstraints: constraints }] };
  const i = ix.executeSettingsTransactionSync({ settingsPda: prime.settings, signers: [prime.owners[0].publicKey, prime.owners[1].publicKey], feePayer: payer.publicKey,
    actions: [{ __kind: 'PolicyCreate', seed, policyCreationPayload: body, signers, threshold, timeLock: 0, startTimestamp: null, expirationArgs: null }] as any,
    remainingAccounts: [{ pubkey: policy, isSigner: false, isWritable: true }] });
  const r = await send(label, true, [i], [prime.owners[0], prime.owners[1]], undefined, { heap: true, units: 1_000_000 });
  const info = await conn.getAccountInfo(policy);
  return { policy, bytes: info?.data.length ?? 0, rent: info?.lamports ?? 0, ok: r.ok };
}
export const agentKey = (k: Keypair) => ({ key: k.publicKey, permissions: { mask: 7 } });

// ── the gate's instructions ────────────────────────────────────────────────────────────────────
export const u64 = (n: bigint) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(n); return b; };
export const u32 = (n: number) => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };
export const i64 = (n: number) => { const b = Buffer.alloc(8); b.writeBigInt64LE(BigInt(n)); return b; };
let seedCounter = 0;
export const newSeed = () => { const b = Buffer.alloc(8); b.writeUInt16BE(process.pid & 0xffff, 0); b.writeUInt16BE(++seedCounter, 2); b.writeUInt32BE(Math.floor(Math.random() * 2 ** 32), 4); return b; };
export const gateAddr = (ms: PublicKey, settings: PublicKey, seed: Buffer) => PublicKey.findProgramAddressSync([Buffer.from('gate'), ms.toBuffer(), settings.toBuffer(), seed], GATE)[0];
export const capAddr = (gate: PublicKey) => PublicKey.findProgramAddressSync([Buffer.from('cap'), gate.toBuffer()], GATE)[0];
export type Gate = { addr: PublicKey; cap: PublicKey; ms: PublicKey; prime: Prime; seed: Buffer };
export type CreateOpts = { seed?: Buffer; agentLane?: number; ownersLane?: number; until?: number; window?: number; recovery: PublicKey; signer?: boolean; gate?: PublicKey; raw?: Buffer };
/** create: `member` (a signer of the multisig `ms`) signs and pays the rent. */
export function createIx(member: PublicKey, ms: PublicKey, prime: Prime, dests: PublicKey[], o: CreateOpts, until: number) {
  const seed = o.seed ?? Buffer.alloc(8);
  const data = o.raw ?? Buffer.concat([Buffer.from([0]), o.recovery.toBuffer(), i64(o.until ?? until), u32(o.window ?? 60), seed, Buffer.from([o.agentLane ?? AL, o.ownersLane ?? OL]), ...dests.map((d) => d.toBuffer())]);
  return new TransactionInstruction({ programId: GATE, data, keys: [m(member, o.signer ?? true, true), m(o.gate ?? gateAddr(ms, prime.settings, seed), false, true), m(prime.settings), m(SYS), m(ms)] });
}
export type Mv = { gate: Gate; lane: PublicKey; src: PublicKey; dst: PublicKey; amount: bigint; notAfter: number; laneSigns?: boolean; tok?: PublicKey; addr?: PublicKey; cap?: PublicKey };
/** transfer: amount u64 | not_after i64. Accounts: gate, lane (signer), source, destination, token program, cap PDA. */
export const transferIx = (o: Mv) => new TransactionInstruction({ programId: GATE, data: Buffer.concat([Buffer.from([1]), u64(o.amount), i64(o.notAfter)]),
  keys: [m(o.addr ?? o.gate.addr), m(o.lane, o.laneSigns ?? true, true), m(o.src, false, true), m(o.dst, false, true), m(o.tok ?? TOKEN_PROGRAM_ID), m(o.cap ?? o.gate.cap)] });
/** allow: cap u64. Accounts: gate, source, token program, multisig, cap PDA, then the signers. */
export const allowIx = (g: Gate, src: PublicKey, cap: bigint, signers: PublicKey[]) => new TransactionInstruction({ programId: GATE, data: Buffer.concat([Buffer.from([2]), u64(cap)]),
  keys: [m(g.addr), m(src, false, true), m(TOKEN_PROGRAM_ID), m(g.ms), m(g.cap), ...signers.map((k) => m(k, true))] });
/** release: the new owner and close authority (32 bytes). Accounts: gate, source, token program, multisig, then the signers. */
export const releaseIx = (g: Gate, src: PublicKey, to: PublicKey, signers: PublicKey[]) => new TransactionInstruction({ programId: GATE, data: Buffer.concat([Buffer.from([3]), to.toBuffer()]),
  keys: [m(g.addr), m(src, false, true), m(TOKEN_PROGRAM_ID), m(g.ms), ...signers.map((k) => m(k, true))] });
/** custody hands a dedicated account to the gate: close authority first, then owner. */
export const handOver = (g: Gate, account: PublicKey, closer: PublicKey) => handOverIxs(account, closer, g.addr, TOKEN_PROGRAM_ID);

export const E = {
  num: /ProgramInteractionInvalidNumericValue/, acct: /ProgramInteractionAccountConstraintViolated/, prog: /ProgramInteractionProgramIdMismatch/, count: /InstructionCountMismatch/,
  signers: /InvalidSignerCount/, lane: /gate: custom program error: 0x1\b/, dest: /gate: custom program error: 0x2\b/,
  window: /gate: custom program error: 0x4\b/, wrong: /gate: custom program error: 0x5\b/, funds: /token\w*: custom program error: 0x1\b/,
  ownerMismatch: /token\w*: custom program error: 0x4\b/, priv: /privilege escalated|MissingRequiredSignature|missing required signature/i, invalidData: /invalid instruction data/i, gateInvalid: /gate: invalid instruction data/i,
  inUse: /already in use|system: custom program error: 0x0/i, rule: /ProgramInteraction/,
};
export const finish = () => {
  const f = results.filter((r) => !r.pass); console.log(`${results.length - f.length}/${results.length} checks passed`); f.forEach((r) => console.log('FAILED', r.name, r.detail));
  save();
  return f.length;
};
export { Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction, TransactionMessage, TOKEN_PROGRAM_ID, sa, AuthorityType, createMintToInstruction, createCloseAccountInstruction, createTransferInstruction, createInitializeAccount3Instruction, createInitializeMint2Instruction, ACCOUNT_SIZE, MINT_SIZE };
