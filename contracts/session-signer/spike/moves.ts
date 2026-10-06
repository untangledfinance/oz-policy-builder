// After setup: sessions and moves with NO NEAR signature.
// Each session = fresh ed25519 key + ONE MetaMask EIP-712 signature (off chain).
import { sha256, toBytes, toHex } from 'viem';
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts';
import { Sdk, XLM, invokeAs, keypair, localSigner, log, save, server, state } from './stellar.ts';
import { DOMAIN, TYPES } from './eip712.ts';
import { metamask } from './mm.ts';
const st = state();
const fee = keypair('secrets/fee-payer.json');
const PRIME: string = st.prime;
const count = Sdk.scValToNative((await server.simulateTransaction(new Sdk.TransactionBuilder(await server.getAccount(fee.publicKey()), { fee: '100', networkPassphrase: Sdk.Networks.TESTNET }).addOperation(new Sdk.Contract(PRIME).call('get_context_rules_count')).setTimeout(30).build()) as any).result.retval);
const RULE = Number(count) - 1;
const now = async () => (await server.getLatestLedger()).sequence;

async function newSession(ledgers: number, wallet = metamask) {
  const kp = Sdk.Keypair.random();
  const until = (await now()) + ledgers;
  const t0 = Date.now();
  const grant = await wallet.signTypedData({ domain: DOMAIN, types: TYPES, primaryType: 'PrimeSession',
    message: { account: PRIME, sessionKey: toHex(kp.rawPublicKey()), validUntil: until, network: sha256(toBytes(Sdk.Networks.TESTNET)) } });
  return { kp, until, grant, grantMs: Date.now() - t0 };
}
type S = Awaited<ReturnType<typeof newSession>>;
const asSigner = (s: S, claimUntil = s.until) => ({ address: st.signer, signNested: async (p: Buffer) => Sdk.xdr.ScVal.scvVec([
  Sdk.xdr.ScVal.scvBytes(s.kp.rawPublicKey()), Sdk.xdr.ScVal.scvU32(claimUntil),
  Sdk.xdr.ScVal.scvBytes(Buffer.from(s.grant.slice(2), 'hex')), Sdk.xdr.ScVal.scvBytes(s.kp.sign(p)) ]) });
const xfer = (to: string, stroops: bigint) => new Sdk.Contract(XLM).call('transfer', new Sdk.Address(PRIME).toScVal(), new Sdk.Address(to).toScVal(), Sdk.nativeToScVal(stroops, { type: 'i128' }));
const short = (e?: string) => [...new Set((e ?? '').match(/Error\([A-Za-z]+, #?\w+\)/g) ?? [])].join(' ') || (e ?? '').slice(0, 160);
const results: Record<string, unknown> = {};
async function run(name: string, expectOk: boolean, p: Promise<Awaited<ReturnType<typeof invokeAs>>>) {
  const r = await p;
  const pass = r.ok === expectOk;
  if (process.env.RAW && !r.ok && name.startsWith(process.env.RAW)) console.log((r.error ?? '').slice(0, 3000));
  results[name] = { pass, ok: r.ok, ms: r.ms, hash: r.hash, error: r.ok ? undefined : short(r.error) };
  log(pass ? 'PASS' : 'FAIL', name, r.ok ? `ok ${r.ms} ms ${r.hash}` : `refused: ${short(r.error)}`);
}
const venue: string = st.venue;
const which = process.argv[2] ?? 'all';

if (which === 'all' || which === 'a') {
  const s1 = await newSession(720); // ~1 hour
  log(`session 1: key ${s1.kp.publicKey()}, valid until ledger ${s1.until}, MetaMask signed in ${s1.grantMs} ms`);
  await run('1. session key moves 1 XLM to the allowed venue', true, invokeAs({ feePayer: fee, op: xfer(venue, 10_000_000n), account: PRIME, ruleIds: [RULE], signers: [asSigner(s1)] }));
  await run('2. second move, same session', true, invokeAs({ feePayer: fee, op: xfer(venue, 10_000_000n), account: PRIME, ruleIds: [RULE], signers: [asSigner(s1)] }));
  await run('3. to an address that is not the venue', false, invokeAs({ feePayer: fee, op: xfer(fee.publicKey(), 10_000_000n), account: PRIME, ruleIds: [RULE], signers: [asSigner(s1)] }));
  const selfCall = new Sdk.Contract(PRIME).call('add_context_rule', Sdk.xdr.ScVal.scvVec([Sdk.xdr.ScVal.scvSymbol('Default')]), Sdk.xdr.ScVal.scvString('x'), Sdk.xdr.ScVal.scvVoid(),
    Sdk.xdr.ScVal.scvVec([Sdk.xdr.ScVal.scvVec([Sdk.xdr.ScVal.scvSymbol('Delegated'), new Sdk.Address(fee.publicKey()).toScVal()])]), Sdk.xdr.ScVal.scvMap([]));
  await run('4. session key adds a rule to the account (session rule)', false, invokeAs({ feePayer: fee, op: selfCall, account: PRIME, ruleIds: [RULE], signers: [asSigner(s1)] }));
  await run('5. session key adds a rule to the account (rule 0)', false, invokeAs({ feePayer: fee, op: selfCall, account: PRIME, ruleIds: [0], signers: [asSigner(s1)] }));
  await run('6. session key moves funds under rule 0', false, invokeAs({ feePayer: fee, op: xfer(fee.publicKey(), 10_000_000n), account: PRIME, ruleIds: [0], signers: [asSigner(s1)] }));
  await run('7. rule 0 still needs 2 of 3: B alone adds a rule', false, invokeAs({ feePayer: fee, op: selfCall, account: PRIME, ruleIds: [0], signers: [localSigner(keypair('secrets/admin-b.json'))] }));
  await run('8. proof claims a later valid_until than MetaMask signed', false, invokeAs({ feePayer: fee, op: xfer(venue, 10_000_000n), account: PRIME, ruleIds: [RULE], signers: [asSigner(s1, s1.until + 100_000)] }));
  const stranger = privateKeyToAccount(generatePrivateKey());
  const s2 = await newSession(720, stranger);
  await run('9. grant signed by another wallet', false, invokeAs({ feePayer: fee, op: xfer(venue, 10_000_000n), account: PRIME, ruleIds: [RULE], signers: [asSigner(s2)] }));
  const s3 = await newSession(720);
  await run('10. renewal: a new key, one new MetaMask signature, no NEAR', true, invokeAs({ feePayer: fee, op: xfer(venue, 10_000_000n), account: PRIME, ruleIds: [RULE], signers: [asSigner(s3)] }));
  save({ movesA: results });
}
if (which === 'all' || which === 'b') {
  const s = await newSession(4);
  log(`short session valid until ${s.until}`);
  await run('11a. short session, before valid_until', true, invokeAs({ feePayer: fee, op: xfer(venue, 10_000_000n), account: PRIME, ruleIds: [RULE], signers: [asSigner(s)] }));
  log('waiting for valid_until to pass');
  while ((await now()) <= s.until + 1) await new Promise((r) => setTimeout(r, 2000));
  await run('11b. same session, after valid_until', false, invokeAs({ feePayer: fee, op: xfer(venue, 10_000_000n), account: PRIME, ruleIds: [RULE], signers: [asSigner(s)] }));
  save({ movesB: results });
}
