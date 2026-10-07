// Is NEAR necessary for Freighter / Phantom on EVM? Same PrimeX account as evm.ts, but Freighter and Phantom are
// checked on chain by an ed25519 verifier contract (chengwenxi/Ed25519, unaudited) instead of NEAR MPC:
//   seats:    Ed25519Owner (ERC-1271 Safe owner) - the wallet signs "Prime approval / safe / safe tx" text
//   sessions: SessionMemberEd - the wallet signs a readable grant once; the session key signs each call
import { createPublicClient, createWalletClient, http, encodeFunctionData, parseAbi, getAddress, concat, pad, toHex, numberToHex, keccak256, type Address, type Hex } from 'viem';
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts';
import { baseSepolia } from 'viem/chains';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import nacl from 'tweetnacl';
import bs58 from 'bs58';
const { Keypair: StellarKeypair } = await import('/home/ubuntu/work/near-session-spike/node_modules/@stellar/stellar-sdk/lib/index.js');
import { metamask } from './keys.ts';
const OCT = '/home/ubuntu/git/github.com/untangledfinance/octopos/apps/evm-web/src/core';
const ob = await import(`${OCT}/onboarding.ts`);
const pol = await import(`${OCT}/evm-policy.ts`);
const { CONTRACTS } = await import(`${OCT}/contracts.ts`);

const RPC = 'http://127.0.0.1:8546';
const pub = createPublicClient({ chain: baseSepolia, transport: http(RPC) });
const relayer = createWalletClient({ chain: baseSepolia, transport: http(RPC), account: privateKeyToAccount('0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80') }); // anvil dev account #0 (public)
const STATE = 'state-evm2.json';
const st: any = existsSync(STATE) ? JSON.parse(readFileSync(STATE, 'utf8')) : {};
const save = () => writeFileSync(STATE, JSON.stringify(st, (_, v) => (typeof v === 'bigint' ? v.toString() : v), 1));
const results: any[] = st.results ?? (st.results = []);
function record(name: string, expectOk: boolean, ok: boolean, detail: string) {
  const pass = ok === expectOk; results.push({ name, pass, ok, detail }); save();
  console.log(`${pass ? 'PASS' : 'FAIL'} ${name} | ${ok ? `ok ${detail}` : `refused: ${detail}`}`);
  return ok;
}
const ROLES_STATUS: Record<number, string> = { 7: 'ParameterNotAllowed', 17: 'AllowanceExceeded' };
const reason = (e: any) => { const s = String(e?.shortMessage ?? e?.message ?? e).replace(/\s+/g, ' ');
  const m = s.replace(/\s/g, '').match(/0xd0a9bf58:?([0-9a-f]{64})/i); if (m) return `Roles ConditionViolation(${ROLES_STATUS[parseInt(m[1]!, 16)] ?? parseInt(m[1]!, 16)})`;
  return s.match(/(reverted with reason: [^.]*|GS\d{3}|reverted with the following reason:[^.]*)/)?.[0] ?? s.slice(0, 140); };
async function send(name: string, expectOk: boolean, to: Address, data: Hex) {
  let ok = true, d = '';
  try { await pub.call({ account: relayer.account, to, data }); const h = await relayer.sendTransaction({ to, data, gas: 5_000_000n }); const r = await pub.waitForTransactionReceipt({ hash: h }); ok = r.status === 'success'; d = `gas ${r.gasUsed} ${h.slice(0, 18)}…`; }
  catch (e: any) { ok = false; d = reason(e); }
  return record(name, expectOk, ok, d);
}
async function deploy(a: any, args: any[] = []) { const h = await relayer.deployContract({ abi: a.abi, bytecode: a.bytecode.object, args }); return (await pub.waitForTransactionReceipt({ hash: h })).contractAddress!; }
const art = (dir: string, n: string, f = n) => JSON.parse(readFileSync(`${dir}/out/${f}.sol/${n}.json`, 'utf8'));
const EM = '/home/ubuntu/work/evm-matrix';
const VER = art('/home/ubuntu/work/ed-evm/v06', 'Ed25519Verifier'), OWN = art(EM, 'Ed25519Owner', 'Ed25519Auth'), SME = art(EM, 'SessionMemberEd', 'Ed25519Auth'), SM = art(EM, 'SessionMember'), TK = art(EM, 'Token');

// ── Wallets (same keys as the matrix: Freighter = key B, Phantom = phantom-test) ─────────────
const FREIGHTER_FILE = '/home/ubuntu/work/near-wallet-spike/secrets/freighter-b.json';
const fr = StellarKeypair.fromSecret(JSON.parse(readFileSync(FREIGHTER_FILE, 'utf8')).secret);
const phSecret = bs58.decode(JSON.parse(readFileSync('/home/ubuntu/work/phantom-spike/secrets/phantom-test.json', 'utf8')).secret);
const ph = nacl.sign.keyPair.fromSecretKey(phSecret.length === 64 ? phSecret : nacl.sign.keyPair.fromSeed(phSecret).secretKey);
function freighterSign(text: string): Hex { // Freighter's signMessage code path (SEP-53)
  const d = mkdtempSync(`${tmpdir()}/fsign-`); writeFileSync(`${d}/m.txt`, text);
  try { return toHex(Buffer.from(execFileSync('bun', ['freighter-sign.ts', FREIGHTER_FILE, `${d}/m.txt`], { cwd: '/home/ubuntu/work/near-session-spike', encoding: 'utf8' }), 'base64')); } finally { rmSync(d, { recursive: true }); }
}
const { realPhantomSign } = await import('/home/ubuntu/work/phantom-spike/bridge-sign.ts');
const phantomSign = (text: string): Hex => toHex(process.env.REAL_PHANTOM ? realPhantomSign(text) : nacl.sign.detached(Buffer.from(text, 'utf8'), ph.secretKey)); // Phantom signMessage
const FR_PK = toHex(fr.rawPublicKey()), PH_PK = toHex(ph.publicKey);

const tokenAbi = parseAbi(['function mint(address,uint256)', 'function transfer(address,uint256) returns (bool)', 'function balanceOf(address) view returns (uint256)']);
const safeAbi = parseAbi(['function nonce() view returns (uint256)', 'function getOwners() view returns (address[])', 'function getThreshold() view returns (uint256)']);
const pk = (k: string) => getAddress(st[k] ?? (st[k] = privateKeyToAccount(generatePrivateKey()).address));
const VENUE = pk('venue'), OTHER = pk('other'), DEST = pk('dest');
const E18 = 10n ** 18n;
const tokenTransfer = (to: Address, n: bigint) => ({ to: st.token as Address, value: 0n, operation: 0 as const, data: encodeFunctionData({ abi: tokenAbi, functionName: 'transfer', args: [to, n * E18] }) });
const bal = (a: Address) => pub.readContract({ address: st.token, abi: tokenAbi, functionName: 'balanceOf', args: [a] });

type Seat = { name: string; owner: Address; sign: (safeTxHash: Hex) => Promise<{ static: Hex; dynamic?: Hex }> };
const mmSeat: Seat = { name: 'MetaMask', owner: metamask.address, sign: async (h) => ({ static: await metamask.sign({ hash: h }) }) };
const edSeat = (name: string, owner: () => Address, signText: (t: string) => Hex): Seat => ({ name, get owner() { return owner(); }, sign: async (h) => {
  const text = await pub.readContract({ address: owner(), abi: OWN.abi, functionName: 'approvalText', args: [st.safe, h] }) as string;
  return { static: '0x', dynamic: signText(text) }; } }) as Seat;
const frSeat = edSeat('Freighter', () => getAddress(st.frOwner), freighterSign), phSeat = edSeat('Phantom', () => getAddress(st.phOwner), phantomSign);

/** Safe 1.4.1 signatures: 65-byte static parts sorted by owner; contract owners (v=0) point at a dynamic tail. */
async function safeTx(name: string, expectOk: boolean, call: { to: Address; value: bigint; data: Hex; operation: 0 | 1 }, seats: Seat[], tamper?: (s: Seat) => Hex | undefined) {
  const nonce = await pub.readContract({ address: st.safe, abi: safeAbi, functionName: 'nonce' });
  const tx = { ...call, safeTxGas: 0n, baseGas: 0n, gasPrice: 0n, gasToken: '0x0000000000000000000000000000000000000000' as Address, refundReceiver: '0x0000000000000000000000000000000000000000' as Address, nonce };
  const hash = ob.hashSafeTransaction(84532, st.safe, tx);
  const parts = [] as { owner: Address; sig: { static: Hex; dynamic?: Hex } }[];
  for (const s of seats) { const sig = await s.sign(hash); const t = tamper?.(s); parts.push({ owner: s.owner, sig: t ? { ...sig, dynamic: t } : sig }); }
  parts.sort((a, b) => (BigInt(a.owner) < BigInt(b.owner) ? -1 : 1));
  let tail: Hex[] = []; let offset = 65 * parts.length;
  const statics = parts.map((p) => {
    if (!p.sig.dynamic) return p.sig.static;
    const len = (p.sig.dynamic.length - 2) / 2;
    const st_ = concat([pad(p.owner, { size: 32 }), pad(numberToHex(offset), { size: 32 }), '0x00']);
    tail.push(concat([pad(numberToHex(len), { size: 32 }), p.sig.dynamic])); offset += 32 + len; return st_;
  });
  return send(name, expectOk, st.safe, ob.encodeExecTransaction(tx, concat([...statics, ...tail])));
}

type Session = { member: Address; key: ReturnType<typeof privateKeyToAccount>; until: bigint; grant: Hex };
async function openEd(member: Address, signText: (t: string) => Hex, seconds = 3600n): Promise<Session> {
  const key = privateKeyToAccount(generatePrivateKey()); const until = (await pub.getBlock()).timestamp + seconds;
  const text = await pub.readContract({ address: member, abi: SME.abi, functionName: 'grantText', args: [key.address, until] }) as string;
  return { member, key, until, grant: signText(text) };
}
async function move(name: string, expectOk: boolean, s: Session, call: { to: Address; value: bigint; data: Hex; operation: 0 | 1 }, o: { until?: bigint } = {}) {
  const digest = await pub.readContract({ address: s.member, abi: SME.abi, functionName: 'callDigest', args: [s.key.address, call.to, call.value, call.data, call.operation, st.roleKey] }) as Hex;
  return send(name, expectOk, s.member, encodeFunctionData({ abi: SME.abi, functionName: 'exec', args: [call.to, call.value, call.data, call.operation, st.roleKey, s.key.address, o.until ?? s.until, s.grant, await s.key.sign({ hash: digest })] }));
}

const part = process.argv[2];
if (part === 'setup') {
  st.verifier = await deploy(VER);
  // gas of one ed25519 verification (Phantom signature over a 120-byte text)
  const t = 'x'.repeat(120); const sig = nacl.sign.detached(Buffer.from(t), ph.secretKey);
  const g = await pub.estimateGas({ to: st.verifier, data: encodeFunctionData({ abi: VER.abi, functionName: 'verify', args: [PH_PK, toHex(sig.slice(0, 32)), toHex(sig.slice(32)), toHex(Buffer.from(t))] }) });
  const ok = await pub.readContract({ address: st.verifier, abi: VER.abi, functionName: 'verify', args: [PH_PK, toHex(sig.slice(0, 32)), toHex(sig.slice(32)), toHex(Buffer.from(t))] });
  const bad = await pub.readContract({ address: st.verifier, abi: VER.abi, functionName: 'verify', args: [FR_PK, toHex(sig.slice(0, 32)), toHex(sig.slice(32)), toHex(Buffer.from(t))] });
  record('E0. ed25519 verifier: genuine signature true, wrong key false', true, ok === true && bad === false, `estimateGas ${g} per verification`);
  st.token = await deploy(TK);
  st.frOwner = await deploy(OWN, [1, FR_PK, st.verifier]); st.phOwner = await deploy(OWN, [2, PH_PK, st.verifier]);
  const proxyCreationCode = await pub.readContract({ address: CONTRACTS.safeProxyFactory, abi: parseAbi(['function proxyCreationCode() view returns (bytes)']), functionName: 'proxyCreationCode' }) as Hex;
  const initializer = ob.encodeSafeInitializer([metamask.address], 1n, CONTRACTS.compatibilityFallbackHandler);
  const salt = BigInt(keccak256(toHex(`matrix2-${Date.now()}`)));
  st.safe = ob.predictSafeAddress(proxyCreationCode, initializer, salt); st.roles = ob.predictPrimeRolesAddress(st.safe);
  st.smMM = await deploy(SM, [metamask.address, st.roles]);
  st.smFR = await deploy(SME, [1, FR_PK, st.verifier, st.roles]); st.smPH = await deploy(SME, [2, PH_PK, st.verifier, st.roles]);
  const doc = { spendingLimit: 1 as const, token: st.token, recipients: [VENUE], amount: (100n * E18).toString(), period: '86400' };
  const rule = pol.buildRuleInstall({ doc, docText: JSON.stringify(doc), name: 'movers', ctx: { prime: st.safe, primeRoles: st.roles }, proxyCreationCode, wallets: [st.smMM, st.smFR, st.smPH], threshold: 1 });
  st.roleKey = rule.roleKey; save();
  const c = ob.encodeCreateSafe(initializer, salt);
  await send('E1. create Safe (MetaMask first, PrimeX flow)', true, c.to, c.data);
  const init = ob.buildSafeInitializationTransaction(st.safe, [st.frOwner, st.phOwner], 2n, rule.calls);
  await send('E2. nonce 0: seats MetaMask, Ed25519Owner(Freighter), Ed25519Owner(Phantom); threshold 2; movers rule — no NEAR', true, st.safe,
    ob.encodeExecTransaction(init, await metamask.sign({ hash: ob.hashSafeTransaction(84532, st.safe, init) })));
  const owners = await pub.readContract({ address: st.safe, abi: safeAbi, functionName: 'getOwners' }) as Address[];
  record('E3. owners are MetaMask + the two Ed25519Owner contracts, threshold 2', true, owners.length === 3 && owners.includes(getAddress(st.frOwner)) && owners.includes(getAddress(st.phOwner)), owners.join(','));
  await send('E4. mint 1000 tokens to the Safe', true, st.token, encodeFunctionData({ abi: tokenAbi, functionName: 'mint', args: [st.safe, 1000n * E18] }));
  save();
}
if (part === 'seats') {
  const t = tokenTransfer(DEST, 1n);
  await safeTx('F1. Freighter alone (contract signature)', false, t, [frSeat]);
  await safeTx('F2. Phantom alone', false, t, [phSeat]);
  const b = await bal(DEST);
  await safeTx('F3. Freighter + Phantom (no MetaMask, no NEAR)', true, t, [frSeat, phSeat]);
  await safeTx('F4. MetaMask + Freighter', true, t, [mmSeat, frSeat]);
  await safeTx('F5. Phantom + MetaMask', true, t, [phSeat, mmSeat]);
  record('F6. DEST received exactly 3 tokens', true, (await bal(DEST)) - b === 3n * E18, `${((await bal(DEST)) - b) / E18}`);
  // wrong-wallet / wrong-format / wrong-tx signatures
  await safeTx('F7. Freighter key signs the approval text WITHOUT the SEP-53 prefix + MetaMask', false, t, [mmSeat, { ...frSeat, owner: frSeat.owner, sign: async (h) => ({ static: '0x', dynamic: toHex(fr.sign(Buffer.from(await pub.readContract({ address: st.frOwner, abi: OWN.abi, functionName: 'approvalText', args: [st.safe, h] }) as string, 'utf8'))) }) }]);
  await safeTx('F8. Phantom seat signed by the Freighter key + MetaMask', false, t, [mmSeat, { ...phSeat, owner: phSeat.owner, sign: async (h) => ({ static: '0x', dynamic: freighterSign(await pub.readContract({ address: st.phOwner, abi: OWN.abi, functionName: 'approvalText', args: [st.safe, h] }) as string) }) }]);
  const stale = await pub.readContract({ address: st.phOwner, abi: OWN.abi, functionName: 'approvalText', args: [st.safe, '0x' + '11'.repeat(32) as Hex] }) as string;
  await safeTx('F9. Phantom approval of another Safe tx hash + MetaMask', false, t, [mmSeat, { ...phSeat, owner: phSeat.owner, sign: async () => ({ static: '0x', dynamic: phantomSign(stale) }) }]);
}
if (part === 'sessions') {
  for (const [name, member, sign] of [['Freighter', st.smFR, freighterSign], ['Phantom', st.smPH, phantomSign]] as const) {
    const s = await openEd(member, sign);
    const b = await bal(VENUE);
    await move(`G-${name}1. one-signature session: 10 tokens to VENUE`, true, s, tokenTransfer(VENUE, 10n));
    record(`G-${name}1b. VENUE received 10`, true, (await bal(VENUE)) - b === 10n * E18, `${((await bal(VENUE)) - b) / E18}`);
    await move(`G-${name}2. 1 token elsewhere`, false, s, tokenTransfer(OTHER, 1n));
    await move(`G-${name}3. stretched validUntil`, false, s, tokenTransfer(VENUE, 1n), { until: s.until + 60n });
    const r = await openEd(member, sign);
    const revoke = sign(await pub.readContract({ address: member, abi: SME.abi, functionName: 'grantText', args: [r.key.address, 0n] }) as string);
    await send(`G-${name}4. ${name} revokes a live session (one signature, no NEAR)`, true, member, encodeFunctionData({ abi: SME.abi, functionName: 'revoke', args: [r.key.address, revoke] }));
    await move(`G-${name}5. that session`, false, r, tokenTransfer(VENUE, 1n));
  }
  const cross = await openEd(st.smPH, freighterSign);
  await move('G6. Phantom member with a Freighter-signed grant', false, cross, tokenTransfer(VENUE, 1n));
  const wrongFmt = await openEd(st.smFR, (t) => toHex(fr.sign(Buffer.from(t, 'utf8'))));
  await move('G7. Freighter member with the Freighter key signing the grant WITHOUT the SEP-53 prefix', false, wrongFmt, tokenTransfer(VENUE, 1n));
}
if (part === 'realph') {
  const b = await bal(DEST);
  await safeTx('RP6. real Phantom approval text (Ed25519Owner) + MetaMask: Safe transfer', true, tokenTransfer(DEST, 1n), [phSeat, mmSeat]);
  record('RP6b. DEST received exactly 1 token', true, (await bal(DEST)) - b === E18, `${((await bal(DEST)) - b) / E18}`);
  const s = await openEd(st.smPH, phantomSign);
  await move('RP7. real Phantom grant (SessionMemberEd) -> session: 5 tokens to VENUE', true, s, tokenTransfer(VENUE, 5n));
}
if (part === 'summary') { const p = results.filter((r) => r.pass).length; console.log(`${p}/${results.length} passed`); for (const r of results.filter((r) => !r.pass)) console.log('FAIL', r.name, r.detail); }
