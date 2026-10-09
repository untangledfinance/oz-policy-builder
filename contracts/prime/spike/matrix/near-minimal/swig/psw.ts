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
const NEAR = process.env.PSW_NEAR === '1';
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
  await measure(`swig-setup-${w.kind}`);
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

// ═════════════════════════════════════════════════════════════════════════════════════════════
await confirm(await conn.requestAirdrop(payer.publicKey, 100 * SOL));
const startBalance = await conn.getBalance(payer.publicKey);

// ── P. Setup ────────────────────────────────────────────────────────────────────────────────────
const A = await createAccount('P0');
st.settings = A.settings.toBase58(); save();
let W: Record<string, Wallet> = {};
for (const w of WALLETS) { W[w.name] = await makeSwig(A, w); }
{
  const s = await sa.accounts.Settings.fromAccountAddress(conn, A.settings);
  record('P1. settings signers are exactly the three seats, threshold 2 (no Swig wallet is a seat)', true, s.threshold === 2 && s.signers.length === 3 && s.signers.every((x: any) => SEATS.some((k) => k.publicKey.equals(x.key))), '');
  for (const w of WALLETS) {
    const sw = await swigOf(W[w.name]!); const r0 = sw.roles[0]!, r1 = sw.roles[1]!;
    record(`P2-${w.name}. Swig roles: 0 = owner root (no session), 1 = owner session authority with max ${MAX_SLOTS} slots`, true,
      sw.roles.length === 2 && !r0.isSessionBased() && r1.isSessionBased() && (r1.authority as any).maxDuration === MAX_SLOTS, `roles ${sw.roles.length}, max ${(r1.authority as any).maxDuration}`);
  }
  const seed = await policySeed(A); const policy = sa.getPolicyPda({ settingsPda: A.settings, policySeed: seed })[0];
  await send('P3. the 2-of-3 installs the movers policy; signers = the four Swig wallet addresses (policy signers only)', true, [settingsSync(A, [{ __kind: 'PolicyCreate', seed, policyCreationPayload: policyPayload(),
    signers: WALLETS.map((w) => ({ key: W[w.name]!.addr!, permissions: ALL })), threshold: 1, timeLock: 0, startTimestamp: null, expirationArgs: null }], [B.publicKey, C.publicKey], [policy])], [payer, B, C]);
  A.policy = policy;
}
const SK: Record<string, Keypair> = {};

// ── G. Moves, every wallet ──────────────────────────────────────────────────────────────────────
for (const w0 of WALLETS) {
  const w = W[w0.name]!; const sk = Keypair.generate(); SK[w.name] = sk; await fund(sk.publicKey, 0.02 * SOL);
  await grant(`G-${w.name}1. one owner signature starts the session (${w.kind === 'secp' ? 'personal_sign' : w === W[FR.name] && NEAR ? 'Solana tx signed by the NEAR MPC key' : 'Solana tx signature'}), relayed`, w, sk.publicKey, 300n);
  await measure(`grant-${w.name}`);
  const before = await conn.getBalance(VENUE);
  await send(`G-${w.name}2. session key alone, relayer pays: 0.01 SOL vault -> VENUE through Swig -> Squads policy`, true, await moveIxs(A, w, sysTransfer(A, VENUE, 0.01)), relayed(sk));
  await measure(`move-${w.name}-relayed`);
  await send(`G-${w.name}3. relayer down, session key pays its own fee: 0.005 SOL`, true, await moveIxs(A, w, sysTransfer(A, VENUE, 0.005)), selfPaid(sk));
  await measure(`move-${w.name}-selfpaid`);
  record(`G-${w.name}4. VENUE received exactly 0.015 SOL`, true, (await conn.getBalance(VENUE)) - before === 0.015 * SOL, `${((await conn.getBalance(VENUE)) - before) / SOL}`);
  await send(`G-${w.name}5. same session: 0.01 SOL elsewhere (policy)`, false, await moveIxs(A, w, sysTransfer(A, OTHER, 0.01)), relayed(sk), { want: /ProgramInteraction/ });
  await send(`G-${w.name}6. same session: 0.06 SOL to VENUE (over the per-move limit)`, false, await moveIxs(A, w, sysTransfer(A, VENUE, 0.06)), relayed(sk), { want: /ProgramInteraction/ });
  const broke = Keypair.generate(); await grant(`G-${w.name}7a. a second session for a key with no SOL`, w, broke.publicKey, 300n);
  await send(`G-${w.name}7b. relayer down and the session key has no SOL`, false, await moveIxs(A, w, sysTransfer(A, VENUE, 0.001)), selfPaid(broke), { want: /insufficient|debit|fee/i });
  SK[w.name] = broke;   // the live session on this wallet is now the second one (one live session per Swig role)
  record(`G-${w.name}8. the first session key stopped working when the second started (one live session per wallet)`, true, !(await hasSession(w, sk.publicKey)) && (await hasSession(w, broke.publicKey)), '');
}

// ── G10. Least privilege: can a Swig wallet hold less than all three Squads permissions in the policy? ────
{
  const seed = await policySeed(A); const p2 = sa.getPolicyPda({ settingsPda: A.settings, policySeed: seed })[0];
  await send('G10a. a policy that lists the Phantom Swig wallet address with the Execute permission only (mask 4)', false, [settingsSync(A, [{ __kind: 'PolicyCreate', seed, policyCreationPayload: policyPayload(),
    signers: [{ key: W[PH.name]!.addr!, permissions: { mask: 4 } }], threshold: 1, timeLock: 0, startTimestamp: null, expirationArgs: null }], [B.publicKey, C.publicKey], [p2])], [payer, B, C], { want: /NoProposers/ });
  const seed2 = await policySeed(A); const p3 = sa.getPolicyPda({ settingsPda: A.settings, policySeed: seed2 })[0];
  await send('G10b. the same wallet with Execute only, next to seat B with Initiate and Vote (mask 3)', true, [settingsSync(A, [{ __kind: 'PolicyCreate', seed: seed2, policyCreationPayload: policyPayload(),
    signers: [{ key: W[PH.name]!.addr!, permissions: { mask: 4 } }, { key: B.publicKey, permissions: { mask: 3 } }], threshold: 1, timeLock: 0, startTimestamp: null, expirationArgs: null }], [B.publicKey, C.publicKey], [p3])], [payer, B, C]);
  await send('G10c. the Phantom session alone (Execute only) moves through that policy', false, await moveIxs(A, W[PH.name]!, sysTransfer(A, VENUE, 0.001), { policy: p3 }), relayed(SK[PH.name]!));
}

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

// ── N. A session key never votes, never changes settings, never calls another program, never manages the Swig ──
{
  const w = wPH, sk = livePH();
  const index = await nextIndex(A);
  await send('N0. seat B proposes a vault transfer and approves it (1 of 2 approvals), so a vote would matter', true, [ix.createTransaction({ settingsPda: A.settings, transactionIndex: index, creator: B.publicKey, rentPayer: payer.publicKey,
    accountIndex: 0, ephemeralSigners: 0, addressLookupTableAccounts: [], transactionMessage: await vaultTx(A, OTHER, 0.01) }),
    ix.createProposal({ settingsPda: A.settings, transactionIndex: index, creator: B.publicKey, rentPayer: payer.publicKey }),
    ix.approveProposal({ settingsPda: A.settings, transactionIndex: index, signer: B.publicKey })], [payer, B]);
  await send('N1. Phantom session approves that proposal as its Swig wallet address (through Swig)', false, await viaSwig(w, [ix.approveProposal({ settingsPda: A.settings, transactionIndex: index, signer: w.addr! })]), relayed(sk), { want: /NotASigner/ });
  await send('N2. Phantom session key approves it as itself (plain transaction)', false, [ix.approveProposal({ settingsPda: A.settings, transactionIndex: index, signer: sk.publicKey })], relayed(sk), { want: /NotASigner/ });
  await send('N3. Phantom session proposes a vault transaction as its Swig wallet address', false, await viaSwig(w, [ix.createTransaction({ settingsPda: A.settings, transactionIndex: index + 1n, creator: w.addr!, rentPayer: payer.publicKey,
    accountIndex: 0, ephemeralSigners: 0, addressLookupTableAccounts: [], transactionMessage: await vaultTx(A, OTHER, 0.01) })]), relayed(sk), { want: /NotASigner|InvalidSigner|Unauthorized/ });
  await send('N4. Phantom session adds its Swig wallet address as a seat (settings sync)', false, await viaSwig(w, [settingsSync(A, [{ __kind: 'AddSigner', newSigner: { key: w.addr!, permissions: ALL } }], [w.addr!])]), relayed(sk), { want: /InvalidSignerCount|NotASigner/ });
  await send('N4b. Phantom session changes the threshold to 1 (settings sync)', false, await viaSwig(w, [settingsSync(A, [{ __kind: 'ChangeThreshold', newThreshold: 1 }], [w.addr!])]), relayed(sk), { want: /InvalidSignerCount|NotASigner/ });
  await send('N5. Phantom session calls the System program as the Swig wallet address (not the Smart Account program)', false, await viaSwig(w, [SystemProgram.transfer({ fromPubkey: w.addr!, toPubkey: OTHER, lamports: 1000 })]), relayed(sk), { want: WANT(SW.MissingPermission) });
  await send('N5b. Phantom as OWNER (role 0, root key) signs a move directly: the root role holds no Program action, so only a session can move', false, await getSignInstructions(await swigOf(w), 0, [policyMove(A, w.addr!, sysTransfer(A, VENUE, 0.001))], false, { payer: payer.publicKey }), [payer], { ext: ownerExt(w), want: WANT(SW.MissingPermission) });
  const sw = await swigOf(w);
  await send('N6. Phantom session adds an All authority for an attacker key (Swig AddAuthority, acting role 1)', false, asRole(await getAddAuthorityInstructions(sw, 0, createEd25519AuthorityInfo(B.publicKey), Actions.set().all().get(), { payer: payer.publicKey }), new PublicKey(PH.pub), sk.publicKey, 12, 1), relayed(sk), { want: WANT(SW.ToManageAuthority) });
  await send('N6b. Phantom session widens its own role (Swig UpdateAuthority: add All)', false, asRole(await getUpdateAuthorityInstructions(sw, 0, 1, updateAuthorityAddActions(Actions.set().all().get()), { payer: payer.publicKey }), new PublicKey(PH.pub), sk.publicKey, 8, 1), relayed(sk), { want: WANT(SW.ToManageAuthority) });
  const owner = new PublicKey(w.pub);
  const restart = swapKey(await startIxs(w, sk.publicKey, MAX_SLOTS), owner, sk.publicKey);
  await send('N7. Phantom session key restarts its own session for the maximum length (Swig CreateSession, session key as the signer)', false, restart, relayed(sk), { want: /Swig/ });
  // relayer fee-payer abuse: Swig forwards outer signers into the inner call, and the Program action only checks instructions that use the Swig signer
  const drain = await viaSwig(w, [SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: OTHER, lamports: 12345 })]);
  const rb = await conn.getBalance(OTHER);
  const n8 = await observe('N8. session builds a Swig sign whose inner call is a System transfer FROM THE RELAYER (fee payer) to the attacker; relayer co-signs', drain, relayed(sk));
  finding('N8', `${n8 ? 'executed' : 'refused'} on the ${LABEL} Swig build (${(await conn.getBalance(OTHER)) - rb} lamports reached the attacker). Swig forwards outer signers into the inner call and its Program action only checks instructions that sign with the Swig wallet.`);
  // relayer funds as rent for accounts the session key chooses (no Swig signer involved)
  const big = Keypair.generate(); const space = 10_240; const rent = await conn.getMinimumBalanceForRentExemption(space); const rb2 = await conn.getBalance(payer.publicKey);
  const n8b = await observe(`N8b. session builds a Swig sign whose inner call is a System createAccount of ${space} bytes funded BY THE RELAYER (${(rent / SOL).toFixed(2)} SOL of rent), owner program = Token program`, await viaSwig(w, [SystemProgram.createAccount({ fromPubkey: payer.publicKey, newAccountPubkey: big.publicKey, lamports: rent, space, programId: TOKEN_PROGRAM_ID })]), [payer, sk, big]);
  finding('N8b', `${n8b ? 'executed' : 'refused'} on the ${LABEL} Swig build (relayer balance fell by ${((rb2 - await conn.getBalance(payer.publicKey)) / SOL).toFixed(3)} SOL). The relayer must refuse any transaction that lists its key in an instruction account list: that rule makes both attempts impossible.`);
  // a session key may delete its own role
  const scratch = await makeSwig(A, PH, { tag: 'N9-scratch' }); const sk9 = Keypair.generate();
  await grant('N9a. scratch Swig: Phantom starts a session', scratch, sk9.publicKey, 300n);
  const rem = asRole(await getRemoveAuthorityInstructions(await swigOf(scratch), 0, 1, { payer: payer.publicKey }), new PublicKey(PH.pub), sk9.publicKey, 8, 1);
  const removed = await send('N9b. scratch Swig: the session key removes its own role (Swig RemoveAuthority 1 by 1)', true, rem, relayed(sk9));
  if (removed) finding('N9', `a session key can delete its own role: roles left on the Swig = ${(await swigOf(scratch)).roles.length}; the owner (role 0, ManageAuthority) can add the role again with one signature`);
}

// ── X. Cross-wallet, cross-account and replay ───────────────────────────────────────────────────
let B2: Acct; let wMM2: Wallet, wPH2: Wallet;
{
  // account B: its own seats' policy and its own Swig per wallet
  B2 = await createAccount('X0');
  wMM2 = await makeSwig(B2, MM, { tag: 'X0-MM' }); wPH2 = await makeSwig(B2, PH, { tag: 'X0-PH' });
  const seed = await policySeed(B2); const policy = sa.getPolicyPda({ settingsPda: B2.settings, policySeed: seed })[0];
  await send('X0b. account B installs its own movers policy (0.1 SOL a day): signers = its two Swig wallet addresses', true, [settingsSync(B2, [{ __kind: 'PolicyCreate', seed, policyCreationPayload: policyPayload(VENUE, 0.05, 0.1),
    signers: [wMM2, wPH2].map((x) => ({ key: x.addr!, permissions: ALL })), threshold: 1, timeLock: 0, startTimestamp: null, expirationArgs: null }], [B.publicKey, C.publicKey], [policy])], [payer, B, C]);
  B2.policy = policy;
  record("X0c. the Swig wallet addresses of account A and account B differ for the same owners", true, !wMM2.addr!.equals(wMM.addr!) && !wPH2.addr!.equals(wPH.addr!), '');
  {
    const m2 = Keypair.generate(), p2 = Keypair.generate();
    await grant('G9a. account B: MetaMask session', wMM2, m2.publicKey, 300n); await grant('G9b. account B: Phantom session', wPH2, p2.publicKey, 300n);
    await send('G9c. account B daily cap is 0.1 SOL for all wallets: MetaMask moves 0.05', true, await moveIxs(B2, wMM2, sysTransfer(B2, VENUE, 0.05)), relayed(m2));
    await send('G9d. Phantom moves 0.045 (0.095 used)', true, await moveIxs(B2, wPH2, sysTransfer(B2, VENUE, 0.045)), relayed(p2));
    await send('G9e. MetaMask moves 0.01 more (0.105 > 0.1)', false, await moveIxs(B2, wMM2, sysTransfer(B2, VENUE, 0.01)), relayed(m2), { want: /ProgramInteraction/ });
    await send('G9f. Phantom moves 0.005 (exactly 0.1)', true, await moveIxs(B2, wPH2, sysTransfer(B2, VENUE, 0.005)), relayed(p2));
  }
  const skA = livePH();
  // wallet against wallet
  const inner = sysTransfer(A, VENUE, 0.001);
  const mmMove = await moveIxs(A, wMM, inner); const mmKey = await sessionKeyOf(wMM);
  await send("X1. Phantom's session key signs a move on MetaMask's Swig (session-key slot swapped)", false, swapKey(mmMove, mmKey, skA.publicKey), relayed(skA), { want: /Swig/ });
  const phStart = await startIxs(wPH, Keypair.generate().publicKey, 300n);
  await send("X2. MetaMask's Solana-account key signs a session start on Phantom's Swig (owner slot swapped)", false, swapKey(phStart, new PublicKey(PH.pub), new PublicKey(MMS.pub)), [payer], { ext: ownerExt(MMS), want: /Swig/ });
  await send("X2b. a random key signs a session start on Phantom's Swig", false, swapKey(phStart, new PublicKey(PH.pub), B.publicKey), [payer, B], { want: /Swig/ });
  const mmStartOther = getCreateSessionInstructions(await swigOf(wMM), 1, Keypair.generate().publicKey, 300n, { currentSlot: await slotNow(), payer: payer.publicKey, signingFn: mmSign(otherSecp) });
  await send("X3. another secp256k1 key signs a session start on MetaMask's Swig", false, await mmStartOther, [payer], { want: /Swig/ });
  // secp256k1 replay
  const skR = Keypair.generate(); const startR = await startIxs(wMM, skR.publicKey, 300n);
  await send('X4a. MetaMask session start (signed once)', true, startR, [payer]);
  await send('X4b. the identical instruction sent again (replay)', false, startR, [payer], { want: WANT(SW.SigReused) });
  // the signature is bound to the Swig account: two fresh Swigs of the same owner, same counter
  const f1 = await makeSwig(B2, MM, { tag: 'X5-swig1' }), f2 = await makeSwig(B2, MM, { tag: 'X5-swig2' });
  const sk5 = Keypair.generate(); const ix1 = await startIxs(f1, sk5.publicKey, 300n);
  await send('X5. a MetaMask signature made for Swig 1 presented to Swig 2 (same owner key, same counter; account swapped)', false, swapKey(ix1, f1.swig!, f2.swig!), [payer], { want: /Swig/ });
  await send('X5b. the same signature on Swig 1 itself works', true, ix1, [payer]);
  const ix6 = await startIxs(f2, sk5.publicKey, 300n);
  await send('X6a. a signed session start with the session key replaced by the attacker key', false, [withData(ix6[0]!, (d) => Buffer.from(Keypair.generate().publicKey.toBytes()).copy(d, 16))], [payer], { want: /Swig/ });
  await send('X6b. a signed session start with the duration changed', false, [withData(ix6[0]!, (d) => d.writeBigUInt64LE(1n, 8))], [payer], { want: /Swig/ });
  await fund(C.publicKey, 0.01 * SOL); const ix6c = swapKey(ix6, payer.publicKey, C.publicKey);
  await send('X6c. a signed session start with the fee payer account swapped', false, ix6c, [C], { want: /Swig/ });
  await send('X6d. the untouched signed session start works', true, ix6, [payer]);
  // stale signature: more than 60 slots old
  const oldSlot = await slotNow(); const stale = await startIxs(f1, Keypair.generate().publicKey, 300n, { slot: oldSlot });
  console.log('   waiting 40 s so the signature is more than 60 slots old'); await sleep(40_000);
  await send('X7. a MetaMask signature older than 60 slots', false, stale, [payer], { want: /Swig/ });
  const future = await startIxs(f1, Keypair.generate().publicKey, 300n, { slot: (await slotNow()) + 500n });
  await send('X7b. a MetaMask signature that names a slot in the future', false, future, [payer], { want: /Swig/ });
  // ed25519: the owner signs the whole transaction
  const g1 = await makeSwig(B2, PH, { tag: 'X8-swig1' }), g2 = await makeSwig(B2, PH, { tag: 'X8-swig2' });
  {
    const sk8 = Keypair.generate(); const orig = await startIxs(g1, sk8.publicKey, 300n);
    const tx = new Transaction().add(...orig); tx.feePayer = payer.publicKey; tx.recentBlockhash = (await conn.getLatestBlockhash('confirmed')).blockhash;
    const sig = await PH.sign!(tx.serializeMessage());
    const tx2 = new Transaction().add(...swapKey(orig, g1.swig!, g2.swig!)); tx2.feePayer = payer.publicKey; tx2.recentBlockhash = tx.recentBlockhash;
    tx2.addSignature(phantom.publicKey, Buffer.from(sig)); tx2.partialSign(payer);
    let ok = true, d = ''; try { d = await conn.sendRawTransaction(tx2.serialize()); await confirm(d); } catch (e: any) { ok = false; d = short(e); }
    record("X8. Phantom's signature over a session start for Swig 1, reused on a transaction that names Swig 2", false, ok, d, /Signature verification failed|signature/i);
  }
  // cross-account: Swig of account A against account B's policy; and the same Swig installed in both accounts
  const skx = livePH();
  const asB = getSignInstructions(await swigOf(wPH), 1, [policyMove(B2, wPH.addr!, sysTransfer(B2, VENUE, 0.001))], false, { payer: skx.publicKey });
  await send("X9. Phantom's account-A session key moves in account B (A's Swig wallet is not a signer of B's policy)", false, await asB, relayed(skx), { want: /NotASigner/ });
  const seed2 = await policySeed(B2); const pol2 = sa.getPolicyPda({ settingsPda: B2.settings, policySeed: seed2 })[0];
  await send("X10a. (misconfiguration) account B's 2-of-3 also installs account A's Phantom Swig wallet as a signer of a second policy", true, [settingsSync(B2, [{ __kind: 'PolicyCreate', seed: seed2, policyCreationPayload: policyPayload(),
    signers: [{ key: wPH.addr!, permissions: ALL }], threshold: 1, timeLock: 0, startTimestamp: null, expirationArgs: null }], [B.publicKey, C.publicKey], [pol2])], [payer, B, C]);
  await send("X10b. ...then Phantom's one session key moves in account B as well: a Swig session reaches every policy that lists its wallet address", true,
    await getSignInstructions(await swigOf(wPH), 1, [policyMove(B2, wPH.addr!, sysTransfer(B2, VENUE, 0.001), pol2)], false, { payer: skx.publicKey }), relayed(skx));
  finding('X10', 'the account binding is the policy membership: use one Swig per wallet per Prime Account and never list a Swig wallet address in two accounts');
}

// ── E. Expiry, maximum length, and the 7-day wall-time mapping ──────────────────────────────────
{
  const idleA = await slotNow(), idleT = Date.now(); await sleep(8000); const idleB = await slotNow(); const localMs = (Date.now() - idleT) / Number(idleB - idleA);
  const w = wMMS; const sk = Keypair.generate(); await fund(sk.publicKey, 0.01 * SOL);
  await grant('E1. session of 20 slots', w, sk.publicKey, 20n);
  const s0 = await slotNow();
  await send('E2. a move inside the 20 slots', true, await moveIxs(A, w, sysTransfer(A, VENUE, 0.0001)), relayed(sk));
  const exp = (await swigRole1(w)).expirySlot as bigint;
  let t0 = Date.now(); while ((await slotNow()) <= exp) await sleep(200);
  const s1 = await slotNow(); const msPerSlot = localMs; void t0; void s0;
  await send(`E3. the same session after its expiry slot ${exp} (now ${s1})`, false, await moveIxs(A, w, sysTransfer(A, VENUE, 0.0001)), relayed(sk), { want: WANT(SW.Expired) });
  const skm = Keypair.generate();
  await grant('E4. session for exactly the maximum length', w, skm.publicKey, MAX_SLOTS);
  const t = await conn.getTransaction(last.sig, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 });
  record('E4b. the expiry slot is the landing slot plus the maximum', true, (await swigRole1(w)).expirySlot === BigInt(t!.slot) + MAX_SLOTS, `landing ${t!.slot}, expiry ${(await swigRole1(w)).expirySlot}, max ${MAX_SLOTS}`);
  await send('E5. session for the maximum plus one slot', false, await startIxs(w, Keypair.generate().publicKey, MAX_SLOTS + 1n), [payer], { ext: ownerExt(w), want: WANT(SW.InvalidDuration) });
  await send('E5b. the maximum itself is on the role, and the owner cannot lengthen it without changing the role (checked in H2)', true, await moveIxs(A, w, sysTransfer(A, VENUE, 0.0001)), relayed(skm));
  metrics.slotTime = { localMsPerSlot: Number(msPerSlot.toFixed(1)), maxSlots: String(MAX_SLOTS), maxDaysAtLocalRate: Number((Number(MAX_SLOTS) * msPerSlot / 86400000).toFixed(2)) };
  console.log(`METRIC slotTime ${JSON.stringify(metrics.slotTime)}`);
}

// ── R. Revoke ───────────────────────────────────────────────────────────────────────────────────
for (const w0 of [MM, MMS, PH, FR]) {
  const w = W[w0.name]!; const sk = Keypair.generate(); await fund(sk.publicKey, 0.01 * SOL);
  await grant(`R-${w.name}1. fresh session`, w, sk.publicKey, 300n);
  await send(`R-${w.name}2. it works`, true, await moveIxs(A, w, sysTransfer(A, VENUE, 0.0001)), relayed(sk));
  const other = Object.values(W).find((x) => x.name !== w.name && x.name !== wMMS.name)!; const osk = SK[other.name]!;
  await grant(`R-${w.name}3. the owner revokes: one owner signature starts a session for a dead key with duration 0`, w, Keypair.generate().publicKey, 0n);
  const rb = await measure(`revoke-${w.name}`); void rb;
  const deadKey = await sessionKeyOf(w);
  await send(`R-${w.name}4. the revoked session key (its key slot is gone: the role now names a dead key)`, false, swapKey(await moveIxs(A, w, sysTransfer(A, VENUE, 0.0001)), deadKey, sk.publicKey), relayed(sk), { want: /Swig/ });
  await send(`R-${w.name}5. another wallet's session is unaffected (${other.name})`, true, await moveIxs(A, other, sysTransfer(A, VENUE, 0.0001)), relayed(osk));
  const sk2 = Keypair.generate(); await grant(`R-${w.name}6. a new session on the same wallet`, w, sk2.publicKey, 300n);
  await send(`R-${w.name}7. the new session works`, true, await moveIxs(A, w, sysTransfer(A, VENUE, 0.0001)), relayed(sk2));
  SK[w.name] = sk2;
}

// ── R2. A withheld grant against a later revoke ─────────────────────────────────────────────────
{
  // ed25519 owner: the grant is a signed transaction. Whoever holds it can send it any time before its blockhash expires, also after a later revoke.
  const w = wPH; const k1 = Keypair.generate(); await fund(k1.publicKey, 0.01 * SOL);
  const ixs = await startIxs(w, k1.publicKey, 300n);
  const tx1 = new Transaction().add(...ixs); tx1.feePayer = payer.publicKey; tx1.recentBlockhash = (await conn.getLatestBlockhash('confirmed')).blockhash;
  tx1.addSignature(phantom.publicKey, Buffer.from(await PH.sign!(tx1.serializeMessage()))); tx1.partialSign(payer);
  await grant('R2a. (Phantom) the owner signs a grant for key K1; the relayer withholds it. The owner then revokes by starting a session for a dead key', w, Keypair.generate().publicKey, 0n);
  let ok = true, d = ''; try { d = await conn.sendRawTransaction(tx1.serialize()); await confirm(d); } catch (e: any) { ok = false; d = short(e); }
  record('R2b. the relayer now sends the withheld grant (still inside its blockhash lifetime)', true, ok, ok ? `${d.slice(0, 12)}…` : d);
  if (ok) finding('R2', `a revoked ed25519 session came back: K1 is live again (${(await hasSession(w, k1.publicKey))}). A Swig revoke overwrites the session key; it does not bar K1 for good, so an earlier owner-signed grant that was never sent can be sent after it, for as long as its blockhash lives (150 slots, about 40 seconds at today's slot time).`);
  // secp256k1 owner: grant and revoke carry a sequence number
  const m = wMM; const k2 = Keypair.generate();
  const g = await startIxs(m, k2.publicKey, 300n); const r = await startIxs(m, Keypair.generate().publicKey, 0n);
  await send('R2c. (MetaMask) the revoke, signed after the grant but before it was sent, goes first', true, r, [payer]);
  await send('R2d. (MetaMask) the withheld grant sent afterwards', false, g, [payer], { want: WANT(SW.SigReused) });
}

// ── M. Measurements ─────────────────────────────────────────────────────────────────────────────
{
  const w = wPH; const sk = await fresh(w);
  const cu: number[] = [], bytes: number[] = [];
  for (let i = 0; i < 10; i++) {
    await send(`M${i}. Phantom session: one relayed move through Swig and the Squads policy (compute units recorded)`, true, await moveIxs(A, w, sysTransfer(A, VENUE, 0.00001)), relayed(sk));
    const m = await measure(`move-sample-${i}`); cu.push(m!.totalCu!); bytes.push(m!.bytes);
  }
  const stat = (v: number[]) => { const x = [...v].sort((p, q) => p - q); return { samples: x, min: x[0], median: (x[4]! + x[5]!) / 2, max: x[9] }; };
  metrics.moveCu = { ...stat(cu), txBytes: bytes[0] }; console.log(`METRIC moveCu ${JSON.stringify(metrics.moveCu)}`);
  // grant and first move in one transaction
  for (const w0 of [MM, PH, FR]) {
    const x = W[w0.name]!; const old = await sessionKeyOf(x); const nk = Keypair.generate();
    const mv = swapKey(await moveIxs(A, x, sysTransfer(A, VENUE, 0.00001)), old, nk.publicKey);
    await send(`M-combo-${x.name}. one transaction: owner starts the session and the new key makes its first move`, true, [...await startIxs(x, nk.publicKey, 300n), ...mv], [payer, nk], { ext: ownerExt(x) });
    await measure(`grant-and-first-move-${x.name}`); SK[x.name] = nk;
  }
}


// ── M2. Compute units over ten different Swig wallets (the Swig PDA bumps differ per wallet); each in its own account with a three-signer policy, like the prime-session pairs ──
{
  const cu: number[] = [];
  for (let i = 0; i < 10; i++) {
    const MX = await createAccount(`M2-${i}`); const w = await makeSwig(MX, PH, { tag: `M2-swig${i}` });
    const seed = await policySeed(MX); const pol = sa.getPolicyPda({ settingsPda: MX.settings, policySeed: seed })[0]; MX.policy = pol;
    await send(`M2-p${i}. policy with three signers: this Swig wallet address and two other keys`, true, [settingsSync(MX, [{ __kind: 'PolicyCreate', seed, policyCreationPayload: policyPayload(),
      signers: [w.addr!, Keypair.generate().publicKey, Keypair.generate().publicKey].map((key) => ({ key, permissions: ALL })), threshold: 1, timeLock: 0, startTimestamp: null, expirationArgs: null }], [B.publicKey, C.publicKey], [pol])], [payer, B, C]);
    const k = Keypair.generate(); await grant(`M2-g${i}. session on Swig ${i}`, w, k.publicKey, 300n);
    await send(`M2-m${i}. one relayed move on Swig ${i} (compute units recorded)`, true, await moveIxs(MX, w, sysTransfer(MX, VENUE, 0.00001)), relayed(k));
    cu.push((await measure(`move-swig-${i}`))!.totalCu!);
  }
  const x = [...cu].sort((p, q) => p - q);
  metrics.moveCuAcrossSwigs = { samples: x, min: x[0], median: (x[4]! + x[5]!) / 2, max: x[9], mean: Math.round(cu.reduce((p, q) => p + q, 0) / cu.length) };
  console.log(`METRIC moveCuAcrossSwigs ${JSON.stringify(metrics.moveCuAcrossSwigs)}`); save();
}

// ── T. SPL tokens through Swig and the Squads policy (what Prime actually moves) ─────────────────
{
  const TA = await createAccount('T0'); const wT = await makeSwig(TA, PH, { tag: 'T0-PH' });
  const mintKp = Keypair.generate(); const DEC = 6; const U = 10 ** DEC;
  await send('T0b. mint with 6 decimals (relayer is the authority)', true, [SystemProgram.createAccount({ fromPubkey: payer.publicKey, newAccountPubkey: mintKp.publicKey, lamports: await conn.getMinimumBalanceForRentExemption(MINT_SIZE), space: MINT_SIZE, programId: TOKEN_PROGRAM_ID }),
    createInitializeMint2Instruction(mintKp.publicKey, DEC, payer.publicKey, null)], [payer, mintKp]);
  const mint = mintKp.publicKey;
  const vAta = getAssociatedTokenAddressSync(mint, TA.vault, true), tVenue = getAssociatedTokenAddressSync(mint, VENUE), tVenue2 = getAssociatedTokenAddressSync(mint, OTHER);
  await send('T0c. vault token account (owner = the Smart Account vault) with 1000 tokens, and the venue token account', true, [createAssociatedTokenAccountIdempotentInstruction(payer.publicKey, vAta, TA.vault, mint),
    createAssociatedTokenAccountIdempotentInstruction(payer.publicKey, tVenue, VENUE, mint), createMintToInstruction(mint, vAta, payer.publicKey, 1000 * U)], [payer]);
  const tokPolicy: any = { __kind: 'ProgramInteraction', fields: [{ accountIndex: 0, preHook: null, postHook: null, spendingLimits: [], instructionsConstraints: [
    { programId: TOKEN_PROGRAM_ID, accountConstraints: [{ accountIndex: 1, accountConstraint: { __kind: 'Pubkey', fields: [[tVenue]] }, owner: null }],
      dataConstraints: [{ dataOffset: 0, dataValue: { __kind: 'U8', fields: [3] }, operator: sa.generated.DataOperator.Equals }, { dataOffset: 1, dataValue: { __kind: 'U64Le', fields: [100 * U] }, operator: sa.generated.DataOperator.LessThanOrEqualTo }] },
    { programId: TOKEN_PROGRAM_ID, accountConstraints: [{ accountIndex: 1, accountConstraint: { __kind: 'Pubkey', fields: [[VENUE]] }, owner: null }],
      dataConstraints: [{ dataOffset: 0, dataValue: { __kind: 'U8', fields: [4] }, operator: sa.generated.DataOperator.Equals }, { dataOffset: 1, dataValue: { __kind: 'U64Le', fields: [50 * U] }, operator: sa.generated.DataOperator.LessThanOrEqualTo }] },
    { programId: ASSOCIATED_TOKEN_PROGRAM_ID, accountConstraints: [], dataConstraints: [{ dataOffset: 0, dataValue: { __kind: 'U8', fields: [1] }, operator: sa.generated.DataOperator.Equals }] }] }] };
  const seed = await policySeed(TA); const pol = sa.getPolicyPda({ settingsPda: TA.settings, policySeed: seed })[0]; TA.policy = pol;
  await send('T1. the 2-of-3 installs a token policy: Token transfer <= 100 tokens to the venue account, Token approve <= 50 tokens for the venue, ATA creation', true, [settingsSync(TA, [{ __kind: 'PolicyCreate', seed, policyCreationPayload: tokPolicy,
    signers: [{ key: wT.addr!, permissions: ALL }], threshold: 1, timeLock: 0, startTimestamp: null, expirationArgs: null }], [B.publicKey, C.publicKey], [pol])], [payer, B, C]);
  const many = (inner: TransactionInstruction[], idx: number[]) => {
    const vaultWritable = inner.map((i) => new TransactionInstruction({ programId: i.programId, data: i.data, keys: i.keys.map((k) => (k.pubkey.equals(TA.vault) ? { ...k, isWritable: true } : k)) }));
    const d = sa.utils.instructionsToSynchronousTransactionDetailsV2({ vaultPda: TA.vault, members: [wT.addr!], transaction_instructions: vaultWritable });
    return ix.executePolicyPayloadSync({ policy: pol, accountIndex: 0, numSigners: 1, instruction_accounts: d.accounts,
      policyPayload: { __kind: 'ProgramInteraction', fields: [{ instructionConstraintIndices: new Uint8Array(idx), transactionPayload: { __kind: 'SyncTransaction', fields: [{ accountIndex: 0, instructions: d.instructions }] } }] } });
  };
  const sk = Keypair.generate(); await grant('T2a. Phantom session on the token account', wT, sk.publicKey, 300n);
  const via = async (inner: TransactionInstruction[], idx: number[]) => getSignInstructions(await swigOf(wT), 1, [many(inner, idx)], false, { payer: sk.publicKey });
  const bal = async (a: PublicKey) => Number((await getAccount(conn, a)).amount) / U;
  await send('T2. session moves 10 tokens vault -> venue (SPL transfer through Swig and Squads)', true, await via([createTransferInstruction(vAta, tVenue, TA.vault, 10 * U)], [0]), relayed(sk));
  await measure('move-token-transfer');
  record('T2b. the venue token account received exactly 10 tokens', true, (await bal(tVenue)) === 10, `${await bal(tVenue)}`);
  await send('T3. session moves 10 tokens to a token account the policy does not list', false, await via([createTransferInstruction(vAta, tVenue2, TA.vault, 10 * U)], [0]), relayed(sk), { want: /ProgramInteraction/ });
  await send('T4. session moves 200 tokens (over the 100 limit)', false, await via([createTransferInstruction(vAta, tVenue, TA.vault, 200 * U)], [0]), relayed(sk), { want: /ProgramInteraction/ });
  await send('T5. session sets the venue as delegate of the vault token account for 20 tokens (SPL approve through Swig)', true, await via([createApproveInstruction(vAta, VENUE, TA.vault, 20 * U)], [1]), relayed(sk));
  record('T5b. the delegate is set on the vault token account', true, (await getAccount(conn, vAta)).delegate?.equals(VENUE) === true, `${(await getAccount(conn, vAta)).delegate?.toBase58()}`);
  await send('T6. session creates the other party\'s token account, rent paid by the vault', true, await via([createAssociatedTokenAccountIdempotentInstruction(TA.vault, tVenue2, OTHER, mint)], [2]), relayed(sk));
  await measure('move-token-ata-create-vault-funded');
  const o3 = Keypair.generate().publicKey; const tVenue3 = getAssociatedTokenAddressSync(mint, o3); const rb = await conn.getBalance(payer.publicKey);
  const t7 = await observe('T7. session creates a token account with the RELAYER as rent payer inside the move', await via([createAssociatedTokenAccountIdempotentInstruction(payer.publicKey, tVenue3, o3, mint)], [2]), relayed(sk));
  finding('T7', `${t7 ? 'executed' : 'refused'} (relayer paid ${(rb - await conn.getBalance(payer.publicKey)) / SOL} SOL); the relayer rule applies to a policy that allows account creation`);
}

// ── D. The 2-of-3 removes a wallet's Swig from the policy ───────────────────────────────────────
{
  const fr = await fresh(wFR), mm = await fresh(wMM);
  await send('D0. Freighter session works before the removal', true, await moveIxs(A, wFR, sysTransfer(A, VENUE, 0.0001)), relayed(fr));
  const upd = (members: Wallet[]) => [settingsSync(A, [{ __kind: 'PolicyUpdate', policy: A.policy!, signers: members.map((x) => ({ key: x.addr!, permissions: ALL })), threshold: 1, timeLock: 0,
    policyUpdatePayload: policyPayload(), expirationArgs: null }], [B.publicKey, phantom.publicKey], [A.policy!])];
  await send("D1. seats B (MetaMask) and Phantom update the policy: Freighter's Swig wallet address is dropped", true, upd([wMM, wMMS, wPH]), [payer, B, phantom]);
  await send('D2. the live Freighter session after the removal', false, await moveIxs(A, wFR, sysTransfer(A, VENUE, 0.0001)), relayed(fr), { want: /NotASigner/ });
  await send('D3. the MetaMask session keeps working', true, await moveIxs(A, wMM, sysTransfer(A, VENUE, 0.0001)), relayed(mm));
  await send('D4. the 2-of-3 puts Freighter back', true, upd([wMM, wMMS, wPH, wFR]), [payer, B, phantom]);
  await send('D5. the same, still unexpired Freighter session works again', true, await moveIxs(A, wFR, sysTransfer(A, VENUE, 0.0001)), relayed(fr));
  finding('D5', 'removing a Swig wallet from the policy stops its sessions but does not revoke them: if the wallet is added back, an unexpired session works again (prime-session behaves the same unless the key was revoked)');
  await send('D6. B and C remove the whole policy (kill switch)', true, [settingsSync(A, [{ __kind: 'PolicyRemove', policy: A.policy! }], [B.publicKey, C.publicKey], [A.policy!])], [payer, B, C]);
  await send('D7. any session move after the policy is gone', false, await moveIxs(A, wMM, sysTransfer(A, VENUE, 0.0001)), relayed(mm), { want: /AccountNotInitialized|NotInitialized/ });
}

// ── H. Configuration hazards and the frozen variant ─────────────────────────────────────────────
{
  // H1: ManageAuthority on the session role lets the session key mint a permanent authority
  const hz = await makeSwig(A, PH, { tag: 'H1', actions: Actions.set().manageAuthority().programLimit({ programId: SQUADS }).get() });
  const kh = Keypair.generate(); const atk = Keypair.generate(); await fund(hz.addr!, 0.02 * SOL);
  await grant('H1a. Swig whose session role also holds ManageAuthority: Phantom starts a session', hz, kh.publicKey, 300n);
  await send('H1b. the session key adds an All authority for an attacker key (acting as its own role)', true, asRole(await getAddAuthorityInstructions(await swigOf(hz), 0, createEd25519AuthorityInfo(atk.publicKey), Actions.set().all().get(), { payer: payer.publicKey }), new PublicKey(PH.pub), kh.publicKey, 12, 1), relayed(kh));
  await fund(atk.publicKey, 0.01 * SOL); const swh = await swigOf(hz); const rid = swh.roles.at(-1)!.id; const ob = await conn.getBalance(OTHER);
  await send('H1c. the attacker key then moves SOL out of the Swig wallet with no session at all', true, await getSignInstructions(swh, rid, [SystemProgram.transfer({ fromPubkey: hz.addr!, toPubkey: OTHER, lamports: 0.005 * SOL })], false, { payer: atk.publicKey }), selfPaid(atk));
  finding('H1', `a session role must never hold ManageAuthority: the attacker role has no expiry (moved ${(await conn.getBalance(OTHER)) - ob} lamports)`);
  // H2: with the owner as role 0 the owner can lengthen sessions beyond the 7-day cap
  const w = wPH; const big = MAX_SLOTS * 10n; const add2 = await getAddAuthorityInstructions(await swigOf(w), 0, ownerInfo(w, big), squadsOnly(), { payer: payer.publicKey, currentSlot: await slotNow() });
  const before = await conn.getAccountInfo(w.swig!);
  await send('H2a. the owner (role 0, ManageAuthority) adds a second session role with ten times the maximum length', true, add2, [payer], { ext: ownerExt(w) });
  const after = await conn.getAccountInfo(w.swig!); metrics.extraRole = { addedBytes: after!.data.length - before!.data.length, addedLamports: after!.lamports - before!.lamports, fee: (await measure('add-role'))?.fee };
  const k3 = Keypair.generate(); const r2 = (await swigOf(w)).roles.at(-1)!.id;
  await send(`H2b. the owner starts a session of ${big} slots on that role`, true, await getCreateSessionInstructions(await swigOf(w), r2, k3.publicKey, big, { payer: payer.publicKey, currentSlot: await slotNow() }), [payer], { ext: ownerExt(w) });
  finding('H2', 'with the owner as role 0, the 7-day cap binds the session key and not the owner (the owner can add a longer role). The frozen variant below removes that.');
  // H3: id squatting
  const idX = crypto.getRandomValues(new Uint8Array(32));
  await send('H3a. an attacker creates a Swig at the id the app meant to use, with the attacker as root', true, [await getCreateSwigInstruction({ authorityInfo: createEd25519AuthorityInfo(atk.publicKey), id: idX, payer: payer.publicKey, actions: Actions.set().manageAuthority().get() })], [payer]);
  await send('H3b. the app creates its Swig at the same id', false, [await getCreateSwigInstruction({ authorityInfo: createEd25519AuthorityInfo(new PublicKey(PH.pub)), id: idX, payer: payer.publicKey, actions: Actions.set().manageAuthority().get() })], [payer], { want: /Swig|already/i });
  const sq = await fetchSwig(conn, findSwigPda(idX));
  record('H3c. the squatted Swig is owned by the attacker, so the app must read role 0 before the 2-of-3 lists a wallet address', true, sq.roles[0]!.authority.matchesSigner(atk.publicKey.toBytes()), 'role 0 = attacker');
  // H4: frozen variant: a throwaway root key creates the Swig, adds the owner's session role, then hands role 0 to the vault (a PDA that can never sign a top-level Swig instruction)
  const E = Keypair.generate(); const idF = crypto.getRandomValues(new Uint8Array(32)); const swF = findSwigPda(idF);
  const bF = getCreateSwigInstructionBuilder({ payer: payer.publicKey, swigAddress: swF, id: idF, actions: Actions.set().manageAuthority().get(), authorityInfo: createEd25519AuthorityInfo(E.publicKey), options: { currentSlot: await slotNow() } });
  bF.addAuthority(createEd25519SessionAuthorityInfo(new PublicKey(PH.pub), MAX_SLOTS), squadsOnly());
  const head = Buffer.alloc(16); head.writeUInt16LE(16, 0); head.writeUInt32LE(0, 4); head.writeUInt32LE(0, 8); head.writeUInt16LE(32, 12);
  const replace = new TransactionInstruction({ programId: SWIG, keys: [{ pubkey: swF, isSigner: false, isWritable: true }, { pubkey: E.publicKey, isSigner: true, isWritable: false }],
    data: Buffer.concat([head, A.vault.toBuffer(), Buffer.from([1])]) });
  await send('H4a. frozen variant: one transaction creates the Swig with a throwaway root key E, adds the owner session role, and replaces E with the vault address', true, [...await bF.getInstructions(), replace], [payer, E]);
  await measure('swig-setup-frozen');
  const fz = Object.assign({}, PH, { swig: swF, addr: walletAddress(swF), id: idF }) as Wallet;
  const fr0 = (await swigOf(fz)).roles[0]!;
  record('H4b. role 0 is now the vault address, not E', true, fr0.authority.matchesSigner(A.vault.toBytes()) && !fr0.authority.matchesSigner(E.publicKey.toBytes()), '');
  await send('H4c. E can no longer add an authority', false, swapKey(await getAddAuthorityInstructions(await swigOf(fz), 0, createEd25519AuthorityInfo(E.publicKey), Actions.set().all().get(), { payer: payer.publicKey }), A.vault, E.publicKey), [payer, E], { want: /Swig/ });
  await send('H4d. the owner cannot add a longer role (it holds no admin role)', false, swapKey(await getAddAuthorityInstructions(await swigOf(fz), 0, ownerInfo(PH, big), squadsOnly(), { payer: payer.publicKey }), A.vault, new PublicKey(PH.pub)), [payer], { ext: ownerExt(PH), want: /Swig/ });
  await send('H4e. the 2-of-3 cannot act as the admin either: Swig refuses any admin call that arrives by CPI', false, [vaultSync(A, [B.publicKey, phantom.publicKey],
    await getAddAuthorityInstructions(await swigOf(fz), 0, createEd25519AuthorityInfo(B.publicKey), Actions.set().all().get(), { payer: payer.publicKey }))], [payer, B, phantom], { want: /Cpi/ });
  const k4 = Keypair.generate(); await grant('H4f. the owner still starts sessions on the frozen Swig', fz, k4.publicKey, 300n);
  {
    // the same bootstrap for a secp256k1 owner: the throwaway root is an ed25519 key, the session role carries the MetaMask key as data (no signature needed)
    const E2 = Keypair.generate(); const idM = crypto.getRandomValues(new Uint8Array(32)); const swM = findSwigPda(idM);
    const bM = getCreateSwigInstructionBuilder({ payer: payer.publicKey, swigAddress: swM, id: idM, actions: Actions.set().manageAuthority().get(), authorityInfo: createEd25519AuthorityInfo(E2.publicKey), options: { currentSlot: await slotNow() } });
    bM.addAuthority(createSecp256k1SessionAuthorityInfo(MM.pub, MAX_SLOTS), squadsOnly());
    const repM = new TransactionInstruction({ programId: SWIG, keys: [{ pubkey: swM, isSigner: false, isWritable: true }, { pubkey: E2.publicKey, isSigner: true, isWritable: false }], data: Buffer.concat([head, A.vault.toBuffer(), Buffer.from([1])]) });
    await send('H4j. frozen variant for a MetaMask (secp256k1) owner: create, add the session role, hand role 0 to the vault, one transaction, no owner signature', true, [...await bM.getInstructions(), repM], [payer, E2]);
    const fm = Object.assign({}, MM, { swig: swM, addr: walletAddress(swM), id: idM }) as Wallet; const km = Keypair.generate();
    await grant('H4k. the MetaMask owner starts a session on the frozen Swig (one personal_sign)', fm, km.publicKey, 300n);
    record('H4l. the frozen MetaMask Swig has role 0 = the vault and the maximum from creation', true, (await swigOf(fm)).roles[0]!.authority.matchesSigner(A.vault.toBytes()) && (await swigRole1(fm)).maxDuration === MAX_SLOTS, '');
  }
  record('H4g. the frozen Swig keeps the maximum from the first transaction', true, (await swigRole1(fz)).maxDuration === MAX_SLOTS, `${(await swigRole1(fz)).maxDuration}`);
  const startAfter = await startIxs(fz, Keypair.generate().publicKey, 300n);
  const remF = asRole(await getRemoveAuthorityInstructions(await swigOf(fz), 0, 1, { payer: payer.publicKey }), A.vault, k4.publicKey, 8, 1);
  await send('H4h. frozen Swig: the session key removes its own role', true, remF, relayed(k4));
  await send('H4i. ...then the owner cannot start a session any more, and nobody can add the role back: the 2-of-3 must replace the Swig (new Swig, policy update)', false, startAfter, [payer], { ext: ownerExt(PH), want: /Swig/ });
}

// ── Z. Summary ──────────────────────────────────────────────────────────────────────────────────
{
  const spent = startBalance - (await conn.getBalance(payer.publicKey));
  metrics.relayerSpend = { spentLamports: spent, sessionKeysFunded: fundCount };
  if (NEAR) { metrics.mpc = nearMod.stats; console.log(`NEAR MPC signatures: ${nearMod.stats.calls}, average ${(nearMod.stats.ms / Math.max(1, nearMod.stats.calls) / 1000).toFixed(1)} s`); }
  save();
  console.log(`\n${results.filter((r) => r.pass).length}/${results.length} passed`);
  for (const r of results.filter((r) => !r.pass)) console.log('FAIL', r.name, r.detail);
}
process.exit(0);
