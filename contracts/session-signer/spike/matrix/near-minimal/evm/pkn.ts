// EVM matrix, NEAR-routed: a Prime Account (Safe 1.4.1 + Zodiac Roles v2.1.1, PrimeX onboarding/policy code) on an
// anvil fork of Base Sepolia, or on real Base Sepolia with PKN_LIVE=1.
//   seats (Safe owners, 2-of-3): MetaMask (its own EOA), Freighter and Phantom (their NEAR MPC secp256k1 addresses,
//         reached through the prime-near-signer NEAR contract: SEP-53 for Freighter, plain text for Phantom)
//   sessions: one PrimeKey per wallet is its Roles member (never a Safe owner); the owner signs one personal_sign
//         grant (MetaMask itself; MPC signs the EIP-191 digest for Freighter / Phantom), then the session key signs
//         each move, submitted by the relayer or, when the relayer is down, by the session key paying its own gas.
import { createPublicClient, createWalletClient, http, encodeFunctionData, parseAbi, getAddress, concat, pad, numberToHex, keccak256, toHex, hashMessage, encodeAbiParameters, parseEther, nonceManager, type Address, type Hex } from 'viem';
import { publicActionsL2 } from 'viem/op-stack';
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts';
import { baseSepolia } from 'viem/chains';
import { readFileSync, writeFileSync } from 'node:fs';
const { metamask, secpAddr, secpSign, stats } = await import('/home/ubuntu/work/near-session-spike/nearsig.ts');
const OCT = '/home/ubuntu/git/github.com/untangledfinance/octopos/apps/evm-web/src/core';
const ob = await import(`${OCT}/onboarding.ts`);
const pol = await import(`${OCT}/evm-policy.ts`);
const { CONTRACTS } = await import(`${OCT}/contracts.ts`);

// PKN_LIVE=1 runs on real Base Sepolia (relayer key from PKN_KEY); otherwise on the local anvil fork.
const LIVE = !!process.env.PKN_LIVE;
const RPC = LIVE ? 'https://sepolia.base.org' : 'http://127.0.0.1:8547';
const pub = createPublicClient({ chain: baseSepolia, transport: http(RPC), pollingInterval: 1000 }).extend(publicActionsL2());
const relayerAcct = LIVE ? privateKeyToAccount(process.env.PKN_KEY as Hex, { nonceManager }) : privateKeyToAccount('0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'); // anvil dev #0 (public)
const wallet = (a: ReturnType<typeof privateKeyToAccount>) => createWalletClient({ chain: baseSepolia, transport: http(RPC), account: a });
const relayer = wallet(relayerAcct);
const rpc = (method: string, params: unknown[]) => fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) }).then((r) => r.json());
const st: any = {}; const results: any[] = [];
const save = () => writeFileSync(LIVE ? 'state-pkn-live.json' : 'state-pkn.json', JSON.stringify({ ...st, results }, (_, v) => (typeof v === 'bigint' ? v.toString() : v), 1));
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
async function deploy(a: any, args: any[] = []) { const h = await relayer.deployContract({ abi: a.abi, bytecode: a.bytecode.object, args }); const r = await pub.waitForTransactionReceipt({ hash: h }); await settle(r.blockNumber); return getAddress(r.contractAddress!); }
const art = (dir: string, n: string) => JSON.parse(readFileSync(`${dir}/out/${n}.sol/${n}.json`, 'utf8'));
const PK = art('/home/ubuntu/work/prime-evm', 'PrimeKey'), TK = art('/home/ubuntu/work/evm-matrix', 'Token');
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
const FR = await viaNear('Freighter'), PH = await viaNear('Phantom');
const FR_OTHER_PATH = await viaNear('Freighter', 'prime:evm-other');
console.log('seats:', MM.addr, FR.addr, PH.addr);

// ── Safe transactions (seats) ──────────────────────────────────────────────────────────────────
type Part = { owner: Address; sig: Hex; dynamic?: Hex };
async function safeTx(name: string, expectOk: boolean, call: { to: Address; value: bigint; data: Hex; operation: 0 | 1 }, parts: (h: Hex) => Promise<Part[]>) {
  const nonce = await pub.readContract({ address: st.safe, abi: safeAbi, functionName: 'nonce' });
  const tx = { ...call, safeTxGas: 0n, baseGas: 0n, gasPrice: 0n, gasToken: '0x0000000000000000000000000000000000000000' as Address, refundReceiver: '0x0000000000000000000000000000000000000000' as Address, nonce };
  const hash = ob.hashSafeTransaction(84532, st.safe, tx);
  const ps = (await parts(hash)).sort((a, b) => (BigInt(a.owner) < BigInt(b.owner) ? -1 : 1));
  const tail: Hex[] = []; let off = 65 * ps.length;
  const statics = ps.map((p) => { if (!p.dynamic) return p.sig; const len = (p.dynamic.length - 2) / 2; tail.push(concat([pad(numberToHex(len), { size: 32 }), p.dynamic]));
    const s = concat([pad(p.owner, { size: 32 }), pad(numberToHex(off), { size: 32 }), '0x00']); off += 32 + len; return s; });
  return send(name, expectOk, st.safe, ob.encodeExecTransaction(tx, concat([...statics, ...tail])));
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
async function move(name: string, expectOk: boolean, s: Session, call: { to: Address; value: bigint; data: Hex; operation: 0 | 1 }, o: { signer?: ReturnType<typeof privateKeyToAccount>; replay?: Hex; selfPay?: boolean; fund?: boolean; tag?: string } = {}) {
  const n = await pub.readContract({ address: s.pk, abi: PK.abi, functionName: 'nonce', args: [s.key.address] }) as bigint;
  const h = keccak256(encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'address' }, { type: 'uint256' }, { type: 'bytes32' }, { type: 'uint8' }, { type: 'bytes32' }],
    [s.pk, 84532n, n, call.to, call.value, keccak256(call.data), call.operation, st.roleKey]));
  const sig = o.replay ?? await (o.signer ?? s.key).sign({ hash: h });
  const data = encodeFunctionData({ abi: PK.abi, functionName: 'exec', args: [call.to, call.value, call.data, call.operation, st.roleKey, s.key.address, sig] });
  if (o.selfPay) { if (o.fund === false) st.drained = String(await drain(s.key)); else await fund(s.key.address, s.pk, data); }
  await send(name, expectOk, s.pk, data, { from: o.selfPay ? s.key : undefined, tag: o.tag });
  return sig;
}

// ── C. Setup ───────────────────────────────────────────────────────────────────────────────────
{ // a zero owner can never match: OpenZeppelin's tryRecover never reports success for the zero address
  const z = await deploy(PK, ['0x0000000000000000000000000000000000000000', fresh()]);
  await send('C0. a zero-owner PrimeKey accepts no grant (garbage signature)', false, z, encodeFunctionData({ abi: PK.abi, functionName: 'grant', args: [fresh(), (await now()) + 3600n, ('0x' + '00'.repeat(65)) as Hex] }));
}
st.token = await deploy(TK);
const proxyCreationCode = await pub.readContract({ address: CONTRACTS.safeProxyFactory, abi: parseAbi(['function proxyCreationCode() view returns (bytes)']), functionName: 'proxyCreationCode' }) as Hex;
const initializer = ob.encodeSafeInitializer([MM.addr], 1n, CONTRACTS.compatibilityFallbackHandler);
const salt = BigInt(keccak256(toHex(`pkn-${Date.now()}`)));
st.safe = ob.predictSafeAddress(proxyCreationCode, initializer, salt); st.roles = ob.predictPrimeRolesAddress(st.safe);
st.pkMM = await deploy(PK, [MM.addr, st.roles]); st.pkFR = await deploy(PK, [FR.addr, st.roles]); st.pkPH = await deploy(PK, [PH.addr, st.roles]);
const doc = { spendingLimit: 1 as const, token: st.token, recipients: [VENUE], amount: (100n * E18).toString(), period: '86400' };
const rule = pol.buildRuleInstall({ doc, docText: JSON.stringify(doc), name: 'movers', ctx: { prime: st.safe, primeRoles: st.roles }, proxyCreationCode, wallets: [st.pkMM, st.pkFR, st.pkPH], threshold: 1 });
st.roleKey = rule.roleKey; save();
const c = ob.encodeCreateSafe(initializer, salt);
await send('C1. create Safe (MetaMask first, PrimeX flow)', true, c.to, c.data);
const init = ob.buildSafeInitializationTransaction(st.safe, [FR.addr, PH.addr], 2n, rule.calls);
await send('C2. seats MetaMask + Freighter(NEAR MPC) + Phantom(NEAR MPC), threshold 2; movers rule for the three PrimeKeys', true, st.safe,
  ob.encodeExecTransaction(init, await MM.signHash(ob.hashSafeTransaction(84532, st.safe, init))));
const owners = (await pub.readContract({ address: st.safe, abi: safeAbi, functionName: 'getOwners' }) as Address[]).map((a) => a.toLowerCase());
const lc = (a: string) => a.toLowerCase();
const thr = await pub.readContract({ address: st.safe, abi: safeAbi, functionName: 'getThreshold' });
record('C3. owners are exactly the three wallet keys (no PrimeKey), threshold 2', true,
  owners.length === 3 && [MM.addr, FR.addr, PH.addr].every((a) => owners.includes(lc(a))) && ![st.pkMM, st.pkFR, st.pkPH].some((a) => owners.includes(lc(a))) && thr === 2n, `${owners.join(',')} / ${thr}`);
await send('C4. mint 1000 tokens to the Safe', true, st.token, encodeFunctionData({ abi: tokenAbi, functionName: 'mint', args: [st.safe, 1000n * E18] }));

// ── S. Seats ───────────────────────────────────────────────────────────────────────────────────
{
  const t = tokenTransfer(DEST, 1n);
  for (const w of [MM, FR, PH]) await safeTx(`S1-${w.name}. ${w.name} alone`, false, t, by(w));
  const b = await bal(DEST);
  await safeTx('S2. MetaMask + Freighter', true, t, by(MM, FR));
  await safeTx('S3. Freighter + Phantom (no MetaMask)', true, t, by(FR, PH));
  await safeTx('S4. Phantom + MetaMask', true, t, by(PH, MM));
  record('S5. DEST received exactly 3', true, (await bal(DEST)) - b === 3n * E18, `${((await bal(DEST)) - b) / E18}`);
  const outsider = privateKeyToAccount(generatePrivateKey());
  await safeTx('S6. outsider + MetaMask', false, t, async (h) => [{ owner: MM.addr, sig: await MM.signHash(h) }, { owner: outsider.address, sig: await outsider.sign({ hash: h }) }]);
  // An ECDSA owner is recovered from its signature, so "Phantom's signature filed as Freighter's" is just Phantom voting.
  // The real check: one wallet cannot count twice.
  await safeTx('S7. the same wallet (Phantom) signs twice, as both votes', false, t, async (h) => { const s = await PH.signHash(h); return [{ owner: PH.addr, sig: s }, { owner: PH.addr, sig: s }]; });
  await safeTx("S8. Freighter's MPC key under another path + MetaMask", false, t, async (h) => [{ owner: MM.addr, sig: await MM.signHash(h) }, { owner: FR.addr, sig: await FR_OTHER_PATH.signHash(h) }]);
  await safeTx('S9. Phantom approval of another Safe tx + MetaMask', false, t, async (h) => [{ owner: MM.addr, sig: await MM.signHash(h) }, { owner: PH.addr, sig: await PH.signHash(keccak256(h)) }]);
}

// ── N. A session can never vote as a seat ──────────────────────────────────────────────────────
{
  const t = tokenTransfer(DEST, 1n);
  const s = await grant('N0. Phantom grants a session (used below)', true, st.pkPH, PH);
  await safeTx("N1. the session key's signature as a Safe owner + MetaMask", false, t, async (h) => [{ owner: MM.addr, sig: await MM.signHash(h) }, { owner: s.key.address, sig: await s.key.sign({ hash: h }) }]);
  await safeTx('N2. PrimeKey(Phantom) as a contract signature + MetaMask', false, t, async (h) => [{ owner: MM.addr, sig: await MM.signHash(h) }, { owner: st.pkPH, sig: '0x' as Hex, dynamic: await s.key.sign({ hash: h }) }]);
  await move('N3. session asks Roles to add the session key as a Safe owner', false, s, { to: st.safe, value: 0n, operation: 0, data: encodeFunctionData({ abi: safeAbi, functionName: 'addOwnerWithThreshold', args: [s.key.address, 1n] }) });
  await move('N4. session asks Roles for a delegatecall', false, s, { ...tokenTransfer(VENUE, 1n), operation: 1 });
  await move('N5. session asks Roles to call the Roles modifier itself (re-assign roles)', false, s, { to: st.roles, value: 0n, operation: 0, data: encodeFunctionData({ abi: parseAbi(['function assignRoles(address,bytes32[],bool[])']), functionName: 'assignRoles', args: [s.key.address, [st.roleKey], [true]] }) });
}

// ── G. Sessions, every wallet ──────────────────────────────────────────────────────────────────
for (const [w, pk] of [[MM, st.pkMM], [FR, st.pkFR], [PH, st.pkPH]] as [W, Address][]) {
  const s = await grant(`G-${w.name}1. ${w.name} grants a 1-hour session (one signature${w === MM ? '' : ' through NEAR'}), relayer submits`, true, pk, w);
  const b = await bal(VENUE);
  await move(`G-${w.name}2. move via relayer: 10 to VENUE`, true, s, tokenTransfer(VENUE, 10n), { tag: `moveRelayer${w.name}` });
  await move(`G-${w.name}3. relayer down: session key submits and pays gas itself, 5 to VENUE`, true, s, tokenTransfer(VENUE, 5n), { selfPay: true, tag: `moveSelf${w.name}` });
  await move(`G-${w.name}4. relayer down and the session key has no ETH`, false, s, tokenTransfer(VENUE, 1n), { selfPay: true, fund: false });
  record(`G-${w.name}5. VENUE received exactly 15`, true, (await bal(VENUE)) - b === 15n * E18, `${((await bal(VENUE)) - b) / E18}`);
  const sig = await move(`G-${w.name}6. move 3: 1 to VENUE`, true, s, tokenTransfer(VENUE, 1n));
  await move(`G-${w.name}7. move 3 replayed`, false, s, tokenTransfer(VENUE, 1n), { replay: sig });
  await move(`G-${w.name}8. 1 to another address (Roles rule)`, false, s, tokenTransfer(OTHER, 1n));
  await move(`G-${w.name}9. move signed by another key`, false, s, tokenTransfer(VENUE, 1n), { signer: privateKeyToAccount(generatePrivateKey()) });
  await grant(`G-${w.name}10. grant for 7 days + 1 hour`, false, pk, w, { seconds: 7n * 86400n + 3600n });
  await grant(`G-${w.name}11. grant submitted with a later end than signed`, false, pk, w, { end: s.end + 3600n, signedEnd: s.end });
  await grant(`G-${w.name}12. old grant replayed with an earlier end`, false, pk, w, { key: s.key, end: s.end - 60n });
  await grant(`G-${w.name}13. grant for the zero key`, false, pk, w, { key: { address: '0x0000000000000000000000000000000000000000' } as any });
  const r = await grant(`G-${w.name}14. second session, granted with the session key paying gas itself`, true, pk, w, { selfPay: true });
  await send(`G-${w.name}15. ${w.name} revokes it: grant with end 0 (one signature)`, true, pk, encodeFunctionData({ abi: PK.abi, functionName: 'grant', args: [r.key.address, 0n, await w.personalSign(await grantText(pk, r.key.address, 0n))] }));
  await move(`G-${w.name}16. the revoked session`, false, r, tokenTransfer(VENUE, 1n));
  await grant(`G-${w.name}17. re-grant the revoked key`, false, pk, w, { key: r.key });
  await move(`G-${w.name}18. first session still works`, true, s, tokenTransfer(VENUE, 1n));
}

// ── X. Cross-wallet ────────────────────────────────────────────────────────────────────────────
{
  await grant('X1. PrimeKey(Freighter) with a grant signed by Phantom (NEAR)', false, st.pkFR, PH);
  await grant('X2. PrimeKey(MetaMask) with a grant signed by Freighter (NEAR)', false, st.pkMM, FR);
  await grant('X3. PrimeKey(Phantom) with a grant signed by MetaMask', false, st.pkPH, MM);
  await grant("X4. PrimeKey(Freighter) with Freighter's MPC key under another path", false, st.pkFR, FR_OTHER_PATH);
  await grant('X5. grant text made for PrimeKey(Freighter) presented to PrimeKey(Phantom), signed by Phantom', false, st.pkPH, PH, { textFor: st.pkFR });
  await grant('X6. raw-hash signature instead of personal_sign (Freighter)', false, st.pkFR, { ...FR, personalSign: async (t) => FR.signHash(keccak256(toHex(t))) });
  const s = await grant('X7. Freighter session', true, st.pkFR, FR);
  await move('X8. that session key used through PrimeKey(Phantom)', false, { ...s, pk: st.pkPH }, tokenTransfer(VENUE, 1n));
  await send('X9. a stranger calls Roles directly', false, st.roles, encodeFunctionData({ abi: parseAbi(['function execTransactionWithRole(address,uint256,bytes,uint8,bytes32,bool) returns (bool)']), functionName: 'execTransactionWithRole', args: [st.token, 0n, tokenTransfer(VENUE, 1n).data, 0, st.roleKey, true] }));
  await move('X10. a move over the daily cap (60 more)', false, s, tokenTransfer(VENUE, 60n));
  // revoke is grant(key, 0, sig): only the owner's end-0 signature counts
  await send("X12. Phantom's end-0 (revoke) signature on PrimeKey(Freighter) for Freighter's live session", false, st.pkFR, encodeFunctionData({ abi: PK.abi, functionName: 'grant', args: [s.key.address, 0n, await PH.personalSign(await grantText(st.pkFR, s.key.address, 0n))] }));
  const pre = privateKeyToAccount(generatePrivateKey());
  const preSig = await FR.personalSign(await grantText(st.pkFR, pre.address, 0n));
  await send('X13. Freighter revokes a key it never granted (pre-emptive)', true, st.pkFR, encodeFunctionData({ abi: PK.abi, functionName: 'grant', args: [pre.address, 0n, preSig] }));
  await grant('X14. that key can never be granted afterwards', false, st.pkFR, FR, { key: pre });
  await send('X15. the same revoke replayed (harmless, key stays revoked)', true, st.pkFR, encodeFunctionData({ abi: PK.abi, functionName: 'grant', args: [pre.address, 0n, preSig] }));
  await move('X16. Freighter session still works after X12', true, s, tokenTransfer(VENUE, 1n));
  if (LIVE) { // real chain: no time travel, so use a 20-second session and wait it out
    const short = await grant('X11a. Freighter 20-second session', true, st.pkFR, FR, { seconds: 20n });
    while ((await now()) <= short.end) await new Promise((r) => setTimeout(r, 2000));
    await move('X11. after the session ends', false, short, tokenTransfer(VENUE, 1n));
  } else { await rpc('evm_increaseTime', [3601]); await rpc('evm_mine', []); await move('X11. after the session ends', false, s, tokenTransfer(VENUE, 1n)); }
}
console.log('gas:', Object.entries(gasOf).map(([k, v]) => `${k} ${v}`).join(', '));
console.log(`NEAR MPC signatures: ${stats.calls}, average ${(stats.ms / Math.max(1, stats.calls) / 1000).toFixed(1)}s`);
st.gas = gasOf; st.mpc = stats; save();
console.log(`${results.filter((r) => r.pass).length}/${results.length} passed`);
for (const r of results.filter((r) => !r.pass)) console.log('FAIL', r.name, r.detail);
process.exit(0);
