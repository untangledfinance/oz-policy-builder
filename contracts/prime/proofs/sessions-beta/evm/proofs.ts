// EVM session proofs E1 to E7 on an anvil fork of Base Sepolia (port 8548). Local keys only; nothing is sent to Base Sepolia.
//   anvil --fork-url https://sepolia.base.org --port 8548 &   then   bun proofs.ts
import { createPublicClient, createWalletClient, http, encodeFunctionData, parseAbi, getAddress, keccak256, toHex, concat, encodeAbiParameters, parseEther, formatEther, type Address, type Hex } from 'viem';
import { publicActionsL2 } from 'viem/op-stack';
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts';
import { baseSepolia } from 'viem/chains';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

const WT = '/home/ubuntu/work/octopos-wt/sess-proofs/apps/evm-web/src/core';
const ob = await import(`${WT}/onboarding.ts`);
const pol = await import(`${WT}/evm-policy-install.ts`);
const art = await import(`${WT}/prime-session-artifact.ts`);
const { CONTRACTS } = await import(`${WT}/contracts.ts`);

const RPC = process.env.EVM_FORK_RPC ?? 'http://127.0.0.1:8548';
const LIVE_RPC = 'https://sepolia.base.org';
const pub = createPublicClient({ chain: baseSepolia, transport: http(RPC), pollingInterval: 200 }).extend(publicActionsL2());
const livePub = createPublicClient({ chain: baseSepolia, transport: http(LIVE_RPC) }).extend(publicActionsL2());
const wallet = (a: ReturnType<typeof privateKeyToAccount>) => createWalletClient({ chain: baseSepolia, transport: http(RPC), account: a });
const rpc = (method: string, params: unknown[]) => fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) }).then((r) => r.json());
const CHAIN = 84532n;
const E18 = 10n ** 18n;
const MULTICALL3: Address = '0xcA11bde05977b3631167028862bE2a173976CA11';
const DEPLOYER: Address = art.CREATE2_DEPLOYER;

const RES = 'results.json';
const res: Record<string, any> = existsSync(RES) ? JSON.parse(readFileSync(RES, 'utf8')) : {};
const rec = (id: string, v: Record<string, unknown>) => { res[id] = v; writeFileSync(RES, JSON.stringify(res, (_, x) => (typeof x === 'bigint' ? x.toString() : x), 1)); };
const gas: Record<string, string> = {};
const ok = (id: string, pass: boolean, detail: string) => console.log(pass ? 'PASS' : 'FAIL', id, detail);

const ROLES_ERR: Record<number, string> = { 2: "TargetAddressNotAllowed", 3: "FunctionNotAllowed", 7: "ParameterNotAllowed", 8: "ParameterLessThanAllowed", 9: "ParameterGreaterThanAllowed", 17: "AllowanceExceeded" };
const reason = (e: any) => {
  const raw: string | undefined = e?.walk?.((x: any) => typeof x?.data === 'string' && x.data.startsWith('0x') && x.data.length >= 10)?.data;
  if (raw?.startsWith('0xd0a9bf58')) return `Roles ConditionViolation(${ROLES_ERR[parseInt(raw.slice(10, 74), 16)] ?? parseInt(raw.slice(10, 74), 16)})`;
  if (raw?.startsWith('0x4a0bfec1')) return `Roles NotAuthorized(0x${raw.slice(-40)})`;
  if (raw?.startsWith('0xfd8e9f28')) return 'Roles NoMembership';
  const s = String(e?.shortMessage ?? e?.message ?? e).replace(/\s+/g, ' ');
  return s.match(/(reverted with reason: [^.]*|GS\d{3}|reverted with the following reason:[^.]*|insufficient funds[^.]*|custom error 0x[0-9a-f]{8})/i)?.[0] ?? s.slice(0, 200);
};

const readJson = (p: string) => JSON.parse(readFileSync(p, 'utf8'));
const TK = readJson('/home/ubuntu/work/evm-matrix/out/Token.sol/Token.json');
const PSABI = parseAbi([
  'function owner() view returns (address)', 'function roles() view returns (address)',
  'function sessions(address) view returns (uint128 until, uint128 nonce)',
  'function grant(address key, uint256 end, bytes sig)',
  'function exec(address to, uint256 value, bytes data, uint8 op, bytes32 role, address key, bytes sig)',
  'function grantText(address key, uint256 end) view returns (string)',
]);
const tokenAbi = parseAbi(['function mint(address,uint256)', 'function transfer(address,uint256) returns (bool)', 'function balanceOf(address) view returns (uint256)']);
const safeAbi = parseAbi(['function nonce() view returns (uint256)', 'function getOwners() view returns (address[])', 'function getThreshold() view returns (uint256)', 'function isModuleEnabled(address) view returns (bool)']);
const mcAbi = parseAbi([
  'struct Call3Value { address target; bool allowFailure; uint256 value; bytes callData; }',
  'struct Result { bool success; bytes returnData; }',
  'function aggregate3Value(Call3Value[] calls) payable returns (Result[] returnData)',
]);

const fresh = () => privateKeyToAccount(generatePrivateKey());
const secrets = (n: string) => `secrets/${n}.json`;
function keyFile(n: string) { // fork-only local keys, kept in mode 600 files and never printed
  const f = secrets(n);
  if (!existsSync(f)) writeFileSync(f, JSON.stringify({ pk: generatePrivateKey() }), { mode: 0o600 });
  return privateKeyToAccount(readJson(f).pk);
}
const dev0 = privateKeyToAccount('0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'); // anvil dev #0, public, fork only
const ownerA = fresh(), ownerB = fresh(), stranger = fresh(), dest = fresh().address, other = fresh().address;
void keyFile; // owners are regenerated per run: the account is made on the fork in this run
const setBalance = (a: Address, wei: bigint) => rpc('anvil_setBalance', [a, toHex(wei)]);
const now = async () => (await pub.getBlock()).timestamp;

async function send(from: ReturnType<typeof privateKeyToAccount>, to: Address, data: Hex, value = 0n, tag?: string) {
  const g = (await pub.estimateGas({ account: from.address, to, data, value })) * 12n / 10n;
  const base = (await pub.getBlock()).baseFeePerGas!;
  const h = await wallet(from).sendTransaction({ to, data, value, gas: g, maxFeePerGas: base * 3n, maxPriorityFeePerGas: 1n });
  const r = await pub.waitForTransactionReceipt({ hash: h });
  if (tag) gas[tag] = String(r.gasUsed);
  return { hash: h, receipt: r, ok: r.status === 'success' };
}
async function estimate(from: Address, to: Address, data: Hex, value = 0n): Promise<{ ok: boolean; reason: string }> {
  try { await pub.estimateGas({ account: from, to, data, value }); return { ok: true, reason: '' }; } catch (e) { return { ok: false, reason: reason(e) }; }
}

// ── Setup: token, Safe 2-of-2 with a Roles module, three PrimeSession addresses, Session moves rule ─────────
for (const a of [dev0.address, ownerA.address, ownerB.address, stranger.address]) await setBalance(a, parseEther('10'));
const tokenHash = await wallet(dev0).deployContract({ abi: TK.abi, bytecode: TK.bytecode.object, args: [] });
const token = getAddress((await pub.waitForTransactionReceipt({ hash: tokenHash })).contractAddress!);
const proxyCreationCode = await pub.readContract({ address: CONTRACTS.safeProxyFactory, abi: parseAbi(['function proxyCreationCode() view returns (bytes)']), functionName: 'proxyCreationCode' }) as Hex;
const initializer = ob.encodeSafeInitializer([ownerA.address], 1n, CONTRACTS.compatibilityFallbackHandler);
const saltNonce = BigInt(keccak256(toHex(`sessions-proofs-${Date.now()}`)));
const safe: Address = ob.predictSafeAddress(proxyCreationCode, initializer, saltNonce);
const roles: Address = ob.predictPrimeRolesAddress(safe);
const PS = (o: Address): Address => art.predictPrimeSessionAddress(safe, o, roles);
const PS_a = PS(ownerA.address), PS_b = PS(ownerB.address), PS_x = PS(stranger.address);
const MAX = 5n * E18;
const doc = { callPolicy: 1 as const, calls: [{ to: token, fn: 'transfer(address,uint256)', args: [{ eq: dest }, { gte: '1', lte: MAX.toString() }] }] };
const rule = pol.buildRuleInstall({ doc, docText: JSON.stringify(doc), name: 'session_moves', ctx: { prime: safe, primeRoles: roles }, proxyCreationCode, wallets: [PS_a, PS_b], threshold: 1 });
const roleKey: Hex = rule.roleKey;

type Tx = { to: Address; value: bigint; data: Hex; operation: 0 | 1; safeTxGas: bigint; baseGas: bigint; gasPrice: bigint; gasToken: Address; refundReceiver: Address; nonce: bigint };
const signSafe = async (tx: Tx, signers: ReturnType<typeof privateKeyToAccount>[]) => {
  const h = ob.hashSafeTransaction(84532, safe, tx) as Hex;
  const parts = await Promise.all(signers.map(async (s) => ({ a: s.address, sig: await s.sign({ hash: h }) })));
  parts.sort((x, y) => (BigInt(x.a) < BigInt(y.a) ? -1 : 1));
  return concat(parts.map((p) => p.sig));
};
const create = ob.encodeCreateSafe(initializer, saltNonce);
const c1 = await send(ownerA, create.to, create.data);
const init: Tx = ob.buildSafeInitializationTransaction(safe, [ownerB.address], 2n, rule.calls);
const c2 = await send(ownerA, safe, ob.encodeExecTransaction(init, await signSafe(init, [ownerA])), 0n, 'safeSetup');
const owners = (await pub.readContract({ address: safe, abi: safeAbi, functionName: 'getOwners' }) as Address[]).map((a) => a.toLowerCase());
const threshold = await pub.readContract({ address: safe, abi: safeAbi, functionName: 'getThreshold' });
const moduleOn = await pub.readContract({ address: safe, abi: safeAbi, functionName: 'isModuleEnabled', args: [roles] });
const setupPass = c1.ok && c2.ok && owners.length === 2 && owners.includes(ownerA.address.toLowerCase()) && owners.includes(ownerB.address.toLowerCase()) && threshold === 2n && moduleOn === true
  && ![PS_a, PS_b].some((a) => owners.includes(a.toLowerCase()));
ok('setup', setupPass, `Safe ${safe} 2-of-2, Roles ${roles}, PrimeSessions are not Safe owners`);
await send(dev0, token, encodeFunctionData({ abi: tokenAbi, functionName: 'mint', args: [safe, 1000n * E18] }));
const bal = (a: Address) => pub.readContract({ address: token, abi: tokenAbi, functionName: 'balanceOf', args: [a] }) as Promise<bigint>;

// ── Text, hashes, calls ─────────────────────────────────────────────────────────────────────────
const lc = (a: string) => a.toLowerCase();
const localGrantText = (ps: Address, key: Address, end: bigint) => `Prime session\ncontract: ${lc(ps)}\nsession key: ${lc(key)}\nvalid until (unix time): ${end}\nnetwork: ${CHAIN}`;
const moveCall = (to: Address, n: bigint) => ({ to: token, value: 0n, op: 0 as const, data: encodeFunctionData({ abi: tokenAbi, functionName: 'transfer', args: [to, n] }) });
const moveHash = (ps: Address, nonce: bigint, c: ReturnType<typeof moveCall>) => keccak256(encodeAbiParameters(
  [{ type: 'address' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'address' }, { type: 'uint256' }, { type: 'bytes32' }, { type: 'uint8' }, { type: 'bytes32' }],
  [ps, CHAIN, nonce, c.to, c.value, keccak256(c.data), c.op, roleKey]));
const sessionOf = async (ps: Address, key: Address) => (await pub.readContract({ address: ps, abi: PSABI, functionName: 'sessions', args: [key] })) as readonly [bigint, bigint];
async function execData(ps: Address, key: ReturnType<typeof privateKeyToAccount>, c: ReturnType<typeof moveCall>, nonceOverride?: bigint) {
  const n = nonceOverride ?? (await sessionOf(ps, key.address))[1];
  const sig = await key.sign({ hash: moveHash(ps, n, c) });
  return encodeFunctionData({ abi: PSABI, functionName: 'exec', args: [c.to, c.value, c.data, c.op, roleKey, key.address, sig] });
}
const grantSig = (owner: ReturnType<typeof privateKeyToAccount>, ps: Address, key: Address, end: bigint) => owner.signMessage({ message: localGrantText(ps, key, end) });

// ── Fee read for the float formula ─────────────────────────────────────────────────────────────
const gp = (await pub.getBlock()).baseFeePerGas!;
const liveGp = (await livePub.getBlock()).baseFeePerGas!;
const l1Of = async (to: Address, data: Hex, from: Address) => { try { return await livePub.estimateL1Fee({ account: from, to, data, chain: baseSepolia }); } catch { return 0n; } };
const MOVE_GAS = 160_000n, REVOKE_GAS = 100_000n; // generous bounds above the measured gas, replaced by measured values below
const sampleMove = await execData(PS_a, ownerA, moveCall(dest, 1n), 0n);
const l1Move = await l1Of(PS_a, sampleMove, ownerA.address);
const l1Revoke = await l1Of(MULTICALL3, encodeFunctionData({ abi: mcAbi, functionName: 'aggregate3Value', args: [[{ target: PS_a, allowFailure: true, value: 0n, callData: encodeFunctionData({ abi: PSABI, functionName: 'grant', args: [ownerA.address, 0n, `0x${'00'.repeat(65)}`] }) }, { target: ownerA.address, allowFailure: false, value: 1n, callData: '0x' }]] }), ownerA.address);
const floatWei = (moves: bigint) => moves * (MOVE_GAS * liveGp * 2n + l1Move * 2n) + (REVOKE_GAS * liveGp * 2n + l1Revoke * 2n);
const FLOAT = floatWei(50n);
console.log('fee read: fork gas price', gp, 'live gas price', liveGp, 'L1 fee move', l1Move, 'L1 fee revoke', l1Revoke, 'float for 50 moves + revoke at 2x:', formatEther(FLOAT), 'ETH');

// ── Start: one Multicall3 transaction: deploy when absent, grant, fund the key ───────────────────
async function start(owner: ReturnType<typeof privateKeyToAccount>, ps: Address, seconds: bigint, float: bigint, deploy: boolean) {
  const key = fresh();
  const end = (await now()) + seconds;
  const sig = await grantSig(owner, ps, key.address, end);
  const calls: { target: Address; allowFailure: boolean; value: bigint; callData: Hex }[] = [];
  if (deploy) calls.push({ target: DEPLOYER, allowFailure: true, value: 0n, callData: concat([art.primeSessionSalt(safe, owner.address), art.primeSessionInitCode(owner.address, roles)]) });
  calls.push({ target: ps, allowFailure: true, value: 0n, callData: encodeFunctionData({ abi: PSABI, functionName: 'grant', args: [key.address, end, sig] }) });
  calls.push({ target: key.address, allowFailure: false, value: float, callData: '0x' });
  const data = encodeFunctionData({ abi: mcAbi, functionName: 'aggregate3Value', args: [calls] });
  const t = await send(owner, MULTICALL3, data, float);
  const l1 = await l1Of(MULTICALL3, data, owner.address);
  return { key, end, sig, tx: t, l1Fee: l1, calldataBytes: (data.length - 2) / 2 };
}

// E1
const e1 = await start(ownerA, PS_a, 3600n, FLOAT, true);
const codeA = await pub.getCode({ address: PS_a });
const sA = await sessionOf(PS_a, e1.key.address);
const keyBal = await pub.getBalance({ address: e1.key.address });
const pOwner = await pub.readContract({ address: PS_a, abi: PSABI, functionName: 'owner' });
const pRoles = await pub.readContract({ address: PS_a, abi: PSABI, functionName: 'roles' });
const e1Pass = e1.tx.ok && !!codeA && codeA !== '0x' && sA[0] === e1.end && keyBal === FLOAT && lc(pOwner) === lc(ownerA.address) && lc(pRoles) === lc(roles);
rec('E1', { pass: e1Pass, tx: e1.tx.hash, gasUsed: String(e1.tx.receipt.gasUsed), predictedPrimeSession: PS_a, codeBytes: ((codeA?.length ?? 2) - 2) / 2, sessionsUntil: sA[0], end: e1.end, keyBalanceWei: keyBal, floatWei: FLOAT, l1FeeEstimateWei: e1.l1Fee, calldataBytes: e1.calldataBytes,
  vector: { chainId: 84532, safe, owner: ownerA.address, roles, primeSession: PS_a, salt: art.primeSessionSalt(safe, ownerA.address) }, ownerAndRolesRead: { owner: pOwner, roles: pRoles }, deployAndGrantAndFundInOneTransaction: true });
ok('E1', e1Pass, `${e1.tx.hash} gas ${e1.tx.receipt.gasUsed}`);

// E2: the live key moves, paying its own gas; a move through B's PrimeSession too (several members in one Roles rule).
const e1key = e1.key;
const destBefore = await bal(dest);
const move1 = await execData(PS_a, e1key, moveCall(dest, 3n * E18));
const m1 = await send(e1key, PS_a, move1, 0n, 'moveSelfPaid');
const sA2 = await sessionOf(PS_a, e1key.address);
const e2a = m1.ok && (await bal(dest)) - destBefore === 3n * E18 && sA2[1] === 1n;
const eB = await start(ownerB, PS_b, 3600n, FLOAT, true);
const mB = await send(eB.key, PS_b, await execData(PS_b, eB.key, moveCall(dest, 1n * E18)), 0n, 'moveSelfPaidB');
const e2b = eB.tx.ok && mB.ok && (await bal(dest)) - destBefore === 4n * E18;
const strangerStart = await start(stranger, PS_x, 3600n, parseEther('0.001'), true);
const strangerMoveData = await execData(PS_x, strangerStart.key, moveCall(dest, 1n * E18));
const strangerEst = await estimate(strangerStart.key.address, PS_x, strangerMoveData);
const e2c = !strangerEst.ok && /NotAuthorized|NoMembership/.test(strangerEst.reason);
rec('E2', { pass: e2a && e2b && e2c, moveTx: m1.hash, moveGasSelfPaid: String(m1.receipt.gasUsed), tokenReachedDestination: String((await bal(dest)) - destBefore), nonceAfter: sA2[1], viaOwnerB: { startTx: eB.tx.hash, moveTx: mB.hash, pass: e2b }, strangerNotInRule: { reason: strangerEst.reason, pass: e2c }, roleKey, members: rule.members, ruleCalls: rule.calls.length, installedInSafeSetupTx: c2.hash });
ok('E2', e2a && e2b && e2c, `move ${m1.hash} gas ${m1.receipt.gasUsed}; B ${mB.hash}; stranger: ${strangerEst.reason}`);

// E3: refusals by eth_estimateGas before sending (key is live, not yet expired)
const overBand = await estimate(e1key.address, PS_a, await execData(PS_a, e1key, moveCall(dest, MAX + 1n)));
const zeroAmt = await estimate(e1key.address, PS_a, await execData(PS_a, e1key, moveCall(dest, 0n)));
const otherDest = await estimate(e1key.address, PS_a, await execData(PS_a, e1key, moveCall(other, 1n * E18)));
const badSig = await estimate(e1key.address, PS_a, await execData(PS_a, fresh(), moveCall(dest, 1n * E18), 0n).then((d) => d)); // an ungranted key
const wrongNonce = await estimate(e1key.address, PS_a, await execData(PS_a, e1key, moveCall(dest, 1n * E18), 5n));
const cond = (r: { ok: boolean; reason: string }) => !r.ok && /ConditionViolation/.test(r.reason);
const e3Pass = cond(overBand) && cond(otherDest) && cond(zeroAmt) && !badSig.ok && /session/.test(badSig.reason) && !wrongNonce.ok && /session sig/.test(wrongNonce.reason);
const k8 = fresh().address, end8 = (await now()) + 8n * 86400n;
const eight = await estimate(ownerA.address, PS_a, encodeFunctionData({ abi: PSABI, functionName: 'grant', args: [k8, end8, await grantSig(ownerA, PS_a, k8, end8)] }));
rec('E3', { pass: e3Pass, overBand: overBand.reason, amountZero: zeroAmt.reason, otherDestination: otherDest.reason, ungrantedKey: badSig.reason, wrongNonce: wrongNonce.reason, eightDayGrantRefused: eight.reason });
ok('E3', e3Pass, `over band: ${overBand.reason}; other destination: ${otherDest.reason}; ungranted key: ${badSig.reason}`);

// E6 (before the revoke so the same owner starts again): second start for the same owner, no deploy in the transaction.
const e6 = await start(ownerA, PS_a, 3600n, FLOAT, false);
const sA6 = await sessionOf(PS_a, e6.key.address);
const e6b = await start(ownerA, PS_a, 3600n, FLOAT, true); // the same start with the deploy call kept: allowFailure absorbs the repeat
const e6Pass = e6.tx.ok && sA6[0] === e6.end && e6b.tx.ok && e6.tx.receipt.gasUsed < e1.tx.receipt.gasUsed;
rec('E6', { pass: e6Pass, tx: e6.tx.hash, gasUsedNoDeploy: String(e6.tx.receipt.gasUsed), gasUsedFirstStart: String(e1.tx.receipt.gasUsed), gasUsedWithDoomedDeployCall: String(e6b.tx.receipt.gasUsed), txWithDoomedDeployCall: e6b.tx.hash, l1FeeEstimateWei: e6.l1Fee, calldataBytes: e6.calldataBytes, calldataBytesFirstStart: e1.calldataBytes, sessionsUntil: sA6[0] });
ok('E6', e6Pass, `no deploy gas ${e6.tx.receipt.gasUsed} vs first start ${e1.tx.receipt.gasUsed}`);

// E4: revoke by the key: grant(key, 0, sig) and the rest of the float back to the owner, in one transaction through Multicall3.
const k4 = e6.key;
const ownerBefore = await pub.getBalance({ address: ownerA.address });
const revokeSig = await grantSig(ownerA, PS_a, k4.address, 0n);
const revokeCall = { target: PS_a, allowFailure: false, value: 0n, callData: encodeFunctionData({ abi: PSABI, functionName: 'grant', args: [k4.address, 0n, revokeSig] }) };
const mk = (rest: bigint) => encodeFunctionData({ abi: mcAbi, functionName: 'aggregate3Value', args: [[revokeCall, { target: ownerA.address, allowFailure: false, value: rest, callData: '0x' }]] });
const balK = await pub.getBalance({ address: k4.address });
const l1Rev = await l1Of(MULTICALL3, mk(1n), k4.address);
// leave a margin for the L1 fee, which the fork does not charge but Base does
const gEst = await pub.estimateGas({ account: k4.address, to: MULTICALL3, data: mk(1n), value: 1n });
const gpNow = (await pub.getBlock()).baseFeePerGas! + 1n;
// a sender's balance must cover gasLimit x maxFeePerGas (here 2 x estimate x 3 x base fee) beside the value, not just the gas used
const rest = balK - gEst * 2n * gpNow * 3n - l1Rev * 2n;
const rv = await send(k4, MULTICALL3, mk(rest), rest, 'revokeByKey');
const sRev = await sessionOf(PS_a, k4.address);
const ownerAfter = await pub.getBalance({ address: ownerA.address });
const keyLeft = await pub.getBalance({ address: k4.address });
const e4Pass = rv.ok && sRev[0] === (2n ** 128n - 1n) && ownerAfter - ownerBefore === rest;
rec('E4', { pass: e4Pass, tx: rv.hash, gasUsed: String(rv.receipt.gasUsed), sessionsUntil: sRev[0], ownerGainWei: ownerAfter - ownerBefore, restWei: rest, keyBalanceBeforeWei: balK, keyBalanceLeftWei: keyLeft, l1FeeEstimateWei: l1Rev, margin: 'the key keeps gasLimit x maxFeePerGas (2 x estimate x 3 x base fee) plus 2x the L1 fee estimate: the balance check counts the limit, not the gas used', revokeText: localGrantText(PS_a, k4.address, 0n) });
ok('E4', e4Pass, `${rv.hash} gas ${rv.receipt.gasUsed}; key left ${keyLeft} wei`);

// E5: revoked key refused by eth_estimateGas from the owner (any sender); a later regrant also fails
const e5 = await estimate(ownerA.address, PS_a, await execData(PS_a, k4, moveCall(dest, 1n * E18)));
const regrantEnd = (await now()) + 3600n;
const regrant = await estimate(ownerA.address, PS_a, encodeFunctionData({ abi: PSABI, functionName: 'grant', args: [k4.address, regrantEnd, await grantSig(ownerA, PS_a, k4.address, regrantEnd)] }));
const e5Pass = !e5.ok && /session/.test(e5.reason) && !regrant.ok && /grant/.test(regrant.reason);
rec('E5', { pass: e5Pass, execFromOwner: e5.reason, regrantAfterRevoke: regrant.reason });
ok('E5', e5Pass, `${e5.reason} / regrant: ${regrant.reason}`);

// E7: grantText on the fork equals the local builder for 3 keys and ends (and 0)
const vectors: { key: Address; end: string; text: string }[] = [];
let e7 = true;
for (const end of [1_900_000_000n, 0n, (await now()) + 3600n]) {
  const key = fresh().address;
  const onChain = await pub.readContract({ address: PS_a, abi: PSABI, functionName: 'grantText', args: [key, end] }) as string;
  const local = localGrantText(PS_a, key, end);
  e7 &&= onChain === local;
  vectors.push({ key, end: String(end), text: onChain });
}
rec('E7', { pass: e7, primeSession: PS_a, chainId: 84532, vectors });
ok('E7', e7, `${vectors.length} vectors`);

// E3 (expiry): warp past the 1 hour end; the key's move reverts `session`
await rpc('evm_increaseTime', [3601]); await rpc('evm_mine', []);
const exp = await estimate(e1key.address, PS_a, await execData(PS_a, e1key, moveCall(dest, 1n * E18)));
const expPass = !exp.ok && /session/.test(exp.reason);
res.E3 = { ...res.E3, expiredKey: exp.reason, pass: res.E3.pass && expPass };
rec('E3', res.E3);
ok('E3 expiry', expPass, exp.reason);

// Float formula inputs
const mv = BigInt(gas.moveSelfPaid!), rvk = BigInt(gas.revokeByKey!);
rec('fees', { forkGasPriceWei: gp, liveGasPriceWei: liveGp, gas: { ...gas }, l1FeeEstimateWei: { move: l1Move, revoke: l1Revoke, firstStart: e1.l1Fee, startNoDeploy: e6.l1Fee },
  floatFormula: 'moves * (moveGas * 2 * gasPrice + 2 * l1Move) + (revokeGas * 2 * gasPrice + 2 * l1Revoke), moveGas and revokeGas taken as bounds above the measured gas',
  boundsUsed: { moveGas: String(MOVE_GAS), revokeGas: String(REVOKE_GAS) }, measured: { moveGas: String(mv), revokeGas: String(rvk) }, floatFor50MovesAndRevokeWei: FLOAT, floatFor50MovesAndRevokeEth: formatEther(FLOAT),
  perMoveCostWei: String(mv * liveGp + l1Move), note: 'the fork charges no L1 data fee; the L1 fee is read from the Base Sepolia GasPriceOracle with the same calldata' });
rec('setup', { chainId: 84532, forkRpc: RPC, safe, roles, token, owners: [ownerA.address, ownerB.address], primeSessions: { a: PS_a, b: PS_b, stranger: PS_x }, roleKey, safeCreateTx: c1.hash, safeSetupTx: c2.hash, safeSetupGas: gas.safeSetup, pass: setupPass,
  bytecodeHash: art.PRIME_SESSION_BYTECODE_HASH, forkBlock: String(await pub.getBlockNumber()) });
const all = ['E1', 'E2', 'E3', 'E4', 'E5', 'E6', 'E7'].map((k) => `${k}:${res[k]?.pass ? 'PASS' : 'FAIL'}`);
console.log(all.join(' '));
process.exit(all.every((s) => s.endsWith('PASS')) ? 0 : 1);
