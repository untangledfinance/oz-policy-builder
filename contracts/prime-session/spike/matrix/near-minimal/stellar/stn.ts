// Stellar matrix (testnet), NEAR-routed: an OZ smart account with OctoGate rules.
//   rule 0 (2-of-3, weighted_threshold 1/1/1 >= 2): Delegated G accounts only (the seats, MPC path `prime:stellar`):
//     Freighter's own key; MetaMask's and Phantom's NEAR MPC ed25519 keys (eth-implicit / our text signer contract).
//   sessions: one prime-session per wallet is the only signer of that wallet's session rule (XLM to VENUE only) and
//     is in no other rule. Its owner is a Stellar account: Freighter's own G account (seat and owner), or, for MetaMask
//     and Phantom, a G account derived by NEAR MPC under `prime:stellar-session`, a path no seat vote uses.
//     The owner authorizes `grant(key, until)` with an ordinary Soroban authorization entry (Freighter signAuthEntry;
//     NEAR MPC signs the entry hash for MetaMask / Phantom); the session key then signs each move. Revoke is
//     grant(key, 0), final: the contract refuses any later grant of a revoked key. Fee: the relayer, or the session
//     key's own G account (grant and move alike).
//   locks: every MPC-derived G account (the MetaMask and Phantom seats, their session owners) gets one SetOptions at
//     setup: master weight 1, thresholds low 1 / medium 1 / high 2. Soroban authorization needs the medium threshold,
//     so votes and grants work; SetOptions on signers and AccountMerge need the high threshold, which one key never reaches.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { Sdk, XLM, PASS, friendbot, invokeAs, keypair, localSigner, accountSig, signaturePayload, nonce, log, server, submit } from './stellar.ts';
const { edKey, edSign, stats } = await import('./nearsig.ts');
const PS = '/home/ubuntu/git/github.com/untangledfinance/oz-policy-builder/packages/policy-synth/src';
const { encodePredicate } = await import(`${PS}/predicate/encode.ts`);
const { buildAddContextRuleArgs } = await import(`${PS}/install/build-add-context-rule.ts`);
const S_ = Sdk.xdr.ScVal, xdr = Sdk.xdr;
const WASM = '/home/ubuntu/git/github.com/untangledfinance/oz-policy-builder/contracts/prime-session/target/wasm32v1-none/release/prime_session.wasm';
const ACCOUNT_WASM_HASH = '91a2cd56ba1a75d78eeb8ddc5d1841c5d439b7726a140bc84c850f73396298a9';
const WEIGHTED = 'CCTNRFZCL45GTJICA3Z2KFQO3VEGBHGCVBLHQ3GLJKAGACQIJMYJS7T2';
const INTERPRETER = 'CCBHVZ6HGGV7C4SNHCZ3S5665Z2WEMHTMBAEPO4XW6PKON464BEBANU5';
const FILE = process.env.STN_STATE ?? 'state-stn.json';
const st: Record<string, any> = existsSync(FILE) ? JSON.parse(readFileSync(FILE, 'utf8')) : {};
const save = (p: Record<string, unknown>) => { Object.assign(st, p); writeFileSync(FILE, JSON.stringify(st, null, 1)); };
const fee = keypair('secrets/fee-payer.json'); // the relayer
const FREIGHTER_FILE = '/home/ubuntu/work/near-wallet-spike/secrets/freighter-b.json';
const kF = Sdk.Keypair.fromSecret(JSON.parse(readFileSync(FREIGHTER_FILE, 'utf8')).secret);
const sym = (s: string) => S_.scvSymbol(s), u32 = (n: number) => S_.scvU32(n), vec = (x: Sdk.xdr.ScVal[]) => S_.scvVec(x);
const addr = (a: string) => new Sdk.Address(a).toScVal();
const delegated = (a: string) => vec([sym('Delegated'), addr(a)]);
const map = (e: [Sdk.xdr.ScVal, Sdk.xdr.ScVal][]) => S_.scvMap(e.map(([k, v]) => new Sdk.xdr.ScMapEntry({ key: k, val: v }))
  .sort((l, r) => (l.key().switch().name === 'scvSymbol' && r.key().switch().name === 'scvSymbol') ? Buffer.compare(Buffer.from(l.key().sym()), Buffer.from(r.key().sym())) : Buffer.compare(l.key().toXDR(), r.key().toXDR())));
const short = (e?: string) => [...new Set((e ?? '').match(/Error\([A-Za-z]+, #?\w+\)/g) ?? [])].join(' ') || (e ?? '').slice(0, 200);
const horizon = new Sdk.Horizon.Server('https://horizon-testnet.stellar.org');
const now = async () => (await server.getLatestLedger()).sequence;
const untilLedger = async (n: number) => { while ((await now()) <= n) await new Promise((r) => setTimeout(r, 2000)); };

// ── Wallets ────────────────────────────────────────────────────────────────────────────────────
type Wallet = 'MetaMask' | 'Freighter' | 'Phantom';
const PATH = 'prime:stellar';                 // seat votes (rule 0)
const SESSION_PATH = 'prime:stellar-session'; // session-grant owners of the NEAR-routed wallets
type W = { name: string; pub: Buffer; G: string; signRaw: (m: Buffer) => Promise<Buffer>; signEntry?: (preimageXdr: Buffer) => Promise<Buffer> };
const viaNear = async (name: 'MetaMask' | 'Phantom', path = PATH): Promise<W> => {
  const pub = Buffer.from(await edKey(name, path));
  return { name, pub, G: Sdk.StrKey.encodeEd25519PublicKey(pub), signRaw: async (m) => Buffer.from(await edSign(name, path, m)) };
};
const local = (name: string, kp: Sdk.Keypair): W => ({ name, pub: kp.rawPublicKey(), G: kp.publicKey(), signRaw: async (m) => kp.sign(m) });
// Freighter's signAuthEntry signs sha256(preimage) with the account key, which is what signaturePayload() returns.
const FR = local('Freighter', kF);
const MM = await viaNear('MetaMask'), PH = await viaNear('Phantom');
const MM_S = await viaNear('MetaMask', SESSION_PATH), PH_S = await viaNear('Phantom', SESSION_PATH);
const PH_OTHER_PATH = await viaNear('Phantom', 'prime:stellar-other');
// The real Freighter extension (5.49) with its own test account; it signs authorization entries through signAuthEntry
// (bridge: /home/ubuntu/work/freighter-ext/explore-auth.mjs).
const BRIDGE = '/home/ubuntu/work/freighter-ext/bridge';
const RF_G: string = JSON.parse(readFileSync('/home/ubuntu/work/freighter-ext/secrets/freighter-real.json', 'utf8')).public;
async function realFreighterAuth(preimage: Buffer): Promise<Buffer> {
  const n = Date.now(), sig = `${BRIDGE}/auth-${n}.sig`;
  writeFileSync(`${BRIDGE}/auth-${n}.xdr`, preimage.toString('base64'));
  for (let i = 0; i < 600 && !existsSync(sig) && !existsSync(`${sig}.err`); i++) await new Promise((r) => setTimeout(r, 300));
  if (!existsSync(sig)) throw new Error(`no Freighter signature for auth-${n}: ${existsSync(`${sig}.err`) ? readFileSync(`${sig}.err`, 'utf8') : 'timeout'}`);
  await new Promise((r) => setTimeout(r, 200));
  const r = JSON.parse(readFileSync(sig, 'utf8'));
  if (r.signer !== RF_G) throw new Error(`Freighter signed as ${r.signer}`);
  log(`   REAL Freighter signed auth-${n} (signAuthEntry, ${preimage.length} bytes of preimage)`);
  return Buffer.from(r.sig, 'base64');
}
const RF: W = { name: 'FreighterReal', pub: Sdk.StrKey.decodeEd25519PublicKey(RF_G), G: RF_G, signRaw: async () => { throw new Error('the real Freighter signs preimages only'); }, signEntry: realFreighterAuth };
const OWNER: Record<string, W> = { MetaMask: MM_S, Freighter: FR, Phantom: PH_S, FreighterReal: RF };
const seat = (w: W, signAs: W = w) => ({ address: w.G, signNested: async (p: Buffer) => accountSig(signAs.pub, await signAs.signRaw(p)) });
const S_OF: Record<string, string> = { MetaMask: 'S_mm', Freighter: 'S_fr', Phantom: 'S_ph', FreighterReal: 'S_rf' };
const Sof = (w: W) => st[S_OF[w.name]] as string;

const results: Record<string, any> = { ...(st.results ?? {}) };
function record(name: string, expectOk: boolean, r: any, payer: Sdk.Keypair, kind: string) {
  const pass = r.ok === expectOk;
  results[name] = { pass, ok: r.ok, hash: r.hash, error: r.ok ? undefined : short(r.error), kind, payer: payer.publicKey(), selfPaid: payer !== fee };
  log(pass ? 'PASS' : 'FAIL', name, r.ok ? `ok ${r.ms} ms ${r.hash}${payer === fee ? '' : ' (fee paid by the session key)'}` : `refused: ${short(r.error)}`);
  save({ results });
}
async function run(name: string, expectOk: boolean, op: Sdk.xdr.Operation, ruleIds: number[], signers: any[], feePayer = fee, kind = 'tx') {
  let r: any;
  try { r = await invokeAs({ feePayer, op, account: st.prime, ruleIds, signers }); } catch (e: any) { r = { ok: false, error: String(e?.message ?? e).slice(0, 300), ms: 0 }; }
  record(name, expectOk, r, feePayer, kind); return r;
}
function check(name: string, ok: boolean, detail: string) { results[name] = { pass: ok, detail }; log(ok ? 'PASS' : 'FAIL', name, detail); save({ results }); }
const call = (fn: string, ...a: Sdk.xdr.ScVal[]) => new Sdk.Contract(st.prime).call(fn, ...a);
const sim = async (op: Sdk.xdr.Operation) => (await server.simulateTransaction(new Sdk.TransactionBuilder(await server.getAccount(fee.publicKey()), { fee: '100', networkPassphrase: Sdk.Networks.TESTNET }).addOperation(op).setTimeout(30).build())) as any;
async function ruleId(name: string) { const n = Number(Sdk.scValToNative((await sim(call('get_context_rules_count'))).result.retval)); for (let i = 0; i < n + 10; i++) { const s = await sim(call('get_context_rule', u32(i))); if (!s.error && (Sdk.scValToNative(s.result.retval) as any).name === name) return i; } return -1; }
const lit = (a: string) => ({ kind: 'literal_address', value: a });
function xlmRule(name: string, S: string) {
  const p: any = encodePredicate({ op: 'and', children: [
    { op: 'eq', left: { kind: 'call_fn' }, right: { kind: 'literal_symbol', value: 'transfer' } },
    { op: 'eq', left: { kind: 'call_arg', index: 0 }, right: lit(st.prime) },
    { op: 'eq', left: { kind: 'call_arg', index: 1 }, right: lit(st.venue) } ] });
  return buildAddContextRuleArgs({ contextRuleType: { kind: 'call_contract', contract: XLM }, name, validUntilLedger: null, signers: [{ kind: 'delegated', address: S }], policies: [] },
    { signers: [{ kind: 'delegated', address: S }], policies: [{ kind: 'interpreter', interpreterAddress: INTERPRETER, predicateBlobBase64: p.encodedPredicate }], installNonce: 1, encodedPredicate: p.encodedPredicate, predicateHash: p.predicateHash })
    .map((v: any) => Sdk.xdr.ScVal.fromXDR(v.toXDR('base64'), 'base64'));
}
const xfer = (to: string, stroops: bigint) => new Sdk.Contract(XLM).call('transfer', addr(st.prime), addr(to), Sdk.nativeToScVal(stroops, { type: 'i128' }));
const tmpRule = (name: string) => call('add_context_rule', vec([sym('CallContract'), addr(XLM)]), S_.scvString(name), S_.scvVoid(), vec([delegated(FR.G)]), S_.scvMap([]));
const xlmBal = async (a: string) => BigInt(Sdk.scValToNative((await sim(new Sdk.Contract(XLM).call('balance', addr(a)))).result.retval));

// ── Grants: owner.require_auth() on prime-session.grant(key, until) ────────────────────────────
type Entry = Sdk.xdr.SorobanAuthorizationEntry;
const grantArgs = (S: string, key: Buffer, until: number) => new xdr.InvokeContractArgs({ contractAddress: new Sdk.Address(S).toScAddress(), functionName: 'grant', args: [S_.scvBytes(key), u32(until)] });
/** The owner's signed authorization entry for grant(key, until) on contract S. `signAs` signs in the owner's place. */
async function authorize(owner: W, S: string, key: Buffer, until: number, o: { signAs?: W; exp?: number } = {}): Promise<Entry> {
  const n = new xdr.Int64(nonce()), exp = o.exp ?? (await now()) + 60, signer = o.signAs ?? owner;
  const root = new xdr.SorobanAuthorizedInvocation({ function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(grantArgs(S, key, until)), subInvocations: [] });
  const pre = xdr.HashIdPreimage.envelopeTypeSorobanAuthorization(new xdr.HashIdPreimageSorobanAuthorization({ networkId: Sdk.hash(Buffer.from(PASS)), nonce: n, signatureExpirationLedger: exp, invocation: root })).toXDR();
  const sig = signer.signEntry ? await signer.signEntry(pre) : await signer.signRaw(signaturePayload(n, exp, root));
  if (signer.signEntry && !Sdk.Keypair.fromPublicKey(signer.G).verify(signaturePayload(n, exp, root), sig)) throw new Error('the wallet signature does not verify against the entry');
  return new xdr.SorobanAuthorizationEntry({ credentials: xdr.SorobanCredentials.sorobanCredentialsAddress(new xdr.SorobanAddressCredentials({
    address: new Sdk.Address(owner.G).toScAddress(), nonce: n, signatureExpirationLedger: exp, signature: accountSig(signer.pub, sig) })), rootInvocation: root });
}
/** Sends grant(key, until) on S with the given entries; `payer` is the transaction source (relayer or session key). */
async function sendGrant(payer: Sdk.Keypair, S: string, key: Buffer, until: number, entries: Entry[]): Promise<any> {
  const t0 = Date.now();
  const fn = new Sdk.Contract(S).call('grant', S_.scvBytes(key), u32(until));
  const op = Sdk.Operation.invokeHostFunction({ func: fn.body().invokeHostFunctionOp().hostFunction(), auth: entries });
  const tx = new Sdk.TransactionBuilder(await server.getAccount(payer.publicKey()), { fee: '2000000', networkPassphrase: PASS }).addOperation(op).setTimeout(120).build();
  const s = await server.simulateTransaction(tx);
  if (Sdk.rpc.Api.isSimulationError(s)) return { ok: false, error: s.error.slice(0, 6000), ms: Date.now() - t0 };
  const ready = Sdk.rpc.assembleTransaction(tx, s).build(); ready.sign(payer);
  const sent = await server.sendTransaction(ready);
  if (sent.status === 'ERROR') return { ok: false, error: `send: ${JSON.stringify(sent.errorResult ?? sent).slice(0, 300)}`, ms: Date.now() - t0 };
  for (let i = 0; i < 40; i++) {
    const r = await server.getTransaction(sent.hash);
    if (r.status !== 'NOT_FOUND') return { ok: r.status === 'SUCCESS', hash: sent.hash, error: r.status === 'SUCCESS' ? undefined : `${r.status} ${JSON.stringify((r as any).resultXdr?.toXDR?.('base64') ?? '').slice(0, 120)}`, ms: Date.now() - t0 };
    await new Promise((res) => setTimeout(res, 1000));
  }
  return { ok: false, hash: sent.hash, error: 'timeout', ms: Date.now() - t0 };
}
type G = { signedS?: string; signedUntil?: number; signAs?: W; exp?: number; payer?: Sdk.Keypair; entries?: Entry[] };
/** One graded grant: the entry is signed for (signedS, signedUntil) and sent as grant(key, until) on S. */
async function runGrant(name: string, expectOk: boolean, owner: W, S: string, key: Buffer, until: number, o: G = {}) {
  const entries = o.entries ?? [await authorize(owner, o.signedS ?? S, key, o.signedUntil ?? until, { signAs: o.signAs, exp: o.exp })];
  const payer = o.payer ?? fee;
  const r = await sendGrant(payer, S, key, until, entries);
  record(name, expectOk, r, payer, until === 0 ? 'revoke' : 'grant'); return { ...r, entries };
}
type Session = { kp: Sdk.Keypair; until: number; S: string; hash?: string; signer: { address: string; signNested: (p: Buffer) => Promise<Sdk.xdr.ScVal> } };
const proofSigner = (S: string, kp: Sdk.Keypair) => ({ address: S, signNested: async (p: Buffer) => vec([S_.scvBytes(kp.rawPublicKey()), S_.scvBytes(kp.sign(p))]) });
/** A live session: the wallet's owner authorizes grant(key, until); returns the session key and its proof signer. */
async function session(w: W, name: string, o: { ledgers?: number; kp?: Sdk.Keypair; payer?: Sdk.Keypair } = {}): Promise<Session> {
  const kp = o.kp ?? Sdk.Keypair.random(), S = Sof(w), until = (await now()) + (o.ledgers ?? 720);
  const g = await runGrant(name, true, OWNER[w.name], S, kp.rawPublicKey(), until, { payer: o.payer });
  return { kp, until, S, hash: g.hash, signer: proofSigner(S, kp) };
}
const mv = (name: string, expectOk: boolean, to: string, rule: number, s: Session, payer = fee) => run(name, expectOk, xfer(to, 10_000_000n), [rule], [s.signer], payer, 'move');
/** The stored grant entry (temporary storage) of a session key: its value and the ledger it lives to. */
async function stored(S: string, key: Buffer) {
  const k = xdr.LedgerKey.contractData(new xdr.LedgerKeyContractData({ contract: new Sdk.Address(S).toScAddress(), key: S_.scvBytes(key), durability: xdr.ContractDataDurability.temporary() }));
  const e = (await server.getLedgerEntries(k)).entries[0];
  return e ? { until: e.val.contractData().val().u32(), live: e.liveUntilLedgerSeq! } : undefined;
}
/** A grant authorization is valid until its signature-expiry ledger: the same construction works at once and is refused after it. */
async function expiredAuthorization() {
  const k1 = Sdk.Keypair.random(), k2 = Sdk.Keypair.random(), exp = (await now()) + 4, until = (await now()) + 720;
  const e1 = await authorize(FR, st.S_fr, k1.rawPublicKey(), until, { exp }), e2 = await authorize(FR, st.S_fr, k2.rawPublicKey(), until, { exp });
  await runGrant('Q14a. control: a grant authorization submitted before its signature-expiry ledger', true, FR, st.S_fr, k1.rawPublicKey(), until, { entries: [e1] });
  await untilLedger(exp + 1);
  await runGrant('Q14. the same authorization for another key, submitted after its signature-expiry ledger', false, FR, st.S_fr, k2.rawPublicKey(), until, { entries: [e2] });
}
const part = process.argv[2];

/** One classic transaction from the wallet's own G account, signed by its key (NEAR MPC for MetaMask and Phantom), sent through Horizon. */
async function classic(w: W, op: Sdk.xdr.Operation): Promise<{ ok: boolean; hash?: string; codes?: string }> {
  const tx = new Sdk.TransactionBuilder(await horizon.loadAccount(w.G), { fee: '1000', networkPassphrase: PASS }).addOperation(op).setTimeout(120).build();
  tx.addSignature(w.G, (await w.signRaw(tx.hash())).toString('base64'));
  try { const r = await horizon.submitTransaction(tx); return { ok: r.successful, hash: r.hash }; }
  catch (e: any) { const c = e?.response?.data?.extras?.result_codes; return { ok: false, codes: c ? JSON.stringify(c) : String(e?.message ?? e).slice(0, 200) }; }
}
const acctState = async (g: string) => { const a: any = await horizon.loadAccount(g); return { signers: a.signers.map((x: any) => `${x.key}:${x.weight}`).join(','), thr: `${a.thresholds.low_threshold}/${a.thresholds.med_threshold}/${a.thresholds.high_threshold}` }; };
/** Freezes the signer list of an MPC-derived G account and proves it: the lock itself, a control, and the two refusals. */
async function lockAccount(label: string, w: W) {
  let s = await acctState(w.G);
  if (s.thr !== '1/1/2' || s.signers !== `${w.G}:1`) { const r = await classic(w, Sdk.Operation.setOptions({ masterWeight: 1, lowThreshold: 1, medThreshold: 1, highThreshold: 2 })); log(`   lock ${label} ${w.G}`, r.ok ? r.hash : r.codes); }
  s = await acctState(w.G);
  check(`L1-${label}. master weight 1, thresholds low 1 / medium 1 / high 2, the account's own key is the only signer`, s.thr === '1/1/2' && s.signers === `${w.G}:1`, `${w.G} thresholds ${s.thr} signers ${s.signers}`);
  const c = await classic(w, Sdk.Operation.setOptions({ homeDomain: 'prime.example' }));
  check(`L2-${label}. control: a medium-threshold SetOptions (home domain) signed by the key is accepted`, c.ok, c.hash ?? c.codes ?? '');
  const add = Sdk.Keypair.random();
  const a = await classic(w, Sdk.Operation.setOptions({ signer: { ed25519PublicKey: add.publicKey(), weight: 1 } }));
  check(`L3-${label}. SetOptions that adds a signer, signed by the key, is refused`, !a.ok && /op_bad_auth/.test(a.codes ?? ''), a.codes ?? 'accepted');
  const m = a.ok ? { ok: true, codes: 'skipped: the signer was added' } : await classic(w, Sdk.Operation.accountMerge({ destination: fee.publicKey() }));
  check(`L4-${label}. AccountMerge into the relayer, signed by the key, is refused`, !m.ok && /op_bad_auth/.test(m.codes ?? ''), m.codes ?? 'accepted');
  s = await acctState(w.G);
  check(`L5-${label}. after both refusals the signer list and thresholds are unchanged and the account exists`, s.thr === '1/1/2' && s.signers === `${w.G}:1`, `${s.thr} ${s.signers}`);
}

if (part === 'setup') {
  await friendbot(fee.publicKey()); await friendbot(FR.G); await friendbot(MM.G); await friendbot(PH.G); await friendbot(MM_S.G); await friendbot(PH_S.G);
  log('seats', { MetaMask: MM.G, Freighter: FR.G, Phantom: PH.G });
  log('session owners', { MetaMask: MM_S.G, Freighter: FR.G, Phantom: PH_S.G });
  if (!st.venue) { const v = Sdk.Keypair.random(); await friendbot(v.publicKey()); const o = Sdk.Keypair.random(); await friendbot(o.publicKey()); save({ venue: v.publicKey(), other: o.publicKey() }); }
  if (!st.wasm) {
    const { ret, hash } = await submit(fee, Sdk.Operation.uploadContractWasm({ wasm: readFileSync(WASM) }));
    save({ wasm: Buffer.from(ret!.bytes()).toString('hex'), wasmTx: hash }); log('prime-session wasm', st.wasm, hash);
  }
  for (const w of [MM_S, FR, PH_S]) {
    const k = S_OF[w === MM_S ? 'MetaMask' : w === PH_S ? 'Phantom' : 'Freighter'];
    if (st[k]) continue;
    const { ret, hash } = await submit(fee, Sdk.Operation.createCustomContract({ address: Sdk.Address.fromString(fee.publicKey()), wasmHash: Buffer.from(st.wasm, 'hex'), constructorArgs: [addr(w.G)], salt: Buffer.from(Sdk.Keypair.random().rawPublicKey()) }));
    save({ [k]: Sdk.Address.fromScVal(ret!).toString(), [`${k}Tx`]: hash }); log(k, st[k], hash);
  }
  await friendbot(RF.G);
  if (!st.S_rf) {
    const { ret, hash } = await submit(fee, Sdk.Operation.createCustomContract({ address: Sdk.Address.fromString(fee.publicKey()), wasmHash: Buffer.from(st.wasm, 'hex'), constructorArgs: [addr(RF.G)], salt: Buffer.from(Sdk.Keypair.random().rawPublicKey()) }));
    save({ S_rf: Sdk.Address.fromScVal(ret!).toString(), S_rfTx: hash }); log('S_rf', st.S_rf, hash);
  }
  save({ G_mm: MM.G, G_fr: FR.G, G_ph: PH.G, G_mm_session: MM_S.G, G_ph_session: PH_S.G, G_rf: RF.G });
  if (!st.prime) {
    const weights = map([[sym('signer_weights'), map([[delegated(MM.G), u32(1)], [delegated(FR.G), u32(1)], [delegated(PH.G), u32(1)]])], [sym('threshold'), u32(2)]]);
    const { ret, hash } = await submit(fee, Sdk.Operation.createCustomContract({ address: Sdk.Address.fromString(fee.publicKey()), wasmHash: Buffer.from(ACCOUNT_WASM_HASH, 'hex'),
      constructorArgs: [vec([MM.G, FR.G, PH.G].map(delegated)), map([[addr(WEIGHTED), weights]])], salt: Buffer.from(Sdk.Keypair.random().rawPublicKey()) }));
    save({ prime: Sdk.Address.fromScVal(ret!).toString(), primeTx: hash }); log('Prime Account', st.prime, hash);
    const f = await submit(fee, new Sdk.Contract(XLM).call('transfer', addr(fee.publicKey()), addr(st.prime), Sdk.nativeToScVal(300_000_000n, { type: 'i128' })));
    log('funded 30 XLM', f.hash);
  }
  const r0: any = Sdk.scValToNative((await sim(call('get_context_rule', u32(0)))).result.retval);
  const signers = JSON.stringify(r0.signers, (_, v) => (typeof v === 'bigint' ? v.toString() : v));
  check('P0. rule 0 signers are exactly the three wallet G keys (no prime-session)', [MM.G, FR.G, PH.G].every((g) => signers.includes(g)) && ![st.S_mm, st.S_fr, st.S_ph].some((s) => signers.includes(s)) && r0.signers.length === 3, signers.slice(0, 300));
  check('P1. the session-owner keys of MetaMask and Phantom are not their seat keys and are not on rule 0', MM_S.G !== MM.G && PH_S.G !== PH.G && !signers.includes(MM_S.G) && !signers.includes(PH_S.G), `MetaMask ${MM_S.G}, Phantom ${PH_S.G}`);
  for (const [label, w] of [['seat-MetaMask', MM], ['seat-Phantom', PH], ['owner-MetaMask', MM_S], ['owner-Phantom', PH_S]] as const) await lockAccount(label, w);
}
if (part === 'seats') {
  for (const w of [MM, FR, PH]) await run(`Y1-${w.name}. ${w.name} alone adds a rule`, false, tmpRule(`y1${w.name}`), [0], [seat(w)]);
  await run('Y2. MetaMask (NEAR) + Freighter add a rule', true, tmpRule('y_mf'), [0], [seat(MM), seat(FR)]);
  await run('Y3. Freighter + Phantom (NEAR) remove it', true, call('remove_context_rule', u32(await ruleId('y_mf'))), [0], [seat(FR), seat(PH)]);
  await run('Y4. Phantom (NEAR) + MetaMask (NEAR) add a rule', true, tmpRule('y_pm'), [0], [seat(PH), seat(MM)]);
  await run('Y5. MetaMask + Phantom remove it', true, call('remove_context_rule', u32(await ruleId('y_pm'))), [0], [seat(MM), seat(PH)]);
  const stranger = Sdk.Keypair.random(); await friendbot(stranger.publicKey());
  await run('Y6. outsider + Freighter', false, tmpRule('y6'), [0], [localSigner(stranger), seat(FR)]);
  await run("Y7. MetaMask's seat signed by Phantom's MPC key + Freighter", false, tmpRule('y7'), [0], [seat(MM, PH), seat(FR)]);
  await run("Y8. Phantom's seat signed by its MPC key under another path + Freighter", false, tmpRule('y8'), [0], [seat(PH, PH_OTHER_PATH), seat(FR)]);
  await run("Y9. MetaMask's seat vote signed under the session path + Freighter", false, tmpRule('y9'), [0], [seat(MM, MM_S), seat(FR)]);
  await run("Y10. Phantom's seat vote signed under the session path + Freighter", false, tmpRule('y10'), [0], [seat(PH, PH_S), seat(FR)]);
  await run('Y11. the two session-owner accounts (MetaMask, Phantom) as the two votes on rule 0', false, tmpRule('y11'), [0], [seat(MM_S), seat(PH_S)]);
}
if (part === 'rules') {
  for (const [name, S] of [['xlm_mm', st.S_mm], ['xlm_fr', st.S_fr], ['xlm_ph', st.S_ph], ['xlm_rf', st.S_rf]] as const)
    if ((await ruleId(name)) < 0) await run(`R-${name}. MetaMask + Freighter install ${name}: XLM to VENUE only, signer: that wallet's prime-session`, true, call('add_context_rule', ...xlmRule(name, S)), [0], [seat(MM), seat(FR)]);
  save({ r_mm: await ruleId('xlm_mm'), r_fr: await ruleId('xlm_fr'), r_ph: await ruleId('xlm_ph'), r_rf: await ruleId('xlm_rf') });
  log('rules', st.r_mm, st.r_fr, st.r_ph, st.r_rf);
}
if (part === 'separation') {
  // A session can never vote as a seat.
  const ph = await session(PH, 'N0a. Phantom grant (setup for N1-N5)'), mm = await session(MM, 'N0b. MetaMask grant (setup for N2)');
  await run("N1. Phantom's prime-session + Freighter on rule 0", false, tmpRule('n1'), [0], [ph.signer, seat(FR)]);
  await run("N2. MetaMask's and Phantom's prime-sessions on rule 0", false, tmpRule('n2'), [0], [mm.signer, ph.signer]);
  await run("N3. Phantom session claims its session rule for an account-admin call", false, tmpRule('n3'), [st.r_ph], [ph.signer]);
  const kpG = ph.kp; await friendbot(kpG.publicKey());
  await run("N4. the session key's own G account + Freighter on rule 0", false, tmpRule('n4'), [0], [localSigner(kpG), seat(FR)]);
  await run("N5. Phantom session removes rule 0 through its session rule", false, call('remove_context_rule', u32(0)), [st.r_ph], [ph.signer]);
}
if (part === 'sessions') {
  const ids: Record<string, number> = { MetaMask: st.r_mm, Freighter: st.r_fr, Phantom: st.r_ph };
  for (const w of [MM, FR, PH]) {
    const n = w.name, rule = ids[n]!;
    const s = await session(w, `Q-${n}0. ${n} grant: one ${n === 'Freighter' ? 'signAuthEntry' : 'NEAR MPC'} authorization, relayer pays`);
    log(`${n}: session key ${s.kp.publicKey()} until ledger ${s.until}`);
    const b = await xlmBal(st.venue);
    await mv(`Q-${n}1. relayer pays: 1 XLM to VENUE`, true, st.venue, rule, s);
    const kp2 = Sdk.Keypair.random(); await friendbot(kp2.publicKey());
    const s2 = await session(w, `Q-${n}2a. ${n} grant, relayer down: the session key's own account is the transaction source`, { kp: kp2, payer: kp2 });
    await mv(`Q-${n}2. relayer down: the session key's own account pays the fee, 1 XLM to VENUE`, true, st.venue, rule, s2, kp2);
    check(`Q-${n}3. VENUE received exactly 2 XLM`, (await xlmBal(st.venue)) - b === 20_000_000n, `${(await xlmBal(st.venue)) - b} stroops`);
    const broke = await session(w, `Q-${n}4a. ${n} grant for a session key that has no account`);
    await mv(`Q-${n}4. relayer down and the session key has no account`, false, st.venue, rule, broke, broke.kp);
    await mv(`Q-${n}5. 1 XLM elsewhere`, false, st.other, rule, s);
    await mv(`Q-${n}6. on another wallet's session rule`, false, st.venue, w === PH ? st.r_mm : st.r_ph, s);
  }
  const ngk = Sdk.Keypair.random();
  await mv('Q-never. a session key that was never granted', false, st.venue, st.r_fr, { kp: ngk, until: 0, S: st.S_fr, signer: proofSigner(st.S_fr, ngk) });
  const ph7 = Sdk.Keypair.random(), u7 = (await now()) + 720;
  await runGrant('Q7. Phantom authorized one valid-until; the relayer submits a later one', false, PH_S, st.S_ph, ph7.rawPublicKey(), u7 + 100, { signedUntil: u7 });
  await mv('Q7b. the key from Q7 cannot move', false, st.venue, st.r_ph, { kp: ph7, until: 0, S: st.S_ph, signer: proofSigner(st.S_ph, ph7) });
  const mm8 = Sdk.Keypair.random();
  await runGrant('Q8. MetaMask grant 10 ledgers beyond 7 days is refused at grant time', false, MM_S, st.S_mm, mm8.rawPublicKey(), (await now()) + 120_960 + 10);
  await mv('Q8b. the key from Q8 cannot move', false, st.venue, st.r_mm, { kp: mm8, until: 0, S: st.S_mm, signer: proofSigner(st.S_mm, mm8) });
  // revoke = grant(key, 0): one owner authorization (MetaMask through NEAR, Freighter natively)
  for (const w of [MM, FR]) {
    const n = w.name, rule = ids[n]!;
    const s = await session(w, `Q9-${n}0. ${n} grant (first session)`), s2 = await session(w, `Q9-${n}00. ${n} grant (second session)`);
    await mv(`Q9-${n}a. session before revoke`, true, st.venue, rule, s);
    await runGrant(`Q9-${n}b. ${n} revokes it: grant(key, 0), one authorization, relayer pays`, true, OWNER[n], Sof(w), s.kp.rawPublicKey(), 0);
    await mv(`Q9-${n}c. the revoked session`, false, st.venue, rule, s);
    await mv(`Q9-${n}d. another live session of the same wallet still works`, true, st.venue, rule, s2);
  }
  const s10 = await session(PH, 'Q10-0. Phantom grant (target of the Freighter revoke)');
  await runGrant('Q10. Freighter signs a revoke of a Phantom session', false, PH_S, st.S_ph, s10.kp.rawPublicKey(), 0, { signAs: FR });
  await mv('Q10b. the Phantom session still works after the refused revoke', true, st.venue, st.r_ph, s10);
  // a short session: works until its ledger, refused at until + 1 while its stored entry still exists
  const sh = await session(PH, 'Q11-0. Phantom grant for 15 ledgers', { ledgers: 15 });
  await mv('Q11a. the short session works before its end', true, st.venue, st.r_ph, sh);
  await untilLedger(sh.until + 1);
  const e11 = await stored(st.S_ph, sh.kp.rawPublicKey());
  check('Q11b. past its end the stored entry still exists', !!e11 && e11.until === sh.until && e11.live >= (await now()), JSON.stringify(e11));
  await mv('Q11c. the short session at until + 1', false, st.venue, st.r_ph, sh);
  // a full 7-day session: the stored entry lives to the session's last ledger
  const lg = await session(FR, 'Q12-0. Freighter grant for the longest session (7 days less 20 ledgers)', { ledgers: 120_960 - 20 });
  const e12 = await stored(st.S_fr, lg.kp.rawPublicKey());
  check('Q12a. the 7-day entry stores its end and lives at least to it', !!e12 && e12.until === lg.until && e12.live >= lg.until, `${JSON.stringify(e12)} session end ${lg.until}`);
  await mv('Q12b. a move in the 7-day session', true, st.venue, st.r_fr, lg);
  // an old authorization cannot be replayed after a revoke
  const rk = Sdk.Keypair.random(), ru = (await now()) + 720;
  const g13 = await runGrant('Q13a. Freighter grant for the replay test', true, FR, st.S_fr, rk.rawPublicKey(), ru, { exp: (await now()) + 200 });
  await runGrant('Q13b. Freighter revokes it', true, FR, st.S_fr, rk.rawPublicKey(), 0);
  await runGrant('Q13c. replay of the used grant authorization', false, FR, st.S_fr, rk.rawPublicKey(), ru, { entries: g13.entries });
  await mv('Q13d. the revoked key cannot move after the replay attempt', false, st.venue, st.r_fr, { kp: rk, until: ru, S: st.S_fr, signer: proofSigner(st.S_fr, rk) });
  // a revoke is final: an entry held back from the first grant, and a new authorization, are refused after it
  for (const w of [FR, PH]) {
    const n = w.name, S = Sof(w), rule = ids[n]!, key = Sdk.Keypair.random(), kb = key.rawPublicKey(), uk = (await now()) + 720;
    const e1 = await authorize(OWNER[n], S, kb, uk, { exp: (await now()) + 300 }), held = await authorize(OWNER[n], S, kb, uk, { exp: (await now()) + 300 });
    const sess: Session = { kp: key, until: uk, S, signer: proofSigner(S, key) };
    await runGrant(`Q17-${n}a. ${n} grant (the first of two entries signed together)`, true, OWNER[n], S, kb, uk, { entries: [e1] });
    await mv(`Q17-${n}b. the session moves`, true, st.venue, rule, sess);
    await runGrant(`Q17-${n}c. ${n} revokes it`, true, OWNER[n], S, kb, 0);
    await runGrant(`Q17-${n}d. the held-back second entry, submitted after the revoke`, false, OWNER[n], S, kb, uk, { entries: [held] });
    await mv(`Q17-${n}e. the key cannot move`, false, st.venue, rule, sess);
    await runGrant(`Q17-${n}f. a new authorization to grant the revoked key again`, false, OWNER[n], S, kb, uk);
    const e17 = await stored(S, kb);
    check(`Q17-${n}g. the revoke entry stores 0 and lives to at least 3,000,000 ledgers ahead`, !!e17 && e17.until === 0 && e17.live >= (await now()) + 3_000_000, JSON.stringify(e17));
  }
  await expiredAuthorization();
  // strangers
  const sk = Sdk.Keypair.random(), strangerW = local('stranger', sk); await friendbot(sk.publicKey());
  await runGrant("Q15. a stranger signs Freighter's grant authorization", false, FR, st.S_fr, sk.rawPublicKey(), (await now()) + 720, { signAs: strangerW });
  await runGrant('Q16. a stranger sends a grant with no owner authorization, paying the fee', false, FR, st.S_fr, sk.rawPublicKey(), (await now()) + 720, { entries: [], payer: sk });
}
if (part === 'cross') {
  const run0 = async (name: string, owner: W, S: string, o: G & { moveRule: number }) => {
    const kp = Sdk.Keypair.random(), until = (await now()) + 720;
    await runGrant(name, false, owner, S, kp.rawPublicKey(), until, o);
    await mv(`${name.split('.')[0]}b. the key from ${name.split('.')[0]} cannot move`, false, st.venue, o.moveRule, { kp, until, S, signer: proofSigner(S, kp) });
  };
  await run0("X1. Freighter's prime-session: grant signed by Phantom's session-owner key (NEAR)", FR, st.S_fr, { signAs: PH_S, moveRule: st.r_fr });
  await run0("X4. Phantom's prime-session: grant signed by its MPC key under another path", PH_S, st.S_ph, { signAs: PH_OTHER_PATH, moveRule: st.r_ph });
  await run0("X5. Phantom's session-owner key authorizes a grant on MetaMask's prime-session", PH_S, st.S_mm, { moveRule: st.r_mm });
  const kp6 = Sdk.Keypair.random(), u6 = (await now()) + 720;
  await runGrant("X6. MetaMask's grant authorization (for its own prime-session) sent to Phantom's prime-session", false, MM_S, st.S_ph, kp6.rawPublicKey(), u6, { signedS: st.S_mm });
  await run0("X7. Phantom's seat key (prime:stellar) signs the grant of its own prime-session", PH_S, st.S_ph, { signAs: PH, moveRule: st.r_ph });
}
if (part === 'q14') await expiredAuthorization();
if (part === 'realfr') {
  // The real Freighter extension signs the grant and the revoke through signAuthEntry; the move uses the session key.
  const rule = st.r_rf, b = await xlmBal(st.venue);
  const s = await session(RF, 'RF0. real Freighter signAuthEntry authorizes grant(key, until), relayer pays');
  await mv('RF1. the session key moves 1 XLM to VENUE under that grant', true, st.venue, rule, s);
  check('RF2. VENUE received exactly 1 XLM', (await xlmBal(st.venue)) - b === 10_000_000n, `${(await xlmBal(st.venue)) - b} stroops`);
  await mv('RF3. 1 XLM elsewhere', false, st.other, rule, s);
  await runGrant('RF4. real Freighter signAuthEntry authorizes the revoke, grant(key, 0)', true, RF, st.S_rf, s.kp.rawPublicKey(), 0);
  await mv('RF5. the revoked session', false, st.venue, rule, s);
}
if (part === 'owners') {
  // Any number of owners and any threshold: PRIME_OWNERS and PRIME_THRESHOLD. A fresh Prime Account and one prime-session per owner are
  // deployed (run with STN_STATE set to its own state file). The first three owners are the real wallets (Freighter's own key, then
  // MetaMask and Phantom through NEAR); further owners are plain local keys that serve as both seat and session owner.
  const N_OWN = Number(process.env.PRIME_OWNERS), THR = Number(process.env.PRIME_THRESHOLD);
  if (!Number.isInteger(N_OWN) || !Number.isInteger(THR) || N_OWN < 1 || THR < 1 || THR > N_OWN) throw new Error(`PRIME_OWNERS=${N_OWN} PRIME_THRESHOLD=${THR}: need integers with 1 <= threshold <= owners`);
  const TAG = `${THR}-of-${N_OWN}`;
  const plain = (n: number): { seat: W; owner: W } => { const w = local(`Owner${n}`, Sdk.Keypair.random()); return { seat: w, owner: w }; };
  const roster = [{ seat: FR, owner: FR }, { seat: MM, owner: MM_S }, { seat: PH, owner: PH_S }].slice(0, N_OWN).concat(Array.from({ length: Math.max(0, N_OWN - 3) }, (_, i) => plain(i + 4)));
  for (const o of roster) { OWNER[o.seat.name] = o.owner; S_OF[o.seat.name] = `S_${o.seat.name}`; }
  const seats = roster.map((o) => o.seat), names = (ws: W[]) => ws.map((w) => w.name).join(' + ');
  const votes = (ws: W[]) => ws.map((w) => seat(w));
  const rules: Record<string, number> = {};
  log(TAG, roster.map((o) => `${o.seat.name} seat ${o.seat.G.slice(0, 6)} owner ${o.owner.G.slice(0, 6)}`).join('; '));

  // setup: relayer, seat and owner accounts, one prime-session per owner, the Prime Account (weights 1, threshold T)
  await friendbot(fee.publicKey());
  for (const o of roster) { await friendbot(o.seat.G); await friendbot(o.owner.G); }
  { const v = Sdk.Keypair.random(), x = Sdk.Keypair.random(); await friendbot(v.publicKey()); await friendbot(x.publicKey()); save({ venue: v.publicKey(), other: x.publicKey() }); }
  { const { ret, hash } = await submit(fee, Sdk.Operation.uploadContractWasm({ wasm: readFileSync(WASM) })); save({ wasm: Buffer.from(ret!.bytes()).toString('hex'), wasmTx: hash }); }
  for (const o of roster) {
    const { ret, hash } = await submit(fee, Sdk.Operation.createCustomContract({ address: Sdk.Address.fromString(fee.publicKey()), wasmHash: Buffer.from(st.wasm, 'hex'), constructorArgs: [addr(o.owner.G)], salt: Buffer.from(Sdk.Keypair.random().rawPublicKey()) }));
    save({ [S_OF[o.seat.name]!]: Sdk.Address.fromScVal(ret!).toString(), [`${S_OF[o.seat.name]}Tx`]: hash }); log(S_OF[o.seat.name], st[S_OF[o.seat.name]!], hash);
  }
  {
    const weights = map([[sym('signer_weights'), map(seats.map((w) => [delegated(w.G), u32(1)] as [Sdk.xdr.ScVal, Sdk.xdr.ScVal]))], [sym('threshold'), u32(THR)]]);
    const { ret, hash } = await submit(fee, Sdk.Operation.createCustomContract({ address: Sdk.Address.fromString(fee.publicKey()), wasmHash: Buffer.from(ACCOUNT_WASM_HASH, 'hex'),
      constructorArgs: [vec(seats.map((w) => delegated(w.G))), map([[addr(WEIGHTED), weights]])], salt: Buffer.from(Sdk.Keypair.random().rawPublicKey()) }));
    save({ prime: Sdk.Address.fromScVal(ret!).toString(), primeTx: hash }); log('Prime Account', st.prime, hash);
    const fundXlm = Math.max(30, N_OWN * 5); log(`funded ${fundXlm} XLM`, (await submit(fee, new Sdk.Contract(XLM).call('transfer', addr(fee.publicKey()), addr(st.prime), Sdk.nativeToScVal(BigInt(fundXlm) * 10_000_000n, { type: 'i128' })))).hash);
  }
  const rule0 = async () => (await sim(call('get_context_rule', u32(0)))).result.retval as Sdk.xdr.ScVal;
  {
    const r0: any = Sdk.scValToNative(await rule0()), signers = JSON.stringify(r0.signers, (_, v) => (typeof v === 'bigint' ? v.toString() : v));
    const S = seats.map((w) => st[S_OF[w.name]!] as string);
    const wt: any = Sdk.scValToNative((await sim(new Sdk.Contract(WEIGHTED).call('get_threshold', u32(0), addr(st.prime)))).result.retval);
    check(`P0. rule 0 signers are exactly the ${N_OWN} seat keys (no prime-session), weighted threshold ${THR}`, seats.every((w) => signers.includes(w.G)) && !S.some((s) => signers.includes(s)) && r0.signers.length === N_OWN && Number(wt) === THR, `${r0.signers.length} signers, threshold ${wt}`);
    check(`P1. the ${N_OWN} prime-session contracts and the ${N_OWN} session-owner accounts are all different`, new Set(S).size === N_OWN && new Set(roster.map((o) => o.owner.G)).size === N_OWN, S.map((s) => s.slice(0, 6)).join(','));
  }

  // seats: threshold - 1 votes refused, threshold votes accepted, any threshold-sized subset, outsider and wrong-key votes refused
  {
    const first = seats.slice(0, THR), last = seats.slice(N_OWN - THR), stranger = Sdk.Keypair.random(); await friendbot(stranger.publicKey());
    await run(`Y1. ${THR - 1} of ${N_OWN} owners vote (threshold minus one) to add a rule`, false, tmpRule('y1'), [0], votes(seats.slice(0, THR - 1)));
    await run(`Y2. ${THR} owners vote (${names(first)}) to add a rule`, true, tmpRule('y2'), [0], votes(first));
    await run(`Y3. a different ${THR} owners vote (${names(last)}) to remove it`, true, call('remove_context_rule', u32(await ruleId('y2'))), [0], votes(last));
    await run(`Y4. ${THR - 1} owners and an outsider vote`, false, tmpRule('y4'), [0], [...votes(seats.slice(0, THR - 1)), localSigner(stranger)]);
    await run(`Y5. ${seats[0]!.name}'s seat signed by another key, plus ${THR - 1} real owners`, false, tmpRule('y5'), [0], [seat(seats[0]!, (seats[1] ?? local('x', stranger)) as W), ...votes(seats.slice(1, THR))]);
  }
  // one session rule per owner, installed by threshold votes on rule 0
  for (const o of roster) { const n = `xlm_${o.seat.name}`;
    await run(`R-${n}. ${THR} owners install ${n}: XLM to VENUE only, signer: ${o.seat.name}'s prime-session`, true, call('add_context_rule', ...xlmRule(n, st[S_OF[o.seat.name]!])), [0], votes(seats.slice(0, THR)));
    rules[o.seat.name] = await ruleId(n); }
  save({ rules });

  // each owner: its own session, relayed and self-paid moves, revoke, no vote
  const live: Record<string, Session> = {};
  for (const [i, o] of roster.entries()) {
    const w = o.seat, n = w.name, p = `P${i}-${n}`, rule = rules[w.name]!, others = seats.filter((x) => x !== w);
    const s = await session(w, `${p}.1 ${n} grant: one authorization (${o.owner === w ? 'own key' : 'NEAR MPC'}), relayer pays`); live[n] = s;
    const b = await xlmBal(st.venue);
    await mv(`${p}.2 relayer pays: 1 XLM to VENUE`, true, st.venue, rule, s);
    const kp2 = Sdk.Keypair.random(); await friendbot(kp2.publicKey());
    const s2 = await session(w, `${p}.3 ${n} grant, relayer down: the session key's own account is the transaction source`, { kp: kp2, payer: kp2 });
    await mv(`${p}.4 relayer down: the session key's own account pays the fee, 1 XLM to VENUE`, true, st.venue, rule, s2, kp2);
    check(`${p}.5 VENUE received exactly 2 XLM`, (await xlmBal(st.venue)) - b === 20_000_000n, `${(await xlmBal(st.venue)) - b} stroops`);
    await mv(`${p}.6 1 XLM elsewhere`, false, st.other, rule, s);
    if (others.length) await mv(`${p}.7 on ${others[0]!.name}'s session rule`, false, st.venue, rules[others[0]!.name]!, s);
    await run(`${p}.8 the session and ${THR - 1} real owners vote on rule 0`, false, tmpRule(`n8_${i}`), [0], [s.signer, ...votes(others.slice(0, THR - 1))]);
    await run(`${p}.9 the session claims its own rule for an account-admin call`, false, tmpRule(`n9_${i}`), [rule], [s.signer]);
    await run(`${p}.10 the session removes rule 0 through its own rule`, false, call('remove_context_rule', u32(0)), [rule], [s.signer]);
    const r = await session(w, `${p}.11 ${n} grant (second session)`);
    await runGrant(`${p}.12 ${n} revokes it: grant(key, 0), one authorization, relayer pays`, true, OWNER[n]!, Sof(w), r.kp.rawPublicKey(), 0);
    await mv(`${p}.13 the revoked session`, false, st.venue, rule, r);
    await mv(`${p}.14 the first session still works`, true, st.venue, rule, s);
    if (others.length) { const x = others[i % others.length]!, kp = Sdk.Keypair.random(), u = (await now()) + 720;
      await runGrant(`${p}.15 a grant for ${n}'s prime-session signed by ${x.name}'s owner key`, false, OWNER[n]!, Sof(w), kp.rawPublicKey(), u, { signAs: OWNER[x.name]! });
      await mv(`${p}.16 the key from ${p}.15 cannot move`, false, st.venue, rule, { kp, until: u, S: Sof(w), signer: proofSigner(Sof(w), kp) }); }
  }

  // removal: the owners drop one owner's session rule, then the owner's seat
  {
    const k = seats[N_OWN - 1]!, rest = seats.filter((x) => x !== k), voters = rest.length >= THR ? rest.slice(0, THR) : seats.slice(0, THR), ks = live[k.name]!, other = seats.find((x) => x !== k);
    await mv(`R0. ${k.name}'s live session works before removal`, true, st.venue, rules[k.name]!, ks);
    await run(`R1. ${THR - 1} owners try to remove ${k.name}'s session rule`, false, call('remove_context_rule', u32(rules[k.name]!)), [0], votes(voters.slice(0, THR - 1)));
    await run(`R2. ${THR} owners remove ${k.name}'s session rule (${names(voters)})`, true, call('remove_context_rule', u32(rules[k.name]!)), [0], votes(voters));
    await mv(`R3. ${k.name}'s live session after removal`, false, st.venue, rules[k.name]!, ks);
    const again = await session(k, `R4. ${k.name} signs a new grant (the contract still takes it)`);
    await mv('R5. the new session cannot move either (no rule)', false, st.venue, rules[k.name]!, again);
    if (other) await mv(`R6. ${other.name}'s session still works`, true, st.venue, rules[other.name]!, live[other.name]!);
    if (N_OWN >= 2) {
      const newThr = Math.min(THR, N_OWN - 1), id = async (g: string) => Number(Sdk.scValToNative((await sim(call('get_signer_id', delegated(g)))).result.retval));
      const exec = async (fn: string, ...a: Sdk.xdr.ScVal[]) => call('execute', addr(WEIGHTED), sym(fn), vec(a));
      if (newThr !== THR) await run(`R7. ${THR} owners lower the threshold to ${newThr} (the account must not be left with fewer owners than votes)`, true, await exec('set_threshold', u32(newThr), await rule0(), addr(st.prime)), [0], votes(voters));
      await run(`R8. ${newThr} owners remove ${k.name} from rule 0`, true, call('remove_signer', u32(0), u32(await id(k.G))), [0], votes(rest.slice(0, newThr)));
      await run(`R9. ${newThr} owners set ${k.name}'s weight to 0 (cleanup)`, true, await exec('set_signer_weight', delegated(k.G), u32(0), await rule0(), addr(st.prime)), [0], votes(rest.slice(0, newThr)));
      const r0: any = Sdk.scValToNative(await rule0());
      check(`R10. rule 0 now has ${N_OWN - 1} signers without ${k.name}`, r0.signers.length === N_OWN - 1 && !JSON.stringify(r0.signers).includes(k.G), `${r0.signers.length} signers`);
      await run(`R11. ${k.name}'s vote and ${newThr - 1} other owners no longer count`, false, tmpRule('r11'), [0], [...votes(rest.slice(0, newThr - 1)), seat(k)]);
      await run(`R12. ${newThr} remaining owners vote`, true, tmpRule('r12'), [0], votes(rest.slice(0, newThr)));
    } else {
      const sole = seats[0]!, id = Number(Sdk.scValToNative((await sim(call('get_signer_id', delegated(sole.G)))).result.retval));
      const r = await run('R7. the sole owner removes itself from rule 0 (observation: what the account allows)', true, call('remove_signer', u32(0), u32(id)), [0], votes([sole]));
      check('R7b. observed: removing the only seat from rule 0 is ' + (r.ok ? 'accepted (the account is then unreachable)' : 'refused'), true, r.ok ? 'accepted' : short(r.error));
    }
  }
  // fees of the setup transactions (Horizon)
  {
    const fees: Record<string, number> = {}; const sessionDeploy: number[] = [];
    const feeOf = async (h: string) => { for (let i = 0; i < 15; i++) { const r = await fetch(`https://horizon-testnet.stellar.org/transactions/${h}`); if (r.ok) return Number((await r.json() as any).fee_charged); await new Promise((s) => setTimeout(s, 2000)); } return -1; };
    fees.wasmUpload = await feeOf(st.wasmTx); fees.primeAccount = await feeOf(st.primeTx);
    for (const o of roster) sessionDeploy.push(await feeOf(st[`${S_OF[o.seat.name]}Tx`]));
    save({ setupFeesStroops: { ...fees, sessionDeploy } }); log('setup fees (stroops)', JSON.stringify({ ...fees, sessionDeploy }));
  }
  const all = Object.entries(results) as any;
  log(`${TAG}: ${all.filter((x: any) => x[1].pass).length}/${all.length} passed; NEAR MPC signatures: ${stats.calls}, average ${(stats.ms / Math.max(1, stats.calls) / 1000).toFixed(1)}s`);
  for (const [n, x] of all) if (!x.pass) log('FAIL', n, x.error ?? x.detail);
}
if (part === 'limits') {
  // Chain limits that bound the number of owners: signers on rule 0, and rules on the account (one session rule per owner).
  await friendbot(fee.publicKey()); await friendbot(FR.G);
  const mk = async (gs: string[]) => {
    const weights = map([[sym('signer_weights'), map(gs.map((g) => [delegated(g), u32(1)] as [Sdk.xdr.ScVal, Sdk.xdr.ScVal]))], [sym('threshold'), u32(1)]]);
    try {
      const { ret, hash } = await submit(fee, Sdk.Operation.createCustomContract({ address: Sdk.Address.fromString(fee.publicKey()), wasmHash: Buffer.from(ACCOUNT_WASM_HASH, 'hex'),
        constructorArgs: [vec(gs.map(delegated)), map([[addr(WEIGHTED), weights]])], salt: Buffer.from(Sdk.Keypair.random().rawPublicKey()) }));
      return { ok: true, id: Sdk.Address.fromScVal(ret!).toString(), hash };
    } catch (e: any) { return { ok: false, id: '', hash: '', error: String(e?.message ?? e).replace(/\s+/g, ' ').slice(0, 300) }; }
  };
  for (const n of [15, 16]) {
    const r = await mk(Array.from({ length: n }, () => Sdk.Keypair.random().publicKey()));
    check(`L${n}. an account with ${n} rule-0 signers is ${r.ok ? 'created' : 'refused'}`, n === 15 ? r.ok : !r.ok, r.ok ? r.hash : (r as any).error);
  }
  const acct = await mk([FR.G]); save({ prime: acct.id });
  let n = 0, last = '';
  for (; n < 40; n++) {
    const r = await invokeAs({ feePayer: fee, op: tmpRule(`lim${n}`), account: st.prime, ruleIds: [0], signers: [seat(FR)] });
    if (!r.ok) { last = short(r.error); break; }
  }
  const total = n + 1;   // rule 0 plus the rules added
  check(`L-rules. rules the account took before it refused one: ${total} (rule 0 and ${n} more)`, true, n === 40 ? 'no limit reached at 41 rules' : `refused rule ${total + 1}: ${last}`);
  log('rule limit', JSON.stringify({ rulesAccepted: total, stoppedBy: n === 40 ? 'probe ceiling' : last }));
}
if (part === 'summary') {
  const horizon = async (h: string) => { for (let i = 0; i < 15; i++) { const r = await fetch(`https://horizon-testnet.stellar.org/transactions/${h}`); if (r.ok) return r.json() as any; await new Promise((s) => setTimeout(s, 2000)); } return undefined; };
  const landed = Object.entries(results).filter(([, x]) => x.hash && x.ok && x.payer);
  const bad: string[] = []; const stats2: Record<string, number[]> = {};
  for (const [n, x] of landed) {
    const h = await horizon(x.hash);
    if (!h) { bad.push(`${n}: not on Horizon`); continue; }
    x.fee = Number(h.fee_charged); x.source = h.source_account;
    if (h.source_account !== x.payer || !h.successful) bad.push(`${n}: source ${h.source_account} expected ${x.payer}`);
    const g = `${x.kind} ${x.selfPaid ? 'self-paid' : 'relayed'}`; (stats2[g] ??= []).push(x.fee);
  }
  const self = landed.filter(([, x]) => x.selfPaid);
  check(`H1. Horizon: all ${landed.length} landed grants, revokes and moves have the payer as source account; the ${self.length} self-paid ones have the session key's own account`, bad.length === 0 && self.every(([, x]) => x.source === x.payer && x.source !== fee.publicKey()), bad.join('; ') || 'ok');
  const table: Record<string, any> = {};
  for (const [g, v] of Object.entries(stats2)) { v.sort((a, b) => a - b); table[g] = { n: v.length, min: v[0], median: v[Math.floor(v.length / 2)], max: v[v.length - 1] }; }
  save({ results, fees: table }); console.log('fees (stroops, Horizon fee_charged)', JSON.stringify(table, null, 1));
  const r = Object.entries(results) as any;
  log(`${r.filter((x: any) => x[1].pass).length}/${r.length} passed; NEAR MPC signatures this part: ${stats.calls}`);
  for (const [n, x] of r) if (!x.pass) log('FAIL', n, x.error ?? x.detail);
}
if (stats.calls) { save({ [`mpc_${part}`]: stats }); log(`NEAR MPC: ${stats.calls} signatures, average ${(stats.ms / stats.calls / 1000).toFixed(1)}s`); }
process.exit(0);
