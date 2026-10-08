// Solana matrix, NEAR-routed: a Squads Smart Account (cloned from devnet) on a local validator (PSN_NET=devnet: on devnet).
//   seats (settings signers, 2-of-3): Phantom (its own key), MetaMask and Freighter (their NEAR MPC ed25519 keys under
//         `prime:solana`: eth-implicit account for MetaMask, our SEP-53 wallet contract for Freighter). Each signs Solana txs itself.
//   sessions: prime-session PDA ["prime", owner, settings] per wallet per account is a member of the movers policy only, never a settings
//         signer. The owner signs one plain-text grant (Phantom signMessage with its own key, which is both seat and owner;
//         NEAR MPC under `prime:solana-session` for MetaMask and Freighter, so a grant signature can never be a seat vote),
//         then the session key signs each move. Fee payer: the relayer, or the session key itself.
//   revoke: the owner signs the grant text with time 0; one relayed transaction creates the revoked marker.
//   PSN_NATIVE=1: MetaMask uses its own Solana account (built-in Solana snap) as both its settings signer and its grant owner, with no NEAR
//         for MetaMask. Grants and revokes are signMessage (PSN_MM_BRIDGE=http://127.0.0.1:8830 sends them to the real extension,
//         metamask-sol/bridge.mjs). Seat votes are transactions: MetaMask's signTransaction rewrites the transaction (adds a compute unit price
//         first and a compute unit limit last), so the wallet's signer here does the same, using the key derived from the same test seed;
//         the real wallet only signs transactions that simulate on devnet or mainnet, which a local validator cannot offer.
import { ComputeBudgetProgram, Message, Connection, Ed25519Program, Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram, SYSVAR_INSTRUCTIONS_PUBKEY, Transaction,
  TransactionInstruction, TransactionMessage } from '@solana/web3.js';
import * as sa from '@sqds/smart-account';
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import { readFileSync, writeFileSync } from 'node:fs';
import { createHmac } from 'node:crypto';
import { mnemonicToSeedSync } from '@scure/bip39';
import { payer } from './keys.ts';
const { edKey, edSign, stats } = await import(process.env.NEARSIG_STUB ?? '/home/ubuntu/work/near-session-spike/nearsig.ts');

const NET = process.env.PSN_NET === 'devnet' ? 'devnet' : 'localnet';
const NATIVE = !!process.env.PSN_NATIVE, MM_BRIDGE = process.env.PSN_MM_BRIDGE;
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
const STATE = process.env.PSN_STATE ?? `/home/ubuntu/work/prime-refine/logs/${NATIVE ? 'native' : 'solana'}/state-psn-${NET}${NATIVE ? '-native' : ''}.json`;
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
type W = { name: string; key: PublicKey; sign: (m: Uint8Array) => Promise<Uint8Array>; signText?: (m: Uint8Array) => Promise<Uint8Array>;
  prepare?: (ixs: TransactionInstruction[], feePayer: PublicKey) => Promise<TransactionInstruction[]>;   // the app's client rule for a wallet that rewrites
  signTx?: (tx: Transaction) => Promise<Transaction> };   // the wallet's signTransaction: returns the transaction it signed (possibly rewritten)
const viaNear = async (name: 'MetaMask' | 'Freighter', path = PATH): Promise<W> => ({ name, key: new PublicKey(await edKey(name, path)), sign: (m) => edSign(name, path, m) });
const phSecret = bs58.decode(JSON.parse(readFileSync('/home/ubuntu/work/phantom-spike/secrets/phantom-test.json', 'utf8')).secret);
const phKp = nacl.sign.keyPair.fromSecretKey(phSecret.length === 64 ? phSecret : nacl.sign.keyPair.fromSeed(phSecret).secretKey);
const PH: W = { name: 'Phantom', key: new PublicKey(phKp.publicKey), sign: async (m) => nacl.sign.detached(m, phKp.secretKey) };
// MetaMask's own Solana account: SLIP-0010 ed25519 at m/44'/501'/0'/0' of the test seed inside the extension profile.
const nat = { msgCalls: 0, msgMs: 0, txCalls: 0, wouldRefuse: 0, wouldRefuseChecks: [] as string[] };
let curCheck = '';
const slip10 = (seed: Buffer, path: number[]) => { let I = createHmac('sha512', 'ed25519 seed').update(seed).digest(); let k = I.subarray(0, 32), c = I.subarray(32);
  for (const i of path) { const d = Buffer.alloc(37); d.set(k, 1); d.writeUInt32BE((0x80000000 | i) >>> 0, 33); I = createHmac('sha512', c).update(d).digest(); k = I.subarray(0, 32); c = I.subarray(32); } return k; };
const mmKp = NATIVE ? nacl.sign.keyPair.fromSeed(slip10(Buffer.from(mnemonicToSeedSync(JSON.parse(readFileSync('/home/ubuntu/work/metamask-sol/secrets/mm-test.json', 'utf8')).srp)), [44, 501, 0, 0])) : undefined;
const bridge = async (body: object) => { const r = await (await fetch(MM_BRIDGE!, { method: 'POST', body: JSON.stringify(body) })).json() as any; if (r.error) throw new Error(`MetaMask: ${r.error}`); return r; };
if (NATIVE && MM_BRIDGE) { const a = (await bridge({ method: 'address' })).address; if (a !== bs58.encode(mmKp!.publicKey)) throw new Error(`the real MetaMask account ${a} is not the key derived from its test seed`); }
/** What MetaMask's Solana snap (5.0.1, signMessage) signs for a message: the bytes decoded as UTF-8 (invalid sequences become U+FFFD), U+0000 removed, encoded again. Plain text is signed as is. */
const mmSignedBytes = (m: Uint8Array) => new TextEncoder().encode(new TextDecoder().decode(m).replace(/\u0000/g, ''));
const CB = ComputeBudgetProgram.programId;
const isBudget = (i: TransactionInstruction, kind: 2 | 3) => i.programId.equals(CB) && i.data[0] === kind;   // 2 = SetComputeUnitLimit, 3 = SetComputeUnitPrice
const MM_PRICE = 10_000;                                                                                  // micro-lamports per unit: the snap's default
/** The app's client rule for MetaMask: build the transaction with both budget instructions in place (price first, limit last), the limit set the way the snap sets it:
 *  the units a simulation consumes with a 1,400,000 limit in place. The snap then signs the message as built, so instruction indexes (prime-session's sig_ix) stay put. */
async function withBudget(ixs: TransactionInstruction[], feePayer: PublicKey, blockhash?: string): Promise<TransactionInstruction[]> {
  const base = ixs.filter((i) => !i.programId.equals(CB)), price = ixs.find((i) => isBudget(i, 3)) ?? ComputeBudgetProgram.setComputeUnitPrice({ microLamports: MM_PRICE });
  const t = new Transaction().add(price, ...base, ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 })); t.feePayer = feePayer; t.recentBlockhash = blockhash ?? (await conn.getLatestBlockhash('confirmed')).blockhash;
  const sim = await conn.simulateTransaction(t); let units = 200_000;
  if (sim.value.err || sim.value.unitsConsumed == null) { nat.wouldRefuse++; nat.wouldRefuseChecks.push(curCheck.split('.')[0]!); } else units = sim.value.unitsConsumed;   // a reverting simulation disables Confirm in the real wallet
  return [price, ...base, ComputeBudgetProgram.setComputeUnitLimit({ units })];
}
/** The relayer's check before it co-signs a transaction a wallet returned: same fee payer and blockhash, the instructions it built (compute-budget ones aside),
 *  at most one price and one limit, a capped priority fee, and the wallet's signature valid over the returned message. Returns the reason to refuse, or null. */
const MAX_PRIORITY_LAMPORTS = 25_000;
function acceptReturned(built: Transaction, ret: Transaction, wallet: PublicKey): string | null {
  if (!ret.feePayer?.equals(built.feePayer!)) return 'fee payer changed';
  if (ret.recentBlockhash !== built.recentBlockhash) return 'blockhash changed';
  const a = built.instructions.filter((i) => !i.programId.equals(CB)), b = ret.instructions.filter((i) => !i.programId.equals(CB));
  if (a.length !== b.length || a.some((x, n) => !x.programId.equals(b[n]!.programId) || !Buffer.from(x.data).equals(Buffer.from(b[n]!.data)) || x.keys.length !== b[n]!.keys.length
    || x.keys.some((k, m) => !k.pubkey.equals(b[n]!.keys[m]!.pubkey) || k.isSigner !== b[n]!.keys[m]!.isSigner || k.isWritable !== b[n]!.keys[m]!.isWritable))) return 'instructions or accounts differ from the ones the relayer built';
  const budget = ret.instructions.filter((i) => i.programId.equals(CB)), prices = budget.filter((i) => isBudget(i, 3)), limits = budget.filter((i) => isBudget(i, 2));
  if (budget.length !== prices.length + limits.length || prices.length > 1 || limits.length > 1) return 'a compute-budget instruction other than one price and one limit';
  if (prices[0]?.data.length !== undefined && prices[0].data.length !== 9 || limits[0]?.data.length !== undefined && limits[0].data.length !== 5) return 'malformed compute-budget data';
  const price = prices[0] ? prices[0].data.readBigUInt64LE(1) : 0n, limit = limits[0] ? BigInt(limits[0].data.readUInt32LE(1)) : 200_000n;
  if (price * limit / 1_000_000n > BigInt(MAX_PRIORITY_LAMPORTS)) return `priority fee above the cap (${price * limit / 1_000_000n} lamports)`;
  const sig = ret.signatures.find((x) => x.publicKey.equals(wallet))?.signature;
  if (!sig || !nacl.sign.detached.verify(ret.serializeMessage(), sig, wallet.toBytes())) return "the wallet's signature does not verify over the returned message";
  return null;
}
const MMN: W = { name: 'MetaMask', key: new PublicKey(mmKp?.publicKey ?? new Uint8Array(32)),
  sign: async (m) => { nat.txCalls++; return nacl.sign.detached(m, mmKp!.secretKey); },   // signTransaction: the signature is over the (rewritten) message bytes
  signText: async (m) => { nat.msgCalls++; const t0 = Date.now();
    try { return MM_BRIDGE ? Uint8Array.from((await bridge({ method: 'signMessage', hex: Buffer.from(m).toString('hex') })).signature) : nacl.sign.detached(mmSignedBytes(m), mmKp!.secretKey); } finally { nat.msgMs += Date.now() - t0; } },
  prepare: (ixs, feePayer) => withBudget(ixs, feePayer),
  signTx: async (tx) => { nat.txCalls++;
    // snap 5.0.1 partiallySignBase64String: any signature already in the transaction, or both budget instructions already present, and it signs the message as is
    const keep = tx.signatures.some((x) => x.signature) || (tx.instructions.some((i) => isBudget(i, 3)) && tx.instructions.some((i) => isBudget(i, 2)));
    const t = keep ? tx : Object.assign(new Transaction({ feePayer: tx.feePayer, recentBlockhash: tx.recentBlockhash }), { instructions: await withBudget(tx.instructions, tx.feePayer!, tx.recentBlockhash!) });
    const out = new Transaction({ feePayer: t.feePayer, recentBlockhash: t.recentBlockhash }); out.instructions = t.instructions; out.signatures = t.signatures.map((x) => ({ ...x }));
    const sig = nacl.sign.detached(out.serializeMessage(), mmKp!.secretKey); const i = out.signatures.findIndex((x) => x.publicKey.equals(MMN.key));
    if (i < 0) out.signatures.push({ publicKey: MMN.key, signature: Buffer.from(sig) }); else out.signatures[i]!.signature = Buffer.from(sig);
    return out; } };
const MM = NATIVE ? MMN : await viaNear('MetaMask'), FR = await viaNear('Freighter');
// Session owners: MetaMask and Freighter sign grants under their own path, so no grant signature can be filed as a seat vote.
// Phantom's own key stays both seat and owner.
const SMM = NATIVE ? MMN : await viaNear('MetaMask', SESSION_PATH), SFR = await viaNear('Freighter', SESSION_PATH);
const own = (w: W): W => ({ MetaMask: SMM, Freighter: SFR, Phantom: PH } as Record<string, W>)[w.name] ?? w;
const FR_OTHER_PATH = await viaNear('Freighter', 'prime:solana-other');
const outsiderKp = Keypair.generate();
const OUT: W = { name: 'outsider', key: outsiderKp.publicKey, sign: async (m) => nacl.sign.detached(m, outsiderKp.secretKey) };
console.log({ MetaMask: MM.key.toBase58(), Freighter: FR.key.toBase58(), Phantom: PH.key.toBase58(), sessionMetaMask: SMM.key.toBase58(), sessionFreighter: SFR.key.toBase58(), program: PROG.toBase58(), programB: PROG_B.toBase58(), net: NET });
st.program = PROG.toBase58(); st.programB = PROG_B.toBase58(); st.sessionOwners = { MetaMask: SMM.key.toBase58(), Freighter: SFR.key.toBase58(), Phantom: PH.key.toBase58() };

/** One tx: instructions signed by `w` (a seat), fee paid by the relayer (or by `w` with selfPaid). A wallet that rewrites gets the transaction with its budget instructions in
 *  place (noPrepare skips that, to show the rewrite); the relayer checks what the wallet returns before it co-signs. */
async function sendBy(name: string, expectOk: boolean, w: W, ixs: TransactionInstruction[], signAs?: W, o: { want?: RegExp; selfPaid?: boolean; noPrepare?: boolean } = {}) {
  curCheck = name;
  const feePayer = o.selfPaid ? w.key : payer.publicKey;
  const built = w.prepare && !o.noPrepare ? await w.prepare(ixs, feePayer) : ixs;
  let tx = new Transaction().add(...built); tx.feePayer = feePayer; tx.recentBlockhash = (await conn.getLatestBlockhash('confirmed')).blockhash;
  let ok = true, d = '';
  try {
    const signer = signAs ?? w;
    if (signer.signTx) { const ret = await signer.signTx(tx); const bad = acceptReturned(tx, ret, w.key); if (bad) throw new Error(`relayer refuses the returned transaction: ${bad}`); tx = ret; }
    else tx.addSignature(w.key, Buffer.from(await signer.sign(tx.serializeMessage())));
    if (!o.selfPaid) tx.partialSign(payer);
    const raw = tx.serialize({ verifySignatures: false }); last = { sig: '', bytes: raw.length };
    d = await conn.sendRawTransaction(raw); await confirm(d); last.sig = d;
    const s = await conn.getSignatureStatus(d); if (s.value?.err) { ok = false; d = JSON.stringify(s.value.err); }
  } catch (e: any) { ok = false; d = short(e); if (e?.getLogs) try { const l = await e.getLogs(conn); if (Array.isArray(l) && l.length) d = short({ logs: l }); } catch {} }
  return record(name, expectOk, ok, d, o.want);
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
  if (/^K[234]\./.test(label)) await measure(`seat-propose-${label.slice(0, 2)}-${a.name}`);
  const ex = b ?? a;
  const exec = actions.settings
    ? ix.executeSettingsTransaction({ settingsPda: settings(), transactionIndex: index, signer: ex.key, rentPayer: payer.publicKey, policies: actions.policies ?? [] })
    : (await ix.executeTransaction({ connection: conn, settingsPda: settings(), transactionIndex: index, signer: ex.key })).instruction;
  const ixs = b ? [ix.approveProposal({ settingsPda: settings(), transactionIndex: index, signer: b.key }), exec] : [exec];
  await sendBy(`${label}b. ${b ? `${b.name} approves and executes` : `${a.name} executes with only its own approval`}`, expectOk, ex, ixs);
  if (expectOk && /^K[234]\./.test(label)) await measure(`seat-exec-${label.slice(0, 2)}-${ex.name}`);
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
const signGrant = (w: W, text: string) => (w.signText ?? w.sign)(new TextEncoder().encode(text));
const edIx = (signer: W, text: string, sig: Uint8Array) => Ed25519Program.createInstructionWithPublicKey({ publicKey: signer.key.toBytes(), message: Buffer.from(text), signature: sig });
async function openSession(w: W, o: { seconds?: number; signAs?: W; text?: (t: string) => string; fund?: number; key?: Keypair } = {}): Promise<Session> {
  const key = o.key ?? Keypair.generate(); const until = Math.floor(Date.now() / 1000) + (o.seconds ?? 3600); const pda = pdaFor(w);
  const text = (o.text ?? ((t) => t))(grantText(pda, key.publicKey, until));
  const signer = o.signAs ?? own(w);
  const sig = await signGrant(signer, text);
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
async function revokeIxs(w: W, key: PublicKey, o: { signAs?: W; owner?: PublicKey; acct?: PublicKey; pda?: PublicKey; marker?: PublicKey; prog?: PublicKey; data?: number; sigIx?: number; payerKey?: PublicKey } = {}): Promise<TransactionInstruction[]> {
  const owner = o.owner ?? own(w).key, acct = o.acct ?? settings(), prog = o.prog ?? PROG, pda = o.pda ?? pdaOf(owner, acct, prog);
  const text = grantText(pda, key, 0), signer = o.signAs ?? own(w);
  const sig = await signGrant(signer, text);
  const head = Buffer.concat([owner.toBuffer(), acct.toBuffer(), Buffer.from(new BigInt64Array([0n]).buffer), Buffer.from([o.sigIx ?? 0, bumpOf(owner, acct, prog)])]);
  const keys = [{ pubkey: SYSVAR_INSTRUCTIONS_PUBKEY, isSigner: false, isWritable: false }, { pubkey: key, isSigner: false, isWritable: false },
    { pubkey: pda, isSigner: false, isWritable: false }, { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    { pubkey: o.marker ?? markerOf(owner, acct, key, prog), isSigner: false, isWritable: true }, { pubkey: o.payerKey ?? payer.publicKey, isSigner: true, isWritable: true }];
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
// ── O. Any number of owners and any threshold: PRIME_OWNERS (default 3) and PRIME_THRESHOLD (default 2) ───────────────
// The default 3 and 2 run the matrix below. Any other pair runs this block instead: the first three owners are the real
// wallets (Phantom's own key, then MetaMask and Freighter through NEAR), further owners are plain local keys; each owner has
// its own session PDA. The block exits when it is done.
const N_OWN = Number(process.env.PRIME_OWNERS ?? 3), THR = Number(process.env.PRIME_THRESHOLD ?? 2);
if (!Number.isInteger(N_OWN) || !Number.isInteger(THR) || N_OWN < 1 || THR < 1 || THR > N_OWN) throw new Error(`PRIME_OWNERS=${N_OWN} PRIME_THRESHOLD=${THR}: need integers with 1 <= threshold <= owners`);
if (N_OWN !== 3 || THR !== 2) {
  if (NATIVE) throw new Error('PRIME_OWNERS / PRIME_THRESHOLD do not combine with PSN_NATIVE');
  const plain = (n: number): W => { const kp = Keypair.generate(); return { name: `Owner${n}`, key: kp.publicKey, sign: async (m) => nacl.sign.detached(m, kp.secretKey) }; };
  const roster: W[] = [PH, MM, FR].slice(0, N_OWN).concat(Array.from({ length: Math.max(0, N_OWN - 3) }, (_, i) => plain(i + 4)));
  const TAG = `${THR}-of-${N_OWN}`;
  const settingsTx = (index: bigint, a: W, actions: any[]) => ix.createSettingsTransaction({ settingsPda: settings(), transactionIndex: index, creator: a.key, rentPayer: payer.publicKey, actions });
  /** A proposal made by the first voter (or the first owner when nobody votes), approved by every voter in `voters`; not executed. */
  async function open(label: string, voters: W[], actions: { vault?: TransactionInstruction[]; settings?: any[] }): Promise<bigint> {
    const index = await nextIndex(), a = voters[0] ?? roster[0]!;
    const create = actions.settings ? settingsTx(index, a, actions.settings)
      : ix.createTransaction({ settingsPda: settings(), transactionIndex: index, creator: a.key, rentPayer: payer.publicKey, accountIndex: 0, ephemeralSigners: 0, addressLookupTableAccounts: [],
          transactionMessage: new TransactionMessage({ payerKey: vault(), recentBlockhash: (await conn.getLatestBlockhash()).blockhash, instructions: actions.vault! }) });
    await sendBy(`${label}.a ${a.name} proposes${voters.length ? ' and approves' : ' (no approval)'}`, true, a, [create, ix.createProposal({ settingsPda: settings(), transactionIndex: index, creator: a.key, rentPayer: payer.publicKey }),
      ...(voters.length ? [ix.approveProposal({ settingsPda: settings(), transactionIndex: index, signer: a.key })] : [])]);
    for (const v of voters.slice(1)) await sendBy(`${label}.${v.name} approves`, true, v, [ix.approveProposal({ settingsPda: settings(), transactionIndex: index, signer: v.key })]);
    return index;
  }
  /** `ex` executes proposal `index` (approving it in the same transaction when `approve`). */
  async function finish(label: string, index: bigint, ex: W, actions: { vault?: TransactionInstruction[]; settings?: any[]; policies?: PublicKey[] }, expectOk: boolean, approve: boolean) {
    const exec = actions.settings ? ix.executeSettingsTransaction({ settingsPda: settings(), transactionIndex: index, signer: ex.key, rentPayer: payer.publicKey, policies: actions.policies ?? [] })
      : (await ix.executeTransaction({ connection: conn, settingsPda: settings(), transactionIndex: index, signer: ex.key })).instruction;
    return sendBy(`${label}.x ${ex.name} ${approve ? 'approves and executes' : 'executes'}`, expectOk, ex, approve ? [ix.approveProposal({ settingsPda: settings(), transactionIndex: index, signer: ex.key }), exec] : [exec]);
  }
  /** `voters` all vote; the last one executes. */
  async function decideN(label: string, voters: W[], actions: { vault?: TransactionInstruction[]; settings?: any[]; policies?: PublicKey[] }, expectOk: boolean) {
    const many = voters.length >= 2, index = await open(label, many ? voters.slice(0, -1) : voters, actions);
    await finish(label, index, many ? voters[voters.length - 1]! : voters[0] ?? roster[0]!, actions, expectOk, many);
    return index;
  }
  const names = (os: W[]) => os.map((o) => o.name).join(' + ');
  console.log(`${TAG}:`, roster.map((o) => `${o.name} seat ${o.key.toBase58().slice(0, 6)} owner ${own(o).key.toBase58().slice(0, 6)}`).join('; '), 'program', PROG.toBase58());

  // setup
  const pc = await sa.accounts.ProgramConfig.fromAccountAddress(conn, sa.getProgramConfigPda({})[0]);
  const [settingsPda] = sa.getSettingsPda({ accountIndex: BigInt(pc.smartAccountIndex.toString()) + 1n });
  const before = await conn.getBalance(payer.publicKey);
  const csig = await conn.sendTransaction(new Transaction().add(ix.createSmartAccount({ treasury: pc.treasury, creator: payer.publicKey, settings: settingsPda, settingsAuthority: null, threshold: THR, timeLock: 0, rentCollector: null,
    signers: roster.map((w) => ({ key: w.key, permissions: ALL })) }), SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: sa.getSmartAccountPda({ settingsPda, accountIndex: 0 })[0], lamports: VAULT_SOL * SOL })), [payer]);
  await confirm(csig); st.settings = settingsPda.toBase58(); save();
  { const info = (await conn.getAccountInfo(settingsPda))!, tx = await conn.getTransaction(csig, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 });
    metrics.createAccount = { owners: N_OWN, settingsBytes: info.data.length, settingsRentLamports: info.lamports, relayerSpentLamports: before - (await conn.getBalance(payer.publicKey)) - VAULT_SOL * SOL, fee: tx?.meta?.fee}; save(); }
  { const s = await sa.accounts.Settings.fromAccountAddress(conn, settings());
    record(`O0. seats are exactly the ${N_OWN} owner keys, threshold ${THR}`, true, s.signers.map((x: any) => x.key.toBase58()).sort().join() === roster.map((w) => w.key.toBase58()).sort().join() && s.threshold === THR, csig);
    record(`O0b. the ${N_OWN} session owners and ${N_OWN} session PDAs are all different, and no session PDA is a seat`, true, new Set(roster.map((w) => pdaFor(w).toBase58())).size === N_OWN
      && roster.every((w) => !s.signers.some((x: any) => x.key.equals(pdaFor(w)))) && new Set(roster.map((w) => own(w).key.toBase58())).size === N_OWN, roster.map((w) => pdaFor(w).toBase58().slice(0, 6)).join(',')); }

  // seats: threshold - 1 approvals cannot execute, the threshold-th approval can, any threshold-sized subset works
  {
    const first = roster.slice(0, THR), last = roster.slice(N_OWN - THR), b = await conn.getBalance(DEST), outsider = OUT;
    const idx = await open('K1', first.slice(0, THR - 1), { vault: [sysTransfer(DEST, 0.01)] });
    await finish('K1', idx, roster[Math.max(0, THR - 2)]!, { vault: [] }, false, false);
    await sendBy('K1c. an outsider approves it', false, outsider, [ix.approveProposal({ settingsPda: settings(), transactionIndex: idx, signer: outsider.key })]);
    if (THR >= 2) await sendBy(`K1d. ${roster[0]!.name} approves it a second time`, false, roster[0]!, [ix.approveProposal({ settingsPda: settings(), transactionIndex: idx, signer: roster[0]!.key })]);
    await finish('K2', idx, roster[THR - 1]!, { vault: [] }, true, true);
    if (!(first.length === last.length && first.every((w, i) => w === last[i]))) await decideN(`K3. a different ${THR} owners (${names(last)}):`, last, { vault: [sysTransfer(DEST, 0.01)] }, true);
    const n = first.every((w, i) => w === last[i]) ? 1 : 2;
    record(`K4. DEST received exactly ${n * 0.01} SOL (the accepted transactions only)`, true, (await conn.getBalance(DEST)) - b === n * 0.01 * SOL, `${((await conn.getBalance(DEST)) - b) / SOL}`);
  }
  const seed = Number((await sa.accounts.Settings.fromAccountAddress(conn, settings())).policySeed ?? 0) + 1;
  const policy = sa.getPolicyPda({ settingsPda: settings(), policySeed: seed })[0];
  st.policy = policy.toBase58(); st.policySeed = seed; save();
  await decideN(`K5. ${THR} owners install the movers policy (members: the ${N_OWN} session PDAs, ${names(roster.slice(0, THR))}):`, roster.slice(0, THR), { settings: [{ __kind: 'PolicyCreate', seed, policyCreationPayload: policyPayload(),
    signers: roster.map((w) => ({ key: pdaFor(w), permissions: ALL })), threshold: 1, timeLock: 0, startTimestamp: null, expirationArgs: null }], policies: [policy] }, true);
  { const pi = (await conn.getAccountInfo(policy))!; metrics.policy = { owners: N_OWN, bytes: pi.data.length, rentLamports: pi.lamports }; save(); }

  // an open proposal that the sessions try to vote on
  const idxOpen = await open('N0', roster.slice(0, THR - 1), { vault: [sysTransfer(DEST, 0.01)] });
  const live: Session[] = [];
  for (const [i, w] of roster.entries()) {
    const p = `P${i}-${w.name}`, others = roster.filter((x) => x !== w);
    const s = await openSession(w); live.push(s);
    const b = await conn.getBalance(VENUE);
    await send(`${p}.1 one ${w.name} signature -> session; relayer pays: 0.002 SOL to VENUE`, true, viaSession(s, policyMove(s.pda, sysTransfer(VENUE, 0.002))), relayed(s));
    await measure(`move-${w.name}-relayed`);
    await send(`${p}.2 relayer down: the session key pays the fee itself: 0.001 SOL to VENUE`, true, viaSession(s, policyMove(s.pda, sysTransfer(VENUE, 0.001))), selfPaid(s));
    record(`${p}.3 VENUE received exactly 0.003 SOL`, true, (await conn.getBalance(VENUE)) - b === 0.003 * SOL, `${((await conn.getBalance(VENUE)) - b) / SOL}`);
    await send(`${p}.4 0.002 SOL elsewhere (policy)`, false, viaSession(s, policyMove(s.pda, sysTransfer(OTHER, 0.002))), relayed(s));
    await send(`${p}.5 the session approves an open seat proposal as its PDA`, false, viaSession(s, ix.approveProposal({ settingsPda: settings(), transactionIndex: idxOpen, signer: s.pda })), relayed(s));
    await send(`${p}.6 the session key approves it as itself`, false, [ix.approveProposal({ settingsPda: settings(), transactionIndex: idxOpen, signer: s.key.publicKey })], relayed(s));
    await send(`${p}.7 the session adds its key as a seat (settings sync, its PDA as the only signer${THR >= 2 ? '; it is short of the threshold, so .5 is the check that names the PDA' : ''})`, false, viaSession(s, ix.executeSettingsTransactionSync({ settingsPda: settings(), feePayer: s.key.publicKey, signers: [s.pda],
      actions: [{ __kind: 'AddSigner', newSigner: { key: s.key.publicKey, permissions: ALL } }] as any })), relayed(s));
    const r = await openSession(w);
    await send(`${p}.8 a second session works`, true, viaSession(r, policyMove(r.pda, sysTransfer(VENUE, 0.001))), relayed(r));
    await send(`${p}.9 ${w.name} revokes it (one signature, relayed)`, true, await revokeIxs(w, r.key.publicKey), [payer]);
    await send(`${p}.10 the revoked session`, false, viaSession(r, policyMove(r.pda, sysTransfer(VENUE, 0.001))), relayed(r), E2);
    await send(`${p}.11 the first session still works`, true, viaSession(s, policyMove(s.pda, sysTransfer(VENUE, 0.001))), relayed(s));
    if (others.length) { const x = others[i % others.length]!, bad = await openSession(w, { signAs: own(x) });
      await send(`${p}.12 a grant for ${w.name}'s PDA signed by ${x.name}'s owner key`, false, viaSession(bad, policyMove(bad.pda, sysTransfer(VENUE, 0.001))), relayed(bad), E7); }
  }

  // removal: the owners drop one owner's PDA from the policy, then the owner itself from the account
  {
    const k = roster[N_OWN - 1]!, rest = roster.filter((x) => x !== k), voters = rest.length >= THR ? rest.slice(0, THR) : roster.slice(0, THR), ks = live[N_OWN - 1]!, other = roster.find((x) => x !== k);
    await send(`R0. ${k.name}'s live session works before removal`, true, viaSession(ks, policyMove(ks.pda, sysTransfer(VENUE, 0.001))), relayed(ks));
    const P = new PublicKey(st.policy), upd = { settings: [{ __kind: 'PolicyUpdate', policy: P, policyUpdatePayload: policyPayload(), signers: rest.map((w) => ({ key: pdaFor(w), permissions: ALL })), threshold: 1, timeLock: 0, expirationArgs: null }], policies: [P] };
    const removable = rest.length > 0;   // a policy needs at least one member: with one owner its PDA cannot be removed
    await decideN(`R1. ${THR - 1} owners try to remove ${k.name}'s PDA from the policy:`, voters.slice(0, THR - 1), upd, false);
    await decideN(`R2. ${THR} owners remove ${k.name}'s PDA from the policy (${names(voters)})${removable ? '' : ': refused, the policy would have no member'}:`, voters, upd, removable);
    await send(`R3. ${k.name}'s live session after removal${removable ? '' : ' (nothing was removed)'}`, !removable, viaSession(ks, policyMove(ks.pda, sysTransfer(VENUE, 0.001))), relayed(ks));
    const again = await openSession(k);
    await send(`R4. ${k.name} signs a new grant: the session is ${removable ? 'still refused' : 'the same as before'}`, !removable, viaSession(again, policyMove(again.pda, sysTransfer(VENUE, 0.001))), relayed(again));
    if (other) { const os = live[roster.indexOf(other)]!; await send(`R5. ${other.name}'s session still works`, true, viaSession(os, policyMove(os.pda, sysTransfer(VENUE, 0.001))), relayed(os)); }
    const newThr = Math.min(THR, N_OWN - 1), rm = { settings: [{ __kind: 'RemoveSigner', oldSigner: k.key }, ...(newThr !== THR ? [{ __kind: 'ChangeThreshold', newThreshold: newThr }] : [])] };
    if (N_OWN >= 2) {
      await decideN(`R6. ${THR} owners remove ${k.name} from the seats (threshold ${newThr}):`, voters, rm, true);
      const s = await sa.accounts.Settings.fromAccountAddress(conn, settings());
      record(`R7. the account now has ${N_OWN - 1} seats without ${k.name}, threshold ${newThr}`, true, s.signers.length === N_OWN - 1 && !s.signers.some((x: any) => x.key.equals(k.key)) && s.threshold === newThr, `${s.signers.length} / ${s.threshold}`);
      const idx = await open('R8', rest.slice(0, newThr - 1), { vault: [sysTransfer(DEST, 0.01)] });
      await sendBy(`R8c. ${k.name} approves a proposal after removal`, false, k, [ix.approveProposal({ settingsPda: settings(), transactionIndex: idx, signer: k.key })]);
      await finish('R9', idx, rest[newThr - 1]!, { vault: [] }, true, true);
    } else {
      await decideN('R6. the sole owner removes itself from a 1-owner account:', [k], rm, false);
    }
  }
  metrics.relayerSpend = { net: NET, spentLamports: startBalance - (await conn.getBalance(payer.publicKey)) }; save();
  console.log(`NEAR MPC signatures: ${stats.calls}, average ${(stats.ms / Math.max(1, stats.calls) / 1000).toFixed(1)}s`);
  st.mpc = stats; save();
  console.log(`${TAG}: ${results.filter((r) => r.pass).length}/${results.length} passed`);
  for (const r of results.filter((r) => !r.pass)) console.log('FAIL', r.name, r.detail);
  process.exit(0);
}

{
  const { settingsPda, sig } = await createAccount();
  st.settings = settingsPda.toBase58(); save();
  const s = await sa.accounts.Settings.fromAccountAddress(conn, settings());
  record(`P0. seats are exactly MetaMask(${NATIVE ? 'own key' : 'NEAR MPC'}), Freighter(NEAR MPC), Phantom(own key); threshold 2; vault funded`, true,
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
  await sendBy(`K6d. Freighter's seat signed by MetaMask's ${NATIVE ? 'own' : 'MPC'} key`, false, FR, [ix.approveProposal({ settingsPda: settings(), transactionIndex: idx, signer: FR.key })], MM);
  await sendBy("K6e. Freighter's seat signed by its MPC key under another path", false, FR, [ix.approveProposal({ settingsPda: settings(), transactionIndex: idx, signer: FR.key })], FR_OTHER_PATH);
  // A grant signature can never count as a seat vote: the session-owner keys are not settings signers and sign under their own path.
  for (const [w, so] of ([[MM, SMM], [FR, SFR]] as [W, W][]).filter(([w]) => !(NATIVE && w === MM))) {
    await sendBy(`K6f-${w.name}. ${w.name}'s seat vote signed by its session-path key`, false, w, [ix.approveProposal({ settingsPda: settings(), transactionIndex: idx, signer: w.key })], so);
    await sendBy(`K6g-${w.name}. ${w.name}'s session-path key approves as itself`, false, so, [ix.approveProposal({ settingsPda: settings(), transactionIndex: idx, signer: so.key })]);
  }
  if (NATIVE) {
    // MetaMask has one key for both jobs. A grant signature is no vote, and a signMessage signature is never a transaction signature.
    // Both are tried on a proposal MetaMask has not voted on, and a control vote on the same proposal passes, so a refusal here comes from the signature.
    const idx2 = await decide('NS0. Freighter alone (open proposal MetaMask has not voted on):', FR, null, { vault: [sysTransfer(DEST, 0.01)] }, false);
    const vote = () => [ix.approveProposal({ settingsPda: settings(), transactionIndex: idx2, signer: MM.key })];
    const gtext = grantText(pdaFor(MM), Keypair.generate().publicKey, Math.floor(Date.now() / 1000) + 3600);
    const gsig = await MM.signText!(new TextEncoder().encode(gtext));
    const SIGFAIL = /signature verification/i;
    await sendBy("NS1. MetaMask's grant signature filed as its vote on that proposal", false, MM, vote(), { name: 'grant signature', key: MM.key, sign: async () => gsig }, { want: SIGFAIL });
    let sent = new Uint8Array(), viaMessage = new Uint8Array();
    await sendBy("NS2. the vote's exact transaction message sent through signMessage, that signature filed as the vote", false, MM, vote(), { name: 'signMessage', key: MM.key, sign: async (m) => { sent = m; return (viaMessage = await MM.signText!(m)); } }, { want: SIGFAIL });
    await sendBy('NS2c. control: the same vote signed through signTransaction passes', true, MM, vote());
    let utf8 = true; try { new TextDecoder('utf-8', { fatal: true }).decode(sent); } catch { utf8 = false; }
    record('NS3. the bytes MetaMask signs for that message differ from it (invalid UTF-8 or NUL bytes change them), so its signMessage signature cannot verify as the transaction signature',
      true, !nacl.sign.detached.verify(sent, viaMessage, MM.key.toBytes()) && (!utf8 || sent.includes(0)) && Buffer.compare(Buffer.from(mmSignedBytes(sent)), Buffer.from(sent)) !== 0, `message ${sent.length} bytes, signed form ${mmSignedBytes(sent).length}`);
    record('NS3b. every Squads vote message holds a byte that never occurs in valid UTF-8 (the program id), so no vote message survives signMessage unchanged', true,
      sa.PROGRAM_ID.toBytes().some((x) => x === 0xc0 || x === 0xc1 || x >= 0xf5), `program id ${sa.PROGRAM_ID.toBase58().slice(0, 8)}…`);
    record('NS4. a grant text is not a Solana transaction message', true, (() => { try { Transaction.populate(Message.from(Buffer.from(gtext))); return false; } catch { return true; } })(), 'parse refused');
    // The relayer checks what the wallet returns before it co-signs.
    {
      curCheck = 'RV (probe transaction, not sent)';
      const built = new Transaction().add(...await MM.prepare!(vote(), payer.publicKey)); built.feePayer = payer.publicKey; built.recentBlockhash = (await conn.getLatestBlockhash('confirmed')).blockhash;
      const ret = await MM.signTx!(built);
      const clone = (t: Transaction, f: (x: Transaction) => void) => { const c = new Transaction({ feePayer: t.feePayer, recentBlockhash: t.recentBlockhash }); c.instructions = [...t.instructions]; c.signatures = t.signatures.map((x) => ({ ...x })); f(c); return c; };
      const resign = (t: Transaction) => { const sig = nacl.sign.detached(t.serializeMessage(), mmKp!.secretKey); const i = t.signatures.findIndex((x) => x.publicKey.equals(MM.key)); t.signatures[i]!.signature = Buffer.from(sig); return t; };
      const refuse = (n: string, label: string, t: Transaction) => { const bad = acceptReturned(built, t, MM.key); record(`RV${n}. relayer ${label}`, false, bad === null, bad ?? 'accepted'); };
      record('RV0. relayer accepts the wallet\'s transaction when the wallet returns the message it was given', true, Buffer.compare(ret.serializeMessage(), built.serializeMessage()) === 0 && acceptReturned(built, ret, MM.key) === null, 'unchanged');
      const lowPrice = resign(clone(ret, (c) => { c.instructions = c.instructions.map((i) => (isBudget(i, 3) ? ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 5_000 }) : i)); }));
      record('RV0b. ...and when only the compute-budget values differ', true, acceptReturned(built, lowPrice, MM.key) === null, 'price 5,000');
      refuse('1', 'refuses a transfer from the fee payer added to the returned message', resign(clone(ret, (c) => { c.instructions = [...c.instructions, SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: OTHER, lamports: 1_000_000 })]; })));
      refuse('2', 'refuses changed instruction data', resign(clone(ret, (c) => { c.instructions = c.instructions.map((i) => (i.programId.equals(CB) ? i : new TransactionInstruction({ programId: i.programId, keys: i.keys, data: Buffer.concat([i.data, Buffer.from([1])]) }))); })));
      refuse('3', 'refuses a priority fee above the cap', resign(clone(ret, (c) => { c.instructions = c.instructions.map((i) => (isBudget(i, 3) ? ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 10_000_000 }) : i)); })));
      refuse('4', 'refuses a changed blockhash', resign(clone(ret, (c) => { c.recentBlockhash = Keypair.generate().publicKey.toBase58(); })));
      refuse('5', 'refuses a second compute-unit limit', resign(clone(ret, (c) => { c.instructions = [...c.instructions, ComputeBudgetProgram.setComputeUnitLimit({ units: 1 })]; })));
      refuse('6', 'refuses another compute-budget instruction (heap frame)', resign(clone(ret, (c) => { c.instructions = [...c.instructions, ComputeBudgetProgram.requestHeapFrame({ bytes: 65536 })]; })));
      refuse('7', 'refuses a returned message the wallet did not sign', clone(ret, (c) => { c.signatures = c.signatures.map((x) => (x.publicKey.equals(MM.key) ? { ...x, signature: Buffer.alloc(64, 1) } : x)); }));
    }
    // MetaMask submits a revoke itself (fee payer and rent payer), as it would with the relayer down. prime-session finds the ed25519 instruction at sig_ix, so the
    // transaction is built with the budget instructions in front (ed25519 at index 1); a transaction without them gets rewritten by the snap and sig_ix 0 then points at the price.
    await fund(MM.key, 0.05 * SOL);
    await sendBy('NS5. MetaMask revokes a session itself as fee payer, budget instructions in place, sig_ix 1', true, MM, await revokeIxs(MM, Keypair.generate().publicKey, { sigIx: 1, payerKey: MM.key }), undefined, { selfPaid: true });
    await sendBy('NS6. the same revoke built without budget instructions: the wallet adds a price in front and sig_ix 0 points at it', false, MM, await revokeIxs(MM, Keypair.generate().publicKey, { payerKey: MM.key }), undefined, { selfPaid: true, noPrepare: true, want: E7 });
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
  await send(`G-${w.name}1. one ${w.name} signature${w === PH || (NATIVE && w === MM) ? '' : ' (through NEAR)'} -> session; relayer pays: 0.01 SOL to VENUE`, true, viaSession(s, policyMove(s.pda, sysTransfer(VENUE, 0.01))), relayed(s));
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
  await send(`X1. Freighter's PDA with a grant signed by MetaMask (${NATIVE ? 'own key' : 'NEAR'})`, false, viaSession(a, policyMove(a.pda, sysTransfer(VENUE, 0.001))), relayed(a), E7);
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
if (NATIVE) { console.log(`MetaMask own-account: ${nat.msgCalls} signMessage (${MM_BRIDGE ? 'real extension' : 'local stand-in'}, average ${(nat.msgMs / Math.max(1, nat.msgCalls) / 1000).toFixed(2)}s), ${nat.txCalls} transaction signatures (stand-in with the wallet's rewrite), ${nat.wouldRefuse} of them for transactions whose simulation reverts (the real wallet would refuse): ${nat.wouldRefuseChecks.join(', ')}`); metrics.nativeMetaMask = { ...nat, realExtension: !!MM_BRIDGE, address: MM.key.toBase58() }; }
st.mpc = stats; save();
console.log(`${results.filter((r) => r.pass).length}/${results.length} passed`);
for (const r of results.filter((r) => !r.pass)) console.log('FAIL', r.name, r.detail);
process.exit(0);
