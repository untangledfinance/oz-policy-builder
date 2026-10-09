// Prime on EVM (PrimeX: Safe 1.4.1 + Zodiac Roles v2.1.1, Base Sepolia fork on anvil), every wallet family:
//   seats  (Safe owners, 2-of-3): MetaMask (its own key), Phantom and Freighter (their NEAR MPC secp256k1 addresses,
//          reached through NEAR's wallet contract: text-ed25519 for Phantom, SEP-53 for Freighter)
//   sessions: one SessionMember per wallet is the Roles member of a PrimeX spending-limit rule (built with PrimeX's
//          own buildRuleInstall). The wallet signs one EIP-712 grant; the session key then signs each move.
import { createPublicClient, createWalletClient, http, encodeFunctionData, parseAbi, getAddress, concat, parseEther, type Address, type Hex, keccak256, toHex } from 'viem';
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts';
import { baseSepolia } from 'viem/chains';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { metamask } from './keys.ts';
const OCT = '/home/ubuntu/git/github.com/untangledfinance/octopos/apps/evm-web/src/core';
const ob = await import(`${OCT}/onboarding.ts`);
const pol = await import(`${OCT}/evm-policy.ts`);
const { CONTRACTS } = await import(`${OCT}/contracts.ts`);

const RPC = 'http://127.0.0.1:8546';
const pub = createPublicClient({ chain: baseSepolia, transport: http(RPC) });
// anvil's well-known dev account #0 (public test key) relays and pays gas
const relayer = createWalletClient({ chain: baseSepolia, transport: http(RPC), account: privateKeyToAccount('0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80') });
const STATE = 'state-evm.json';
const st: any = existsSync(STATE) ? JSON.parse(readFileSync(STATE, 'utf8')) : {};
const save = () => writeFileSync(STATE, JSON.stringify(st, (_, v) => typeof v === 'bigint' ? v.toString() : v, 1));
const results: any[] = st.results ?? (st.results = []);
function record(name: string, expectOk: boolean, ok: boolean, detail: string) {
  const pass = ok === expectOk; results.push({ name, pass, ok, detail }); save();
  console.log(`${pass ? 'PASS' : 'FAIL'} ${name} | ${ok ? `ok ${detail}` : `refused: ${detail}`}`);
  return ok;
}
const ROLES_STATUS: Record<number, string> = { 2: 'TargetAddressNotAllowed', 3: 'FunctionNotAllowed', 5: 'OrViolation', 7: 'ParameterNotAllowed', 9: 'ParameterGreaterThanAllowed', 17: 'AllowanceExceeded' };
const rolesErr = (s: string) => { const m = s.match(/0xd0a9bf58:?\s*([0-9a-f]{64})/i); if (m) return `Roles ConditionViolation(${ROLES_STATUS[parseInt(m[1]!, 16)] ?? parseInt(m[1]!, 16)})`; if (/0xfd8e9f28/i.test(s)) return 'Roles NoMembership'; return null; };
const reason = (e: any) => rolesErr(String(e?.shortMessage ?? e?.message ?? e).replace(/\s+/g, '')) ?? String(e?.shortMessage ?? e?.message ?? e).replace(/\s+/g, ' ').match(/(reverted with reason string '[^']*'|reverted with the following reason:[^.]*|reverted with custom error '[^']*'|Error: [A-Za-z]+\([^)]*\)|GS\d{3}|execution reverted[^.]{0,80})/)?.[0] ?? String(e?.shortMessage ?? e).slice(0, 140);
async function send(name: string, expectOk: boolean, to: Address, data: Hex) {
  let ok = true, d = '';
  try { await pub.call({ account: relayer.account, to, data }); const h = await relayer.sendTransaction({ to, data, gas: 3_000_000n }); const r = await pub.waitForTransactionReceipt({ hash: h }); ok = r.status === 'success'; d = h; }
  catch (e: any) { ok = false; d = reason(e); }
  return record(name, expectOk, ok, d);
}

// ── Wallets ────────────────────────────────────────────────────────────────
type W = { name: string; addr: Address; signHash: (h: Hex) => Promise<Hex> };
function nearSign(wallet: 'freighter' | 'phantom', hash?: Hex) {
  const t0 = Date.now();
  const out = execFileSync('/home/ubuntu/work/evm-matrix/near-sign.sh', [wallet, '0', 'prime:matrix/evm-1', ...(hash ? [hash.slice(2)] : [])], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  if (hash) console.log(`   ${wallet} -> NEAR wallet contract -> MPC secp256k1 in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  return { addr: getAddress(out.match(/ADDR (0x\w+)/)![1]!), sig: hash ? (`0x${out.match(/SIG (\w+)/)![1]}${(27 + Number(out.match(/V (\d)/)![1])).toString(16)}` as Hex) : undefined };
}
const MM: W = { name: 'MetaMask', addr: metamask.address, signHash: (h) => metamask.sign({ hash: h }) };
const PH: W = { name: 'Phantom', addr: nearSign('phantom').addr, signHash: async (h) => nearSign('phantom', h).sig! };
const FR: W = { name: 'Freighter', addr: nearSign('freighter').addr, signHash: async (h) => nearSign('freighter', h).sig! };
const OUTSIDER = privateKeyToAccount(generatePrivateKey());
const OUT: W = { name: 'outsider', addr: OUTSIDER.address, signHash: (h) => OUTSIDER.sign({ hash: h }) };

// ── Contracts ──────────────────────────────────────────────────────────────
const art = (n: string) => JSON.parse(readFileSync(`/home/ubuntu/work/evm-matrix/out/${n}.sol/${n}.json`, 'utf8'));
const SM = art('SessionMember'), TK = art('Token');
const tokenAbi = parseAbi(['function mint(address,uint256)', 'function transfer(address,uint256) returns (bool)', 'function balanceOf(address) view returns (uint256)']);
const safeAbi = parseAbi(['function nonce() view returns (uint256)', 'function getOwners() view returns (address[])', 'function getThreshold() view returns (uint256)']);
const rolesAbi = parseAbi(['function assignRoles(address module, bytes32[] roleKeys, bool[] memberOf)']);
async function deploy(a: any, args: any[] = []) {
  const h = await relayer.deployContract({ abi: a.abi, bytecode: a.bytecode.object, args }); return (await pub.waitForTransactionReceipt({ hash: h })).contractAddress!;
}
const VENUE = getAddress(st.venue ?? (st.venue = privateKeyToAccount(generatePrivateKey()).address));
const OTHER = getAddress(st.other ?? (st.other = privateKeyToAccount(generatePrivateKey()).address));
const DEST = getAddress(st.dest ?? (st.dest = privateKeyToAccount(generatePrivateKey()).address));
const E18 = 10n ** 18n;

/** A Safe transaction signed by `signers` (each signs the EIP-712 SafeTx hash; sorted by address). */
async function safeTx(name: string, expectOk: boolean, call: { to: Address; value: bigint; data: Hex; operation: 0 | 1 }, signers: W[]) {
  const safe = st.safe as Address;
  const nonce = await pub.readContract({ address: safe, abi: safeAbi, functionName: 'nonce' });
  const tx = { ...call, safeTxGas: 0n, baseGas: 0n, gasPrice: 0n, gasToken: '0x0000000000000000000000000000000000000000' as Address, refundReceiver: '0x0000000000000000000000000000000000000000' as Address, nonce };
  const hash = ob.hashSafeTransaction(84532, safe, tx);
  const sigs: [Address, Hex][] = [];
  for (const s of signers) sigs.push([s.addr, await s.signHash(hash)]);
  sigs.sort((a, b) => (BigInt(a[0]) < BigInt(b[0]) ? -1 : 1));
  return send(name, expectOk, safe, ob.encodeExecTransaction(tx, concat(sigs.map((x) => x[1]))));
}
const tokenTransfer = (to: Address, amount: bigint) => ({ to: st.token as Address, value: 0n, operation: 0 as const, data: encodeFunctionData({ abi: tokenAbi, functionName: 'transfer', args: [to, amount] }) });
const bal = (a: Address) => pub.readContract({ address: st.token, abi: tokenAbi, functionName: 'balanceOf', args: [a] });

// ── Sessions ───────────────────────────────────────────────────────────────
const smAbi = SM.abi;
async function grant(w: W, member: Address, key: Address, until: bigint) {
  if (w === MM) // MetaMask: eth_signTypedData_v4
    return metamask.signTypedData({ domain: { name: 'Prime Session', version: '1' }, primaryType: 'PrimeSession',
      types: { PrimeSession: [{ name: 'member', type: 'address' }, { name: 'sessionKey', type: 'address' }, { name: 'validUntil', type: 'uint64' }, { name: 'chainId', type: 'uint256' }] },
      message: { member, sessionKey: key, validUntil: until, chainId: 84532n } });
  const digest = await pub.readContract({ address: member, abi: smAbi, functionName: 'grantDigest', args: [key, until] }) as Hex;
  return w.signHash(digest); // Phantom / Freighter: one wallet signature -> NEAR MPC signs the same digest
}
let lastExec: { member: Address; data: Hex } = { member: '0x0000000000000000000000000000000000000000', data: '0x' };
type Session = { w: W; member: Address; key: ReturnType<typeof privateKeyToAccount>; until: bigint; grant: Hex };
async function openSession(w: W, member: Address, seconds = 3600n): Promise<Session> {
  const key = privateKeyToAccount(generatePrivateKey());
  const now = (await pub.getBlock()).timestamp;
  const until = now + seconds;
  return { w, member, key, until, grant: await grant(w, member, key.address, until) };
}
async function move(name: string, expectOk: boolean, s: Session, call: { to: Address; value: bigint; data: Hex; operation: 0 | 1 }, o: { grant?: Hex; until?: bigint; signer?: ReturnType<typeof privateKeyToAccount> } = {}) {
  const digest = await pub.readContract({ address: s.member, abi: smAbi, functionName: 'callDigest', args: [s.key.address, call.to, call.value, call.data, call.operation, st.roleKey] }) as Hex;
  const sessionSig = await (o.signer ?? s.key).sign({ hash: digest });
  lastExec = { member: s.member, data: encodeFunctionData({ abi: smAbi, functionName: 'exec',
    args: [call.to, call.value, call.data, call.operation, st.roleKey, s.key.address, o.until ?? s.until, o.grant ?? s.grant, sessionSig] }) };
  return send(name, expectOk, s.member, lastExec.data);
}

const part = process.argv[2];
if (part === 'setup') {
  console.log({ MetaMask: MM.addr, Phantom: PH.addr, Freighter: FR.addr });
  st.token = await deploy(TK);
  const proxyCreationCode = await pub.readContract({ address: CONTRACTS.safeProxyFactory, abi: parseAbi(['function proxyCreationCode() view returns (bytes)']), functionName: 'proxyCreationCode' }) as Hex;
  const initializer = ob.encodeSafeInitializer([MM.addr], 1n, CONTRACTS.compatibilityFallbackHandler);
  const salt = BigInt(keccak256(toHex(`matrix-${Date.now()}`)));
  const safe = ob.predictSafeAddress(proxyCreationCode, initializer, salt);
  const roles = ob.predictPrimeRolesAddress(safe);
  st.safe = safe; st.roles = roles; save();
  st.members = {};
  for (const w of [MM, PH, FR]) st.members[w.name] = await deploy(SM, [w.addr, roles]);
  const wallets = [MM, PH, FR].map((w) => getAddress(st.members[w.name]));
  const doc = { spendingLimit: 1 as const, token: st.token, recipients: [VENUE], amount: (100n * E18).toString(), period: '86400' };
  const rule = pol.buildRuleInstall({ doc, docText: JSON.stringify(doc), name: 'movers', ctx: { prime: safe, primeRoles: roles }, proxyCreationCode, wallets, threshold: 1 });
  st.roleKey = rule.roleKey; save();
  record('V0. rule members are the three SessionMembers directly (one approval each)', true, rule.members.length === 3 && !rule.shared, rule.members.join(','));
  const c = ob.encodeCreateSafe(initializer, salt);
  await send('V1. create Safe (PrimeX flow: creator MetaMask first)', true, c.to, c.data);
  // nonce 0, signed by the creator alone: add Phantom + Freighter seats, threshold 2, Roles module, the movers rule
  const init = ob.buildSafeInitializationTransaction(safe, [PH.addr, FR.addr], 2n, rule.calls);
  const h0 = ob.hashSafeTransaction(84532, safe, init);
  await send('V2. nonce 0 (MetaMask): seats MetaMask, Phantom (NEAR MPC), Freighter (NEAR MPC); threshold 2; Roles + spending-limit rule (100/day to VENUE)', true, safe, ob.encodeExecTransaction(init, await MM.signHash(h0)));
  const owners = await pub.readContract({ address: safe, abi: safeAbi, functionName: 'getOwners' }) as Address[];
  const th = await pub.readContract({ address: safe, abi: safeAbi, functionName: 'getThreshold' });
  record('V3. Safe owners = MetaMask, Phantom, Freighter; threshold 2', true, owners.length === 3 && [MM, PH, FR].every((w) => owners.includes(w.addr)) && th === 2n, `${owners.join(',')} t=${th}`);
  await send('V4. mint 1000 test tokens to the Safe', true, st.token, encodeFunctionData({ abi: tokenAbi, functionName: 'mint', args: [safe, 1000n * E18] }));
  save();
}
if (part === 'seats') {
  const t = (n: bigint) => tokenTransfer(DEST, n * E18);
  await safeTx('W1. MetaMask alone signs a Safe transfer', false, t(1n), [MM]);
  await safeTx('W2. MetaMask + outsider', false, t(1n), [MM, OUT]);
  const b0 = await bal(DEST);
  await safeTx('W3. MetaMask + Phantom', true, t(1n), [MM, PH]);
  await safeTx('W4. Phantom + Freighter (no MetaMask)', true, t(1n), [PH, FR]);
  await safeTx('W5. Freighter + MetaMask', true, t(1n), [FR, MM]);
  record('W6. DEST received exactly 3 tokens', true, (await bal(DEST)) - b0 === 3n * E18, `${((await bal(DEST)) - b0) / E18}`);
}
if (part === 'sessions') {
  const m = (w: W) => getAddress(st.members[w.name]);
  const toVenue = (n: bigint) => tokenTransfer(VENUE, n * E18), toOther = (n: bigint) => tokenTransfer(OTHER, n * E18);
  const sessions: Record<string, Session> = {};
  for (const w of [MM, PH, FR]) {
    const s = sessions[w.name] = await openSession(w, m(w));
    console.log(`   ${w.name} granted session ${s.key.address} (one signature)`);
    const b = await bal(VENUE);
    await move(`X-${w.name}1. session: 10 tokens to VENUE`, true, s, toVenue(10n));
    record(`X-${w.name}1b. VENUE received 10`, true, (await bal(VENUE)) - b === 10n * E18, `${((await bal(VENUE)) - b) / E18}`);
    await move(`X-${w.name}2. session: 1 token to another address`, false, s, toOther(1n));
    await move(`X-${w.name}1r. session: a 0-token move (replayed next)`, true, s, toVenue(0n));
    const used = lastExec; await send(`X-${w.name}3. replay of a used, signed move`, false, used.member, used.data);
    await move(`X-${w.name}4. a move signed by another key`, false, s, toVenue(1n), { signer: privateKeyToAccount(generatePrivateKey()) });
  }
  await move('X4. shared cap: MetaMask session 71 more (30 + 71 > 100/day)', false, sessions.MetaMask!, toVenue(71n));
  await move('X5. shared cap: Phantom session 70 more (exactly 100)', true, sessions.Phantom!, toVenue(70n));
  await move('X6. MetaMask grant used on the Phantom member', false, { ...sessions.MetaMask!, member: m(PH) }, toVenue(1n));
  await move('X7. stretched validUntil (grant was for less)', false, sessions.Freighter!, toVenue(1n), { until: sessions.Freighter!.until + 60n });
  const far = await openSession(MM, m(MM), 8n * 86400n);
  await move('X8. session longer than 7 days', false, far, toVenue(1n));
  // owner revokes its own session (one signature, anyone submits)
  const rev = await grant(FR, m(FR), sessions.Freighter!.key.address, 0n);
  await send('X9. Freighter revokes its session (signature via NEAR)', true, m(FR), encodeFunctionData({ abi: smAbi, functionName: 'revoke', args: [sessions.Freighter!.key.address, rev] }));
  await move('X10. revoked Freighter session (still within its validity)', false, sessions.Freighter!, toVenue(0n));
  await pub.request({ method: 'evm_increaseTime' as any, params: [86400] as any }); await pub.request({ method: 'evm_mine' as any, params: [] as any });
  const s2 = await openSession(PH, m(PH), 60n);
  await move('X11. fresh Phantom session works next day', true, s2, toVenue(1n));
  await pub.request({ method: 'evm_increaseTime' as any, params: [120] as any }); await pub.request({ method: 'evm_mine' as any, params: [] as any });
  await move('X12. that session after it expired', false, s2, toVenue(1n));
  // 2-of-3 removes MetaMask's member from the rule: its live session stops
  const s3 = await openSession(MM, m(MM));
  await move('X13. MetaMask session before removal', true, s3, toVenue(1n));
  await safeTx('X14. Phantom + Freighter remove the MetaMask member from the rule', true,
    { to: st.roles, value: 0n, operation: 0, data: encodeFunctionData({ abi: rolesAbi, functionName: 'assignRoles', args: [m(MM), [st.roleKey], [false]] }) }, [PH, FR]);
  await move('X15. same MetaMask session after removal', false, s3, toVenue(1n));
  await move('X16. Phantom session still works', true, await openSession(PH, m(PH)), toVenue(1n));
}
if (part === 'fix') {
  // X5 and X10 were refused for the wrong reason (cap partly spent by an earlier partial run; session expired before
  // the revoke was checked). Redone cleanly.
  for (const r of results) if (/^X(5|10)\./.test(r.name) || (r.name.startsWith('X-') && results.filter((x) => x.name === r.name).indexOf(r) === 0 && results.filter((x) => x.name === r.name).length > 1))
    { r.pass = false; r.detail = `(harness: invalid run, redone as C*/R*) ${r.detail}`; }
  save();
  const m = (w: W) => getAddress(st.members[w.name]);
  await pub.request({ method: 'evm_increaseTime' as any, params: [86400] as any }); await pub.request({ method: 'evm_mine' as any, params: [] as any });
  const ph = await openSession(PH, m(PH)), fr = await openSession(FR, m(FR));
  await move('C1. new day: Phantom session 60 to VENUE', true, ph, tokenTransfer(VENUE, 60n * E18));
  await move('C2. Freighter session 41 (60 + 41 > 100/day, cap shared)', false, fr, tokenTransfer(VENUE, 41n * E18));
  await move('C3. Freighter session 40 (exactly 100)', true, fr, tokenTransfer(VENUE, 40n * E18));
  await move('C4. Phantom session 1 more', false, ph, tokenTransfer(VENUE, 1n * E18));
  const fr2 = await openSession(FR, m(FR));
  const rev = await grant(FR, m(FR), fr2.key.address, 0n);
  await send('R1. Freighter revokes a live session (one signature via NEAR, anyone submits)', true, m(FR), encodeFunctionData({ abi: smAbi, functionName: 'revoke', args: [fr2.key.address, rev] }));
  await move('R2. that session, still within its validity', false, fr2, tokenTransfer(VENUE, 0n));
  await send('R3. outsider tries to revoke the Phantom session', false, m(PH), encodeFunctionData({ abi: smAbi, functionName: 'revoke', args: [ph.key.address, await OUT.signHash(await pub.readContract({ address: m(PH), abi: smAbi, functionName: 'grantDigest', args: [ph.key.address, 0n] }) as Hex)] }));
}
if (part === 'summary') { const p = results.filter((r) => r.pass).length; console.log(`${p}/${results.length} passed`); for (const r of results.filter((r) => !r.pass)) console.log('FAIL', r.name, r.detail); }
