// Prime Account on Solana = Squads Smart Account (SMRT…) 2-of-3 + a ProgramInteraction policy for moves.
//   Settings signers (rule 0): A = owner seat (MetaMask -> NEAR eth-implicit MPC ed25519), B, C. Threshold 2.
//   Policy P1 (what movers may do): signers = three Swig wallets (PDAs), threshold 1:
//     W_mm: root = MetaMask (secp256k1), session role = MetaMask session, may only call the Smart Account program
//     W_ph: root = Phantom (ed25519),    session role = Phantom session, same limit
//     W_fr: root = K (NEAR MPC ed25519 key of Freighter's NEAR wallet account), session role on K, same limit
//   P1 allows: System transfer from the vault to VENUE or VENUE2, <= 0.05 SOL per transfer, <= 0.08 SOL per day.
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram, Transaction, sendAndConfirmTransaction, type TransactionInstruction } from '@solana/web3.js';
import * as sa from '@sqds/smart-account';
import { Actions, createEd25519AuthorityInfo, createEd25519SessionAuthorityInfo, createSecp256k1AuthorityInfo, createSecp256k1SessionAuthorityInfo,
  fetchSwig, findSwigPda, getAddAuthorityInstructions, getCreateSessionInstructions, getCreateSwigInstruction, getSignInstructions,
  getSwigWalletAddress, getEvmPersonalSignPrefix } from '@swig-wallet/classic';
import { hexToBytes } from 'viem';
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { payer, phantom, B, C, attacker, metamask } from './keys.ts';

const here = process.cwd(); process.chdir('/home/ubuntu/work/near-session-spike');
const { mpcSign: mmMpcSign, ethAccountId } = await import('/home/ubuntu/work/near-session-spike/mm.ts');
const { deriveEd25519 } = await import('/home/ubuntu/work/near-session-spike/near.ts');
process.chdir(here);

const conn = new Connection('http://127.0.0.1:8899', 'confirmed');
const SMRT = sa.PROGRAM_ID;
const STATE = 'state-sa.json';
const st: any = existsSync(STATE) ? JSON.parse(readFileSync(STATE, 'utf8')) : {};
const save = () => writeFileSync(STATE, JSON.stringify(st, null, 1));
const results: any[] = st.results ?? (st.results = []);
const pk = (k: string) => new PublicKey(st[k] ?? (st[k] = Keypair.generate().publicKey.toBase58()));
const VENUE = pk('venue'), VENUE2 = pk('venue2'), OTHER = pk('other');
const SOL = LAMPORTS_PER_SOL;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const short = (e: any) => { const s = String(e?.logs?.join(' ') ?? e?.message ?? e);
  const m = s.match(/Error Code: \w+/)?.[0] ? s.match(/Error Code: \w+/) : s.match(/(Error Message: [^.]*|custom program error: 0x[0-9a-f]+|Signature verification failed|missing required signature[^"]{0,40}|[A-Za-z]+Error[^"]{0,60})/i); return (m?.[0] ?? s).slice(0, 160); };
function record(name: string, expectOk: boolean, ok: boolean, detail: string, ms = 0) {
  const pass = ok === expectOk; results.push({ name, pass, ok, ms, detail }); save();
  console.log(`${pass ? 'PASS' : 'FAIL'} ${name} | ${ok ? `ok ${ms ? ms + 'ms ' : ''}${detail}` : `refused: ${detail}`}`);
  return ok;
}
async function send(name: string, expectOk: boolean, ixs: TransactionInstruction[] | (() => Promise<TransactionInstruction[]>), signers: Keypair[]) {
  const t0 = Date.now(); let ok = true, d = '';
  try { const list = typeof ixs === 'function' ? await ixs() : ixs; d = await sendAndConfirmTransaction(conn, new Transaction().add(...list), signers, { commitment: 'confirmed' }); }
  catch (e: any) { ok = false; d = short(e); if (e?.getLogs) try { d = short({ logs: await e.getLogs(conn) }); } catch {} }
  return record(name, expectOk, ok, d, Date.now() - t0);
}
/** Send a tx that needs one external ed25519 signature (`who`), produced by `signFn` over the message bytes. */
async function sendExt(name: string, expectOk: boolean, ixs: TransactionInstruction[], who: PublicKey, signFn: (m: Uint8Array) => Promise<Uint8Array>, extra: Keypair[] = []) {
  const tx = new Transaction().add(...ixs); tx.feePayer = payer.publicKey; tx.recentBlockhash = (await conn.getLatestBlockhash('confirmed')).blockhash;
  const sig = await signFn(tx.serializeMessage()); tx.addSignature(who, Buffer.from(sig)); tx.partialSign(payer, ...extra);
  const t0 = Date.now(); let ok = true, d = '';
  try { d = await conn.sendRawTransaction(tx.serialize()); await conn.confirmTransaction(d, 'confirmed'); const s = await conn.getSignatureStatus(d); if (s.value?.err) { ok = false; d = JSON.stringify(s.value.err); } }
  catch (e: any) { ok = false; d = short(e); }
  return record(name, expectOk, ok, d, Date.now() - t0);
}

// Owner seat A: MetaMask -> NEAR eth-implicit account -> MPC ed25519 (native NEAR, no contract).
const A_PATH = 'prime:sa-spike/solana-1';
const A = new PublicKey(await deriveEd25519(ethAccountId, A_PATH));
const signA = async (m: Uint8Array) => { const r = await mmMpcSign(m, A_PATH); console.log(`   MetaMask -> NEAR MPC signed for A in ${(r.ms / 1000).toFixed(1)}s`); return r.sig; };
// Freighter: SEP-53 request to NEAR wallet contract account 0s2ee0a8… -> MPC ed25519 key K.
const FR_ACCT = '0s2ee0a84eed813ebcaf80280ed3c8cbad311e52d5', FR_PATH = 'prime:sa-spike/freighter-1';
const K = new PublicKey(await deriveEd25519(FR_ACCT, FR_PATH));
const signK = async (m: Uint8Array) => {
  const near = JSON.parse(readFileSync('/home/ubuntu/work/near-session-spike/secrets/near.json', 'utf8')); const t0 = Date.now();
  const out = execFileSync('/home/ubuntu/work/near-wallet-spike/intents/target/debug/examples/spike', [], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, NEAR_NETWORK: 'testnet', NEAR_ACCOUNT_ID: near.accountId, NEAR_PRIVATE_KEY: near.secret,
      SEP53_CODE_HASH: '5LVYEYWkNFZ9FM86Ge7RAVDjL3zzoYMfNnbRGdU2HgKQ', SPIKE_PATH: FR_PATH, SPIKE_SIGN_HEX: Buffer.from(m).toString('hex') } });
  console.log(`   Freighter (SEP-53) -> NEAR wallet contract -> MPC signed for K in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  return Buffer.from(out.match(/SIG ([0-9a-f]{128})/)![1]!, 'hex');
};
const mmSign = async (m: Uint8Array) => ({ signature: hexToBytes(await metamask.signMessage({ message: { raw: m } })), prefix: getEvmPersonalSignPrefix(m.length) });
const slot = async () => BigInt(await conn.getSlot('confirmed'));
const transfer = (from: PublicKey, to: PublicKey, lamports: number) => SystemProgram.transfer({ fromPubkey: from, toPubkey: to, lamports });

const settings = () => new PublicKey(st.settings);
const vault = () => sa.getSmartAccountPda({ settingsPda: settings(), accountIndex: 0 })[0];
const ALL = { mask: 7 };
const settingsSync = (actions: any[], signers: PublicKey[], remaining: PublicKey[] = [], rentPayer = payer.publicKey) => sa.instructions.executeSettingsTransactionSync({
  settingsPda: settings(), signers, actions, feePayer: rentPayer, remainingAccounts: remaining.map((p) => ({ pubkey: p, isWritable: true, isSigner: false })) });
const policyPayload = (cap = 0.08): any => ({ __kind: 'ProgramInteraction', fields: [{
  accountIndex: 0, preHook: null, postHook: null,
  instructionsConstraints: [{
    programId: SystemProgram.programId,
    accountConstraints: [{ accountIndex: 1, accountConstraint: { __kind: 'Pubkey', fields: [[VENUE, VENUE2]] }, owner: null }],
    dataConstraints: [
      { dataOffset: 0, dataValue: { __kind: 'U32Le', fields: [2] }, operator: sa.generated.DataOperator.Equals }, // System Transfer
      { dataOffset: 4, dataValue: { __kind: 'U64Le', fields: [0.05 * SOL] }, operator: sa.generated.DataOperator.LessThanOrEqualTo },
    ],
  }],
  spendingLimits: [{ mint: PublicKey.default, timeConstraints: { start: 0, expiration: null, period: { __kind: 'Daily' } }, quantityConstraints: { maxPerPeriod: cap * SOL } }],
}] });
const nextPolicy = async () => {
  const s = await sa.accounts.Settings.fromAccountAddress(conn, settings());
  const seed = Number(s.policySeed ?? 0) + 1; return { seed, pda: sa.getPolicyPda({ settingsPda: settings(), policySeed: seed })[0] };
};
/** The policy move instruction: `signer` (a Swig wallet PDA or a key) asks policy `policy` to run `ixs` from the vault. */
const policyMove = (policy: PublicKey, signer: PublicKey, ixs: TransactionInstruction[]) => {
  const d = sa.utils.instructionsToSynchronousTransactionDetailsV2({ vaultPda: vault(), members: [signer], transaction_instructions: ixs });
  return sa.instructions.executePolicyPayloadSync({ policy, accountIndex: 0, numSigners: 1, instruction_accounts: d.accounts,
    policyPayload: { __kind: 'ProgramInteraction', fields: [{ instructionConstraintIndices: new Uint8Array(ixs.map(() => 0)),
      transactionPayload: { __kind: 'SyncTransaction', fields: [{ accountIndex: 0, instructions: d.instructions }] } }] } });
};
const swigW = async (k: string) => fetchSwig(conn, findSwigPda(Buffer.from(st[k + 'Id'], 'hex')));
/** Session key -> Swig wallet W -> Smart Account policy move. */
const viaSession = async (k: string, sk: Keypair, inner: TransactionInstruction[]) => {
  const w = await swigW(k); const role = w.findRoleBySessionKey(sk.publicKey)!;
  return getSignInstructions(w, role.id, inner, false, { payer: sk.publicKey });
};
const balance = async (p: PublicKey) => conn.getBalance(p);
const fundedKey = async (label: string) => { const sk = Keypair.generate(); await send(`${label}: fund session key (fees only)`, true, [transfer(payer.publicKey, sk.publicKey, 0.01 * SOL)], [payer]); return sk; };

const part = process.argv[2];
if (part === 'setup') {
  if ((await balance(payer.publicKey)) < 50 * SOL) await conn.confirmTransaction(await conn.requestAirdrop(payer.publicKey, 100 * SOL));
  console.log({ A: A.toBase58(), owner: ethAccountId, K: K.toBase58(), freighterNear: FR_ACCT, B: B.publicKey.toBase58(), C: C.publicKey.toBase58() });
  if (!st.settings) {
    const pc = await sa.accounts.ProgramConfig.fromAccountAddress(conn, sa.getProgramConfigPda({})[0]);
    const [settingsPda] = sa.getSettingsPda({ accountIndex: BigInt(pc.smartAccountIndex.toString()) + 1n });
    await send('S1. create Smart Account: signers A (MetaMask via NEAR), B, C; threshold 2; no settings authority', true, [sa.instructions.createSmartAccount({
      treasury: pc.treasury, creator: payer.publicKey, settings: settingsPda, settingsAuthority: null, threshold: 2, timeLock: 0, rentCollector: null,
      signers: [{ key: A, permissions: ALL }, { key: B.publicKey, permissions: ALL }, { key: C.publicKey, permissions: ALL }] })], [payer]);
    st.settings = settingsPda.toBase58(); st.vault = vault().toBase58(); save();
    await send('S2. fund vault 1 SOL', true, [transfer(payer.publicKey, vault(), 1 * SOL)], [payer]);
  }
  const mkSwig = async (k: string, label: string, root: any, signers: Keypair[]) => {
    if (st[k + 'Id']) return;
    const id = crypto.getRandomValues(new Uint8Array(32)); st[k + 'Id'] = Buffer.from(id).toString('hex'); save();
    await send(`${label}: create Swig wallet`, true, [await getCreateSwigInstruction({ authorityInfo: root, id, payer: payer.publicKey, actions: Actions.set().all().get() })], signers);
    st[k] = (await getSwigWalletAddress(await swigW(k))).toBase58(); save();
  };
  const smrtOnly = () => Actions.set().programLimit({ programId: SMRT }).get();
  await mkSwig('wmm', 'S3. W_mm (root = MetaMask)', createSecp256k1AuthorityInfo(hexToBytes(metamask.publicKey)), [payer]);
  if (st.wmmRole === undefined) {
    await send('S3a. MetaMask (root, one personal_sign) adds its SESSION role on W_mm: may only call the Smart Account program', true,
      async () => getAddAuthorityInstructions(await swigW('wmm'), 0, createSecp256k1SessionAuthorityInfo(hexToBytes(metamask.publicKey), 300n), smrtOnly(),
        { payer: payer.publicKey, currentSlot: await slot(), signingFn: mmSign }), [payer]);
    st.wmmRole = (await swigW('wmm')).roles.at(-1)!.id; save();
  }
  await mkSwig('wph', 'S4. W_ph (root = Phantom)', createEd25519AuthorityInfo(phantom.publicKey), [payer]);
  if (st.wphRole === undefined) {
    await send('S4a. Phantom (root) adds its SESSION role on W_ph (Smart Account program only)', true,
      async () => getAddAuthorityInstructions(await swigW('wph'), 0, createEd25519SessionAuthorityInfo(phantom.publicKey, 300n), smrtOnly(), { payer: payer.publicKey }), [payer, phantom]);
    st.wphRole = (await swigW('wph')).roles.at(-1)!.id; save();
  }
  await mkSwig('wfr', 'S5. W_fr (root = K, the NEAR MPC key Freighter controls)', createEd25519AuthorityInfo(K), [payer]);
  if (st.wfrRole === undefined) {
    const ixs = await getAddAuthorityInstructions(await swigW('wfr'), 0, createEd25519SessionAuthorityInfo(K, 300n), smrtOnly(), { payer: payer.publicKey });
    if (await sendExt('S5a. K (Freighter via NEAR) adds its SESSION role on W_fr (Smart Account program only)', true, ixs, K, signK))
      { st.wfrRole = (await swigW('wfr')).roles.at(-1)!.id; save(); }
  }
  console.log({ settings: st.settings, vault: st.vault, W_mm: st.wmm, W_ph: st.wph, W_fr: st.wfr });
}
if (part === 'policy') {
  const { seed, pda } = await nextPolicy();
  const create = (signersOfPolicy: PublicKey[]) => ({ __kind: 'PolicyCreate', seed, policyCreationPayload: policyPayload(),
    signers: signersOfPolicy.map((key) => ({ key, permissions: ALL })), threshold: 1, timeLock: 0, startTimestamp: null,
    expirationArgs: { __kind: 'Timestamp', fields: [Math.floor(Date.now() / 1000) + 7 * 86400] } });
  const W = [new PublicKey(st.wmm), new PublicKey(st.wph), new PublicKey(st.wfr)];
  await send('P0. B alone installs the policy (1 of 2)', false, [settingsSync([create(W)], [B.publicKey], [pda])], [payer, B]);
  await send('P0b. attacker + B install a policy', false, [settingsSync([create([attacker.publicKey])], [B.publicKey, attacker.publicKey], [pda])], [payer, B, attacker]);
  const t0 = Date.now();
  const ok = await sendExt('P1. A (MetaMask via NEAR) + B install policy P1: signers W_mm, W_ph, W_fr (Swig wallet PDAs), threshold 1, 7-day expiry', true,
    [settingsSync([create(W)], [A, B.publicKey], [pda])], A, signA, [B]);
  void t0;
  if (ok) { st.p1 = pda.toBase58(); save(); }
  const p = await sa.accounts.Policy.fromAccountAddress(conn, pda);
  record('P2. policy P1 on chain: 3 signers, threshold 1', true, p.signers.length === 3 && p.threshold === 1, `signers ${p.signers.map((s: any) => s.key.toBase58().slice(0, 6)).join(',')}`);
}
if (part === 'mm') {
  const P1 = new PublicKey(st.p1), W = new PublicKey(st.wmm);
  const sk = await fundedKey('M0');
  await send('M1. MetaMask opens a session on W_mm (one personal_sign, 200 slots)', true,
    async () => getCreateSessionInstructions(await swigW('wmm'), st.wmmRole, sk.publicKey, 200n, { currentSlot: await slot(), signingFn: mmSign, payer: payer.publicKey }), [payer]);
  const before = await balance(VENUE);
  await send('M2. session key alone -> W_mm -> policy P1: 0.01 SOL vault -> VENUE', true, () => viaSession('wmm', sk, [policyMove(P1, W, [transfer(vault(), VENUE, 0.01 * SOL)])]), [sk]);
  record('M2b. VENUE got exactly 0.01 SOL from the vault', true, (await balance(VENUE)) - before === 0.01 * SOL, `${((await balance(VENUE)) - before) / SOL} SOL`);
  await send('M3. same path: 0.01 SOL to VENUE2 (also allowed)', true, () => viaSession('wmm', sk, [policyMove(P1, W, [transfer(vault(), VENUE2, 0.01 * SOL)])]), [sk]);
  await send('M4. same path: 0.01 SOL to another address', false, () => viaSession('wmm', sk, [policyMove(P1, W, [transfer(vault(), OTHER, 0.01 * SOL)])]), [sk]);
  await send('M5. same path: 0.06 SOL to VENUE (over 0.05 per transfer)', false, () => viaSession('wmm', sk, [policyMove(P1, W, [transfer(vault(), VENUE, 0.06 * SOL)])]), [sk]);
  await send('M6. same path: 0.05 SOL to VENUE (0.02 + 0.05 = 0.07, under 0.08/day)', true, () => viaSession('wmm', sk, [policyMove(P1, W, [transfer(vault(), VENUE, 0.05 * SOL)])]), [sk]);
  await send('M7. same path: 0.02 SOL to VENUE (0.09 > 0.08/day)', false, () => viaSession('wmm', sk, [policyMove(P1, W, [transfer(vault(), VENUE, 0.02 * SOL)])]), [sk]);
  await send('M8. session key: plain transfer out of W_mm (not the Smart Account program)', false, () => viaSession('wmm', sk, [transfer(W, OTHER, 1000)]), [sk]);
  await send('M9. session key -> W_mm tries to change settings (add itself as a 2-of-3 signer)', false,
    () => viaSession('wmm', sk, [settingsSync([{ __kind: 'AddSigner', newSigner: { key: W, permissions: ALL } }], [W], [], W)]), [sk]);
  const { pda } = await nextPolicy();
  await send('M10. session key -> W_mm tries to install its own wider policy', false,
    () => viaSession('wmm', sk, [settingsSync([{ __kind: 'PolicyCreate', seed: 99, policyCreationPayload: policyPayload(), signers: [{ key: W, permissions: ALL }], threshold: 1, timeLock: 0, startTimestamp: null, expirationArgs: null }], [W], [pda], W)]), [sk]);
  await send('M11. MetaMask session key signs the policy move directly (not through W)', false, [policyMove(P1, sk.publicKey, [transfer(vault(), VENUE, 1000)])], [sk]);

}
if (part === 'mm2') {
  // M9/M10 again with W as rent payer, so the only missing authority is the 2-of-3 itself.
  const W = new PublicKey(st.wmm);
  const sk = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync('secrets/sa-mm-session.json', 'utf8'))));
  await send('M9r. session key -> W_mm tries to change settings (add W_mm as a 2-of-3 signer; W pays rent)', false,
    () => viaSession('wmm', sk, [settingsSync([{ __kind: 'AddSigner', newSigner: { key: W, permissions: ALL } }], [W], [], W)]), [sk]);
  const { seed, pda } = await nextPolicy();
  await send('M10r. session key -> W_mm tries to install its own wider policy (W pays rent)', false,
    () => viaSession('wmm', sk, [settingsSync([{ __kind: 'PolicyCreate', seed, policyCreationPayload: policyPayload(), signers: [{ key: W, permissions: ALL }], threshold: 1, timeLock: 0, startTimestamp: null, expirationArgs: null }], [W], [pda], W)]), [sk]);
}
if (part === 'phantom') {
  const P1 = new PublicKey(st.p1), W = new PublicKey(st.wph);
  const sk = await fundedKey('H0');
  await send('H1. Phantom opens a session on W_ph (signs one Solana tx)', true,
    async () => getCreateSessionInstructions(await swigW('wph'), st.wphRole, sk.publicKey, 200n, { currentSlot: await slot(), payer: payer.publicKey }), [payer, phantom]);
  await send('H2. Phantom session -> W_ph -> P1: 0.005 SOL to VENUE', true, () => viaSession('wph', sk, [policyMove(P1, W, [transfer(vault(), VENUE, 0.005 * SOL)])]), [sk]);
  await send('H3. same path: 0.005 SOL to another address', false, () => viaSession('wph', sk, [policyMove(P1, W, [transfer(vault(), OTHER, 0.005 * SOL)])]), [sk]);
  await send('H4. Phantom session tries to use W_mm (the MetaMask wallet) as the policy signer', false,
    () => viaSession('wph', sk, [policyMove(P1, new PublicKey(st.wmm), [transfer(vault(), VENUE, 1000)])]), [sk]);
}
if (part === 'freighter') {
  const P1 = new PublicKey(st.p1), W = new PublicKey(st.wfr);
  const sk = await fundedKey('F0');
  const ixs = await getCreateSessionInstructions(await swigW('wfr'), st.wfrRole, sk.publicKey, 200n, { currentSlot: await slot(), payer: payer.publicKey });
  await sendExt('F1. Freighter opens a session on W_fr (one SEP-53 signature -> NEAR wallet contract -> MPC signs the Solana tx)', true, ixs, K, signK);
  await send('F2. Freighter session -> W_fr -> P1: 0.005 SOL to VENUE2', true, () => viaSession('wfr', sk, [policyMove(P1, W, [transfer(vault(), VENUE2, 0.005 * SOL)])]), [sk]);
  await send('F3. same path: 0.005 SOL to another address', false, () => viaSession('wfr', sk, [policyMove(P1, W, [transfer(vault(), OTHER, 0.005 * SOL)])]), [sk]);
  const ixs2 = await getCreateSessionInstructions(await swigW('wfr'), st.wfrRole, Keypair.generate().publicKey, 200n, { currentSlot: await slot(), payer: payer.publicKey });
  const fake = Keypair.generate();
  await sendExt('F4. a session on W_fr signed by some other ed25519 key', false, ixs2, K, async (m) => nacl.sign.detached(m, fake.secretKey));
}
if (part === 'attacks' || part === 'x3') {
  const P1 = new PublicKey(st.p1);
  if (part === 'attacks') await send('X1. attacker signs a policy move as itself', false, [policyMove(P1, attacker.publicKey, [transfer(vault(), VENUE, 1000)])], [payer, attacker]);
  if (part === 'attacks') await send('X2. B (a 2-of-3 signer, not a policy signer) signs a policy move alone', false, [policyMove(P1, B.publicKey, [transfer(vault(), VENUE, 1000)])], [payer, B]);
  await send('X3. B + C together: plain vault transfer of 0.01 SOL to OTHER outside any policy (sync 2-of-3)', true, async () => {
    const d = sa.utils.instructionsToSynchronousTransactionDetailsV2({ vaultPda: vault(), members: [B.publicKey, C.publicKey], transaction_instructions: [transfer(vault(), OTHER, 0.01 * SOL)] });
    return [sa.instructions.executeTransactionSyncV2({ settingsPda: settings(), numSigners: 2, accountIndex: 0, instructions: d.instructions, instruction_accounts: d.accounts } as any)];
  }, [payer, B, C]);
}
if (part === 'revoke') {
  const P1 = new PublicKey(st.p1);
  const sk = await fundedKey('R');
  await send('R-a. MetaMask opens a fresh session (300 slots)', true, async () => getCreateSessionInstructions(await swigW('wmm'), st.wmmRole, sk.publicKey, 300n, { currentSlot: await slot(), signingFn: mmSign, payer: payer.publicKey }), [payer]);
  await send('R0. daily cap is shared: M 0.07 + H 0.005 + F 0.005 = 0.08 used; MetaMask session +0.001 SOL', false, () => viaSession('wmm', sk, [policyMove(P1, new PublicKey(st.wmm), [transfer(vault(), VENUE, 0.001 * SOL)])]), [sk]);
  await send('R1. B + C update P1: signers W_ph, W_fr (drop W_mm), cap raised to 0.2 SOL/day', true, [settingsSync([{ __kind: 'PolicyUpdate', policy: P1,
    signers: [new PublicKey(st.wph), new PublicKey(st.wfr)].map((key) => ({ key, permissions: ALL })), threshold: 1, timeLock: 0,
    policyUpdatePayload: policyPayload(0.2), expirationArgs: { __kind: 'Timestamp', fields: [Math.floor(Date.now() / 1000) + 7 * 86400] } }], [B.publicKey, C.publicKey], [P1])], [payer, B, C]);
  await send('R2. the MetaMask session (unexpired) after W_mm was dropped from P1', false, () => viaSession('wmm', sk, [policyMove(P1, new PublicKey(st.wmm), [transfer(vault(), VENUE, 1000)])]), [sk]);
  const sk2 = await fundedKey('R3');
  await send('R3a. Phantom session', true, async () => getCreateSessionInstructions(await swigW('wph'), st.wphRole, sk2.publicKey, 200n, { currentSlot: await slot(), payer: payer.publicKey }), [payer, phantom]);
  await send('R3b. Phantom still moves after the update (0.01 SOL)', true, () => viaSession('wph', sk2, [policyMove(P1, new PublicKey(st.wph), [transfer(vault(), VENUE, 0.01 * SOL)])]), [sk2]);
  await send('R4. B + C remove P1 (kill switch)', true, [settingsSync([{ __kind: 'PolicyRemove', policy: P1 }], [B.publicKey, C.publicKey], [P1])], [payer, B, C]);
  await send('R5. Phantom session after P1 was removed', false, () => viaSession('wph', sk2, [policyMove(P1, new PublicKey(st.wph), [transfer(vault(), VENUE, 1000)])]), [sk2]);

}
if (part === 'revoke2') {
  // Redo of R0/R2 with a fresh MetaMask session (the first one had expired: Swig 0xbc6 SessionExpired).
  const { seed, pda } = await nextPolicy(); const Wmm = new PublicKey(st.wmm), Wph = new PublicKey(st.wph);
  await send('V1. B + C install P3: signers W_mm, W_ph; cap 0.02 SOL/day', true, [settingsSync([{ __kind: 'PolicyCreate', seed, policyCreationPayload: policyPayload(0.02),
    signers: [Wmm, Wph].map((key) => ({ key, permissions: ALL })), threshold: 1, timeLock: 0, startTimestamp: null,
    expirationArgs: { __kind: 'Timestamp', fields: [Math.floor(Date.now() / 1000) + 86400] } }], [B.publicKey, C.publicKey], [pda])], [payer, B, C]);
  const mm = await fundedKey('V2'), ph = await fundedKey('V3');
  await send('V2a. MetaMask session (300 slots)', true, async () => getCreateSessionInstructions(await swigW('wmm'), st.wmmRole, mm.publicKey, 300n, { currentSlot: await slot(), signingFn: mmSign, payer: payer.publicKey }), [payer]);
  await send('V3a. Phantom session (300 slots)', true, async () => getCreateSessionInstructions(await swigW('wph'), st.wphRole, ph.publicKey, 300n, { currentSlot: await slot(), payer: payer.publicKey }), [payer, phantom]);
  await send('V4. MetaMask: 0.015 SOL to VENUE', true, () => viaSession('wmm', mm, [policyMove(pda, Wmm, [transfer(vault(), VENUE, 0.015 * SOL)])]), [mm]);
  await send('V5. Phantom: 0.01 SOL to VENUE (0.025 > 0.02/day, cap shared by all movers)', false, () => viaSession('wph', ph, [policyMove(pda, Wph, [transfer(vault(), VENUE, 0.01 * SOL)])]), [ph]);
  await send('V6. Phantom: 0.005 SOL to VENUE (0.02, exactly the cap)', true, () => viaSession('wph', ph, [policyMove(pda, Wph, [transfer(vault(), VENUE, 0.005 * SOL)])]), [ph]);
  await send('V7. B + C update P3: drop W_mm, cap 0.2/day', true, [settingsSync([{ __kind: 'PolicyUpdate', policy: pda, signers: [{ key: Wph, permissions: ALL }], threshold: 1, timeLock: 0,
    policyUpdatePayload: policyPayload(0.2), expirationArgs: { __kind: 'Timestamp', fields: [Math.floor(Date.now() / 1000) + 86400] } }], [B.publicKey, C.publicKey], [pda])], [payer, B, C]);
  await send('V8. MetaMask session (still valid) after W_mm was dropped: 0.001 SOL', false, () => viaSession('wmm', mm, [policyMove(pda, Wmm, [transfer(vault(), VENUE, 0.001 * SOL)])]), [mm]);
  await send('V9. Phantom after the update: 0.01 SOL', true, () => viaSession('wph', ph, [policyMove(pda, Wph, [transfer(vault(), VENUE, 0.01 * SOL)])]), [ph]);
  await send('V10. MetaMask session, same session, outside any policy: SMRT settings change', false, () => viaSession('wmm', mm, [settingsSync([{ __kind: 'ChangeThreshold', newThreshold: 1 }], [Wmm], [], Wmm)]), [mm]);
  st.p3 = pda.toBase58(); save();
}
if (part === 'expiry') {
  const { seed, pda } = await nextPolicy(); const W = new PublicKey(st.wph);
  await send('E1. B + C install P2 (W_ph only) that expires in 20 s', true, [settingsSync([{ __kind: 'PolicyCreate', seed, policyCreationPayload: policyPayload(),
    signers: [{ key: W, permissions: ALL }], threshold: 1, timeLock: 0, startTimestamp: null,
    expirationArgs: { __kind: 'Timestamp', fields: [Math.floor(Date.now() / 1000) + 20] } }], [B.publicKey, C.publicKey], [pda])], [payer, B, C]);
  const sk = await fundedKey('E2');
  await send('E2a. Phantom session', true, async () => getCreateSessionInstructions(await swigW('wph'), st.wphRole, sk.publicKey, 300n, { currentSlot: await slot(), payer: payer.publicKey }), [payer, phantom]);
  await send('E3. move through P2 before expiry', true, () => viaSession('wph', sk, [policyMove(pda, W, [transfer(vault(), VENUE, 1000)])]), [sk]);
  await sleep(25000);
  await send('E4. same move after P2 expired (session itself still valid)', false, () => viaSession('wph', sk, [policyMove(pda, W, [transfer(vault(), VENUE, 1000)])]), [sk]);
  await send('E5. B + C change the settings (rotate C -> C2 keeps working with 2-of-3)', true, [settingsSync([{ __kind: 'RemoveSigner', oldSigner: C.publicKey }, { __kind: 'AddSigner', newSigner: { key: Keypair.generate().publicKey, permissions: ALL } }], [B.publicKey, C.publicKey])], [payer, B, C]);
}
if (part === 'summary') {
  const pass = results.filter((r) => r.pass).length; console.log(`${pass}/${results.length} passed`);
  for (const r of results.filter((r) => !r.pass)) console.log('FAIL', r.name, r.detail);
}

process.exit(0);
