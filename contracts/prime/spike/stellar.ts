// Stellar testnet helpers + the OZ smart-account auth shapes (copied from
// octopos apps/web/ui/octopos/smart-account-oz-auth.ts, itself a copy of
// oz-policy-builder's scripts/oz-auth.ts).
import * as Sdk from '@stellar/stellar-sdk';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
export { Sdk };
const { xdr, Address, hash } = Sdk;
export const PASS = Sdk.Networks.TESTNET;
export const server = new Sdk.rpc.Server('https://soroban-testnet.stellar.org');
export const XLM = Sdk.Asset.native().contractId(PASS);
export const log = (...a: unknown[]) => console.log(new Date().toISOString().slice(11, 19), ...a);

export async function friendbot(addr: string) {
  if ((await fetch(`https://horizon-testnet.stellar.org/accounts/${addr}`)).ok) return;
  const r = await fetch(`https://friendbot.stellar.org?addr=${addr}`);
  if (!r.ok && !(await r.text()).includes('createAccountAlreadyExist')) throw new Error(`friendbot ${r.status}`);
}
export function keypair(file: string): Sdk.Keypair {
  if (!existsSync(file)) writeFileSync(file, JSON.stringify({ secret: Sdk.Keypair.random().secret() }), { mode: 0o600 });
  return Sdk.Keypair.fromSecret(JSON.parse(readFileSync(file, 'utf8')).secret);
}
export const state = (): Record<string, any> => (existsSync('state.json') ? JSON.parse(readFileSync('state.json', 'utf8')) : {});
export const save = (patch: Record<string, unknown>) => writeFileSync('state.json', JSON.stringify({ ...state(), ...patch }, null, 1));

const sym = (s: string) => xdr.ScVal.scvSymbol(s);
const u32 = (n: number) => xdr.ScVal.scvU32(n);
const vec = (items: xdr.ScVal[]) => xdr.ScVal.scvVec(items);
const bytes = (b: Buffer | Uint8Array) => xdr.ScVal.scvBytes(Buffer.from(b));
export const delegatedSigner = (a: string) => vec([sym('Delegated'), new Address(a).toScVal()]);

export function signaturePayload(nonce: xdr.Int64, exp: number, inv: xdr.SorobanAuthorizedInvocation): Buffer {
  return hash(xdr.HashIdPreimage.envelopeTypeSorobanAuthorization(new xdr.HashIdPreimageSorobanAuthorization({ networkId: hash(Buffer.from(PASS)), nonce, signatureExpirationLedger: exp, invocation: inv })).toXDR());
}
export const authDigest = (payload: Buffer, ids: number[]) => hash(Buffer.concat([payload, vec(ids.map(u32)).toXDR()]));
export function authPayload(signers: string[], ids: number[]): xdr.ScVal {
  const m = signers.map((a) => new xdr.ScMapEntry({ key: delegatedSigner(a), val: bytes(Buffer.alloc(0)) }))
    .sort((l, r) => Buffer.compare(l.key().toXDR(), r.key().toXDR()));
  return xdr.ScVal.scvMap([
    new xdr.ScMapEntry({ key: sym('context_rule_ids'), val: vec(ids.map(u32)) }),
    new xdr.ScMapEntry({ key: sym('signers'), val: xdr.ScVal.scvMap(m) }),
  ]);
}
export function nonce(): bigint { const b = crypto.getRandomValues(new Uint8Array(8)); let n = 0n; for (const x of b) n = (n << 8n) | BigInt(x); return n & 0x7fff_ffff_ffff_ffffn; }
export function countContexts(inv: xdr.SorobanAuthorizedInvocation): number { return 1 + inv.subInvocations().reduce((t, s) => t + countContexts(s), 0); }

/** The nested `require_auth_for_args(auth_digest)` entry for a delegated signer, unsigned. */
export function nestedEntry(account: string, digest: Buffer, signer: string, n: bigint, exp: number) {
  return new xdr.SorobanAuthorizationEntry({
    credentials: xdr.SorobanCredentials.sorobanCredentialsAddress(new xdr.SorobanAddressCredentials({ address: new Address(signer).toScAddress(), nonce: new xdr.Int64(n), signatureExpirationLedger: exp, signature: xdr.ScVal.scvVoid() })),
    rootInvocation: new xdr.SorobanAuthorizedInvocation({
      function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(new xdr.InvokeContractArgs({ contractAddress: new Address(account).toScAddress(), functionName: '__check_auth', args: [bytes(digest)] })),
      subInvocations: [] }),
  });
}

/**
 * Invoke `op` with the Prime Account's authorisation coming from ONE delegated
 * signer (`signer`), whose own nested entry is signed by `signNested(payload)`.
 * Returns the tx hash and status, or the simulation / submission error.
 */
export async function invokeAs(opts: {
  feePayer: Sdk.Keypair; op: xdr.Operation; account: string; ruleIds: number[];
  signers: Array<{ address: string; signNested: (payload: Buffer) => Promise<xdr.ScVal> }>;
  /** Sign root entries for other addresses (e.g. a G account a contract calls require_auth on). */
  others?: Record<string, (payload: Buffer) => Promise<xdr.ScVal>>;
}): Promise<{ ok: boolean; hash?: string; error?: string; ms: number; signMs: number }> {
  const t0 = Date.now();
  const src = await server.getAccount(opts.feePayer.publicKey());
  const build = () => new Sdk.TransactionBuilder(src, { fee: '2000000', networkPassphrase: PASS }).addOperation(opts.op).setTimeout(120);
  const sim = await server.simulateTransaction(build().build());
  if (Sdk.rpc.Api.isSimulationError(sim)) return { ok: false, error: `recording sim: ${sim.error.slice(0, 400)}`, ms: Date.now() - t0, signMs: 0 };
  const latest = (await server.getLatestLedger()).sequence;
  const exp = latest + 60;
  const entries: xdr.SorobanAuthorizationEntry[] = [];
  let signMs = 0;
  for (const e of sim.result!.auth) {
    const c = e.credentials();
    const who = c.switch().name === 'sorobanCredentialsAddress' ? Address.fromScAddress(c.address().address()).toString() : '';
    if (who && who !== opts.account && opts.others?.[who]) {
      const ac = c.address();
      const signed = new xdr.SorobanAuthorizationEntry({ credentials: xdr.SorobanCredentials.sorobanCredentialsAddress(new xdr.SorobanAddressCredentials({ address: ac.address(), nonce: ac.nonce(), signatureExpirationLedger: exp, signature: xdr.ScVal.scvVoid() })), rootInvocation: e.rootInvocation() });
      signed.credentials().address().signature(await opts.others[who]!(signaturePayload(ac.nonce(), exp, e.rootInvocation())));
      entries.push(signed); continue;
    }
    if (who !== opts.account) { entries.push(e); continue; }
    const ids = opts.ruleIds.length === 1 ? new Array(countContexts(e.rootInvocation())).fill(opts.ruleIds[0]) : opts.ruleIds;
    const payload = signaturePayload(c.address().nonce(), exp, e.rootInvocation());
    const digest = authDigest(payload, ids);
    entries.push(new xdr.SorobanAuthorizationEntry({
      credentials: xdr.SorobanCredentials.sorobanCredentialsAddress(new xdr.SorobanAddressCredentials({ address: c.address().address(), nonce: c.address().nonce(), signatureExpirationLedger: exp, signature: authPayload(opts.signers.map((x) => x.address), ids) })),
      rootInvocation: e.rootInvocation() }));
    for (const sg of opts.signers) {
      const nested = nestedEntry(opts.account, digest, sg.address, nonce(), exp);
      const nc = nested.credentials().address();
      const s0 = Date.now();
      nc.signature(await sg.signNested(signaturePayload(nc.nonce(), exp, nested.rootInvocation())));
      signMs += Date.now() - s0;
      entries.push(nested);
    }
  }
  const op = Sdk.Operation.invokeHostFunction({ func: opts.op.body().invokeHostFunctionOp().hostFunction(), auth: entries });
  const tx = new Sdk.TransactionBuilder(await server.getAccount(opts.feePayer.publicKey()), { fee: '2000000', networkPassphrase: PASS }).addOperation(op).setTimeout(120).build();
  const sim2 = await server.simulateTransaction(tx);
  if (Sdk.rpc.Api.isSimulationError(sim2)) return { ok: false, error: sim2.error.slice(0, 600), ms: Date.now() - t0, signMs };
  const ready = Sdk.rpc.assembleTransaction(tx, sim2).build();
  ready.sign(opts.feePayer);
  const sent = await server.sendTransaction(ready);
  if (sent.status === 'ERROR') return { ok: false, error: `send: ${JSON.stringify(sent.errorResult ?? sent).slice(0, 300)}`, ms: Date.now() - t0, signMs };
  for (let i = 0; i < 40; i++) {
    const r = await server.getTransaction(sent.hash);
    if (r.status !== 'NOT_FOUND') return { ok: r.status === 'SUCCESS', hash: sent.hash, error: r.status === 'SUCCESS' ? undefined : r.status, ms: Date.now() - t0, signMs };
    await new Promise((res) => setTimeout(res, 1000));
  }
  return { ok: false, hash: sent.hash, error: 'timeout', ms: Date.now() - t0, signMs };
}

/** Plain submit for setup steps the fee payer alone authorises. */
export async function submit(feePayer: Sdk.Keypair, op: xdr.Operation) {
  const tx = new Sdk.TransactionBuilder(await server.getAccount(feePayer.publicKey()), { fee: '2000000', networkPassphrase: PASS }).addOperation(op).setTimeout(120).build();
  const prepared = await server.prepareTransaction(tx);
  prepared.sign(feePayer);
  const sent = await server.sendTransaction(prepared);
  if (sent.status === 'ERROR') throw new Error(JSON.stringify(sent.errorResult).slice(0, 300));
  for (let i = 0; i < 40; i++) {
    const r = await server.getTransaction(sent.hash);
    if (r.status === 'SUCCESS') return { hash: sent.hash, ret: r.returnValue };
    if (r.status === 'FAILED') throw new Error(`failed ${sent.hash}`);
    await new Promise((res) => setTimeout(res, 1000));
  }
  throw new Error(`timeout ${sent.hash}`);
}

/** A classic G-account's signature value for an address-credential entry. */
export function accountSig(pub: Buffer, sig: Uint8Array): xdr.ScVal {
  return xdr.ScVal.scvVec([xdr.ScVal.scvMap([
    new xdr.ScMapEntry({ key: sym('public_key'), val: bytes(pub) }),
    new xdr.ScMapEntry({ key: sym('signature'), val: bytes(sig) }),
  ])]);
}
/** A plain local key as a delegated co-signer (stands in for a team member's wallet). */
export const localSigner = (kp: Sdk.Keypair) => ({ address: kp.publicKey(), signNested: async (p: Buffer) => accountSig(kp.rawPublicKey(), kp.sign(p)) });
