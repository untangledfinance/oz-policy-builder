// Solana matrix, NEAR-routed: a Squads Smart Account (cloned from devnet) on a local validator.
//   seats (settings signers, 2-of-3): Phantom (its own key), MetaMask and Freighter (their NEAR MPC ed25519 keys:
//         eth-implicit account for MetaMask, our SEP-53 wallet contract for Freighter). Each signs Solana txs itself.
//   sessions: prime-session PDA ["prime", owner] per wallet is a member of the movers policy only, never a settings
//         signer. The owner signs one plain-text grant (Phantom signMessage; NEAR MPC signs the text for the others),
//         then the session key signs each move. Fee payer: the relayer, or the session key itself.
import { Connection, Ed25519Program, Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram, SYSVAR_INSTRUCTIONS_PUBKEY, Transaction,
  TransactionInstruction, TransactionMessage } from '@solana/web3.js';
import * as sa from '@sqds/smart-account';
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import { readFileSync, writeFileSync } from 'node:fs';
import { payer } from './keys.ts';
const { edKey, edSign, stats } = await import('/home/ubuntu/work/near-session-spike/nearsig.ts');

const conn = new Connection('http://127.0.0.1:8899', { commitment: 'confirmed', confirmTransactionInitialTimeout: 120_000 });
const PROG = new PublicKey('FTNMFWiECbRp7D5MwJUiNQfee6NuJPjE7S11J9yc2B9G');
const CLUSTER = 'localnet';
const st: any = {}; const results: any[] = [];
const save = () => writeFileSync('state-psn.json', JSON.stringify({ ...st, results }, null, 1));
const SOL = LAMPORTS_PER_SOL;
const VENUE = Keypair.generate().publicKey, OTHER = Keypair.generate().publicKey, DEST = Keypair.generate().publicKey;
const short = (e: any) => { const s = [e?.logs?.join(' '), e?.message, String(e)].filter(Boolean).join(' | ');
  return ((s.match(/prime-session: [^"]*?(?= Program|$)/) ?? s.match(/Error Code: \w+/) ?? s.match(/(custom program error: 0x[0-9a-f]+|Signature verification failed|Attempt to debit an account but found no record of a prior credit|insufficient [a-z ]+|[A-Za-z]+Error[^"]{0,60})/i))?.[0] ?? s).slice(0, 160); };
/** Wait for a signature by polling its status (confirmTransaction stalls on this validator even when the tx lands). */
async function confirm(sig: string) {
  for (let i = 0; i < 180; i++) {
    const s = (await conn.getSignatureStatus(sig, { searchTransactionHistory: true })).value;
    if (s?.err) throw Object.assign(new Error(JSON.stringify(s.err)), { signature: sig });
    if (s?.confirmationStatus === 'confirmed' || s?.confirmationStatus === 'finalized') return sig;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`${sig} not confirmed after 90 s (status lookup)`);
}
function record(name: string, expectOk: boolean, ok: boolean, detail: string) {
  const pass = ok === expectOk; results.push({ name, pass, ok, detail }); save();
  console.log(`${pass ? 'PASS' : 'FAIL'} ${name} | ${ok ? `ok ${detail}` : `refused: ${detail}`}`);
  return ok;
}

// ── Wallets ────────────────────────────────────────────────────────────────────────────────────
const PATH = 'prime:solana';
type W = { name: string; key: PublicKey; sign: (m: Uint8Array) => Promise<Uint8Array> };
const viaNear = async (name: 'MetaMask' | 'Freighter', path = PATH): Promise<W> => ({ name, key: new PublicKey(await edKey(name, path)), sign: (m) => edSign(name, path, m) });
const phSecret = bs58.decode(JSON.parse(readFileSync('/home/ubuntu/work/phantom-spike/secrets/phantom-test.json', 'utf8')).secret);
const phKp = nacl.sign.keyPair.fromSecretKey(phSecret.length === 64 ? phSecret : nacl.sign.keyPair.fromSeed(phSecret).secretKey);
const PH: W = { name: 'Phantom', key: new PublicKey(phKp.publicKey), sign: async (m) => nacl.sign.detached(m, phKp.secretKey) };
const MM = await viaNear('MetaMask'), FR = await viaNear('Freighter');
const FR_OTHER_PATH = await viaNear('Freighter', 'prime:solana-other');
const outsiderKp = Keypair.generate();
const OUT: W = { name: 'outsider', key: outsiderKp.publicKey, sign: async (m) => nacl.sign.detached(m, outsiderKp.secretKey) };
console.log({ MetaMask: MM.key.toBase58(), Freighter: FR.key.toBase58(), Phantom: PH.key.toBase58() });

/** One tx: instructions signed by `w` (a seat), fee paid by the relayer. */
async function sendBy(name: string, expectOk: boolean, w: W, ixs: TransactionInstruction[], signAs?: W) {
  const tx = new Transaction().add(...ixs); tx.feePayer = payer.publicKey; tx.recentBlockhash = (await conn.getLatestBlockhash('confirmed')).blockhash;
  let ok = true, d = '';
  try {
    tx.addSignature(w.key, Buffer.from(await (signAs ?? w).sign(tx.serializeMessage()))); tx.partialSign(payer);
    d = await conn.sendRawTransaction(tx.serialize({ verifySignatures: false })); await confirm(d);
    const s = await conn.getSignatureStatus(d); if (s.value?.err) { ok = false; d = JSON.stringify(s.value.err); }
  } catch (e: any) { ok = false; d = short(e); if (e?.getLogs) try { const l = await e.getLogs(conn); if (Array.isArray(l) && l.length) d = short({ logs: l }); } catch {} }
  return record(name, expectOk, ok, d);
}
/** One tx signed by plain keypairs (sessions); the first is the fee payer. */
async function send(name: string, expectOk: boolean, ixs: TransactionInstruction[], signers: Keypair[]) {
  let ok = true, d = '';
  try {
    const tx = new Transaction().add(...ixs); tx.feePayer = signers[0]!.publicKey; tx.recentBlockhash = (await conn.getLatestBlockhash('confirmed')).blockhash;
    tx.sign(...signers);
    d = await conn.sendRawTransaction(tx.serialize()); await confirm(d);
    const s = await conn.getSignatureStatus(d); if (s.value?.err) { ok = false; d = JSON.stringify(s.value.err); }
  } catch (e: any) { ok = false; d = short(e); if (e?.getLogs) try { const l = await e.getLogs(conn); if (Array.isArray(l) && l.length) d = short({ logs: l }); } catch {} }
  return record(name, expectOk, ok, d);
}

// ── Smart Account helpers ──────────────────────────────────────────────────────────────────────
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
const policyMove = (signer: PublicKey, inner: TransactionInstruction) => {
  const d = sa.utils.instructionsToSynchronousTransactionDetailsV2({ vaultPda: vault(), members: [signer], transaction_instructions: [inner] });
  return ix.executePolicyPayloadSync({ policy: new PublicKey(st.policy), accountIndex: 0, numSigners: 1, instruction_accounts: d.accounts,
    policyPayload: { __kind: 'ProgramInteraction', fields: [{ instructionConstraintIndices: new Uint8Array([0]), transactionPayload: { __kind: 'SyncTransaction', fields: [{ accountIndex: 0, instructions: d.instructions }] } }] } });
};
/** A 2-of-3 seat decision: a proposes and approves (one signature), b approves and executes (one signature). */
async function decide(label: string, a: W, b: W | null, actions: { vault?: TransactionInstruction[]; settings?: any[]; policies?: PublicKey[] }, expectOk: boolean) {
  const index = await nextIndex();
  const create = actions.settings
    ? ix.createSettingsTransaction({ settingsPda: settings(), transactionIndex: index, creator: a.key, rentPayer: payer.publicKey, actions: actions.settings })
    : ix.createTransaction({ settingsPda: settings(), transactionIndex: index, creator: a.key, rentPayer: payer.publicKey, accountIndex: 0, ephemeralSigners: 0, addressLookupTableAccounts: [],
        transactionMessage: new TransactionMessage({ payerKey: vault(), recentBlockhash: (await conn.getLatestBlockhash()).blockhash, instructions: actions.vault! }) });
  await sendBy(`${label}a. ${a.name} proposes and approves`, true, a, [create,
    ix.createProposal({ settingsPda: settings(), transactionIndex: index, creator: a.key, rentPayer: payer.publicKey }),
    ix.approveProposal({ settingsPda: settings(), transactionIndex: index, signer: a.key })]);
  const ex = b ?? a;
  const exec = actions.settings
    ? ix.executeSettingsTransaction({ settingsPda: settings(), transactionIndex: index, signer: ex.key, rentPayer: payer.publicKey, policies: actions.policies ?? [] })
    : (await ix.executeTransaction({ connection: conn, settingsPda: settings(), transactionIndex: index, signer: ex.key })).instruction;
  const ixs = b ? [ix.approveProposal({ settingsPda: settings(), transactionIndex: index, signer: b.key }), exec] : [exec];
  await sendBy(`${label}b. ${b ? `${b.name} approves and executes` : `${a.name} executes with only its own approval`}`, expectOk, ex, ixs);
  return index;
}

// ── Sessions ───────────────────────────────────────────────────────────────────────────────────
const pdaOf = (owner: PublicKey) => PublicKey.findProgramAddressSync([Buffer.from('prime'), owner.toBuffer()], PROG)[0];
const grantText = (pda: PublicKey, key: PublicKey, until: number, cluster = CLUSTER, program = PROG) =>
  `Prime session\nsigner: ${pda.toBase58()}\nsession key: ${key.toBase58()}\nvalid until (unix time): ${until}\ncluster: ${cluster}\nprogram: ${program.toBase58()}`;
type Session = { owner: PublicKey; key: Keypair; until: number; pda: PublicKey; sigIx: TransactionInstruction };
async function openSession(w: W, o: { seconds?: number; signAs?: W; text?: (t: string) => string; fund?: number } = {}): Promise<Session> {
  const key = Keypair.generate(); const until = Math.floor(Date.now() / 1000) + (o.seconds ?? 3600); const pda = pdaOf(w.key);
  const text = (o.text ?? ((t) => t))(grantText(pda, key.publicKey, until));
  const signer = o.signAs ?? w;
  const sig = await signer.sign(new TextEncoder().encode(text));
  const sigIx = Ed25519Program.createInstructionWithPublicKey({ publicKey: signer.key.toBytes(), message: Buffer.from(text), signature: sig });
  if (o.fund !== 0) await confirm(await conn.requestAirdrop(key.publicKey, o.fund ?? 0.05 * SOL));
  return { owner: w.key, key, until, pda, sigIx };
}
/** [ed25519 program ix, prime-session execute(inner)]. */
function viaSession(s: Session, inner: TransactionInstruction, o: { until?: number; owner?: PublicKey; pda?: PublicKey } = {}): TransactionInstruction[] {
  const owner = o.owner ?? s.owner, pda = o.pda ?? s.pda;
  const head = Buffer.concat([Buffer.from([0]), owner.toBuffer(), Buffer.from(new BigInt64Array([BigInt(o.until ?? s.until)]).buffer), Buffer.from([0])]);
  const keys = [{ pubkey: SYSVAR_INSTRUCTIONS_PUBKEY, isSigner: false, isWritable: false }, { pubkey: s.key.publicKey, isSigner: true, isWritable: true },
    { pubkey: pda, isSigner: false, isWritable: false }, { pubkey: inner.programId, isSigner: false, isWritable: false },
    ...inner.keys.map((k) => ({ ...k, isSigner: k.pubkey.equals(pda) ? false : k.isSigner }))];
  return [s.sigIx, new TransactionInstruction({ programId: PROG, keys, data: Buffer.concat([head, inner.data]) })];
}
const relayed = (s: Session) => [payer, s.key];   // relayer pays the fee, session key co-signs
const selfPaid = (s: Session) => [s.key];         // relayer down: the session key pays

// ── P. Setup ───────────────────────────────────────────────────────────────────────────────────
if ((await conn.getBalance(payer.publicKey)) < 10 * SOL) await confirm(await conn.requestAirdrop(payer.publicKey, 100 * SOL));
{
  const pc = await sa.accounts.ProgramConfig.fromAccountAddress(conn, sa.getProgramConfigPda({})[0]);
  const [settingsPda] = sa.getSettingsPda({ accountIndex: BigInt(pc.smartAccountIndex.toString()) + 1n });
  const tx = new Transaction().add(ix.createSmartAccount({ treasury: pc.treasury, creator: payer.publicKey, settings: settingsPda, settingsAuthority: null,
    threshold: 2, timeLock: 0, rentCollector: null, signers: [MM, FR, PH].map((w) => ({ key: w.key, permissions: ALL })) }),
    SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: sa.getSmartAccountPda({ settingsPda, accountIndex: 0 })[0], lamports: 2 * SOL }));
  const sig = await conn.sendTransaction(tx, [payer]); await confirm(sig);
  st.settings = settingsPda.toBase58(); save();
  const s = await sa.accounts.Settings.fromAccountAddress(conn, settings());
  record('P0. seats are exactly MetaMask(NEAR MPC), Freighter(NEAR MPC), Phantom(own key); threshold 2; vault funded', true,
    s.signers.map((x: any) => x.key.toBase58()).sort().join() === [MM, FR, PH].map((w) => w.key.toBase58()).sort().join() && s.threshold === 2, sig);
}

// ── K. Seats ───────────────────────────────────────────────────────────────────────────────────
{
  for (const w of [MM, FR, PH]) await decide(`K1-${w.name}. ${w.name} alone:`, w, null, { vault: [sysTransfer(DEST, 0.01)] }, false);
  const b = await conn.getBalance(DEST);
  await decide('K2. MetaMask + Freighter:', MM, FR, { vault: [sysTransfer(DEST, 0.01)] }, true);
  await decide('K3. Freighter + Phantom:', FR, PH, { vault: [sysTransfer(DEST, 0.01)] }, true);
  await decide('K4. Phantom + MetaMask:', PH, MM, { vault: [sysTransfer(DEST, 0.01)] }, true);
  record('K5. DEST received exactly 0.03 SOL', true, (await conn.getBalance(DEST)) - b === 0.03 * SOL, `${((await conn.getBalance(DEST)) - b) / SOL}`);
  const idx = await decide('K6. MetaMask alone (open proposal):', MM, null, { vault: [sysTransfer(DEST, 0.01)] }, false);
  await sendBy('K6c. an outsider approves it', false, OUT, [ix.approveProposal({ settingsPda: settings(), transactionIndex: idx, signer: OUT.key })]);
  await sendBy("K6d. Freighter's seat signed by MetaMask's MPC key", false, FR, [ix.approveProposal({ settingsPda: settings(), transactionIndex: idx, signer: FR.key })], MM);
  await sendBy("K6e. Freighter's seat signed by its MPC key under another path", false, FR, [ix.approveProposal({ settingsPda: settings(), transactionIndex: idx, signer: FR.key })], FR_OTHER_PATH);
  // movers policy: members are the three session PDAs; a 2-of-3 settings decision (MetaMask + Phantom)
  const seed = Number((await sa.accounts.Settings.fromAccountAddress(conn, settings())).policySeed ?? 0) + 1;
  const policy = sa.getPolicyPda({ settingsPda: settings(), policySeed: seed })[0];
  st.policy = policy.toBase58(); st.policySeed = seed; save();
  await decide('K7. install the movers policy (members: the three session PDAs):', MM, PH, { settings: [{ __kind: 'PolicyCreate', seed, policyCreationPayload: policyPayload(),
    signers: [MM, FR, PH].map((w) => ({ key: pdaOf(w.key), permissions: ALL })), threshold: 1, timeLock: 0, startTimestamp: null, expirationArgs: null }], policies: [policy] }, true);
}

// ── N. A session can never vote as a seat ──────────────────────────────────────────────────────
{
  const s = await openSession(PH);
  const idx = await decide('N0. MetaMask alone (open proposal):', MM, null, { vault: [sysTransfer(DEST, 0.01)] }, false);
  await send('N1. Phantom session approves that proposal as its PDA', false, viaSession(s, ix.approveProposal({ settingsPda: settings(), transactionIndex: idx, signer: s.pda })), relayed(s));
  await send('N2. Phantom session key approves it as itself', false, [ix.approveProposal({ settingsPda: settings(), transactionIndex: idx, signer: s.key.publicKey })], relayed(s));
  const i2 = await nextIndex();
  await send('N3. Phantom session proposes a vault transaction as its PDA', false, viaSession(s, ix.createTransaction({ settingsPda: settings(), transactionIndex: i2, creator: s.pda, rentPayer: s.key.publicKey, accountIndex: 0, ephemeralSigners: 0, addressLookupTableAccounts: [],
    transactionMessage: new TransactionMessage({ payerKey: vault(), recentBlockhash: (await conn.getLatestBlockhash()).blockhash, instructions: [sysTransfer(OTHER, 0.01)] }) })), relayed(s));
  await send('N4. Phantom session adds its key as a seat (settings sync, as its PDA)', false, viaSession(s, ix.executeSettingsTransactionSync({ settingsPda: settings(), feePayer: s.key.publicKey, signers: [s.pda],
    actions: [{ __kind: 'AddSigner', newSigner: { key: s.key.publicKey, permissions: ALL } }] as any })), relayed(s));
  await send('N5. Phantom session calls a program other than the Smart Account (System transfer from its PDA)', false, viaSession(s, SystemProgram.transfer({ fromPubkey: s.pda, toPubkey: OTHER, lamports: 1000 })), relayed(s));
}

// ── G. Sessions, every wallet ──────────────────────────────────────────────────────────────────
for (const w of [MM, FR, PH]) {
  const s = await openSession(w);
  const b = await conn.getBalance(VENUE);
  await send(`G-${w.name}1. one ${w.name} signature${w === PH ? '' : ' (through NEAR)'} -> session; relayer pays: 0.01 SOL to VENUE`, true, viaSession(s, policyMove(s.pda, sysTransfer(VENUE, 0.01))), relayed(s));
  await send(`G-${w.name}2. relayer down: session key pays the fee itself: 0.005 SOL to VENUE`, true, viaSession(s, policyMove(s.pda, sysTransfer(VENUE, 0.005))), selfPaid(s));
  record(`G-${w.name}3. VENUE received exactly 0.015 SOL`, true, (await conn.getBalance(VENUE)) - b === 0.015 * SOL, `${((await conn.getBalance(VENUE)) - b) / SOL}`);
  const broke = await openSession(w, { fund: 0 });
  await send(`G-${w.name}4. relayer down and the session key has no SOL`, false, viaSession(broke, policyMove(broke.pda, sysTransfer(VENUE, 0.001))), selfPaid(broke));
  await send(`G-${w.name}5. same session: 0.01 SOL elsewhere (policy)`, false, viaSession(s, policyMove(s.pda, sysTransfer(OTHER, 0.01))), relayed(s));
  await send(`G-${w.name}6. same session: 0.06 SOL to VENUE (over the 0.05 per-move limit)`, false, viaSession(s, policyMove(s.pda, sysTransfer(VENUE, 0.06))), relayed(s));
  await send(`G-${w.name}7. stretched valid-until`, false, viaSession(s, policyMove(s.pda, sysTransfer(VENUE, 0.001)), { until: s.until + 60 }), relayed(s));
  const thief = Keypair.generate(); await confirm(await conn.requestAirdrop(thief.publicKey, 0.05 * SOL));
  await send(`G-${w.name}8. someone else replays the grant with their own key`, false, viaSession({ ...s, key: thief }, policyMove(s.pda, sysTransfer(VENUE, 0.001))), [thief]);
}
{
  const long = await openSession(PH, { seconds: 8 * 86400 });
  await send('G9. grant longer than 7 days', false, viaSession(long, policyMove(long.pda, sysTransfer(VENUE, 0.001))), relayed(long));
  const old = await openSession(PH, { seconds: -10 });
  await send('G10. expired grant', false, viaSession(old, policyMove(old.pda, sysTransfer(VENUE, 0.001))), relayed(old));
  const mm = await openSession(MM);
  await send('G11. MetaMask grant with the ed25519 program instruction missing', false, [viaSession(mm, policyMove(mm.pda, sysTransfer(VENUE, 0.001)))[1]!], relayed(mm));
  const d = Buffer.from(mm.sigIx.data); d.writeUInt16LE(1, 8); // public key read from another instruction
  await send('G12. ed25519 instruction reading its public key from another instruction', false, viaSession({ ...mm, sigIx: new TransactionInstruction({ ...mm.sigIx, data: d }) }, policyMove(mm.pda, sysTransfer(VENUE, 0.001))), relayed(mm));
  await send('G13. daily cap shared by all: 0.045 used + 0.05 = 0.095 <= 0.1', true, viaSession(mm, policyMove(mm.pda, sysTransfer(VENUE, 0.05))), relayed(mm));
  await send('G13b. + 0.01 = 0.105 > 0.1', false, viaSession(mm, policyMove(mm.pda, sysTransfer(VENUE, 0.01))), relayed(mm));
}

// ── X. Cross-wallet ────────────────────────────────────────────────────────────────────────────
{
  const a = await openSession(FR, { signAs: MM });
  await send("X1. Freighter's PDA with a grant signed by MetaMask (NEAR)", false, viaSession(a, policyMove(a.pda, sysTransfer(VENUE, 0.001))), relayed(a));
  const b = await openSession(PH, { signAs: FR });
  await send("X2. Phantom's PDA with a grant signed by Freighter (NEAR)", false, viaSession(b, policyMove(b.pda, sysTransfer(VENUE, 0.001))), relayed(b));
  const c = await openSession(MM, { signAs: PH });
  await send("X3. MetaMask's PDA with a grant signed by Phantom", false, viaSession(c, policyMove(c.pda, sysTransfer(VENUE, 0.001))), relayed(c));
  const d = await openSession(FR, { signAs: FR_OTHER_PATH });
  await send("X4. Freighter's PDA with its MPC key under another path", false, viaSession(d, policyMove(d.pda, sysTransfer(VENUE, 0.001))), relayed(d));
  const ph = await openSession(PH);
  await send("X5. Phantom grant presented for MetaMask's PDA", false, viaSession(ph, policyMove(pdaOf(MM.key), sysTransfer(VENUE, 0.001)), { owner: MM.key, pda: pdaOf(MM.key) }), relayed(ph));
  const cl = await openSession(PH, { text: (t) => t.replace('cluster: localnet', 'cluster: mainnet') });
  await send('X6. grant signed for cluster mainnet, used on localnet', false, viaSession(cl, policyMove(cl.pda, sysTransfer(VENUE, 0.001))), relayed(cl));
  const pr = await openSession(PH, { text: (t) => t.replace(`program: ${PROG.toBase58()}`, 'program: 8xSaCrq6HidyjmE3khJ9DYewWdYNfn93nQEkYvqTEpig') });
  await send('X7. grant signed for another program id', false, viaSession(pr, policyMove(pr.pda, sysTransfer(VENUE, 0.001))), relayed(pr));
}

// ── R. No per-session revoke: the 2-of-3 removes a wallet's session PDA from the policy ─────────
{
  const fr = await openSession(FR), mm = await openSession(MM);
  await send('R0. Freighter session works before', true, viaSession(fr, policyMove(fr.pda, sysTransfer(VENUE, 0.001))), relayed(fr));
  const P = new PublicKey(st.policy);
  await decide('R1. MetaMask + Phantom update the policy: members MetaMask and Phantom PDAs only:', MM, PH, { settings: [{ __kind: 'PolicyUpdate', policy: P, policyUpdatePayload: policyPayload(),
    signers: [MM, PH].map((w) => ({ key: pdaOf(w.key), permissions: ALL })), threshold: 1, timeLock: 0, expirationArgs: null }], policies: [P] }, true);
  await send('R2. the live Freighter session after removal', false, viaSession(fr, policyMove(fr.pda, sysTransfer(VENUE, 0.001))), relayed(fr));
  await send('R3. MetaMask session still works', true, viaSession(mm, policyMove(mm.pda, sysTransfer(VENUE, 0.001))), relayed(mm));
}
console.log(`NEAR MPC signatures: ${stats.calls}, average ${(stats.ms / Math.max(1, stats.calls) / 1000).toFixed(1)}s`);
st.mpc = stats; save();
console.log(`${results.filter((r) => r.pass).length}/${results.length} passed`);
for (const r of results.filter((r) => !r.pass)) console.log('FAIL', r.name, r.detail);
process.exit(0);
