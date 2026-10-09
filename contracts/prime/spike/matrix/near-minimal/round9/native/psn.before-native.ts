// Solana matrix, NEAR-routed: a Squads Smart Account (cloned from devnet) on a local validator (PSN_NET=devnet: on devnet).
//   seats (settings signers, 2-of-3): Phantom (its own key), MetaMask and Freighter (their NEAR MPC ed25519 keys under
//         `prime:solana`: eth-implicit account for MetaMask, our SEP-53 wallet contract for Freighter). Each signs Solana txs itself.
//   sessions: prime-session PDA ["prime", owner, settings] per wallet per account is a member of the movers policy only, never a settings
//         signer. The owner signs one plain-text grant (Phantom signMessage with its own key, which is both seat and owner;
//         NEAR MPC under `prime:solana-session` for MetaMask and Freighter, so a grant signature can never be a seat vote),
//         then the session key signs each move. Fee payer: the relayer, or the session key itself.
//   revoke: the owner signs the grant text with time 0; one relayed transaction creates the revoked marker.
import { Connection, Ed25519Program, Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram, SYSVAR_INSTRUCTIONS_PUBKEY, Transaction,
  TransactionInstruction, TransactionMessage } from '@solana/web3.js';
import * as sa from '@sqds/smart-account';
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import { readFileSync, writeFileSync } from 'node:fs';
import { payer } from './keys.ts';
const { edKey, edSign, stats } = await import(process.env.NEARSIG_STUB ?? '/home/ubuntu/work/near-session-spike/nearsig.ts');

const NET = process.env.PSN_NET === 'devnet' ? 'devnet' : 'localnet';
const conn = new Connection(process.env.PSN_RPC ?? (NET === 'devnet' ? 'https://api.devnet.solana.com' : 'http://127.0.0.1:8899'), { commitment: 'confirmed', confirmTransactionInitialTimeout: 120_000 });
// local: a fixed id given to the validator with --bpf-program; devnet: the id of the keypair that `solana program deploy` uses (target/deploy/prime_session-keypair.json)
const PROG = NET === 'devnet' ? Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync('/home/ubuntu/work/prime-session/target/deploy/prime_session-keypair.json', 'utf8')))).publicKey
  : new PublicKey('FTNMFWiECbRp7D5MwJUiNQfee6NuJPjE7S11J9yc2B9G');
// the same .so at a second program id (--bpf-program locally, a second deploy on devnet) for the two-program-id checks
const PROG_B = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync('/home/ubuntu/work/swig-spike/secrets/prime-session-b.json', 'utf8')))).publicKey;
// PSN_R8=1 (local only): the round 8 .so is loaded at this id so the compute-unit samples compare both programs in one account.
const R8 = process.env.PSN_R8 && NET === 'localnet' ? new PublicKey('8xSaCrq6HidyjmE3khJ9DYewWdYNfn93nQEkYvqTEpig') : undefined;
const CLUSTER = NET;
const VAULT_SOL = NET === 'devnet' ? 0.25 : 2;
const SESSION_FUND = (NET === 'devnet' ? 0.002 : 0.05) * LAMPORTS_PER_SOL;   // devnet: just above the 0 B rent minimum (890,880 lamports)
const st: any = {}; const results: any[] = []; const metrics: any = {};
const STATE = process.env.PSN_STATE ?? `/home/ubuntu/work/prime-refine/logs/solana/state-psn-${NET}.json`;
const save = () => writeFileSync(STATE, JSON.stringify({ ...st, metrics, results }, null, 1));
const SOL = LAMPORTS_PER_SOL;
const VENUE = Keypair.generate().publicKey, OTHER = Keypair.generate().publicKey, DEST = Keypair.generate().publicKey;
const short = (e: any) => { const s = [e?.logs?.join(' '), e?.message, String(e)].filter(Boolean).join(' | ');
  return ((s.match(/prime-session: [^"]*?(?= Program|$)/) ?? s.match(/Error Code: \w+/) ?? s.match(/(custom program error: 0x[0-9a-f]+|Signature verification failed|Transaction did not pass signature verification|Transaction results in an account \(\d+\) with insufficient funds for rent|InsufficientFundsForRent|Attempt to debit an account but found no record of a prior credit|insufficient [a-z ]+|[A-Za-z]+Error[^"]{0,60})/i))?.[0] ?? s).slice(0, 160); };
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
/** Total compute units of the last transaction sent by `send`, prime-session's own share, and its size in bytes. */
async function measure(label: string, program = PROG) {
  const t = await conn.getTransaction(last.sig, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 });
  const logs = t?.meta?.logMessages ?? [];
  const mine = logs.map((l) => l.match(new RegExp(`^Program ${program.toBase58()} consumed (\\d+) of`))).filter(Boolean).map((m) => Number(m![1]));
  metrics[label] = { totalCu: t?.meta?.computeUnitsConsumed, primeSessionCu: mine[0], bytes: last.bytes, fee: t?.meta?.fee };
  console.log(`METRIC ${label} ${JSON.stringify(metrics[label])}`); save();
}
/** SOL for a session key or test wallet: an airdrop on the local validator, a transfer from the relayer on devnet (no faucet). */
let fundCount = 0;
async function fund(to: PublicKey, lamports: number) {
  fundCount++;
  if (NET === 'localnet') return void await confirm(await conn.requestAirdrop(to, lamports));
  await confirm(await conn.sendTransaction(new Transaction().add(SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: to, lamports })), [payer]));
}
function record(name: string, expectOk: boolean, ok: boolean, detail: string, want?: RegExp) {
  const pass = ok === expectOk && (ok || !want || want.test(detail)); results.push({ name, pass, ok, detail }); save();
  console.log(`${pass ? 'PASS' : 'FAIL'} ${name} | ${ok ? `ok ${detail}` : `refused: ${detail}`}`);
  return ok;
}

// ── Wallets ────────────────────────────────────────────────────────────────────────────────────
const PATH = 'prime:solana', SESSION_PATH = 'prime:solana-session';
type W = { name: string; key: PublicKey; sign: (m: Uint8Array) => Promise<Uint8Array> };
const viaNear = async (name: 'MetaMask' | 'Freighter', path = PATH): Promise<W> => ({ name, key: new PublicKey(await edKey(name, path)), sign: (m) => edSign(name, path, m) });
const phSecret = bs58.decode(JSON.parse(readFileSync('/home/ubuntu/work/phantom-spike/secrets/phantom-test.json', 'utf8')).secret);
const phKp = nacl.sign.keyPair.fromSecretKey(phSecret.length === 64 ? phSecret : nacl.sign.keyPair.fromSeed(phSecret).secretKey);
const PH: W = { name: 'Phantom', key: new PublicKey(phKp.publicKey), sign: async (m) => nacl.sign.detached(m, phKp.secretKey) };
const MM = await viaNear('MetaMask'), FR = await viaNear('Freighter');
// Session owners: MetaMask and Freighter sign grants under their own path, so no grant signature can be filed as a seat vote.
// Phantom's own key stays both seat and owner.
const SMM = await viaNear('MetaMask', SESSION_PATH), SFR = await viaNear('Freighter', SESSION_PATH);
const own = (w: W): W => ({ MetaMask: SMM, Freighter: SFR, Phantom: PH } as Record<string, W>)[w.name]!;
const FR_OTHER_PATH = await viaNear('Freighter', 'prime:solana-other');
const outsiderKp = Keypair.generate();
const OUT: W = { name: 'outsider', key: outsiderKp.publicKey, sign: async (m) => nacl.sign.detached(m, outsiderKp.secretKey) };
console.log({ MetaMask: MM.key.toBase58(), Freighter: FR.key.toBase58(), Phantom: PH.key.toBase58(), sessionMetaMask: SMM.key.toBase58(), sessionFreighter: SFR.key.toBase58(), program: PROG.toBase58(), programB: PROG_B.toBase58(), net: NET });
st.program = PROG.toBase58(); st.programB = PROG_B.toBase58(); st.sessionOwners = { MetaMask: SMM.key.toBase58(), Freighter: SFR.key.toBase58(), Phantom: PH.key.toBase58() };

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
let last = { sig: '', bytes: 0 };
/** One tx signed by plain keypairs (sessions); the first is the fee payer. */
async function send(name: string, expectOk: boolean, ixs: TransactionInstruction[], signers: Keypair[], want?: RegExp) {
  let ok = true, d = '';
  try {
    const tx = new Transaction().add(...ixs); tx.feePayer = signers[0]!.publicKey; tx.recentBlockhash = (await conn.getLatestBlockhash('confirmed')).blockhash;
    tx.sign(...signers);
    last = { sig: '', bytes: tx.serialize().length };
    d = await conn.sendRawTransaction(tx.serialize()); await confirm(d); last.sig = d;
    const s = await conn.getSignatureStatus(d); if (s.value?.err) { ok = false; d = JSON.stringify(s.value.err); }
  } catch (e: any) { ok = false; d = short(e); if (e?.getLogs) try { const l = await e.getLogs(conn); if (Array.isArray(l) && l.length) d = short({ logs: l }); } catch {} }
  return record(name, expectOk, ok, d, want);
}

// ── Smart Account helpers ──────────────────────────────────────────────────────────────────────
// `sel` switches every helper to a second Smart Account (account B) for the account-binding checks.
let sel: 'A' | 'B' = 'A';
const settings = () => new PublicKey(sel === 'B' ? st.settingsB : st.settings);
const policyAddr = () => new PublicKey(sel === 'B' ? st.policyB : st.policy);
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
  return ix.executePolicyPayloadSync({ policy: policyAddr(), accountIndex: 0, numSigners: 1, instruction_accounts: d.accounts,
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
const pdaOf = (owner: PublicKey, acct = settings(), prog = PROG) => PublicKey.findProgramAddressSync([Buffer.from('prime'), owner.toBuffer(), acct.toBuffer()], prog)[0];
/** The session PDA of wallet `w` (derived from its session owner key) in account `acct`. */
const pdaFor = (w: W, acct = settings(), prog = PROG) => pdaOf(own(w).key, acct, prog);
const markerOf = (owner: PublicKey, acct: PublicKey, key: PublicKey, prog = PROG) => PublicKey.findProgramAddressSync([owner.toBuffer(), acct.toBuffer(), key.toBuffer()], prog)[0];
const bumpOf = (owner: PublicKey, acct: PublicKey, prog = PROG) => PublicKey.findProgramAddressSync([Buffer.from('prime'), owner.toBuffer(), acct.toBuffer()], prog)[1];
const grantText = (pda: PublicKey, key: PublicKey, until: number, cluster = CLUSTER) =>
  `Prime session\nsigner: ${pda.toBase58()}\nsession key: ${key.toBase58()}\nvalid until (unix time): ${until}\ncluster: ${cluster}`;
type Session = { owner: PublicKey; acct: PublicKey; key: Keypair; until: number; pda: PublicKey; sigIx: TransactionInstruction };
const edIx = (signer: W, text: string, sig: Uint8Array) => Ed25519Program.createInstructionWithPublicKey({ publicKey: signer.key.toBytes(), message: Buffer.from(text), signature: sig });
async function openSession(w: W, o: { seconds?: number; signAs?: W; text?: (t: string) => string; fund?: number; key?: Keypair } = {}): Promise<Session> {
  const key = o.key ?? Keypair.generate(); const until = Math.floor(Date.now() / 1000) + (o.seconds ?? 3600); const pda = pdaFor(w);
  const text = (o.text ?? ((t) => t))(grantText(pda, key.publicKey, until));
  const signer = o.signAs ?? own(w);
  const sig = await signer.sign(new TextEncoder().encode(text));
  if (o.fund !== 0) await fund(key.publicKey, o.fund ?? SESSION_FUND);
  return { owner: own(w).key, acct: settings(), key, until, pda, sigIx: edIx(signer, text, sig) };
}
type Over = { until?: number; owner?: PublicKey; pda?: PublicKey; acct?: PublicKey; bump?: number; marker?: PublicKey; prog?: PublicKey };
/** [ed25519 program ix, prime-session execute(inner)]. */
function viaSession(s: Session, inner: TransactionInstruction, o: Over = {}): TransactionInstruction[] {
  const owner = o.owner ?? s.owner, pda = o.pda ?? s.pda, acct = o.acct ?? s.acct, prog = o.prog ?? PROG;
  const head = Buffer.concat([owner.toBuffer(), acct.toBuffer(), Buffer.from(new BigInt64Array([BigInt(o.until ?? s.until)]).buffer), Buffer.from([0, o.bump ?? bumpOf(owner, acct, prog)])]);
  const keys = [{ pubkey: SYSVAR_INSTRUCTIONS_PUBKEY, isSigner: false, isWritable: false }, { pubkey: s.key.publicKey, isSigner: true, isWritable: true },
    { pubkey: pda, isSigner: false, isWritable: false }, { pubkey: inner.programId, isSigner: false, isWritable: false },
    { pubkey: o.marker ?? markerOf(owner, acct, s.key.publicKey, prog), isSigner: false, isWritable: false },
    ...inner.keys.map((k) => ({ ...k, isSigner: k.pubkey.equals(pda) ? false : k.isSigner }))];
  return [s.sigIx, new TransactionInstruction({ programId: prog, keys, data: Buffer.concat([head, inner.data]) })];
}
/** A revoke: `owner` (a session owner key) signs the grant text with time 0 for `key`; the relayer pays and funds the marker. One owner signature. */
async function revokeIxs(w: W, key: PublicKey, o: { signAs?: W; owner?: PublicKey; acct?: PublicKey; pda?: PublicKey; marker?: PublicKey; prog?: PublicKey; data?: number } = {}): Promise<TransactionInstruction[]> {
  const owner = o.owner ?? own(w).key, acct = o.acct ?? settings(), prog = o.prog ?? PROG, pda = o.pda ?? pdaOf(owner, acct, prog);
  const text = grantText(pda, key, 0), signer = o.signAs ?? own(w);
  const sig = await signer.sign(new TextEncoder().encode(text));
  const head = Buffer.concat([owner.toBuffer(), acct.toBuffer(), Buffer.from(new BigInt64Array([0n]).buffer), Buffer.from([0, bumpOf(owner, acct, prog)])]);
  const keys = [{ pubkey: SYSVAR_INSTRUCTIONS_PUBKEY, isSigner: false, isWritable: false }, { pubkey: key, isSigner: false, isWritable: false },
    { pubkey: pda, isSigner: false, isWritable: false }, { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    { pubkey: o.marker ?? markerOf(owner, acct, key, prog), isSigner: false, isWritable: true }, { pubkey: payer.publicKey, isSigner: true, isWritable: true }];
  return [edIx(signer, text, sig), new TransactionInstruction({ programId: prog, keys, data: o.data !== undefined ? head.subarray(0, o.data) : head })];
}
const E2 = /0x2\b/, E4 = /0x4\b/, E7 = /0x7\b/;   // prime-session refusals: revoked or address not derived, expired or too long, not signed by the owner over this text
const relayed = (s: Session) => [payer, s.key];   // relayer pays the fee, session key co-signs
const selfPaid = (s: Session) => [s.key];         // relayer down: the session key pays

// ── P. Setup ───────────────────────────────────────────────────────────────────────────────────
if (NET === 'localnet') { if ((await conn.getBalance(payer.publicKey)) < 10 * SOL) await confirm(await conn.requestAirdrop(payer.publicKey, 100 * SOL)); }
else if ((await conn.getBalance(payer.publicKey)) < 0.8 * SOL) throw new Error(`relayer ${payer.publicKey.toBase58()} holds ${(await conn.getBalance(payer.publicKey)) / SOL} SOL on devnet; the run needs about 0.7 SOL after both programs are deployed`);
if (NET === 'devnet') for (const [n, id] of [['A', PROG], ['B', PROG_B]] as const) {
  if (!(await conn.getAccountInfo(id))?.executable) throw new Error(`prime-session ${n} (${id.toBase58()}) is not deployed on devnet: deploy target/deploy-devnet/prime_session.so first`);
}
const startBalance = await conn.getBalance(payer.publicKey);
async function createAccount() {
  const pc = await sa.accounts.ProgramConfig.fromAccountAddress(conn, sa.getProgramConfigPda({})[0]);
  const [settingsPda] = sa.getSettingsPda({ accountIndex: BigInt(pc.smartAccountIndex.toString()) + 1n });
  const tx = new Transaction().add(ix.createSmartAccount({ treasury: pc.treasury, creator: payer.publicKey, settings: settingsPda, settingsAuthority: null,
    threshold: 2, timeLock: 0, rentCollector: null, signers: [MM, FR, PH].map((w) => ({ key: w.key, permissions: ALL })) }),
    SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: sa.getSmartAccountPda({ settingsPda, accountIndex: 0 })[0], lamports: VAULT_SOL * SOL }));
  const sig = await conn.sendTransaction(tx, [payer]); await confirm(sig);
  return { settingsPda, sig };
}
{
  const { settingsPda, sig } = await createAccount();
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
  // A grant signature can never count as a seat vote: the session-owner keys are not settings signers and sign under their own path.
  for (const [w, so] of [[MM, SMM], [FR, SFR]] as [W, W][]) {
    await sendBy(`K6f-${w.name}. ${w.name}'s seat vote signed by its session-path key`, false, w, [ix.approveProposal({ settingsPda: settings(), transactionIndex: idx, signer: w.key })], so);
    await sendBy(`K6g-${w.name}. ${w.name}'s session-path key approves as itself`, false, so, [ix.approveProposal({ settingsPda: settings(), transactionIndex: idx, signer: so.key })]);
  }
  // movers policy: members are the three session PDAs; a 2-of-3 settings decision (MetaMask + Phantom)
  const seed = Number((await sa.accounts.Settings.fromAccountAddress(conn, settings())).policySeed ?? 0) + 1;
  const policy = sa.getPolicyPda({ settingsPda: settings(), policySeed: seed })[0];
  st.policy = policy.toBase58(); st.policySeed = seed; save();
  await decide('K7. install the movers policy (members: the three session PDAs):', MM, PH, { settings: [{ __kind: 'PolicyCreate', seed, policyCreationPayload: policyPayload(),
    signers: [MM, FR, PH].map((w) => ({ key: pdaFor(w), permissions: ALL })), threshold: 1, timeLock: 0, startTimestamp: null, expirationArgs: null }], policies: [policy] }, true);
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
  await measure(`move-${w.name}-relayed`);
  await send(`G-${w.name}2. relayer down: session key pays the fee itself: 0.005 SOL to VENUE`, true, viaSession(s, policyMove(s.pda, sysTransfer(VENUE, 0.005))), selfPaid(s));
  record(`G-${w.name}3. VENUE received exactly 0.015 SOL`, true, (await conn.getBalance(VENUE)) - b === 0.015 * SOL, `${((await conn.getBalance(VENUE)) - b) / SOL}`);
  const broke = await openSession(w, { fund: 0 });
  await send(`G-${w.name}4. relayer down and the session key has no SOL`, false, viaSession(broke, policyMove(broke.pda, sysTransfer(VENUE, 0.001))), selfPaid(broke));
  await send(`G-${w.name}5. same session: 0.01 SOL elsewhere (policy)`, false, viaSession(s, policyMove(s.pda, sysTransfer(OTHER, 0.01))), relayed(s));
  await send(`G-${w.name}6. same session: 0.06 SOL to VENUE (over the 0.05 per-move limit)`, false, viaSession(s, policyMove(s.pda, sysTransfer(VENUE, 0.06))), relayed(s));
  await send(`G-${w.name}7. stretched valid-until`, false, viaSession(s, policyMove(s.pda, sysTransfer(VENUE, 0.001)), { until: s.until + 60 }), relayed(s), E7);
  const thief = Keypair.generate(); await fund(thief.publicKey, SESSION_FUND);
  await send(`G-${w.name}8. someone else replays the grant with their own key`, false, viaSession({ ...s, key: thief }, policyMove(s.pda, sysTransfer(VENUE, 0.001))), [thief]);
}
{
  const long = await openSession(PH, { seconds: 8 * 86400 });
  await send('G9. grant longer than 7 days', false, viaSession(long, policyMove(long.pda, sysTransfer(VENUE, 0.001))), relayed(long), E4);
  const old = await openSession(PH, { seconds: -10 });
  await send('G10. expired grant', false, viaSession(old, policyMove(old.pda, sysTransfer(VENUE, 0.001))), relayed(old), E4);
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
  await send("X1. Freighter's PDA with a grant signed by MetaMask (NEAR)", false, viaSession(a, policyMove(a.pda, sysTransfer(VENUE, 0.001))), relayed(a), E7);
  const b = await openSession(PH, { signAs: FR });
  await send("X2. Phantom's PDA with a grant signed by Freighter (NEAR)", false, viaSession(b, policyMove(b.pda, sysTransfer(VENUE, 0.001))), relayed(b), E7);
  const c = await openSession(MM, { signAs: PH });
  await send("X3. MetaMask's PDA with a grant signed by Phantom", false, viaSession(c, policyMove(c.pda, sysTransfer(VENUE, 0.001))), relayed(c), E7);
  const d = await openSession(FR, { signAs: FR_OTHER_PATH });
  await send("X4. Freighter's PDA with its MPC key under another path", false, viaSession(d, policyMove(d.pda, sysTransfer(VENUE, 0.001))), relayed(d), E7);
  const e = await openSession(FR, { signAs: FR });
  await send("X4b. Freighter's session PDA with a grant signed by its seat key (prime:solana)", false, viaSession(e, policyMove(e.pda, sysTransfer(VENUE, 0.001))), relayed(e), E7);
  const ph = await openSession(PH);
  await send("X5. Phantom grant presented for MetaMask's PDA", false, viaSession(ph, policyMove(pdaFor(MM), sysTransfer(VENUE, 0.001)), { owner: own(MM).key, pda: pdaFor(MM) }), relayed(ph), E7);
  const cl = await openSession(PH, { text: (t) => t.replace('cluster: localnet', 'cluster: mainnet') });
  await send('X6. grant signed for cluster mainnet, used on localnet', false, viaSession(cl, policyMove(cl.pda, sysTransfer(VENUE, 0.001))), relayed(cl), E7);
  // The same .so at a second program id (PROG_B). The grant text has no program line: the PDA it names commits to the program.
  {
    const gA = await openSession(PH);                                   // names program A's PDA
    const inner = (pda: PublicKey) => policyMove(pda, sysTransfer(VENUE, 0.001));
    const pdaB = pdaOf(PH.key, settings(), PROG_B);
    await send("X7a. a grant naming program A's PDA, presented to program B with A's PDA", false, viaSession(gA, inner(gA.pda), { prog: PROG_B }), relayed(gA));
    await send("X7b. the same grant presented to program B with B's PDA (text mismatch)", false, viaSession(gA, inner(pdaB), { prog: PROG_B, pda: pdaB }), relayed(gA));
    const gB = { ...(await openSession(PH, { text: (t) => t.replace(`signer: ${gA.pda.toBase58()}`, `signer: ${pdaB.toBase58()}`) })), pda: pdaB };
    await send("X7c. a grant naming program B's PDA, presented to program A with B's PDA", false, viaSession(gB, inner(pdaB), { pda: pdaB }), relayed(gB));
    await send("X7d. the same grant presented to program A with A's PDA (text mismatch)", false, viaSession(gB, inner(gA.pda), { pda: gA.pda }), relayed(gB));
  }
  // prime-session has no explicit PDA check: Phantom signs a grant naming MetaMask's PDA (a real policy signer); the runtime
  // must refuse, because invoke_signed's seeds derive only Phantom's PDA.
  const mmPda = pdaFor(MM);
  const fake = await openSession(PH, { text: (t) => t.replace(`signer: ${pdaFor(PH).toBase58()}`, `signer: ${mmPda.toBase58()}`) });
  await send("X8. Phantom's own signed grant naming MetaMask's PDA", false, viaSession(fake, policyMove(mmPda, sysTransfer(VENUE, 0.001)), { pda: mmPda }), relayed(fake), E2);
  // right PDA and grant, but another Smart Account's settings in the data: the seeds then derive a different PDA
  const ph8 = await openSession(PH);
  await send('X9a. valid Phantom grant, data names another settings address', false, viaSession(ph8, policyMove(ph8.pda, sysTransfer(VENUE, 0.001)), { acct: OUT.key }), relayed(ph8), E2);
  // the session key does not sign the transaction (only the relayer does)
  const ns = viaSession(ph8, policyMove(ph8.pda, sysTransfer(VENUE, 0.001)));
  ns[1] = new TransactionInstruction({ ...ns[1], keys: ns[1].keys.map((k, i) => (i === 1 ? { ...k, isSigner: false } : k)) });
  await send('X10. the session key does not sign (relayer only)', false, ns, [payer]);
  // prime-session has no target check: its inner call always goes to the Smart Account program (a constant). With
  // account 3 set to the System program, the move still runs, and the only program called from prime-session is the
  // Smart Account (the System program is reached only from the Smart Account's vault, one level deeper).
  const wt = viaSession(ph8, policyMove(ph8.pda, sysTransfer(VENUE, 0.001)));
  wt[1] = new TransactionInstruction({ ...wt[1], keys: wt[1].keys.map((k, i) => (i === 3 ? { ...k, pubkey: SystemProgram.programId } : k)) });
  await send('X11a. account 3 set to the System program instead of the Smart Account program: the move still runs', true, wt, relayed(ph8));
  const [last] = await conn.getSignaturesForAddress(PROG, { limit: 1 }, 'confirmed');
  const logs = (await conn.getTransaction(last!.signature, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 }))?.meta?.logMessages ?? [];
  const depth2 = logs.filter((l) => l.endsWith(' invoke [2]'));
  record('X11b. ...and prime-session called only the Smart Account program', true, depth2.length === 1 && depth2[0]!.includes('SMRTzfY6DfH5ik3TKiyLFfXexV8uSG3d2UksSCYdunG'), `${last!.signature.slice(0, 12)}… ${depth2.join('; ')}`);
}

// ── A. A grant works in one Smart Account only ────────────────────────────────────────────────
{
  const a = await openSession(PH);                       // granted for account A
  const { settingsPda: B, sig } = await createAccount();  // account B: same three seats
  st.settingsB = B.toBase58(); sel = 'B';
  const seed = Number((await sa.accounts.Settings.fromAccountAddress(conn, settings())).policySeed ?? 0) + 1;
  st.policyB = sa.getPolicyPda({ settingsPda: settings(), policySeed: seed })[0].toBase58(); save();
  record('A0. account B created with the same three seats', true, true, sig);
  await decide("A1. account B installs its movers policy (members: each wallet's PDA for account B):", MM, PH, { settings: [{ __kind: 'PolicyCreate', seed, policyCreationPayload: policyPayload(),
    signers: [...[MM, FR, PH].map((w) => pdaFor(w)), ...(R8 ? [pdaOf(PH.key, B, R8)] : [])].map((key) => ({ key, permissions: ALL })), threshold: 1, timeLock: 0, startTimestamp: null, expirationArgs: null }], policies: [policyAddr()] }, true);
  record("A2. each wallet's PDA differs between account A and account B", true, [MM, FR, PH].every((w) => !pdaFor(w, new PublicKey(st.settings)).equals(pdaFor(w, B))), [MM, FR, PH].map((w) => pdaFor(w).toBase58().slice(0, 6)).join(','));
  await send("A3. account A's Phantom grant presented to account B (as Phantom's account-B PDA)", false, viaSession(a, policyMove(pdaFor(PH), sysTransfer(VENUE, 0.001)), { acct: B, pda: pdaFor(PH) }), relayed(a));
  await send("A4. account A's Phantom PDA calling account B's policy", false, viaSession(a, policyMove(a.pda, sysTransfer(VENUE, 0.001))), relayed(a));
  const b = await openSession(PH);                       // granted for account B
  await send('A5. a Phantom grant made for account B works in account B', true, viaSession(b, policyMove(b.pda, sysTransfer(VENUE, 0.001))), relayed(b));
  // Compute units of a whole move (prime-session plus the Smart Account call) over ten sessions: the bump search for the marker differs per key.
  // With PSN_R8 the round 8 program runs ten moves in this same account, interleaved with the current program's.
  const cu: number[] = [], cu8: number[] = [];
  for (let i = 0; i < 10; i++) {
    const m = await openSession(PH);
    await send(`A5-M${i}. Phantom session: one move through the Smart Account (compute units recorded)`, true, viaSession(m, policyMove(m.pda, sysTransfer(VENUE, 0.00001))), relayed(m));
    await measure(`move-sample-${i}`); cu.push(metrics[`move-sample-${i}`].totalCu);
    if (!R8) continue;
    const key = Keypair.generate(), until = Math.floor(Date.now() / 1000) + 3600, pda8 = pdaOf(PH.key, B, R8);
    const text = `Prime session\nsigner: ${pda8.toBase58()}\nsession key: ${key.publicKey.toBase58()}\nvalid until (unix time): ${until}\ncluster: ${CLUSTER}\nprogram: ${R8.toBase58()}`;
    await fund(key.publicKey, SESSION_FUND);
    const inner = policyMove(pda8, sysTransfer(VENUE, 0.00001));
    const head = Buffer.concat([PH.key.toBuffer(), B.toBuffer(), Buffer.from(new BigInt64Array([BigInt(until)]).buffer), Buffer.from([0])]);
    const keys = [{ pubkey: SYSVAR_INSTRUCTIONS_PUBKEY, isSigner: false, isWritable: false }, { pubkey: key.publicKey, isSigner: true, isWritable: true },
      { pubkey: pda8, isSigner: false, isWritable: false }, { pubkey: inner.programId, isSigner: false, isWritable: false },
      ...inner.keys.map((k) => ({ ...k, isSigner: k.pubkey.equals(pda8) ? false : k.isSigner }))];
    await send(`A5-R${i}. round 8 program, same account: one move through the Smart Account (compute units recorded)`, true,
      [edIx(PH, text, await PH.sign(new TextEncoder().encode(text))), new TransactionInstruction({ programId: R8, keys, data: Buffer.concat([head, inner.data]) })], [payer, key]);
    await measure(`move8-sample-${i}`, R8); cu8.push(metrics[`move8-sample-${i}`].totalCu);
  }
  const stat = (v: number[]) => { v.sort((x, y) => x - y); return { samples: v, min: v[0], median: (v[4]! + v[5]!) / 2, max: v[9] }; };
  metrics.moveCu = { ...stat(cu), txBytes: last.bytes };
  if (R8) metrics.moveCuRound8 = stat(cu8);
  sel = 'A';
  await send("A6. account B's grant presented to account A", false, viaSession(b, policyMove(pdaFor(PH), sysTransfer(VENUE, 0.001)), { acct: settings(), pda: pdaFor(PH) }), relayed(b));
}

// ── V. Per-session revoke: the owner signs the grant text with time 0, one relayed transaction ──
{
  const mv = (s: Session) => viaSession(s, policyMove(s.pda, sysTransfer(VENUE, 0.00001)));   // small, so the daily cap checked in G13 is not used up
  const s1 = await openSession(PH), s2 = await openSession(PH);
  await send('V0a. Phantom session 1 works', true, mv(s1), relayed(s1));
  await send('V0b. Phantom session 2 works', true, mv(s2), relayed(s2));
  const m1 = markerOf(PH.key, settings(), s1.key.publicKey);
  record('V0c. no marker exists for session 1 yet', true, (await conn.getAccountInfo(m1)) === null, m1.toBase58());
  await send('V1. Phantom revokes session 1 (one signature, relayed, session key does not sign)', true, await revokeIxs(PH, s1.key.publicKey), [payer]);
  await measure('revoke');
  const mi = (await conn.getAccountInfo(m1))!;
  metrics.revokeRent = { lamports: mi.lamports, dataBytes: mi.data.length, owner: mi.owner.toBase58() };
  record('V1b. the marker is empty, owned by prime-session and rent exempt', true, mi.owner.equals(PROG) && mi.data.length === 0 && mi.lamports === (await conn.getMinimumBalanceForRentExemption(0)), JSON.stringify(metrics.revokeRent));
  await send('V2. the revoked session 1 is refused', false, mv(s1), relayed(s1), E2);
  await send("V3. the same wallet's session 2 keeps working", true, mv(s2), relayed(s2));
  await send('V3b. revoking session 1 again is refused', false, await revokeIxs(PH, s1.key.publicKey), [payer], E2);
  // another wallet's revoke
  await send("V4a. MetaMask's session-owner key signs a revoke of Phantom's session 2 (data names Phantom as owner)", false, await revokeIxs(PH, s2.key.publicKey, { signAs: SMM }), [payer], E7);
  await send("V4b. MetaMask signs a revoke naming Phantom's PDA under its own owner field", false, await revokeIxs(MM, s2.key.publicKey, { pda: pdaFor(PH) }), [payer], E2);
  await send('V4c. Phantom session 2 still works', true, mv(s2), relayed(s2));
  await send("V4d. MetaMask revokes the same key under its own PDA (a marker in MetaMask's namespace)", true, await revokeIxs(MM, s2.key.publicKey), [payer]);
  await send("V4e. ...and Phantom's session 2 still works (the marker is per owner)", true, mv(s2), relayed(s2));
  // pre-emptive revoke of a key that was never granted
  const never = Keypair.generate();
  await send('V5a. Phantom revokes a key it never granted', true, await revokeIxs(PH, never.publicKey), [payer]);
  const late = await openSession(PH, { key: never });
  await send('V5b. a grant signed for that key afterwards is refused', false, mv(late), relayed(late), E2);
  // a revoke signed for account A, sent with account B's settings
  const B = new PublicKey(st.settingsB), s3 = await openSession(PH);
  await send("V6a. a revoke signed for account A's PDA, sent with account B's settings and B's marker", false,
    await revokeIxs(PH, s3.key.publicKey, { acct: B, pda: pdaFor(PH), marker: markerOf(PH.key, B, s3.key.publicKey) }), [payer], E2);
  record('V6b. no marker was created in account B', true, (await conn.getAccountInfo(markerOf(PH.key, B, s3.key.publicKey))) === null, '');
  await send('V6c. session 3 still works in account A', true, mv(s3), relayed(s3));
  // a stranger pre-funds the marker address
  const s4 = await openSession(PH), m4 = markerOf(PH.key, settings(), s4.key.publicKey);
  {
    const t = new Transaction().add(SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: m4, lamports: 1000 })); t.feePayer = payer.publicKey;
    t.recentBlockhash = (await conn.getLatestBlockhash('confirmed')).blockhash; t.sign(payer);
    const r = await conn.simulateTransaction(t);
    record('V7a. a pre-fund below the rent minimum is refused by the runtime', false, !r.value.err, JSON.stringify(r.value.err), /InsufficientFundsForRent/);
  }
  await send('V7b. a stranger pre-funds the marker address with 0.001 SOL', true, [SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: m4, lamports: 0.001 * SOL })], [payer]);
  await send('V7c. the revoke still works', true, await revokeIxs(PH, s4.key.publicKey), [payer]);
  await send('V7d. the revoked session 4 is refused', false, mv(s4), relayed(s4), E2);
  // a marker address that is not the key's marker
  const s5 = await openSession(PH);
  await send('V8a. a move that passes another marker address', false, viaSession(s5, policyMove(s5.pda, sysTransfer(VENUE, 0.00001)), { marker: Keypair.generate().publicKey }), relayed(s5), E2);
  // a non-canonical bump with the right PDA account
  const canon = bumpOf(PH.key, settings(), PROG); let alt = -1;
  for (let b = canon - 1; b >= 0 && alt < 0; b--) { try { PublicKey.createProgramAddressSync([Buffer.from('prime'), PH.key.toBuffer(), settings().toBuffer(), Buffer.from([b])], PROG); alt = b; } catch {} }
  await send(`V8b. a move with non-canonical bump ${alt} (canonical ${canon}) and the canonical PDA account`, false, viaSession(s5, policyMove(s5.pda, sysTransfer(VENUE, 0.00001)), { bump: alt }), relayed(s5), E2);
  await send('V8c. the same session with the canonical bump works', true, viaSession(s5, policyMove(s5.pda, sysTransfer(VENUE, 0.00001))), relayed(s5));
  // instruction data too short
  await send('V9. a 72-byte instruction (the old length check)', false, await revokeIxs(PH, Keypair.generate().publicKey, { data: 72 }), [payer]);
  await send('V9b. a 10-byte instruction', false, await revokeIxs(PH, Keypair.generate().publicKey, { data: 10 }), [payer]);
}

// ── R. The 2-of-3 removes a wallet's session PDA from the policy (stops every session of that wallet) ──
{
  const fr = await openSession(FR), mm = await openSession(MM);
  await send('R0. Freighter session works before', true, viaSession(fr, policyMove(fr.pda, sysTransfer(VENUE, 0.001))), relayed(fr));
  const P = new PublicKey(st.policy);
  await decide('R1. MetaMask + Phantom update the policy: members MetaMask and Phantom PDAs only:', MM, PH, { settings: [{ __kind: 'PolicyUpdate', policy: P, policyUpdatePayload: policyPayload(),
    signers: [MM, PH].map((w) => ({ key: pdaFor(w), permissions: ALL })), threshold: 1, timeLock: 0, expirationArgs: null }], policies: [P] }, true);
  await send('R2. the live Freighter session after removal', false, viaSession(fr, policyMove(fr.pda, sysTransfer(VENUE, 0.001))), relayed(fr));
  await send('R3. MetaMask session still works', true, viaSession(mm, policyMove(mm.pda, sysTransfer(VENUE, 0.001))), relayed(mm));
}
{
  const spent = startBalance - (await conn.getBalance(payer.publicKey)), accounts = 2;
  // devnet cost = what the relayer paid (rent, fees, vault funding) with the vault funding of this network swapped for the devnet one, plus the session keys' funding
  metrics.relayerSpend = { net: NET, spentLamports: spent, vaultFundingLamports: accounts * VAULT_SOL * SOL, sessionKeysFunded: fundCount, sessionKeyFundingDevnetLamports: fundCount * 0.002 * SOL,
    devnetEstimateLamports: spent - accounts * VAULT_SOL * SOL + accounts * 0.25 * SOL + (NET === 'devnet' ? 0 : fundCount * 0.002 * SOL) };
  console.log('METRIC relayerSpend', JSON.stringify(metrics.relayerSpend));
}
console.log(`NEAR MPC signatures: ${stats.calls}, average ${(stats.ms / Math.max(1, stats.calls) / 1000).toFixed(1)}s`);
st.mpc = stats; save();
console.log(`${results.filter((r) => r.pass).length}/${results.length} passed`);
for (const r of results.filter((r) => !r.pass)) console.log('FAIL', r.name, r.detail);
process.exit(0);
