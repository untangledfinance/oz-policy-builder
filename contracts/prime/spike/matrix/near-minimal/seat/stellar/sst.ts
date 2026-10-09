// Seat-voting sessions on Stellar testnet (spike). Contract: ./prime-seat (prime-session as the owner's rule-0 seat).
//   rule 0 (weighted_threshold 1/1/1 >= 2): External(prime-seat of MetaMask, 0x01), External(...Freighter), External(...Phantom),
//     served by prime-seat's `verify`. A seat votes when its owner authorizes (nested owner.require_auth_for_args in
//     verify) or when a live session key whose grant carries the vote flag signs. One contract = one vote.
//   session rules (XLM to VENUE only): Delegated(the wallet's prime-seat), served by __check_auth, which accepts any live
//     session key, vote flag or not. A Delegated signer is told nothing about its rule and the policy-interpreter refuses
//     External signers, so the two entry points are what keeps a move-only key out of rule 0.
//   owners: Freighter's own G key; for MetaMask and Phantom the NEAR MPC key under `prime:stellar-session`, locked at setup
//     (master weight 1, thresholds 1/1/2). The old seat path `prime:stellar` is unused here.
//   grants: grant(key, until, vote) with the owner's Soroban authorization; revoke = grant(key, 0, false), final.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { Sdk, XLM, PASS, friendbot, keypair, accountSig, signaturePayload, authDigest, nonce, log, server, submit, nestedEntry } from './stellar.ts';
const LOCAL = process.env.SST_LOCAL === '1'; // dry run: every wallet is a local key and the relayer is a separate funded key; no NEAR
const { edKey, edSign, stats } = LOCAL ? { edKey: async () => new Uint8Array(32), edSign: async () => new Uint8Array(64), stats: { calls: 0, ms: 0 } } : await import('./nearsig.ts');
const PS = '/home/ubuntu/git/github.com/untangledfinance/oz-policy-builder/packages/policy-synth/src';
const { encodePredicate } = await import(`${PS}/predicate/encode.ts`);
const { buildAddContextRuleArgs } = await import(`${PS}/install/build-add-context-rule.ts`);
const S_ = Sdk.xdr.ScVal, xdr = Sdk.xdr;
const HERE = '/home/ubuntu/work/seat-spike/stellar';
const WASM = `${process.env.SST_WASM ?? `${HERE}/prime-seat/target/wasm32v1-none/release/prime_seat.wasm`}`;
const ACCOUNT_WASM_HASH = '91a2cd56ba1a75d78eeb8ddc5d1841c5d439b7726a140bc84c850f73396298a9';
const WEIGHTED = 'CCTNRFZCL45GTJICA3Z2KFQO3VEGBHGCVBLHQ3GLJKAGACQIJMYJS7T2';
const INTERPRETER = 'CCBHVZ6HGGV7C4SNHCZ3S5665Z2WEMHTMBAEPO4XW6PKON464BEBANU5';
const FILE = process.env.SST_STATE ?? `${HERE}/${LOCAL ? 'state-sst-local' : 'state-sst'}.json`;
const st: Record<string, any> = existsSync(FILE) ? JSON.parse(readFileSync(FILE, 'utf8')) : {};
const save = (p: Record<string, unknown>) => { Object.assign(st, p); writeFileSync(FILE, JSON.stringify(st, null, 1)); };
const fee = keypair(LOCAL ? `${HERE}/secrets/local-fee.json` : '/home/ubuntu/work/near-session-spike/secrets/fee-payer.json'); // the relayer
const FREIGHTER_FILE = '/home/ubuntu/work/near-wallet-spike/secrets/freighter-b.json';
const kF = Sdk.Keypair.fromSecret(JSON.parse(readFileSync(FREIGHTER_FILE, 'utf8')).secret);
const sym = (s: string) => S_.scvSymbol(s), u32 = (n: number) => S_.scvU32(n), vec = (x: Sdk.xdr.ScVal[]) => S_.scvVec(x), bool = (b: boolean) => S_.scvBool(b);
const addr = (a: string) => new Sdk.Address(a).toScVal();
const delegated = (a: string) => vec([sym('Delegated'), addr(a)]);
const KEYDATA = Buffer.from([1]);
const external = (S: string) => vec([sym('External'), addr(S), S_.scvBytes(KEYDATA)]);
const map = (e: [Sdk.xdr.ScVal, Sdk.xdr.ScVal][]) => S_.scvMap(e.map(([k, v]) => new Sdk.xdr.ScMapEntry({ key: k, val: v }))
  .sort((l, r) => (l.key().switch().name === 'scvSymbol' && r.key().switch().name === 'scvSymbol') ? Buffer.compare(Buffer.from(l.key().sym()), Buffer.from(r.key().sym())) : Buffer.compare(l.key().toXDR(), r.key().toXDR())));
const short = (e?: string) => [...new Set((e ?? '').match(/Error\([A-Za-z]+, #?\w+\)/g) ?? [])].join(' ') || (e ?? '').slice(0, 200);
const horizon = new Sdk.Horizon.Server('https://horizon-testnet.stellar.org');
const now = async () => (await server.getLatestLedger()).sequence;
const untilLedger = async (n: number) => { while ((await now()) <= n) await new Promise((r) => setTimeout(r, 2000)); };
const part = process.argv[2];
let ACCKEY = part?.startsWith('nogov') ? 'prime2' : 'prime';
const ACC = () => st[ACCKEY] as string;

// Refusal reasons, as the host and the contracts report them.
const NOT_LIVE = /Error\(Contract, #1\)/;            // prime-seat: no live grant (never granted, expired, revoked, or no vote flag)
const VOTE_REFUSED = /Error\(Contract, #3003\)/;       // the account: a seat's verify returned false (no live key with the vote flag)
const THRESHOLD = /Error\(Contract, #3213\)/;        // weighted_threshold: not enough weight
const AUTH = /Error\(Auth, InvalidAction\)/;         // an authorization entry does not match what the contract asked for
const BADSIG = /Error\(Crypto|Error\(Auth, InvalidInput\)|Error\(Contract, #5\)|failed ED25519/; // a signature does not verify

// ── Wallets ────────────────────────────────────────────────────────────────────────────────────
type W = { name: string; pub: Buffer; G: string; signRaw: (m: Buffer) => Promise<Buffer> };
const SESSION_PATH = 'prime:stellar-session'; // the owner path: grants and seat votes of the NEAR-routed wallets
const OLD_SEAT_PATH = 'prime:stellar';        // the earlier seat path: no longer a seat here
const viaNear = async (name: 'MetaMask' | 'Phantom', path: string): Promise<W> => {
  if (LOCAL) { const kp = keypair(`${HERE}/secrets/local-${name}-${path.replace(/\W/g, '_')}.json`); return { name, pub: kp.rawPublicKey(), G: kp.publicKey(), signRaw: async (m) => kp.sign(m) }; }
  const pub = Buffer.from(await edKey(name, path));
  return { name, pub, G: Sdk.StrKey.encodeEd25519PublicKey(pub), signRaw: async (m) => Buffer.from(await edSign(name, path, m)) };
};
const local = (name: string, kp: Sdk.Keypair): W => ({ name, pub: kp.rawPublicKey(), G: kp.publicKey(), signRaw: async (m) => kp.sign(m) });
const FR = local('Freighter', kF);
const MM = await viaNear('MetaMask', SESSION_PATH), PH = await viaNear('Phantom', SESSION_PATH);
const MM_OLD = await viaNear('MetaMask', OLD_SEAT_PATH), PH_OLD = await viaNear('Phantom', OLD_SEAT_PATH);
const PH_OTHER_PATH = await viaNear('Phantom', 'prime:stellar-other');
const WALLET: Record<string, W> = { MetaMask: MM, Freighter: FR, Phantom: PH };
const S_OF: Record<string, string> = { MetaMask: 'S_mm', Freighter: 'S_fr', Phantom: 'S_ph' };
const Sof = (w: W) => st[S_OF[w.name]] as string;

const results: Record<string, any> = { ...(st.results ?? {}) };
function record(name: string, expectOk: boolean, r: any, payer: Sdk.Keypair, kind: string, why?: RegExp) {
  const reasonOk = expectOk || !why || why.test(r.error ?? '');
  const pass = r.ok === expectOk && reasonOk;
  results[name] = { pass, ok: r.ok, hash: r.hash, cpu: r.cpu, error: r.ok ? undefined : short(r.error), kind, payer: payer.publicKey(), selfPaid: payer !== fee };
  log(pass ? 'PASS' : 'FAIL', name, r.ok ? `ok ${r.ms} ms ${r.hash}${payer === fee ? '' : ' (fee paid by the session key)'}` : `refused: ${short(r.error)}${reasonOk ? '' : `   <- expected ${why}`}`);
  save({ results });
}
function check(name: string, ok: boolean, detail: string) { results[name] = { pass: ok, detail }; log(ok ? 'PASS' : 'FAIL', name, detail); save({ results }); }
const call = (fn: string, ...a: Sdk.xdr.ScVal[]) => new Sdk.Contract(ACC()).call(fn, ...a);
const sim = async (op: Sdk.xdr.Operation) => (await server.simulateTransaction(new Sdk.TransactionBuilder(await server.getAccount(fee.publicKey()), { fee: '100', networkPassphrase: Sdk.Networks.TESTNET }).addOperation(op).setTimeout(30).build())) as any;
async function ruleId(name: string) { const n = Number(Sdk.scValToNative((await sim(call('get_context_rules_count'))).result.retval)); for (let i = 0; i < n + 10; i++) { const s = await sim(call('get_context_rule', u32(i))); if (!s.error && (Sdk.scValToNative(s.result.retval) as any).name === name) return i; } return -1; }
const lit = (a: string) => ({ kind: 'literal_address', value: a });
const dlgDraft = (S: string) => ({ kind: 'delegated', address: S });
const extDraft = (S: string) => ({ kind: 'external', verifier: S, keyBytes: KEYDATA.toString('hex') });
function xlmRule(name: string, S: string, draft: (S: string) => any = dlgDraft) {
  const p: any = encodePredicate({ op: 'and', children: [
    { op: 'eq', left: { kind: 'call_fn' }, right: { kind: 'literal_symbol', value: 'transfer' } },
    { op: 'eq', left: { kind: 'call_arg', index: 0 }, right: lit(ACC()) },
    { op: 'eq', left: { kind: 'call_arg', index: 1 }, right: lit(st.venue) } ] });
  return buildAddContextRuleArgs({ contextRuleType: { kind: 'call_contract', contract: XLM }, name, validUntilLedger: null, signers: [draft(S)], policies: [] },
    { signers: [draft(S)], policies: [{ kind: 'interpreter', interpreterAddress: INTERPRETER, predicateBlobBase64: p.encodedPredicate }], installNonce: 1, encodedPredicate: p.encodedPredicate, predicateHash: p.predicateHash })
    .map((v: any) => Sdk.xdr.ScVal.fromXDR(v.toXDR('base64'), 'base64'));
}
const xfer = (to: string, stroops: bigint) => new Sdk.Contract(XLM).call('transfer', addr(ACC()), addr(to), Sdk.nativeToScVal(stroops, { type: 'i128' }));
const xlmBal = async (a: string) => BigInt(Sdk.scValToNative((await sim(new Sdk.Contract(XLM).call('balance', addr(a)))).result.retval));
let probeN = Number(st.probeN ?? 0);
const renameProbe = () => { save({ probeN: ++probeN }); return call('update_context_rule_name', u32(st.r_probe), S_.scvString(`p${probeN}`)); };

// ── Signers of one transaction ─────────────────────────────────────────────────────────────────
// owner:   External(S) seat in rule 0, the owner authorizes (an entry for the owner: S.verify(digest))
// session: External(S) seat in rule 0, a session key's proof (key || signature of the digest), for a vote
// g:       Delegated(G), a plain account
// move:    Delegated(S) signer of a session rule, a session key's proof (key, signature of S's entry payload), for a move
type Entry = Sdk.xdr.SorobanAuthorizationEntry;
type Sg =
  | { t: 'owner'; S: string; owner: W; signAs?: W; entry?: Entry }
  | { t: 'session'; S: string; kp: Sdk.Keypair; as?: Sdk.Keypair; key?: Buffer }
  | { t: 'g'; kp: Sdk.Keypair }
  | { t: 'plain'; w: W; signAs?: W }
  | { t: 'move'; S: string; kp: Sdk.Keypair; as?: Sdk.Keypair; key?: Buffer };
const rank = (k: Sdk.xdr.ScVal) => (k.vec()![0]!.sym().toString() === 'Delegated' ? 0 : 1);
const signerKey = (s: Sg) => s.t === 'owner' || s.t === 'session' ? external(s.S) : s.t === 'g' ? delegated(s.kp.publicKey()) : s.t === 'plain' ? delegated(s.w.G) : delegated(s.S);
function authPayload(signers: Sg[], ids: number[], digest: Buffer): Sdk.xdr.ScVal {
  const m = signers.map((s) => new xdr.ScMapEntry({ key: signerKey(s), val: S_.scvBytes(s.t === 'session' ? Buffer.concat([s.key ?? s.kp.rawPublicKey(), (s.as ?? s.kp).sign(digest)]) : Buffer.alloc(0)) }))
    .sort((l, r) => rank(l.key()) - rank(r.key()) || Buffer.compare(l.key().toXDR(), r.key().toXDR()));
  return xdr.ScVal.scvMap([new xdr.ScMapEntry({ key: sym('context_rule_ids'), val: vec(ids.map(u32)) }), new xdr.ScMapEntry({ key: sym('signers'), val: xdr.ScVal.scvMap(m) })]);
}
const verifyInvocation = (S: string, digest: Buffer) => new xdr.SorobanAuthorizedInvocation({
  function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(new xdr.InvokeContractArgs({ contractAddress: new Sdk.Address(S).toScAddress(), functionName: 'verify', args: [S_.scvBytes(digest)] })), subInvocations: [] });
const signEntry = async (w: W, n: Sdk.xdr.Int64, exp: number, root: Sdk.xdr.SorobanAuthorizedInvocation) => accountSig(w.pub, await w.signRaw(signaturePayload(n, exp, root)));
/** An Entry for `address` with `signature` over `root`. */
const entryFor = (address: string, n: Sdk.xdr.Int64, exp: number, signature: Sdk.xdr.ScVal, root: Sdk.xdr.SorobanAuthorizedInvocation) => new xdr.SorobanAuthorizationEntry({
  credentials: xdr.SorobanCredentials.sorobanCredentialsAddress(new xdr.SorobanAddressCredentials({ address: new Sdk.Address(address).toScAddress(), nonce: n, signatureExpirationLedger: exp, signature })), rootInvocation: root });
const countContexts = (inv: Sdk.xdr.SorobanAuthorizedInvocation): number => 1 + inv.subInvocations().reduce((t, s) => t + countContexts(s), 0);

/** Invoke `op` on the Prime Account with the given signers on rule ids `ruleIds`; the fee payer is the transaction source. */
async function invoke(o: { feePayer: Sdk.Keypair; op: Sdk.xdr.Operation; ruleIds: number[]; signers: Sg[]; also?: Sg[] }): Promise<{ ok: boolean; hash?: string; error?: string; ms: number }> {
  const t0 = Date.now();
  const src = await server.getAccount(o.feePayer.publicKey());
  const build = () => new Sdk.TransactionBuilder(src, { fee: '2000000', networkPassphrase: PASS }).addOperation(o.op).setTimeout(120);
  const s1 = await server.simulateTransaction(build().build());
  if (Sdk.rpc.Api.isSimulationError(s1)) return { ok: false, error: `recording sim: ${s1.error.slice(0, 400)}`, ms: Date.now() - t0 };
  const exp = (await now()) + 60;
  const entries: Entry[] = [];
  for (const e of s1.result!.auth) {
    const c = e.credentials();
    const who = c.switch().name === 'sorobanCredentialsAddress' ? Sdk.Address.fromScAddress(c.address().address()).toString() : '';
    if (who !== ACC()) { entries.push(e); continue; }
    const ids = o.ruleIds.length === 1 ? new Array(countContexts(e.rootInvocation())).fill(o.ruleIds[0]) : o.ruleIds;
    const payload = signaturePayload(c.address().nonce(), exp, e.rootInvocation());
    const digest = authDigest(payload, ids);
    entries.push(new xdr.SorobanAuthorizationEntry({ credentials: xdr.SorobanCredentials.sorobanCredentialsAddress(new xdr.SorobanAddressCredentials({ address: c.address().address(), nonce: c.address().nonce(), signatureExpirationLedger: exp, signature: authPayload(o.signers, ids, digest) })), rootInvocation: e.rootInvocation() }));
    for (const s of [...o.signers, ...(o.also ?? [])]) {
      if (s.t === 'owner') {
        if (s.entry) entries.push(s.entry);
        else { const on = new xdr.Int64(nonce()), root = verifyInvocation(s.S, digest), w = s.signAs ?? s.owner; entries.push(entryFor(s.owner.G, on, exp, await signEntry(w, on, exp, root), root)); }
        continue;
      }
      if (s.t === 'session') continue;
      const nested = nestedEntry(ACC(), digest, s.t === 'g' ? s.kp.publicKey() : s.t === 'plain' ? s.w.G : s.S, nonce(), exp);
      const nc = nested.credentials().address();
      const np = signaturePayload(nc.nonce(), exp, nested.rootInvocation());
      if (s.t === 'g') nc.signature(accountSig(s.kp.rawPublicKey(), s.kp.sign(np)));
      else if (s.t === 'plain') { const w = s.signAs ?? s.w; nc.signature(accountSig(w.pub, await w.signRaw(np))); }
      else nc.signature(vec([S_.scvBytes(s.key ?? s.kp.rawPublicKey()), S_.scvBytes((s.as ?? s.kp).sign(np))]));
      entries.push(nested);
    }
  }
  const op = Sdk.Operation.invokeHostFunction({ func: o.op.body().invokeHostFunctionOp().hostFunction(), auth: entries });
  return send(o.feePayer, op, t0);
}
async function send(payer: Sdk.Keypair, op: Sdk.xdr.Operation, t0 = Date.now()): Promise<{ ok: boolean; hash?: string; error?: string; ms: number; cpu?: number }> {
  const tx = new Sdk.TransactionBuilder(await server.getAccount(payer.publicKey()), { fee: '2000000', networkPassphrase: PASS }).addOperation(op).setTimeout(120).build();
  const s2 = await server.simulateTransaction(tx);
  if (Sdk.rpc.Api.isSimulationError(s2)) return { ok: false, error: s2.error.slice(0, 6000), ms: Date.now() - t0 };
  const ready = Sdk.rpc.assembleTransaction(tx, s2).build(); ready.sign(payer);
  const sent = await server.sendTransaction(ready);
  const cpu = Number((s2 as any).transactionData?.build().resources().instructions() ?? 0);
  if (sent.status === 'ERROR') return { ok: false, error: `send: ${JSON.stringify(sent.errorResult ?? sent).slice(0, 300)}`, ms: Date.now() - t0 };
  for (let i = 0; i < 40; i++) {
    const r = await server.getTransaction(sent.hash);
    if (r.status !== 'NOT_FOUND') return { ok: r.status === 'SUCCESS', hash: sent.hash, cpu, error: r.status === 'SUCCESS' ? undefined : `${r.status} ${JSON.stringify((r as any).resultXdr?.toXDR?.('base64') ?? '').slice(0, 120)}`, ms: Date.now() - t0 };
    await new Promise((res) => setTimeout(res, 1000));
  }
  return { ok: false, hash: sent.hash, error: 'timeout', ms: Date.now() - t0 };
}
async function run(name: string, expectOk: boolean, op: Sdk.xdr.Operation, ruleIds: number[], signers: Sg[], o: { feePayer?: Sdk.Keypair; kind?: string; why?: RegExp; also?: Sg[] } = {}) {
  const feePayer = o.feePayer ?? fee;
  let r: any;
  try { r = await invoke({ feePayer, op, ruleIds, signers, also: o.also }); } catch (e: any) { r = { ok: false, error: String(e?.message ?? e).slice(0, 300), ms: 0 }; }
  record(name, expectOk, r, feePayer, o.kind ?? 'tx', o.why); return r;
}

// ── Grants: owner.require_auth() on prime-seat.grant(key, until, vote) ─────────────────────────
const grantArgs = (S: string, key: Buffer, until: number, vote?: boolean) => new xdr.InvokeContractArgs({ contractAddress: new Sdk.Address(S).toScAddress(), functionName: 'grant', args: vote === undefined ? [S_.scvBytes(key), u32(until)] : [S_.scvBytes(key), u32(until), bool(vote)] });
/** The owner's signed authorization entry for grant(key, until, vote) on contract S. `signAs` signs in the owner's place. */
async function authorize(owner: W, S: string, key: Buffer, until: number, vote: boolean | undefined, o: { signAs?: W; exp?: number } = {}): Promise<Entry> {
  const n = new xdr.Int64(nonce()), exp = o.exp ?? (await now()) + 60, signer = o.signAs ?? owner;
  const root = new xdr.SorobanAuthorizedInvocation({ function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(grantArgs(S, key, until, vote)), subInvocations: [] });
  return entryFor(owner.G, n, exp, await signEntry(signer, n, exp, root), root);
}
async function sendGrant(payer: Sdk.Keypair, S: string, key: Buffer, until: number, vote: boolean | undefined, entries: Entry[]) {
  const fn = vote === undefined ? new Sdk.Contract(S).call('grant', S_.scvBytes(key), u32(until)) : new Sdk.Contract(S).call('grant', S_.scvBytes(key), u32(until), bool(vote));
  return send(payer, Sdk.Operation.invokeHostFunction({ func: fn.body().invokeHostFunctionOp().hostFunction(), auth: entries }));
}
type G = { signedS?: string; signedUntil?: number; signedVote?: boolean; signAs?: W; exp?: number; payer?: Sdk.Keypair; entries?: Entry[]; why?: RegExp };
/** One graded grant: the entry is signed for (signedS, signedUntil, signedVote) and sent as grant(key, until, vote) on S. */
async function runGrant(name: string, expectOk: boolean, owner: W, S: string, key: Buffer, until: number, vote: boolean | undefined, o: G = {}) {
  const entries = o.entries ?? [await authorize(owner, o.signedS ?? S, key, o.signedUntil ?? until, o.signedVote ?? vote, { signAs: o.signAs, exp: o.exp })];
  const payer = o.payer ?? fee;
  const r = await sendGrant(payer, S, key, until, vote, entries);
  record(name, expectOk, r, payer, `${vote === undefined ? 'base:' : ''}${until === 0 ? 'revoke' : vote ? 'grant+vote' : 'grant'}`, o.why); return { ...r, entries };
}
type Session = { kp: Sdk.Keypair; until: number; S: string; vote: boolean; hash?: string };
/** A live session: the wallet's owner authorizes grant(key, until, vote). */
async function session(w: W, name: string, o: { ledgers?: number; kp?: Sdk.Keypair; payer?: Sdk.Keypair; vote?: boolean } = {}): Promise<Session> {
  const kp = o.kp ?? Sdk.Keypair.random(), S = Sof(w), until = (await now()) + (o.ledgers ?? 720), vote = o.vote ?? false;
  const g = await runGrant(name, true, w, S, kp.rawPublicKey(), until, vote, { payer: o.payer });
  return { kp, until, S, vote, hash: g.hash };
}
const asMove = (s: Session, o: { as?: Sdk.Keypair } = {}): Sg => ({ t: 'move', S: s.S, kp: s.kp, as: o.as });
const asVote = (s: Session, o: { S?: string; as?: Sdk.Keypair } = {}): Sg => ({ t: 'session', S: o.S ?? s.S, kp: s.kp, as: o.as });
const owner = (w: W, o: { signAs?: W; entry?: Entry } = {}): Sg => ({ t: 'owner', S: Sof(w), owner: w, ...o });
const mv = (name: string, expectOk: boolean, to: string, rule: number, s: Session, payer = fee, why?: RegExp) => run(name, expectOk, xfer(to, 10_000_000n), [rule], [asMove(s)], { feePayer: payer, kind: 'move', why });
/** The stored grant (temporary storage) of a session key: (until, vote) and the ledger it lives to. */
async function stored(S: string, key: Buffer) {
  const k = xdr.LedgerKey.contractData(new xdr.LedgerKeyContractData({ contract: new Sdk.Address(S).toScAddress(), key: S_.scvBytes(key), durability: xdr.ContractDataDurability.temporary() }));
  const e = (await server.getLedgerEntries(k)).entries[0];
  if (!e) return undefined;
  const g = e.val.contractData().val().u32();
  return { until: g & 0x7fffffff, vote: g >>> 31 === 1, live: e.liveUntilLedgerSeq! };
}
/** A grant authorization is valid until its signature-expiry ledger: the same construction works at once and is refused after it. */
async function expiredAuthorization() {
  const k1 = Sdk.Keypair.random(), k2 = Sdk.Keypair.random(), exp = (await now()) + 4, until = (await now()) + 720;
  const e1 = await authorize(FR, st.S_fr, k1.rawPublicKey(), until, true, { exp }), e2 = await authorize(FR, st.S_fr, k2.rawPublicKey(), until, true, { exp });
  await runGrant('Q14a. control: a grant authorization submitted before its signature-expiry ledger', true, FR, st.S_fr, k1.rawPublicKey(), until, true, { entries: [e1] });
  await untilLedger(exp + 1);
  await runGrant('Q14. the same authorization for another key, submitted after its signature-expiry ledger', false, FR, st.S_fr, k2.rawPublicKey(), until, true, { entries: [e2], why: /Error\(Auth, InvalidInput\)/ });
}

// ── MPC-derived accounts: one SetOptions at setup freezes the signer list ──────────────────────
async function classic(w: W, op: Sdk.xdr.Operation): Promise<{ ok: boolean; hash?: string; codes?: string }> {
  const tx = new Sdk.TransactionBuilder(await horizon.loadAccount(w.G), { fee: '1000', networkPassphrase: PASS }).addOperation(op).setTimeout(120).build();
  tx.addSignature(w.G, (await w.signRaw(tx.hash())).toString('base64'));
  try { const r = await horizon.submitTransaction(tx); return { ok: r.successful, hash: r.hash }; }
  catch (e: any) { const c = e?.response?.data?.extras?.result_codes; return { ok: false, codes: c ? JSON.stringify(c) : String(e?.message ?? e).slice(0, 200) }; }
}
const acctState = async (g: string) => { const a: any = await horizon.loadAccount(g); return { signers: a.signers.map((x: any) => `${x.key}:${x.weight}`).join(','), thr: `${a.thresholds.low_threshold}/${a.thresholds.med_threshold}/${a.thresholds.high_threshold}` }; };
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
const ownerOf = async (c: string) => {
  const key = xdr.LedgerKey.contractData(new xdr.LedgerKeyContractData({ contract: new Sdk.Address(c).toScAddress(), key: S_.scvLedgerKeyContractInstance(), durability: xdr.ContractDataDurability.persistent() }));
  const e = (await server.getLedgerEntries(key)).entries[0];
  const m = e.val.contractData().val().instance().storage()?.find((en) => en.key().switch().name === 'scvU32' && en.key().u32() === 0);
  return m ? Sdk.Address.fromScVal(m.val()).toString() : 'missing';
};
const rule0 = async () => (await sim(call('get_context_rule', u32(0)))).result.retval as Sdk.xdr.ScVal;
const rule0Signers = async () => JSON.stringify((Sdk.scValToNative(await rule0()) as any).signers, (_, v) => (typeof v === 'bigint' ? v.toString() : v));
const weightedCall = async (fn: string, ...a: Sdk.xdr.ScVal[]) => call('execute', addr(WEIGHTED), sym(fn), vec([...a, await rule0(), addr(ACC())]));
const threshold = async () => Number(Sdk.scValToNative((await sim(new Sdk.Contract(WEIGHTED).call('get_threshold', u32(0), addr(ACC())))).result.retval));
const signerId = async (s: Sdk.xdr.ScVal) => Number(Sdk.scValToNative((await sim(call('get_signer_id', s))).result.retval));

if (part === 'setup') {
  await friendbot(fee.publicKey()); await friendbot(FR.G); await friendbot(MM.G); await friendbot(PH.G);
  log('owners (seat owners)', { MetaMask: MM.G, Freighter: FR.G, Phantom: PH.G });
  if (!st.venue) { const v = Sdk.Keypair.random(); await friendbot(v.publicKey()); const o = Sdk.Keypair.random(); await friendbot(o.publicKey()); save({ venue: v.publicKey(), other: o.publicKey() }); }
  const wasm = readFileSync(WASM);
  if (!st.wasm) {
    const { ret, hash } = await submit(fee, Sdk.Operation.uploadContractWasm({ wasm }));
    save({ wasm: Buffer.from(ret!.bytes()).toString('hex'), wasmTx: hash, wasmSha256: createHash('sha256').update(wasm).digest('hex') }); log('prime-seat wasm', st.wasm, hash);
  }
  for (const w of [MM, FR, PH]) {
    const k = S_OF[w.name]!;
    if (st[k]) continue;
    const { ret, hash } = await submit(fee, Sdk.Operation.createCustomContract({ address: Sdk.Address.fromString(fee.publicKey()), wasmHash: Buffer.from(st.wasm, 'hex'), constructorArgs: [addr(w.G)], salt: Buffer.from(Sdk.Keypair.random().rawPublicKey()) }));
    save({ [k]: Sdk.Address.fromScVal(ret!).toString(), [`${k}Tx`]: hash }); log(k, st[k], hash);
  }
  save({ G_mm: MM.G, G_fr: FR.G, G_ph: PH.G });
  if (!st.prime) {
    const seats = [st.S_mm, st.S_fr, st.S_ph];
    const weights = map([[sym('signer_weights'), map(seats.map((s) => [external(s), u32(1)] as [Sdk.xdr.ScVal, Sdk.xdr.ScVal]))], [sym('threshold'), u32(2)]]);
    const { ret, hash } = await submit(fee, Sdk.Operation.createCustomContract({ address: Sdk.Address.fromString(fee.publicKey()), wasmHash: Buffer.from(ACCOUNT_WASM_HASH, 'hex'),
      constructorArgs: [vec(seats.map(external)), map([[addr(WEIGHTED), weights]])], salt: Buffer.from(Sdk.Keypair.random().rawPublicKey()) }));
    save({ prime: Sdk.Address.fromScVal(ret!).toString(), primeTx: hash }); log('Prime Account', st.prime, hash);
    const f = await submit(fee, new Sdk.Contract(XLM).call('transfer', addr(fee.publicKey()), addr(st.prime), Sdk.nativeToScVal(300_000_000n, { type: 'i128' })));
    log('funded 30 XLM', f.hash);
  }
  const signers = await rule0Signers(), r0: any = Sdk.scValToNative(await rule0());
  check('P0. rule 0 holds exactly the three prime-seat contracts (External), no plain account', [st.S_mm, st.S_fr, st.S_ph].every((s) => signers.includes(s)) && r0.signers.length === 3 && r0.signers.every((x: any) => x[0] === 'External') && ![MM.G, FR.G, PH.G].some((g) => signers.includes(g)), signers.slice(0, 300));
  check('P1. the owners of MetaMask and Phantom are their prime:stellar-session keys, not their old seat keys', MM.G !== MM_OLD.G && PH.G !== PH_OLD.G, `MetaMask ${MM.G}, Phantom ${PH.G}`);
  const owners = { S_mm: MM.G, S_fr: FR.G, S_ph: PH.G } as Record<string, string>;
  for (const [k, want] of Object.entries(owners)) { const o = await ownerOf(st[k]); check(`P2-${k}. the stored owner of ${k} is the expected account`, o === want, `${o}`); }
  const wasmHashOn = async (c: string) => { const key = xdr.LedgerKey.contractData(new xdr.LedgerKeyContractData({ contract: new Sdk.Address(c).toScAddress(), key: S_.scvLedgerKeyContractInstance(), durability: xdr.ContractDataDurability.persistent() })); return (await server.getLedgerEntries(key)).entries[0]!.val.contractData().val().instance().executable().wasmHash().toString('hex'); };
  const build = createHash('sha256').update(wasm).digest('hex');
  for (const k of ['S_mm', 'S_fr', 'S_ph']) { const h = await wasmHashOn(st[k]); check(`P3-${k}. ${k} runs the built wasm`, h === build && st.wasm === build, `${h} build ${build}`); }
  for (const [label, w] of [['owner-MetaMask', MM], ['owner-Phantom', PH]] as const) await lockAccount(label, w);
}
if (part === 'rules') {
  // Rule installs are 2-of-3 decisions made by the owners themselves: MetaMask (NEAR) + Freighter, each through its own authorization.
  const tmp = call('add_context_rule', vec([sym('CallContract'), addr(XLM)]), S_.scvString('probe'), S_.scvVoid(), vec([delegated(FR.G)]), S_.scvMap([]));
  if ((await ruleId('probe')) < 0) await run('R-probe. MetaMask + Freighter (both owners, nested owner authorization) add the probe rule', true, tmp, [0], [owner(MM), owner(FR)], { kind: 'admin:owner+owner' });
  for (const [name, S] of [['xlm_mm', st.S_mm], ['xlm_fr', st.S_fr], ['xlm_ph', st.S_ph]] as const)
    if ((await ruleId(name)) < 0) await run(`R-${name}. MetaMask + Freighter install ${name}: XLM to VENUE only, signer Delegated(that wallet's prime-seat)`, true, call('add_context_rule', ...xlmRule(name, S)), [0], [owner(MM), owner(FR)], { kind: 'admin:owner+owner' });
  await run("R-ext. the policy-interpreter refuses an External signer on a session rule (ExternalSignerNotSupported), so session rules keep Delegated signers", false, call('add_context_rule', ...xlmRule('xlm_ext', st.S_mm, extDraft)), [0], [owner(MM), owner(FR)], { why: /Error\(Contract, #212\)/ });
  save({ r_probe: await ruleId('probe'), r_mm: await ruleId('xlm_mm'), r_fr: await ruleId('xlm_fr'), r_ph: await ruleId('xlm_ph') });
  log('rules', st.r_probe, st.r_mm, st.r_fr, st.r_ph);
}
const stranger = async () => { const k = Sdk.Keypair.random(); await friendbot(k.publicKey()); return { kp: k, w: local('stranger', k) }; };
/** A vote: rename the probe rule through rule 0 with the given seats. */
const vote = (name: string, expectOk: boolean, signers: Sg[], o: { kind?: string; why?: RegExp; feePayer?: Sdk.Keypair; also?: Sg[] } = {}) =>
  run(name, expectOk, renameProbe(), [0], signers, { kind: o.kind ?? 'vote', why: o.why, feePayer: o.feePayer, also: o.also });
/** The owner's authorization entry for S.verify(digest), signed by `signAs`. */
async function ownerEntry(w: W, S: string, digest: Buffer, signAs?: W): Promise<Entry> {
  const n = new xdr.Int64(nonce()), exp = (await now()) + 60, root = verifyInvocation(S, digest);
  return entryFor(w.G, n, exp, await signEntry(signAs ?? w, n, exp, root), root);
}

if (part === 'votes') {
  // ── sessions for the checks ──
  const fv = await session(FR, 'V0a. Freighter grant, move+vote', { vote: true }), fm = await session(FR, 'V0b. Freighter grant, move only');
  const mvs = await session(MM, 'V0c. MetaMask grant (NEAR MPC), move+vote', { vote: true }), mmo = await session(MM, 'V0d. MetaMask grant (NEAR MPC), move only');
  const pvs = await session(PH, 'V0e. Phantom grant (NEAR MPC), move+vote', { vote: true }), pmo = await session(PH, 'V0f. Phantom grant (NEAR MPC), move only');
  const short15 = await session(FR, 'V0g. Freighter grant, move+vote, 15 ledgers', { vote: true, ledgers: 15 });
  const revd = await session(FR, 'V0h. Freighter grant, move+vote (revoked below)', { vote: true });
  const e0 = await stored(fv.S, fv.kp.rawPublicKey()), e1 = await stored(fm.S, fm.kp.rawPublicKey());
  check('V0i. the stored grant carries the vote flag: true for the vote session, false for the move-only one', e0?.vote === true && e1?.vote === false && e0.until === fv.until && e1.until === fm.until, `${JSON.stringify(e0)} ${JSON.stringify(e1)}`);

  // ── the owner alone, and the owners together ──
  for (const w of [FR, MM, PH]) await vote(`V1-${w.name}. ${w.name}'s owner authorization alone (one seat)`, false, [owner(w)], { why: THRESHOLD });
  await vote('V2a. Freighter + Phantom owners (each through its own authorization)', true, [owner(FR), owner(PH)], { kind: 'vote:owner+owner' });
  await vote('V2b. MetaMask + Phantom owners', true, [owner(MM), owner(PH)], { kind: 'vote:owner+owner' });
  // ── a vote session replaces the owner's authorization ──
  await vote("V3a. Freighter's vote session + Phantom's owner", true, [asVote(fv), owner(PH)], { kind: 'vote:session+owner' });
  await vote("V3b. MetaMask's vote session + Freighter's owner", true, [asVote(mvs), owner(FR)], { kind: 'vote:session+owner' });
  await vote("V3c. Phantom's vote session + Freighter's owner", true, [asVote(pvs), owner(FR)], { kind: 'vote:session+owner' });
  await vote("V3d. two vote sessions (Freighter's + Phantom's) and no owner present", true, [asVote(fv), asVote(pvs)], { kind: 'vote:session+session' });
  const k2 = Sdk.Keypair.random(); await friendbot(k2.publicKey());
  const sp = await session(FR, "V3e0. Freighter grant, move+vote, for a key with its own account (relayer down)", { vote: true, kp: k2, payer: k2 });
  await vote("V3e. relayer down: the vote session key's own account pays the fee for the vote", true, [asVote(sp), owner(PH)], { kind: 'vote:session+owner', feePayer: k2 });
  // ── move-only sessions never vote ──
  await vote("V4a. Freighter's move-only session + Phantom's owner", false, [asVote(fm), owner(PH)], { why: VOTE_REFUSED });
  await vote("V4b. MetaMask's move-only session + Freighter's owner", false, [asVote(mmo), owner(FR)], { why: VOTE_REFUSED });
  await vote("V4c. Phantom's move-only session + Freighter's owner", false, [asVote(pmo), owner(FR)], { why: VOTE_REFUSED });
  await vote("V4d. a move-only session + a vote session (two session seats)", false, [asVote(fm), asVote(pvs)], { why: VOTE_REFUSED });
  // ── one seat counts once ──
  const fOwnerEntry = (d: Buffer) => ownerEntry(FR, st.S_fr, d);
  await run("V5a. Freighter's owner and Freighter's own vote session together (the seat counts once)", false, renameProbe(), [0], [asVote(fv)], { why: THRESHOLD, also: [owner(FR)] });
  await run("V5b. Freighter's owner authorization and no session proof, listed once, with nobody else", false, renameProbe(), [0], [owner(FR)], { why: THRESHOLD });
  const g5 = fv.kp; await friendbot(g5.publicKey());
  await vote("V5c. Freighter's owner + the vote session key's own account as a second voter (not a signer of rule 0)", false, [owner(FR), { t: 'g', kp: g5 }]);
  // ── a session alone ──
  await vote("V6a. Freighter's vote session alone", false, [asVote(fv)], { why: THRESHOLD });
  await vote("V6b. MetaMask's vote session alone", false, [asVote(mvs)], { why: THRESHOLD });
  await vote("V6c. Phantom's vote session alone", false, [asVote(pvs)], { why: THRESHOLD });
  // ── expired, revoked ──
  await runGrant('V7a0. Freighter revokes a vote session: grant(key, 0, false)', true, FR, st.S_fr, revd.kp.rawPublicKey(), 0, false);
  await vote("V7a. the revoked vote session + Phantom's owner", false, [asVote(revd), owner(PH)], { why: VOTE_REFUSED });
  await runGrant('V7b0. a revoked key cannot be granted again with the vote flag (revoke is final)', false, FR, st.S_fr, revd.kp.rawPublicKey(), (await now()) + 720, true, { why: NOT_LIVE });
  await vote("V7b. ... and it still cannot vote", false, [asVote(revd), owner(PH)], { why: VOTE_REFUSED });
  const rflag = await session(FR, 'V7d0. Freighter grant, move+vote (revoked below with the flag set)', { vote: true });
  await runGrant('V7d1. Freighter revokes it with the vote flag set: grant(key, 0, true)', true, FR, st.S_fr, rflag.kp.rawPublicKey(), 0, true);
  await runGrant('V7d2. the revoke is final whatever flag it carried: a new grant of the key is refused', false, FR, st.S_fr, rflag.kp.rawPublicKey(), (await now()) + 720, true, { why: NOT_LIVE });
  await vote('V7d3. ... and the key cannot vote', false, [asVote(rflag), owner(PH)], { why: VOTE_REFUSED });
  await untilLedger(short15.until + 1);
  await vote('V7c. an expired vote session (until + 1) + Phantom\'s owner', false, [asVote(short15), owner(PH)], { why: VOTE_REFUSED });
  // ── a session of one wallet never votes for another wallet's seat ──
  await vote("V8a. Freighter's vote session key in Phantom's seat + Freighter's owner", false, [asVote(fv, { S: st.S_ph }), owner(FR)], { why: VOTE_REFUSED });
  await vote("V8b. Freighter's vote session key in MetaMask's seat + Freighter's owner", false, [asVote(fv, { S: st.S_mm }), owner(FR)], { why: VOTE_REFUSED });
  await vote("V8c. Phantom's vote session key in Freighter's seat + Phantom's owner", false, [asVote(pvs, { S: st.S_fr }), owner(PH)], { why: VOTE_REFUSED });
  await vote("V8d. an unknown key in Freighter's seat + Phantom's owner", false, [asVote({ ...fv, kp: Sdk.Keypair.random() }), owner(PH)], { why: VOTE_REFUSED });
  await vote("V8e. Freighter's vote session proof signed by another key (key claimed, signature from a stranger) + Phantom's owner", false, [asVote(fv, { as: Sdk.Keypair.random() }), owner(PH)], { why: BADSIG });
  // ── the vote flag is bound by the owner's authorization ──
  const kb = Sdk.Keypair.random(), ub = (await now()) + 720;
  await runGrant('V9a. Freighter authorized move-only; the relayer submits move+vote', false, FR, st.S_fr, kb.rawPublicKey(), ub, true, { signedVote: false, why: AUTH });
  await vote('V9b. the key cannot vote', false, [asVote({ kp: kb, until: ub, S: st.S_fr, vote: true }), owner(PH)], { why: VOTE_REFUSED });
  const kc = Sdk.Keypair.random(), uc = (await now()) + 720;
  await runGrant('V9c. Freighter authorized move+vote; the relayer submits move-only', false, FR, st.S_fr, kc.rawPublicKey(), uc, false, { signedVote: true, why: AUTH });
  await runGrant('V9d. Phantom authorized move-only; the relayer submits move+vote', false, PH, st.S_ph, kb.rawPublicKey(), ub, true, { signedVote: false, why: AUTH });
  // ── owner authorizations: only the owner, only this vote ──
  const sg = await stranger(), digestFor = async () => Buffer.alloc(32, 7);
  await vote("V10a. a stranger signs Freighter's owner authorization + Phantom's owner", false, [owner(FR, { signAs: sg.w }), owner(PH)], { why: BADSIG });
  await vote("V10b. Phantom's owner key signs Freighter's owner authorization + Phantom's owner", false, [owner(FR, { signAs: PH }), owner(PH)], { why: BADSIG });
  await vote("V10c. MetaMask's old seat key (prime:stellar) signs MetaMask's owner authorization + Freighter's owner", false, [owner(MM, { signAs: MM_OLD }), owner(FR)], { why: BADSIG });
  const gEntry = await authorize(FR, st.S_fr, Sdk.Keypair.random().rawPublicKey(), (await now()) + 720, true);
  await vote("V10d. Freighter's signed grant authorization offered as its owner vote + Phantom's owner", false, [owner(FR, { entry: gEntry }), owner(PH)], { why: AUTH });
  const wrong = await ownerEntry(FR, st.S_fr, await digestFor());
  await vote("V10e. Freighter's owner authorization for another digest (another transaction) + Phantom's owner", false, [owner(FR, { entry: wrong }), owner(PH)], { why: AUTH });
  const wrongS = await ownerEntry(FR, st.S_ph, Buffer.alloc(32, 9));
  await vote("V10f. no owner authorization at all for Freighter's seat (entry for Phantom's contract) + Phantom's owner", false, [owner(FR, { entry: wrongS }), owner(PH)], { why: AUTH });
  // ── a re-grant changes the flag, with the owner's authorization ──
  const dg = await session(FR, 'V11a. Freighter grant, move+vote', { vote: true });
  await vote('V11b. the vote session votes', true, [asVote(dg), owner(PH)], { kind: 'vote:session+owner' });
  await runGrant('V11c. Freighter re-grants the same key and the same end ledger as move-only', true, FR, st.S_fr, dg.kp.rawPublicKey(), dg.until, false);
  await vote('V11d. the downgraded key cannot vote', false, [asVote(dg), owner(PH)], { why: VOTE_REFUSED });
  await runGrant('V11e. a stranger signs a re-grant of the key with the vote flag', false, FR, st.S_fr, dg.kp.rawPublicKey(), dg.until, true, { signAs: sg.w, why: BADSIG });
  await vote('V11f. the key still cannot vote after the refused upgrade', false, [asVote(dg), owner(PH)], { why: VOTE_REFUSED });
  await runGrant('V11g. Freighter re-grants it with the vote flag', true, FR, st.S_fr, dg.kp.rawPublicKey(), dg.until, true);
  await vote('V11h. the upgraded key votes again', true, [asVote(dg), owner(PH)], { kind: 'vote:session+owner' });
  // ── at most 7 days, for a vote session too ──
  const kd = Sdk.Keypair.random();
  await runGrant('V12a. a move+vote grant 10 ledgers beyond 7 days is refused at grant time', false, MM, st.S_mm, kd.rawPublicKey(), (await now()) + 120_960 + 10, true, { why: NOT_LIVE });
  const lg = await session(FR, 'V12b. Freighter grant, move+vote, 7 days less 20 ledgers', { vote: true, ledgers: 120_960 - 20 });
  const el = await stored(lg.S, lg.kp.rawPublicKey());
  check('V12c. the 7-day vote grant stores its end and lives at least to it', !!el && el.until === lg.until && el.vote && el.live >= lg.until, `${JSON.stringify(el)} session end ${lg.until}`);
  await vote('V12d. the 7-day vote session votes', true, [asVote(lg), owner(PH)], { kind: 'vote:session+owner' });
}

if (part === 'separation') {
  // A move-only key (the session-rule signer) never reaches rule 0, and a vote key stays inside the rules that list it.
  const ph = await session(PH, 'N0a. Phantom grant, move only'), phv = await session(PH, 'N0b. Phantom grant, move+vote', { vote: true });
  await vote("N1. Phantom's move-only key through the move entry point (Delegated) as a rule-0 seat + Freighter's owner", false, [asMove(ph), owner(FR)], { why: /Error\(Contract, #3\d\d\d\)/ });
  await vote("N2. Phantom's move-only key in the vote entry point (External) + Freighter's owner", false, [asVote(ph), owner(FR)], { why: VOTE_REFUSED });
  await run("N3. Phantom's move-only session asks its own session rule for an account-admin call", false, renameProbe(), [st.r_ph], [asMove(ph)], { why: /Error\(Contract, #(100|105|3\d\d\d)\)|Error\(Auth/ });
  await run("N4. Phantom's move+vote session asks its session rule for an account-admin call", false, renameProbe(), [st.r_ph], [asMove(phv)], { why: /Error\(Contract, #(100|105|3\d\d\d)\)|Error\(Auth/ });
  await run("N5. Phantom's move+vote session removes rule 0 through its session rule", false, call('remove_context_rule', u32(0)), [st.r_ph], [asMove(phv)], { why: /Error\(Contract, #(100|105|3\d\d\d)\)|Error\(Auth/ });
  await run("N6. Phantom's vote session key as an External signer of its session rule (not in that rule)", false, xfer(st.venue, 10_000_000n), [st.r_ph], [asVote(phv)], { why: /Error\(Contract, #3\d\d\d\)/ });
  await vote("N7. a plain account that is not a seat + Freighter's owner on rule 0", false, [{ t: 'g', kp: ph.kp }, owner(FR)], { why: /Error\(Contract, #3\d\d\d\)/ });
}

if (part === 'danger') {
  // A live vote session plus ONE other owner reaches 2-of-3: it can change rule 0, the owners and the threshold. Documented, then undone.
  const dv = (n: string, ok: boolean, sg: Sg[], o: { why?: RegExp } = {}) => vote(n, ok, sg, { ...o, kind: 'admin' });
  const ds = await session(FR, 'D0. Freighter grant, move+vote (the session under test)', { vote: true });
  const withPH = [asVote(ds), owner(PH)];
  const thief = Sdk.Keypair.random(); await friendbot(thief.publicKey());
  const thiefSeat: Sg = { t: 'g', kp: thief };
  check('D0a. start: threshold 2, three External seats on rule 0', (await threshold()) === 2 && (Sdk.scValToNative(await rule0()) as any).signers.length === 3, `threshold ${await threshold()}`);
  // 1. the threshold
  await run('D1. vote session + Phantom owner lower the rule-0 threshold from 2 to 1 (execute set_threshold on the weighted policy)', true, await weightedCall('set_threshold', u32(1)), [0], withPH, { kind: 'admin:session+owner' });
  check('D1a. the threshold now reads 1', (await threshold()) === 1, `threshold ${await threshold()}`);
  await dv('D2. the vote session ALONE now passes rule 0', true, [asVote(ds)]);
  await run('D3. the vote session alone raises the threshold back to 2', true, await weightedCall('set_threshold', u32(2)), [0], [asVote(ds)]);
  check('D3a. the threshold reads 2 again', (await threshold()) === 2, `threshold ${await threshold()}`);
  await dv('D3b. control: the vote session alone is refused again', false, [asVote(ds)], { why: THRESHOLD });
  // 2. the owners: a new seat
  await run('D4. vote session + Phantom owner add a thief account as a seat of rule 0 (add_signer)', true, call('add_signer', u32(0), delegated(thief.publicKey())), [0], withPH, { kind: 'admin:session+owner' });
  await run('D5. vote session + Phantom owner give the thief weight 1 (execute set_signer_weight)', true, await weightedCall('set_signer_weight', delegated(thief.publicKey()), u32(1)), [0], withPH, { kind: 'admin:session+owner' });
  await dv('D6. the thief + Phantom owner now pass rule 0 (a third party holds a seat)', true, [thiefSeat, owner(PH)]);
  const thiefId = await signerId(delegated(thief.publicKey()));
  await run('D7. vote session + Phantom owner remove the thief seat (remove_signer)', true, call('remove_signer', u32(0), u32(thiefId)), [0], withPH, { kind: 'admin:session+owner' });
  await run('D7a. ... and clear its weight', true, await weightedCall('set_signer_weight', delegated(thief.publicKey()), u32(0)), [0], withPH, { kind: 'admin:session+owner' });
  await dv('D7b. control: the thief + Phantom owner are refused again', false, [thiefSeat, owner(PH)], { why: /Error\(Contract, #3\d\d\d\)/ });
  // 3. the owners: take MetaMask's seat away
  const mmSeat = external(st.S_mm), mmId = await signerId(mmSeat);
  await run("D8. vote session + Phantom owner remove MetaMask's seat from rule 0", true, call('remove_signer', u32(0), u32(mmId)), [0], withPH, { kind: 'admin:session+owner' });
  await dv("D9. MetaMask's owner + Freighter's owner are refused (the seat is gone)", false, [owner(MM), owner(FR)], { why: /Error\(Contract, #3\d\d\d\)/ });
  await run("D10. Freighter + Phantom owners put MetaMask's seat back (add_signer)", true, call('add_signer', u32(0), mmSeat), [0], [owner(FR), owner(PH)], { kind: 'admin:owner+owner' });
  await dv("D11. MetaMask's owner + Freighter's owner pass again", true, [owner(MM), owner(FR)], { kind: 'admin:owner+owner' });
  // 4. rules: a new rule that anyone can satisfy is just one more call
  await run('D12. vote session + Phantom owner add a rule that the session key alone satisfies (the rule it would use for any call)', true,
    call('add_context_rule', vec([sym('CallContract'), addr(XLM)]), S_.scvString('d12'), S_.scvVoid(), vec([delegated(ds.kp.publicKey())]), S_.scvMap([])), [0], withPH, { kind: 'admin:session+owner' });
  const d12 = await ruleId('d12');
  await run('D12a. ... and remove it again', true, call('remove_context_rule', u32(d12)), [0], withPH, { kind: 'admin:session+owner' });
  const r0: any = Sdk.scValToNative(await rule0());
  check('D13. end state: rule 0 holds the three External seats again and the threshold is 2', r0.signers.length === 3 && r0.signers.every((x: any) => x[0] === 'External') && (await threshold()) === 2, `${r0.signers.length} signers, threshold ${await threshold()}`);
}

if (part === 'sessions') {
  // The move-rule checks of stn.ts (group Q), with the grant carrying a vote flag. A move uses the Delegated entry point.
  const ids: Record<string, number> = { MetaMask: st.r_mm, Freighter: st.r_fr, Phantom: st.r_ph };
  for (const w of [MM, FR, PH]) {
    const n = w.name, rule = ids[n]!;
    const s = await session(w, `Q-${n}0. ${n} grant (move only): one ${n === 'Freighter' ? 'signAuthEntry-style' : 'NEAR MPC'} authorization, relayer pays`);
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
    const sv = await session(w, `Q-${n}7a. ${n} grant, move+vote`, { vote: true });
    await mv(`Q-${n}7. a move+vote session moves 1 XLM to VENUE too`, true, st.venue, rule, sv);
  }
  const ngk = Sdk.Keypair.random();
  await mv('Q-never. a session key that was never granted', false, st.venue, st.r_fr, { kp: ngk, until: 0, S: st.S_fr, vote: false }, fee, NOT_LIVE);
  const ph7 = Sdk.Keypair.random(), u7 = (await now()) + 720;
  await runGrant('Q7. Phantom authorized one valid-until; the relayer submits a later one', false, PH, st.S_ph, ph7.rawPublicKey(), u7 + 100, false, { signedUntil: u7, why: AUTH });
  await mv('Q7b. the key from Q7 cannot move', false, st.venue, st.r_ph, { kp: ph7, until: 0, S: st.S_ph, vote: false }, fee, NOT_LIVE);
  const mm8 = Sdk.Keypair.random();
  await runGrant('Q8. MetaMask grant 10 ledgers beyond 7 days is refused at grant time', false, MM, st.S_mm, mm8.rawPublicKey(), (await now()) + 120_960 + 10, false, { why: NOT_LIVE });
  await mv('Q8b. the key from Q8 cannot move', false, st.venue, st.r_mm, { kp: mm8, until: 0, S: st.S_mm, vote: false }, fee, NOT_LIVE);
  // revoke = grant(key, 0, false): one owner authorization (MetaMask through NEAR, Freighter natively)
  for (const w of [MM, FR]) {
    const n = w.name, rule = ids[n]!;
    const s = await session(w, `Q9-${n}0. ${n} grant (first session, move+vote)`, { vote: true }), s2 = await session(w, `Q9-${n}00. ${n} grant (second session)`);
    await mv(`Q9-${n}a. session before revoke`, true, st.venue, rule, s);
    await runGrant(`Q9-${n}b. ${n} revokes it: grant(key, 0, false), one authorization, relayer pays`, true, w, Sof(w), s.kp.rawPublicKey(), 0, false);
    await mv(`Q9-${n}c. the revoked session`, false, st.venue, rule, s, fee, NOT_LIVE);
    await mv(`Q9-${n}d. another live session of the same wallet still works`, true, st.venue, rule, s2);
  }
  const s10 = await session(PH, 'Q10-0. Phantom grant (target of the Freighter revoke)');
  await runGrant('Q10. Freighter signs a revoke of a Phantom session', false, PH, st.S_ph, s10.kp.rawPublicKey(), 0, false, { signAs: FR, why: BADSIG });
  await mv('Q10b. the Phantom session still works after the refused revoke', true, st.venue, st.r_ph, s10);
  // a short session: works until its ledger, refused at until + 1 while its stored entry still exists
  const sh = await session(PH, 'Q11-0. Phantom grant for 15 ledgers', { ledgers: 15 });
  await mv('Q11a. the short session works before its end', true, st.venue, st.r_ph, sh);
  await untilLedger(sh.until + 1);
  const e11 = await stored(st.S_ph, sh.kp.rawPublicKey());
  check('Q11b. past its end the stored entry still exists', !!e11 && e11.until === sh.until && e11.live >= (await now()), JSON.stringify(e11));
  await mv('Q11c. the short session at until + 1', false, st.venue, st.r_ph, sh, fee, NOT_LIVE);
  // a full 7-day session: the stored entry lives to the session's last ledger
  const lg = await session(FR, 'Q12-0. Freighter grant for the longest session (7 days less 20 ledgers)', { ledgers: 120_960 - 20 });
  const e12 = await stored(st.S_fr, lg.kp.rawPublicKey());
  check('Q12a. the 7-day entry stores its end and lives at least to it', !!e12 && e12.until === lg.until && e12.live >= lg.until, `${JSON.stringify(e12)} session end ${lg.until}`);
  await mv('Q12b. a move in the 7-day session', true, st.venue, st.r_fr, lg);
  // an old authorization cannot be replayed after a revoke
  const rk = Sdk.Keypair.random(), ru = (await now()) + 720;
  const g13 = await runGrant('Q13a. Freighter grant for the replay test', true, FR, st.S_fr, rk.rawPublicKey(), ru, false, { exp: (await now()) + 200 });
  await runGrant('Q13b. Freighter revokes it', true, FR, st.S_fr, rk.rawPublicKey(), 0, false);
  await runGrant('Q13c. replay of the used grant authorization', false, FR, st.S_fr, rk.rawPublicKey(), ru, false, { entries: g13.entries, why: /Error\(Auth, ExistingValue\)|Error\(Contract, #1\)/ });
  await mv('Q13d. the revoked key cannot move after the replay attempt', false, st.venue, st.r_fr, { kp: rk, until: ru, S: st.S_fr, vote: false }, fee, NOT_LIVE);
  // a revoke is final: an entry held back from the first grant, and a new authorization, are refused after it (vote flag set)
  for (const w of [FR, PH]) {
    const n = w.name, S = Sof(w), rule = ids[n]!, key = Sdk.Keypair.random(), kb = key.rawPublicKey(), uk = (await now()) + 720;
    const e1 = await authorize(w, S, kb, uk, true, { exp: (await now()) + 300 }), held = await authorize(w, S, kb, uk, true, { exp: (await now()) + 300 });
    const sess: Session = { kp: key, until: uk, S, vote: true };
    await runGrant(`Q17-${n}a. ${n} grant (the first of two entries signed together)`, true, w, S, kb, uk, true, { entries: [e1] });
    await mv(`Q17-${n}b. the session moves`, true, st.venue, rule, sess);
    await runGrant(`Q17-${n}c. ${n} revokes it`, true, w, S, kb, 0, false);
    await runGrant(`Q17-${n}d. the held-back second entry, submitted after the revoke`, false, w, S, kb, uk, true, { entries: [held], why: NOT_LIVE });
    await mv(`Q17-${n}e. the key cannot move`, false, st.venue, rule, sess, fee, NOT_LIVE);
    await runGrant(`Q17-${n}f. a new authorization to grant the revoked key again`, false, w, S, kb, uk, true, { why: NOT_LIVE });
    const e17 = await stored(S, kb);
    check(`Q17-${n}g. the revoke entry stores 0 and lives to at least 3,000,000 ledgers ahead`, !!e17 && e17.until === 0 && e17.live >= (await now()) + 3_000_000, JSON.stringify(e17));
  }
  await expiredAuthorization();
  const sk = Sdk.Keypair.random(), strangerW = local('stranger', sk); await friendbot(sk.publicKey());
  await runGrant("Q15. a stranger signs Freighter's grant authorization", false, FR, st.S_fr, sk.rawPublicKey(), (await now()) + 720, true, { signAs: strangerW, why: BADSIG });
  await runGrant('Q16. a stranger sends a grant with no owner authorization, paying the fee', false, FR, st.S_fr, sk.rawPublicKey(), (await now()) + 720, true, { entries: [], payer: sk, why: /FAILED|Auth/ });
}

if (part === 'cross') {
  const run0 = async (name: string, owner0: W, S: string, o: G & { moveRule: number; vote?: boolean }) => {
    const kp = Sdk.Keypair.random(), until = (await now()) + 720;
    await runGrant(name, false, owner0, S, kp.rawPublicKey(), until, o.vote ?? false, o);
    await mv(`${name.split('.')[0]}b. the key from ${name.split('.')[0]} cannot move`, false, st.venue, o.moveRule, { kp, until, S, vote: false }, fee, NOT_LIVE);
  };
  await run0("X1. Freighter's prime-seat: grant signed by Phantom's owner key (NEAR)", FR, st.S_fr, { signAs: PH, moveRule: st.r_fr, why: BADSIG });
  await run0("X4. Phantom's prime-seat: grant signed by its MPC key under another path", PH, st.S_ph, { signAs: PH_OTHER_PATH, moveRule: st.r_ph, why: BADSIG });
  await run0("X5. Phantom's owner key authorizes a grant on MetaMask's prime-seat", PH, st.S_mm, { moveRule: st.r_mm, why: /Error\(Auth, InvalidAction\)/ });
  const kp6 = Sdk.Keypair.random(), u6 = (await now()) + 720;
  await runGrant("X6. MetaMask's grant authorization (for its own prime-seat) sent to Phantom's prime-seat", false, MM, st.S_ph, kp6.rawPublicKey(), u6, false, { signedS: st.S_mm, why: AUTH });
  await run0("X7. Phantom's old seat key (prime:stellar) signs the grant of its own prime-seat", PH, st.S_ph, { signAs: PH_OLD, moveRule: st.r_ph, why: BADSIG });
  await run0("X8. MetaMask's old seat key (prime:stellar) signs a vote-flag grant of its own prime-seat", MM, st.S_mm, { signAs: MM_OLD, moveRule: st.r_mm, vote: true, why: BADSIG });
}

const plain = (w: W, o: { signAs?: W } = {}): Sg => ({ t: 'plain', w, ...o });
if (part === 'nogov-setup') {
  // A second Prime Account on the same three prime-seat contracts: rule 0 (Default) holds the owners' plain accounts, so a session can never
  // reach it; the "ops" rule (CallContract(XLM)) holds the three External seats, so vote sessions can vote on fund moves only.
  if (!st.prime2) {
    const plainSeats = [MM.G, FR.G, PH.G];
    const weights = map([[sym('signer_weights'), map(plainSeats.map((g) => [delegated(g), u32(1)] as [Sdk.xdr.ScVal, Sdk.xdr.ScVal]))], [sym('threshold'), u32(2)]]);
    const { ret, hash } = await submit(fee, Sdk.Operation.createCustomContract({ address: Sdk.Address.fromString(fee.publicKey()), wasmHash: Buffer.from(ACCOUNT_WASM_HASH, 'hex'),
      constructorArgs: [vec(plainSeats.map(delegated)), map([[addr(WEIGHTED), weights]])], salt: Buffer.from(Sdk.Keypair.random().rawPublicKey()) }));
    save({ prime2: Sdk.Address.fromScVal(ret!).toString(), prime2Tx: hash }); log('Prime Account 2 (plain owners in rule 0)', st.prime2, hash);
    const f = await submit(fee, new Sdk.Contract(XLM).call('transfer', addr(fee.publicKey()), addr(st.prime2), Sdk.nativeToScVal(300_000_000n, { type: 'i128' })));
    log('funded 30 XLM', f.hash);
  }
  if ((await ruleId('probe')) < 0)
    await run('NGS0. MetaMask + Freighter (plain owner accounts, rule 0) add the probe rule', true, call('add_context_rule', vec([sym('CallContract'), addr(XLM)]), S_.scvString('probe'), S_.scvVoid(), vec([delegated(FR.G)]), S_.scvMap([])), [0], [plain(MM), plain(FR)], { kind: 'admin:plain+plain' });
  if ((await ruleId('ops')) < 0) {
    const seats = [st.S_mm, st.S_fr, st.S_ph];
    const weights = map([[sym('signer_weights'), map(seats.map((s) => [external(s), u32(1)] as [Sdk.xdr.ScVal, Sdk.xdr.ScVal]))], [sym('threshold'), u32(2)]]);
    await run('NGS1. MetaMask + Freighter install the ops rule: CallContract(XLM), the three External seats, weighted 2-of-3', true,
      call('add_context_rule', vec([sym('CallContract'), addr(XLM)]), S_.scvString('ops'), S_.scvVoid(), vec(seats.map(external)), map([[addr(WEIGHTED), weights]])), [0], [plain(MM), plain(FR)], { kind: 'admin:plain+plain' });
  }
  save({ r2_probe: await ruleId('probe'), r2_ops: await ruleId('ops') });
  const r0: any = Sdk.scValToNative(await rule0()), ops: any = Sdk.scValToNative((await sim(call('get_context_rule', u32(st.r2_ops)))).result.retval);
  check('NGS2. rule 0 holds only the three owners\' plain accounts; the ops rule holds only the three External seats', r0.signers.length === 3 && r0.signers.every((x: any) => x[0] === 'Delegated' && [MM.G, FR.G, PH.G].includes(x[1])) && ops.signers.length === 3 && ops.signers.every((x: any) => x[0] === 'External'), `${r0.signers.length} + ${ops.signers.length} signers`);
}
if (part === 'nogov') {
  const ops = st.r2_ops as number;
  const rn = () => { save({ probeN: ++probeN }); return call('update_context_rule_name', u32(st.r2_probe), S_.scvString(`q${probeN}`)); };
  const fv = await session(FR, 'NG0a. Freighter grant, move+vote', { vote: true }), pvs = await session(PH, 'NG0b. Phantom grant, move+vote', { vote: true }), fm = await session(FR, 'NG0c. Freighter grant, move only');
  const b0 = await xlmBal(st.venue);
  await run('NG1. baseline: plain owners MetaMask + Freighter on rule 0 (the production seat vote), same rename action', true, rn(), [0], [plain(MM), plain(FR)], { kind: 'vote:plain+plain' });
  await run('NG2. a vote session + Phantom owner (External seats) move 1 XLM to VENUE through the ops rule', true, xfer(st.venue, 10_000_000n), [ops], [asVote(fv), owner(PH)], { kind: 'ops:session+owner' });
  await run('NG3. two owners (External seats) move 1 XLM through the ops rule', true, xfer(st.venue, 10_000_000n), [ops], [owner(MM), owner(FR)], { kind: 'ops:owner+owner' });
  check('NG3a. VENUE received exactly 2 XLM from the account', (await xlmBal(st.venue)) - b0 === 20_000_000n, `${(await xlmBal(st.venue)) - b0} stroops`);
  await run('NG4. two vote sessions move 1 XLM through the ops rule with no owner present', true, xfer(st.venue, 10_000_000n), [ops], [asVote(fv), asVote(pvs)], { kind: 'ops:session+session' });
  await run('NG5. a vote session + Phantom owner move 1 XLM to ANY address through the ops rule (the rule has no destination limit)', true, xfer(st.other, 10_000_000n), [ops], [asVote(fv), owner(PH)], { kind: 'ops:any' });
  const thief = Sdk.Keypair.random();
  await run('NG6. a vote session + Phantom owner add a seat to rule 0 through the ops rule', false, call('add_signer', u32(0), delegated(thief.publicKey())), [ops], [asVote(fv), owner(PH)], { why: /Error\(Contract, #3\d\d\d\)/ });
  await run('NG7. a vote session + Phantom owner lower the rule-0 threshold (execute set_threshold) through the ops rule', false, await weightedCall('set_threshold', u32(1)), [ops], [asVote(fv), owner(PH)], { why: /Error\(Contract, #3\d\d\d\)/ });
  await run('NG8. a vote session + Phantom owner rename a rule through the ops rule', false, rn(), [ops], [asVote(fv), owner(PH)], { why: /Error\(Contract, #3\d\d\d\)/ });
  await run('NG9. the same governance call through rule 0 with the External seats (not signers of rule 0)', false, rn(), [0], [asVote(fv), owner(PH)], { why: /Error\(Contract, #3\d\d\d\)/ });
  await run('NG10. a move-only session + Phantom owner through the ops rule', false, xfer(st.venue, 10_000_000n), [ops], [asVote(fm), owner(PH)], { why: VOTE_REFUSED });
  await run('NG11. a vote session alone through the ops rule', false, xfer(st.venue, 10_000_000n), [ops], [asVote(fv)], { why: THRESHOLD });
  await run('NG12. the owners govern through rule 0 with their plain accounts: Phantom + Freighter set the rule-0 threshold (execute set_threshold, value 2)', true, await weightedCall('set_threshold', u32(2)), [0], [plain(PH), plain(FR)], { kind: 'vote:plain+plain' });
}


if (part === 'feebench') {
  // The same action (rename a rule) voted four ways, five times each after a warm-up: steady-state fees and simulated CPU instructions.
  const N = 5;
  const fv = await session(FR, 'FB0a. Freighter grant, move+vote', { vote: true }), pvs = await session(PH, 'FB0b. Phantom grant, move+vote', { vote: true });
  const rn1 = () => { save({ probeN: ++probeN }); return call('update_context_rule_name', u32(st.r_probe), S_.scvString(`f${probeN}`)); };
  const rn2 = () => { save({ probeN: ++probeN }); return call('update_context_rule_name', u32(st.r2_probe), S_.scvString(`f${probeN}`)); };
  for (let i = 0; i <= N; i++) {
    const tag = i === 0 ? 'warm-up' : `run ${i}`;
    ACCKEY = 'prime';
    await run(`FB1.${i} owner + owner (Freighter, Phantom), ${tag}`, true, rn1(), [0], [owner(FR), owner(PH)], { kind: i ? 'bench:owner+owner' : 'bench:warmup' });
    await run(`FB2.${i} vote session (Freighter) + owner (Phantom), ${tag}`, true, rn1(), [0], [asVote(fv), owner(PH)], { kind: i ? 'bench:session+owner' : 'bench:warmup' });
    await run(`FB3.${i} two vote sessions (Freighter, Phantom), ${tag}`, true, rn1(), [0], [asVote(fv), asVote(pvs)], { kind: i ? 'bench:session+session' : 'bench:warmup' });
    ACCKEY = 'prime2';
    await run(`FB4.${i} plain accounts (Freighter, Phantom) on a production-style rule 0, ${tag}`, true, rn2(), [0], [plain(FR), plain(PH)], { kind: i ? 'bench:plain+plain' : 'bench:warmup' });
  }
}

if (part === 'baseline') {
  // Control: the production prime-session (round 9 build) deployed beside the spike contract, so grant, revoke and move fees are compared in the same run.
  const PROD_WASM = '/home/ubuntu/git/github.com/untangledfinance/oz-policy-builder/contracts/prime/stellar/prime-session/target/wasm32v1-none/release/prime_session.wasm';
  const pw = readFileSync(PROD_WASM), pHash = createHash('sha256').update(pw).digest('hex');
  if (!st.wasmBase) { const { ret, hash } = await submit(fee, Sdk.Operation.uploadContractWasm({ wasm: pw })); save({ wasmBase: Buffer.from(ret!.bytes()).toString('hex'), wasmBaseTx: hash }); }
  if (!st.P_base) { const { ret, hash } = await submit(fee, Sdk.Operation.createCustomContract({ address: Sdk.Address.fromString(fee.publicKey()), wasmHash: Buffer.from(st.wasmBase, 'hex'), constructorArgs: [addr(FR.G)], salt: Buffer.from(Sdk.Keypair.random().rawPublicKey()) })); save({ P_base: Sdk.Address.fromScVal(ret!).toString(), P_baseTx: hash }); }
  check('B0. the control contract runs the round 9 build (sha256 e36d155f...)', st.wasmBase === pHash && pHash.startsWith('e36d155f'), `${st.wasmBase} ${pHash}`);
  if ((await ruleId('xlm_base')) < 0) await run('B1. MetaMask + Freighter install a session rule for the control contract (Delegated)', true, call('add_context_rule', ...xlmRule('xlm_base', st.P_base)), [0], [owner(MM), owner(FR)], { kind: 'admin:owner+owner' });
  save({ r_base: await ruleId('xlm_base') });
  const ks = [Sdk.Keypair.random(), Sdk.Keypair.random()], until = (await now()) + 720;
  for (const k of ks) await runGrant('B2. control grant(key, until), the round 9 signature, relayer pays', true, FR, st.P_base, k.rawPublicKey(), until, undefined);
  for (const k of ks) await run('B3. control move: 1 XLM to VENUE through the Delegated session rule', true, xfer(st.venue, 10_000_000n), [st.r_base], [{ t: 'move', S: st.P_base, kp: k }], { kind: 'base:move' });
  await runGrant('B4. control revoke grant(key, 0)', true, FR, st.P_base, ks[0]!.rawPublicKey(), 0, undefined);
}

if (part === 'summary') {
  const horizonTx = async (h: string) => { for (let i = 0; i < 15; i++) { const r = await fetch(`https://horizon-testnet.stellar.org/transactions/${h}`); if (r.ok) return r.json() as any; await new Promise((s) => setTimeout(s, 2000)); } return undefined; };
  const landed = Object.entries(results).filter(([, x]) => x.hash && x.ok && x.payer);
  const bad: string[] = []; const stats2: Record<string, number[]> = {}; const cpu2: Record<string, number[]> = {};
  for (const [n, x] of landed) {
    if (x.fee === undefined) {
      const h = await horizonTx(x.hash);
      if (!h) { bad.push(`${n}: not on Horizon`); continue; }
      x.fee = Number(h.fee_charged); x.source = h.source_account; x.okH = h.successful;
    }
    if (x.source !== x.payer || !x.okH) bad.push(`${n}: source ${x.source} expected ${x.payer}`);
    const g = `${x.kind} ${x.selfPaid ? 'self-paid' : 'relayed'}`; (stats2[g] ??= []).push(x.fee); if (x.cpu) (cpu2[g] ??= []).push(x.cpu);
  }
  const self = landed.filter(([, x]) => x.selfPaid);
  check(`H1. Horizon: all ${landed.length} landed transactions have the payer as source account; the ${self.length} self-paid ones have the session key's own account`, bad.length === 0 && self.every(([, x]) => x.source === x.payer && x.source !== fee.publicKey()), bad.join('; ') || 'ok');
  const table: Record<string, any> = {};
  for (const [g, v] of Object.entries(stats2)) { v.sort((a, b) => a - b); const c = (cpu2[g] ?? []).sort((a, b) => a - b); table[g] = { n: v.length, min: v[0], median: v[Math.floor(v.length / 2)], max: v[v.length - 1], cpuMedian: c.length ? c[Math.floor(c.length / 2)] : undefined }; }
  save({ results, fees: table }); console.log('fees (stroops, Horizon fee_charged)', JSON.stringify(table, null, 1));
  const r = Object.entries(results) as any;
  log(`${r.filter((x: any) => x[1].pass).length}/${r.length} passed`);
  for (const [n, x] of r) if (!x.pass) log('FAIL', n, x.error ?? x.detail);
}

if (stats.calls) { save({ [`mpc_${part}`]: stats }); log(`NEAR MPC: ${stats.calls} signatures, average ${(stats.ms / stats.calls / 1000).toFixed(1)}s`); }
process.exit(0);
