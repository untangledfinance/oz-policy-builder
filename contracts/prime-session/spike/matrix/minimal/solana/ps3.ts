// Round 2: prime-session v2 (cluster + program in the grant, revoke, Smart-Account-only target). Derived from ps.ts.
// Is NEAR (or Swig) necessary on Solana? prime-session (our ~150-line program) checks each wallet's grant with
// Solana's own signature programs and signs as a PDA, so MetaMask, Freighter and Phantom each hold a 2-of-3 seat
// AND open sessions on a Squads Smart Account with no NEAR and no Swig.
//   PDA_x = ["prime", kind, owner]: MetaMask (secp256k1 personal_sign), Freighter (ed25519 SEP-53), Phantom (ed25519 text)
import { Connection, Ed25519Program, Keypair, LAMPORTS_PER_SOL, PublicKey, Secp256k1Program, SystemProgram, SYSVAR_INSTRUCTIONS_PUBKEY, Transaction,
  TransactionInstruction, TransactionMessage, sendAndConfirmTransaction } from '@solana/web3.js';
import * as sa from '@sqds/smart-account';
import { Actions, createSecp256k1AuthorityInfo, createSecp256k1SessionAuthorityInfo, fetchSwig, findSwigPda, getAddAuthorityInstructions,
  getCreateSessionInstructions, getCreateSwigInstruction, getSignInstructions, getSwigWalletAddress, getEvmPersonalSignPrefix } from '@swig-wallet/classic';
import { hexToBytes, sha256 as vsha256 } from 'viem';
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { payer, B, C, metamask } from './keys.ts';
const { Keypair: StellarKeypair } = await import('/home/ubuntu/work/near-session-spike/node_modules/@stellar/stellar-sdk/lib/index.js');

const conn = new Connection('http://127.0.0.1:8899', 'confirmed');
const PROG = new PublicKey('FTNMFWiECbRp7D5MwJUiNQfee6NuJPjE7S11J9yc2B9G'); // v2
const CLUSTER = 'localnet';
const STATE = 'state-ps3.json';
const st: any = existsSync(STATE) ? JSON.parse(readFileSync(STATE, 'utf8')) : {};
const save = () => writeFileSync(STATE, JSON.stringify(st, null, 1));
const results: any[] = st.results ?? (st.results = []);
const SOL = LAMPORTS_PER_SOL;
const pkey = (k: string) => new PublicKey(st[k] ?? (st[k] = Keypair.generate().publicKey.toBase58()));
const VENUE = pkey('venue'), OTHER = pkey('other'), DEST = pkey('dest');
const short = (e: any) => { const s = String(e?.logs?.join(' ') ?? e?.message ?? e);
  return ((s.match(/prime-session: [^"]*?(?= Program|$)/) ?? s.match(/Error Code: \w+/) ?? s.match(/(custom program error: 0x[0-9a-f]+|Signature verification failed|[A-Za-z]+Error[^"]{0,60})/i))?.[0] ?? s).slice(0, 160); };
function record(name: string, expectOk: boolean, ok: boolean, detail: string) {
  const pass = ok === expectOk; results.push({ name, pass, ok, detail }); save();
  console.log(`${pass ? 'PASS' : 'FAIL'} ${name} | ${ok ? `ok ${detail}` : `refused: ${detail}`}`);
  return ok;
}
async function send(name: string, expectOk: boolean, ixs: TransactionInstruction[], signers: Keypair[]) {
  let ok = true, d = '';
  try { d = await sendAndConfirmTransaction(conn, new Transaction().add(...ixs), signers, { commitment: 'confirmed' }); }
  catch (e: any) { ok = false; d = short(e); if (e?.getLogs) try { d = short({ logs: await e.getLogs(conn) }); } catch {} }
  return record(name, expectOk, ok, d);
}

// ── Wallets ────────────────────────────────────────────────────────────────
type Kind = 0 | 1 | 2;
type Owner = { name: string; kind: Kind; owner: Buffer; signText: (t: string) => Promise<Buffer> };
const FREIGHTER_FILE = '/home/ubuntu/work/near-wallet-spike/secrets/freighter-b.json';
const frKp = StellarKeypair.fromSecret(JSON.parse(readFileSync(FREIGHTER_FILE, 'utf8')).secret);
const phSecret = bs58.decode(JSON.parse(readFileSync('/home/ubuntu/work/phantom-spike/secrets/phantom-test.json', 'utf8')).secret);
const ph = nacl.sign.keyPair.fromSecretKey(phSecret.length === 64 ? phSecret : nacl.sign.keyPair.fromSeed(phSecret).secretKey);
const MM: Owner = { name: 'MetaMask', kind: 0, owner: Buffer.from(metamask.address.slice(2), 'hex'), signText: async (t) => Buffer.from(hexToBytes(await metamask.signMessage({ message: t }))) };
const FR: Owner = { name: 'Freighter', kind: 1, owner: Buffer.from(frKp.rawPublicKey()), signText: async (t) => { // Freighter signMessage (SEP-53) code path
  const d = mkdtempSync(`${tmpdir()}/fsign-`); writeFileSync(`${d}/m.txt`, t);
  try { return Buffer.from(execFileSync('bun', ['freighter-sign.ts', FREIGHTER_FILE, `${d}/m.txt`], { cwd: '/home/ubuntu/work/near-session-spike', encoding: 'utf8' }), 'base64'); } finally { rmSync(d, { recursive: true }); } } };
const PH: Owner = { name: 'Phantom', kind: 2, owner: Buffer.from(ph.publicKey), signText: async (t) => process.env.REAL_PHANTOM
  ? Buffer.from((await import('/home/ubuntu/work/phantom-spike/bridge-sign.ts')).realPhantomSign(t)) : Buffer.from(nacl.sign.detached(Buffer.from(t, 'utf8'), ph.secretKey)) };
const pdaOf = (o: Owner) => PublicKey.findProgramAddressSync([Buffer.from('prime'), Buffer.from([o.kind]), o.owner], PROG)[0];
const grantText = (pda: PublicKey, key: PublicKey, until: number, cluster = CLUSTER, program = PROG) => `Prime session\nsigner: ${pda.toBase58()}\nsession key: ${key.toBase58()}\nvalid until (unix time): ${until}\ncluster: ${cluster}\nprogram: ${program.toBase58()}`;
const revokeText = (pda: PublicKey, key: PublicKey) => grantText(pda, key, 0); // revoking = the grant text with valid until 0
const markerOf = (pda: PublicKey, key: PublicKey) => PublicKey.findProgramAddressSync([Buffer.from('revoked'), pda.toBuffer(), key.toBuffer()], PROG)[0];

type Session = { o: Owner; key: Keypair; until: number; pda: PublicKey; sigIx: TransactionInstruction };
/** The wallet signs one grant; the matching signature-program instruction is rebuilt for every transaction. */
async function openSession(o: Owner, seconds = 3600, opt: { pda?: PublicKey; signAs?: Owner; text?: (t: string) => string } = {}): Promise<Session> {
  const key = Keypair.generate(); const until = Math.floor(Date.now() / 1000) + seconds; const pda = opt.pda ?? pdaOf(o);
  const text = (opt.text ?? ((t) => t))(grantText(pda, key.publicKey, until));
  const sig = await (opt.signAs ?? o).signText(text);
  let sigIx: TransactionInstruction;
  if (o.kind === 0) {
    const m = Buffer.concat([Buffer.from(getEvmPersonalSignPrefix(Buffer.byteLength(text))), Buffer.from(text)]);
    sigIx = Secp256k1Program.createInstructionWithEthAddress({ ethAddress: o.owner, message: m, signature: sig.subarray(0, 64), recoveryId: sig[64]! - 27, instructionIndex: 0 });
  } else {
    const m = o.kind === 1 ? Buffer.from(hexToBytes(vsha256(Buffer.concat([Buffer.from('Stellar Signed Message:\n'), Buffer.from(text)])))) : Buffer.from(text);
    sigIx = Ed25519Program.createInstructionWithPublicKey({ publicKey: (opt.signAs ?? o).owner, message: m, signature: sig });
  }
  await conn.confirmTransaction(await conn.requestAirdrop(key.publicKey, 0.05 * SOL));
  return { o, key, until, pda, sigIx };
}
/** [signature program ix, prime-session execute(inner)] signed by the session key alone. */
function viaSession(s: Session, inner: TransactionInstruction, o: { until?: number; owner?: Owner } = {}): TransactionInstruction[] {
  const ow = o.owner ?? s.o;
  const head = Buffer.concat([Buffer.from([0, ow.kind]), ow.owner, Buffer.from(new BigInt64Array([BigInt(o.until ?? s.until)]).buffer), Buffer.from([0])]);
  const keys = [{ pubkey: SYSVAR_INSTRUCTIONS_PUBKEY, isSigner: false, isWritable: false }, { pubkey: s.key.publicKey, isSigner: true, isWritable: true },
    { pubkey: s.pda, isSigner: false, isWritable: false }, { pubkey: markerOf(s.pda, s.key.publicKey), isSigner: false, isWritable: false }, { pubkey: inner.programId, isSigner: false, isWritable: false },
    ...inner.keys.map((k) => ({ ...k, isSigner: k.pubkey.equals(s.pda) ? false : k.isSigner }))];
  return [s.sigIx, new TransactionInstruction({ programId: PROG, keys, data: Buffer.concat([head, inner.data]) })];
}

async function sigIxFor(o: Owner, text: string): Promise<TransactionInstruction> {
  const sig = await o.signText(text);
  if (o.kind === 0) { const m = Buffer.concat([Buffer.from(getEvmPersonalSignPrefix(Buffer.byteLength(text))), Buffer.from(text)]);
    return Secp256k1Program.createInstructionWithEthAddress({ ethAddress: o.owner, message: m, signature: sig.subarray(0, 64), recoveryId: sig[64]! - 27, instructionIndex: 0 }); }
  const m = o.kind === 1 ? Buffer.from(hexToBytes(vsha256(Buffer.concat([Buffer.from('Stellar Signed Message:\n'), Buffer.from(text)])))) : Buffer.from(text);
  return Ed25519Program.createInstructionWithPublicKey({ publicKey: o.owner, message: m, signature: sig });
}
async function revokeIxs(o: Owner, key: PublicKey, signAs?: Owner) {
  const pda = pdaOf(o); const sigIx = await sigIxFor(signAs ?? o, revokeText(pda, key));
  if (signAs && signAs.kind !== 0) (sigIx as any).data = sigIx.data; // signed by another key: the ed25519 program checks that key
  return [sigIx, new TransactionInstruction({ programId: PROG, data: Buffer.concat([Buffer.from([1, o.kind]), o.owner, Buffer.from([0]), key.toBuffer()]),
    keys: [{ pubkey: SYSVAR_INSTRUCTIONS_PUBKEY, isSigner: false, isWritable: false }, { pubkey: payer.publicKey, isSigner: true, isWritable: true },
      { pubkey: pda, isSigner: false, isWritable: false }, { pubkey: markerOf(pda, key), isSigner: false, isWritable: true }, { pubkey: SystemProgram.programId, isSigner: false, isWritable: false }] })];
}
const settings = () => new PublicKey(st.settings);
const vault = () => sa.getSmartAccountPda({ settingsPda: settings(), accountIndex: 0 })[0];
const ix = sa.instructions;
const nextIndex = async () => BigInt((await sa.accounts.Settings.fromAccountAddress(conn, settings())).transactionIndex.toString()) + 1n;
const ALL = { mask: 7 };
const sysTransfer = (to: PublicKey, sol: number) => SystemProgram.transfer({ fromPubkey: vault(), toPubkey: to, lamports: Math.round(sol * SOL) });
const policyPayload = (): any => ({ __kind: 'ProgramInteraction', fields: [{ accountIndex: 0, preHook: null, postHook: null,
  instructionsConstraints: [{ programId: SystemProgram.programId, accountConstraints: [{ accountIndex: 1, accountConstraint: { __kind: 'Pubkey', fields: [[VENUE]] }, owner: null }],
    dataConstraints: [{ dataOffset: 0, dataValue: { __kind: 'U32Le', fields: [2] }, operator: sa.generated.DataOperator.Equals },
      { dataOffset: 4, dataValue: { __kind: 'U64Le', fields: [0.05 * SOL] }, operator: sa.generated.DataOperator.LessThanOrEqualTo }] }],
  spendingLimits: [{ mint: PublicKey.default, timeConstraints: { start: 0, expiration: null, period: { __kind: 'Daily' } }, quantityConstraints: { maxPerPeriod: 0.1 * SOL } }] }] });
const policyMove = (policy: PublicKey, signer: PublicKey, inner: TransactionInstruction) => {
  const d = sa.utils.instructionsToSynchronousTransactionDetailsV2({ vaultPda: vault(), members: [signer], transaction_instructions: [inner] });
  return ix.executePolicyPayloadSync({ policy, accountIndex: 0, numSigners: 1, instruction_accounts: d.accounts,
    policyPayload: { __kind: 'ProgramInteraction', fields: [{ instructionConstraintIndices: new Uint8Array([0]), transactionPayload: { __kind: 'SyncTransaction', fields: [{ accountIndex: 0, instructions: d.instructions }] } }] } });
};

/** A 2-of-3 decision by two wallets, each through its own one-signature session: a proposes + approves, b approves + executes. */
async function decide(label: string, a: Session, b: Session | null, create: (index: bigint, creator: PublicKey) => TransactionInstruction[], exec: (index: bigint, signer: PublicKey) => Promise<TransactionInstruction>, expectOk = true) {
  const index = await nextIndex();
  const createIxs = create(index, a.pda);
  for (const [i, c] of createIxs.entries()) await send(`${label}a${i}. ${a.o.name} session: ${i === 0 ? 'create transaction' : 'proposal'}`, true, viaSession(a, c), [a.key]);
  await send(`${label}a. ${a.o.name} session approves`, true, viaSession(a, ix.approveProposal({ settingsPda: settings(), transactionIndex: index, signer: a.pda })), [a.key]);
  const ex = b ?? a;
  if (b) await send(`${label}b. ${b.o.name} session approves`, true, viaSession(b, ix.approveProposal({ settingsPda: settings(), transactionIndex: index, signer: b.pda })), [b.key]);
  return send(`${label}c. ${ex.o.name} session executes${b ? '' : ' with one approval'}`, expectOk, viaSession(ex, await exec(index, ex.pda)), [ex.key]);
}
const vaultTx = (to: PublicKey, sol: number) => async () => new TransactionMessage({ payerKey: vault(), recentBlockhash: (await conn.getLatestBlockhash()).blockhash, instructions: [sysTransfer(to, sol)] });

const part = process.argv[2];
if (part === 'setup') {
  if ((await conn.getBalance(payer.publicKey)) < 10 * SOL) await conn.confirmTransaction(await conn.requestAirdrop(payer.publicKey, 100 * SOL));
  const pc = await sa.accounts.ProgramConfig.fromAccountAddress(conn, sa.getProgramConfigPda({})[0]);
  const [settingsPda] = sa.getSettingsPda({ accountIndex: BigInt(pc.smartAccountIndex.toString()) + 1n });
  st.pdas = Object.fromEntries([MM, FR, PH].map((o) => [o.name, pdaOf(o).toBase58()]));
  await send('P0. Smart Account: seats are the prime-session PDAs of MetaMask, Freighter, Phantom; threshold 2 (no NEAR, no Swig)', true, [
    ix.createSmartAccount({ treasury: pc.treasury, creator: payer.publicKey, settings: settingsPda, settingsAuthority: null, threshold: 2, timeLock: 0, rentCollector: null,
      signers: [MM, FR, PH].map((o) => ({ key: pdaOf(o), permissions: ALL })) }),
    SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: sa.getSmartAccountPda({ settingsPda, accountIndex: 0 })[0], lamports: 2 * SOL }),
    ...[MM, FR, PH].map((o) => SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: pdaOf(o), lamports: 0.2 * SOL }))], [payer]);
  st.settings = settingsPda.toBase58(); save();
  console.log(st.pdas);
}
if (part === 'seats') {
  const s = { MetaMask: await openSession(MM), Freighter: await openSession(FR), Phantom: await openSession(PH) } as Record<string, Session>;
  const vtx = (to: PublicKey) => (index: bigint, creator: PublicKey) => [] as TransactionInstruction[];
  void vtx;
  const pair = async (label: string, a: Session, b: Session | null, expectOk: boolean) => {
    const msg = await vaultTx(DEST, 0.01)();
    const before = await conn.getBalance(DEST);
    await decide(label, a, b, (index, creator) => [
      ix.createTransaction({ settingsPda: settings(), transactionIndex: index, creator, rentPayer: a.key.publicKey, accountIndex: 0, ephemeralSigners: 0, transactionMessage: msg, addressLookupTableAccounts: [] }),
      ix.createProposal({ settingsPda: settings(), transactionIndex: index, creator, rentPayer: a.key.publicKey })],
      async (index, signer) => (await ix.executeTransaction({ connection: conn, settingsPda: settings(), transactionIndex: index, signer })).instruction, expectOk);
    if (expectOk) record(`${label}d. DEST received exactly 0.01 SOL`, true, (await conn.getBalance(DEST)) - before === 0.01 * SOL, `${((await conn.getBalance(DEST)) - before) / SOL}`);
  };
  await pair('K1', s.Phantom!, null, false);
  await pair('K2', s.MetaMask!, s.Freighter!, true);
  await pair('K3', s.Freighter!, s.Phantom!, true);
  await pair('K4', s.Phantom!, s.MetaMask!, true);
  // install the movers policy (signers = the three PDAs) as a 2-of-3 settings decision: MetaMask + Phantom
  const index = await nextIndex(); const seed = Number((await sa.accounts.Settings.fromAccountAddress(conn, settings())).policySeed ?? 0) + 1;
  const policy = sa.getPolicyPda({ settingsPda: settings(), policySeed: seed })[0];
  const action: any = { __kind: 'PolicyCreate', seed, policyCreationPayload: policyPayload(), signers: [MM, FR, PH].map((o) => ({ key: pdaOf(o), permissions: ALL })), threshold: 1, timeLock: 0, startTimestamp: null, expirationArgs: null };
  await decide('K5', s.MetaMask!, s.Phantom!, (i, creator) => [
    ix.createSettingsTransaction({ settingsPda: settings(), transactionIndex: i, creator, rentPayer: s.MetaMask!.key.publicKey, actions: [action] }),
    ix.createProposal({ settingsPda: settings(), transactionIndex: i, creator, rentPayer: s.MetaMask!.key.publicKey })],
    async (i, signer) => ix.executeSettingsTransaction({ settingsPda: settings(), transactionIndex: i, signer, rentPayer: s.Phantom!.key.publicKey, policies: [policy] }));
  void index;
  st.policy = policy.toBase58(); save();
}
if (part === 'sessions') {
  const P = new PublicKey(st.policy);
  for (const o of [MM, FR, PH]) {
    const s = await openSession(o);
    const b = await conn.getBalance(VENUE);
    await send(`M-${o.name}1. one ${o.name} signature -> session key alone: 0.01 SOL vault -> VENUE`, true, viaSession(s, policyMove(P, s.pda, sysTransfer(VENUE, 0.01))), [s.key]);
    record(`M-${o.name}1b. VENUE received exactly 0.01 SOL`, true, (await conn.getBalance(VENUE)) - b === 0.01 * SOL, `${((await conn.getBalance(VENUE)) - b) / SOL}`);
    await send(`M-${o.name}2. same session: 0.01 SOL elsewhere`, false, viaSession(s, policyMove(P, s.pda, sysTransfer(OTHER, 0.01))), [s.key]);
    await send(`M-${o.name}3. v2: same session tries a System transfer of the PDA's own SOL (target allowlist)`, false, viaSession(s, SystemProgram.transfer({ fromPubkey: s.pda, toPubkey: OTHER, lamports: 0.01 * SOL })), [s.key]);
  }
  // program-level refusals
  const ph = await openSession(PH);
  const other = nacl.sign.keyPair();
  const fake = await openSession(PH, 3600, { signAs: { ...PH, owner: Buffer.from(other.publicKey), signText: async (t) => Buffer.from(nacl.sign.detached(Buffer.from(t), other.secretKey)) } });
  await send('N1. Phantom PDA with a grant signed by another ed25519 key', false, viaSession(fake, policyMove(P, fake.pda, sysTransfer(VENUE, 0.001))), [fake.key]);
  const noPrefix = await openSession(FR, 3600, { signAs: { ...FR, signText: async (t) => Buffer.from(frKp.sign(Buffer.from(t))) } });
  await send('N2. Freighter key signs the grant WITHOUT the SEP-53 prefix', false, viaSession({ ...noPrefix, sigIx: Ed25519Program.createInstructionWithPublicKey({ publicKey: FR.owner, message: Buffer.from(grantText(noPrefix.pda, noPrefix.key.publicKey, noPrefix.until)), signature: frKp.sign(Buffer.from(grantText(noPrefix.pda, noPrefix.key.publicKey, noPrefix.until))) }) }, policyMove(P, noPrefix.pda, sysTransfer(VENUE, 0.001))), [noPrefix.key]);
  await send('N3. Phantom grant presented for the MetaMask PDA', false, viaSession({ ...ph, pda: pdaOf(MM) }, policyMove(P, pdaOf(MM), sysTransfer(VENUE, 0.001)), { owner: MM }), [ph.key]);
  await send('N4. stretched valid-until (grant says less)', false, viaSession(ph, policyMove(P, ph.pda, sysTransfer(VENUE, 0.001)), { until: ph.until + 60 }), [ph.key]);
  const thief = Keypair.generate(); await conn.confirmTransaction(await conn.requestAirdrop(thief.publicKey, 0.05 * SOL));
  await send('N5. someone else replays the Phantom grant with their own key', false, viaSession({ ...ph, key: thief }, policyMove(P, ph.pda, sysTransfer(VENUE, 0.001))), [thief]);
  const long = await openSession(PH, 8 * 86400);
  await send('N6. grant longer than 7 days', false, viaSession(long, policyMove(P, long.pda, sysTransfer(VENUE, 0.001))), [long.key]);
  const shortS = await openSession(PH, 3);
  await new Promise((r) => setTimeout(r, 6000));
  await send('N7. expired grant', false, viaSession(shortS, policyMove(P, shortS.pda, sysTransfer(VENUE, 0.001))), [shortS.key]);
  const mm = await openSession(MM);
  await send('N8. MetaMask grant with the signature program missing (only prime-session)', false, [viaSession(mm, policyMove(P, mm.pda, sysTransfer(VENUE, 0.001)))[1]!], [mm.key]);
  await send('N9. cap shared by all three: 0.03 used + 0.05 = 0.08 <= 0.1/day', true, viaSession(mm, policyMove(P, mm.pda, sysTransfer(VENUE, 0.05))), [mm.key]);
  await send('N9b. 0.08 + 0.05 = 0.13 > 0.1/day', false, viaSession(mm, policyMove(P, mm.pda, sysTransfer(VENUE, 0.05))), [mm.key]);
}
if (part === 'swigseat') {
  // Can MetaMask hold a Solana seat without NEAR through a Swig wallet (as run 10's policy signer did)?
  const id = crypto.getRandomValues(new Uint8Array(32));
  const mmSign = async (m: Uint8Array) => ({ signature: hexToBytes(await metamask.signMessage({ message: { raw: m } })), prefix: getEvmPersonalSignPrefix(m.length) });
  await send('W0. Swig wallet W: root MetaMask', true, [await getCreateSwigInstruction({ authorityInfo: createSecp256k1AuthorityInfo(hexToBytes(metamask.publicKey)), id, payer: payer.publicKey, actions: Actions.set().all().get() })], [payer]);
  let w = await fetchSwig(conn, findSwigPda(id)); const W = await getSwigWalletAddress(w);
  await send('W0a. MetaMask adds its session role on W (Smart Account program only)', true, await getAddAuthorityInstructions(w, 0, createSecp256k1SessionAuthorityInfo(hexToBytes(metamask.publicKey), 300n), Actions.set().programLimit({ programId: sa.PROGRAM_ID }).get(), { payer: payer.publicKey, currentSlot: BigInt(await conn.getSlot()), signingFn: mmSign }), [payer]);
  const pc = await sa.accounts.ProgramConfig.fromAccountAddress(conn, sa.getProgramConfigPda({})[0]);
  const [s2] = sa.getSettingsPda({ accountIndex: BigInt(pc.smartAccountIndex.toString()) + 1n });
  await send('W1. Smart Account: seats W (MetaMask via Swig), B, C; threshold 2', true, [ix.createSmartAccount({ treasury: pc.treasury, creator: payer.publicKey, settings: s2, settingsAuthority: null, threshold: 2, timeLock: 0, rentCollector: null,
    signers: [W, B.publicKey, C.publicKey].map((key) => ({ key, permissions: ALL })) }), SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: sa.getSmartAccountPda({ settingsPda: s2, accountIndex: 0 })[0], lamports: SOL }),
    SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: W, lamports: 0.1 * SOL })], [payer]);
  const v2 = sa.getSmartAccountPda({ settingsPda: s2, accountIndex: 0 })[0];
  const sk = Keypair.generate(); await conn.confirmTransaction(await conn.requestAirdrop(sk.publicKey, 0.05 * SOL));
  w = await fetchSwig(conn, findSwigPda(id));
  await send('W2. MetaMask opens a session on W (one personal_sign)', true, await getCreateSessionInstructions(w, w.roles.at(-1)!.id, sk.publicKey, 200n, { currentSlot: BigInt(await conn.getSlot()), signingFn: mmSign, payer: payer.publicKey }), [payer]);
  w = await fetchSwig(conn, findSwigPda(id)); const role = w.findRoleBySessionKey(sk.publicKey)!;
  const msg = new TransactionMessage({ payerKey: v2, recentBlockhash: (await conn.getLatestBlockhash()).blockhash, instructions: [SystemProgram.transfer({ fromPubkey: v2, toPubkey: DEST, lamports: 0.01 * SOL })] });
  await send('W3r. MetaMask session -> W proposes + approves a vault transfer (session key pays rent)', true, await getSignInstructions(w, role.id, [
    ix.createTransaction({ settingsPda: s2, transactionIndex: 1n, creator: W, rentPayer: sk.publicKey, accountIndex: 0, ephemeralSigners: 0, transactionMessage: msg, addressLookupTableAccounts: [] }),
    ix.createProposal({ settingsPda: s2, transactionIndex: 1n, creator: W, rentPayer: sk.publicKey }), ix.approveProposal({ settingsPda: s2, transactionIndex: 1n, signer: W })], false, { payer: sk.publicKey }), [sk]);
  const before = await conn.getBalance(DEST);
  const { instruction } = await ix.executeTransaction({ connection: conn, settingsPda: s2, transactionIndex: 1n, signer: B.publicKey });
  await send('W4. B approves and executes (MetaMask via Swig + B = 2 of 3)', true, [ix.approveProposal({ settingsPda: s2, transactionIndex: 1n, signer: B.publicKey }), instruction], [payer, B]);
  record('W5. DEST received exactly 0.01 SOL', true, (await conn.getBalance(DEST)) - before === 0.01 * SOL, `${((await conn.getBalance(DEST)) - before) / SOL}`);
}
if (part === 'dbg3') {
  for (const r of results) if (/^M-\w+3\./.test(r.name)) { r.pass = false; r.detail = '(harness: 1000 lamports to an empty account fails the rent check; redone as M3r) ' + r.detail.slice(0, 60); }
  save();
  for (const o of [MM, FR, PH]) { const s = await openSession(o);
    await send(`M-${o.name}3r. FINDING: the session moves 0.01 SOL of the PDA's own SOL (the program does not limit the target)`, true, viaSession(s, SystemProgram.transfer({ fromPubkey: s.pda, toPubkey: OTHER, lamports: 0.01 * SOL })), [s.key]); }
}
if (part === 'realph') {
  const s = await openSession(PH); const b = await conn.getBalance(VENUE);
  await send('RP5. real Phantom grant (prime-session text) -> session alone: 0.01 SOL vault -> VENUE', true, viaSession(s, policyMove(new PublicKey(st.policy), s.pda, sysTransfer(VENUE, 0.01))), [s.key]);
  record('RP5b. VENUE received exactly 0.01 SOL', true, (await conn.getBalance(VENUE)) - b === 0.01 * SOL, `${((await conn.getBalance(VENUE)) - b) / SOL}`);
}
if (part === 'v2') {
  const P = new PublicKey(st.policy);
  // revoke
  const phS = await openSession(PH), mm = await openSession(MM), fr = await openSession(FR);
  await send('V1. Phantom session before revoke: 0.005 SOL to VENUE', true, viaSession(phS, policyMove(P, phS.pda, sysTransfer(VENUE, 0.005))), [phS.key]);
  await send('V2. revoke signed by another ed25519 key (claiming Phantom)', false, await (async () => { const other = nacl.sign.keyPair();
    const t = revokeText(pdaOf(PH), phS.key.publicKey); const sigIx = Ed25519Program.createInstructionWithPublicKey({ publicKey: other.publicKey, message: Buffer.from(t), signature: nacl.sign.detached(Buffer.from(t), other.secretKey) });
    const [, ix2] = await revokeIxs(PH, phS.key.publicKey); return [sigIx, ix2!]; })(), [payer]);
  await send('V3. Phantom revokes its session (one signMessage over the revoke text)', true, await revokeIxs(PH, phS.key.publicKey), [payer]);
  await send('V4. the revoked Phantom session (still within validity)', false, viaSession(phS, policyMove(P, phS.pda, sysTransfer(VENUE, 0.001))), [phS.key]);
  const ph2 = await openSession(PH);
  await send('V5. a new Phantom session still works', true, viaSession(ph2, policyMove(P, ph2.pda, sysTransfer(VENUE, 0.001))), [ph2.key]);
  await send('V6. MetaMask revokes its session (personal_sign)', true, await revokeIxs(MM, mm.key.publicKey), [payer]);
  await send('V7. the revoked MetaMask session', false, viaSession(mm, policyMove(P, mm.pda, sysTransfer(VENUE, 0.001))), [mm.key]);
  await send('V8. Freighter revokes its session (SEP-53)', true, await revokeIxs(FR, fr.key.publicKey), [payer]);
  await send('V9. the revoked Freighter session', false, viaSession(fr, policyMove(P, fr.pda, sysTransfer(VENUE, 0.001))), [fr.key]);
  await send('V10. revoked session with the marker account swapped for another', false, (() => { const ixs = viaSession(fr, policyMove(P, fr.pda, sysTransfer(VENUE, 0.001))); ixs[1]!.keys[3] = { pubkey: Keypair.generate().publicKey, isSigner: false, isWritable: false }; return ixs; })(), [fr.key]);
  // cluster / program binding
  const otherCluster = await openSession(PH, 3600, { text: (t) => t.replace('cluster: localnet', 'cluster: mainnet') });
  await send('V11. grant signed for cluster mainnet, used on localnet', false, viaSession(otherCluster, policyMove(P, otherCluster.pda, sysTransfer(VENUE, 0.001))), [otherCluster.key]);
  const otherProg = await openSession(PH, 3600, { text: (t) => t.replace(`program: ${PROG.toBase58()}`, 'program: 8xSaCrq6HidyjmE3khJ9DYewWdYNfn93nQEkYvqTEpig') });
  await send('V12. grant signed for another program id, used here', false, viaSession(otherProg, policyMove(P, otherProg.pda, sysTransfer(VENUE, 0.001))), [otherProg.key]);
  const v1style = await openSession(PH, 3600, { text: (t) => t.split('\ncluster:')[0]! });
  await send('V13. a grant without cluster and program', false, viaSession(v1style, policyMove(P, v1style.pda, sysTransfer(VENUE, 0.001))), [v1style.key]);
  // target allowlist
  const s = await openSession(PH);
  await send('V14. session -> System Assign of its own PDA', false, viaSession(s, SystemProgram.assign({ accountPubkey: s.pda, programId: Keypair.generate().publicKey })), [s.key]);
  // signature instruction pointing at other data
  const t = grantText(s.pda, s.key.publicKey, s.until); const sig = nacl.sign.detached(Buffer.from(t), ph.secretKey);
  const edIx = Ed25519Program.createInstructionWithPublicKey({ publicKey: ph.publicKey, message: Buffer.from(t), signature: sig });
  const d = Buffer.from(edIx.data); d.writeUInt16LE(1, 8); // public key instruction index -> 1 instead of 0xffff
  const tampered = viaSession(s, policyMove(P, s.pda, sysTransfer(VENUE, 0.001))); tampered[0] = new TransactionInstruction({ ...edIx, data: d });
  await send('V15. ed25519 instruction reading its public key from another instruction', false, tampered, [s.key]);
  // anyone can send lamports to a marker address: that must neither revoke a live session nor block a real revoke
  const g = await openSession(FR), g2 = await openSession(MM);
  await send('V16. stranger pre-funds the marker of a live Freighter session with exactly the rent minimum', true, [SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: markerOf(g.pda, g.key.publicKey), lamports: await conn.getMinimumBalanceForRentExemption(0) })], [payer]);
  await send('V17. that session still works', true, viaSession(g, policyMove(P, g.pda, sysTransfer(VENUE, 0.001))), [g.key]);
  await send('V18. Freighter revokes it (marker already holds lamports)', true, await revokeIxs(FR, g.key.publicKey), [payer]);
  await send('V19. the revoked session', false, viaSession(g, policyMove(P, g.pda, sysTransfer(VENUE, 0.001))), [g.key]);
  await send('V20. revoking again is a no-op', true, await revokeIxs(FR, g.key.publicKey), [payer]);
  await send('V21. stranger pre-funds a marker above rent exemption (0.01 SOL)', true, [SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: markerOf(g2.pda, g2.key.publicKey), lamports: 0.01 * SOL })], [payer]);
  await send('V22. that MetaMask session still works', true, viaSession(g2, policyMove(P, g2.pda, sysTransfer(VENUE, 0.001))), [g2.key]);
  await send('V23. MetaMask revokes it', true, await revokeIxs(MM, g2.key.publicKey), [payer]);
  await send('V24. the revoked session', false, viaSession(g2, policyMove(P, g2.pda, sysTransfer(VENUE, 0.001))), [g2.key]);
  const g3 = await openSession(PH); // live, never revoked: a signed revoke text (valid until 0) must not work as a grant
  await send('V25. a signed revoke text (valid until 0) used as a session grant', false, viaSession({ ...g3, until: 0, sigIx: await sigIxFor(PH, revokeText(g3.pda, g3.key.publicKey)) }, policyMove(P, g3.pda, sysTransfer(VENUE, 0.001))), [g3.key]);
}
if (part === 'summary') { const p = results.filter((r) => r.pass).length; console.log(`${p}/${results.length} passed`); for (const r of results.filter((r) => !r.pass)) console.log('FAIL', r.name, r.detail); }

process.exit(0);
