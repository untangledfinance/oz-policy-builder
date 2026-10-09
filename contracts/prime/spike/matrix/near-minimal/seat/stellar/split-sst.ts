// Split seat/owner-key variant on Stellar testnet: one wallet (MetaMask, both keys from the NEAR MPC key under two paths).
//   owner key  = prime:stellar-session : move-only grants and revokes (and nothing that carries voting power)
//   seat key   = prime:stellar         : vote grants, vote revokes and the seat's own vote
// Contract-level run: grant and verify are called directly with Soroban authorization entries, as the account's rule 0 would call verify.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { Sdk, XLM, PASS, friendbot, keypair, accountSig, signaturePayload, nonce, log, server, submit } from './stellar.ts';
void XLM;
const { edKey, edSign, stats } = await import('./nearsig.ts');
const S_ = Sdk.xdr.ScVal, xdr = Sdk.xdr;
const HERE = '/home/ubuntu/work/seat-spike/stellar';
const WASM = `${HERE}/prime-seat-split/target/wasm32v1-none/release/prime_seat_split.wasm`;
const FILE = `${HERE}/state-split.json`;
const st: Record<string, any> = existsSync(FILE) ? JSON.parse(readFileSync(FILE, 'utf8')) : {};
const save = (p: Record<string, unknown>) => { Object.assign(st, p); writeFileSync(FILE, JSON.stringify(st, null, 1)); };
const fee = keypair('/home/ubuntu/work/near-session-spike/secrets/fee-payer.json');
type W = { G: string; pub: Buffer; sign: (m: Buffer) => Promise<Buffer> };
const wallet = async (path: string): Promise<W> => { const pub = Buffer.from(await edKey('MetaMask', path)); return { G: Sdk.StrKey.encodeEd25519PublicKey(pub), pub, sign: async (m) => Buffer.from(await edSign('MetaMask', path, m)) }; };
const OWNER = await wallet('prime:stellar-session'), SEAT = await wallet('prime:stellar'), STRANGER = await wallet('prime:stellar-other');
const u32 = (n: number) => S_.scvU32(n), bytes = (b: Buffer | Uint8Array) => S_.scvBytes(Buffer.from(b)), bool = (b: boolean) => S_.scvBool(b);
const addr = (a: string) => new Sdk.Address(a).toScVal();
const short = (e?: string) => [...new Set((e ?? '').match(/Error\([A-Za-z]+, #?\w+\)/g) ?? [])].join(' ') || (e ?? '').slice(0, 160);
const AUTH = /Error\(Auth, InvalidAction\)/, BADSIG = /Error\(Crypto|Error\(Auth, InvalidInput\)|Error\(Contract, #5\)|failed ED25519/;
const now = async () => (await server.getLatestLedger()).sequence;
const results: Record<string, any> = {};
const note = (name: string, pass: boolean, detail: string, hash?: string) => { results[name] = { pass, detail, hash }; log(pass ? 'PASS' : 'FAIL', name, detail); save({ results }); };

type Entry = Sdk.xdr.SorobanAuthorizationEntry;
const invocation = (S: string, fn: string, args: Sdk.xdr.ScVal[]) => new xdr.SorobanAuthorizedInvocation({
  function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(new xdr.InvokeContractArgs({ contractAddress: new Sdk.Address(S).toScAddress(), functionName: fn, args })), subInvocations: [] });
/** The authorization of `who` for the invocation `root`, signed by `by` (default: who). */
async function entry(who: W, root: Sdk.xdr.SorobanAuthorizedInvocation, by: W = who): Promise<Entry> {
  const n = new xdr.Int64(nonce()), exp = (await now()) + 60;
  return new xdr.SorobanAuthorizationEntry({ credentials: xdr.SorobanCredentials.sorobanCredentialsAddress(new xdr.SorobanAddressCredentials({
    address: new Sdk.Address(who.G).toScAddress(), nonce: n, signatureExpirationLedger: exp, signature: accountSig(by.pub, await by.sign(signaturePayload(n, exp, root))) })), rootInvocation: root });
}
async function send(op: Sdk.xdr.Operation) {
  const t0 = Date.now();
  const tx = new Sdk.TransactionBuilder(await server.getAccount(fee.publicKey()), { fee: '2000000', networkPassphrase: PASS }).addOperation(op).setTimeout(120).build();
  const s2: any = await server.simulateTransaction(tx);
  if (Sdk.rpc.Api.isSimulationError(s2)) return { ok: false, error: s2.error.slice(0, 4000), ms: Date.now() - t0 } as any;
  const ret = s2.result?.retval ? Sdk.scValToNative(s2.result.retval) : undefined;
  const ready = Sdk.rpc.assembleTransaction(tx, s2).build(); ready.sign(fee);
  const sent = await server.sendTransaction(ready);
  if (sent.status === 'ERROR') return { ok: false, error: `send ${JSON.stringify(sent.errorResult ?? sent).slice(0, 200)}`, ms: Date.now() - t0 } as any;
  for (let i = 0; i < 40; i++) { const r = await server.getTransaction(sent.hash); if (r.status !== 'NOT_FOUND') return { ok: r.status === 'SUCCESS', hash: sent.hash, ret, ms: Date.now() - t0, error: r.status === 'SUCCESS' ? undefined : r.status } as any; await new Promise((s) => setTimeout(s, 1000)); }
  return { ok: false, error: 'timeout', ms: 0 } as any;
}
const callOp = (S: string, fn: string, args: Sdk.xdr.ScVal[], auth: Entry[]) => {
  const f = new Sdk.Contract(S).call(fn, ...args);
  return Sdk.Operation.invokeHostFunction({ func: f.body().invokeHostFunctionOp().hostFunction(), auth });
};
const expect = (name: string, r: any, ok: boolean, why?: RegExp, o: { ret?: unknown } = {}) => {
  const reasonOk = ok || !why || why.test(r.error ?? '');
  const retOk = !('ret' in o) || r.ret === o.ret;
  note(name, r.ok === ok && reasonOk && retOk, r.ok ? `ok ${r.ms} ms${'ret' in o ? ` returned ${r.ret}` : ''}` : `refused: ${short(r.error)}`, r.hash);
};
const grant = async (S: string, key: Buffer, until: number, vote: boolean, who: W, by: W = who) => {
  const e = await entry(who, invocation(S, 'grant', [bytes(key), u32(until), bool(vote)]), by);
  return send(callOp(S, 'grant', [bytes(key), u32(until), bool(vote)], [e]));
};
const verifyOwn = async (S: string, digest: Buffer, who?: W, by?: W) => {
  const auth = who ? [await entry(who, invocation(S, 'verify', [bytes(digest)]), by)] : [];
  return send(callOp(S, 'verify', [bytes(digest), bytes(Buffer.alloc(0)), bytes(Buffer.alloc(0))], auth));
};
const verifyKey = (S: string, digest: Buffer, kp: Sdk.Keypair) =>
  send(callOp(S, 'verify', [bytes(digest), bytes(Buffer.alloc(0)), bytes(Buffer.concat([kp.rawPublicKey(), kp.sign(digest)]))], []));
const stored = async (S: string, key: Buffer) => {
  const k = xdr.LedgerKey.contractData(new xdr.LedgerKeyContractData({ contract: new Sdk.Address(S).toScAddress(), key: bytes(key), durability: xdr.ContractDataDurability.temporary() }));
  const e = (await server.getLedgerEntries(k)).entries[0];
  if (!e) return undefined;
  const g = e.val.contractData().val().u32(); return { until: g & 0x7fffffff, vote: g >>> 31 === 1 };
};
const instanceOf = async (S: string) => {
  const key = xdr.LedgerKey.contractData(new xdr.LedgerKeyContractData({ contract: new Sdk.Address(S).toScAddress(), key: S_.scvLedgerKeyContractInstance(), durability: xdr.ContractDataDurability.persistent() }));
  const inst = (await server.getLedgerEntries(key)).entries[0]!.val.contractData().val().instance();
  const at = (n: number) => { const m = inst.storage()?.find((en) => en.key().switch().name === 'scvU32' && en.key().u32() === n); return m ? Sdk.Address.fromScVal(m.val()).toString() : 'missing'; };
  return { hash: inst.executable().wasmHash().toString('hex'), owner: at(0), seat: at(1) };
};

log('owner key', OWNER.G, 'seat key', SEAT.G);
for (const w of [OWNER, SEAT, STRANGER]) await friendbot(w.G);
const wasm = readFileSync(WASM), build = createHash('sha256').update(wasm).digest('hex');
if (!st.wasm) { const { ret, hash } = await submit(fee, Sdk.Operation.uploadContractWasm({ wasm })); save({ wasm: Buffer.from(ret!.bytes()).toString('hex'), wasmTx: hash }); }
if (!st.S) { const { ret, hash } = await submit(fee, Sdk.Operation.createCustomContract({ address: Sdk.Address.fromString(fee.publicKey()), wasmHash: Buffer.from(st.wasm, 'hex'), constructorArgs: [addr(OWNER.G), addr(SEAT.G)], salt: Buffer.from(Sdk.Keypair.random().rawPublicKey()) })); save({ S: Sdk.Address.fromScVal(ret!).toString(), STx: hash }); }
const S = st.S as string;
const inst = await instanceOf(S);
note('SP0. the deployed contract runs the built split wasm', inst.hash === build && st.wasm === build, `${inst.hash} build ${build}`);
note('SP1. the contract stores the owner key at 0 and the seat key at 1, and they differ', inst.owner === OWNER.G && inst.seat === SEAT.G && OWNER.G !== SEAT.G, `owner ${inst.owner} seat ${inst.seat}`);

const until = (await now()) + 720;
const km = Sdk.Keypair.random(), kv = Sdk.Keypair.random(), kd = Sdk.Keypair.random(), ku = Sdk.Keypair.random(), kr = Sdk.Keypair.random();
// grants: who may carry which power
expect('SG1. the owner key grants a move-only session', await grant(S, km.rawPublicKey(), until, false, OWNER), true);
expect('SG2. the owner key grants a session with the vote flag: refused (the contract asks the seat key)', await grant(S, kv.rawPublicKey(), until, true, OWNER), false, AUTH);
note('SG2b. ... and the key holds no grant', (await stored(S, kv.rawPublicKey())) === undefined, 'no entry');
expect('SG3. the seat key grants a session with the vote flag', await grant(S, kv.rawPublicKey(), until, true, SEAT), true);
expect('SG4. the seat key grants a move-only session: refused (the contract asks the owner key)', await grant(S, ku.rawPublicKey(), until, false, SEAT), false, AUTH);
expect('SG5. a stranger signs the seat key\'s vote grant', await grant(S, kr.rawPublicKey(), until, true, SEAT, STRANGER), false, BADSIG);
const a = await stored(S, km.rawPublicKey()), b = await stored(S, kv.rawPublicKey());
note('SG6. stored: the move-only key has no vote flag, the vote key has it', a?.vote === false && b?.vote === true && a.until === until && b.until === until, `${JSON.stringify(a)} ${JSON.stringify(b)}`);
// votes
const digest = Buffer.alloc(32, 3);
expect('SV1. the seat key authorizes the seat\'s own vote (verify, empty proof)', await verifyOwn(S, digest, SEAT), true, undefined, { ret: true });
expect('SV2. the owner key authorizes a vote: refused (the contract asks the seat key)', await verifyOwn(S, digest, OWNER), false, AUTH);
expect('SV3. no authorization at all', await verifyOwn(S, digest), false);
expect('SV4. a session key with the vote flag votes', await verifyKey(S, digest, kv), true, undefined, { ret: true });
expect('SV5. a move-only session key does not vote', await verifyKey(S, digest, km), true, undefined, { ret: false });
// downgrades and revokes
const kd2 = kd;
expect('SR0. the seat key grants a second vote session', await grant(S, kd2.rawPublicKey(), until, true, SEAT), true);
expect('SR1. the owner key re-grants it move-only (a downgrade)', await grant(S, kd2.rawPublicKey(), until, false, OWNER), true);
expect('SR2. the downgraded key does not vote', await verifyKey(S, digest, kd2), true, undefined, { ret: false });
expect('SR3. the owner key tries to upgrade the move-only key to a vote session: refused', await grant(S, km.rawPublicKey(), until, true, OWNER), false, AUTH);
expect('SR4. the owner key revokes the vote session (grant(key, 0, false)), the same wallet\'s other keys stay', await grant(S, kv.rawPublicKey(), 0, false, OWNER), true);
expect('SR5. the revoked key does not vote', await verifyKey(S, digest, kv), true, undefined, { ret: false });
expect('SR6. the seat key cannot grant the revoked key again (revoke is final)', await grant(S, kv.rawPublicKey(), (await now()) + 720, true, SEAT), false, /Error\(Contract, #1\)/);
expect('SR7. the move-only session is still live after the revoke of the other key', await grant(S, km.rawPublicKey(), until, false, OWNER), true);

// fees from Horizon
const hashes = Object.entries(results).filter(([, x]) => x.hash).map(([n, x]) => [n, x.hash] as const);
const fees: Record<string, number> = {};
for (const [n, h] of hashes) { for (let i = 0; i < 15; i++) { const r = await fetch(`https://horizon-testnet.stellar.org/transactions/${h}`); if (r.ok) { fees[n] = Number(((await r.json()) as any).fee_charged); break; } await new Promise((s) => setTimeout(s, 2000)); } }
save({ fees });
console.log('fees (stroops)', JSON.stringify(fees));
const r = Object.entries(results);
log(`${r.filter((x) => x[1].pass).length}/${r.length} passed`);
for (const [n, x] of r) if (!x.pass) log('FAIL', n, x.detail);
log(`NEAR MPC: ${stats.calls} signatures, average ${stats.calls ? (stats.ms / stats.calls / 1000).toFixed(1) : 0}s`);
process.exit(0);
