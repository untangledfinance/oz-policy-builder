// v2 session tests against Blend TestnetV2. No NEAR signature anywhere here.
import { sha256, toBytes, toHex } from 'viem';
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts';
import { Sdk, XLM, invokeAs, keypair, log, save, server, state, submit } from './stellar.ts';
import { DOMAIN, TYPES } from './eip712.ts';
import { metamask } from './mm.ts';
const POOL = 'CCEBVDYM32YNYCVNRXQKDFFPISJJCV557CDZEIRBEE4NCV4KHPQ44HGF';
const st = state();
const fee = keypair('secrets/fee-payer.json');
const PRIME: string = st.prime, SIGNER: string = st.signer2;
const S = Sdk.xdr.ScVal;
const sim = async (contract: string, fn: string, ...args: Sdk.xdr.ScVal[]) => {
  const tx = new Sdk.TransactionBuilder(await server.getAccount(fee.publicKey()), { fee: '100', networkPassphrase: Sdk.Networks.TESTNET }).addOperation(new Sdk.Contract(contract).call(fn, ...args)).setTimeout(30).build();
  return Sdk.scValToNative(((await server.simulateTransaction(tx)) as any).result.retval);
};
const n = Number(await sim(PRIME, 'get_context_rules_count'));
const ids: Record<string, number> = {};
for (let i = 0; i < n + 4 && Object.keys(ids).length < n; i++) { try { const r: any = await sim(PRIME, 'get_context_rule', S.scvU32(i)); ids[r.name] = i; } catch {} }
const POOL_RULE = ids.session_blend!, XLM_RULE = ids.session_xlm!;
log('rules', JSON.stringify(ids));
const now = async () => (await server.getLatestLedger()).sequence;
const network = sha256(toBytes(Sdk.Networks.TESTNET));
async function grantFor(key: Buffer, until: number, wallet = metamask, signer = SIGNER) {
  const sig = await wallet.signTypedData({ domain: DOMAIN, types: TYPES, primaryType: 'PrimeSession', message: { signer, sessionKey: toHex(key), validUntil: until, network } });
  return { rs: Buffer.from(sig.slice(2, 130), 'hex'), v: parseInt(sig.slice(130, 132), 16) };
}
async function session(ledgers: number, opts: { wallet?: typeof metamask; signer?: string; claim?: number } = {}) {
  const kp = Sdk.Keypair.random(), until = (await now()) + ledgers;
  const g = await grantFor(kp.rawPublicKey(), until, opts.wallet, opts.signer);
  return { kp, until, ...g, claim: opts.claim ?? until };
}
type Sess = Awaited<ReturnType<typeof session>>;
const as = (s: Sess) => [{ address: SIGNER, signNested: async (p: Buffer) => S.scvVec([S.scvBytes(s.kp.rawPublicKey()), S.scvU32(s.claim), S.scvBytes(s.rs), S.scvU32(s.v), S.scvBytes(s.kp.sign(p))]) }];
const req = (type: number, stroops: bigint) => S.scvMap([
  new Sdk.xdr.ScMapEntry({ key: S.scvSymbol('address'), val: new Sdk.Address(XLM).toScVal() }),
  new Sdk.xdr.ScMapEntry({ key: S.scvSymbol('amount'), val: Sdk.nativeToScVal(stroops, { type: 'i128' }) }),
  new Sdk.xdr.ScMapEntry({ key: S.scvSymbol('request_type'), val: S.scvU32(type) })]);
const submitOp = (reqs: Sdk.xdr.ScVal[], to = PRIME) => new Sdk.Contract(POOL).call('submit', new Sdk.Address(PRIME).toScVal(), new Sdk.Address(PRIME).toScVal(), new Sdk.Address(to).toScVal(), S.scvVec(reqs));
const short = (e?: string) => [...new Set((e ?? '').match(/Error\([A-Za-z]+, #?\w+\)/g) ?? [])].join(' ') || (e ?? '').slice(0, 160);
const results: Record<string, unknown> = { ...(st.moves2 ?? {}) };
async function run(name: string, expectOk: boolean, op: Sdk.xdr.Operation, ruleIds: number[], s: Sess) {
  const r = await invokeAs({ feePayer: fee, op, account: PRIME, ruleIds, signers: as(s) });
  const pass = r.ok === expectOk;
  results[name] = { pass, ok: r.ok, ms: r.ms, hash: r.hash, error: r.ok ? undefined : short(r.error) };
  log(pass ? 'PASS' : 'FAIL', name, r.ok ? `ok ${r.ms} ms ${r.hash}` : `refused: ${short(r.error)}`);
  save({ moves2: results });
  return r;
}
const supplied = async () => { const p: any = await sim(POOL, 'get_positions', new Sdk.Address(PRIME).toScVal()); return JSON.stringify(p, (_, v) => (typeof v === 'bigint' ? v.toString() : v)); };
const part = process.argv[2];

if (part === 'a') {
  const s = await session(720);
  log('positions before', await supplied());
  await run('1. supply 5 XLM to Blend (pool + nested XLM transfer, two rules)', true, submitOp([req(0, 50_000_000n)]), [POOL_RULE, XLM_RULE], s);
  await run('2. withdraw 2 XLM from Blend', true, submitOp([req(1, 20_000_000n)]), [POOL_RULE], s);
  log('positions after', await supplied());
  await run('3. borrow (request_type 4)', false, submitOp([req(4, 10_000_000n)]), [POOL_RULE], s);
  await run('4. withdraw to another address', false, submitOp([req(1, 10_000_000n)], fee.publicKey()), [POOL_RULE], s);
  await run('5. two requests in one submit', false, submitOp([req(0, 10_000_000n), req(0, 10_000_000n)]), [POOL_RULE, XLM_RULE], s);
  const selfCall = new Sdk.Contract(PRIME).call('remove_context_rule', S.scvU32(0));
  await run('6. session key removes rule 0', false, selfCall, [POOL_RULE], s);
  await run('7. XLM straight to the session holder', false, new Sdk.Contract(XLM).call('transfer', new Sdk.Address(PRIME).toScVal(), new Sdk.Address(fee.publicKey()).toScVal(), Sdk.nativeToScVal(10_000_000n, { type: 'i128' })), [XLM_RULE], s);
}
if (part === 'b') {
  await run('8. grant made for the v1 instance, used on v2', false, submitOp([req(1, 10_000_000n)]), [POOL_RULE], await session(720, { signer: st.signer }));
  await run('9. grant 7 days + 1 ledger ahead', false, submitOp([req(1, 10_000_000n)]), [POOL_RULE], await session(120_961));
  await run('10. grant exactly 7 days ahead', true, submitOp([req(1, 10_000_000n)]), [POOL_RULE], await session(120_960));
  await run('11. grant signed by another wallet', false, submitOp([req(1, 10_000_000n)]), [POOL_RULE], await session(720, { wallet: privateKeyToAccount(generatePrivateKey()) }));
}
if (part === 'c') {
  const r = await session(720), keep = await session(720);
  await run('12. session R works', true, submitOp([req(1, 10_000_000n)]), [POOL_RULE], r);
  const bad = await grantFor(r.kp.rawPublicKey(), 0, privateKeyToAccount(generatePrivateKey()));
  try { await submit(fee, new Sdk.Contract(SIGNER).call('revoke', S.scvBytes(r.kp.rawPublicKey()), S.scvBytes(bad.rs), S.scvU32(bad.v))); log('FAIL 13. revoke signed by a stranger went through'); results['13. revoke by a stranger'] = { pass: false }; }
  catch (e) { log('PASS 13. revoke signed by a stranger refused:', short(String(e))); results['13. revoke by a stranger'] = { pass: true }; }
  const t0 = Date.now();
  const g = await grantFor(r.kp.rawPublicKey(), 0); // the owner's "end session" signature (off chain)
  const rv = await submit(fee, new Sdk.Contract(SIGNER).call('revoke', S.scvBytes(r.kp.rawPublicKey()), S.scvBytes(g.rs), S.scvU32(g.v)));
  log(`14. owner revoked session R in ${Date.now() - t0} ms, ${rv.hash}`); results['14. owner revokes R'] = { pass: true, hash: rv.hash, ms: Date.now() - t0 };
  await run('15. session R after revoke', false, submitOp([req(1, 10_000_000n)]), [POOL_RULE], r);
  await run('16. another session still works', true, submitOp([req(1, 10_000_000n)]), [POOL_RULE], keep);
}
if (part === 'd') {
  const s = await session(720);
  const ms: number[] = [];
  for (let i = 0; i < 5; i++) { const r = await run(`17.${i + 1} latency: supply 1 XLM`, true, submitOp([req(0, 10_000_000n)]), [POOL_RULE, XLM_RULE], s); ms.push(r.ms); }
  log('latency ms', ms.join(', '), 'median', [...ms].sort((a, b) => a - b)[2]);
  save({ latency: ms });
}
if (part === 'e') {
  const s = await session(720);
  await run('3a. supply 5 XLM as collateral (request_type 2)', true, submitOp([req(2, 50_000_000n)]), [POOL_RULE, XLM_RULE], s);
  log('positions', await supplied());
  // Recording simulation runs Blend's own checks first; it must PASS for this borrow,
  // so the refusal below can only come from the session rule's policy.
  await run('3b. borrow 0.5 XLM against it (request_type 4)', false, submitOp([req(4, 5_000_000n)]), [POOL_RULE], s);
}
