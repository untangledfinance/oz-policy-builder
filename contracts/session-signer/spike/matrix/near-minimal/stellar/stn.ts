// Stellar matrix (testnet), NEAR-routed: an OZ smart account with OctoGate rules.
//   rule 0 (2-of-3, weighted_threshold 1/1/1 >= 2): Delegated G accounts only:
//     Freighter's own key; MetaMask's and Phantom's NEAR MPC ed25519 keys (eth-implicit / our text wallet contract).
//   sessions: one session-signer per wallet (owner = the same key) is the only signer of that wallet's session rule
//     (XLM to VENUE only) and is in no other rule. The owner signs one SEP-53 grant (Freighter signMessage; NEAR MPC
//     signs the SEP-53 digest for MetaMask / Phantom), then the session key signs each move. Fee: the relayer, or the
//     session key's own G account.
import { existsSync, readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { Sdk, XLM, friendbot, invokeAs, keypair, localSigner, accountSig, log, server, submit } from './stellar.ts';
const { edKey, edSign, stats } = await import('./nearsig.ts');
const PS = '/home/ubuntu/git/github.com/untangledfinance/oz-policy-builder/packages/policy-synth/src';
const { encodePredicate } = await import(`${PS}/predicate/encode.ts`);
const { buildAddContextRuleArgs } = await import(`${PS}/install/build-add-context-rule.ts`);
const S_ = Sdk.xdr.ScVal;
const WASM = '/home/ubuntu/git/github.com/untangledfinance/oz-policy-builder/contracts/session-signer/target/wasm32v1-none/release/session_signer.wasm';
const ACCOUNT_WASM_HASH = '91a2cd56ba1a75d78eeb8ddc5d1841c5d439b7726a140bc84c850f73396298a9';
const WEIGHTED = 'CCTNRFZCL45GTJICA3Z2KFQO3VEGBHGCVBLHQ3GLJKAGACQIJMYJS7T2';
const INTERPRETER = 'CCBHVZ6HGGV7C4SNHCZ3S5665Z2WEMHTMBAEPO4XW6PKON464BEBANU5';
const FILE = 'state-stn.json';
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
const now = async () => (await server.getLatestLedger()).sequence;
const sha = (b: Buffer) => Sdk.hash(b);

// ── Wallets ────────────────────────────────────────────────────────────────────────────────────
type Wallet = 'MetaMask' | 'Freighter' | 'Phantom';
const PATH = 'prime:stellar';
type W = { name: Wallet | string; pub: Buffer; G: string; signRaw: (m: Buffer) => Promise<Buffer>; sep53: (text: string) => Promise<Buffer> };
const sep53Digest = (text: string) => sha(Buffer.concat([Buffer.from('Stellar Signed Message:\n'), Buffer.from(text, 'utf8')]));
function freighterSignMessage(text: string): Buffer { // Freighter's signMessage code path (SEP-53)
  const d = mkdtempSync(`${tmpdir()}/fsign-`); writeFileSync(`${d}/m.txt`, text);
  try { return Buffer.from(execFileSync('bun', ['freighter-sign.ts', FREIGHTER_FILE, `${d}/m.txt`], { encoding: 'utf8' }), 'base64'); } finally { rmSync(d, { recursive: true }); }
}
const viaNear = async (name: 'MetaMask' | 'Phantom' | 'Freighter', path = PATH): Promise<W> => {
  const pub = Buffer.from(await edKey(name, path));
  return { name, pub, G: Sdk.StrKey.encodeEd25519PublicKey(pub), signRaw: async (m) => Buffer.from(await edSign(name, path, m)), sep53: async (t) => Buffer.from(await edSign(name, path, sep53Digest(t))) };
};
const FR: W = { name: 'Freighter', pub: kF.rawPublicKey(), G: kF.publicKey(), signRaw: async (m) => kF.sign(m), sep53: async (t) => freighterSignMessage(t) };
const MM = await viaNear('MetaMask'), PH = await viaNear('Phantom');
const PH_OTHER_PATH = await viaNear('Phantom', 'prime:stellar-other');
const seat = (w: W, signAs: W = w) => ({ address: w.G, signNested: async (p: Buffer) => accountSig(signAs.pub, await signAs.signRaw(p)) });
const S_OF: Record<Wallet, string> = { MetaMask: 'S_mm', Freighter: 'S_fr', Phantom: 'S_ph' };

const grantText = (S: string, key: Buffer, until: number) => `Prime session\ncontract: ${S}\nsession key: ${key.toString('hex')}\nvalid until ledger: ${until}`;
type Session = { kp: Sdk.Keypair; until: number; S: string; signer: { address: string; signNested: (p: Buffer) => Promise<Sdk.xdr.ScVal> } };
async function session(w: W, o: { ledgers?: number; S?: string; signAs?: W; sign?: (t: string) => Promise<Buffer>; signedUntil?: number } = {}): Promise<Session> {
  const S = o.S ?? st[S_OF[w.name as Wallet]]; const kp = Sdk.Keypair.random(); const until = (await now()) + (o.ledgers ?? 720);
  const text = grantText(S, kp.rawPublicKey(), o.signedUntil ?? until);
  const rs = o.sign ? await o.sign(text) : await (o.signAs ?? w).sep53(text);
  return { kp, until, S, signer: { address: S, signNested: async (p: Buffer) => vec([S_.scvBytes(kp.rawPublicKey()), u32(until), S_.scvBytes(rs), S_.scvBytes(kp.sign(p))]) } };
}

const results: Record<string, unknown> = { ...(st.results ?? {}) };
async function run(name: string, expectOk: boolean, op: Sdk.xdr.Operation, ruleIds: number[], signers: any[], feePayer = fee) {
  let r: any;
  try { r = await invokeAs({ feePayer, op, account: st.prime, ruleIds, signers }); } catch (e: any) { r = { ok: false, error: String(e?.message ?? e).slice(0, 300), ms: 0 }; }
  const pass = r.ok === expectOk;
  results[name] = { pass, ok: r.ok, hash: r.hash, error: r.ok ? undefined : short(r.error) };
  log(pass ? 'PASS' : 'FAIL', name, r.ok ? `ok ${r.ms} ms ${r.hash}${feePayer === fee ? '' : ' (fee paid by the session key)'}` : `refused: ${short(r.error)}`);
  save({ results }); return r;
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
const part = process.argv[2];

if (part === 'setup') {
  await friendbot(fee.publicKey()); await friendbot(FR.G); await friendbot(MM.G); await friendbot(PH.G);
  log('seats', { MetaMask: MM.G, Freighter: FR.G, Phantom: PH.G });
  if (!st.venue) { const v = Sdk.Keypair.random(); await friendbot(v.publicKey()); const o = Sdk.Keypair.random(); await friendbot(o.publicKey()); save({ venue: v.publicKey(), other: o.publicKey() }); }
  if (!st.wasm) {
    const { ret, hash } = await submit(fee, Sdk.Operation.uploadContractWasm({ wasm: readFileSync(WASM) }));
    save({ wasm: Buffer.from(ret!.bytes()).toString('hex'), wasmTx: hash }); log('session-signer wasm', st.wasm, hash);
  }
  for (const [k, w] of [['S_mm', MM], ['S_fr', FR], ['S_ph', PH]] as const) {
    if (st[k]) continue;
    const { ret, hash } = await submit(fee, Sdk.Operation.createCustomContract({ address: Sdk.Address.fromString(fee.publicKey()), wasmHash: Buffer.from(st.wasm, 'hex'), constructorArgs: [S_.scvBytes(w.pub)], salt: Buffer.from(Sdk.Keypair.random().rawPublicKey()) }));
    save({ [k]: Sdk.Address.fromScVal(ret!).toString() }); log(k, st[k], hash);
  }
  save({ G_mm: MM.G, G_fr: FR.G, G_ph: PH.G });
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
  check('P0. rule 0 signers are exactly the three wallet G keys (no session-signer)', [MM.G, FR.G, PH.G].every((g) => signers.includes(g)) && ![st.S_mm, st.S_fr, st.S_ph].some((s) => signers.includes(s)) && r0.signers.length === 3, signers.slice(0, 300));
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
}
if (part === 'rules') {
  for (const [name, S] of [['xlm_mm', st.S_mm], ['xlm_fr', st.S_fr], ['xlm_ph', st.S_ph]] as const)
    if ((await ruleId(name)) < 0) await run(`R-${name}. MetaMask + Freighter install ${name}: XLM to VENUE only, signer: that wallet's session-signer`, true, call('add_context_rule', ...xlmRule(name, S)), [0], [seat(MM), seat(FR)]);
  save({ r_mm: await ruleId('xlm_mm'), r_fr: await ruleId('xlm_fr'), r_ph: await ruleId('xlm_ph') });
  log('rules', st.r_mm, st.r_fr, st.r_ph);
}
if (part === 'separation') {
  // A session can never vote as a seat.
  const ph = await session(PH), mm = await session(MM);
  await run("N1. Phantom's session-signer + Freighter on rule 0", false, tmpRule('n1'), [0], [ph.signer, seat(FR)]);
  await run("N2. MetaMask's and Phantom's session-signers on rule 0", false, tmpRule('n2'), [0], [mm.signer, ph.signer]);
  await run("N3. Phantom session claims its session rule for an account-admin call", false, tmpRule('n3'), [st.r_ph], [ph.signer]);
  const kpG = ph.kp; await friendbot(kpG.publicKey());
  await run("N4. the session key's own G account + Freighter on rule 0", false, tmpRule('n4'), [0], [localSigner(kpG), seat(FR)]);
  await run("N5. Phantom session removes rule 0 through its session rule", false, call('remove_context_rule', u32(0)), [st.r_ph], [ph.signer]);
}
if (part === 'sessions') {
  const ids: Record<string, number> = { MetaMask: st.r_mm, Freighter: st.r_fr, Phantom: st.r_ph };
  for (const w of [MM, FR, PH]) {
    const s = await session(w);
    log(`${w.name}: one ${w.name === 'Freighter' ? 'Freighter signMessage' : 'NEAR MPC'} signature -> session key ${s.kp.publicKey()} until ledger ${s.until}`);
    const b = await xlmBal(st.venue);
    await run(`Q-${w.name}1. relayer pays: 1 XLM to VENUE`, true, xfer(st.venue, 10_000_000n), [ids[w.name]!], [s.signer]);
    await friendbot(s.kp.publicKey());
    await run(`Q-${w.name}2. relayer down: the session key's own account pays the fee, 1 XLM to VENUE`, true, xfer(st.venue, 10_000_000n), [ids[w.name]!], [s.signer], s.kp);
    check(`Q-${w.name}3. VENUE received exactly 2 XLM`, (await xlmBal(st.venue)) - b === 20_000_000n, `${(await xlmBal(st.venue)) - b} stroops`);
    const broke = await session(w);
    await run(`Q-${w.name}4. relayer down and the session key has no account`, false, xfer(st.venue, 10_000_000n), [ids[w.name]!], [broke.signer], broke.kp);
    await run(`Q-${w.name}5. 1 XLM elsewhere`, false, xfer(st.other, 10_000_000n), [ids[w.name]!], [s.signer]);
    const other = w === PH ? st.r_mm : st.r_ph;
    await run(`Q-${w.name}6. on another wallet's session rule`, false, xfer(st.venue, 10_000_000n), [other], [s.signer]);
  }
  const stretched = await session(PH, { ledgers: 720, signedUntil: (await now()) + 100 });
  await run('Q7. Phantom grant submitted with a later valid-until than signed', false, xfer(st.venue, 10_000_000n), [st.r_ph], [stretched.signer]);
  const long = await session(MM, { ledgers: 120_961 + 10 });
  await run('Q8. MetaMask grant longer than 7 days', false, xfer(st.venue, 10_000_000n), [st.r_mm], [long.signer]);
  // revoke: one owner signature over the grant text with ledger 0 (MetaMask through NEAR, Freighter natively)
  for (const w of [MM, FR]) {
    const s = await session(w), s2 = await session(w);
    await run(`Q9-${w.name}a. session before revoke`, true, xfer(st.venue, 10_000_000n), [ids[w.name]!], [s.signer]);
    const sig = await w.sep53(grantText(st[S_OF[w.name as Wallet]], s.kp.rawPublicKey(), 0));
    const rv = await submit(fee, new Sdk.Contract(st[S_OF[w.name as Wallet]]).call('revoke', S_.scvBytes(s.kp.rawPublicKey()), S_.scvBytes(sig))).then((x) => ({ ok: true, hash: x.hash }), (e) => ({ ok: false, hash: String(e) }));
    check(`Q9-${w.name}b. ${w.name} revokes it (one signature, relayed)`, rv.ok, rv.hash);
    await run(`Q9-${w.name}c. the revoked session`, false, xfer(st.venue, 10_000_000n), [ids[w.name]!], [s.signer]);
    await run(`Q9-${w.name}d. another live session of the same wallet still works`, true, xfer(st.venue, 10_000_000n), [ids[w.name]!], [s2.signer]);
  }
  const s = await session(PH);
  const bad = await PH.sep53(grantText(st.S_ph, s.kp.rawPublicKey(), 0)).then(() => FR.sep53(grantText(st.S_ph, s.kp.rawPublicKey(), 0)));
  const rv = await submit(fee, new Sdk.Contract(st.S_ph).call('revoke', S_.scvBytes(s.kp.rawPublicKey()), S_.scvBytes(bad))).then(() => true, () => false);
  check("Q10. Freighter cannot revoke a Phantom session", !rv, rv ? 'revoked!' : 'refused');
  const short3 = await session(PH, { ledgers: 3 });
  while ((await now()) <= short3.until + 1) await new Promise((r) => setTimeout(r, 2000));
  await run('Q11. expired Phantom session', false, xfer(st.venue, 10_000_000n), [st.r_ph], [short3.signer]);
}
if (part === 'cross') {
  const a = await session(FR, { signAs: PH });
  await run("X1. Freighter's session-signer with a grant signed by Phantom (NEAR)", false, xfer(st.venue, 10_000_000n), [st.r_fr], [a.signer]);
  const b = await session(MM, { sign: async (t) => FR.signRaw(Buffer.from(t)) });
  await run("X2. MetaMask's session-signer with Freighter's raw (non-SEP-53) signature", false, xfer(st.venue, 10_000_000n), [st.r_mm], [b.signer]);
  const c = await session(MM, { sign: async (t) => MM.signRaw(Buffer.from(t)) });
  await run('X3. MetaMask (NEAR) signs the grant text without the SEP-53 prefix', false, xfer(st.venue, 10_000_000n), [st.r_mm], [c.signer]);
  const d = await session(PH, { signAs: PH_OTHER_PATH });
  await run("X4. Phantom's session-signer with its MPC key under another path", false, xfer(st.venue, 10_000_000n), [st.r_ph], [d.signer]);
  const e = await session(PH, { S: st.S_mm, signAs: PH });
  await run("X5. Phantom grant (for MetaMask's session-signer) on MetaMask's rule", false, xfer(st.venue, 10_000_000n), [st.r_mm], [e.signer]);
  const f = await session(MM);
  const moved = { ...f.signer, address: st.S_ph };
  await run("X6. MetaMask grant presented to Phantom's session-signer", false, xfer(st.venue, 10_000_000n), [st.r_ph], [moved]);
}
if (part === 'summary') {
  const r = Object.entries(results) as any;
  log(`${r.filter((x: any) => x[1].pass).length}/${r.length} passed; NEAR MPC signatures this part: ${stats.calls}`);
  for (const [n, x] of r) if (!x.pass) log('FAIL', n, x.error ?? x.detail);
}
if (stats.calls) { save({ [`mpc_${part}`]: stats }); log(`NEAR MPC: ${stats.calls} signatures, average ${(stats.ms / stats.calls / 1000).toFixed(1)}s`); }
process.exit(0);
