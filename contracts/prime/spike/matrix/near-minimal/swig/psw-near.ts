// Freighter-only run of psw.ts with the real NEAR MPC (short, so the NEAR lock is held for about a minute). Generated from psw.ts.
// Swig as the Solana session layer for a Prime Account (Squads Smart Account), on a local validator cloned from devnet (port 8919).
//   seats (settings signers, 2-of-3, plain keys): MetaMask seat = B, Freighter seat = C, Phantom's own key. Swig is never a settings signer.
//   one Swig wallet per wallet per Prime Account; the Swig wallet ADDRESS is the Squads policy signer (policy threshold 1).
//   Swig roles: 0 = admin (ManageAuthority only; here the Smart Account vault, so the 2-of-3 administers the Swig),
//               1 = the owner's session authority, may call the Smart Account program only, sessions of at most MAX_SLOTS slots.
//   owners: MetaMask secp256k1 (personal_sign, native), MetaMask native Solana account (ed25519), Phantom (ed25519 tx signature),
//           Freighter (NEAR MPC ed25519 key under prime:solana-session; PSW_NEAR=1 signs through NEAR, else a local stand-in key).
// Run from /home/ubuntu/work/swig-spike:  bun psw.ts   (PSW_NEAR=1 under flock /home/ubuntu/work/prime-refine/near.lock)
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram, Transaction, TransactionInstruction, TransactionMessage } from '@solana/web3.js';
import * as sa from '@sqds/smart-account';
import { Actions, updateAuthorityAddActions, createEd25519AuthorityInfo, createEd25519SessionAuthorityInfo, createSecp256k1AuthorityInfo, createSecp256k1SessionAuthorityInfo, fetchSwig,
  findSwigPda, getAddAuthorityInstructions, getCreateSessionInstructions, getCreateSwigInstruction, getCreateSwigInstructionBuilder, getRemoveAuthorityInstructions, getSignInstructions,
  getUpdateAuthorityInstructions, getEvmPersonalSignPrefix } from '@swig-wallet/classic';
import { MINT_SIZE, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID, createInitializeMint2Instruction, createMintToInstruction, createAssociatedTokenAccountIdempotentInstruction, createTransferInstruction,
  createApproveInstruction, getAssociatedTokenAddressSync, getAccount } from '@solana/spl-token';
import { hexToBytes, sha256 as vsha256 } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import { readFileSync, writeFileSync } from 'node:fs';
import { payer, B, C, phantom, metamask } from './keys.ts';

process.on('uncaughtException', (e: any) => { console.log('UNCAUGHT', e?.stack ?? e); process.exit(1); });
const RPC = process.env.PSW_RPC ?? 'http://127.0.0.1:8919';
const LABEL = process.env.PSW_LABEL ?? 'devnet-build';
const NEAR = true;
const MAX_SLOTS = BigInt(process.env.PSW_MAX_SLOTS ?? 1_512_000);
const STATE = process.env.PSW_STATE ?? `/home/ubuntu/work/prime-refine/logs/swig/state-psw-${LABEL}.json`;
const conn = new Connection(RPC, { commitment: 'confirmed', confirmTransactionInitialTimeout: 120_000 });
const SWIG = new PublicKey('swigypWHEksbC64pWKwah1WTeh9JXwx8H1rJHLdbQMB');
const SQUADS = sa.PROGRAM_ID;
const SOL = LAMPORTS_PER_SOL;
const ix = sa.instructions;
const ALL = { mask: 7 };
const ERR: Record<string, string> = JSON.parse(readFileSync('/home/ubuntu/work/swig-spike/psw-errors.json', 'utf8'));
const st: any = {}; const results: any[] = []; const metrics: any = {};
const save = () => writeFileSync(STATE, JSON.stringify({ label: LABEL, ...st, metrics, results }, null, 1));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const VENUE = Keypair.generate().publicKey, OTHER = Keypair.generate().publicKey, DEST = Keypair.generate().publicKey;

// ── errors, results, sending ────────────────────────────────────────────────────────────────────
const short = (e: any) => {
  const s = [e?.logs?.join(' '), e?.message, String(e)].filter(Boolean).join(' | ');
  const sw = s.match(/Program swigypWHEksbC64pWKwah1WTeh9JXwx8H1rJHLdbQMB failed: custom program error: 0x([0-9a-f]+)/i) ?? s.match(/custom program error: 0x([0-9a-f]+)/i);
  const anchor = s.match(/Error Code: (\w+)/);
  if (anchor && !/swigyp[^|]*failed/.test(s.slice(0, 0))) { const swFirst = sw && s.indexOf(sw[0]) < s.indexOf(anchor[0]); if (!swFirst) return anchor[0]; }
  if (sw) { const code = parseInt(sw[1]!, 16); return `Swig ${ERR[String(code)] ?? 'code'} (${code})`; }
  return (s.match(/(Signature verification failed|Transaction did not pass signature verification|already been processed|insufficient funds|Attempt to debit[^"]{0,40}|InsufficientFundsForRent|[A-Za-z]+Error[^"]{0,60})/i)?.[0] ?? s).slice(0, 170);
};
function record(name: string, expectOk: boolean, ok: boolean, detail: string, want?: RegExp) {
  const pass = ok === expectOk && (ok || !want || want.test(detail)); results.push({ name, pass, ok, detail }); save();
  console.log(`${pass ? 'PASS' : 'FAIL'} ${name} | ${ok ? `ok ${detail}` : `refused: ${detail}`}`);
  return ok;
}
async function confirm(sig: string) {
  for (let i = 0; i < 180; i++) {
    const s = (await conn.getSignatureStatus(sig, { searchTransactionHistory: true })).value;
    if (s?.err) throw Object.assign(new Error(JSON.stringify(s.err)), { signature: sig });
    if (s?.confirmationStatus === 'confirmed' || s?.confirmationStatus === 'finalized') return sig;
    await sleep(250);
  }
  throw new Error(`${sig} not confirmed`);
}
let last = { sig: '', bytes: 0, ms: 0 };
type Ext = { pub: PublicKey; sign: (m: Uint8Array) => Promise<Uint8Array> };
/** Builds, signs, sends and confirms one transaction. signers[0] is the fee payer unless `feePayer` is given; `ext` are external ed25519 signers (an owner that signs the message). */
async function attempt(ixs: TransactionInstruction[], signers: Keypair[], o: { ext?: Ext[]; feePayer?: PublicKey } = {}): Promise<{ ok: boolean; detail: string }> {
  const t0 = Date.now();
  try {
    const tx = new Transaction().add(...ixs); tx.feePayer = o.feePayer ?? signers[0]!.publicKey; tx.recentBlockhash = (await conn.getLatestBlockhash('confirmed')).blockhash;
    for (const e of o.ext ?? []) tx.addSignature(e.pub, Buffer.from(await e.sign(tx.serializeMessage())));
    tx.partialSign(...signers);
    last = { sig: '', bytes: tx.serialize().length, ms: 0 };
    const sig = await conn.sendRawTransaction(tx.serialize()); await confirm(sig); last.sig = sig; last.ms = Date.now() - t0;
    return { ok: true, detail: `${sig.slice(0, 12)}…` };
  } catch (e: any) {
    let d = short(e); let logs: string[] = [];
    if (e?.getLogs) try { const l = await e.getLogs(conn); if (Array.isArray(l)) logs = l; } catch {}
    if (!logs.length && e?.signature) try { logs = (await conn.getTransaction(e.signature, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 }))?.meta?.logMessages ?? []; } catch {}
    if (logs.length) d = short({ logs, message: e?.message });
    if (/^SendTransactionError|\[object Object\]|^Simulation failed/.test(d) && logs.length) d = logs.filter((l) => /failed|Error|error|insufficient/i.test(l)).slice(-2).join(' | ').slice(0, 200) || d;
    if (process.env.PSW_DEBUG) console.log(logs.map((l) => `      ${l}`).join('\n'));
    return { ok: false, detail: d };
  }
}
/** One transaction with an expected outcome. */
async function send(name: string, expectOk: boolean, ixs: TransactionInstruction[], signers: Keypair[], o: { want?: RegExp; ext?: Ext[]; feePayer?: PublicKey } = {}) {
  const r = await attempt(ixs, signers, o);
  return record(name, expectOk, r.ok, r.detail, o.want);
}
/** Compute units, fee and per-program shares of the last transaction sent by `send`. */
async function measure(label: string) {
  if (!last.sig) return null;
  const t = await conn.getTransaction(last.sig, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 });
  const logs = t?.meta?.logMessages ?? [];
  const share = (p: PublicKey) => logs.map((l) => l.match(new RegExp(`^Program ${p.toBase58()} consumed (\\d+) of`))).filter(Boolean).map((m) => Number(m![1]));
  metrics[label] = { totalCu: t?.meta?.computeUnitsConsumed, swigCu: share(SWIG)[0], squadsCu: share(SQUADS)[0], bytes: last.bytes, fee: t?.meta?.fee, ms: last.ms };
  console.log(`METRIC ${label} ${JSON.stringify(metrics[label])}`); save();
  return metrics[label];
}
let fundCount = 0;
async function fund(to: PublicKey, lamports: number) { fundCount++; await confirm(await conn.requestAirdrop(to, lamports)); }
const slotNow = async () => BigInt(await conn.getSlot('confirmed'));
const WANT = (n: string | number) => new RegExp(typeof n === 'number' ? `\\(${n}\\)` : n);   // Swig error by name or code
const code = (n: string) => Number(Object.entries(ERR).find(([, v]) => v === n)![0]);
const SW = { MissingPermission: code('PermissionDeniedMissingPermission'), ToManageAuthority: code('PermissionDeniedToManageAuthority'), Expired: code('PermissionDeniedSessionExpired'), SigInvalid: code('PermissionDeniedSecp256k1InvalidSignature'),
  SigReused: code('PermissionDeniedSecp256k1SignatureReused'), InvalidDuration: code('InvalidSessionDuration') };

// ── Wallets ─────────────────────────────────────────────────────────────────────────────────────
type Wallet = { name: string; kind: 'secp' | 'ed'; pub: Uint8Array; seat: Keypair; sign?: (m: Uint8Array) => Promise<Uint8Array>;
  swig?: PublicKey; addr?: PublicKey; id?: Uint8Array };
let mmShown = false;
const mmSign = (acct = metamask) => async (m: Uint8Array) => { if (!mmShown) { mmShown = true; metrics.metamaskPrompt = { bytes: m.length, text: Buffer.from(m).toString('utf8') }; console.log(`   MetaMask is asked to personal_sign ${m.length} bytes: "${Buffer.from(m).toString('utf8')}"`); }
  return { signature: hexToBytes(await acct.signMessage({ message: { raw: m } })), prefix: getEvmPersonalSignPrefix(m.length) }; };
const kpSign = (kp: Keypair) => async (m: Uint8Array) => nacl.sign.detached(m, kp.secretKey);
const mmSolKp = Keypair.generate();                                     // MetaMask native Solana account (stand-in: signs Solana transactions like Phantom)
let nearMod: any; let frKey: PublicKey; let frSign: (m: Uint8Array) => Promise<Uint8Array>; const frLocal = Keypair.generate();
if (NEAR) {
  nearMod = await import('/home/ubuntu/work/near-session-spike/nearsig.ts');
  frKey = new PublicKey(await nearMod.edKey('Freighter', 'prime:solana-session'));
  frSign = (m) => nearMod.edSign('Freighter', 'prime:solana-session', m);
} else { frKey = frLocal.publicKey; frSign = kpSign(frLocal); }
const otherSecp = privateKeyToAccount(generatePrivateKey());
const MM: Wallet = { name: 'MetaMask(secp256k1)', kind: 'secp', pub: hexToBytes(metamask.publicKey), seat: B };
const MMS: Wallet = { name: 'MetaMask(Solana acct)', kind: 'ed', pub: mmSolKp.publicKey.toBytes(), seat: B, sign: kpSign(mmSolKp) };
const PH: Wallet = { name: 'Phantom', kind: 'ed', pub: phantom.publicKey.toBytes(), seat: phantom, sign: kpSign(phantom) };
const FR: Wallet = { name: 'Freighter(NEAR MPC)', kind: 'ed', pub: frKey.toBytes(), seat: C, sign: frSign };
const WALLETS = [MM, MMS, PH, FR];
const ownerInfo = (w: Wallet, max: bigint) => w.kind === 'secp' ? createSecp256k1SessionAuthorityInfo(w.pub, max) : createEd25519SessionAuthorityInfo(new PublicKey(w.pub), max);
const rootInfo = (w: Wallet) => w.kind === 'secp' ? createSecp256k1AuthorityInfo(w.pub) : createEd25519AuthorityInfo(new PublicKey(w.pub));
const ownerExt = (w: Wallet): Ext[] => w.kind === 'ed' ? [{ pub: new PublicKey(w.pub), sign: w.sign! }] : [];
const squadsOnly = () => Actions.set().programLimit({ programId: SQUADS }).get();
console.log({ label: LABEL, near: NEAR, maxSlots: String(MAX_SLOTS), swig: SWIG.toBase58(), squads: SQUADS.toBase58(), freighterOwner: frKey.toBase58(), phantom: phantom.publicKey.toBase58(), mmSolana: mmSolKp.publicKey.toBase58(), metamask: metamask.address });

// ── Smart Account helpers ───────────────────────────────────────────────────────────────────────
type Acct = { settings: PublicKey; vault: PublicKey; policy?: PublicKey; tag: string };
const SEATS = [B, C, phantom];
async function createAccount(tag: string): Promise<Acct> {
  const pc = await sa.accounts.ProgramConfig.fromAccountAddress(conn, sa.getProgramConfigPda({})[0]);
  const [settings] = sa.getSettingsPda({ accountIndex: BigInt(pc.smartAccountIndex.toString()) + 1n });
  const vault = sa.getSmartAccountPda({ settingsPda: settings, accountIndex: 0 })[0];
  await send(`${tag}. Smart Account: seats B (MetaMask), C (Freighter), Phantom; threshold 2; vault funded 2 SOL`, true, [ix.createSmartAccount({ treasury: pc.treasury, creator: payer.publicKey, settings,
    settingsAuthority: null, threshold: 2, timeLock: 0, rentCollector: null, signers: SEATS.map((k) => ({ key: k.publicKey, permissions: ALL })) }),
    SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: vault, lamports: 2 * SOL })], [payer]);
  return { settings, vault, tag };
}
const sysTransfer = (a: Acct, to: PublicKey, sol: number) => SystemProgram.transfer({ fromPubkey: a.vault, toPubkey: to, lamports: Math.round(sol * SOL) });
const policyPayload = (venue = VENUE, perMove = 0.05, daily = 1): any => ({ __kind: 'ProgramInteraction', fields: [{ accountIndex: 0, preHook: null, postHook: null,
  instructionsConstraints: [{ programId: SystemProgram.programId, accountConstraints: [{ accountIndex: 1, accountConstraint: { __kind: 'Pubkey', fields: [[venue]] }, owner: null }],
    dataConstraints: [{ dataOffset: 0, dataValue: { __kind: 'U32Le', fields: [2] }, operator: sa.generated.DataOperator.Equals },
      { dataOffset: 4, dataValue: { __kind: 'U64Le', fields: [perMove * SOL] }, operator: sa.generated.DataOperator.LessThanOrEqualTo }] }],
  spendingLimits: [{ mint: PublicKey.default, timeConstraints: { start: 0, expiration: null, period: { __kind: 'Daily' } }, quantityConstraints: { maxPerPeriod: daily * SOL } }] }] });
/** The policy move: signer (a Swig wallet address) asks the policy to run `inner` from the vault. */
const policyMove = (a: Acct, signer: PublicKey, inner: TransactionInstruction, policy = a.policy!) => {
  const d = sa.utils.instructionsToSynchronousTransactionDetailsV2({ vaultPda: a.vault, members: [signer], transaction_instructions: [inner] });
  return ix.executePolicyPayloadSync({ policy, accountIndex: 0, numSigners: 1, instruction_accounts: d.accounts,
    policyPayload: { __kind: 'ProgramInteraction', fields: [{ instructionConstraintIndices: new Uint8Array([0]), transactionPayload: { __kind: 'SyncTransaction', fields: [{ accountIndex: 0, instructions: d.instructions }] } }] } });
};
/** A settings change by two seats in one transaction (synchronous settings execution). */
const settingsSync = (a: Acct, actions: any[], signers: PublicKey[], remaining: PublicKey[] = []) => ix.executeSettingsTransactionSync({ settingsPda: a.settings, signers, actions, feePayer: payer.publicKey,
  remainingAccounts: remaining.map((p) => ({ pubkey: p, isWritable: true, isSigner: false })) });
/** The vault signs `inner` (2 seats sign the transaction). */
const vaultSync = (a: Acct, seats: PublicKey[], inner: TransactionInstruction[]) => {
  const d = sa.utils.instructionsToSynchronousTransactionDetailsV2({ vaultPda: a.vault, members: seats, transaction_instructions: inner });
  return ix.executeTransactionSyncV2({ settingsPda: a.settings, numSigners: seats.length, accountIndex: 0, instructions: d.instructions, instruction_accounts: d.accounts } as any);
};
const policySeed = async (a: Acct) => Number((await sa.accounts.Settings.fromAccountAddress(conn, a.settings)).policySeed ?? 0) + 1;

// ── Swig helpers ────────────────────────────────────────────────────────────────────────────────
const swigOf = (w: Wallet) => fetchSwig(conn, w.swig!);
const walletAddress = (swig: PublicKey) => PublicKey.findProgramAddressSync([Buffer.from('swig-wallet-address'), swig.toBuffer()], SWIG)[0];
/** Swig for wallet `w`: one transaction, relayer pays, one owner signature. Role 0 = the owner (ManageAuthority only, cannot sign for the wallet address);
 *  role 1 = the owner's session authority (Smart Account program only, sessions of at most `max` slots). */
async function makeSwig(a: Acct, w: Wallet, o: { tag?: string; max?: bigint; actions?: any } = {}) {
  const tag = o.tag ?? `${a.tag}-${w.name}`; const max = o.max ?? MAX_SLOTS;
  const id = crypto.getRandomValues(new Uint8Array(32)); const swigPda = findSwigPda(id);
  const builder = getCreateSwigInstructionBuilder({ payer: payer.publicKey, swigAddress: swigPda, id, actions: Actions.set().manageAuthority().get(), authorityInfo: rootInfo(w),
    options: { currentSlot: await slotNow(), ...(w.kind === 'secp' ? { signingFn: mmSign() } : {}) } });
  builder.addAuthority(ownerInfo(w, max), o.actions ?? squadsOnly());
  await send(`${tag}: relayer creates the Swig wallet; owner root (ManageAuthority) + owner session role (Smart Account program only, max ${max} slots); one owner signature`, true,
    await builder.getInstructions(), [payer], { ext: ownerExt(w) });
  await measure('swig-setup');
  const sw = await fetchSwig(conn, swigPda);
  metrics[`swigAccount-${w.kind}`] = { lamports: (await conn.getAccountInfo(swigPda))!.lamports, bytes: (await conn.getAccountInfo(swigPda))!.data.length, walletAddressLamports: await conn.getBalance(walletAddress(swigPda)), roles: sw.roles.length };
  return Object.assign({}, w, { id, swig: swigPda, addr: walletAddress(swigPda) }) as Wallet;
}
/** The owner starts (or restarts) a session for `sk` lasting `dur` slots: one owner signature. secp: personal_sign inside the instruction; ed25519: the owner signs the transaction. */
async function startIxs(w: Wallet, sk: PublicKey, dur: bigint, o: { slot?: bigint; roleId?: number; payerKey?: PublicKey } = {}) {
  const s = await swigOf(w); const role = o.roleId ?? 1;
  return getCreateSessionInstructions(s, role, sk, dur, { currentSlot: o.slot ?? await slotNow(), payer: o.payerKey ?? payer.publicKey, ...(w.kind === 'secp' ? { signingFn: mmSign() } : {}) });
}
async function grant(name: string, w: Wallet, sk: PublicKey, dur: bigint, expectOk = true, want?: RegExp) {
  return send(name, expectOk, await startIxs(w, sk, dur), [payer], { ext: ownerExt(w), want });
}
/** A session move: the session key signs; the relayer pays the fee, or the session key pays when `self`. */
async function moveIxs(a: Acct, w: Wallet, inner: TransactionInstruction, o: { roleId?: number; policy?: PublicKey; signer?: PublicKey } = {}) {
  const s = await swigOf(w);
  return getSignInstructions(s, o.roleId ?? 1, [policyMove(a, o.signer ?? w.addr!, inner, o.policy)], false, { payer: (s.findRoleById(o.roleId ?? 1)!.authority as any).sessionKey });
}
const relayed = (sk: Keypair) => [payer, sk];
const selfPaid = (sk: Keypair) => [sk];
const hasSession = async (w: Wallet, sk: PublicKey) => !!(await swigOf(w)).findRoleBySessionKey(sk);

const SK: Record<string, Keypair> = {}; const W: Record<string, Wallet> = {};
// ── helpers for the attack sections ─────────────────────────────────────────────────────────────
/** A transaction whose outcome is a property of the build under test: records what happened and always passes. */
const observe = async (name: string, ixs: TransactionInstruction[], signers: Keypair[], o: { ext?: Ext[] } = {}) => {
  const r = await attempt(ixs, signers, o); record(name, r.ok, r.ok, r.detail); return r.ok;
};
const finding = (name: string, detail: string) => record(`FINDING ${name}`, true, true, detail);
const viaSwig = async (w: Wallet, inner: TransactionInstruction[], roleId = 1) => { const s = await swigOf(w); return getSignInstructions(s, roleId, inner, false, { payer: (s.findRoleById(roleId)!.authority as any).sessionKey }); };
const swapKey = (ixs: TransactionInstruction[], from: PublicKey, to: PublicKey) => ixs.map((i) => new TransactionInstruction({ programId: i.programId, data: i.data, keys: i.keys.map((k) => (k.pubkey.equals(from) ? { ...k, pubkey: to } : k)) }));
const withData = (i: TransactionInstruction, f: (d: Buffer) => void) => { const d = Buffer.from(i.data); f(d); return new TransactionInstruction({ programId: i.programId, keys: i.keys, data: d }); };
/** Re-aims a SDK-built admin instruction at the session role: the session key takes the authority slot and the acting role id is rewritten (the SDK builds admin calls for root roles only). */
const asRole = (ixs: TransactionInstruction[], from: PublicKey, to: PublicKey, roleOffset: number, role: number) => swapKey(ixs, from, to).map((i) => withData(i, (d) => d.writeUInt32LE(role, roleOffset)));
const fresh = async (w: Wallet, dur = 300n) => { const k = Keypair.generate(); await grant(`fresh session on ${w.name}`, w, k.publicKey, dur); SK[w.name] = k; return k; };
const nextIndex = async (a: Acct) => BigInt((await sa.accounts.Settings.fromAccountAddress(conn, a.settings)).transactionIndex.toString()) + 1n;
const vaultTx = async (a: Acct, to: PublicKey, sol: number) => new TransactionMessage({ payerKey: a.vault, recentBlockhash: (await conn.getLatestBlockhash()).blockhash, instructions: [sysTransfer(a, to, sol)] });
const wPH = W[PH.name]!, wMM = W[MM.name]!, wFR = W[FR.name]!, wMMS = W[MMS.name]!;
const livePH = () => SK[PH.name]!;
const swigRole1 = async (w: Wallet) => (await swigOf(w)).findRoleById(1)!.authority as any;
const sessionKeyOf = async (w: Wallet) => new PublicKey((await swigRole1(w)).sessionKey.toBytes());

await confirm(await conn.requestAirdrop(payer.publicKey, 20 * SOL));
const build = (await conn.getAccountInfo(new PublicKey('Bb6gN8CtkMXf7cfXKnWysmdBg5B8EZfP5kus5TsyH5Es')))!.data.length; st.swigProgramDataBytes = build; console.log(`Swig ProgramData length on this validator: ${build} (296888 = mainnet bytes, 392704 = devnet bytes)`);
const A = await createAccount('F0'); const w = await makeSwig(A, FR, { tag: 'F0-FR' });
{
  const seed = await policySeed(A); const policy = sa.getPolicyPda({ settingsPda: A.settings, policySeed: seed })[0]; A.policy = policy;
  await send('F1. the 2-of-3 installs the policy with the Freighter Swig wallet address', true, [settingsSync(A, [{ __kind: 'PolicyCreate', seed, policyCreationPayload: policyPayload(), signers: [{ key: w.addr!, permissions: ALL }], threshold: 1, timeLock: 0, startTimestamp: null, expirationArgs: null }], [B.publicKey, C.publicKey], [policy])], [payer, B, C]);
  const k1 = Keypair.generate(); await fund(k1.publicKey, 0.01 * SOL);
  await grant('F2. Freighter starts a session: one SEP-53 signature, the signer contract, the NEAR MPC signs the Solana transaction', w, k1.publicKey, 300n); await measure('grant-freighter-mpc');
  const b = await conn.getBalance(VENUE);
  await send('F3. session key alone, relayer pays: 0.01 SOL vault -> VENUE', true, await moveIxs(A, w, sysTransfer(A, VENUE, 0.01)), relayed(k1));
  await send('F4. relayer down, session key pays: 0.005 SOL', true, await moveIxs(A, w, sysTransfer(A, VENUE, 0.005)), selfPaid(k1));
  record('F5. VENUE received exactly 0.015 SOL', true, (await conn.getBalance(VENUE)) - b === 0.015 * SOL, `${((await conn.getBalance(VENUE)) - b) / SOL}`);
  await send('F6. same session: 0.01 SOL elsewhere (policy)', false, await moveIxs(A, w, sysTransfer(A, OTHER, 0.01)), relayed(k1), { want: /ProgramInteraction/ });
  // a signature by another ed25519 key
  const fake = Keypair.generate(); await send('F7. a session start signed by some other key', false, await startIxs(w, Keypair.generate().publicKey, 300n), [payer], { ext: [{ pub: new PublicKey(FR.pub), sign: kpSign(fake) }], want: /signature|verification/i });
  // withheld grant against a later revoke (the grant is signed by the MPC)
  const k2 = Keypair.generate(); await fund(k2.publicKey, 0.01 * SOL);
  const ixs = await startIxs(w, k2.publicKey, 300n); const tx1 = new Transaction().add(...ixs); tx1.feePayer = payer.publicKey; tx1.recentBlockhash = (await conn.getLatestBlockhash('confirmed')).blockhash;
  tx1.addSignature(new PublicKey(FR.pub), Buffer.from(await FR.sign!(tx1.serializeMessage()))); tx1.partialSign(payer);
  await grant('F8. the owner revokes (a session for a dead key, 0 slots): one MPC signature', w, Keypair.generate().publicKey, 0n); await measure('revoke-freighter-mpc');
  await send('F9. the revoked session key', false, swapKey(await moveIxs(A, w, sysTransfer(A, VENUE, 0.0001)), await sessionKeyOf(w), k1.publicKey), relayed(k1), { want: /Swig/ });
  let ok = true, d = ''; try { d = await conn.sendRawTransaction(tx1.serialize()); await confirm(d); } catch (e: any) { ok = false; d = short(e); }
  record('F10. the relayer sends the grant it withheld before the revoke (still inside its blockhash lifetime)', true, ok, ok ? `${d.slice(0, 12)}…` : d);
  const k3 = Keypair.generate(); const mv = swapKey(await moveIxs(A, w, sysTransfer(A, VENUE, 0.00001)), await sessionKeyOf(w), k3.publicKey);
  await send('F11. one transaction: the MPC-signed session start and the new key first move', true, [...await startIxs(w, k3.publicKey, 300n), ...mv], [payer, k3], { ext: ownerExt(w) }); await measure('grant-and-first-move-freighter-mpc');
}
metrics.mpc = nearMod.stats; console.log(`NEAR MPC signatures: ${nearMod.stats.calls}, average ${(nearMod.stats.ms / Math.max(1, nearMod.stats.calls) / 1000).toFixed(1)} s`);
save(); console.log(`\n${results.filter((r) => r.pass).length}/${results.length} passed`);
for (const r of results.filter((r) => !r.pass)) console.log('FAIL', r.name, r.detail);
process.exit(0);
