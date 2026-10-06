// THE one NEAR-signed step: install the session rule on the Prime Account.
// Rule: scoped to the XLM contract, signer = session-signer, policy = the
// pinned testnet interpreter with "transfer, to VENUE only".
import { ed25519 } from '@noble/curves/ed25519.js';
import { Sdk, XLM, accountSig, friendbot, invokeAs, keypair, localSigner, log, save, state } from './stellar.ts';
import { mpcSign } from './mm.ts';
const PS = '/home/ubuntu/git/github.com/untangledfinance/oz-policy-builder/packages/policy-synth/src';
const { encodePredicate } = await import(`${PS}/predicate/encode.ts`);
const { buildAddContextRuleArgs } = await import(`${PS}/install/build-add-context-rule.ts`);
const INTERPRETER = 'CCBHVZ6HGGV7C4SNHCZ3S5665Z2WEMHTMBAEPO4XW6PKON464BEBANU5';
const st = state();
const fee = keypair('secrets/fee-payer.json');
const venue = keypair('secrets/venue.json').publicKey(); // stands in for an allowed destination
await friendbot(venue);
const pred = encodePredicate({ op: 'and', children: [
  { op: 'eq', left: { kind: 'call_fn' }, right: { kind: 'literal_symbol', value: 'transfer' } },
  { op: 'eq', left: { kind: 'call_arg', index: 1 }, right: { kind: 'literal_address', value: venue } },
] });
const blob: string = (pred as any).encodedPredicate;
const phash: string = (pred as any).predicateHash;
const args = buildAddContextRuleArgs(
  { contextRuleType: { kind: 'call_contract', contract: XLM }, name: 'session', validUntilLedger: null, signers: [{ kind: 'delegated', address: st.signer }], policies: [] },
  { signers: [{ kind: 'delegated', address: st.signer }], policies: [{ kind: 'interpreter', interpreterAddress: INTERPRETER, predicateBlobBase64: blob }], installNonce: 1, encodedPredicate: blob, predicateHash: phash },
).map((v: any) => Sdk.xdr.ScVal.fromXDR(v.toXDR('base64'), 'base64'));
const op = new Sdk.Contract(st.prime).call('add_context_rule', ...args);
let mpcMs = 0, nearTx = '';
const nearSigner = { address: st.admin, signNested: async (payload: Buffer) => {
  const { sig, ms, nearTx: t } = await mpcSign(payload, st.path);
  mpcMs = ms; nearTx = t;
  if (!ed25519.verify(sig, payload, Sdk.StrKey.decodeEd25519PublicKey(st.admin))) throw new Error('MPC signature does not verify');
  return accountSig(Sdk.StrKey.decodeEd25519PublicKey(st.admin), sig);
} };
// Rule 0 is 2 of 3: A (MetaMask via NEAR, ONE MPC signature) + B co-signs.
const r = await invokeAs({ feePayer: fee, op, account: st.prime, ruleIds: [0], signers: [nearSigner, localSigner(keypair('secrets/admin-b.json'))] });
log('install session rule', JSON.stringify({ ...r, mpcMs, nearTx }));
if (r.ok) save({ venue, installTx: r.hash, installNearTx: nearTx, installMpcMs: mpcMs, installMs: r.ms });
