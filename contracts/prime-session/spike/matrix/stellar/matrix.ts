// Historical (earlier version): the session-signer path below is now contracts/prime-session, and its source has changed since.
// Prime on Stellar (testnet), every wallet family, no NEAR:
//   rule 0 (2-of-3, weighted_threshold 1/1/1 >= 2):
//     S_mm  = session-signer v3, owner Evm(MetaMask)      - MetaMask's seat (EIP-712 grant)
//     F     = Freighter's own Stellar account (Delegated)  - Freighter's seat (native)
//     S_ph  = session-signer v3, owner Solana(Phantom)     - Phantom's seat (signMessage text grant)
//   session rules (XLM transfer to VENUE only, one per wallet): S_mm, S_fr (owner Stellar(Freighter), SEP-53 grant), S_ph.
import { existsSync, readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { sha256 as vsha, toBytes, toHex } from 'viem';
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import { Sdk, XLM, friendbot, invokeAs, keypair, localSigner, log, server, submit } from './stellar.ts';
import { DOMAIN, TYPES } from './eip712.ts';
import { metamask } from './mm.ts';
const PS = '/home/ubuntu/git/github.com/untangledfinance/oz-policy-builder/packages/policy-synth/src';
const { encodePredicate } = await import(`${PS}/predicate/encode.ts`);
const { buildAddContextRuleArgs } = await import(`${PS}/install/build-add-context-rule.ts`);
const S_ = Sdk.xdr.ScVal;
const WASM = '/home/ubuntu/git/github.com/untangledfinance/oz-policy-builder/contracts/session-signer/target/wasm32v1-none/release/session_signer.wasm';
const ACCOUNT_WASM_HASH = '91a2cd56ba1a75d78eeb8ddc5d1841c5d439b7726a140bc84c850f73396298a9';
const WEIGHTED = 'CCTNRFZCL45GTJICA3Z2KFQO3VEGBHGCVBLHQ3GLJKAGACQIJMYJS7T2';
const INTERPRETER = 'CCBHVZ6HGGV7C4SNHCZ3S5665Z2WEMHTMBAEPO4XW6PKON464BEBANU5';
const FILE = 'state-matrix.json';
const st: Record<string, any> = existsSync(FILE) ? JSON.parse(readFileSync(FILE, 'utf8')) : {};
const save = (p: Record<string, unknown>) => { Object.assign(st, p); writeFileSync(FILE, JSON.stringify(st, null, 1)); };
const fee = keypair('secrets/fee-payer.json');
const FREIGHTER_FILE = '/home/ubuntu/work/near-wallet-spike/secrets/freighter-b.json'; // the same Freighter key as on NEAR/Solana/EVM (controls NEAR account 0s2ee0a8… as its extension)
const kF = Sdk.Keypair.fromSecret(JSON.parse(readFileSync(FREIGHTER_FILE, 'utf8')).secret);
const phSecret = bs58.decode(JSON.parse(readFileSync('/home/ubuntu/work/phantom-spike/secrets/phantom-test.json', 'utf8')).secret); // the same Phantom key
const phantom = nacl.sign.keyPair.fromSecretKey(phSecret.length === 64 ? phSecret : nacl.sign.keyPair.fromSeed(phSecret).secretKey);
const sym = (s: string) => S_.scvSymbol(s), u32 = (n: number) => S_.scvU32(n), vec = (x: Sdk.xdr.ScVal[]) => S_.scvVec(x);
const addr = (a: string) => new Sdk.Address(a).toScVal();
const delegated = (a: string) => vec([sym('Delegated'), addr(a)]);
const map = (e: [Sdk.xdr.ScVal, Sdk.xdr.ScVal][]) => S_.scvMap(e.map(([k, v]) => new Sdk.xdr.ScMapEntry({ key: k, val: v }))
  .sort((l, r) => (l.key().switch().name === 'scvSymbol' && r.key().switch().name === 'scvSymbol') ? Buffer.compare(Buffer.from(l.key().sym()), Buffer.from(r.key().sym())) : Buffer.compare(l.key().toXDR(), r.key().toXDR())));
const short = (e?: string) => [...new Set((e ?? '').match(/Error\([A-Za-z]+, #?\w+\)/g) ?? [])].join(' ') || (e ?? '').slice(0, 200);
const now = async () => (await server.getLatestLedger()).sequence;
const NET = vsha(toBytes(Sdk.Networks.TESTNET)).slice(2);

// ── Grants ─────────────────────────────────────────────────────────────────
type Wallet = 'MetaMask' | 'Freighter' | 'Phantom';
const grantText = (S: string, key: Buffer, until: number) =>
  `Prime session\ncontract: ${S}\nsession key: ${key.toString('hex')}\nvalid until ledger: ${until}\nnetwork: ${NET}`;
function freighterSignMessage(text: string): Buffer { // Freighter's signMessage code path (SEP-53)
  const d = mkdtempSync(`${tmpdir()}/fsign-`); writeFileSync(`${d}/m.txt`, text);
  try { return Buffer.from(execFileSync('bun', ['freighter-sign.ts', FREIGHTER_FILE, `${d}/m.txt`], { encoding: 'utf8' }), 'base64'); } finally { rmSync(d, { recursive: true }); }
}
async function grant(w: Wallet, S: string, key: Buffer, until: number): Promise<{ rs: Buffer; v: number }> {
  if (w === 'MetaMask') {
    const g = await metamask.signTypedData({ domain: DOMAIN, types: TYPES, primaryType: 'PrimeSession', message: { signer: S, sessionKey: toHex(key), validUntil: until, network: `0x${NET}` } });
    return { rs: Buffer.from(g.slice(2, 130), 'hex'), v: parseInt(g.slice(130, 132), 16) };
  }
  const text = grantText(S, key, until);
  if (w === 'Freighter') return { rs: freighterSignMessage(text), v: 0 };
  return { rs: Buffer.from(nacl.sign.detached(Buffer.from(text, 'utf8'), phantom.secretKey)), v: 0 }; // Phantom signMessage
}
const ssOf = (w: Wallet, purpose: 'seat' | 'session') => (w === 'MetaMask' ? st.S_mm : w === 'Phantom' ? st.S_ph : purpose === 'session' ? st.S_fr : null);
async function session(w: Wallet, ledgers = 720, o: { S?: string; signAs?: Wallet } = {}) {
  const S = o.S ?? ssOf(w, 'session'); const kp = Sdk.Keypair.random(); const until = (await now()) + ledgers;
  const { rs, v } = await grant(o.signAs ?? w, S, kp.rawPublicKey(), until);
  return { kp, until, S, signer: { address: S as string, signNested: async (p: Buffer) => vec([S_.scvBytes(kp.rawPublicKey()), u32(until), S_.scvBytes(rs), u32(v), S_.scvBytes(kp.sign(p))]) } };
}

const results: Record<string, unknown> = { ...(st.results ?? {}) };
async function run(name: string, expectOk: boolean, op: Sdk.xdr.Operation, ruleIds: number[], signers: any[]) {
  const r = await invokeAs({ feePayer: fee, op, account: st.prime, ruleIds, signers });
  const pass = r.ok === expectOk;
  results[name] = { pass, ok: r.ok, hash: r.hash, error: r.ok ? undefined : short(r.error) };
  log(pass ? 'PASS' : 'FAIL', name, r.ok ? `ok ${r.ms} ms ${r.hash}` : `refused: ${short(r.error)}`);
  save({ results }); return r;
}
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
const tmpRule = (name: string) => call('add_context_rule', vec([sym('CallContract'), addr(XLM)]), S_.scvString(name), S_.scvVoid(), vec([delegated(st.F)]), S_.scvMap([]));
const F = () => localSigner(kF);
const part = process.argv[2];

if (part === 'setup') {
  await friendbot(fee.publicKey()); await friendbot(kF.publicKey());
  if (!st.venue) { const v = Sdk.Keypair.random(); await friendbot(v.publicKey()); const o = Sdk.Keypair.random(); await friendbot(o.publicKey()); save({ venue: v.publicKey(), other: o.publicKey() }); }
  if (!st.wasm) {
    const { ret, hash } = await submit(fee, Sdk.Operation.uploadContractWasm({ wasm: readFileSync(WASM) }));
    save({ wasm: Buffer.from(ret!.bytes()).toString('hex'), wasmTx: hash }); log('session-signer v3 wasm', st.wasm, hash);
  }
  const owner = (kind: 'Evm' | 'Stellar' | 'Solana', b: Buffer) => vec([sym(kind), S_.scvBytes(b)]);
  for (const [k, o] of [['S_mm', owner('Evm', Buffer.from(metamask.address.slice(2), 'hex'))], ['S_fr', owner('Stellar', kF.rawPublicKey())], ['S_ph', owner('Solana', Buffer.from(phantom.publicKey))]] as const) {
    if (st[k]) continue;
    const { ret, hash } = await submit(fee, Sdk.Operation.createCustomContract({ address: Sdk.Address.fromString(fee.publicKey()), wasmHash: Buffer.from(st.wasm, 'hex'), constructorArgs: [o], salt: Buffer.from(Sdk.Keypair.random().rawPublicKey()) }));
    save({ [k]: Sdk.Address.fromScVal(ret!).toString() }); log(k, st[k], hash);
  }
  save({ F: kF.publicKey(), metamask: metamask.address, phantom: bs58.encode(phantom.publicKey) });
  if (!st.prime) {
    const weights = map([[sym('signer_weights'), map([[delegated(st.S_mm), u32(1)], [delegated(st.F), u32(1)], [delegated(st.S_ph), u32(1)]])], [sym('threshold'), u32(2)]]);
    const { ret, hash } = await submit(fee, Sdk.Operation.createCustomContract({ address: Sdk.Address.fromString(fee.publicKey()), wasmHash: Buffer.from(ACCOUNT_WASM_HASH, 'hex'),
      constructorArgs: [vec([st.S_mm, st.F, st.S_ph].map(delegated)), map([[addr(WEIGHTED), weights]])], salt: Buffer.from(Sdk.Keypair.random().rawPublicKey()) }));
    save({ prime: Sdk.Address.fromScVal(ret!).toString(), primeTx: hash }); log('Prime Account', st.prime, hash);
    const f = await submit(fee, new Sdk.Contract(XLM).call('transfer', addr(fee.publicKey()), addr(st.prime), Sdk.nativeToScVal(300_000_000n, { type: 'i128' })));
    log('funded 30 XLM', f.hash);
  }
}
if (part === 'seats') {
  const mm = await session('MetaMask'), ph = await session('Phantom');
  await run('Y1. Freighter alone adds a rule', false, tmpRule('y1'), [0], [F()]);
  await run('Y2. Phantom alone (its session-signer) adds a rule', false, tmpRule('y2'), [0], [ph.signer]);
  await run('Y3. MetaMask + Freighter add a rule', true, tmpRule('y_mf'), [0], [mm.signer, F()]);
  await run('Y4. Freighter + Phantom remove it', true, call('remove_context_rule', u32(await ruleId('y_mf'))), [0], [F(), ph.signer]);
  await run('Y5. MetaMask + Phantom add a rule', true, tmpRule('y_mp'), [0], [mm.signer, ph.signer]);
  await run('Y6. MetaMask + Phantom remove it', true, call('remove_context_rule', u32(await ruleId('y_mp'))), [0], [mm.signer, ph.signer]);
  const stranger = Sdk.Keypair.random(); await friendbot(stranger.publicKey());
  await run('Y7. outsider + Freighter', false, tmpRule('y7'), [0], [localSigner(stranger), F()]);
  const fake = await session('Phantom', 720, { signAs: 'Freighter' });
  await run('Y8. Phantom seat with a grant signed by Freighter (SEP-53) + MetaMask', false, tmpRule('y8'), [0], [fake.signer, mm.signer]);
}
if (part === 'rules') {
  const mm = await session('MetaMask');
  for (const [name, S] of [['xlm_mm', st.S_mm], ['xlm_fr', st.S_fr], ['xlm_ph', st.S_ph]] as const)
    if ((await ruleId(name)) < 0) await run(`R-${name}. MetaMask + Freighter install ${name}: XLM to VENUE only, signer ${name.slice(4)} session-signer`, true, call('add_context_rule', ...xlmRule(name, S)), [0], [mm.signer, F()]);
  save({ r_mm: await ruleId('xlm_mm'), r_fr: await ruleId('xlm_fr'), r_ph: await ruleId('xlm_ph') });
  log('rules', st.r_mm, st.r_fr, st.r_ph);
}
if (part === 'sessions') {
  const ids: Record<Wallet, number> = { MetaMask: st.r_mm, Freighter: st.r_fr, Phantom: st.r_ph };
  for (const w of ['MetaMask', 'Freighter', 'Phantom'] as Wallet[]) {
    const s = await session(w);
    log(`${w}: one signature -> session key ${s.kp.publicKey()} until ledger ${s.until}`);
    await run(`Q-${w}1. session alone: 1 XLM to VENUE`, true, xfer(st.venue, 10_000_000n), [ids[w]], [s.signer]);
    await run(`Q-${w}2. session alone: 1 XLM elsewhere`, false, xfer(st.other, 10_000_000n), [ids[w]], [s.signer]);
    await run(`Q-${w}3. session alone: change rule 0`, false, tmpRule('q3'), [0], [s.signer]);
  }
  const ph = await session('Phantom');
  await run('Q4. Phantom session on the MetaMask session rule', false, xfer(st.venue, 10_000_000n), [st.r_mm], [ph.signer]);
  const wrong = await session('Freighter', 720, { signAs: 'Phantom' });
  await run('Q5. Freighter session-signer with a Phantom-style (unprefixed) grant', false, xfer(st.venue, 10_000_000n), [st.r_fr], [wrong.signer]);
  const cross = await session('Phantom', 720, { S: st.S_mm, signAs: 'Phantom' });
  await run('Q6. Phantom grant presented to the MetaMask session-signer', false, xfer(st.venue, 10_000_000n), [st.r_mm], [cross.signer]);
  // Freighter revokes its own session: SEP-53 signature over the grant text with ledger 0.
  const fr = await session('Freighter');
  await run('Q7. Freighter session before revoke', true, xfer(st.venue, 10_000_000n), [st.r_fr], [fr.signer]);
  const g = await grant('Freighter', st.S_fr, fr.kp.rawPublicKey(), 0);
  const rv = await submit(fee, new Sdk.Contract(st.S_fr).call('revoke', S_.scvBytes(fr.kp.rawPublicKey()), S_.scvBytes(g.rs), u32(0)));
  log('Freighter revoked the session', rv.hash); results['Q8a. Freighter revokes its session (one SEP-53 signature, relayed)'] = { pass: true, hash: rv.hash };
  await run('Q8. revoked Freighter session', false, xfer(st.venue, 10_000_000n), [st.r_fr], [fr.signer]);
  const short3 = await session('Phantom', 3);
  while ((await now()) <= short3.until + 1) await new Promise((r) => setTimeout(r, 2000));
  await run('Q9. expired Phantom session', false, xfer(st.venue, 10_000_000n), [st.r_ph], [short3.signer]);
}
if (part === 'why') {
  // Q8/Q9 again, reading the session-signer's own error code: #2 revoked, #1 expired.
  const code = (e?: string) => (e ?? '').match(/Error\(Contract, #[12]\)/)?.[0] ?? 'no session-signer code';
  const fr = await session('Freighter');
  const g = await grant('Freighter', st.S_fr, fr.kp.rawPublicKey(), 0);
  await submit(fee, new Sdk.Contract(st.S_fr).call('revoke', S_.scvBytes(fr.kp.rawPublicKey()), S_.scvBytes(g.rs), u32(0)));
  const r1 = await invokeAs({ feePayer: fee, op: xfer(st.venue, 10_000_000n), account: st.prime, ruleIds: [st.r_fr], signers: [fr.signer] });
  results['Q8r. revoked Freighter session: session-signer code'] = { pass: !r1.ok && code(r1.error) === 'Error(Contract, #2)', error: code(r1.error) }; log('Q8r', code(r1.error));
  const ph = await session('Phantom', 3);
  while ((await now()) <= ph.until + 1) await new Promise((r) => setTimeout(r, 2000));
  const r2 = await invokeAs({ feePayer: fee, op: xfer(st.venue, 10_000_000n), account: st.prime, ruleIds: [st.r_ph], signers: [ph.signer] });
  results['Q9r. expired Phantom session: session-signer code'] = { pass: !r2.ok && code(r2.error) === 'Error(Contract, #1)', error: code(r2.error) }; log('Q9r', code(r2.error));
  save({ results });
}
if (part === 'summary') { const r = Object.entries(st.results ?? {}) as any; log(`${r.filter((x: any) => x[1].pass).length}/${r.length} passed`); for (const [n, x] of r) if (!x.pass) log('FAIL', n, x.error); }
