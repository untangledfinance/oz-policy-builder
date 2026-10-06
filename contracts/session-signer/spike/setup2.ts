// v2: deploy the reviewed session-signer and install two session rules on the
// same 2-of-3 Prime Account. Rule 0 approves each: A (MetaMask via NEAR) + B.
import { readFileSync } from 'node:fs';
import { ed25519 } from '@noble/curves/ed25519.js';
import { Sdk, XLM, accountSig, invokeAs, keypair, localSigner, log, save, state, submit } from './stellar.ts';
import { mpcSign, metamask } from './mm.ts';
const PS = '/home/ubuntu/git/github.com/untangledfinance/oz-policy-builder/packages/policy-synth/src';
const { encodePredicate } = await import(`${PS}/predicate/encode.ts`);
const { buildAddContextRuleArgs } = await import(`${PS}/install/build-add-context-rule.ts`);
const WASM = '/home/ubuntu/git/github.com/untangledfinance/oz-policy-builder/contracts/session-signer/target/wasm32v1-none/release/session_signer.wasm';
const INTERPRETER = 'CCBHVZ6HGGV7C4SNHCZ3S5665Z2WEMHTMBAEPO4XW6PKON464BEBANU5';
export const POOL = 'CCEBVDYM32YNYCVNRXQKDFFPISJJCV557CDZEIRBEE4NCV4KHPQ44HGF'; // Blend TestnetV2
const st = state();
const fee = keypair('secrets/fee-payer.json');
const PRIME: string = st.prime;

let signer2: string = st.signer2;
if (!signer2) {
  const wasm = readFileSync(WASM);
  const up = await submit(fee, Sdk.Operation.uploadContractWasm({ wasm }));
  const { ret, hash } = await submit(fee, Sdk.Operation.createCustomContract({ address: Sdk.Address.fromString(fee.publicKey()), wasmHash: Sdk.hash(wasm),
    constructorArgs: [Sdk.xdr.ScVal.scvBytes(Buffer.from(metamask.address.slice(2), 'hex'))] }));
  signer2 = Sdk.Address.fromScVal(ret!).toString();
  save({ signer2, signer2Tx: hash, signer2Upload: up.hash, signer2Wasm: Sdk.hash(wasm).toString('hex') });
  log('session-signer v2', signer2, hash);
}
const A = { address: st.admin, signNested: async (payload: Buffer) => {
  const { sig, ms, nearTx } = await mpcSign(payload, st.path);
  log(`  A signed via MetaMask -> NEAR MPC in ${ms} ms (NEAR ${nearTx})`);
  if (!ed25519.verify(sig, payload, Sdk.StrKey.decodeEd25519PublicKey(st.admin))) throw new Error('bad MPC signature');
  return accountSig(Sdk.StrKey.decodeEd25519PublicKey(st.admin), sig);
} };
const B = localSigner(keypair('secrets/admin-b.json'));
const addr = (a: string) => ({ kind: 'literal_address', value: a });
async function install(name: string, contract: string, predicate: unknown) {
  const p: any = encodePredicate(predicate);
  const args = buildAddContextRuleArgs(
    { contextRuleType: { kind: 'call_contract', contract }, name, validUntilLedger: null, signers: [{ kind: 'delegated', address: signer2 }], policies: [] },
    { signers: [{ kind: 'delegated', address: signer2 }], policies: [{ kind: 'interpreter', interpreterAddress: INTERPRETER, predicateBlobBase64: p.encodedPredicate }], installNonce: 1, encodedPredicate: p.encodedPredicate, predicateHash: p.predicateHash },
  ).map((v: any) => Sdk.xdr.ScVal.fromXDR(v.toXDR('base64'), 'base64'));
  const r = await invokeAs({ feePayer: fee, op: new Sdk.Contract(PRIME).call('add_context_rule', ...args), account: PRIME, ruleIds: [0], signers: [A, B] });
  log(`install ${name}`, JSON.stringify(r));
  if (!r.ok) process.exit(1);
  return r;
}
if (!st.poolRuleTx) {
  // Blend submit(from, spender, to, requests): only for this account, one request, supply/withdraw kinds 0-3 (no borrow).
  const r = await install('session_blend', POOL, { op: 'and', children: [
    { op: 'eq', left: { kind: 'call_fn' }, right: { kind: 'literal_symbol', value: 'submit' } },
    { op: 'eq', left: { kind: 'call_arg', index: 0 }, right: addr(PRIME) },
    { op: 'eq', left: { kind: 'call_arg', index: 1 }, right: addr(PRIME) },
    { op: 'eq', left: { kind: 'call_arg', index: 2 }, right: addr(PRIME) },
    { op: 'eq', left: { kind: 'call_arg_len', index: 3 }, right: { kind: 'literal_u32', value: 1 } },
    { op: 'in', needle: { kind: 'call_arg_field', index: 3, element: 0, field: 'request_type' }, haystack: [0, 1, 2, 3].map((value) => ({ kind: 'literal_u32', value })) },
  ] });
  save({ poolRuleTx: r.hash });
}
if (!st.xlmRuleTx) {
  const r = await install('session_xlm', XLM, { op: 'and', children: [
    { op: 'eq', left: { kind: 'call_fn' }, right: { kind: 'literal_symbol', value: 'transfer' } },
    { op: 'eq', left: { kind: 'call_arg', index: 1 }, right: addr(POOL) },
  ] });
  save({ xlmRuleTx: r.hash });
}
