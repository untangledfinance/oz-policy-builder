// Shared helpers for the seat-voting harness (pse.ts): clients, result recording, wallets, Safe transactions, sessions.
// Fork only: an anvil fork of Base Sepolia on port 8567.
import { createPublicClient, createWalletClient, http, encodeFunctionData, parseAbi, getAddress, concat, pad, numberToHex, keccak256, toHex, encodeAbiParameters, hashTypedData, decodeFunctionData, type Address, type Hex } from 'viem';
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts';
import { baseSepolia } from 'viem/chains';
import { readFileSync, writeFileSync } from 'node:fs';

export const { metamask, secpAddr, secpSign, stats } = await import(process.env.NEARSIG_STUB ?? '/home/ubuntu/work/near-session-spike/nearsig.ts');
const OCT = '/home/ubuntu/git/github.com/untangledfinance/octopos/apps/evm-web/src/core';
export const ob = await import(`${OCT}/onboarding.ts`);
export const pol = await import(`${OCT}/evm-policy.ts`);
export const { CONTRACTS } = await import(`${OCT}/contracts.ts`);

export const RPC = process.env.PSE_RPC ?? 'http://127.0.0.1:8567';
export const CHAIN_ID = 84532;
export const pub = createPublicClient({ chain: baseSepolia, transport: http(RPC), pollingInterval: 500 });
export const relayerAcct = privateKeyToAccount('0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'); // anvil dev #0 (public)
export const wallet = (a: ReturnType<typeof privateKeyToAccount>, id = CHAIN_ID) => createWalletClient({ chain: { ...baseSepolia, id }, transport: http(RPC), account: a });
export const rpc = (method: string, params: unknown[]) => fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) }).then((r) => r.json()) as Promise<any>;

export const st: any = {};
export const results: any[] = [];
export const gasOf: Record<string, bigint> = {};
export let lastTx: Hex | undefined;
const STATE = process.env.PSE_STATE ?? 'state-pse.json';
export const save = () => writeFileSync(STATE, JSON.stringify({ ...st, results }, (_, v) => (typeof v === 'bigint' ? v.toString() : v), 1));
export function record(name: string, expectOk: boolean, ok: boolean, detail: string) {
  const pass = ok === expectOk; results.push({ name, pass, ok, detail, tx: lastTx }); lastTx = undefined; save();
  console.log(`${pass ? 'PASS' : 'FAIL'} ${name} | ${ok ? `ok ${detail}` : `refused: ${detail}`}`);
  return ok;
}
export const note = (s: string) => console.log(`---- ${s}`);

const ROLES: Record<number, string> = { 2: 'TargetAddressNotAllowed', 3: 'FunctionNotAllowed', 7: 'ParameterNotAllowed', 17: 'AllowanceExceeded' };
export const reason = (e: any) => { const s = String(e?.shortMessage ?? e?.message ?? e).replace(/\s+/g, ' ');
  const m = s.replace(/\s/g, '').match(/0xd0a9bf58:?([0-9a-f]{64})/i); if (m) return `Roles ConditionViolation(${ROLES[parseInt(m[1]!, 16)] ?? parseInt(m[1]!, 16)})`;
  if (/0xfd8e9f28/i.test(s)) return 'Roles NoMembership';
  return s.match(/(reverted with reason: [^.]*|GS\d{3}|reverted with the following reason:[^.]*|insufficient funds[^.]*|custom error 0x[0-9a-f]{8}|Multicall3: call failed)/i)?.[0] ?? s.slice(0, 140); };

export async function send(name: string, expectOk: boolean, to: Address, data: Hex, o: { from?: ReturnType<typeof privateKeyToAccount>; tag?: string; chainId?: number } = {}) {
  let ok = true, d = '';
  const from = o.from ?? relayerAcct;
  try { await pub.call({ account: from, to, data }); const h = await wallet(from, o.chainId ?? CHAIN_ID).sendTransaction({ to, data, gas: 3_000_000n }); lastTx = h; const r = await pub.waitForTransactionReceipt({ hash: h }); ok = r.status === 'success'; d = `gas ${r.gasUsed}${from === relayerAcct ? '' : ' (paid by ' + from.address.slice(0, 8) + '…)'}`; if (o.tag) gasOf[o.tag] = r.gasUsed; }
  catch (e: any) { ok = false; d = reason(e); }
  return record(name, expectOk, ok, d);
}
export async function deploy(a: any, args: any[] = [], tag?: string) { const h = await wallet(relayerAcct).deployContract({ abi: a.abi, bytecode: a.bytecode.object, args }); const r = await pub.waitForTransactionReceipt({ hash: h }); if (tag) gasOf[tag] = r.gasUsed; return getAddress(r.contractAddress!); }
export const art = (dir: string, n: string) => JSON.parse(readFileSync(`${dir}/out/${n}.sol/${n}.json`, 'utf8'));
export const HERE = '/home/ubuntu/work/seat-spike/evm';
export const PK = art(HERE, 'PrimeSession'), NG = art(HERE, 'PrimeSessionNoGov'), BASE = art('/home/ubuntu/work/prime-evm', 'PrimeSession'), TK = art('/home/ubuntu/work/evm-matrix', 'Token');
export const tokenAbi = parseAbi(['function mint(address,uint256)', 'function transfer(address,uint256) returns (bool)', 'function balanceOf(address) view returns (uint256)']);
export const safeAbi = parseAbi(['function nonce() view returns (uint256)', 'function getOwners() view returns (address[])', 'function getThreshold() view returns (uint256)', 'function addOwnerWithThreshold(address owner, uint256 threshold)',
  'function removeOwner(address prevOwner, address owner, uint256 _threshold)', 'function swapOwner(address prevOwner, address oldOwner, address newOwner)', 'function changeThreshold(uint256 _threshold)', 'function enableModule(address module)',
  'function setGuard(address guard)', 'function domainSeparator() view returns (bytes32)', 'function isValidSignature(bytes32 _dataHash, bytes _signature) view returns (bytes4)', 'function getMessageHash(bytes message) view returns (bytes32)']);
export const fresh = () => getAddress(privateKeyToAccount(generatePrivateKey()).address);
export const VENUE = fresh(), OTHER = fresh(), DEST = fresh(), ATTACKER = privateKeyToAccount(generatePrivateKey());
export const E18 = 10n ** 18n;
export const ZERO: Address = '0x0000000000000000000000000000000000000000';
export const SENTINEL: Address = '0x0000000000000000000000000000000000000001';
export type Call = { to: Address; value: bigint; data: Hex; operation: 0 | 1 };
export const tokenTransfer = (to: Address, n: bigint): Call => ({ to: st.token as Address, value: 0n, operation: 0, data: encodeFunctionData({ abi: tokenAbi, functionName: 'transfer', args: [to, n * E18] }) });
export const bal = (a: Address) => pub.readContract({ address: st.token, abi: tokenAbi, functionName: 'balanceOf', args: [a] });
export const now = async () => (await pub.getBlock()).timestamp;
export const lc = (a: string) => a.toLowerCase();

// ── Wallets: MetaMask signs with its own key, Freighter and Phantom through the NEAR MPC under prime:evm-session ──────
export type W = { name: string; addr: Address; signHash: (h: Hex) => Promise<Hex>; personalSign: (t: string) => Promise<Hex> };
const memo = new Map<string, Hex>(); // an MPC signature over the same hash is reusable, so refused retries cost no second NEAR call
export const SESSION_PATH = 'prime:evm-session';
export const viaNear = async (name: 'Freighter' | 'Phantom', path = SESSION_PATH): Promise<W> => ({ name, addr: await secpAddr(name, path),
  signHash: async (h) => { const k = `${name}:${path}:${h}`; if (!memo.has(k)) memo.set(k, await secpSign(name, path, h)); return memo.get(k)!; },
  personalSign: (t) => secpSign(name, path, hashMessage(t)) });
import { hashMessage } from 'viem';
export const MM: W = { name: 'MetaMask', addr: metamask.address, signHash: (h) => metamask.sign({ hash: h }), personalSign: (t) => metamask.signMessage({ message: t }) };

// ── Safe transactions ────────────────────────────────────────────────────────────────────────────────────
export type Tx = Call & { safeTxGas: bigint; baseGas: bigint; gasPrice: bigint; gasToken: Address; refundReceiver: Address; nonce: bigint };
export type Ctx = { hash: Hex; tx: Tx; safe: Address };
export type Part = { owner: Address; sig: Hex; dynamic?: Hex };
export type PartFn = (c: Ctx) => Promise<Part>;
export async function prepare(safe: Address, call: Call, chainId = CHAIN_ID): Promise<Ctx> {
  const nonce = await pub.readContract({ address: safe, abi: safeAbi, functionName: 'nonce' });
  const tx: Tx = { ...call, safeTxGas: 0n, baseGas: 0n, gasPrice: 0n, gasToken: ZERO, refundReceiver: ZERO, nonce };
  return { tx, safe, hash: ob.hashSafeTransaction(chainId, safe, tx) };
}
export function pack(ps: Part[], sort = true): Hex {
  if (sort) ps = [...ps].sort((a, b) => (BigInt(a.owner) < BigInt(b.owner) ? -1 : 1));
  const tail: Hex[] = []; let off = 65 * ps.length;
  const statics = ps.map((p) => { if (!p.dynamic) return p.sig; const len = (p.dynamic.length - 2) / 2; tail.push(concat([pad(numberToHex(len), { size: 32 }), p.dynamic]));
    const s = concat([pad(p.owner, { size: 32 }), pad(numberToHex(off), { size: 32 }), '0x00']); off += 32 + len; return s; });
  return statics.length ? concat([...statics, ...tail]) : '0x';
}
export const execData = (c: Ctx, sigs: Hex) => ob.encodeExecTransaction(c.tx, sigs) as Hex;
export async function safeTx(safe: Address, name: string, expectOk: boolean, call: Call, parts: PartFn[], o: { tag?: string; sort?: boolean } = {}) {
  const c = await prepare(safe, call);
  const ps = await Promise.all(parts.map((p) => p(c)));
  const ok = await send(name, expectOk, safe, execData(c, pack(ps, o.sort ?? true)), { tag: o.tag });
  return { ok, ctx: c, parts: ps };
}
// part builders: a PrimeSession as a Safe owner (contract signature, v = 0) carrying a 65-byte signature over the Safe hash
export const byOwner = (w: W, pk: Address): PartFn => async (c) => ({ owner: pk, sig: '0x', dynamic: await w.signHash(c.hash) });
export const bySession = (s: { pk: Address; key: ReturnType<typeof privateKeyToAccount> }): PartFn => async (c) => ({ owner: s.pk, sig: '0x', dynamic: await s.key.sign({ hash: c.hash }) });
export const byEoa = (a: ReturnType<typeof privateKeyToAccount>): PartFn => async (c) => ({ owner: a.address, sig: await a.sign({ hash: c.hash }) });
// the SafeTx words a no-governance vote session appends to its signature
export const txWords = (t: Tx): Hex => encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }, { type: 'bytes32' }, { type: 'uint8' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'address' }, { type: 'address' }, { type: 'uint256' }],
  [t.to, t.value, keccak256(t.data), t.operation, t.safeTxGas, t.baseGas, t.gasPrice, t.gasToken, t.refundReceiver, t.nonce]);
export const bySessionWithFields = (s: { pk: Address; key: ReturnType<typeof privateKeyToAccount> }): PartFn => async (c) => ({ owner: s.pk, sig: '0x', dynamic: concat([await s.key.sign({ hash: c.hash }), txWords(c.tx)]) });

export async function makeSafe(label: string, owners: Address[], threshold: number): Promise<Address> {
  const proxyCreationCode = await pub.readContract({ address: CONTRACTS.safeProxyFactory, abi: parseAbi(['function proxyCreationCode() view returns (bytes)']), functionName: 'proxyCreationCode' }) as Hex;
  const initializer = ob.encodeSafeInitializer(owners, BigInt(threshold), CONTRACTS.compatibilityFallbackHandler);
  const salt = BigInt(keccak256(toHex(`pse-${label}-${Date.now()}`)));
  const addr = ob.predictSafeAddress(proxyCreationCode, initializer, salt) as Address;
  const c = ob.encodeCreateSafe(initializer, salt);
  await send(`create Safe ${label} (${threshold}-of-${owners.length})`, true, c.to, c.data);
  await send(`mint 1000 tokens to ${label}`, true, st.token, encodeFunctionData({ abi: tokenAbi, functionName: 'mint', args: [addr, 1000n * E18] }));
  return addr;
}

// ── Sessions ─────────────────────────────────────────────────────────────────────────────────────────────
export type Session = { pk: Address; key: ReturnType<typeof privateKeyToAccount>; end: bigint; vote: boolean };
export const grantText = (pk: Address, key: Address, end: bigint, vote: boolean) => pub.readContract({ address: pk, abi: PK.abi, functionName: 'grantText', args: [key, end, vote] }) as Promise<string>;
export async function grant(name: string, expectOk: boolean, pk: Address, w: W, o: { seconds?: bigint; end?: bigint; vote?: boolean; signedVote?: boolean; signedEnd?: bigint; key?: ReturnType<typeof privateKeyToAccount>; textFor?: Address; tag?: string } = {}): Promise<Session> {
  const key = o.key ?? privateKeyToAccount(generatePrivateKey()); const end = o.end ?? (await now()) + (o.seconds ?? 3600n); const vote = o.vote ?? false;
  const sig = await w.personalSign(await grantText(o.textFor ?? pk, key.address, o.signedEnd ?? end, o.signedVote ?? vote));
  await send(name, expectOk, pk, encodeFunctionData({ abi: PK.abi, functionName: 'grant', args: [key.address, end, vote, sig] }), { tag: o.tag });
  return { pk, key, end, vote };
}
export const revoke = async (name: string, pk: Address, w: W, key: Address, expectOk = true) =>
  send(name, expectOk, pk, encodeFunctionData({ abi: PK.abi, functionName: 'grant', args: [key, 0n, false, await w.personalSign(await grantText(pk, key, 0n, false))] }));
export const sessionOf = async (pk: Address, key: Address) => pub.readContract({ address: pk, abi: PK.abi, functionName: 'sessions', args: [key] }) as Promise<readonly [bigint, bigint, boolean]>;
export const execHash = (pk: Address, n: bigint, call: Call) => keccak256(encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'address' }, { type: 'uint256' }, { type: 'bytes32' }, { type: 'uint8' }, { type: 'bytes32' }],
  [pk, BigInt(CHAIN_ID), n, call.to, call.value, keccak256(call.data), call.operation, st.roleKey]));
export async function move(name: string, expectOk: boolean, s: { pk: Address; key: ReturnType<typeof privateKeyToAccount> }, call: Call, o: { signer?: ReturnType<typeof privateKeyToAccount>; replay?: Hex; tag?: string } = {}) {
  const n = (await sessionOf(s.pk, s.key.address))[1];
  const sig = o.replay ?? await (o.signer ?? s.key).sign({ hash: execHash(s.pk, n, call) });
  await send(name, expectOk, s.pk, encodeFunctionData({ abi: PK.abi, functionName: 'exec', args: [call.to, call.value, call.data, call.operation, st.roleKey, s.key.address, sig] }), { tag: o.tag });
  return sig;
}

// ── Traces: what the Safe really passes to a contract owner ──────────────────────────────────────────────
export type Sub = { to: Address; type: string; selector: Hex; input: Hex; gasUsed: bigint };
export async function ownerCalls(txHash: Hex, pks: Address[]): Promise<Sub[]> {
  const t = (await rpc('debug_traceTransaction', [txHash, { tracer: 'callTracer' }])).result;
  const out: Sub[] = [];
  const walk = (c: any) => { if (pks.map(lc).includes(lc(c.to ?? '')) && c.input?.length >= 10) out.push({ to: getAddress(c.to), type: c.type, selector: c.input.slice(0, 10), input: c.input, gasUsed: BigInt(c.gasUsed) }); (c.calls ?? []).forEach(walk); };
  walk(t); return out;
}
export const isValidSigAbi = parseAbi(['function isValidSignature(bytes data, bytes sig) view returns (bytes4)']);
export { encodeFunctionData, parseAbi, getAddress, concat, keccak256, toHex, hashTypedData, decodeFunctionData, encodeAbiParameters, privateKeyToAccount, generatePrivateKey, pad, numberToHex };
export type { Address, Hex };
