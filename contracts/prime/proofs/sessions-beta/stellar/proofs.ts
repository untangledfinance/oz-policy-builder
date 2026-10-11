// Stellar session proofs S1 to S7 on testnet (throwaway friendbot keys in ./secrets, never printed).
//   bun proofs.ts setup | s1 | s3 | s4 | s5 | s6 | s7
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { Sdk, XLM, PASS, friendbot, invokeAs, keypair, localSigner, accountSig, signaturePayload, nonce, log, server, submit } from './lib.ts';

const xdr = Sdk.xdr, S_ = xdr.ScVal;
const ACCOUNT_WASM_HASH = '91a2cd56ba1a75d78eeb8ddc5d1841c5d439b7726a140bc84c850f73396298a9';
const SESSION_WASM_HASH = 'e36d155f0381a466fb6c2c29b788a9d52e4a6f3e568f30da981609075bb7a0b3';
const SIMPLE_THRESHOLD = 'CAYTIVQOEZDOQI4GC3XBXEEYHQUANQQJHPJVMXVRBREGSAP6TCN3DID6';
const INTERPRETER = 'CDPR5VTX6R2ZPKREPD7FBW5ANVWXMVJIBIH2GMF36XPOFNMHRDIRUAZQ';
const MAX_PER_MOVE = 50_000_000n; // 5 XLM
const horizon = new Sdk.Horizon.Server('https://horizon-testnet.stellar.org');

const STATE = 'state.json', RESULTS = 'results.json';
const st: Record<string, any> = existsSync(STATE) ? JSON.parse(readFileSync(STATE, 'utf8')) : {};
const save = (p: Record<string, unknown>) => { Object.assign(st, p); writeFileSync(STATE, JSON.stringify(st, null, 1)); };
const res: Record<string, any> = existsSync(RESULTS) ? JSON.parse(readFileSync(RESULTS, 'utf8')) : {};
const record = (id: string, v: Record<string, unknown>) => { res[id] = { ...(res[id] ?? {}), ...v }; writeFileSync(RESULTS, JSON.stringify(res, null, 1)); };

const sym = (s: string) => S_.scvSymbol(s), u32 = (n: number) => S_.scvU32(n), vec = (x: xdr.ScVal[]) => S_.scvVec(x);
const addr = (a: string) => new Sdk.Address(a).toScVal();
const i128 = (v: bigint) => new Sdk.XdrLargeInt('i128', v.toString()).toScVal();
const delegated = (a: string) => vec([sym('Delegated'), addr(a)]);
const short = (e?: string) => [...new Set((e ?? '').match(/Error\([A-Za-z]+, #?\w+\)/g) ?? [])].join(' ') || (e ?? '').slice(0, 240);
const now = async () => (await server.getLatestLedger()).sequence;
const untilLedger = async (n: number) => { while ((await now()) <= n) await new Promise((r) => setTimeout(r, 2000)); };

const payer = keypair('secrets/payer.json');
const ownerA = keypair('secrets/owner-a.json'), ownerB = keypair('secrets/owner-b.json');
const stranger = keypair('secrets/stranger.json');
const venue = keypair('secrets/venue.json');

/** Contract id of a contract deployed by `deployer` with `salt` (counterfactual). */
function contractIdFor(deployer: string, salt: Buffer): string {
  const pre = xdr.HashIdPreimage.envelopeTypeContractId(new xdr.HashIdPreimageContractId({
    networkId: Sdk.hash(Buffer.from(PASS)),
    contractIdPreimage: xdr.ContractIdPreimage.contractIdPreimageFromAddress(new xdr.ContractIdPreimageFromAddress({ address: new Sdk.Address(deployer).toScAddress(), salt })) }));
  return Sdk.StrKey.encodeContract(Sdk.hash(pre.toXDR()));
}
const sessionSalt = (account: string) => Buffer.from(Sdk.hash(Buffer.concat([Buffer.from('prime-session'), Buffer.from(Sdk.StrKey.decodeContract(account))])));

async function feeOf(hash: string): Promise<number> {
  const r: any = await server.getTransaction(hash);
  return Number(r.resultXdr?.feeCharged?.().toString() ?? 0);
}

// ── Grammar-6 predicate for the Session moves rule ─────────────────────────────────────────────
function movePredicate(account: string, destination: string, max: bigint) {
  const eq = (a: xdr.ScVal, b: xdr.ScVal) => vec([sym('eq'), a, b]);
  const cmp = (op: string, a: xdr.ScVal, b: xdr.ScVal) => vec([sym(op), a, b]);
  const arg = (i: number) => vec([sym('call_arg'), u32(i)]);
  const p = vec([sym('and'), vec([
    eq(vec([sym('call_fn')]), sym('transfer')),
    eq(arg(0), addr(account)),
    eq(arg(1), addr(destination)),
    cmp('gte', arg(2), i128(1n)),
    cmp('lte', arg(2), i128(max)),
  ])]);
  const bytes = p.toXDR();
  return { bytes, hash: Buffer.from(Sdk.hash(bytes)) };
}
const entry = (k: xdr.ScVal, v: xdr.ScVal) => new xdr.ScMapEntry({ key: k, val: v });
function sessionMovesRuleArgs(account: string, signers: string[], destination: string, max: bigint, name: string, threshold = 1) {
  const pred = movePredicate(account, destination, max);
  const interpreterParams = S_.scvMap([
    entry(sym('grammar_version'), u32(6)), entry(sym('install_nonce'), u32(1)), entry(sym('policy_admins'), vec([delegated(account)])),
    entry(sym('predicate'), S_.scvBytes(pred.bytes)), entry(sym('predicate_hash'), S_.scvBytes(pred.hash)) ]);
  const policies = [entry(addr(INTERPRETER), interpreterParams), entry(addr(SIMPLE_THRESHOLD), S_.scvMap([entry(sym('threshold'), u32(threshold))]))]
    .sort((l, r) => Buffer.compare(l.key().toXDR(), r.key().toXDR()));
  return [vec([sym('CallContract'), addr(XLM)]), S_.scvString(name), S_.scvVoid(), vec(signers.map(delegated)), S_.scvMap(policies)];
}

// ── Chain helpers ──────────────────────────────────────────────────────────────────────────────
const call = (fn: string, ...a: xdr.ScVal[]) => new Sdk.Contract(st.account).call(fn, ...a);
const sim = async (op: xdr.Operation) => (await server.simulateTransaction(new Sdk.TransactionBuilder(await server.getAccount(payer.publicKey()), { fee: '100', networkPassphrase: PASS }).addOperation(op).setTimeout(30).build())) as any;
const xfer = (to: string, stroops: bigint) => new Sdk.Contract(XLM).call('transfer', addr(st.account), addr(to), Sdk.nativeToScVal(stroops, { type: 'i128' }));
const seat = (kp: Sdk.Keypair) => localSigner(kp);
const proofSigner = (S: string, kp: { rawPublicKey(): Buffer; sign(p: Buffer): Buffer | Uint8Array }) => ({ address: S, signNested: async (p: Buffer) => vec([S_.scvBytes(kp.rawPublicKey()), S_.scvBytes(Buffer.from(kp.sign(p)))]) });

/** The owner's signed authorization entry for grant(key, until) on contract S. */
async function authorize(ownerKp: Sdk.Keypair, S: string, key: Buffer, until: number): Promise<xdr.SorobanAuthorizationEntry> {
  const n = new xdr.Int64(nonce()), exp = (await now()) + 120;
  const root = new xdr.SorobanAuthorizedInvocation({ function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(new xdr.InvokeContractArgs({ contractAddress: new Sdk.Address(S).toScAddress(), functionName: 'grant', args: [S_.scvBytes(key), u32(until)] })), subInvocations: [] });
  const sig = ownerKp.sign(signaturePayload(n, exp, root));
  return new xdr.SorobanAuthorizationEntry({ credentials: xdr.SorobanCredentials.sorobanCredentialsAddress(new xdr.SorobanAddressCredentials({
    address: new Sdk.Address(ownerKp.publicKey()).toScAddress(), nonce: n, signatureExpirationLedger: exp, signature: accountSig(ownerKp.rawPublicKey(), sig) })), rootInvocation: root });
}

type Signer = { publicKey(): string; sign(tx: Sdk.Transaction): void };
/** Sends grant(key, until) on S. `source` is the transaction source (the key's own account or the owner). */
const grantOp = (S: string, key: Buffer, until: number, entries: xdr.SorobanAuthorizationEntry[]) =>
  Sdk.Operation.invokeHostFunction({ func: new Sdk.Contract(S).call('grant', S_.scvBytes(key), u32(until)).body().invokeHostFunctionOp().hostFunction(), auth: entries });
async function sendGrant(source: Signer, S: string, key: Buffer, until: number, entries: xdr.SorobanAuthorizationEntry[]) {
  return sendOp(source, grantOp(S, key, until, entries));
}
async function sendOp(source: Signer, op: xdr.Operation, extra?: (tx: Sdk.Transaction) => Sdk.Transaction) {
  const t0 = Date.now();
  let tx = new Sdk.TransactionBuilder(await server.getAccount(source.publicKey()), { fee: '2000000', networkPassphrase: PASS }).addOperation(op).setTimeout(120).build();
  const s = await server.simulateTransaction(tx);
  if (Sdk.rpc.Api.isSimulationError(s)) return { ok: false, error: s.error.slice(0, 600), ms: Date.now() - t0 } as any;
  const ready = Sdk.rpc.assembleTransaction(tx, s).build(); source.sign(ready);
  const sent = await server.sendTransaction(ready);
  if (sent.status === 'ERROR') return { ok: false, error: `send: ${JSON.stringify(sent.errorResult ?? sent).slice(0, 300)}`, ms: Date.now() - t0 } as any;
  for (let i = 0; i < 40; i++) {
    const r = await server.getTransaction(sent.hash);
    if (r.status !== 'NOT_FOUND') return { ok: r.status === 'SUCCESS', hash: sent.hash, fee: r.status === 'SUCCESS' ? await feeOf(sent.hash) : undefined, error: r.status === 'SUCCESS' ? undefined : r.status, ms: Date.now() - t0 } as any;
    await new Promise((res) => setTimeout(res, 1000));
  }
  return { ok: false, hash: sent.hash, error: 'timeout', ms: Date.now() - t0 } as any;
}
const kpSigner = (kp: Sdk.Keypair): Signer => ({ publicKey: () => kp.publicKey(), sign: (tx) => tx.sign(kp) });

/** A WebCrypto Ed25519 key (private key non-extractable) usable as a session key and a transaction signer. */
async function webKey() {
  const pair = (await crypto.subtle.generateKey({ name: 'Ed25519' }, false, ['sign', 'verify'])) as CryptoKeyPair;
  const raw = Buffer.from(await crypto.subtle.exportKey('raw', pair.publicKey));
  const G = Sdk.StrKey.encodeEd25519PublicKey(raw);
  const priv = pair.privateKey;
  // sign() over bytes is async in WebCrypto, so the proof signer pre-signs through this table when needed.
  return { raw, G, extractable: priv.extractable, signBytes: async (m: Uint8Array) => Buffer.from(await crypto.subtle.sign({ name: 'Ed25519' }, priv, m)) };
}
type WebKey = Awaited<ReturnType<typeof webKey>>;
const webProofSigner = (S: string, k: WebKey) => ({ address: S, signNested: async (p: Buffer) => vec([S_.scvBytes(k.raw), S_.scvBytes(await k.signBytes(p))]) });
/** sendOp for a transaction whose source is a WebCrypto key: simulate, then sign the transaction hash with the key. */
async function sendOpWeb(k: WebKey, op: xdr.Operation) {
  const t0 = Date.now();
  const tx = new Sdk.TransactionBuilder(await server.getAccount(k.G), { fee: '2000000', networkPassphrase: PASS }).addOperation(op).setTimeout(120).build();
  const s = await server.simulateTransaction(tx);
  if (Sdk.rpc.Api.isSimulationError(s)) return { ok: false, error: s.error.slice(0, 600), ms: Date.now() - t0 } as any;
  const ready = Sdk.rpc.assembleTransaction(tx, s).build();
  const sig = await k.signBytes(ready.hash());
  ready.signatures.push(new xdr.DecoratedSignature({ hint: k.raw.subarray(k.raw.length - 4), signature: sig }));
  const sent = await server.sendTransaction(ready);
  if (sent.status === 'ERROR') return { ok: false, error: `send: ${JSON.stringify(sent.errorResult ?? sent).slice(0, 300)}`, ms: Date.now() - t0 } as any;
  for (let i = 0; i < 40; i++) {
    const r = await server.getTransaction(sent.hash);
    if (r.status !== 'NOT_FOUND') return { ok: r.status === 'SUCCESS', hash: sent.hash, fee: r.status === 'SUCCESS' ? await feeOf(sent.hash) : undefined, error: r.status === 'SUCCESS' ? undefined : r.status, ms: Date.now() - t0 } as any;
    await new Promise((res) => setTimeout(res, 1000));
  }
  return { ok: false, hash: sent.hash, error: 'timeout', ms: Date.now() - t0 } as any;
}

async function stored(S: string, key: Buffer) {
  const k = xdr.LedgerKey.contractData(new xdr.LedgerKeyContractData({ contract: new Sdk.Address(S).toScAddress(), key: S_.scvBytes(key), durability: xdr.ContractDataDurability.temporary() }));
  const e = (await server.getLedgerEntries(k)).entries[0];
  return e ? { until: e.val.contractData().val().u32(), live: e.liveUntilLedgerSeq! } : undefined;
}
const classicSend = async (kp: Sdk.Keypair, op: xdr.Operation) => {
  const tx = new Sdk.TransactionBuilder(await horizon.loadAccount(kp.publicKey()), { fee: '1000', networkPassphrase: PASS }).addOperation(op).setTimeout(120).build();
  tx.sign(kp);
  const r: any = await horizon.submitTransaction(tx);
  return { ok: r.successful as boolean, hash: r.hash as string, fee: Number(r.fee_charged) };
};
const balance = async (g: string) => Number((await horizon.loadAccount(g)).balances.find((b: any) => b.asset_type === 'native')!.balance) * 1e7;

/** Graded move through S, paid by `feeSource` (a keypair). */
async function move(id: string, expectOk: boolean, S: string, signer: ReturnType<typeof proofSigner>, to: string, stroops: bigint, ruleId: number, feeSource = payer) {
  let r: any;
  try { r = await invokeAs({ feePayer: feeSource, op: xfer(to, stroops), account: st.account, ruleIds: [ruleId], signers: [signer] }); } catch (e: any) { r = { ok: false, error: String(e?.message ?? e).slice(0, 400) }; }
  const pass = r.ok === expectOk;
  log(pass ? 'PASS' : 'FAIL', id, r.ok ? `ok ${r.hash}` : `refused: ${short(r.error)}`);
  return { pass, ok: r.ok, hash: r.hash, error: r.ok ? undefined : short(r.error) };
}

const part = process.argv[2];

if (part === 'setup') {
  for (const kp of [payer, ownerA, ownerB, stranger, venue]) await friendbot(kp.publicKey());
  const fr = await (await fetch(`https://friendbot.stellar.org?addr=${ownerA.publicKey()}`)).text();
  record('friendbot', { sample: fr.slice(0, 160), funded: [ownerA.publicKey(), ownerB.publicKey(), stranger.publicKey(), venue.publicKey(), payer.publicKey()] });
  if (!st.account) {
    const policies = S_.scvMap([entry(addr(SIMPLE_THRESHOLD), S_.scvMap([entry(sym('threshold'), u32(2))]))]);
    const { ret, hash } = await submit(ownerA, Sdk.Operation.createCustomContract({ address: Sdk.Address.fromString(ownerA.publicKey()), wasmHash: Buffer.from(ACCOUNT_WASM_HASH, 'hex'),
      constructorArgs: [vec([delegated(ownerA.publicKey()), delegated(ownerB.publicKey())]), policies], salt: Buffer.from(Sdk.Keypair.random().rawPublicKey()) }));
    save({ account: Sdk.Address.fromScVal(ret!).toString(), accountTx: hash }); log('Prime Account', st.account, hash);
    const f = await submit(payer, new Sdk.Contract(XLM).call('transfer', addr(payer.publicKey()), addr(st.account), Sdk.nativeToScVal(300_000_000n, { type: 'i128' })));
    log('funded 30 XLM', f.hash);
  }
  // S2: predicted S addresses equal the deployed ones.
  const salt = sessionSalt(st.account);
  for (const [tag, kp, extra] of [['S_a', ownerA, ''], ['S_b', ownerB, ''], ['S_x', stranger, '']] as const) {
    const predicted = contractIdFor(kp.publicKey(), salt);
    if (!st[tag]) {
      const { ret, hash } = await submit(kp, Sdk.Operation.createCustomContract({ address: Sdk.Address.fromString(kp.publicKey()), wasmHash: Buffer.from(SESSION_WASM_HASH, 'hex'), constructorArgs: [addr(kp.publicKey())], salt }));
      const deployed = Sdk.Address.fromScVal(ret!).toString();
      save({ [tag]: deployed, [`${tag}Tx`]: hash, [`${tag}Predicted`]: predicted, [`${tag}Fee`]: await feeOf(hash) });
    }
    log(tag, st[tag], predicted === st[tag] ? 'matches the predicted id' : `MISMATCH predicted ${predicted}`);
  }
  // A different deployer at the same salt gives another id (the owner is part of the address).
  const other = contractIdFor(ownerB.publicKey(), salt);
  record('S2', { pass: st.S_a === contractIdFor(ownerA.publicKey(), salt) && st.S_b === contractIdFor(ownerB.publicKey(), salt) && st.S_x === contractIdFor(stranger.publicKey(), salt) && other !== st.S_a,
    detail: 'deployer = owner G, salt = sha256("prime-session" || account C raw id), constructor [owner]; predicted id equals deployed id for 3 owners; same salt under a different deployer gives a different id',
    account: st.account, S_a: st.S_a, S_b: st.S_b, S_x: st.S_x, deployTx: { S_a: st.S_aTx, S_b: st.S_bTx, S_x: st.S_xTx }, deployFeeStroops: st.S_aFee, wasm: SESSION_WASM_HASH });
  log('S2', res.S2.pass ? 'PASS' : 'FAIL');
  save({ venue: venue.publicKey() });
}

if (part === 's1') {
  // Install the Session moves rule on the 2-of-2 account: signers Delegated(S_a), Delegated(S_b), simple_threshold 1, interpreter predicate.
  if (st.ruleId === undefined) {
    const args = sessionMovesRuleArgs(st.account, [st.S_a, st.S_b], st.venue, MAX_PER_MOVE, 'session-moves');
    const r = await invokeAs({ feePayer: payer, op: call('add_context_rule', ...args), account: st.account, ruleIds: [0], signers: [seat(ownerA), seat(ownerB)] });
    log('install Session moves rule', r.ok ? r.hash : short(r.error));
    if (!r.ok) { record('S1', { pass: false, installError: short(r.error) }); process.exit(1); }
    const n = Number(Sdk.scValToNative((await sim(call('get_context_rules_count'))).result.retval));
    let id = -1;
    for (let i = 0; i < n + 10; i++) { const s = await sim(call('get_context_rule', u32(i))); if (!s.error && (Sdk.scValToNative(s.result.retval) as any).name === 'session-moves') { id = i; break; } }
    save({ ruleId: id, installTx: r.hash });
  }
  const ruleId = st.ruleId as number;
  const until = (await now()) + 720;
  const ka = Sdk.Keypair.random(), kb = Sdk.Keypair.random(), kx = Sdk.Keypair.random();
  const grants: Record<string, any> = {};
  for (const [tag, owner, S, k] of [['a', ownerA, st.S_a, ka], ['b', ownerB, st.S_b, kb], ['x', stranger, st.S_x, kx]] as const) {
    const r = await sendGrant(kpSigner(payer), S, k.rawPublicKey(), until, [await authorize(owner, S, k.rawPublicKey(), until)]);
    grants[tag] = { ok: r.ok, hash: r.hash, fee: r.fee, error: r.error };
    log('grant', tag, r.ok ? r.hash : r.error);
  }
  const D = st.venue as string;
  const results: Record<string, any> = {};
  results.moveViaA = await move('S1 move via S_a inside band', true, st.S_a, proofSigner(st.S_a, ka), D, 10_000_000n, ruleId);
  results.moveViaB = await move('S1 move via S_b inside band', true, st.S_b, proofSigner(st.S_b, kb), D, 10_000_000n, ruleId);
  results.otherDestination = await move('S1 other destination', false, st.S_a, proofSigner(st.S_a, ka), stranger.publicKey(), 10_000_000n, ruleId);
  results.amountZero = await move('S1 amount 0', false, st.S_a, proofSigner(st.S_a, ka), D, 0n, ruleId);
  results.amountMaxPlus1 = await move('S1 amount max + 1', false, st.S_a, proofSigner(st.S_a, ka), D, MAX_PER_MOVE + 1n, ruleId);
  results.amountMax = await move('S1 amount == max (control)', true, st.S_a, proofSigner(st.S_a, ka), D, MAX_PER_MOVE, ruleId);
  results.strangerS = await move("S1 stranger's S (not in the rule)", false, st.S_x, proofSigner(st.S_x, kx), D, 10_000_000n, ruleId);
  results.wrongKey = await move('S1 S_a signed by an ungranted key', false, st.S_a, proofSigner(st.S_a, Sdk.Keypair.random()), D, 10_000_000n, ruleId);
  const pass = Object.values(results).every((r: any) => r.pass);
  record('S1', { pass, shape: 'one rule, two Delegated(prime-session) signers (A1 holds if pass)', account: st.account, ruleId, ruleInstallTx: st.installTx, S_a: st.S_a, S_b: st.S_b, grants, results, maxPerMoveStroops: String(MAX_PER_MOVE), destination: D });
  log('S1', pass ? 'PASS' : 'FAIL');
}

if (part === 's3') {
  // TTL: the key extends the instance of S and the code past until + 1000.
  const key = Sdk.Keypair.random();
  const until = (await now()) + 720;
  const g = await sendGrant(kpSigner(payer), st.S_a, key.rawPublicKey(), until, [await authorize(ownerA, st.S_a, key.rawPublicKey(), until)]);
  const instKey = xdr.LedgerKey.contractData(new xdr.LedgerKeyContractData({ contract: new Sdk.Address(st.S_a).toScAddress(), key: S_.scvLedgerKeyContractInstance(), durability: xdr.ContractDataDurability.persistent() }));
  const codeKey = xdr.LedgerKey.contractCode(new xdr.LedgerKeyContractCode({ hash: Buffer.from(SESSION_WASM_HASH, 'hex') }));
  const read = async () => { const r = await server.getLedgerEntries(instKey, codeKey); return { latest: await now(), inst: r.entries.find((e) => e.key.switch().name === 'contractData')!.liveUntilLedgerSeq!, code: r.entries.find((e) => e.key.switch().name === 'contractCode')!.liveUntilLedgerSeq! }; };
  const before = await read();
  // A 7-day session ends 120,960 ledgers out; the default instance TTL is about the same, so the extension is needed.
  const target = before.latest + 120_960 + 1000;
  // extendTo is counted from the current ledger; ask for the target plus margin so the entry outlives it.
  const extendTo = target + 2000 - before.latest;
  const sorobanData = new Sdk.SorobanDataBuilder().setReadOnly([instKey, codeKey]).build();
  const tx = new Sdk.TransactionBuilder(await server.getAccount(payer.publicKey()), { fee: '1000000', networkPassphrase: PASS }).addOperation(Sdk.Operation.extendFootprintTtl({ extendTo })).setSorobanData(sorobanData).setTimeout(120).build();
  const prepared = await server.prepareTransaction(tx); prepared.sign(payer);
  const sent = await server.sendTransaction(prepared);
  let ok = false;
  for (let i = 0; i < 40; i++) { const r = await server.getTransaction(sent.hash); if (r.status === 'SUCCESS') { ok = true; break; } if (r.status === 'FAILED') break; await new Promise((r) => setTimeout(r, 1000)); }
  const after = await read();
  const fee = ok ? await feeOf(sent.hash) : undefined;
  const pass = ok && after.inst > before.inst && after.inst > target && after.code >= target;
  record('S3', { pass, grantTx: g.hash, extendTx: sent.hash, extendFeeStroops: fee, until, target, before, after, note: 'target = a 7-day session end + 1000; source = a G account (a session key pays the same way); the code entry was already at 180 days from the step 1 extension, so the extension left it unchanged' });
  log('S3', pass ? 'PASS' : 'FAIL', JSON.stringify({ before, after, fee }));
}

if (part === 's4') {
  // Start with a WebCrypto Ed25519 key: owner createAccount(keyG, 2 XLM), owner entry for grant(key, until), the key's account sends the grant.
  const k = await webKey();
  const until = (await now()) + 17280;
  const ownerBefore = await balance(ownerA.publicKey());
  const created = await classicSend(ownerA, Sdk.Operation.createAccount({ destination: k.G, startingBalance: '2' }));
  const entryOwner = await authorize(ownerA, st.S_a, k.raw, until);
  const g = await sendOpWeb(k, grantOp(st.S_a, k.raw, until, [entryOwner]));
  const s = await stored(st.S_a, k.raw);
  const keyBal = await balance(k.G);
  const pass = created.ok && g.ok && s?.until === until && k.extractable === false;
  record('S4', { pass, key: k.G, extractable: k.extractable, until, createAccountTx: created.hash, createAccountFee: created.fee, grantTx: g.hash, grantFeeStroops: g.fee, storedUntil: s?.until, storedLive: s?.live, keyBalanceStroopsAfterGrant: keyBal, ownerBalanceBefore: ownerBefore, grantSentBy: 'the key G account (fee paid by the key)' });
  save({ s4Key: { G: k.G, raw: k.raw.toString('hex') } });
  log('S4', pass ? 'PASS' : 'FAIL', g.error ?? '');
  // Keep the WebCrypto key for S5 in the same process: write a marker so s5 can run right after.
  (globalThis as any).__k = k;
  if (process.argv[3] === 'with-s5') await s5(k, until, ownerBefore);
}

async function s5(k: WebKey, until: number, ownerBefore: number) {
  const ownerPre = await balance(ownerA.publicKey());
  // Revoke: owner entry for grant(key, 0), key sends it.
  const entry0 = await authorize(ownerA, st.S_a, k.raw, 0);
  const rv = await sendOpWeb(k, grantOp(st.S_a, k.raw, 0, [entry0]));
  // Enforce-mode simulation of a move signed by the key with the owner as source.
  const r = await invokeAs({ feePayer: ownerA, op: xfer(st.venue, 10_000_000n), account: st.account, ruleIds: [st.ruleId], signers: [webProofSigner(st.S_a, k)] }).catch((e: any) => ({ ok: false, error: String(e?.message ?? e) } as any));
  const refusal = short(r.error);
  // accountMerge to the owner, signed by the key.
  const keyBal = await balance(k.G);
  const mergeTx = new Sdk.TransactionBuilder(await server.getAccount(k.G), { fee: '1000', networkPassphrase: PASS }).addOperation(Sdk.Operation.accountMerge({ destination: ownerA.publicKey() })).setTimeout(120).build();
  mergeTx.signatures.push(new xdr.DecoratedSignature({ hint: k.raw.subarray(k.raw.length - 4), signature: await k.signBytes(mergeTx.hash()) }));
  const mr: any = await horizon.submitTransaction(mergeTx);
  let gone = false; try { await horizon.loadAccount(k.G); } catch { gone = true; }
  const ownerPost = await balance(ownerA.publicKey());
  const storedAfter = await stored(st.S_a, k.raw);
  const pass = rv.ok && !r.ok && /Error\(Contract, #1\)/.test(refusal) && gone && mr.successful;
  record('S5', { pass, revokeTx: rv.hash, revokeFeeStroops: rv.fee, refusal, mergeTx: mr.hash, mergeFeeStroops: Number(mr.fee_charged), keyBalanceBeforeMerge: keyBal, keyAccountGone: gone, ownerBalanceBeforeRevoke: ownerPre, ownerBalanceAfterMerge: ownerPost, storedAfterRevoke: storedAfter, note: 'revoke sent by the key; the key account merged to the owner afterwards' });
  log('S5', pass ? 'PASS' : 'FAIL', refusal);
}

if (part === 's6') {
  // Owner ends without the key: owner signs grant(key, 0) and sends from its own account.
  const key = Sdk.Keypair.random();
  const until = (await now()) + 720;
  const g = await sendGrant(kpSigner(payer), st.S_a, key.rawPublicKey(), until, [await authorize(ownerA, st.S_a, key.rawPublicKey(), until)]);
  const ok1 = await move('S6 control: move before revoke', true, st.S_a, proofSigner(st.S_a, key), st.venue, 10_000_000n, st.ruleId);
  const rv = await sendGrant(kpSigner(ownerA), st.S_a, key.rawPublicKey(), 0, [await authorize(ownerA, st.S_a, key.rawPublicKey(), 0)]);
  const after = await move('S6 move after owner-only revoke', false, st.S_a, proofSigner(st.S_a, key), st.venue, 10_000_000n, st.ruleId, ownerA);
  const pass = ok1.pass && rv.ok && after.pass && /Error\(Contract, #1\)/.test(after.error ?? '');
  // A later re-grant of the revoked key must also fail (final).
  const re = await sendGrant(kpSigner(payer), st.S_a, key.rawPublicKey(), until, [await authorize(ownerA, st.S_a, key.rawPublicKey(), until)]);
  record('S6', { pass: pass && !re.ok, grantTx: g.hash, controlMove: ok1, revokeTx: rv.hash, revokeFeeStroops: rv.fee, revokeSentBy: 'owner own account, key not involved', moveAfter: after, regrantRefused: !re.ok, regrantError: short(re.error) });
  log('S6', res.S6.pass ? 'PASS' : 'FAIL');
}

if (part === 's7') {
  const key = Sdk.Keypair.random();
  const until = (await now()) + 15;
  const g = await sendGrant(kpSigner(payer), st.S_a, key.rawPublicKey(), until, [await authorize(ownerA, st.S_a, key.rawPublicKey(), until)]);
  const early = await move('S7 control: move inside the session', true, st.S_a, proofSigner(st.S_a, key), st.venue, 10_000_000n, st.ruleId);
  await untilLedger(until + 1);
  const late = await move('S7 move at until + 1', false, st.S_a, proofSigner(st.S_a, key), st.venue, 10_000_000n, st.ruleId);
  const s = await stored(st.S_a, key.rawPublicKey());
  record('S7', { pass: g.ok && early.pass && late.pass && /Error\(Contract, #1\)/.test(late.error ?? ''), grantTx: g.hash, until, controlMove: early, moveAtUntilPlus1: late, storedEntry: s ?? 'absent' });
  log('S7', res.S7.pass ? 'PASS' : 'FAIL');
}
