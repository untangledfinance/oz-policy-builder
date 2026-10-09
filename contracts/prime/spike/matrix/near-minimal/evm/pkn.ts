// EVM matrix, NEAR-routed: a Prime Account (Safe 1.4.1 + Zodiac Roles v2.1.1, PrimeX onboarding/policy code) on an
// anvil fork of Base Sepolia, or on real Base Sepolia with PKN_LIVE=1.
//   seats (Safe owners, 2-of-3): MetaMask (its own EOA), Freighter and Phantom (their NEAR MPC secp256k1 addresses,
//         reached through the prime-near-signer NEAR contract: SEP-53 for Freighter, plain text for Phantom)
//   sessions: one PrimeSession per wallet is its Roles member (never a Safe owner); the owner signs one personal_sign
//         grant (MetaMask itself; MPC signs the EIP-191 digest for Freighter / Phantom), then the session key signs
//         each move, submitted by the relayer or, when the relayer is down, by the session key paying its own gas.
//         The grant owner of a NEAR-routed wallet is its MPC key under prime:evm-session, a different key from its
//         seat (prime:evm), so no signature made for a grant can count as a seat vote. MetaMask's own key is both.
//         grant + first move can go in one transaction through Multicall3 aggregate3.
//   PKN_NATIVE=1: Phantom uses its own EVM account as both its Safe seat and its PrimeSession owner (no NEAR for Phantom).
//         Seat votes are personal_sign over the 32 raw bytes of the Safe transaction hash, filed as the Safe's eth_sign
//         signature type (v + 4). Grants are personal_sign of the grant text. PKN_PH_BRIDGE=http://127.0.0.1:8831 sends
//         every Phantom signature to the real extension (phantom-evm/bridge.mjs); without it a local key stands in.
import { recoverAddress, createPublicClient, createWalletClient, http, encodeFunctionData, parseAbi, getAddress, concat, pad, numberToHex, keccak256, toHex, hashMessage, encodeAbiParameters, parseEther, nonceManager, type Address, type Hex } from 'viem';
import { publicActionsL2 } from 'viem/op-stack';
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts';
import { baseSepolia } from 'viem/chains';
import { readFileSync, writeFileSync } from 'node:fs';
const { metamask, secpAddr, secpSign, stats } = await import(process.env.NEARSIG_STUB ?? '/home/ubuntu/work/near-session-spike/nearsig.ts');
const OCT = '/home/ubuntu/git/github.com/untangledfinance/octopos/apps/evm-web/src/core';
const ob = await import(`${OCT}/onboarding.ts`);
const pol = await import(`${OCT}/evm-policy.ts`);
const { CONTRACTS } = await import(`${OCT}/contracts.ts`);

// PKN_LIVE=1 runs on real Base Sepolia (relayer key from PKN_KEY); otherwise on the local anvil fork.
const LIVE = !!process.env.PKN_LIVE;
const NATIVE = !!process.env.PKN_NATIVE, PH_BRIDGE = process.env.PKN_PH_BRIDGE;
const RPC = LIVE ? 'https://sepolia.base.org' : 'http://127.0.0.1:8547';
const pub = createPublicClient({ chain: baseSepolia, transport: http(RPC), pollingInterval: 1000 }).extend(publicActionsL2());
const relayerAcct = LIVE ? privateKeyToAccount(process.env.PKN_KEY as Hex, { nonceManager }) : privateKeyToAccount('0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'); // anvil dev #0 (public)
const wallet = (a: ReturnType<typeof privateKeyToAccount>) => createWalletClient({ chain: baseSepolia, transport: http(RPC), account: a });
const relayer = wallet(relayerAcct);
const rpc = (method: string, params: unknown[]) => fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) }).then((r) => r.json());
const st: any = {}; const results: any[] = [];
const save = () => writeFileSync(process.env.PKN_STATE ?? (LIVE ? 'state-pkn-live.json' : NATIVE ? 'state-pkn-native.json' : 'state-pkn.json'), JSON.stringify({ ...st, results }, (_, v) => (typeof v === 'bigint' ? v.toString() : v), 1));
function record(name: string, expectOk: boolean, ok: boolean, detail: string) {
  const pass = ok === expectOk; results.push({ name, pass, ok, detail, tx: lastTx }); lastTx = undefined; save();
  console.log(`${pass ? 'PASS' : 'FAIL'} ${name} | ${ok ? `ok ${detail}` : `refused: ${detail}`}`);
  return ok;
}
const ROLES: Record<number, string> = { 2: 'TargetAddressNotAllowed', 3: 'FunctionNotAllowed', 7: 'ParameterNotAllowed', 17: 'AllowanceExceeded' };
const reason = (e: any) => { const s = String(e?.shortMessage ?? e?.message ?? e).replace(/\s+/g, ' ');
  const m = s.replace(/\s/g, '').match(/0xd0a9bf58:?([0-9a-f]{64})/i); if (m) return `Roles ConditionViolation(${ROLES[parseInt(m[1]!, 16)] ?? parseInt(m[1]!, 16)})`;
  if (/0xfd8e9f28/i.test(s)) return 'Roles NoMembership';
  return s.match(/(reverted with reason: [^.]*|GS\d{3}|reverted with the following reason:[^.]*|insufficient funds[^.]*|custom error 0x[0-9a-f]{8})/i)?.[0] ?? s.slice(0, 140); };
const gasOf: Record<string, bigint> = {};
let lastTx: Hex | undefined;
// Public RPCs sit behind load balancers whose nodes can lag a block or two: wait until several reads agree on the new block.
async function settle(block: bigint) { if (!LIVE) return; for (let ok = 0; ok < 4;) { ok = (await pub.getBlockNumber({ cacheTime: 0 })) > block ? ok + 1 : 0; await new Promise((r) => setTimeout(r, 500)); } }
// Give `key` just enough ETH to submit `data` itself (fork: set the balance; live: a small transfer from the relayer).
async function fund(key: Address, to: Address, data: Hex) {
  if (!LIVE) return rpc('anvil_setBalance', [key, toHex(parseEther('0.01'))]);
  const gp = await pub.getGasPrice();
  let g = 400_000n; try { g = (await pub.estimateGas({ account: key, to, data })) * 2n; } catch {}
  const l1 = await pub.estimateL1Fee({ account: key, to, data, chain: baseSepolia });
  const need = g * gp * 2n + l1 * 3n, have = await pub.getBalance({ address: key });
  if (have < need) await settle((await pub.waitForTransactionReceipt({ hash: await relayer.sendTransaction({ to: key, value: need - have }) })).blockNumber);
}
// Empty `key` (live: send everything back to the relayer, leaving less than any call costs).
async function drain(key: ReturnType<typeof privateKeyToAccount>) {
  if (!LIVE) return rpc('anvil_setBalance', [key.address, '0x0']);
  const bal = await pub.getBalance({ address: key.address }), gp = await pub.getGasPrice();
  const l1 = await pub.estimateL1Fee({ account: key, to: relayerAcct.address, value: 1n, gasPrice: gp, chain: baseSepolia });
  const value = bal - 21000n * gp - l1 * 11n / 10n;
  if (value > 0n) await settle((await pub.waitForTransactionReceipt({ hash: await wallet(key).sendTransaction({ to: relayerAcct.address, value, gas: 21000n, gasPrice: gp }) })).blockNumber);
  return pub.getBalance({ address: key.address });
}
async function send(name: string, expectOk: boolean, to: Address, data: Hex, o: { from?: ReturnType<typeof privateKeyToAccount>; tag?: string } = {}) {
  let ok = true, d = '';
  const from = o.from ?? relayerAcct;
  try { await pub.call({ account: from, to, data }); const gas = LIVE ? (await pub.estimateGas({ account: from, to, data })) * 3n / 2n : 3_000_000n; const h = await wallet(from).sendTransaction({ to, data, gas }); lastTx = h; const r = await pub.waitForTransactionReceipt({ hash: h }); await settle(r.blockNumber); ok = r.status === 'success'; d = `gas ${r.gasUsed}${from === relayerAcct ? '' : ' (paid by ' + from.address.slice(0, 8) + '…)'}`; if (o.tag) gasOf[o.tag] = r.gasUsed; }
  catch (e: any) { ok = false; d = reason(e); }
  return record(name, expectOk, ok, d);
}
async function deploy(a: any, args: any[] = [], tag?: string) { const h = await relayer.deployContract({ abi: a.abi, bytecode: a.bytecode.object, args }); const r = await pub.waitForTransactionReceipt({ hash: h }); await settle(r.blockNumber); if (tag) gasOf[tag] = r.gasUsed; return getAddress(r.contractAddress!); }
const art = (dir: string, n: string) => JSON.parse(readFileSync(`${dir}/out/${n}.sol/${n}.json`, 'utf8'));
const PK = art('/home/ubuntu/work/prime-evm', 'PrimeSession'), TK = art('/home/ubuntu/work/evm-matrix', 'Token');
const tokenAbi = parseAbi(['function mint(address,uint256)', 'function transfer(address,uint256) returns (bool)', 'function balanceOf(address) view returns (uint256)']);
const safeAbi = parseAbi(['function nonce() view returns (uint256)', 'function getOwners() view returns (address[])', 'function getThreshold() view returns (uint256)', 'function addOwnerWithThreshold(address owner, uint256 threshold)']);
const fresh = () => getAddress(privateKeyToAccount(generatePrivateKey()).address);
const VENUE = fresh(), OTHER = fresh(), DEST = fresh();
const E18 = 10n ** 18n;
const tokenTransfer = (to: Address, n: bigint) => ({ to: st.token as Address, value: 0n, operation: 0 as const, data: encodeFunctionData({ abi: tokenAbi, functionName: 'transfer', args: [to, n * E18] }) });
const bal = (a: Address) => pub.readContract({ address: st.token, abi: tokenAbi, functionName: 'balanceOf', args: [a] });
const now = async () => (await pub.getBlock()).timestamp;

// ── Wallets ────────────────────────────────────────────────────────────────────────────────────
const PATH = 'prime:evm';
type W = { name: string; addr: Address; signHash: (h: Hex) => Promise<Hex>; personalSign: (t: string) => Promise<Hex> };
const viaNear = async (name: 'Freighter' | 'Phantom', path = PATH): Promise<W> => ({ name, addr: await secpAddr(name, path),
  signHash: (h) => secpSign(name, path, h), personalSign: (t) => secpSign(name, path, hashMessage(t)) });
const MM: W = { name: 'MetaMask', addr: metamask.address, signHash: (h) => metamask.sign({ hash: h }), personalSign: (t) => metamask.signMessage({ message: t }) };
const SESSION_PATH = 'prime:evm-session';
// Phantom's own EVM account. Its Safe vote is personal_sign over the 32 raw bytes of the Safe transaction hash; the Safe takes it as
// an eth_sign signature (v + 4). The real extension signs through phantom-evm/bridge.mjs; without the bridge a local key stands in.
const nat = { calls: 0, ms: 0 };
const phLocal = privateKeyToAccount(generatePrivateKey());
const phSign = async (message: string | Hex, raw: boolean): Promise<{ addr: Address; sig: Hex }> => {
  const t0 = Date.now(); nat.calls++;
  try {
    if (!PH_BRIDGE) return { addr: phLocal.address, sig: await phLocal.signMessage({ message: raw ? { raw: message as Hex } : message }) };
    const r = await (await fetch(PH_BRIDGE, { method: 'POST', body: JSON.stringify({ method: 'personal_sign', message }) })).json() as any;
    if (r.error) throw new Error(`Phantom: ${r.error}`);
    return { addr: getAddress(r.addr), sig: r.sig };
  } finally { nat.ms += Date.now() - t0; }
};
const toEthSign = (sig: Hex): Hex => { const v = parseInt(sig.slice(-2), 16); return `${sig.slice(0, -2)}${(v < 27 ? v + 31 : v + 4).toString(16)}` as Hex; };
const phAddr = !NATIVE ? undefined : !PH_BRIDGE ? phLocal.address : getAddress(((await (await fetch(PH_BRIDGE, { method: 'POST', body: JSON.stringify({ method: 'address' }) })).json()) as any).addr);
const NPH: W = { name: 'Phantom', addr: phAddr!, signHash: async (h) => toEthSign((await phSign(h, true)).sig), personalSign: async (t) => (await phSign(t, false)).sig };
const FR = await viaNear('Freighter'), PH = NATIVE ? NPH : await viaNear('Phantom');                                // seats
const FR_S = await viaNear('Freighter', SESSION_PATH), PH_S = NATIVE ? NPH : await viaNear('Phantom', SESSION_PATH); // grant owners
const FR_OTHER_PATH = await viaNear('Freighter', 'prime:evm-other');
console.log('seats:', MM.addr, FR.addr, PH.addr);
console.log('session owners:', MM.addr, FR_S.addr, PH_S.addr);

// ── Safe transactions (seats) ──────────────────────────────────────────────────────────────────
type Part = { owner: Address; sig: Hex; dynamic?: Hex };
async function safeTx(name: string, expectOk: boolean, call: { to: Address; value: bigint; data: Hex; operation: 0 | 1 }, parts: (h: Hex) => Promise<Part[]>, tag?: string) {
  const nonce = await pub.readContract({ address: st.safe, abi: safeAbi, functionName: 'nonce' });
  const tx = { ...call, safeTxGas: 0n, baseGas: 0n, gasPrice: 0n, gasToken: '0x0000000000000000000000000000000000000000' as Address, refundReceiver: '0x0000000000000000000000000000000000000000' as Address, nonce };
  const hash = ob.hashSafeTransaction(84532, st.safe, tx);
  const ps = (await parts(hash)).sort((a, b) => (BigInt(a.owner) < BigInt(b.owner) ? -1 : 1));
  const tail: Hex[] = []; let off = 65 * ps.length;
  const statics = ps.map((p) => { if (!p.dynamic) return p.sig; const len = (p.dynamic.length - 2) / 2; tail.push(concat([pad(numberToHex(len), { size: 32 }), p.dynamic]));
    const s = concat([pad(p.owner, { size: 32 }), pad(numberToHex(off), { size: 32 }), '0x00']); off += 32 + len; return s; });
  return send(name, expectOk, st.safe, ob.encodeExecTransaction(tx, statics.length ? concat([...statics, ...tail]) : '0x'), { tag });
}
const by = (...ws: W[]) => async (h: Hex) => Promise.all(ws.map(async (w) => ({ owner: w.addr, sig: await w.signHash(h) })));

// ── Sessions ───────────────────────────────────────────────────────────────────────────────────
type Session = { pk: Address; key: ReturnType<typeof privateKeyToAccount>; end: bigint };
const grantText = (pk: Address, key: Address, end: bigint) => pub.readContract({ address: pk, abi: PK.abi, functionName: 'grantText', args: [key, end] }) as Promise<string>;
async function grant(name: string, expectOk: boolean, pk: Address, w: W, o: { seconds?: bigint; end?: bigint; signedEnd?: bigint; key?: ReturnType<typeof privateKeyToAccount>; textFor?: Address; selfPay?: boolean } = {}): Promise<Session> {
  const key = o.key ?? privateKeyToAccount(generatePrivateKey()); const end = o.end ?? (await now()) + (o.seconds ?? 3600n);
  const text = await grantText(o.textFor ?? pk, key.address, o.signedEnd ?? end);
  const sig = await w.personalSign(text);
  const data = encodeFunctionData({ abi: PK.abi, functionName: 'grant', args: [key.address, end, sig] });
  if (o.selfPay) await fund(key.address, pk, data);
  await send(name, expectOk, pk, data, { from: o.selfPay ? key : undefined, tag: expectOk ? `grant${w.name}` : undefined });
  return { pk, key, end };
}
const execHash = (pk: Address, n: bigint, call: { to: Address; value: bigint; data: Hex; operation: 0 | 1 }) => keccak256(encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'address' }, { type: 'uint256' }, { type: 'bytes32' }, { type: 'uint8' }, { type: 'bytes32' }],
  [pk, 84532n, n, call.to, call.value, keccak256(call.data), call.operation, st.roleKey]));
const execData = (s: Session, call: { to: Address; value: bigint; data: Hex; operation: 0 | 1 }, sig: Hex) => encodeFunctionData({ abi: PK.abi, functionName: 'exec', args: [call.to, call.value, call.data, call.operation, st.roleKey, s.key.address, sig] });
const sessionNonce = async (s: Session) => (await pub.readContract({ address: s.pk, abi: PK.abi, functionName: 'sessions', args: [s.key.address] }) as readonly [bigint, bigint])[1];
const sessionUntil = async (pk: Address, key: Address) => (await pub.readContract({ address: pk, abi: PK.abi, functionName: 'sessions', args: [key] }) as readonly [bigint, bigint])[0];
async function move(name: string, expectOk: boolean, s: Session, call: { to: Address; value: bigint; data: Hex; operation: 0 | 1 }, o: { signer?: ReturnType<typeof privateKeyToAccount>; replay?: Hex; selfPay?: boolean; fund?: boolean; tag?: string } = {}) {
  const sig = o.replay ?? await (o.signer ?? s.key).sign({ hash: execHash(s.pk, await sessionNonce(s), call) });
  const data = execData(s, call, sig);
  if (o.selfPay) { if (o.fund === false) st.drained = String(await drain(s.key)); else await fund(s.key.address, s.pk, data); }
  await send(name, expectOk, s.pk, data, { from: o.selfPay ? s.key : undefined, tag: o.tag });
  return sig;
}
// Grant + the session's first move in one transaction through Multicall3. The grant may fail (someone else already
// submitted it); the move may not, and it needs a live session, so a bad grant signature still cannot move.
const MULTICALL3: Address = '0xcA11bde05977b3631167028862bE2a173976CA11';
const multicallAbi = parseAbi(['struct Call3 { address target; bool allowFailure; bytes callData; }', 'struct Result { bool success; bytes returnData; }', 'function aggregate3(Call3[] calls) payable returns (Result[] returnData)']);
async function grantAndMove(name: string, expectOk: boolean, pk: Address, w: W, call: { to: Address; value: bigint; data: Hex; operation: 0 | 1 }, o: { selfPay?: boolean; tag?: string; pregrant?: string; badSig?: boolean } = {}): Promise<Session> {
  const key = privateKeyToAccount(generatePrivateKey()); const end = (await now()) + 3600n; const s: Session = { pk, key, end };
  const text = await grantText(pk, key.address, end);
  const g = encodeFunctionData({ abi: PK.abi, functionName: 'grant', args: [key.address, end, o.badSig ? await privateKeyToAccount(generatePrivateKey()).signMessage({ message: text }) : await w.personalSign(text)] });
  if (o.pregrant) await send(o.pregrant, true, pk, g);
  const e = execData(s, call, await key.sign({ hash: execHash(pk, 0n, call) }));
  const data = encodeFunctionData({ abi: multicallAbi, functionName: 'aggregate3', args: [[{ target: pk, allowFailure: true, callData: g }, { target: pk, allowFailure: false, callData: e }]] });
  if (o.selfPay) await fund(key.address, MULTICALL3, data);
  await send(name, expectOk, MULTICALL3, data, { from: o.selfPay ? key : undefined, tag: o.tag });
  return s;
}

// ── O. Any number of owners and any threshold: PRIME_OWNERS (default 3) and PRIME_THRESHOLD (default 2) ───────────────
// The default 3 and 2 run the matrix below. Any other pair runs this block instead: the first three owners are the real
// wallets (MetaMask's own key, then Freighter and Phantom through NEAR), further owners are plain local keys; each owner has
// its own PrimeSession. The block exits when it is done.
const N_OWN = Number(process.env.PRIME_OWNERS ?? 3), THR = Number(process.env.PRIME_THRESHOLD ?? 2);
if (!Number.isInteger(N_OWN) || !Number.isInteger(THR) || N_OWN < 1 || THR < 1 || THR > N_OWN) throw new Error(`PRIME_OWNERS=${N_OWN} PRIME_THRESHOLD=${THR}: need integers with 1 <= threshold <= owners`);
if (N_OWN !== 3 || THR !== 2) {
  if (NATIVE) throw new Error('PRIME_OWNERS / PRIME_THRESHOLD do not combine with PKN_NATIVE');
  type Own = { name: string; seat: W; sess: W };
  const plain = (n: number): Own => { const a = privateKeyToAccount(generatePrivateKey());
    const w: W = { name: `Owner${n}`, addr: a.address, signHash: (h) => a.sign({ hash: h }), personalSign: (t) => a.signMessage({ message: t }) }; return { name: w.name, seat: w, sess: w }; };
  const roster: Own[] = [{ name: 'MetaMask', seat: MM, sess: MM }, { name: 'Freighter', seat: FR, sess: FR_S }, { name: 'Phantom', seat: PH, sess: PH_S }]
    .slice(0, N_OWN).concat(Array.from({ length: Math.max(0, N_OWN - 3) }, (_, i) => plain(i + 4)));
  const TAG = `${THR}-of-${N_OWN}`;
  const ext = parseAbi(['function removeOwner(address prevOwner, address owner, uint256 _threshold)']);
  const rolesAbi = parseAbi(['function assignRoles(address module, bytes32[] roleKeys, bool[] memberOf)']);
  const SENTINEL: Address = '0x0000000000000000000000000000000000000001';
  const lc = (a: string) => a.toLowerCase();
  const voteBy = (os: Own[]) => by(...os.map((o) => o.seat));
  const safeOwners = async () => (await pub.readContract({ address: st.safe, abi: safeAbi, functionName: 'getOwners' }) as Address[]);
  const sameSet = (a: Own[], b: Own[]) => a.length === b.length && a.every((o) => b.includes(o));
  console.log(`${TAG}:`, roster.map((o) => `${o.name} seat ${o.seat.addr.slice(0, 8)} owner ${o.sess.addr.slice(0, 8)}`).join('; '));

  st.token = await deploy(TK);
  const t1 = tokenTransfer(DEST, 1n);
  const proxyCreationCode = await pub.readContract({ address: CONTRACTS.safeProxyFactory, abi: parseAbi(['function proxyCreationCode() view returns (bytes)']), functionName: 'proxyCreationCode' }) as Hex;
  const initializer = ob.encodeSafeInitializer([roster[0]!.seat.addr], 1n, CONTRACTS.compatibilityFallbackHandler);
  const salt = BigInt(keccak256(toHex(`pkn-${TAG}-${Date.now()}`)));
  st.safe = ob.predictSafeAddress(proxyCreationCode, initializer, salt); st.roles = ob.predictPrimeRolesAddress(st.safe);
  st.pks = [] as Address[];
  for (const [i, o] of roster.entries()) st.pks.push(await deploy(PK, [o.sess.addr, st.roles], i === 0 ? 'deployPrimeSession' : undefined));
  const doc = { spendingLimit: 1 as const, token: st.token, recipients: [VENUE], amount: ((100n + 20n * BigInt(N_OWN)) * E18).toString(), period: '86400' };
  const rule = pol.buildRuleInstall({ doc, docText: JSON.stringify(doc), name: 'movers', ctx: { prime: st.safe, primeRoles: st.roles }, proxyCreationCode, wallets: st.pks, threshold: 1 });
  st.roleKey = rule.roleKey; st.owners = roster.map((o) => ({ name: o.name, seat: o.seat.addr, owner: o.sess.addr })); st.threshold = THR; save();
  const pkOf = (o: Own) => st.pks[roster.indexOf(o)] as Address;
  const c = ob.encodeCreateSafe(initializer, salt);
  await send(`O1. create the Safe with ${roster[0]!.name} as its only owner`, true, c.to, c.data);
  const init = ob.buildSafeInitializationTransaction(st.safe, roster.slice(1).map((o) => o.seat.addr), BigInt(THR), rule.calls);
  await send(`O2. ${roster[0]!.name} adds the other ${N_OWN - 1} owners, sets threshold ${THR}, installs Roles with the ${N_OWN} PrimeSessions and the rule`, true, st.safe, ob.encodeExecTransaction(init, await roster[0]!.seat.signHash(ob.hashSafeTransaction(84532, st.safe, init))), { tag: 'setupSafe' });
  { const own = (await safeOwners()).map(lc), thr = await pub.readContract({ address: st.safe, abi: safeAbi, functionName: 'getThreshold' });
    record(`O3. Safe owners are exactly the ${N_OWN} seat keys (no PrimeSession), threshold ${THR}`, true, own.length === N_OWN && roster.every((o) => own.includes(lc(o.seat.addr))) && !st.pks.some((a: Address) => own.includes(lc(a))) && thr === BigInt(THR), `${own.length} owners / ${thr}`);
    const po = await Promise.all(st.pks.map((a: Address) => pub.readContract({ address: a, abi: PK.abi, functionName: 'owner' }) as Promise<Address>));
    record(`O4. each PrimeSession's owner is its own wallet's grant key, and all ${N_OWN} differ`, true, po.every((a, i) => a === roster[i]!.sess.addr) && new Set(po.map(lc)).size === N_OWN, po.map((a) => a.slice(0, 8)).join(',')); }
  await send('O5. mint 100000 tokens to the Safe', true, st.token, encodeFunctionData({ abi: tokenAbi, functionName: 'mint', args: [st.safe, 100000n * E18] }));

  // seats: threshold - 1 votes refused, threshold votes accepted, any threshold-sized subset
  {
    const first = roster.slice(0, THR), last = roster.slice(N_OWN - THR), outsider = privateKeyToAccount(generatePrivateKey());
    const b = await bal(DEST);
    await safeTx(`S1. ${THR - 1} of ${N_OWN} owners vote (threshold minus one)`, false, t1, voteBy(roster.slice(0, THR - 1)));
    await safeTx(`S2. ${THR} owners vote (${first.map((o) => o.name).join(' + ')})`, true, t1, voteBy(first), 'safeThreshold');
    if (!sameSet(first, last)) await safeTx(`S3. a different ${THR} owners vote (${last.map((o) => o.name).join(' + ')})`, true, t1, voteBy(last));
    await safeTx(`S4. ${THR - 1} owners and an outsider vote`, false, t1, async (h) => [...await voteBy(roster.slice(0, THR - 1))(h), { owner: outsider.address, sig: await outsider.sign({ hash: h }) }]);
    if (THR >= 2) await safeTx(`S5. ${roster[0]!.name} signs ${THR} times, as ${THR} votes`, false, t1, async (h) => { const s = await roster[0]!.seat.signHash(h); return Array.from({ length: THR }, () => ({ owner: roster[0]!.seat.addr, sig: s })); });
    record(`S6. DEST received exactly ${sameSet(first, last) ? 1 : 2} (the accepted transactions only)`, true, (await bal(DEST)) - b === (sameSet(first, last) ? 1n : 2n) * E18, `${((await bal(DEST)) - b) / E18}`);
  }

  // each owner: a session of its own, relayed and self-paid moves, revoke, no vote
  const live: Session[] = [];
  for (const [i, o] of roster.entries()) {
    const pk = pkOf(o), p = `P${i}-${o.name}`, others = roster.filter((x) => x !== o);
    const s = await grant(`${p}.1 ${o.name} grants a 1-hour session on its own PrimeSession, relayer submits`, true, pk, o.sess); live.push(s);
    const b = await bal(VENUE);
    await move(`${p}.2 move via relayer: 3 to VENUE`, true, s, tokenTransfer(VENUE, 3n), { tag: `moveRelayer${o.name}` });
    await move(`${p}.3 relayer down: the session key pays its own gas, 2 to VENUE`, true, s, tokenTransfer(VENUE, 2n), { selfPay: true, tag: `moveSelf${o.name}` });
    record(`${p}.4 VENUE received exactly 5`, true, (await bal(VENUE)) - b === 5n * E18, `${((await bal(VENUE)) - b) / E18}`);
    await move(`${p}.5 1 to another address (Roles rule)`, false, s, tokenTransfer(OTHER, 1n));
    const voters = others.slice(0, THR - 1);
    await safeTx(`${p}.6 the session key's signature as a Safe owner + ${voters.length} real owner votes (${THR} signatures)`, false, t1, async (h) => [...await voteBy(voters)(h), { owner: s.key.address, sig: await s.key.sign({ hash: h }) }]);
    await safeTx(`${p}.7 the PrimeSession as a contract signature + ${voters.length} real owner votes`, false, t1, async (h) => [...await voteBy(voters)(h), { owner: pk, sig: '0x' as Hex, dynamic: await s.key.sign({ hash: h }) }]);
    await move(`${p}.8 session asks Roles to add its key as a Safe owner`, false, s, { to: st.safe, value: 0n, operation: 0, data: encodeFunctionData({ abi: safeAbi, functionName: 'addOwnerWithThreshold', args: [s.key.address, 1n] }) });
    const r = await grant(`${p}.9 ${o.name} grants a second session`, true, pk, o.sess);
    await send(`${p}.10 ${o.name} revokes it: grant with end 0 (one signature)`, true, pk, encodeFunctionData({ abi: PK.abi, functionName: 'grant', args: [r.key.address, 0n, await o.sess.personalSign(await grantText(pk, r.key.address, 0n))] }), { tag: `revoke${o.name}` });
    await move(`${p}.11 the revoked session`, false, r, tokenTransfer(VENUE, 1n));
    await move(`${p}.12 the first session still works`, true, s, tokenTransfer(VENUE, 1n));
    if (others.length) { const x = others[i % others.length]!;
      await grant(`${p}.13 a grant signed by ${x.name} presented to ${o.name}'s PrimeSession`, false, pk, x.sess); }
  }

  // removal: the owners drop one owner's PrimeSession from Roles, then the owner itself from the Safe
  {
    const k = roster[N_OWN - 1]!, rest = roster.filter((x) => x !== k), voters = rest.length >= THR ? rest.slice(0, THR) : roster.slice(0, THR), pk = pkOf(k);
    const ks = live[N_OWN - 1]!, other = roster.find((x) => x !== k);
    await move(`R0. ${k.name}'s live session works before removal`, true, ks, tokenTransfer(VENUE, 1n));
    await safeTx(`R1. ${THR - 1} owners try to remove ${k.name}'s PrimeSession from the Roles members`, false, { to: st.roles, value: 0n, operation: 0, data: encodeFunctionData({ abi: rolesAbi, functionName: 'assignRoles', args: [pk, [st.roleKey], [false]] }) }, voteBy(voters.slice(0, THR - 1)));
    await safeTx(`R2. ${THR} owners remove ${k.name}'s PrimeSession from the Roles members (${voters.map((o) => o.name).join(' + ')})`, true, { to: st.roles, value: 0n, operation: 0, data: encodeFunctionData({ abi: rolesAbi, functionName: 'assignRoles', args: [pk, [st.roleKey], [false]] }) }, voteBy(voters));
    await move(`R3. ${k.name}'s live session after removal`, false, ks, tokenTransfer(VENUE, 1n));
    const again = await grant(`R4. ${k.name} signs a new grant (the contract still takes it)`, true, pk, k.sess);
    await move('R5. the new session cannot move either (no Roles membership)', false, again, tokenTransfer(VENUE, 1n));
    if (other) { const os = live[roster.indexOf(other)]!; await move(`R6. ${other.name}'s session still works`, true, os, tokenTransfer(VENUE, 1n)); }
    if (N_OWN >= 2) {
      const own = await safeOwners(), i = own.findIndex((a) => lc(a) === lc(k.seat.addr)), newThr = BigInt(Math.min(THR, N_OWN - 1));
      const rm = { to: st.safe, value: 0n, operation: 0 as const, data: encodeFunctionData({ abi: ext, functionName: 'removeOwner', args: [i === 0 ? SENTINEL : own[i - 1]!, k.seat.addr, newThr] }) };
      await safeTx(`R7. ${THR} owners remove ${k.name} from the Safe (new threshold ${newThr})`, true, rm, voteBy(voters));
      const after = (await safeOwners()).map(lc), thr = await pub.readContract({ address: st.safe, abi: safeAbi, functionName: 'getThreshold' });
      record(`R8. the Safe now has ${N_OWN - 1} owners without ${k.name}, threshold ${newThr}`, true, after.length === N_OWN - 1 && !after.includes(lc(k.seat.addr)) && thr === newThr, `${after.length} owners / ${thr}`);
      const remain = rest.slice(0, Number(newThr) - 1);
      await safeTx(`R9. ${k.name}'s vote and ${Number(newThr) - 1} other owners no longer reach the threshold`, false, t1, voteBy([...remain, k]));
      await safeTx(`R10. ${newThr} remaining owners vote`, true, t1, voteBy(rest.slice(0, Number(newThr))));
    } else {
      await safeTx('R7. the sole owner removes itself from a 1-owner Safe', false, { to: st.safe, value: 0n, operation: 0, data: encodeFunctionData({ abi: ext, functionName: 'removeOwner', args: [SENTINEL, k.seat.addr, 1n] }) }, voteBy([k]));
    }
  }
  console.log('gas:', Object.entries(gasOf).map(([k, v]) => `${k} ${v}`).join(', '));
  console.log(`NEAR MPC signatures: ${stats.calls}, average ${(stats.ms / Math.max(1, stats.calls) / 1000).toFixed(1)}s`);
  st.gas = gasOf; st.mpc = stats; save();
  console.log(`${TAG}: ${results.filter((r) => r.pass).length}/${results.length} passed`);
  for (const r of results.filter((r) => !r.pass)) console.log('FAIL', r.name, r.detail);
  process.exit(0);
}

// ── C. Setup ───────────────────────────────────────────────────────────────────────────────────
{ // a zero owner can never match: OpenZeppelin's tryRecover never reports success for the zero address
  const z = await deploy(PK, ['0x0000000000000000000000000000000000000000', fresh()]);
  await send('C0. a zero-owner PrimeSession accepts no grant (garbage signature)', false, z, encodeFunctionData({ abi: PK.abi, functionName: 'grant', args: [fresh(), (await now()) + 3600n, ('0x' + '00'.repeat(65)) as Hex] }));
}
st.token = await deploy(TK);
const proxyCreationCode = await pub.readContract({ address: CONTRACTS.safeProxyFactory, abi: parseAbi(['function proxyCreationCode() view returns (bytes)']), functionName: 'proxyCreationCode' }) as Hex;
const initializer = ob.encodeSafeInitializer([MM.addr], 1n, CONTRACTS.compatibilityFallbackHandler);
const salt = BigInt(keccak256(toHex(`pkn-${Date.now()}`)));
st.safe = ob.predictSafeAddress(proxyCreationCode, initializer, salt); st.roles = ob.predictPrimeRolesAddress(st.safe);
st.pkMM = await deploy(PK, [MM.addr, st.roles], 'deploy'); st.pkFR = await deploy(PK, [FR_S.addr, st.roles]); st.pkPH = await deploy(PK, [PH_S.addr, st.roles]);
st.ownerFR = FR_S.addr; st.ownerPH = PH_S.addr;
const doc = { spendingLimit: 1 as const, token: st.token, recipients: [VENUE], amount: (100n * E18).toString(), period: '86400' };
const rule = pol.buildRuleInstall({ doc, docText: JSON.stringify(doc), name: 'movers', ctx: { prime: st.safe, primeRoles: st.roles }, proxyCreationCode, wallets: [st.pkMM, st.pkFR, st.pkPH], threshold: 1 });
st.roleKey = rule.roleKey; save();
const c = ob.encodeCreateSafe(initializer, salt);
await send('C1. create Safe (MetaMask first, PrimeX flow)', true, c.to, c.data);
const init = ob.buildSafeInitializationTransaction(st.safe, [FR.addr, PH.addr], 2n, rule.calls);
await send(`C2. seats MetaMask + Freighter(NEAR MPC) + Phantom(${NATIVE ? 'own key' : 'NEAR MPC'}), threshold 2; movers rule for the three PrimeSessions`, true, st.safe,
  ob.encodeExecTransaction(init, await MM.signHash(ob.hashSafeTransaction(84532, st.safe, init))));
const owners = (await pub.readContract({ address: st.safe, abi: safeAbi, functionName: 'getOwners' }) as Address[]).map((a) => a.toLowerCase());
const lc = (a: string) => a.toLowerCase();
const thr = await pub.readContract({ address: st.safe, abi: safeAbi, functionName: 'getThreshold' });
record('C3. owners are exactly the three wallet keys (no PrimeSession), threshold 2', true,
  owners.length === 3 && [MM.addr, FR.addr, PH.addr].every((a) => owners.includes(lc(a))) && ![st.pkMM, st.pkFR, st.pkPH].some((a) => owners.includes(lc(a))) && thr === 2n, `${owners.join(',')} / ${thr}`);
await send('C4. mint 1000 tokens to the Safe', true, st.token, encodeFunctionData({ abi: tokenAbi, functionName: 'mint', args: [st.safe, 1000n * E18] }));
{ const owners3 = await Promise.all([st.pkMM, st.pkFR, st.pkPH].map((a) => pub.readContract({ address: a, abi: PK.abi, functionName: 'owner' }) as Promise<Address>));
  record(NATIVE ? 'C5. grant owners: MetaMask and Phantom keep their own keys (seat and owner); Freighter uses a prime:evm-session key that differs from its seat' : 'C5. grant owners: MetaMask keeps its own key (seat and owner); Freighter and Phantom use prime:evm-session keys that differ from their seats', true,
    owners3[0] === MM.addr && owners3[1] === FR_S.addr && owners3[2] === PH_S.addr && FR_S.addr !== FR.addr && (NATIVE ? PH_S.addr === PH.addr : PH_S.addr !== PH.addr) && FR_S.addr !== PH_S.addr, owners3.join(','));
  const mcCode = await pub.getCode({ address: MULTICALL3 });
  record('C6. Multicall3 is deployed at the canonical address', true, (mcCode?.length ?? 0) > 2, `${((mcCode?.length ?? 2) - 2) / 2} bytes`); }

// ── S. Seats ───────────────────────────────────────────────────────────────────────────────────
{
  const t = tokenTransfer(DEST, 1n);
  for (const w of [MM, FR, PH]) await safeTx(`S1-${w.name}. ${w.name} alone`, false, t, by(w));
  const b = await bal(DEST);
  await safeTx('S2. MetaMask + Freighter', true, t, by(MM, FR), 'safeMM+FR');
  await safeTx('S3. Freighter + Phantom (no MetaMask)', true, t, by(FR, PH), 'safeFR+PH');
  await safeTx('S4. Phantom + MetaMask', true, t, by(PH, MM), 'safePH+MM');
  record('S5. DEST received exactly 3', true, (await bal(DEST)) - b === 3n * E18, `${((await bal(DEST)) - b) / E18}`);
  const outsider = privateKeyToAccount(generatePrivateKey());
  await safeTx('S6. outsider + MetaMask', false, t, async (h) => [{ owner: MM.addr, sig: await MM.signHash(h) }, { owner: outsider.address, sig: await outsider.sign({ hash: h }) }]);
  // An ECDSA owner is recovered from its signature, so "Phantom's signature filed as Freighter's" is just Phantom voting.
  // The real check: one wallet cannot count twice.
  await safeTx('S7. the same wallet (Phantom) signs twice, as both votes', false, t, async (h) => { const s = await PH.signHash(h); return [{ owner: PH.addr, sig: s }, { owner: PH.addr, sig: s }]; });
  await safeTx("S8. Freighter's MPC key under another path + MetaMask", false, t, async (h) => [{ owner: MM.addr, sig: await MM.signHash(h) }, { owner: FR.addr, sig: await FR_OTHER_PATH.signHash(h) }]);
  await safeTx('S9. Phantom approval of another Safe tx + MetaMask', false, t, async (h) => [{ owner: MM.addr, sig: await MM.signHash(h) }, { owner: PH.addr, sig: await PH.signHash(keccak256(h)) }]);
  // A grant-path (prime:evm-session) signature over a Safe transaction hash, filed as a seat vote, counts for nothing.
  if (!NATIVE) {
    await safeTx('S10. Freighter and Phantom session-path signatures filed as their seat votes (no MetaMask)', false, t, async (h) => [{ owner: FR.addr, sig: await FR_S.signHash(h) }, { owner: PH.addr, sig: await PH_S.signHash(h) }]);
    await safeTx("S11. Phantom's session-path signature filed as its seat vote + MetaMask", false, t, async (h) => [{ owner: MM.addr, sig: await MM.signHash(h) }, { owner: PH.addr, sig: await PH_S.signHash(h) }]);
  } else {
    // Phantom has one key for both jobs, so only Freighter keeps a separate session path.
    await safeTx("S10. Freighter's session-path signature filed as its seat vote + Phantom", false, t, async (h) => [{ owner: FR.addr, sig: await FR_S.signHash(h) }, { owner: PH.addr, sig: await PH.signHash(h) }]);
  }
}

// ── NS. Native Phantom: one key, two texts. A grant signature is no vote and a vote is no grant ────
if (NATIVE) {
  const t = tokenTransfer(DEST, 1n);
  const probe = privateKeyToAccount(generatePrivateKey());
  const gText = await grantText(st.pkPH, probe.address, (await now()) + 3600n);
  const gSig = await PH.personalSign(gText);                     // what Phantom shows and signs for a session grant
  const voteDigest = (h: Hex) => keccak256(concat([toHex('\x19Ethereum Signed Message:\n32'), h]));  // what the Safe recovers for an eth_sign vote
  await safeTx("NS1. Phantom's grant signature filed as its Safe vote (eth_sign type, v + 4) + MetaMask", false, t, async (h) => [{ owner: MM.addr, sig: await MM.signHash(h) }, { owner: PH.addr, sig: toEthSign(gSig) }]);
  await safeTx("NS2. Phantom's grant signature filed as a plain ECDSA vote over the Safe hash + MetaMask", false, t, async (h) => [{ owner: MM.addr, sig: await MM.signHash(h) }, { owner: PH.addr, sig: gSig }]);
  const gDigest = hashMessage(gText);
  { const h = ob.hashSafeTransaction(84532, st.safe, { ...t, safeTxGas: 0n, baseGas: 0n, gasPrice: 0n, gasToken: '0x0000000000000000000000000000000000000000', refundReceiver: '0x0000000000000000000000000000000000000000', nonce: await pub.readContract({ address: st.safe, abi: safeAbi, functionName: 'nonce' }) });
    record('NS3. the two things Phantom signs are different digests (grant text vs eth_sign of a 32-byte Safe hash), and a grant text is not 32 bytes long', true,
      gDigest !== voteDigest(h) && toHex(gText).length !== 2 + 64 && (await recoverAddress({ hash: gDigest, signature: gSig })) === PH.addr && (await recoverAddress({ hash: voteDigest(h), signature: gSig })) !== PH.addr,
      `grant text ${toHex(gText).length / 2 - 1} bytes, digests ${gDigest.slice(0, 10)}… vs ${voteDigest(h).slice(0, 10)}…`); }
  // A vote signature (personal_sign over the 32 raw bytes of a Safe hash) offered to PrimeSession(Phantom) as the grant signature
  const vh = keccak256(toHex(`vote-${Date.now()}`)); const vSig = await phSign(vh, true).then((r) => r.sig);
  await send("NS4. Phantom's Safe vote signature offered as its PrimeSession grant signature", false, st.pkPH, encodeFunctionData({ abi: PK.abi, functionName: 'grant', args: [probe.address, (await now()) + 3600n, vSig] }));
  // The vote with the right Safe hash still works (the checks above did not disturb the Safe)
  await safeTx('NS5. Phantom vote + MetaMask vote over the real Safe hash', true, t, by(PH, MM));
}

// ── N. A session can never vote as a seat ──────────────────────────────────────────────────────
{
  const t = tokenTransfer(DEST, 1n);
  const s = await grant('N0. Phantom grants a session (used below)', true, st.pkPH, PH_S);
  await safeTx("N1. the session key's signature as a Safe owner + MetaMask", false, t, async (h) => [{ owner: MM.addr, sig: await MM.signHash(h) }, { owner: s.key.address, sig: await s.key.sign({ hash: h }) }]);
  await safeTx('N2. PrimeSession(Phantom) as a contract signature + MetaMask', false, t, async (h) => [{ owner: MM.addr, sig: await MM.signHash(h) }, { owner: st.pkPH, sig: '0x' as Hex, dynamic: await s.key.sign({ hash: h }) }]);
  await move('N3. session asks Roles to add the session key as a Safe owner', false, s, { to: st.safe, value: 0n, operation: 0, data: encodeFunctionData({ abi: safeAbi, functionName: 'addOwnerWithThreshold', args: [s.key.address, 1n] }) });
  await move('N4. session asks Roles for a delegatecall', false, s, { ...tokenTransfer(VENUE, 1n), operation: 1 });
  await move('N5. session asks Roles to call the Roles modifier itself (re-assign roles)', false, s, { to: st.roles, value: 0n, operation: 0, data: encodeFunctionData({ abi: parseAbi(['function assignRoles(address,bytes32[],bool[])']), functionName: 'assignRoles', args: [s.key.address, [st.roleKey], [true]] }) });
}

// ── G. Sessions, every wallet ──────────────────────────────────────────────────────────────────
for (const [w, pk] of [[MM, st.pkMM], [FR_S, st.pkFR], [PH_S, st.pkPH]] as [W, Address][]) {
  const s = await grant(`G-${w.name}1. ${w.name} grants a 1-hour session (one signature${w === MM || (NATIVE && w === PH_S) ? '' : ' through NEAR'}), relayer submits`, true, pk, w);
  const b = await bal(VENUE);
  await move(`G-${w.name}2. move via relayer: 10 to VENUE`, true, s, tokenTransfer(VENUE, 10n), { tag: `moveRelayer${w.name}` });
  await move(`G-${w.name}3. relayer down: session key submits and pays gas itself, 5 to VENUE`, true, s, tokenTransfer(VENUE, 5n), { selfPay: true, tag: `moveSelf${w.name}` });
  await move(`G-${w.name}4. relayer down and the session key has no ETH`, false, s, tokenTransfer(VENUE, 1n), { selfPay: true, fund: false });
  record(`G-${w.name}5. VENUE received exactly 15`, true, (await bal(VENUE)) - b === 15n * E18, `${((await bal(VENUE)) - b) / E18}`);
  const sig = await move(`G-${w.name}6. move 3: 1 to VENUE`, true, s, tokenTransfer(VENUE, 1n), { tag: `moveLater${w.name}` });
  await move(`G-${w.name}7. move 3 replayed`, false, s, tokenTransfer(VENUE, 1n), { replay: sig });
  await move(`G-${w.name}8. 1 to another address (Roles rule)`, false, s, tokenTransfer(OTHER, 1n));
  await move(`G-${w.name}9. move signed by another key`, false, s, tokenTransfer(VENUE, 1n), { signer: privateKeyToAccount(generatePrivateKey()) });
  await grant(`G-${w.name}10. grant for 7 days + 1 hour`, false, pk, w, { seconds: 7n * 86400n + 3600n });
  await grant(`G-${w.name}11. grant submitted with a later end than signed`, false, pk, w, { end: s.end + 3600n, signedEnd: s.end });
  await grant(`G-${w.name}12. old grant replayed with an earlier end`, false, pk, w, { key: s.key, end: s.end - 60n });
  // The zero key is owner-signed, so storing it is harmless: no signature recovers to the zero address, so it can never move.
  const zero: Session = { pk, key: { address: '0x0000000000000000000000000000000000000000' } as any, end: 0n };
  zero.end = (await now()) + 3600n;
  await grant(`G-${w.name}13. grant for the zero key is accepted (owner-signed, stored)`, true, pk, w, { key: zero.key, end: zero.end });
  await move(`G-${w.name}13b. the zero key can never move (no signature recovers to it)`, false, zero, tokenTransfer(VENUE, 1n), { replay: `0x${'11'.repeat(32)}${'22'.repeat(32)}1b` as Hex });
  const r = await grant(`G-${w.name}14. second session, granted with the session key paying gas itself`, true, pk, w, { selfPay: true });
  await send(`G-${w.name}15. ${w.name} revokes it: grant with end 0 (one signature)`, true, pk, encodeFunctionData({ abi: PK.abi, functionName: 'grant', args: [r.key.address, 0n, await w.personalSign(await grantText(pk, r.key.address, 0n))] }), { tag: `revoke${w.name}` });
  await move(`G-${w.name}16. the revoked session`, false, r, tokenTransfer(VENUE, 1n));
  await grant(`G-${w.name}17. re-grant the revoked key`, false, pk, w, { key: r.key });
  await move(`G-${w.name}18. first session still works`, true, s, tokenTransfer(VENUE, 1n));
  const bc = await bal(VENUE);
  const c1 = await grantAndMove(`G-${w.name}19. grant + first move in one Multicall3 transaction, relayer submits`, true, pk, w, tokenTransfer(VENUE, 2n), { tag: `grantMoveRelayer${w.name}` });
  record(`G-${w.name}20. that session is live with nonce 1 afterwards, and VENUE got the 2`, true, (await sessionNonce(c1)) === 1n && (await sessionUntil(pk, c1.key.address)) === c1.end && (await bal(VENUE)) - bc === 2n * E18, `nonce ${await sessionNonce(c1)}`);
  const c2 = await grantAndMove(`G-${w.name}21. grant + first move in one transaction, the session key pays its own gas`, true, pk, w, tokenTransfer(VENUE, 2n), { selfPay: true, tag: `grantMoveSelf${w.name}` });
  await move(`G-${w.name}22. the combined session's second move`, true, c2, tokenTransfer(VENUE, 1n));
  const bad = await grantAndMove(`G-${w.name}23. grant + a refused first move (1 to another address): the whole transaction reverts`, false, pk, w, tokenTransfer(OTHER, 1n));
  record(`G-${w.name}24. and the grant was not stored`, true, (await sessionUntil(pk, bad.key.address)) === 0n, `until ${await sessionUntil(pk, bad.key.address)}`);
  const pre = await grantAndMove(`G-${w.name}26. the same grant was already submitted alone: the combined call still makes the move`, true, pk, w, tokenTransfer(VENUE, 1n), { pregrant: `G-${w.name}25. grant submitted alone first (front-run)` });
  record(`G-${w.name}27. that session shows nonce 1 (the move ran once)`, true, (await sessionNonce(pre)) === 1n, `nonce ${await sessionNonce(pre)}`);
  const bs = await grantAndMove(`G-${w.name}28. combined call with a bad grant signature: the move is refused`, false, pk, w, tokenTransfer(VENUE, 1n), { badSig: true });
  record(`G-${w.name}29. and nothing was stored for that key`, true, (await sessionUntil(pk, bs.key.address)) === 0n && (await sessionNonce(bs)) === 0n, `until ${await sessionUntil(pk, bs.key.address)}`);
}

// ── X. Cross-wallet ────────────────────────────────────────────────────────────────────────────
{
  await grant('X1. PrimeSession(Freighter) with a grant signed by Phantom (NEAR)', false, st.pkFR, PH_S);
  await grant('X2. PrimeSession(MetaMask) with a grant signed by Freighter (NEAR)', false, st.pkMM, FR_S);
  await grant('X3. PrimeSession(Phantom) with a grant signed by MetaMask', false, st.pkPH, MM);
  await grant("X4. PrimeSession(Freighter) with Freighter's MPC key under another path", false, st.pkFR, FR_OTHER_PATH);
  await grant("X4b. PrimeSession(Freighter) with a grant signed by Freighter's seat key (prime:evm)", false, st.pkFR, FR);
  if (!NATIVE) await grant("X4c. PrimeSession(Phantom) with a grant signed by Phantom's seat key (prime:evm)", false, st.pkPH, PH);
  await grant('X5. grant text made for PrimeSession(Freighter) presented to PrimeSession(Phantom), signed by Phantom', false, st.pkPH, PH_S, { textFor: st.pkFR });
  await grant('X6. raw-hash signature instead of personal_sign (Freighter)', false, st.pkFR, { ...FR_S, personalSign: async (t) => FR_S.signHash(keccak256(toHex(t))) });
  const s = await grant('X7. Freighter session', true, st.pkFR, FR_S);
  await move('X8. that session key used through PrimeSession(Phantom)', false, { ...s, pk: st.pkPH }, tokenTransfer(VENUE, 1n));
  await send('X9. a stranger calls Roles directly', false, st.roles, encodeFunctionData({ abi: parseAbi(['function execTransactionWithRole(address,uint256,bytes,uint8,bytes32,bool) returns (bool)']), functionName: 'execTransactionWithRole', args: [st.token, 0n, tokenTransfer(VENUE, 1n).data, 0, st.roleKey, true] }));
  await move('X10. a move over the daily cap (60 more)', false, s, tokenTransfer(VENUE, 60n));
  // revoke is grant(key, 0, sig): only the owner's end-0 signature counts
  await send("X12. Phantom's end-0 (revoke) signature on PrimeSession(Freighter) for Freighter's live session", false, st.pkFR, encodeFunctionData({ abi: PK.abi, functionName: 'grant', args: [s.key.address, 0n, await PH_S.personalSign(await grantText(st.pkFR, s.key.address, 0n))] }));
  const pre = privateKeyToAccount(generatePrivateKey());
  const preSig = await FR_S.personalSign(await grantText(st.pkFR, pre.address, 0n));
  await send('X13. Freighter revokes a key it never granted (pre-emptive)', true, st.pkFR, encodeFunctionData({ abi: PK.abi, functionName: 'grant', args: [pre.address, 0n, preSig] }));
  await grant('X14. that key can never be granted afterwards', false, st.pkFR, FR_S, { key: pre });
  await send('X15. the same revoke replayed (harmless, key stays revoked)', true, st.pkFR, encodeFunctionData({ abi: PK.abi, functionName: 'grant', args: [pre.address, 0n, preSig] }));
  await move('X16. Freighter session still works after X12', true, s, tokenTransfer(VENUE, 1n));
  if (LIVE) { // real chain: no time travel, so use a 20-second session and wait it out
    const short = await grant('X11a. Freighter 20-second session', true, st.pkFR, FR_S, { seconds: 20n });
    while ((await now()) <= short.end) await new Promise((r) => setTimeout(r, 2000));
    await move('X11. after the session ends', false, short, tokenTransfer(VENUE, 1n));
  } else { await rpc('evm_increaseTime', [3601]); await rpc('evm_mine', []); await move('X11. after the session ends', false, s, tokenTransfer(VENUE, 1n)); }
}
console.log('gas:', Object.entries(gasOf).map(([k, v]) => `${k} ${v}`).join(', '));
console.log(`NEAR MPC signatures: ${stats.calls}, average ${(stats.ms / Math.max(1, stats.calls) / 1000).toFixed(1)}s`);
if (NATIVE) console.log(`Phantom own-account signatures (${PH_BRIDGE ? 'real extension' : 'local stand-in'}): ${nat.calls}, average ${(nat.ms / Math.max(1, nat.calls) / 1000).toFixed(2)}s`);
st.gas = gasOf; st.mpc = stats; st.phantomNative = NATIVE ? { ...nat, real: !!PH_BRIDGE, address: PH.addr } : undefined; save();
console.log(`${results.filter((r) => r.pass).length}/${results.length} passed`);
for (const r of results.filter((r) => !r.pass)) console.log('FAIL', r.name, r.detail);
process.exit(0);
