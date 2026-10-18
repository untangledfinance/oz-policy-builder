// Contract calls through a session key on EVM: a Prime Account (Safe 1.4.1 + Zodiac Roles v2.1.1, the PrimeX
// onboarding and policy code) on an anvil fork of Base Sepolia (port 8577), the round-9 PrimeSession as the Roles
// member, and a test venue that moves no token: deposit(uint256 amount, address onBehalfOf) / withdraw(uint256, address).
// Owners sign natively with local keys (MetaMask-style personal_sign for grants, EIP-712 for Safe votes): no NEAR.
//   rule A (callPolicy document, one call): Venue.deposit with amount <= CAP and onBehalfOf == the Safe
//   rule B (callPolicy document, two calls): Venue.deposit with 10 <= amount <= 100 and onBehalfOf one of two addresses;
//          Venue.withdraw with any amount and recipient == the Safe
// Every refusal is checked against the Roles status code, and against a control: the same call made by the Safe itself
// (eth_call from the Safe) succeeds, so the Roles rule is what refuses it, not the venue.
import { createPublicClient, createWalletClient, http, encodeFunctionData, parseAbi, getAddress, concat, pad, numberToHex, keccak256, toHex, encodeAbiParameters, parseEther, maxUint256, type Address, type Hex } from 'viem';
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts';
import { baseSepolia } from 'viem/chains';
import { readFileSync, writeFileSync } from 'node:fs';
const OCT = '/home/ubuntu/git/github.com/untangledfinance/octopos/apps/evm-web/src/core';
const ob = await import(`${OCT}/onboarding.ts`);
const pol = await import(`${OCT}/evm-policy.ts`);
const { CONTRACTS } = await import(`${OCT}/contracts.ts`);

const RPC = process.env.CALLS_RPC ?? 'http://127.0.0.1:8577';
if (!/127\.0\.0\.1:8577/.test(RPC)) throw new Error('this harness runs on the anvil fork at port 8577 only');
const pub = createPublicClient({ chain: baseSepolia, transport: http(RPC), pollingInterval: 500 });
const relayerAcct = privateKeyToAccount('0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'); // anvil dev #0 (public)
const wallet = (a: ReturnType<typeof privateKeyToAccount>) => createWalletClient({ chain: baseSepolia, transport: http(RPC), account: a });
const relayer = wallet(relayerAcct);
const rpc = (method: string, params: unknown[]) => fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) }).then((r) => r.json());
const st: any = {}; const results: any[] = [];
const save = () => writeFileSync(process.env.CALLS_STATE ?? 'state-calls-evm.json', JSON.stringify({ ...st, results }, (_, v) => (typeof v === 'bigint' ? v.toString() : v), 1));
function record(name: string, expectOk: boolean, ok: boolean, detail: string) {
  const pass = ok === expectOk; results.push({ name, pass, ok, detail }); save();
  console.log(`${pass ? 'PASS' : 'FAIL'} ${name} | ${ok ? `ok ${detail}` : `refused: ${detail}`}`);
  return pass;
}
// Zodiac Roles v2 Status enum (roles-abi.ts)
const STATUS: Record<number, string> = { 1: 'DelegateCallNotAllowed', 2: 'TargetAddressNotAllowed', 3: 'FunctionNotAllowed', 4: 'SendNotAllowed', 5: 'OrViolation', 7: 'ParameterNotAllowed', 8: 'ParameterLessThanAllowed', 9: 'ParameterGreaterThanAllowed', 10: 'ParameterNotAMatch', 17: 'AllowanceExceeded' };
const revertData = (e: any): string => { try { const w = e?.walk?.((x: any) => typeof x?.data === 'string' && /^0x[0-9a-f]{8}/i.test(x.data)); if (w?.data) return w.data; } catch {} return String(e?.message ?? e).replace(/\s/g, '').match(/(0x[0-9a-f]{8})/i)?.[1] ?? ''; };
const rolesStatus = (e: any): number | undefined => { const d = revertData(e); return /^0xd0a9bf58/i.test(d) && d.length >= 74 ? parseInt(d.slice(10, 74), 16) : undefined; };
const reason = (e: any) => { const s = String(e?.shortMessage ?? e?.message ?? e).replace(/\s+/g, ' ');
  const c = rolesStatus(e); if (c !== undefined) return `Roles ConditionViolation(${STATUS[c] ?? c})`;
  if (/0xfd8e9f28/i.test(s)) return 'Roles NoMembership';
  if (/0x742638b4/i.test(revertData(e))) return 'Roles CalldataOutOfBounds';
  return s.match(/(reverted with reason: [^.]*|GS\d{3}|reverted with the following reason:[^.]*|custom error 0x[0-9a-f]{8})/i)?.[0] ?? s.slice(0, 140); };
async function send(name: string, expectOk: boolean, to: Address, data: Hex, o: { expectStatus?: string; value?: bigint } = {}) {
  let ok = true, d = '', status: number | undefined;
  try { await pub.call({ account: relayerAcct, to, data, value: o.value }); const h = await relayer.sendTransaction({ to, data, gas: 3_000_000n, value: o.value }); const r = await pub.waitForTransactionReceipt({ hash: h }); ok = r.status === 'success'; d = `gas ${r.gasUsed}`; }
  catch (e: any) { ok = false; d = reason(e); status = rolesStatus(e); }
  const pass = record(name, expectOk, ok, d);
  if (!expectOk && o.expectStatus) record(`   ${name.split(' ')[0]} refusal reason is ${o.expectStatus}`, true, !!status && STATUS[status] === o.expectStatus, status === undefined ? d : (STATUS[status] ?? String(status)));
  return pass;
}
async function deploy(a: any, args: any[] = []) { const h = await relayer.deployContract({ abi: a.abi, bytecode: a.bytecode.object, args }); const r = await pub.waitForTransactionReceipt({ hash: h }); return getAddress(r.contractAddress!); }
const art = (dir: string, n: string) => JSON.parse(readFileSync(`${dir}/out/${n}.sol/${n}.json`, 'utf8'));
const PK = art('/home/ubuntu/work/prime-evm', 'PrimeSession'), VN = art('/home/ubuntu/work/calls-spike/evm', 'Venue');
const venueAbi = parseAbi(['function deposit(uint256 amount, address onBehalfOf)', 'function withdraw(uint256 amount, address to)', 'function deposits(address) view returns (uint256)', 'function lastCaller() view returns (address)', 'function calls() view returns (uint256)']);
const safeAbi = parseAbi(['function nonce() view returns (uint256)', 'function getOwners() view returns (address[])', 'function getThreshold() view returns (uint256)', 'function addOwnerWithThreshold(address owner, uint256 threshold)']);
const fresh = () => getAddress(privateKeyToAccount(generatePrivateKey()).address);
const now = async () => (await pub.getBlock()).timestamp;

// ── Owners: three local keys. The first (MetaMask-style) is also the PrimeSession owner. ─────────────────────
const seats = [0, 1, 2].map(() => privateKeyToAccount(generatePrivateKey()));
const MM = seats[0]!;
type Call = { to: Address; value: bigint; data: Hex; operation: 0 | 1 };
const dep = (venue: Address, amount: bigint, onBehalfOf: Address, o: Partial<Call> = {}): Call => ({ to: venue, value: 0n, operation: 0, data: encodeFunctionData({ abi: venueAbi, functionName: 'deposit', args: [amount, onBehalfOf] }), ...o });
const wd = (venue: Address, amount: bigint, to: Address): Call => ({ to: venue, value: 0n, operation: 0, data: encodeFunctionData({ abi: venueAbi, functionName: 'withdraw', args: [amount, to] }) });

async function safeTx(name: string, expectOk: boolean, call: Call, signers: ReturnType<typeof privateKeyToAccount>[]) {
  const nonce = await pub.readContract({ address: st.safe, abi: safeAbi, functionName: 'nonce' });
  const tx = { ...call, safeTxGas: 0n, baseGas: 0n, gasPrice: 0n, gasToken: '0x0000000000000000000000000000000000000000' as Address, refundReceiver: '0x0000000000000000000000000000000000000000' as Address, nonce };
  const hash = ob.hashSafeTransaction(84532, st.safe, tx);
  const sigs = (await Promise.all(signers.map(async (s) => ({ a: s.address, sig: await s.sign({ hash }) })))).sort((x, y) => (BigInt(x.a) < BigInt(y.a) ? -1 : 1)).map((x) => x.sig);
  return send(name, expectOk, st.safe, ob.encodeExecTransaction(tx, concat(sigs)));
}

// ── Sessions (PrimeSession round 9) ──────────────────────────────────────────────────────────────────────────
type Session = { pk: Address; key: ReturnType<typeof privateKeyToAccount>; role: Hex };
const grantText = (pk: Address, key: Address, end: bigint) => pub.readContract({ address: pk, abi: PK.abi, functionName: 'grantText', args: [key, end] }) as Promise<string>;
async function grant(name: string, pk: Address, role: Hex): Promise<Session> {
  const key = privateKeyToAccount(generatePrivateKey()), end = (await now()) + 3600n;
  const sig = await MM.signMessage({ message: await grantText(pk, key.address, end) });
  await send(name, true, pk, encodeFunctionData({ abi: PK.abi, functionName: 'grant', args: [key.address, end, sig] }));
  return { pk, key, role };
}
const nonceOf = async (s: Session) => (await pub.readContract({ address: s.pk, abi: PK.abi, functionName: 'sessions', args: [s.key.address] }) as readonly [bigint, bigint])[1];
const execHash = (s: Session, n: bigint, c: Call) => keccak256(encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'address' }, { type: 'uint256' }, { type: 'bytes32' }, { type: 'uint8' }, { type: 'bytes32' }], [s.pk, 84532n, n, c.to, c.value, keccak256(c.data), c.operation, s.role]));
// One move through PrimeSession.exec. expectStatus: the Roles status that must explain a refusal. control: the Safe itself can make the call.
async function move(name: string, expectOk: boolean, s: Session, c: Call, o: { expectStatus?: string; control?: boolean; replay?: Hex } = {}) {
  const sig = o.replay ?? await s.key.sign({ hash: execHash(s, await nonceOf(s), c) });
  const data = encodeFunctionData({ abi: PK.abi, functionName: 'exec', args: [c.to, c.value, c.data, c.operation, s.role, s.key.address, sig] });
  const before = await state();
  await send(name, expectOk, s.pk, data, { expectStatus: o.expectStatus });
  const after = await state();
  if (!expectOk) record(`   ${name.split(' ')[0]} venue state unchanged by the refused call`, true, before === after, after);
  if (o.control) { // the call itself is valid: the Safe (as msg.sender) can make it, so only the rule refuses it
    let ok = true, d = 'ok'; try { await pub.call({ account: st.safe, to: c.to, data: c.data, value: c.value }); } catch (e: any) { ok = false; d = reason(e); }
    record(`   ${name.split(' ')[0]} control: the same call from the Safe itself would succeed (so the rule is what refuses it)`, true, ok, d);
  }
  return sig;
}
async function state() { const out: string[] = [`${await venueCalls(st.venue)}`, `${await venueCalls(st.venue2)}`];
  for (const w of [st.safe, st.other, st.treasury]) out.push(`${await deposits(w)}`);
  return out.join('/'); }
const deposits = (who: Address, venue: Address = st.venue) => pub.readContract({ address: venue, abi: venueAbi, functionName: 'deposits', args: [who] }) as Promise<bigint>;
const lastCaller = (venue: Address = st.venue) => pub.readContract({ address: venue, abi: venueAbi, functionName: 'lastCaller' }) as Promise<Address>;
const venueCalls = (venue: Address = st.venue) => pub.readContract({ address: venue, abi: venueAbi, functionName: 'calls' }) as Promise<bigint>;

// ── Setup ──────────────────────────────────────────────────────────────────────────────────────────────────
const CAP = 1000n;
st.venue = await deploy(VN); st.venue2 = await deploy(VN);
st.other = fresh(); st.treasury = fresh();
const proxyCreationCode = await pub.readContract({ address: CONTRACTS.safeProxyFactory, abi: parseAbi(['function proxyCreationCode() view returns (bytes)']), functionName: 'proxyCreationCode' }) as Hex;
const initializer = ob.encodeSafeInitializer([MM.address], 1n, CONTRACTS.compatibilityFallbackHandler);
const salt = BigInt(keccak256(toHex(`calls-evm-${Date.now()}`)));
st.safe = ob.predictSafeAddress(proxyCreationCode, initializer, salt); st.roles = ob.predictPrimeRolesAddress(st.safe);
st.pkA = await deploy(PK, [MM.address, st.roles]); st.pkB = await deploy(PK, [MM.address, st.roles]);
// rule A: one call. The document is the app's own callPolicy shape.
const docA = { callPolicy: 1 as const, calls: [{ to: st.venue, fn: 'deposit(uint256,address)', args: [{ lte: CAP.toString() }, { eq: st.safe }] }] };
const ruleA = pol.buildRuleInstall({ doc: docA, docText: JSON.stringify(docA), name: 'venue-deposit', ctx: { prime: st.safe, primeRoles: st.roles }, proxyCreationCode, wallets: [st.pkA], threshold: 1 });
st.roleA = ruleA.roleKey;
const c0 = ob.encodeCreateSafe(initializer, salt);
await send('C1. create the Safe (MetaMask-style key first, PrimeX flow)', true, c0.to, c0.data);
const init = ob.buildSafeInitializationTransaction(st.safe, [seats[1]!.address, seats[2]!.address], 2n, ruleA.calls);
await send('C2. three seats, threshold 2; Roles installed; rule A for PrimeSession A', true, st.safe, ob.encodeExecTransaction(init, await MM.sign({ hash: ob.hashSafeTransaction(84532, st.safe, init) })));
{ const own = (await pub.readContract({ address: st.safe, abi: safeAbi, functionName: 'getOwners' }) as Address[]).map((a) => a.toLowerCase());
  record('C3. Safe owners are exactly the three seat keys (no PrimeSession), threshold 2', true, own.length === 3 && seats.every((s) => own.includes(s.address.toLowerCase())) && ![st.pkA, st.pkB].some((a) => own.includes(a.toLowerCase())) && (await pub.readContract({ address: st.safe, abi: safeAbi, functionName: 'getThreshold' })) === 2n, `${own.length} owners`); }
{ const a = await pub.readContract({ address: st.roles, abi: parseAbi(['function owner() view returns (address)']), functionName: 'owner' });
  record('C4. Roles is owned by the Safe; the venue is a contract that never saw this Safe before', true, a === st.safe && (await venueCalls()) === 0n, `calls ${await venueCalls()}`); }

// ── Rule A: one function, one capped argument, one fixed argument ─────────────────────────────────────────
console.log('--- rule A: deposit(amount <= 1000, onBehalfOf == Safe) on one venue');
const A = await grant('A0. MetaMask-style key grants a 1-hour session on PrimeSession A (one personal_sign)', st.pkA, st.roleA);
const sigA1 = await move('A1. allowed: deposit(100, Safe)', true, A, dep(st.venue, 100n, st.safe));
record('A2. the venue ledger shows 100 for the Safe, and its caller was the Safe (not the session key, not PrimeSession)', true, (await deposits(st.safe)) === 100n && (await lastCaller()) === st.safe && (await venueCalls()) === 1n, `deposits ${await deposits(st.safe)}, lastCaller ${(await lastCaller()).slice(0, 10)}, calls ${await venueCalls()}`);
await move(`A3. boundary: deposit(${CAP}, Safe), amount equal to the cap`, true, A, dep(st.venue, CAP, st.safe));
await move(`A4. amount over the cap: deposit(${CAP + 1n}, Safe)`, false, A, dep(st.venue, CAP + 1n, st.safe), { expectStatus: 'ParameterGreaterThanAllowed', control: true });
await move('A5. amount = 2^256 - 1', false, A, dep(st.venue, maxUint256, st.safe), { expectStatus: 'ParameterGreaterThanAllowed', control: false });
await move('A6. different onBehalfOf (a stranger): deposit(100, other)', false, A, dep(st.venue, 100n, st.other), { expectStatus: 'ParameterNotAllowed', control: true });
await move("A7. onBehalfOf is the session key's own address", false, A, dep(st.venue, 100n, A.key.address), { expectStatus: 'ParameterNotAllowed', control: true });
await move('A8. onBehalfOf is the zero address', false, A, dep(st.venue, 100n, '0x0000000000000000000000000000000000000000'), { expectStatus: 'ParameterNotAllowed', control: true });
await move('A9. another function on the same venue: withdraw(1, Safe)', false, A, wd(st.venue, 1n, st.safe), { expectStatus: 'FunctionNotAllowed', control: true });
await move('A10. the same allowed call on another contract (a second venue)', false, A, dep(st.venue2, 100n, st.safe), { expectStatus: 'TargetAddressNotAllowed', control: true });
await move('A11. delegatecall of the allowed deposit', false, A, dep(st.venue, 100n, st.safe, { operation: 1 }), { expectStatus: 'DelegateCallNotAllowed', control: false });
await move('A12. the allowed deposit with 1 wei of ETH attached', false, A, dep(st.venue, 100n, st.safe, { value: 1n }), { expectStatus: 'SendNotAllowed', control: false });
await move('A13. a call to the Safe itself (addOwnerWithThreshold)', false, A, { to: st.safe, value: 0n, operation: 0, data: encodeFunctionData({ abi: safeAbi, functionName: 'addOwnerWithThreshold', args: [A.key.address, 1n] }) }, { expectStatus: 'TargetAddressNotAllowed', control: false });
await move('A14. empty calldata to the venue (fallback)', false, A, { to: st.venue, value: 0n, operation: 0, data: '0x' }, { control: false });
await move('A15. the deposit selector with no arguments (short calldata)', false, A, { to: st.venue, value: 0n, operation: 0, data: encodeFunctionData({ abi: venueAbi, functionName: 'deposit', args: [1n, st.safe] }).slice(0, 10) as Hex }, { control: false });
{ const good = dep(st.venue, 7n, st.safe), padded = { ...good, data: (good.data + 'ff'.repeat(4)) as Hex };
  // Solidity ignores bytes after the arguments, so the venue reads the same (7, Safe): safe to accept, and the venue sees nothing different. Report what Roles does.
  const d0 = await deposits(st.safe); await move('A16. the allowed call with 4 extra bytes after the arguments: accepted, and the venue reads the same (7, Safe)', true, A, padded, { control: false });
  record('A16b. effect on the venue is exactly deposit(7, Safe)', true, (await deposits(st.safe)) - d0 === 7n, `+${(await deposits(st.safe)) - d0}`); }
const b0 = await state();
await move('A17. replay of the accepted A1 signature (nonce already used)', false, A, dep(st.venue, 100n, st.safe), { replay: sigA1 });
{ const n0 = await nonceOf(A); await move('A19. allowed: deposit(5, Safe) again', true, A, dep(st.venue, 5n, st.safe)); record('A20. session nonce advanced by exactly one for the accepted move, none for refused ones', true, (await nonceOf(A)) === n0 + 1n, `nonce ${n0} -> ${await nonceOf(A)}`); }
record('A21. totals: Safe deposited 100 + 1000 + 7 + 5 = 1112 and the venue counted 4 calls; no refused call changed anything', true, (await deposits(st.safe)) === 1112n && (await venueCalls()) === 4n && (await deposits(st.other)) === 0n && (await venueCalls(st.venue2)) === 0n, `deposits ${await deposits(st.safe)}, calls ${await venueCalls()}, other ${await deposits(st.other)}, venue2 calls ${await venueCalls(st.venue2)} (state before A17 ${b0})`);

// ── Rule B: two functions, a range, a set of recipients ─────────────────────────────────────────────────────
console.log('--- rule B: deposit(10 <= amount <= 100, onBehalfOf in {Safe, treasury}), withdraw(any amount, to == Safe)');
const docB = { callPolicy: 1 as const, calls: [
  { to: st.venue, fn: 'deposit(uint256,address)', args: [{ gte: '10', lte: '100' }, { oneOf: [st.safe, st.treasury] }] },
  { to: st.venue, fn: 'withdraw(uint256,address)', args: [{}, { eq: st.safe }] }] };
const ruleB = pol.buildRuleInstall({ doc: docB, docText: JSON.stringify(docB), name: 'venue-two-calls', ctx: { prime: st.safe, primeRoles: st.roles }, proxyCreationCode, wallets: [st.pkB], threshold: 1 });
st.roleB = ruleB.roleKey; save();
{ const batch = ob.buildConfigBatch(ruleB.calls);
  await safeTx('B0. two seats install rule B for PrimeSession B (a Safe transaction, 2-of-3)', true, { ...batch, operation: batch.operation }, [seats[1]!, seats[2]!]); }
const B = await grant('B1. MetaMask-style key grants a session on PrimeSession B', st.pkB, st.roleB);
await move('B2. allowed: deposit(10, Safe), the lower bound', true, B, dep(st.venue, 10n, st.safe));
await move('B3. allowed: deposit(100, treasury), the upper bound and the second listed address', true, B, dep(st.venue, 100n, st.treasury));
await move('B4. below the range: deposit(9, Safe)', false, B, dep(st.venue, 9n, st.safe), { expectStatus: 'ParameterLessThanAllowed', control: true });
await move('B5. above the range: deposit(101, Safe)', false, B, dep(st.venue, 101n, st.safe), { expectStatus: 'ParameterGreaterThanAllowed', control: true });
await move('B6. onBehalfOf outside the set: deposit(50, other)', false, B, dep(st.venue, 50n, st.other), { expectStatus: 'OrViolation', control: true });
await move('B7. allowed: withdraw(5, Safe), any amount (no condition on the first argument)', true, B, wd(st.venue, 5n, st.safe));
await move('B8. withdraw to the treasury (the recipient must be the Safe)', false, B, wd(st.venue, 1n, st.treasury), { expectStatus: 'ParameterNotAllowed', control: false });
await move('B9. PrimeSession B asks for rule A\'s role key (a role it is not a member of)', false, { ...B, role: st.roleA }, dep(st.venue, 100n, st.safe), { expectStatus: undefined, control: false });
record('B10. totals: Safe 1112 + 10 - 5 = 1117, treasury 100, 7 calls on the venue, none on the second venue', true, (await deposits(st.safe)) === 1117n && (await deposits(st.treasury)) === 100n && (await venueCalls()) === 7n && (await venueCalls(st.venue2)) === 0n, `safe ${await deposits(st.safe)}, treasury ${await deposits(st.treasury)}, calls ${await venueCalls()}`);

// ── Session ends and revoke still apply to contract calls ───────────────────────────────────────────────────
{ const r = await grant('R1. a second session on PrimeSession A', st.pkA, st.roleA);
  const sig = await MM.signMessage({ message: await grantText(st.pkA, r.key.address, 0n) });
  await send('R2. the owner revokes it: grant with end 0 (one signature)', true, st.pkA, encodeFunctionData({ abi: PK.abi, functionName: 'grant', args: [r.key.address, 0n, sig] }));
  await move('R3. the revoked session makes the otherwise allowed deposit(1, Safe)', false, r, dep(st.venue, 1n, st.safe), {});
  await rpc('evm_increaseTime', [3601]); await rpc('evm_mine', []);
  await move('R4. after the session ends, the first session makes the allowed deposit(1, Safe)', false, A, dep(st.venue, 1n, st.safe), {}); }

console.log(`${results.filter((r) => r.pass).length}/${results.length} passed`);
for (const r of results.filter((r) => !r.pass)) console.log('FAIL', r.name, r.detail);
process.exit(0);
