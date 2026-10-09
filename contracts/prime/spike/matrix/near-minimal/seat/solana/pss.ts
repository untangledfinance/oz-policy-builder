// Seat-voting sessions on Solana: a Squads Smart Account (cloned from devnet) on a local validator.
//   seats: the three settings signers are the prime-seat PDAs ["prime", owner, settings], threshold 2. The same PDA is also the wallet's policy signer.
//   owners: Phantom (its own key), MetaMask and Freighter (NEAR MPC ed25519 keys under `prime:solana-session`, signing Solana transactions themselves).
//   an owner votes by signing the transaction that carries the prime-seat instruction; a session key votes when the owner's grant carries the vote flag.
//   A move-only grant (the default) can run a policy move and nothing else.
// PSS_VARIANT=ng loads the no-governance build (a vote session may approve vault and policy proposals, never settings changes).
import { ComputeBudgetProgram, Connection, Ed25519Program, Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram, SYSVAR_INSTRUCTIONS_PUBKEY, Transaction,
  TransactionInstruction, TransactionMessage } from '@solana/web3.js';
import * as sa from '@sqds/smart-account';
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { payer } from '/home/ubuntu/work/swig-spike/keys.ts';
const { edKey, edSign, stats } = await import(process.env.NEARSIG_STUB ?? '/home/ubuntu/work/near-session-spike/nearsig.ts');

const VARIANT = process.env.PSS_VARIANT === 'ng' ? 'ng' : 'full';
const RPC = process.env.PSS_RPC ?? 'http://127.0.0.1:8949';
const conn = new Connection(RPC, { commitment: 'confirmed', confirmTransactionInitialTimeout: 120_000 });
const kp = (f: string) => Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(`/home/ubuntu/work/seat-spike/solana/secrets/${f}`, 'utf8'))));
const PROG = kp('prime-seat-keypair.json').publicKey, PROG_B = kp('prime-seat-b.json').publicKey;
// PSS_BASE=1: the production prime-session .so is loaded at this id so move compute units compare in one account.
const BASE = process.env.PSS_BASE ? new PublicKey('FTNMFWiECbRp7D5MwJUiNQfee6NuJPjE7S11J9yc2B9G') : undefined;
const SA_ID = new PublicKey('SMRTzfY6DfH5ik3TKiyLFfXexV8uSG3d2UksSCYdunG');
const CLUSTER = 'localnet';
const SOL = LAMPORTS_PER_SOL, SESSION_FUND = 0.05 * SOL, VAULT_SOL = 2;
const st: any = {}; const results: any[] = []; const metrics: any = {};
const STATE = process.env.PSS_STATE ?? `/home/ubuntu/work/prime-refine/logs/seat/solana/state-pss-${VARIANT}.json`;
const save = () => writeFileSync(STATE, JSON.stringify({ ...st, metrics, results }, null, 1));
const VENUE = Keypair.generate().publicKey, OTHER = Keypair.generate().publicKey, DEST = Keypair.generate().publicKey;
const short = (e: any) => { const s = [e?.logs?.join(' '), e?.message, String(e)].filter(Boolean).join(' | ');
  return ((s.match(/Error Code: \w+/) ?? s.match(/(custom program error: 0x[0-9a-f]+|missing required signature[a-z ]{0,25}|Transaction signature verification failure|Signature verification failed|Transaction did not pass signature verification|Transaction results in an account \(\d+\) with insufficient funds for rent|InsufficientFundsForRent|Attempt to debit an account but found no record of a prior credit|insufficient [a-z ]+|[A-Za-z]+Error[^"]{0,60})/i))?.[0] ?? s).slice(0, 160); };
async function confirm(sig: string) {
  for (let i = 0; i < 180; i++) {
    const s = (await conn.getSignatureStatus(sig, { searchTransactionHistory: true })).value;
    if (s?.err) throw Object.assign(new Error(JSON.stringify(s.err)), { signature: sig });
    if (s?.confirmationStatus === 'confirmed' || s?.confirmationStatus === 'finalized') return sig;
    await new Promise((r) => setTimeout(r, 400));
  }
  throw new Error(`${sig} not confirmed after 72 s (status lookup)`);
}
/** Compute units of the last transaction sent: the whole transaction, prime-seat's total (nested call included), the Smart Account's part, and the program's own share. */
async function measure(label: string, program = PROG) {
  const t = await conn.getTransaction(last.sig, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 });
  const done: { prog: string; depth: number; cu: number }[] = [], stack: { prog: string; depth: number; cu: number }[] = [];
  for (const l of t?.meta?.logMessages ?? []) {
    let m: RegExpMatchArray | null;
    if ((m = l.match(/^Program (\w+) invoke \[(\d+)\]/))) stack.push({ prog: m[1]!, depth: Number(m[2]), cu: 0 });
    else if ((m = l.match(/^Program (\w+) consumed (\d+) of/))) stack[stack.length - 1]!.cu = Number(m[2]);
    else if (/^Program \w+ (success|failed)/.test(l)) done.push(stack.pop()!);
  }
  const mine = done.filter((d) => d.prog === program.toBase58() && d.depth === 1), sq = done.filter((d) => d.prog === SA_ID.toBase58() && d.depth === 2);
  metrics[label] = { totalCu: t?.meta?.computeUnitsConsumed, programCu: mine[0]?.cu, smartAccountCu: sq[0]?.cu, programOwnCu: mine[0] && sq[0] ? mine[0].cu - sq[0].cu : undefined, bytes: last.bytes, fee: t?.meta?.fee };
  console.log(`METRIC ${label} ${JSON.stringify(metrics[label])}`); save();
}
async function fund(to: PublicKey, lamports: number) { await confirm(await conn.requestAirdrop(to, lamports)); }
function record(name: string, expectOk: boolean, ok: boolean, detail: string, want?: RegExp) {
  const pass = ok === expectOk && (ok || !want || want.test(detail)); results.push({ name, pass, ok, detail }); save();
  console.log(`${pass ? 'PASS' : 'FAIL'} ${name} | ${ok ? `ok ${detail}` : `refused: ${detail}`}`);
  return ok;
}

// ── Wallets ────────────────────────────────────────────────────────────────────────────────────
// Owners: the key the PDA derives from. MetaMask and Freighter keep their prime:solana-session MPC keys; Phantom's own key is its owner key.
const SESSION_PATH = 'prime:solana-session', SEAT_PATH = 'prime:solana';
type W = { name: string; key: PublicKey; sign: (m: Uint8Array) => Promise<Uint8Array> };
const viaNear = async (name: 'MetaMask' | 'Freighter', path: string): Promise<W> => ({ name, key: new PublicKey(await edKey(name, path)), sign: (m) => edSign(name, path, m) });
const phSecret = bs58.decode(JSON.parse(readFileSync('/home/ubuntu/work/phantom-spike/secrets/phantom-test.json', 'utf8')).secret);
const phKp = nacl.sign.keyPair.fromSecretKey(phSecret.length === 64 ? phSecret : nacl.sign.keyPair.fromSeed(phSecret).secretKey);
const PH: W = { name: 'Phantom', key: new PublicKey(phKp.publicKey), sign: async (m) => nacl.sign.detached(m, phKp.secretKey) };
const MM = await viaNear('MetaMask', SESSION_PATH), FR = await viaNear('Freighter', SESSION_PATH);
const MM_OLD = await viaNear('MetaMask', SEAT_PATH), FR_OLD = await viaNear('Freighter', SEAT_PATH);   // the old seat keys: no longer settings signers
const FR_OTHER_PATH = await viaNear('Freighter', 'prime:solana-other');
const outsiderKp = Keypair.generate();
const OUT: W = { name: 'outsider', key: outsiderKp.publicKey, sign: async (m) => nacl.sign.detached(m, outsiderKp.secretKey) };
const OWNERS = [MM, FR, PH];
console.log({ MetaMask: MM.key.toBase58(), Freighter: FR.key.toBase58(), Phantom: PH.key.toBase58(), program: PROG.toBase58(), programB: PROG_B.toBase58(), variant: VARIANT });
st.program = PROG.toBase58(); st.programB = PROG_B.toBase58(); st.variant = VARIANT; st.owners = { MetaMask: MM.key.toBase58(), Freighter: FR.key.toBase58(), Phantom: PH.key.toBase58() };

// ── Sending ───────────────────────────────────────────────────────────────────────────────────
let last = { sig: '', bytes: 0 };
type S = W | Keypair;
/** One transaction. The fee payer is the relayer, or the first signer with selfPaid; wallets sign through `sign`, keypairs directly. A compute-unit limit goes last so instruction indexes stay put. */
async function submit(name: string, expectOk: boolean, ixs: TransactionInstruction[], signers: S[], o: { want?: RegExp; selfPaid?: boolean; cu?: number } = {}) {
  let ok = true, d = '';
  try {
    const tx = new Transaction().add(...ixs, ...(o.cu ? [ComputeBudgetProgram.setComputeUnitLimit({ units: o.cu })] : []));
    tx.feePayer = o.selfPaid ? ('publicKey' in signers[0]! ? signers[0].publicKey : signers[0]!.key) : payer.publicKey; tx.recentBlockhash = (await conn.getLatestBlockhash('confirmed')).blockhash;
    for (const s of signers) { if ('publicKey' in s) tx.partialSign(s); else tx.addSignature(s.key, Buffer.from(await s.sign(tx.serializeMessage()))); }
    if (!o.selfPaid) tx.partialSign(payer);
    const raw = tx.serialize({ verifySignatures: false }); last = { sig: '', bytes: raw.length };
    d = await conn.sendRawTransaction(raw); await confirm(d); last.sig = d;
    const s = await conn.getSignatureStatus(d); if (s.value?.err) { ok = false; d = JSON.stringify(s.value.err); }
  } catch (e: any) { ok = false; d = short(e); if (e?.getLogs) try { const l = await e.getLogs(conn); if (Array.isArray(l) && l.length) d = short({ logs: l }); } catch {} }
  return record(name, expectOk, ok, d, o.want);
}

// ── Smart Account helpers ──────────────────────────────────────────────────────────────────────
// `sel` switches every helper to another account: A (the main one), B (cross-account checks), C (the dangerous case), Q (the permission matrix).
let sel: 'A' | 'B' | 'C' | 'D' | 'E' | 'P' | 'Q' = 'A';
const acct: Record<string, { settings?: string; policy?: string }> = { A: {}, B: {}, C: {}, D: {}, E: {}, P: {}, Q: {} };
const settings = () => new PublicKey(acct[sel]!.settings!);
const policyAddr = () => new PublicKey(acct[sel]!.policy!);
const vault = () => sa.getSmartAccountPda({ settingsPda: settings(), accountIndex: 0 })[0];
const ix = sa.instructions;
const getSettings = () => sa.accounts.Settings.fromAccountAddress(conn, settings());
const nextIndex = async () => BigInt((await getSettings()).transactionIndex.toString()) + 1n;
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
async function createAccount(label: 'A' | 'B' | 'C' | 'D' | 'E' | 'P' | 'Q', members: (settingsPda: PublicKey) => { key: PublicKey; permissions: { mask: number } }[], threshold = 2) {
  const pc = await sa.accounts.ProgramConfig.fromAccountAddress(conn, sa.getProgramConfigPda({})[0]);
  const [settingsPda] = sa.getSettingsPda({ accountIndex: BigInt(pc.smartAccountIndex.toString()) + 1n });
  const tx = new Transaction().add(ix.createSmartAccount({ treasury: pc.treasury, creator: payer.publicKey, settings: settingsPda, settingsAuthority: null,
    threshold, timeLock: 0, rentCollector: null, signers: members(settingsPda) }),
    SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: sa.getSmartAccountPda({ settingsPda, accountIndex: 0 })[0], lamports: VAULT_SOL * SOL }));
  const sig = await conn.sendTransaction(tx, [payer]); await confirm(sig);
  acct[label]!.settings = settingsPda.toBase58(); st[`settings${label}`] = settingsPda.toBase58(); save();
  return { settingsPda, sig };
}

// ── prime-seat: the PDA, the grant, the instruction ───────────────────────────────────────────
const pdaOf = (owner: PublicKey, a = settings(), prog = PROG) => PublicKey.findProgramAddressSync([Buffer.from('prime'), owner.toBuffer(), a.toBuffer()], prog)[0];
const markerOf = (owner: PublicKey, a: PublicKey, key: PublicKey, prog = PROG) => PublicKey.findProgramAddressSync([owner.toBuffer(), a.toBuffer(), key.toBuffer()], prog)[0];
const bumpOf = (owner: PublicKey, a: PublicKey, prog = PROG) => PublicKey.findProgramAddressSync([Buffer.from('prime'), owner.toBuffer(), a.toBuffer()], prog)[1];
const grantText = (pda: PublicKey, key: PublicKey, until: number, vote: boolean, cluster = CLUSTER) =>
  `Prime session\nsigner: ${pda.toBase58()}\nsession key: ${key.toBase58()}\nvalid until (unix time): ${until}\ncluster: ${cluster}\nvote: ${vote}`;
const baseText = (pda: PublicKey, key: PublicKey, until: number) => `Prime session\nsigner: ${pda.toBase58()}\nsession key: ${key.toBase58()}\nvalid until (unix time): ${until}\ncluster: ${CLUSTER}`;
const edIx = (signer: W, text: string, sig: Uint8Array) => Ed25519Program.createInstructionWithPublicKey({ publicKey: signer.key.toBytes(), message: Buffer.from(text), signature: sig });
const signGrant = (w: W, text: string) => w.sign(new TextEncoder().encode(text));
type Session = { owner: PublicKey; acct: PublicKey; key: Keypair; until: number; pda: PublicKey; vote: boolean; sigIx: TransactionInstruction };
async function openSession(w: W, o: { seconds?: number; vote?: boolean; signAs?: W; text?: (t: string) => string; fund?: number; key?: Keypair } = {}): Promise<Session> {
  const key = o.key ?? Keypair.generate(), until = Math.floor(Date.now() / 1000) + (o.seconds ?? 3600), pda = pdaOf(w.key), vote = o.vote ?? false;
  const text = (o.text ?? ((t) => t))(grantText(pda, key.publicKey, until, vote));
  const signer = o.signAs ?? w, sig = await signGrant(signer, text);
  if (o.fund !== 0) await fund(key.publicKey, o.fund ?? SESSION_FUND);
  return { owner: w.key, acct: settings(), key, until, pda, vote, sigIx: edIx(signer, text, sig) };
}
type Over = { until?: number; owner?: PublicKey; pda?: PublicKey; acct?: PublicKey; bump?: number; marker?: PublicKey; prog?: PublicKey; vote?: boolean; sigIx?: number; signerKey?: PublicKey };
const head = (owner: PublicKey, a: PublicKey, until: number, sigIx: number, bump: number, vote: boolean) =>
  Buffer.concat([owner.toBuffer(), a.toBuffer(), Buffer.from(new BigInt64Array([BigInt(until)]).buffer), Buffer.from([sigIx, bump, vote ? 1 : 0])]);
const forwarded = (inner: TransactionInstruction, pda: PublicKey) => inner.keys.map((k) => ({ ...k, isSigner: k.pubkey.equals(pda) ? false : k.isSigner }));
/** The prime-seat instruction for a call the owner authorizes by signing the transaction (the time field is any non-zero value). */
function ownerIx(w: W, inner: TransactionInstruction, o: Over = {}): TransactionInstruction {
  const owner = o.owner ?? w.key, a = o.acct ?? settings(), prog = o.prog ?? PROG, pda = o.pda ?? pdaOf(owner, a, prog), sk = o.signerKey ?? w.key;
  const keys = [{ pubkey: SYSVAR_INSTRUCTIONS_PUBKEY, isSigner: false, isWritable: false }, { pubkey: sk, isSigner: true, isWritable: false },
    { pubkey: pda, isSigner: false, isWritable: false }, { pubkey: inner.programId, isSigner: false, isWritable: false },
    { pubkey: o.marker ?? markerOf(owner, a, sk, prog), isSigner: false, isWritable: false }, ...forwarded(inner, pda)];
  return new TransactionInstruction({ programId: prog, keys, data: Buffer.concat([head(owner, a, o.until ?? 1, o.sigIx ?? 0, o.bump ?? bumpOf(owner, a, prog), o.vote ?? false), inner.data]) });
}
/** The prime-seat instruction for a call a session key makes; the ed25519 instruction that checks the grant goes first in the transaction (index 0). */
function sessionIx(s: Session, inner: TransactionInstruction, o: Over = {}): TransactionInstruction {
  const owner = o.owner ?? s.owner, pda = o.pda ?? s.pda, a = o.acct ?? s.acct, prog = o.prog ?? PROG;
  const keys = [{ pubkey: SYSVAR_INSTRUCTIONS_PUBKEY, isSigner: false, isWritable: false }, { pubkey: s.key.publicKey, isSigner: true, isWritable: true },
    { pubkey: pda, isSigner: false, isWritable: false }, { pubkey: inner.programId, isSigner: false, isWritable: false },
    { pubkey: o.marker ?? markerOf(owner, a, s.key.publicKey, prog), isSigner: false, isWritable: false }, ...forwarded(inner, pda)];
  return new TransactionInstruction({ programId: prog, keys, data: Buffer.concat([head(owner, a, o.until ?? s.until, o.sigIx ?? 0, o.bump ?? bumpOf(owner, a, prog), o.vote ?? s.vote), inner.data]) });
}
/** A revoke: `signAs` (default the owner) signs the grant text with time 0 for `key`; the relayer pays and funds the marker. One owner signature. */
async function revokeIxs(w: W, key: PublicKey, o: { signAs?: W; owner?: PublicKey; acct?: PublicKey; pda?: PublicKey; marker?: PublicKey; prog?: PublicKey; data?: number } = {}): Promise<TransactionInstruction[]> {
  const owner = o.owner ?? w.key, a = o.acct ?? settings(), prog = o.prog ?? PROG, pda = o.pda ?? pdaOf(owner, a, prog);
  const text = grantText(pda, key, 0, false), signer = o.signAs ?? w, sig = await signGrant(signer, text);
  const h = head(owner, a, 0, 0, bumpOf(owner, a, prog), false);
  const keys = [{ pubkey: SYSVAR_INSTRUCTIONS_PUBKEY, isSigner: false, isWritable: false }, { pubkey: key, isSigner: false, isWritable: false },
    { pubkey: pda, isSigner: false, isWritable: false }, { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    { pubkey: o.marker ?? markerOf(owner, a, key, prog), isSigner: false, isWritable: true }, { pubkey: payer.publicKey, isSigner: true, isWritable: true }];
  return [edIx(signer, text, sig), new TransactionInstruction({ programId: prog, keys, data: o.data !== undefined ? h.subarray(0, o.data) : h })];
}
const E2 = /0x2\b/, E4 = /0x4\b/, E7 = /0x7\b/, E8 = /0x8\b/;   // refusals: revoked or address not derived, expired or too long, not signed by the owner over this text, move-only grant used for a vote
const NAS = /NotASigner/, UNAUTH = /Unauthorized/, ALREADY = /AlreadyApproved/, BADSTATUS = /InvalidProposalStatus/;

// A voter: an owner signing the transaction, or a session key holding a grant. `act` wraps Smart Account instructions for it and sends one transaction.
type V = { owner: W } | { session: Session };
const asOwner = (w: W): V => ({ owner: w }), asSession = (s: Session): V => ({ session: s });
const pdaV = (v: V) => ('owner' in v ? pdaOf(v.owner.key) : v.session.pda);
const nameV = (v: V) => ('owner' in v ? `${v.owner.name}` : `${v.session.vote ? 'vote' : 'move-only'} session of ${OWNERS.find((w) => w.key.equals(v.session.owner))?.name ?? '?'}`);
const wrapV = (v: V, inners: TransactionInstruction[], o: Over = {}) => ('owner' in v ? inners.map((i) => ownerIx(v.owner, i, o)) : [v.session.sigIx, ...inners.map((i) => sessionIx(v.session, i, o))]);
const signersV = (v: V): S[] => ('owner' in v ? [v.owner] : [v.session.key]);
const act = (name: string, expectOk: boolean, v: V, inners: TransactionInstruction[], o: Over & { want?: RegExp; selfPaid?: boolean; cu?: number } = {}) =>
  submit(name, expectOk, wrapV(v, inners, o), signersV(v), o);

/** A seat decision: `a` proposes and approves, `b` approves and executes (or, with b null, `a` executes with only its own approval). With `stop`, nothing executes. Returns the index. */
async function decide(label: string, a: V, b: V | null, actions: { vault?: TransactionInstruction[]; settings?: any[]; policies?: PublicKey[] }, expectOk: boolean, o: { stop?: boolean; want?: RegExp; aOk?: boolean; noApprove?: boolean } = {}) {
  const index = await nextIndex(), pa = pdaV(a);
  const create = actions.settings
    ? ix.createSettingsTransaction({ settingsPda: settings(), transactionIndex: index, creator: pa, rentPayer: payer.publicKey, actions: actions.settings })
    : ix.createTransaction({ settingsPda: settings(), transactionIndex: index, creator: pa, rentPayer: payer.publicKey, accountIndex: 0, ephemeralSigners: 0, addressLookupTableAccounts: [],
        transactionMessage: new TransactionMessage({ payerKey: vault(), recentBlockhash: (await conn.getLatestBlockhash()).blockhash, instructions: actions.vault! }) });
  const prop = [ix.createProposal({ settingsPda: settings(), transactionIndex: index, creator: pa, rentPayer: payer.publicKey }), ...(o.noApprove ? [] : [ix.approveProposal({ settingsPda: settings(), transactionIndex: index, signer: pa })])];
  // the create call is a transaction of its own when the grant's ed25519 instruction or a big payload would push the transaction over 1,232 bytes
  const aOk = o.aOk ?? true;
  if ('session' in a || actions.settings) { const made = await act(`${label}a1. ${nameV(a)} creates the transaction`, aOk, a, [create], { want: o.want }); if (!aOk) return index; if (made) await act(`${label}a2. ${nameV(a)} proposes and approves`, true, a, prop); }
  else await act(`${label}a. ${nameV(a)} creates, proposes and approves`, true, a, [create, ...prop]);
  if (o.stop) return index;
  const ex = b ?? a, pe = pdaV(ex);
  const exec = actions.settings
    ? ix.executeSettingsTransaction({ settingsPda: settings(), transactionIndex: index, signer: pe, rentPayer: payer.publicKey, policies: actions.policies ?? [] })
    : (await ix.executeTransaction({ connection: conn, settingsPda: settings(), transactionIndex: index, signer: pe })).instruction;
  const ixs = b ? [ix.approveProposal({ settingsPda: settings(), transactionIndex: index, signer: pe }), exec] : [exec];
  await act(`${label}b. ${b ? `${nameV(b)} approves and executes` : `${nameV(a)} executes with only its own approval`}`, expectOk, ex, ixs, { want: o.want });
  return index;
}
// The no-governance build reads the proposal's transaction account, passed last in the call.
const approveAt = (settingsPda: PublicKey, index: bigint, signer: PublicKey) => {
  const i = ix.approveProposal({ settingsPda, transactionIndex: index, signer });
  if (VARIANT === 'ng') i.keys.push({ pubkey: sa.getTransactionPda({ settingsPda, transactionIndex: index })[0], isSigner: false, isWritable: false });
  return i;
};
const approve = (index: bigint, v: V) => approveAt(settings(), index, pdaV(v));
const proposalOf = async (index: bigint) => sa.accounts.Proposal.fromAccountAddress(conn, sa.getProposalPda({ settingsPda: settings(), transactionIndex: index })[0]);
const approvers = async (index: bigint) => (await proposalOf(index)).approved.map((k: PublicKey) => k.toBase58());
const statusOf = async (index: bigint) => (await proposalOf(index)).status.__kind as string;

// ── P. Setup ───────────────────────────────────────────────────────────────────────────────────
if ((await conn.getBalance(payer.publicKey)) < 10 * SOL) await confirm(await conn.requestAirdrop(payer.publicKey, 100 * SOL));
for (const [n, id] of [['A', PROG], ['B', PROG_B]] as const) if (!(await conn.getAccountInfo(id))?.executable) throw new Error(`prime-seat ${n} (${id.toBase58()}) is not loaded on ${RPC}`);
const startBalance = await conn.getBalance(payer.publicKey);
{
  const { settingsPda, sig } = await createAccount('A', (s) => OWNERS.map((w) => ({ key: pdaOf(w.key, s), permissions: ALL })));
  const s = await getSettings();
  record('P0. the settings signers are exactly the three seat PDAs (mask 7), threshold 2, vault funded', true,
    s.signers.map((x: any) => x.key.toBase58()).sort().join() === OWNERS.map((w) => pdaOf(w.key, settingsPda).toBase58()).sort().join() && s.signers.every((x: any) => x.permissions.mask === 7) && s.threshold === 2, sig);
  record('P0b. no PDA is on the ed25519 curve (it holds no key)', true, OWNERS.every((w) => !PublicKey.isOnCurve(pdaOf(w.key).toBytes())), '');
}

// ── K. Seats voted by owners ───────────────────────────────────────────────────────────────────
{
  for (const w of OWNERS) await decide(`K1-${w.name}. ${w.name} alone:`, asOwner(w), null, { vault: [sysTransfer(DEST, 0.01)] }, false, { want: BADSTATUS });
  const b = await conn.getBalance(DEST);
  await decide('K2. MetaMask + Freighter:', asOwner(MM), asOwner(FR), { vault: [sysTransfer(DEST, 0.01)] }, true);
  await measure('approve-and-execute-owner');
  await decide('K3. Freighter + Phantom:', asOwner(FR), asOwner(PH), { vault: [sysTransfer(DEST, 0.01)] }, true);
  await decide('K4. Phantom + MetaMask:', asOwner(PH), asOwner(MM), { vault: [sysTransfer(DEST, 0.01)] }, true);
  record('K5. DEST received exactly 0.03 SOL', true, (await conn.getBalance(DEST)) - b === 0.03 * SOL, `${((await conn.getBalance(DEST)) - b) / SOL}`);
  const idx = await decide('K6. MetaMask alone (open proposal):', asOwner(MM), null, { vault: [sysTransfer(DEST, 0.01)] }, false, { want: BADSTATUS });
  const fAppr = () => ix.approveProposal({ settingsPda: settings(), transactionIndex: idx, signer: pdaOf(FR.key) });
  await act("K6c. an outsider's PDA approves it (not a seat)", false, asOwner(OUT), [ix.approveProposal({ settingsPda: settings(), transactionIndex: idx, signer: pdaOf(OUT.key) })], { want: NAS });
  await act("K6d. Freighter's seat vote signed by MetaMask's key (data names Freighter as owner)", false, asOwner(MM), [fAppr()], { owner: FR.key, pda: pdaOf(FR.key), want: E7 });
  await act("K6d2. Freighter's PDA named, owner field Phantom, signed by Phantom", false, asOwner(PH), [fAppr()], { pda: pdaOf(FR.key), want: E2 });
  await submit("K6e. Freighter's seat vote signed by its MPC key under another path", false, wrapV(asOwner(FR), [fAppr()]), [{ ...FR, sign: FR_OTHER_PATH.sign }], { want: /signature verification/i });
  // The old seat keys (prime:solana) are not settings signers any more, and a PDA cannot sign a transaction by itself.
  for (const w of [MM_OLD, FR_OLD]) await submit(`K6f-${w.name}. the old seat key approves as itself`, false, [ix.approveProposal({ settingsPda: settings(), transactionIndex: idx, signer: w.key })], [w], { want: NAS });
  await submit('K6g. an approve naming the PDA as signer, sent straight to Squads', false, [fAppr()], [], { want: /signature verification/i });
  const replay = await act('K6h. Freighter votes through prime-seat (control: the same proposal)', true, asOwner(FR), [fAppr()]);
  record('K6i. the proposal now holds MetaMask + Freighter approvals and is Approved', true, replay && (await statusOf(idx)) === 'Approved', await statusOf(idx));
  // movers policy: members are the same three PDAs (settings signer and policy signer at once); a 2-of-3 owner decision (MetaMask + Phantom)
  const seed = Number((await getSettings()).policySeed ?? 0) + 1;
  acct.A!.policy = sa.getPolicyPda({ settingsPda: settings(), policySeed: seed })[0].toBase58(); st.policy = acct.A!.policy; save();
  await decide('K7. install the movers policy (members: the same three PDAs):', asOwner(MM), asOwner(PH), { settings: [{ __kind: 'PolicyCreate', seed, policyCreationPayload: policyPayload(),
    signers: OWNERS.map((w) => ({ key: pdaOf(w.key), permissions: ALL })), threshold: 1, timeLock: 0, startTimestamp: null, expirationArgs: null }], policies: [policyAddr()] }, true);
  const pol = await sa.accounts.Policy.fromAccountAddress(conn, policyAddr());
  const setSigners = (await getSettings()).signers.map((x: any) => x.key.toBase58()).sort().join(), polSigners = pol.signers.map((x: any) => x.key.toBase58()).sort().join();
  record('K8. the policy signers and the settings signers are the same three PDAs', true, setSigners === polSigners, setSigners.length ? 'equal' : '');
}

// ── N. A move-only session cannot vote ─────────────────────────────────────────────────────────
{
  const s = await openSession(PH);                                                       // move-only (default)
  const idx = await decide('N0. MetaMask alone (open proposal):', asOwner(MM), null, { vault: [sysTransfer(DEST, 0.01)] }, false, { want: BADSTATUS });
  const v = asSession(s), pdaPH = s.pda;
  await act('N1. a move-only session approves that proposal as its PDA', false, v, [ix.approveProposal({ settingsPda: settings(), transactionIndex: idx, signer: pdaPH })], { want: E8 });
  await act('N2. ...proposes a vault transaction as its PDA', false, v, [ix.createTransaction({ settingsPda: settings(), transactionIndex: idx + 1n, creator: pdaPH, rentPayer: payer.publicKey, accountIndex: 0, ephemeralSigners: 0, addressLookupTableAccounts: [],
    transactionMessage: new TransactionMessage({ payerKey: vault(), recentBlockhash: (await conn.getLatestBlockhash()).blockhash, instructions: [sysTransfer(OTHER, 0.01)] }) })], { want: E8 });
  await act('N3. ...adds its key as a seat (settings sync, as its PDA)', false, v, [ix.executeSettingsTransactionSync({ settingsPda: settings(), feePayer: s.key.publicKey, signers: [pdaPH],
    actions: [{ __kind: 'AddSigner', newSigner: { key: s.key.publicKey, permissions: ALL } }] as any })], { want: E8 });
  await act('N4. ...creates a settings transaction as its PDA', false, v, [ix.createSettingsTransaction({ settingsPda: settings(), transactionIndex: idx + 1n, creator: pdaPH, rentPayer: payer.publicKey,
    actions: [{ __kind: 'ChangeThreshold', newThreshold: 1 }] as any })], { want: E8 });
  await act('N5. ...calls a program other than the Smart Account (System transfer from its PDA)', false, v, [SystemProgram.transfer({ fromPubkey: pdaPH, toPubkey: OTHER, lamports: 1000 })], { want: E8 });
  // a synchronous vault transaction on the settings consensus has the policy move's discriminator but is no policy move
  {
    const d = sa.utils.instructionsToSynchronousTransactionDetailsV2({ vaultPda: vault(), members: [pdaPH], transaction_instructions: [sysTransfer(OTHER, 0.01)] });
    await act('N6. ...runs a synchronous vault transaction on the settings (the policy move\'s discriminator, consensus = settings)', false, v, [ix.executeTransactionSyncV2({ settingsPda: settings(), accountIndex: 0, numSigners: 1, instructions: d.instructions, instruction_accounts: d.accounts })], { want: E8 });
  }
  // the approved-but-unexecuted proposal a move-only session must not execute
  const ap = await decide('N7. MetaMask proposes and approves:', asOwner(MM), null, { vault: [sysTransfer(DEST, 0.01)] }, true, { stop: true });
  await act('N7b. (Freighter approves)', true, asOwner(FR), [approve(ap, asOwner(FR))]);
  const exe = (await ix.executeTransaction({ connection: conn, settingsPda: settings(), transactionIndex: ap, signer: pdaPH })).instruction;
  await act('N8. a move-only session executes the approved proposal', false, v, [exe], { want: E8 });
  await act('N8b. ...rejects a proposal as its PDA', false, v, [ix.rejectProposal({ settingsPda: settings(), transactionIndex: idx, signer: pdaPH })], { want: E8 });
  st.approvedIdx = ap.toString();
  // a session key that signs a vote as itself (no PDA): refused by the Smart Account
  await submit('N9. a session key approves as itself (the grant is not involved)', false, [ix.approveProposal({ settingsPda: settings(), transactionIndex: idx, signer: s.key.publicKey })], [s.key], { want: NAS });
}

// ── D. Vote sessions ───────────────────────────────────────────────────────────────────────────
const ses = async (w: W, o: { seconds?: number; fund?: number; signAs?: W; text?: (t: string) => string; key?: Keypair } = {}) => openSession(w, { ...o, vote: true });
const FULL = VARIANT === 'full';
{
  const b0 = await conn.getBalance(DEST); let expect = 0;
  // D1: an owner proposes and approves, a vote session approves, another owner executes (both builds: a vote session approves)
  const sPH = await ses(PH);
  const i1 = await decide('D1. MetaMask proposes and approves (open):', asOwner(MM), null, { vault: [sysTransfer(DEST, 0.01)] }, false, { stop: true });
  await act('D1b. Phantom vote session approves it', true, asSession(sPH), [approve(i1, asSession(sPH))]);
  await measure('vote-session-approve-first');
  await act('D1c. Freighter (owner) executes: two approvals, MetaMask and the Phantom session', true, asOwner(FR), [(await ix.executeTransaction({ connection: conn, settingsPda: settings(), transactionIndex: i1, signer: pdaOf(FR.key) })).instruction], {}); expect += 0.01;
  // D2: a vote session creates, proposes and executes (full build); the no-governance build refuses each of those calls
  const sFR = await ses(FR);
  if (FULL) {
    await decide('D2. Phantom vote session + Freighter:', asSession(sPH), asOwner(FR), { vault: [sysTransfer(DEST, 0.01)] }, true); expect += 0.01;
    await decide('D2b. MetaMask + Freighter vote session:', asOwner(MM), asSession(sFR), { vault: [sysTransfer(DEST, 0.01)] }, true); expect += 0.01;
    await measure('approve-and-execute-session');
  } else {
    const idx = await nextIndex();
    await decide('D2. Phantom vote session creates a vault transaction (no governance):', asSession(sPH), asOwner(FR), { vault: [sysTransfer(DEST, 0.01)] }, false, { aOk: false, want: E8 });
    const ap = await decide('D2b. MetaMask proposes and approves (open):', asOwner(MM), null, { vault: [sysTransfer(DEST, 0.01)] }, false, { stop: true });
    await act('D2c. Freighter owner approves it', true, asOwner(FR), [approve(ap, asOwner(FR))]);
    await act('D2d. a vote session executes the approved proposal (no governance: approve only)', false, asSession(sFR), [(await ix.executeTransaction({ connection: conn, settingsPda: settings(), transactionIndex: ap, signer: pdaOf(FR.key) })).instruction], { want: E8 });
    await act('D2e. a vote session creates a proposal', false, asSession(sFR), [ix.createProposal({ settingsPda: settings(), transactionIndex: idx, creator: pdaOf(FR.key), rentPayer: payer.publicKey })], { want: E8 });
    await act('D2f. Phantom owner executes it', true, asOwner(PH), [(await ix.executeTransaction({ connection: conn, settingsPda: settings(), transactionIndex: ap, signer: pdaOf(PH.key) })).instruction], {}); expect += 0.01;
  }
  // D3: two vote sessions approve, no owner key votes (the proposer does not approve); an owner executes
  const sMM = await ses(MM), sPH2 = await ses(PH);
  const i3 = await decide('D3. Freighter proposes without approving:', asOwner(FR), null, { vault: [sysTransfer(DEST, 0.01)] }, false, { stop: true, noApprove: true });
  await act('D3b. MetaMask vote session approves', true, asSession(sMM), [approve(i3, asSession(sMM))]);
  await act('D3c. Phantom vote session approves: two approvals, both from sessions', true, asSession(sPH2), [approve(i3, asSession(sPH2))]);
  record('D3d. the proposal is Approved with MetaMask and Phantom PDAs', true, (await statusOf(i3)) === 'Approved' && (await approvers(i3)).length === 2, `${await statusOf(i3)}, ${(await approvers(i3)).length}`);
  await act('D3e. Freighter (owner, no vote) executes', true, asOwner(FR), [(await ix.executeTransaction({ connection: conn, settingsPda: settings(), transactionIndex: i3, signer: pdaOf(FR.key) })).instruction], {}); expect += 0.01;
  record(`D4. DEST received exactly ${expect.toFixed(2)} SOL from the decisions`, true, Math.abs((await conn.getBalance(DEST)) - b0 - expect * SOL) < 1, `${((await conn.getBalance(DEST)) - b0) / SOL}`);
  // D5: an owner and its own session count once
  const sMM2 = await ses(MM);
  const i5 = await decide('D5. MetaMask proposes and approves (open):', asOwner(MM), null, { vault: [sysTransfer(DEST, 0.01)] }, false, { stop: true });
  await act("D5b. MetaMask's own vote session approves the same proposal", false, asSession(sMM2), [approve(i5, asSession(sMM2))], { want: ALREADY });
  record("D5c. one approval is recorded (MetaMask's PDA) and the proposal is still Active", true, (await approvers(i5)).length === 1 && (await statusOf(i5)) === 'Active', `${(await approvers(i5)).length} approval(s), ${await statusOf(i5)}`);
  const exec5 = async (v: V) => (await ix.executeTransaction({ connection: conn, settingsPda: settings(), transactionIndex: i5, signer: pdaV(v) })).instruction;
  await act("D5d. MetaMask's session executes with that one approval", false, asSession(sMM2), [await exec5(asSession(sMM2))], { want: FULL ? BADSTATUS : E8 });
  await act('D5e. Freighter approves', true, asOwner(FR), [approve(i5, asOwner(FR))]);
  const b5 = await conn.getBalance(DEST);
  if (FULL) await act("D5f. MetaMask's vote session executes (two approvals: MetaMask, Freighter)", true, asSession(sMM2), [await exec5(asSession(sMM2))], {});
  else await act('D5f. MetaMask (owner) executes (two approvals: MetaMask, Freighter)', true, asOwner(MM), [await exec5(asOwner(MM))], {});
  record('D5g. DEST received 0.01 SOL', true, (await conn.getBalance(DEST)) - b5 === 0.01 * SOL, '');
  // D6: a session alone
  const sPH3 = await ses(PH);
  const i6 = await decide('D6. Freighter proposes without approving:', asOwner(FR), null, { vault: [sysTransfer(DEST, 0.01)] }, false, { stop: true, noApprove: true });
  await act('D6b. Phantom vote session approves (its approval alone)', true, asSession(sPH3), [approve(i6, asSession(sPH3))]);
  record('D6c. one approval recorded, still Active', true, (await approvers(i6)).length === 1 && (await statusOf(i6)) === 'Active', `${(await approvers(i6)).length}, ${await statusOf(i6)}`);
  await act('D6d. an owner executes with that one approval', false, asOwner(FR), [(await ix.executeTransaction({ connection: conn, settingsPda: settings(), transactionIndex: i6, signer: pdaOf(FR.key) })).instruction], { want: BADSTATUS });
  {
    const d = sa.utils.instructionsToSynchronousTransactionDetailsV2({ vaultPda: vault(), members: [sPH3.pda], transaction_instructions: [sysTransfer(OTHER, 0.01)] });
    await act('D6e. the vote session runs a synchronous vault transaction on the settings alone (threshold 2)', false, asSession(sPH3), [ix.executeTransactionSyncV2({ settingsPda: settings(), accountIndex: 0, numSigners: 1, instructions: d.instructions, instruction_accounts: d.accounts })], { want: FULL ? /InvalidSignerCount|ThresholdNotReached/ : E8 });
    await act('D6f. the vote session adds its key as a seat by settings sync alone', false, asSession(sPH3), [ix.executeSettingsTransactionSync({ settingsPda: settings(), feePayer: sPH3.key.publicKey, signers: [sPH3.pda],
      actions: [{ __kind: 'AddSigner', newSigner: { key: sPH3.key.publicKey, permissions: ALL } }] as any })], { want: FULL ? /InvalidSignerCount|ThresholdNotReached/ : E8 });
  }
  // D7: the vote session key signing as itself, and the session key not signing
  await submit('D7. a vote session key approves as itself', false, [ix.approveProposal({ settingsPda: settings(), transactionIndex: i6, signer: sPH3.key.publicKey })], [sPH3.key], { want: NAS });
  {
    const bare = wrapV(asSession(sPH3), [approve(i6, asSession(sPH3))]); bare[1] = new TransactionInstruction({ ...bare[1]!, keys: bare[1]!.keys.map((k, i) => (i === 1 ? { ...k, isSigner: false } : k)) });
    await submit('D8. the session key does not sign (relayer only)', false, bare, [], { want: /missing required signature|MissingRequiredSignature/i });
  }
  // D9: expiry, stretch, revoke
  const old = await ses(PH, { seconds: -10 });
  await act('D9. an expired vote grant votes', false, asSession(old), [approve(i6, asSession(old))], { want: E4 });
  const long = await ses(PH, { seconds: 8 * 86400 });
  await act('D9b. a vote grant longer than 7 days votes', false, asSession(long), [approve(i6, asSession(long))], { want: E4 });
  const str = await ses(PH);
  await act('D9c. a stretched valid-until', false, asSession(str), [approve(i6, asSession(str))], { until: str.until + 60, want: E7 });
  const rv = await ses(PH);
  await submit('D10. Phantom revokes that vote session (one signature, relayed)', true, await revokeIxs(PH, rv.key.publicKey), []);
  await act('D10b. the revoked vote session approves', false, asSession(rv), [approve(i6, asSession(rv))], { want: E2 });
  // D11: tampering with the vote flag
  const mo = await openSession(PH), vt = await ses(PH);
  await act('D11. a move-only grant presented with the vote flag set', false, asSession(mo), [approve(i6, asSession(mo))], { vote: true, want: E7 });
  await act('D11b. a vote grant presented with the vote flag cleared', false, asSession(vt), [approve(i6, asSession(vt))], { vote: false, want: E7 });
  const t0 = baseText(mo.pda, mo.key.publicKey, mo.until);
  await act('D11c. the production grant text (no vote line) presented to prime-seat', false, asSession({ ...mo, sigIx: edIx(PH, t0, await signGrant(PH, t0)) }), [approve(i6, asSession(mo))], { want: E7 });
  // D12: another wallet's PDA, another wallet's grant
  const phv = await ses(PH);
  await act("D12. Phantom's vote grant presented for MetaMask's PDA (data names Phantom as owner)", false, asSession(phv), [ix.approveProposal({ settingsPda: settings(), transactionIndex: i6, signer: pdaOf(MM.key) })], { pda: pdaOf(MM.key), want: E7 });
  await act("D12b. ...with MetaMask named as owner", false, asSession(phv), [ix.approveProposal({ settingsPda: settings(), transactionIndex: i6, signer: pdaOf(MM.key) })], { pda: pdaOf(MM.key), owner: MM.key, want: E7 });
  const fake = await ses(PH, { text: (t) => t.replace(`signer: ${pdaOf(PH.key).toBase58()}`, `signer: ${pdaOf(MM.key).toBase58()}`) });
  await act("D12c. Phantom signs a vote grant that names MetaMask's PDA", false, asSession(fake), [ix.approveProposal({ settingsPda: settings(), transactionIndex: i6, signer: pdaOf(MM.key) })], { pda: pdaOf(MM.key), want: E2 });
  const x = await ses(FR, { signAs: MM });
  await act("D12d. Freighter's vote PDA with a grant signed by MetaMask", false, asSession(x), [approve(i6, asSession(x))], { want: E7 });
  const y = await ses(FR, { signAs: FR_OTHER_PATH });
  await act("D12e. Freighter's vote PDA with its MPC key under another path", false, asSession(y), [approve(i6, asSession(y))], { want: E7 });
  const z = await ses(FR, { signAs: FR_OLD });
  await act("D12f. Freighter's vote PDA with a grant signed by its old seat key (prime:solana)", false, asSession(z), [approve(i6, asSession(z))], { want: E7 });
  // D13: a thief replays a vote grant with its own key
  const thief = Keypair.generate(); await fund(thief.publicKey, SESSION_FUND);
  await act('D13. someone else replays a vote grant with their own key', false, asSession({ ...phv, key: thief }), [approve(i6, asSession(phv))], { want: E7 });
  // D14: a vote session can also reject (a seat's right); the no-governance build allows approvals only
  const rj = await ses(FR);
  await act('D14. a vote session rejects the open proposal', FULL, asSession(rj), [ix.rejectProposal({ settingsPda: settings(), transactionIndex: i6, signer: pdaOf(FR.key) })], FULL ? {} : { want: E8 });
  if (FULL) record('D14b. one rejection is recorded and the proposal is still Active (cutoff 2)', true, (await proposalOf(i6)).rejected.length === 1 && (await statusOf(i6)) === 'Active', `${(await proposalOf(i6)).rejected.length} rejection(s), ${await statusOf(i6)}`);
}

// ── S. The dangerous case: a vote session and one owner change the seats ───────────────────────
{
  sel = 'C';
  const { sig } = await createAccount('C', (s) => OWNERS.map((w) => ({ key: pdaOf(w.key, s), permissions: ALL })));
  record('S0. account C created with the same three owners', true, true, sig);
  await fund(vault(), 1 * SOL);
  const atk = Keypair.generate(), full = VARIANT === 'full';
  const actions = [{ __kind: 'AddSigner', newSigner: { key: atk.publicKey, permissions: ALL } }, { __kind: 'ChangeThreshold', newThreshold: 1 }] as any;
  // (a) a vote session proposes the change, an owner approves and executes it
  const sPH = await ses(PH);
  if (full) await decide('S1. Phantom vote session + MetaMask add an outside key as a seat and set the threshold to 1:', asSession(sPH), asOwner(MM), { settings: actions }, true);
  else await decide('S1. Phantom vote session creates a settings transaction (no governance):', asSession(sPH), asOwner(MM), { settings: actions }, false, { aOk: false, want: E8 });
  if (!full) {
    // (b) an owner proposes the change; the vote session may not approve it
    const idx = await decide('S1b. MetaMask proposes the same change and approves:', asOwner(MM), null, { settings: actions }, false, { stop: true });
    await act('S1c. Phantom vote session approves the settings proposal', false, asSession(sPH), [approve(idx, asSession(sPH))], { want: E8 });
    await act('S1d. Freighter vote session executes the approved settings proposal', false, asSession(await ses(FR)), [ix.executeSettingsTransaction({ settingsPda: settings(), transactionIndex: idx, signer: pdaOf(FR.key), rentPayer: payer.publicKey, policies: [] })], { want: E8 });
    await act('S1e. Phantom vote session approves a vault proposal (allowed)', true, asSession(sPH), [approve(await decide('S1f. MetaMask proposes a vault transfer:', asOwner(MM), null, { vault: [sysTransfer(DEST, 0.001)] }, false, { stop: true }), asSession(sPH))]);
  }
  const s = await getSettings();
  record(`S2. ${full ? 'the account now has the outside key as a seat and threshold 1' : 'the account is unchanged: three seats, threshold 2'}`, true,
    full ? s.signers.some((x: any) => x.key.equals(atk.publicKey)) && s.threshold === 1 : s.signers.length === 3 && s.threshold === 2, `${s.signers.length} seats, threshold ${s.threshold}`);
  if (full) {
    // the outside key alone now moves the vault
    const b = await conn.getBalance(OTHER), index = await nextIndex();
    await submit('S3a. the outside key alone proposes and approves a 0.9 SOL transfer', true, [
      ix.createTransaction({ settingsPda: settings(), transactionIndex: index, creator: atk.publicKey, rentPayer: payer.publicKey, accountIndex: 0, ephemeralSigners: 0, addressLookupTableAccounts: [],
        transactionMessage: new TransactionMessage({ payerKey: vault(), recentBlockhash: (await conn.getLatestBlockhash()).blockhash, instructions: [sysTransfer(OTHER, 0.9)] }) }),
      ix.createProposal({ settingsPda: settings(), transactionIndex: index, creator: atk.publicKey, rentPayer: payer.publicKey }), ix.approveProposal({ settingsPda: settings(), transactionIndex: index, signer: atk.publicKey })], [atk]);
    await submit('S3b. ...and executes it', true, [(await ix.executeTransaction({ connection: conn, settingsPda: settings(), transactionIndex: index, signer: atk.publicKey })).instruction], [atk], {});
    record('S3c. OTHER received 0.9 SOL', true, (await conn.getBalance(OTHER)) - b === 0.9 * SOL, `${((await conn.getBalance(OTHER)) - b) / SOL}`);
  }
  // (c) two vote sessions, no owner key at all, on a fresh account
  sel = 'D';
  const d = await createAccount('D', (st2) => OWNERS.map((w) => ({ key: pdaOf(w.key, st2), permissions: ALL })));
  record('S4. account D created with the same three owners', true, true, d.sig);
  const s1 = await ses(PH), s2 = await ses(FR);
  await decide('S4b. Phantom vote session + Freighter vote session set the threshold to 3 (no owner signs):', asSession(s1), asSession(s2), { settings: [{ __kind: 'ChangeThreshold', newThreshold: 3 }] as any }, full, full ? {} : { aOk: false, want: E8 });
  record(`S4c. account D ${full ? 'now needs 3 of 3' : 'is unchanged (2 of 3)'}`, true, (await getSettings()).threshold === (full ? 3 : 2), `threshold ${(await getSettings()).threshold}`);
  sel = 'A';
}

// ── Q. What Squads does with a PDA as a settings signer: permissions, one by one ───────────────
{
  sel = 'Q';
  // X proposes only, Y votes only, Z executes only; threshold 1
  const [X, Y, Z] = [PH, FR, MM];
  const { sig } = await createAccount('Q', (s) => [[X, 1], [Y, 2], [Z, 4]].map(([w, m]) => ({ key: pdaOf((w as W).key, s), permissions: { mask: m as number } })), 1);
  record('Q0. account with three PDA seats: Phantom Initiate, Freighter Vote, MetaMask Execute; threshold 1', true, true, sig);
  await fund(vault(), 0.2 * SOL);
  const index = await nextIndex(), mk = async (creator: PublicKey, i: bigint) => ix.createTransaction({ settingsPda: settings(), transactionIndex: i, creator, rentPayer: payer.publicKey, accountIndex: 0, ephemeralSigners: 0, addressLookupTableAccounts: [],
    transactionMessage: new TransactionMessage({ payerKey: vault(), recentBlockhash: (await conn.getLatestBlockhash()).blockhash, instructions: [sysTransfer(DEST, 0.001)] }) });
  const prop = (creator: PublicKey, i: bigint) => ix.createProposal({ settingsPda: settings(), transactionIndex: i, creator, rentPayer: payer.publicKey });
  const pX = pdaOf(X.key), pY = pdaOf(Y.key), pZ = pdaOf(Z.key);
  await act('Q1. a Vote-only PDA (Freighter) creates a transaction', false, asOwner(Y), [await mk(pY, index)], { want: UNAUTH });
  await act('Q2. an Execute-only PDA (MetaMask) creates a transaction', false, asOwner(Z), [await mk(pZ, index)], { want: UNAUTH });
  await act('Q3. an Initiate-only PDA (Phantom) creates a transaction and a proposal', true, asOwner(X), [await mk(pX, index), prop(pX, index)]);
  await act('Q4. ...and approves it', false, asOwner(X), [ix.approveProposal({ settingsPda: settings(), transactionIndex: index, signer: pX })], { want: UNAUTH });
  await act('Q5. an Execute-only PDA approves it', false, asOwner(Z), [ix.approveProposal({ settingsPda: settings(), transactionIndex: index, signer: pZ })], { want: UNAUTH });
  await act('Q6. a Vote-only PDA approves it (threshold 1: Approved)', true, asOwner(Y), [ix.approveProposal({ settingsPda: settings(), transactionIndex: index, signer: pY })]);
  const exe = async (p: PublicKey) => (await ix.executeTransaction({ connection: conn, settingsPda: settings(), transactionIndex: index, signer: p })).instruction;
  await act('Q7. an Initiate-only PDA executes it', false, asOwner(X), [await exe(pX)], { want: UNAUTH });
  await act('Q8. a Vote-only PDA executes it', false, asOwner(Y), [await exe(pY)], { want: UNAUTH });
  const b = await conn.getBalance(DEST);
  await act('Q9. an Execute-only PDA executes it', true, asOwner(Z), [await exe(pZ)], {});
  record('Q9b. DEST received 0.001 SOL', true, (await conn.getBalance(DEST)) - b === 0.001 * SOL, '');
  // a transaction made by Initiate-only, its proposal created by a Vote-only PDA (create_proposal accepts Initiate or Vote)
  const i2 = await nextIndex();
  await act('Q10. an Initiate-only PDA creates a transaction only', true, asOwner(X), [await mk(pX, i2)]);
  await act('Q10b. an Execute-only PDA creates the proposal for it', false, asOwner(Z), [prop(pZ, i2)], { want: UNAUTH });
  await act('Q10c. a Vote-only PDA creates the proposal for it (Squads allows Initiate or Vote)', true, asOwner(Y), [prop(pY, i2)]);
  // the same wrapper through a vote session keeps those permissions
  const sY = await ses(FR), i3 = await nextIndex();
  await act('Q11. the Vote-only seat\'s vote session creates a transaction', false, asSession(sY), [await mk(pY, i3)], { want: FULL ? UNAUTH : E8 });
  sel = 'A';
}

// ── T. Threshold 1: what the consensus test in the move-only gate stops ──────────────────────────
{
  sel = 'E';
  const { sig } = await createAccount('E', (s) => OWNERS.map((w) => ({ key: pdaOf(w.key, s), permissions: ALL })), 1);
  record('T0. account E: the same three owners, threshold 1', true, true, sig);
  await fund(vault(), 0.5 * SOL);
  const d = sa.utils.instructionsToSynchronousTransactionDetailsV2({ vaultPda: vault(), members: [pdaOf(PH.key)], transaction_instructions: [sysTransfer(OTHER, 0.01)] });
  const sync = () => ix.executeTransactionSyncV2({ settingsPda: settings(), accountIndex: 0, numSigners: 1, instructions: d.instructions, instruction_accounts: d.accounts });
  const b = await conn.getBalance(OTHER);
  await act('T1. the owner alone runs a synchronous vault transaction on the settings (one signature meets threshold 1)', true, asOwner(PH), [sync()]);
  record('T1b. OTHER received 0.01 SOL', true, (await conn.getBalance(OTHER)) - b === 0.01 * SOL, '');
  await act('T2. the same call from a move-only session is refused by prime-seat', false, asSession(await openSession(PH)), [sync()], { want: E8 });
  await act('T3. the same call from a vote session', FULL, asSession(await ses(PH)), [sync()], FULL ? {} : { want: E8 });
  // a vault transaction cannot reach the settings: the vault is no settings signer
  await decide('T4. a vault transaction calls a settings instruction with the vault as signer:', asOwner(PH), null, { vault: [ix.executeSettingsTransactionSync({ settingsPda: settings(), feePayer: vault(), signers: [vault()],
    actions: [{ __kind: 'ChangeThreshold', newThreshold: 2 }] as any })] }, false, { want: /NotASigner|Error Code|custom program error/ });
  record('T4b. the threshold of account E is still 1', true, (await getSettings()).threshold === 1, '');
  sel = 'A';
}

// ── G. Moves by move-only sessions, every wallet (as in psn.ts) ────────────────────────────────
const mvIxs = (s: Session, to: PublicKey, sol: number) => [policyMove(s.pda, sysTransfer(to, sol))];
for (const w of OWNERS) {
  const s = await openSession(w), v = asSession(s);
  const b = await conn.getBalance(VENUE);
  await act(`G-${w.name}1. one ${w.name} signature${w === PH ? '' : ' (through NEAR)'} -> session; relayer pays: 0.01 SOL to VENUE`, true, v, mvIxs(s, VENUE, 0.01));
  await measure(`move-${w.name}-relayed`);
  await act(`G-${w.name}2. relayer down: session key pays the fee itself: 0.005 SOL to VENUE`, true, v, mvIxs(s, VENUE, 0.005), { selfPaid: true });
  record(`G-${w.name}3. VENUE received exactly 0.015 SOL`, true, (await conn.getBalance(VENUE)) - b === 0.015 * SOL, `${((await conn.getBalance(VENUE)) - b) / SOL}`);
  const broke = await openSession(w, { fund: 0 });
  await act(`G-${w.name}4. relayer down and the session key has no SOL`, false, asSession(broke), mvIxs(broke, VENUE, 0.001), { selfPaid: true });
  await act(`G-${w.name}5. same session: 0.01 SOL elsewhere (policy)`, false, v, mvIxs(s, OTHER, 0.01));
  await act(`G-${w.name}6. same session: 0.06 SOL to VENUE (over the 0.05 per-move limit)`, false, v, mvIxs(s, VENUE, 0.06));
  await act(`G-${w.name}7. stretched valid-until`, false, v, mvIxs(s, VENUE, 0.001), { until: s.until + 60, want: E7 });
  const thief = Keypair.generate(); await fund(thief.publicKey, SESSION_FUND);
  await act(`G-${w.name}8. someone else replays the grant with their own key`, false, asSession({ ...s, key: thief }), mvIxs(s, VENUE, 0.001), { want: E7 });
}
{
  const long = await openSession(PH, { seconds: 8 * 86400 });
  await act('G9. grant longer than 7 days', false, asSession(long), mvIxs(long, VENUE, 0.001), { want: E4 });
  const old = await openSession(PH, { seconds: -10 });
  await act('G10. expired grant', false, asSession(old), mvIxs(old, VENUE, 0.001), { want: E4 });
  const mm = await openSession(MM);
  await submit('G11. MetaMask grant with the ed25519 program instruction missing', false, [sessionIx(mm, mvIxs(mm, VENUE, 0.001)[0]!)], [mm.key]);
  const d = Buffer.from(mm.sigIx.data); d.writeUInt16LE(1, 8);   // public key read from another instruction
  await act('G12. ed25519 instruction reading its public key from another instruction', false, asSession({ ...mm, sigIx: new TransactionInstruction({ ...mm.sigIx, data: d }) }), mvIxs(mm, VENUE, 0.001));
  await act('G13. daily cap shared by all: 0.045 used + 0.05 = 0.095 <= 0.1', true, asSession(mm), mvIxs(mm, VENUE, 0.05));
  await act('G13b. + 0.01 = 0.105 > 0.1', false, asSession(mm), mvIxs(mm, VENUE, 0.01));
}

// ── X. Cross-wallet and cross-program ──────────────────────────────────────────────────────────
{
  const mv = (s: Session) => mvIxs(s, VENUE, 0.001);
  const a = await openSession(FR, { signAs: MM });
  await act("X1. Freighter's PDA with a grant signed by MetaMask (NEAR)", false, asSession(a), mv(a), { want: E7 });
  const b = await openSession(PH, { signAs: FR });
  await act("X2. Phantom's PDA with a grant signed by Freighter (NEAR)", false, asSession(b), mv(b), { want: E7 });
  const c = await openSession(MM, { signAs: PH });
  await act("X3. MetaMask's PDA with a grant signed by Phantom", false, asSession(c), mv(c), { want: E7 });
  const d = await openSession(FR, { signAs: FR_OTHER_PATH });
  await act("X4. Freighter's PDA with its MPC key under another path", false, asSession(d), mv(d), { want: E7 });
  const e = await openSession(FR, { signAs: FR_OLD });
  await act("X4b. Freighter's PDA with a grant signed by its old seat key (prime:solana)", false, asSession(e), mv(e), { want: E7 });
  const ph = await openSession(PH);
  await act("X5. Phantom grant presented for MetaMask's PDA", false, asSession(ph), mvIxs({ ...ph, pda: pdaOf(MM.key) }, VENUE, 0.001), { owner: MM.key, pda: pdaOf(MM.key), want: E7 });
  const cl = await openSession(PH, { text: (t) => t.replace('cluster: localnet', 'cluster: mainnet') });
  await act('X6. grant signed for cluster mainnet, used on localnet', false, asSession(cl), mv(cl), { want: E7 });
  // The same .so at a second program id: the grant names a PDA, and the PDA commits to the program.
  {
    const gA = await openSession(PH), pdaB = pdaOf(PH.key, settings(), PROG_B);
    await act("X7a. a grant naming program A's PDA, presented to program B with A's PDA", false, asSession(gA), mv(gA), { prog: PROG_B, want: E2 });
    await act("X7b. the same grant presented to program B with B's PDA (text mismatch)", false, asSession(gA), mvIxs({ ...gA, pda: pdaB }, VENUE, 0.001), { prog: PROG_B, pda: pdaB, want: E7 });
    const gB = { ...(await openSession(PH, { text: (t) => t.replace(`signer: ${gA.pda.toBase58()}`, `signer: ${pdaB.toBase58()}`) })), pda: pdaB };
    await act("X7c. a grant naming program B's PDA, presented to program A with B's PDA", false, asSession(gB), mv(gB), { pda: pdaB, want: E2 });
    await act("X7d. the same grant presented to program A with A's PDA (text mismatch)", false, asSession(gB), mvIxs({ ...gB, pda: gA.pda }, VENUE, 0.001), { pda: gA.pda, want: E7 });
  }
  const mmPda = pdaOf(MM.key);
  const fake = await openSession(PH, { text: (t) => t.replace(`signer: ${pdaOf(PH.key).toBase58()}`, `signer: ${mmPda.toBase58()}`) });
  await act("X8. Phantom's own signed grant naming MetaMask's PDA", false, asSession(fake), mvIxs({ ...fake, pda: mmPda }, VENUE, 0.001), { pda: mmPda, want: E2 });
  const ph8 = await openSession(PH);
  await act('X9a. valid Phantom grant, data names another settings address', false, asSession(ph8), mv(ph8), { acct: OUT.key, want: E2 });
  const ns = wrapV(asSession(ph8), mv(ph8)); ns[1] = new TransactionInstruction({ ...ns[1]!, keys: ns[1]!.keys.map((k, i) => (i === 1 ? { ...k, isSigner: false } : k)) });
  await submit('X10. the session key does not sign (relayer only)', false, ns, []);
  const wt = wrapV(asSession(ph8), mv(ph8));
  wt[1] = new TransactionInstruction({ ...wt[1]!, keys: wt[1]!.keys.map((k, i) => (i === 3 ? { ...k, pubkey: SystemProgram.programId } : k)) });
  await submit('X11a. account 3 set to the System program instead of the Smart Account program: the move still runs', true, wt, [ph8.key]);
  const [lastSig] = await conn.getSignaturesForAddress(PROG, { limit: 1 }, 'confirmed');
  const logs = (await conn.getTransaction(lastSig!.signature, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 }))?.meta?.logMessages ?? [];
  const depth2 = logs.filter((l) => l.endsWith(' invoke [2]'));
  record('X11b. ...and prime-seat called only the Smart Account program', true, depth2.length === 1 && depth2[0]!.includes(SA_ID.toBase58()), depth2.join('; '));
}

// ── A. A grant works in one Smart Account only; compute units of a move ───────────────────────
{
  const a = await openSession(PH), aV = await ses(PH);       // granted for account A: a move-only and a vote grant
  const aPda = pdaOf(PH.key);
  const va = asSession(a);
  sel = 'B';
  const { settingsPda: B, sig } = await createAccount('B', (s) => OWNERS.map((w) => ({ key: pdaOf(w.key, s), permissions: ALL })));
  record('A0. account B created with the same three owners', true, true, sig);
  const seed = Number((await getSettings()).policySeed ?? 0) + 1;
  acct.B!.policy = sa.getPolicyPda({ settingsPda: settings(), policySeed: seed })[0].toBase58(); st.policyB = acct.B!.policy; save();
  await decide("A1. account B installs its movers policy (members: each owner's PDA for account B):", asOwner(MM), asOwner(PH), { settings: [{ __kind: 'PolicyCreate', seed, policyCreationPayload: policyPayload(),
    signers: [...OWNERS.map((w) => pdaOf(w.key)), ...(BASE ? [pdaOf(PH.key, B, BASE)] : [])].map((key) => ({ key, permissions: ALL })), threshold: 1, timeLock: 0, startTimestamp: null, expirationArgs: null }], policies: [policyAddr()] }, true);
  record("A2. each wallet's PDA differs between account A and account B", true, OWNERS.every((w) => !pdaOf(w.key, new PublicKey(acct.A!.settings!)).equals(pdaOf(w.key, B))), OWNERS.map((w) => pdaOf(w.key).toBase58().slice(0, 6)).join(','));
  await act("A3. account A's Phantom grant presented to account B (as Phantom's account-B PDA)", false, va, [policyMove(pdaOf(PH.key), sysTransfer(VENUE, 0.001))], { acct: B, pda: pdaOf(PH.key), want: E7 });
  await act("A4. account A's Phantom PDA calling account B's policy", false, va, [policyMove(a.pda, sysTransfer(VENUE, 0.001))], { want: NAS });
  const bb = await openSession(PH);                         // granted for account B
  await act('A5. a Phantom grant made for account B works in account B', true, asSession(bb), mvIxs(bb, VENUE, 0.001));
  // vote grants across accounts
  const ib = await decide("A5v. account B: MetaMask proposes and approves (open):", asOwner(MM), null, { vault: [sysTransfer(DEST, 0.001)] }, false, { stop: true });
  const bV = await ses(PH);                                  // vote grant for account B
  await act('A5w. a vote grant made for account B votes in account B', true, asSession(bV), [approve(ib, asSession(bV))]);
  await act("A3v. account A's Phantom vote grant presented to account B (as Phantom's account-B PDA)", false, asSession(aV), [approveAt(B, ib, pdaOf(PH.key))], { acct: B, pda: pdaOf(PH.key), want: E7 });
  await act("A4v. account A's Phantom vote grant and PDA voting on account B's proposal", false, asSession(aV), [approveAt(B, ib, aV.pda)], { want: FULL ? NAS : E8 });
  // the owner path across accounts: Phantom signs, the data names account B but account A's PDA
  await act("A5b. Phantom signs a call with account A's PDA and account B's settings in the data", false, asOwner(PH), [ix.approveProposal({ settingsPda: new PublicKey(acct.A!.settings!), transactionIndex: 1n, signer: aPda })], { acct: B, pda: aPda, want: E2 });
  // Compute units of a whole move (prime-seat plus the Smart Account call) over ten sessions: the bump search for the marker differs per key.
  // With PSS_BASE the production program runs ten moves in this same account, interleaved with prime-seat's.
  const cu: number[] = [], cu8: number[] = [];
  for (let i = 0; i < 10; i++) {
    const m = await openSession(PH);
    await act(`A5-M${i}. Phantom session: one move through the Smart Account (compute units recorded)`, true, asSession(m), mvIxs(m, VENUE, 0.00001));
    await measure(`move-sample-${i}`); cu.push(metrics[`move-sample-${i}`].totalCu);
    if (!BASE) continue;
    const key = Keypair.generate(), until = Math.floor(Date.now() / 1000) + 3600, pda8 = pdaOf(PH.key, B, BASE), text = baseText(pda8, key.publicKey, until);
    await fund(key.publicKey, SESSION_FUND);
    const inner = policyMove(pda8, sysTransfer(VENUE, 0.00001));
    const h8 = Buffer.concat([PH.key.toBuffer(), B.toBuffer(), Buffer.from(new BigInt64Array([BigInt(until)]).buffer), Buffer.from([0, bumpOf(PH.key, B, BASE)])]);
    const keys = [{ pubkey: SYSVAR_INSTRUCTIONS_PUBKEY, isSigner: false, isWritable: false }, { pubkey: key.publicKey, isSigner: true, isWritable: true }, { pubkey: pda8, isSigner: false, isWritable: false },
      { pubkey: inner.programId, isSigner: false, isWritable: false }, { pubkey: markerOf(PH.key, B, key.publicKey, BASE), isSigner: false, isWritable: false }, ...forwarded(inner, pda8)];
    await submit(`A5-R${i}. production prime-session, same account: one move through the Smart Account (compute units recorded)`, true,
      [edIx(PH, text, await PH.sign(new TextEncoder().encode(text))), new TransactionInstruction({ programId: BASE, keys, data: Buffer.concat([h8, inner.data]) })], [key]);
    await measure(`move8-sample-${i}`, BASE); cu8.push(metrics[`move8-sample-${i}`].totalCu);
  }
  const stat = (v: number[]) => { v.sort((x, y) => x - y); return { samples: v, min: v[0], median: (v[4]! + v[5]!) / 2, max: v[9] }; };
  metrics.moveCu = { ...stat(cu), txBytes: last.bytes };
  if (BASE) metrics.moveCuProduction = stat(cu8);
  sel = 'A';
  await act("A6v. account B's Phantom vote grant presented to account A (as Phantom's account-A PDA)", false, asSession(bV), [approveAt(settings(), 1n, pdaOf(PH.key))], { acct: settings(), pda: pdaOf(PH.key), want: E7 });
  await act("A6. account B's grant presented to account A", false, asSession(bb), [policyMove(pdaOf(PH.key), sysTransfer(VENUE, 0.001))], { acct: new PublicKey(acct.A!.settings!), pda: pdaOf(PH.key, new PublicKey(acct.A!.settings!)), want: E7 });
}

// ── V. Per-session revoke: the owner signs the grant text with time 0, one relayed transaction ──
{
  const mv = (s: Session) => mvIxs(s, VENUE, 0.00001);   // small, so the daily cap checked in G13 is not used up
  const s1 = await openSession(PH), s2 = await openSession(PH);
  await act('V0a. Phantom session 1 works', true, asSession(s1), mv(s1));
  await act('V0b. Phantom session 2 works', true, asSession(s2), mv(s2));
  const m1 = markerOf(PH.key, settings(), s1.key.publicKey);
  record('V0c. no marker exists for session 1 yet', true, (await conn.getAccountInfo(m1)) === null, m1.toBase58());
  await submit('V1. Phantom revokes session 1 (one signature, relayed, session key does not sign)', true, await revokeIxs(PH, s1.key.publicKey), []);
  await measure('revoke');
  const mi = (await conn.getAccountInfo(m1))!;
  metrics.revokeRent = { lamports: mi.lamports, dataBytes: mi.data.length, owner: mi.owner.toBase58() };
  record('V1b. the marker is empty, owned by prime-seat and rent exempt', true, mi.owner.equals(PROG) && mi.data.length === 0 && mi.lamports === (await conn.getMinimumBalanceForRentExemption(0)), JSON.stringify(metrics.revokeRent));
  await act('V2. the revoked session 1 is refused', false, asSession(s1), mv(s1), { want: E2 });
  await act("V3. the same wallet's session 2 keeps working", true, asSession(s2), mv(s2));
  await submit('V3b. revoking session 1 again is refused', false, await revokeIxs(PH, s1.key.publicKey), [], { want: E2 });
  await submit("V4a. MetaMask's key signs a revoke of Phantom's session 2 (data names Phantom as owner)", false, await revokeIxs(PH, s2.key.publicKey, { signAs: MM }), [], { want: E7 });
  await submit("V4b. MetaMask signs a revoke naming Phantom's PDA under its own owner field", false, await revokeIxs(MM, s2.key.publicKey, { pda: pdaOf(PH.key) }), [], { want: E2 });
  await act('V4c. Phantom session 2 still works', true, asSession(s2), mv(s2));
  await submit("V4d. MetaMask revokes the same key under its own PDA (a marker in MetaMask's namespace)", true, await revokeIxs(MM, s2.key.publicKey), []);
  await act("V4e. ...and Phantom's session 2 still works (the marker is per owner)", true, asSession(s2), mv(s2));
  // a vote session is revoked the same way
  const sv = await ses(PH);
  await submit('V4f. Phantom revokes a vote session', true, await revokeIxs(PH, sv.key.publicKey), []);
  await act('V4g. the revoked vote session can no longer run a move either', false, asSession(sv), mv(sv), { want: E2 });
  // pre-emptive revoke of a key that was never granted
  const never = Keypair.generate();
  await submit('V5a. Phantom revokes a key it never granted', true, await revokeIxs(PH, never.publicKey), []);
  const late = await openSession(PH, { key: never });
  await act('V5b. a grant signed for that key afterwards is refused', false, asSession(late), mv(late), { want: E2 });
  // a revoke signed for account A, sent with account B's settings
  const B = new PublicKey(acct.B!.settings!), s3 = await openSession(PH);
  await submit("V6a. a revoke signed for account A's PDA, sent with account B's settings and B's marker", false,
    await revokeIxs(PH, s3.key.publicKey, { acct: B, pda: pdaOf(PH.key), marker: markerOf(PH.key, B, s3.key.publicKey) }), [], { want: E2 });
  record('V6b. no marker was created in account B', true, (await conn.getAccountInfo(markerOf(PH.key, B, s3.key.publicKey))) === null, '');
  await act('V6c. session 3 still works in account A', true, asSession(s3), mv(s3));
  // a stranger pre-funds the marker address
  const s4 = await openSession(PH), m4 = markerOf(PH.key, settings(), s4.key.publicKey);
  {
    const t = new Transaction().add(SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: m4, lamports: 1000 })); t.feePayer = payer.publicKey;
    t.recentBlockhash = (await conn.getLatestBlockhash('confirmed')).blockhash; t.sign(payer);
    const r = await conn.simulateTransaction(t);
    record('V7a. a pre-fund below the rent minimum is refused by the runtime', false, !r.value.err, JSON.stringify(r.value.err), /InsufficientFundsForRent/);
  }
  await submit('V7b. a stranger pre-funds the marker address with 0.001 SOL', true, [SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: m4, lamports: 0.001 * SOL })], []);
  await submit('V7c. the revoke still works', true, await revokeIxs(PH, s4.key.publicKey), []);
  await act('V7d. the revoked session 4 is refused', false, asSession(s4), mv(s4), { want: E2 });
  const s5 = await openSession(PH);
  await act('V8a. a move that passes another marker address', false, asSession(s5), mv(s5), { marker: Keypair.generate().publicKey, want: E2 });
  const canon = bumpOf(PH.key, settings()); let alt = -1;
  for (let b = canon - 1; b >= 0 && alt < 0; b--) { try { PublicKey.createProgramAddressSync([Buffer.from('prime'), PH.key.toBuffer(), settings().toBuffer(), Buffer.from([b])], PROG); alt = b; } catch {} }
  await act(`V8b. a move with non-canonical bump ${alt} (canonical ${canon}) and the canonical PDA account`, false, asSession(s5), mv(s5), { bump: alt, want: E2 });
  await act('V8c. the same session with the canonical bump works', true, asSession(s5), mv(s5));
  await submit('V9. a 72-byte instruction', false, await revokeIxs(PH, Keypair.generate().publicKey, { data: 72 }), []);
  await submit('V9b. a 10-byte instruction', false, await revokeIxs(PH, Keypair.generate().publicKey, { data: 10 }), []);
}

// ── M. Cost of one vote: by an owner, by a session, against a plain key as the settings signer ──
{
  sel = 'P';
  const kA = Keypair.generate(), kB = Keypair.generate();
  const { sig } = await createAccount('P', () => [PH.key, kA.publicKey, kB.publicKey].map((key) => ({ key, permissions: ALL })));
  record('M0. account P: plain keys as settings signers (baseline), threshold 2', true, true, sig);
  const index = await nextIndex(), mkTx = async (creator: PublicKey, i: bigint) => ix.createTransaction({ settingsPda: settings(), transactionIndex: i, creator, rentPayer: payer.publicKey, accountIndex: 0, ephemeralSigners: 0, addressLookupTableAccounts: [],
    transactionMessage: new TransactionMessage({ payerKey: vault(), recentBlockhash: (await conn.getLatestBlockhash()).blockhash, instructions: [sysTransfer(DEST, 0.001)] }) });
  await submit('M1. plain: kA creates, proposes, approves', true, [await mkTx(kA.publicKey, index), ix.createProposal({ settingsPda: settings(), transactionIndex: index, creator: kA.publicKey, rentPayer: payer.publicKey }),
    ix.approveProposal({ settingsPda: settings(), transactionIndex: index, signer: kA.publicKey })], [kA]);
  await measure('create-propose-approve-plain', SA_ID);
  await submit('M2. plain: Phantom approves (the vote measured)', true, [ix.approveProposal({ settingsPda: settings(), transactionIndex: index, signer: PH.key })], [PH]);
  await measure('vote-plain-approve', SA_ID);
  sel = 'A';
  // the same on account A: owner votes, session votes
  const i1 = await decide('M3. MetaMask proposes and approves (open):', asOwner(MM), null, { vault: [sysTransfer(DEST, 0.001)] }, false, { stop: true });
  await measure('create-propose-approve-owner');
  await act('M4. Phantom approves as an owner (the vote measured)', true, asOwner(PH), [approve(i1, asOwner(PH))]);
  await measure('vote-owner-approve');
  const i2 = await decide('M5. MetaMask proposes and approves (open):', asOwner(MM), null, { vault: [sysTransfer(DEST, 0.001)] }, false, { stop: true });
  const sv2 = await ses(PH);
  await act('M6. Phantom vote session approves (the vote measured)', true, asSession(sv2), [approve(i2, asSession(sv2))]);
  await measure('vote-session-approve');
  const sv3 = await ses(FR), i3 = await decide('M7. MetaMask proposes and approves (open):', asOwner(MM), null, { vault: [sysTransfer(DEST, 0.001)] }, false, { stop: true });
  await act('M8. Freighter vote session approves, then Phantom owner executes in one more step', true, asSession(sv3), [approve(i3, asSession(sv3))]);
  await act('M9. Phantom owner executes the approved proposal (measured)', true, asOwner(PH), [(await ix.executeTransaction({ connection: conn, settingsPda: settings(), transactionIndex: i3, signer: pdaOf(PH.key) })).instruction], {});
  await measure('execute-owner');
  // six votes of each kind: a vote's compute units move with the address search inside the Smart Account, so one sample misleads
  const vo: number[] = [], vs: number[] = [], stat = (v: number[]) => { v.sort((x, y) => x - y); return { samples: v, min: v[0], median: (v[2]! + v[3]!) / 2, max: v[5] }; };
  for (let i = 0; i < 6; i++) {
    const pa = await decide(`M12-${i}. MetaMask proposes and approves (open):`, asOwner(MM), null, { vault: [sysTransfer(DEST, 0.001)] }, false, { stop: true });
    await act(`M12-${i}a. Phantom approves as an owner`, true, asOwner(PH), [approve(pa, asOwner(PH))]);
    await measure(`vote-owner-sample-${i}`); vo.push(metrics[`vote-owner-sample-${i}`].totalCu);
    const pb = await decide(`M13-${i}. MetaMask proposes and approves (open):`, asOwner(MM), null, { vault: [sysTransfer(DEST, 0.001)] }, false, { stop: true });
    const sv = await ses(PH);
    await act(`M13-${i}a. Phantom vote session approves`, true, asSession(sv), [approve(pb, asSession(sv))]);
    await measure(`vote-session-sample-${i}`); vs.push(metrics[`vote-session-sample-${i}`].totalCu);
  }
  metrics.voteCu = { owner: { ...stat(vo), bytes: metrics['vote-owner-sample-0'].bytes }, session: { ...stat(vs), bytes: metrics['vote-session-sample-0'].bytes } };
  // the relayer is down: the owner pays its own fee
  await fund(PH.key, 0.05 * SOL);
  const i4 = await decide('M10. MetaMask proposes and approves (open):', asOwner(MM), null, { vault: [sysTransfer(DEST, 0.001)] }, false, { stop: true });
  await act('M11. Phantom votes and pays its own fee (relayer down)', true, asOwner(PH), [approve(i4, asOwner(PH))], { selfPaid: true });
  await measure('vote-owner-approve-selfpaid');
  // relayer down: the owner is fee payer and rent payer of a whole create, propose, approve
  const i5 = await nextIndex(), pPH = pdaOf(PH.key);
  await act('M14. Phantom creates, proposes and approves a vault transaction as fee payer and rent payer (relayer down)', true, asOwner(PH), [
    ix.createTransaction({ settingsPda: settings(), transactionIndex: i5, creator: pPH, rentPayer: PH.key, accountIndex: 0, ephemeralSigners: 0, addressLookupTableAccounts: [],
      transactionMessage: new TransactionMessage({ payerKey: vault(), recentBlockhash: (await conn.getLatestBlockhash()).blockhash, instructions: [sysTransfer(DEST, 0.001)] }) }),
    ix.createProposal({ settingsPda: settings(), transactionIndex: i5, creator: pPH, rentPayer: PH.key }), ix.approveProposal({ settingsPda: settings(), transactionIndex: i5, signer: pPH })], { selfPaid: true });
  await measure('create-propose-approve-owner-selfpaid');
}

// ── R. The 2-of-3 removes a PDA from the policy, or from the settings: the two lists are independent ──
{
  const fr = await openSession(FR), mm = await openSession(MM);
  await act('R0. Freighter session works before', true, asSession(fr), mvIxs(fr, VENUE, 0.00001));
  const P = policyAddr();
  await decide('R1. MetaMask + Phantom update the policy: members MetaMask and Phantom PDAs only:', asOwner(MM), asOwner(PH), { settings: [{ __kind: 'PolicyUpdate', policy: P, policyUpdatePayload: policyPayload(),
    signers: [MM, PH].map((w) => ({ key: pdaOf(w.key), permissions: ALL })), threshold: 1, timeLock: 0, expirationArgs: null }], policies: [P] }, true);
  await act('R2. the live Freighter session after removal from the policy', false, asSession(fr), mvIxs(fr, VENUE, 0.00001), { want: NAS });
  await act('R3. MetaMask session still works', true, asSession(mm), mvIxs(mm, VENUE, 0.00001));
  await decide("R4. Freighter's seat still votes: MetaMask + Freighter decide:", asOwner(MM), asOwner(FR), { vault: [sysTransfer(DEST, 0.001)] }, true);
  const mmSes = await ses(MM);
  await decide('R5. Freighter + Phantom remove MetaMask from the settings:', asOwner(FR), asOwner(PH), { settings: [{ __kind: 'RemoveSigner', oldSigner: pdaOf(MM.key) }] as any }, true);
  const probe = approveAt(settings(), BigInt(st.approvedIdx), pdaOf(MM.key));
  await act("R6. MetaMask's owner vote after removal from the settings", false, asOwner(MM), [probe], { want: NAS });
  await act("R7. MetaMask's vote session after removal from the settings", false, asSession(mmSes), [probe], { want: NAS });
  await act('R8. MetaMask session still makes policy moves (still a policy member)', true, asSession(mm), mvIxs(mm, VENUE, 0.00001));
}

// ── R2. One settings transaction removes an owner from the settings and from the policy ────────
{
  sel = 'B';
  const P = policyAddr();
  await decide('R9. MetaMask + Phantom remove Freighter from the settings and the policy in one settings transaction:', asOwner(MM), asOwner(PH), { settings: [{ __kind: 'RemoveSigner', oldSigner: pdaOf(FR.key) },
    { __kind: 'PolicyUpdate', policy: P, policyUpdatePayload: policyPayload(), signers: [MM, PH].map((w) => ({ key: pdaOf(w.key), permissions: ALL })), threshold: 1, timeLock: 0, expirationArgs: null }] as any, policies: [P] }, true);
  const set = (await getSettings()).signers.map((x: any) => x.key.toBase58()).sort().join(), pol = (await sa.accounts.Policy.fromAccountAddress(conn, P)).signers.map((x: any) => x.key.toBase58()).sort().join();
  const want = [MM, PH].map((w) => pdaOf(w.key).toBase58()).sort().join();
  record('R9b. the settings signers and the policy signers are now the MetaMask and Phantom PDAs only', true, set === want && pol === want, set === want ? 'settings ok' : 'settings differ');
  sel = 'A';
}

// ── Z. Totals, spend, hash ─────────────────────────────────────────────────────────────────────
{
  const spent = startBalance - (await conn.getBalance(payer.publicKey));
  metrics.relayerSpend = { spentLamports: spent, accounts: 7, vaultFundingLamports: 7 * VAULT_SOL * SOL };
  console.log('METRIC relayerSpend', JSON.stringify(metrics.relayerSpend));
  const so = readFileSync(process.env.PSS_SO ?? `/home/ubuntu/work/seat-spike/solana/prime-seat${VARIANT === 'ng' ? '-ng' : ''}/target/deploy/prime_seat${VARIANT === 'ng' ? '_ng' : ''}.so`);
  const shaSo = createHash('sha256').update(so).digest('hex');
  for (const [n, id] of [['A', PROG], ['B', PROG_B]] as const) {
    const p = (await conn.getAccountInfo(id))!;
    const code = p.owner.toBase58() === 'BPFLoaderUpgradeab1e11111111111111111111111' ? (await conn.getAccountInfo(new PublicKey(p.data.subarray(4, 36))))!.data.subarray(45) : p.data;
    const eq = Buffer.compare(code.subarray(0, so.length), so) === 0 && code.subarray(so.length).every((x) => x === 0);
    record(`Z${n}. on-chain code of program ${n} (${id.toBase58().slice(0, 8)}…) equals the .so (sha256 ${shaSo.slice(0, 16)}…, ${so.length} bytes)`, true, eq, `${code.length} bytes on chain`);
    st[`onchainSha${n}`] = createHash('sha256').update(code.subarray(0, so.length)).digest('hex');
  }
  st.soSha256 = shaSo; st.soBytes = so.length;
}
console.log(`NEAR MPC signatures: ${stats.calls}, average ${(stats.ms / Math.max(1, stats.calls) / 1000).toFixed(1)}s`);
st.mpc = stats; save();
console.log(`${results.filter((r) => r.pass).length}/${results.length} passed`);
for (const r of results.filter((r) => !r.pass)) console.log('FAIL', r.name, r.detail);
process.exit(0);
