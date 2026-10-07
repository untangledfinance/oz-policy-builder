// PrimeKey: the one EVM contract. A Prime Account (Safe 1.4.1 + Zodiac Roles v2.1.1, PrimeX flow) on an anvil
// fork of Base Sepolia with all three wallets as seats AND session owners, no NEAR:
//   seats:    MetaMask EOA, PrimeKey(Freighter, SEP-53), PrimeKey(Phantom, signMessage text); threshold 2
//   sessions: PrimeKey(MetaMask personal_sign), PrimeKey(Freighter), PrimeKey(Phantom) are the Roles members;
//             the wallet signs one grant text, then only the session key signs each move.
import { createPublicClient, createWalletClient, http, encodeFunctionData, parseAbi, getAddress, concat, pad, toHex, numberToHex, keccak256, encodeAbiParameters, type Address, type Hex } from 'viem';
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts';
import { baseSepolia } from 'viem/chains';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import nacl from 'tweetnacl';
import bs58 from 'bs58';
const { Keypair: StellarKeypair } = await import('/home/ubuntu/work/near-session-spike/node_modules/@stellar/stellar-sdk/lib/index.js');
import { metamask } from './keys.ts';
const OCT = '/home/ubuntu/git/github.com/untangledfinance/octopos/apps/evm-web/src/core';
const ob = await import(`${OCT}/onboarding.ts`);
const pol = await import(`${OCT}/evm-policy.ts`);
const { CONTRACTS } = await import(`${OCT}/contracts.ts`);

const RPC = 'http://127.0.0.1:8547';
const pub = createPublicClient({ chain: baseSepolia, transport: http(RPC) });
const relayer = createWalletClient({ chain: baseSepolia, transport: http(RPC), account: privateKeyToAccount('0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80') }); // anvil dev #0 (public)
const rpc = (method: string, params: unknown[]) => fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
const st: any = {}; const results: any[] = [];
const save = () => writeFileSync('state-pk.json', JSON.stringify({ ...st, results }, (_, v) => (typeof v === 'bigint' ? v.toString() : v), 1));
function record(name: string, expectOk: boolean, ok: boolean, detail: string) {
  const pass = ok === expectOk; results.push({ name, pass, ok, detail }); save();
  console.log(`${pass ? 'PASS' : 'FAIL'} ${name} | ${ok ? `ok ${detail}` : `refused: ${detail}`}`);
  return ok;
}
const ROLES_STATUS: Record<number, string> = { 7: 'ParameterNotAllowed', 17: 'AllowanceExceeded' };
const reason = (e: any) => { const s = String(e?.shortMessage ?? e?.message ?? e).replace(/\s+/g, ' ');
  const m = s.replace(/\s/g, '').match(/0xd0a9bf58:?([0-9a-f]{64})/i); if (m) return `Roles ConditionViolation(${ROLES_STATUS[parseInt(m[1]!, 16)] ?? parseInt(m[1]!, 16)})`;
  return s.match(/(reverted with reason: [^.]*|GS\d{3}|reverted with the following reason:[^.]*)/)?.[0] ?? s.slice(0, 140); };
const gasOf: Record<string, bigint> = {};
async function send(name: string, expectOk: boolean, to: Address, data: Hex, tag?: string) {
  let ok = true, d = '';
  try { await pub.call({ account: relayer.account, to, data }); const h = await relayer.sendTransaction({ to, data, gas: 5_000_000n }); const r = await pub.waitForTransactionReceipt({ hash: h }); ok = r.status === 'success'; d = `gas ${r.gasUsed}`; if (tag) gasOf[tag] = r.gasUsed; }
  catch (e: any) { ok = false; d = reason(e); }
  return record(name, expectOk, ok, d);
}
async function tryDeploy(a: any, args: any[]): Promise<Address | string> {
  try { const h = await relayer.deployContract({ abi: a.abi, bytecode: a.bytecode.object, args }); const r = await pub.waitForTransactionReceipt({ hash: h }); return r.status === 'success' ? r.contractAddress! : 'reverted'; }
  catch (e: any) { return reason(e); }
}
const deploy = async (a: any, args: any[] = []) => { const x = await tryDeploy(a, args); if (!x.startsWith('0x')) throw new Error(x); return getAddress(x); };
const art = (dir: string, n: string, f = n) => JSON.parse(readFileSync(`${dir}/out/${f}.sol/${n}.json`, 'utf8'));
const PE = '/home/ubuntu/work/prime-evm';
const PK = art(PE, 'PrimeKey'), ED = art(PE, 'EdHarness'), TK = art('/home/ubuntu/work/evm-matrix', 'Token');

// ── Wallets (the same keys as the other matrices) ─────────────────────────────────────────────
const FREIGHTER_FILE = '/home/ubuntu/work/near-wallet-spike/secrets/freighter-b.json';
const fr = StellarKeypair.fromSecret(JSON.parse(readFileSync(FREIGHTER_FILE, 'utf8')).secret);
const phSecret = bs58.decode(JSON.parse(readFileSync('/home/ubuntu/work/phantom-spike/secrets/phantom-test.json', 'utf8')).secret);
const ph = nacl.sign.keyPair.fromSecretKey(phSecret.length === 64 ? phSecret : nacl.sign.keyPair.fromSeed(phSecret).secretKey);
function freighterSign(text: string): Hex { // Freighter's signMessage code path (SEP-53)
  const d = mkdtempSync(`${tmpdir()}/fsign-`); writeFileSync(`${d}/m.txt`, text);
  try { return toHex(Buffer.from(execFileSync('bun', ['freighter-sign.ts', FREIGHTER_FILE, `${d}/m.txt`], { cwd: '/home/ubuntu/work/near-session-spike', encoding: 'utf8' }), 'base64')); } finally { rmSync(d, { recursive: true }); }
}
const phantomSign = (text: string): Hex => { if (process.env.REAL_PHANTOM) { const { realPhantomSign } = require('/home/ubuntu/work/phantom-spike/bridge-sign.ts'); return toHex(realPhantomSign(text)); } return toHex(nacl.sign.detached(Buffer.from(text, 'utf8'), ph.secretKey)); };
const metamaskSign = (text: string) => metamask.signMessage({ message: text }); // personal_sign
const FR_PK = toHex(fr.rawPublicKey()), PH_PK = toHex(ph.publicKey);
type Signer = (t: string) => Hex | Promise<Hex>;

const tokenAbi = parseAbi(['function mint(address,uint256)', 'function transfer(address,uint256) returns (bool)', 'function balanceOf(address) view returns (uint256)']);
const safeAbi = parseAbi(['function nonce() view returns (uint256)', 'function getOwners() view returns (address[])', 'function getThreshold() view returns (uint256)']);
const fresh = () => getAddress(privateKeyToAccount(generatePrivateKey()).address);
const VENUE = fresh(), OTHER = fresh(), DEST = fresh();
const E18 = 10n ** 18n;
const tokenTransfer = (to: Address, n: bigint) => ({ to: st.token as Address, value: 0n, operation: 0 as const, data: encodeFunctionData({ abi: tokenAbi, functionName: 'transfer', args: [to, n * E18] }) });
const bal = (a: Address) => pub.readContract({ address: st.token, abi: tokenAbi, functionName: 'balanceOf', args: [a] });
const now = async () => (await pub.getBlock()).timestamp;
const text = (pk: Address, key: Address, end: bigint) => pub.readContract({ address: pk, abi: PK.abi, functionName: 'grantText', args: [key, end] }) as Promise<string>;
const approvalText = (safe: Address, h: Hex) => `Prime approval\nsafe: ${safe.toLowerCase()}\nsafe tx: ${h}`;

// ── Safe seats ────────────────────────────────────────────────────────────────────────────────
type Seat = { name: string; owner: () => Address; sign: (h: Hex) => Promise<{ static: Hex; dynamic?: Hex }> };
const mmSeat: Seat = { name: 'MetaMask', owner: () => metamask.address, sign: async (h) => ({ static: await metamask.sign({ hash: h }) }) };
const keySeat = (name: string, owner: () => Address, sign: Signer, safe = () => st.safe as Address): Seat => ({ name, owner, sign: async (h) => ({ static: '0x', dynamic: await sign(approvalText(safe(), h)) }) });
const frSeat = keySeat('Freighter', () => st.pkFR, freighterSign), phSeat = keySeat('Phantom', () => st.pkPH, phantomSign);
async function safeTx(name: string, expectOk: boolean, call: { to: Address; value: bigint; data: Hex; operation: 0 | 1 }, seats: Seat[]) {
  const nonce = await pub.readContract({ address: st.safe, abi: safeAbi, functionName: 'nonce' });
  const tx = { ...call, safeTxGas: 0n, baseGas: 0n, gasPrice: 0n, gasToken: '0x0000000000000000000000000000000000000000' as Address, refundReceiver: '0x0000000000000000000000000000000000000000' as Address, nonce };
  const hash = ob.hashSafeTransaction(84532, st.safe, tx);
  const parts = [] as { owner: Address; sig: { static: Hex; dynamic?: Hex } }[];
  for (const s of seats) parts.push({ owner: getAddress(s.owner()), sig: await s.sign(hash) });
  parts.sort((a, b) => (BigInt(a.owner) < BigInt(b.owner) ? -1 : 1));
  const tail: Hex[] = []; let offset = 65 * parts.length;
  const statics = parts.map((p) => {
    if (!p.sig.dynamic) return p.sig.static;
    const len = (p.sig.dynamic.length - 2) / 2;
    tail.push(concat([pad(numberToHex(len), { size: 32 }), p.sig.dynamic]));
    const s_ = concat([pad(p.owner, { size: 32 }), pad(numberToHex(offset), { size: 32 }), '0x00']); offset += 32 + len; return s_;
  });
  return send(name, expectOk, st.safe, ob.encodeExecTransaction(tx, concat([...statics, ...tail])), name.startsWith('S3') ? 'seatApproval' : undefined);
}

// ── Sessions ──────────────────────────────────────────────────────────────────────────────────
type Session = { pk: Address; key: ReturnType<typeof privateKeyToAccount>; end: bigint };
async function grant(name: string, expectOk: boolean, pk: Address, sign: Signer, o: { seconds?: bigint; end?: bigint; signedEnd?: bigint; key?: ReturnType<typeof privateKeyToAccount>; tag?: string } = {}): Promise<Session> {
  const key = o.key ?? privateKeyToAccount(generatePrivateKey()); const end = o.end ?? (await now()) + (o.seconds ?? 3600n);
  const sig = await sign(await text(pk, key.address, o.signedEnd ?? end));
  await send(name, expectOk, pk, encodeFunctionData({ abi: PK.abi, functionName: 'grant', args: [key.address, end, sig] }), o.tag);
  return { pk, key, end };
}
async function move(name: string, expectOk: boolean, s: Session, call: { to: Address; value: bigint; data: Hex; operation: 0 | 1 }, o: { signer?: ReturnType<typeof privateKeyToAccount>; nonce?: bigint; replay?: Hex; tag?: string } = {}) {
  const n = o.nonce ?? (await pub.readContract({ address: s.pk, abi: PK.abi, functionName: 'nonce', args: [s.key.address] }) as bigint);
  const h = keccak256(encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'address' }, { type: 'uint256' }, { type: 'bytes32' }, { type: 'uint8' }, { type: 'bytes32' }],
    [s.pk, 84532n, n, call.to, call.value, keccak256(call.data), call.operation, st.roleKey]));
  const sig = o.replay ?? await (o.signer ?? s.key).sign({ hash: h });
  await send(name, expectOk, s.pk, encodeFunctionData({ abi: PK.abi, functionName: 'exec', args: [call.to, call.value, call.data, call.operation, st.roleKey, s.key.address, sig] }), o.tag);
  return sig;
}

// ── A. The ported ed25519 library (0.8, unchecked) ────────────────────────────────────────────
{
  const ed = await deploy(ED);
  const verify = (k: Hex | Uint8Array, sig: Uint8Array, m: Uint8Array) => pub.readContract({ address: ed, abi: ED.abi, functionName: 'verify', args: [typeof k === 'string' ? k : toHex(k), toHex(sig.slice(0, 32)), toHex(sig.slice(32, 64)), toHex(m)] }) as Promise<boolean>;
  const unhex = (s: string) => Uint8Array.from(Buffer.from(s, 'hex'));
  const rfc = [
    ['d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a', '', 'e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e065224901555fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b'],
    ['3d4017c3e843895a92b70aa74d1b7ebc9c982ccf2ec4968cc0cd55f12af4660c', '72', '92a009a9f0d4cab8720e820b5f642540a2b27b5416503f8fb3762223ebdb69da085ac1e43e15996e458f3613d0f11d8c387b2eaeb4302aeeb00d291612bb0c00'],
    ['fc51cd8e6218a1a38da47ed00230f0580816ed13ba3303ac5deb911548908025', 'af82', '6291d657deec24024827e69c3abe01a30ce548a284743a445e3680d7db5ac3ac18ff9b538d16f290ae67f760984dc6594a7c15e9716ed28dc027beceea1ec40a'],
  ];
  for (const [i, [k, m, s]] of rfc.entries()) record(`A${i + 1}. RFC 8032 TEST ${i + 1}`, true, await verify(`0x${k}`, unhex(s!), unhex(m!)), '');
  let ok = 0, n = 0;
  for (const len of [0, 1, 31, 32, 63, 64, 111, 112, 127, 128, 129, 139, 148, 157, 200, 260, 300, 500, 777, 1024]) for (let j = 0; j < 2; j++) {
    const kp = nacl.sign.keyPair(); const m = nacl.randomBytes(len); n++; if (await verify(kp.publicKey, nacl.sign.detached(m, kp.secretKey), m)) ok++;
  }
  record(`A4. ${n} random key/message pairs (0..1024 bytes) accepted`, true, ok === n, `${ok}/${n}`);
  const kp = nacl.sign.keyPair(), m = new TextEncoder().encode('Prime session\ncontract: 0x00'), sig = nacl.sign.detached(m, kp.secretKey);
  const flip = (a: Uint8Array, i: number) => { const b = a.slice(); b[i]! ^= 1; return b; };
  record('A5. message bit flipped', false, await verify(kp.publicKey, sig, flip(m, 5)), '');
  record('A6. R bit flipped', false, await verify(kp.publicKey, flip(sig, 3), m), '');
  record('A7. S bit flipped', false, await verify(kp.publicKey, flip(sig, 40), m), '');
  record('A8. another key', false, await verify(nacl.sign.keyPair().publicKey, sig, m), '');
  const L = 2n ** 252n + 27742317777372353535851937790883648493n;
  const s2 = BigInt('0x' + Buffer.from(sig.slice(32)).reverse().toString('hex')) + L;
  record('A9. malleated S + L', false, await verify(kp.publicKey, new Uint8Array([...sig.slice(0, 32), ...Buffer.from(s2.toString(16).padStart(64, '0'), 'hex').reverse()]), m), '');
  record('A10. all-zero signature', false, await verify(kp.publicKey, new Uint8Array(64), m), '');
  const g = await pub.estimateGas({ to: ed, data: encodeFunctionData({ abi: ED.abi, functionName: 'verify', args: [toHex(kp.publicKey), toHex(sig.slice(0, 32)), toHex(sig.slice(32)), toHex(new Uint8Array(160))] }) });
  console.log(`   one ed25519 verification of 160 bytes: ~${g} gas`);
}

// ── B. Constructor refuses owners that would make signatures forgeable ───────────────────────
{
  const le = (y: bigint, sign = 0) => { const b = Buffer.from(y.toString(16).padStart(64, '0'), 'hex').reverse(); if (sign) b[31]! |= 0x80; return toHex(b); };
  const P = 2n ** 255n - 19n, Y8 = 0x7a03ac9277fdc74ec6cc392cfa53202a0f67100d760b3cba4fd84d3d706a17c7n;
  const roles = fresh();
  const cases: [string, number, Hex, boolean][] = [
    ['B1. MetaMask owner = zero address', 0, pad('0x00', { size: 32 }), false],
    ['B2. MetaMask owner wider than 20 bytes', 0, `0x01${'00'.repeat(11)}${metamask.address.slice(2)}` as Hex, false],
    ['B3. kind 3', 3, PH_PK, false],
    ...([['identity y=1', le(1n)], ['order 2 y=p-1', le(P - 1n)], ['order 4 y=0', le(0n)], ['order 4 y=0 sign bit', le(0n, 1)], ['order 8 y8', le(Y8)], ['order 8 y8 sign bit', le(Y8, 1)], ['order 8 p-y8', le(P - Y8)], ['order 8 p-y8 sign bit', le(P - Y8, 1)], ['non-canonical y=p+1', le(P + 1n)]] as [string, Hex][])
      .flatMap(([n, k], i) => [[`B${4 + 2 * i}. Freighter small-order/non-canonical key: ${n}`, 1, k, false], [`B${5 + 2 * i}. Phantom small-order/non-canonical key: ${n}`, 2, k, false]] as [string, number, Hex, boolean][]),
    ['B22. real MetaMask / Freighter / Phantom owners', -1, '0x', true],
  ];
  for (const [name, kind, owner, expectOk] of cases) {
    if (kind === -1) { const r: string[] = []; for (const [k, o] of [[0, pad(metamask.address, { size: 32 })], [1, FR_PK], [2, PH_PK]]) r.push(await tryDeploy(PK, [k, o, roles])); record(name, true, r.every((x) => x.startsWith('0x')), r.join(' ')); continue; }
    const r = await tryDeploy(PK, [kind, owner, roles]); record(name, expectOk, r.startsWith('0x'), r);
  }
}

// ── C. The Prime Account: three seats, three session owners ──────────────────────────────────
st.token = await deploy(TK);
const proxyCreationCode = await pub.readContract({ address: CONTRACTS.safeProxyFactory, abi: parseAbi(['function proxyCreationCode() view returns (bytes)']), functionName: 'proxyCreationCode' }) as Hex;
const initializer = ob.encodeSafeInitializer([metamask.address], 1n, CONTRACTS.compatibilityFallbackHandler);
const salt = BigInt(keccak256(toHex(`primekey-${Date.now()}`)));
st.safe = ob.predictSafeAddress(proxyCreationCode, initializer, salt); st.roles = ob.predictPrimeRolesAddress(st.safe);
st.pkMM = await deploy(PK, [0, pad(metamask.address, { size: 32 }), st.roles]);
st.pkFR = await deploy(PK, [1, FR_PK, st.roles]); st.pkPH = await deploy(PK, [2, PH_PK, st.roles]);
const doc = { spendingLimit: 1 as const, token: st.token, recipients: [VENUE], amount: (100n * E18).toString(), period: '86400' };
const rule = pol.buildRuleInstall({ doc, docText: JSON.stringify(doc), name: 'movers', ctx: { prime: st.safe, primeRoles: st.roles }, proxyCreationCode, wallets: [st.pkMM, st.pkFR, st.pkPH], threshold: 1 });
st.roleKey = rule.roleKey; save();
const c = ob.encodeCreateSafe(initializer, salt);
await send('C1. create Safe (MetaMask first, PrimeX flow)', true, c.to, c.data);
const init = ob.buildSafeInitializationTransaction(st.safe, [st.pkFR, st.pkPH], 2n, rule.calls);
await send('C2. seats MetaMask + PrimeKey(Freighter) + PrimeKey(Phantom), threshold 2, movers rule for the three PrimeKeys', true, st.safe,
  ob.encodeExecTransaction(init, await metamask.sign({ hash: ob.hashSafeTransaction(84532, st.safe, init) })));
const owners = await pub.readContract({ address: st.safe, abi: safeAbi, functionName: 'getOwners' }) as Address[];
const thr = await pub.readContract({ address: st.safe, abi: safeAbi, functionName: 'getThreshold' });
record('C3. owners and threshold', true, owners.length === 3 && owners.includes(st.pkFR) && owners.includes(st.pkPH) && thr === 2n, `${owners.length} owners, threshold ${thr}`);
await send('C4. mint 1000 tokens to the Safe', true, st.token, encodeFunctionData({ abi: tokenAbi, functionName: 'mint', args: [st.safe, 1000n * E18] }));

// ── S. Seats (2-of-3) ─────────────────────────────────────────────────────────────────────────
{
  const t = tokenTransfer(DEST, 1n);
  await safeTx('S1. Freighter alone', false, t, [frSeat]);
  await safeTx('S2. Phantom alone', false, t, [phSeat]);
  const b = await bal(DEST);
  await safeTx('S3. Freighter + Phantom', true, t, [frSeat, phSeat]);
  await safeTx('S4. MetaMask + Freighter', true, t, [mmSeat, frSeat]);
  await safeTx('S5. Phantom + MetaMask', true, t, [phSeat, mmSeat]);
  record('S6. DEST received exactly 3', true, (await bal(DEST)) - b === 3n * E18, `${((await bal(DEST)) - b) / E18}`);
  await safeTx('S7. Freighter key signs WITHOUT the SEP-53 prefix (+ MetaMask)', false, t, [mmSeat, keySeat('Freighter', () => st.pkFR, (x) => toHex(fr.sign(Buffer.from(x, 'utf8'))))]);
  await safeTx('S8. Phantom seat signed by the Freighter key (+ MetaMask)', false, t, [mmSeat, keySeat('Phantom', () => st.pkPH, freighterSign)]);
  await safeTx('S9. Phantom approval of another Safe tx (+ MetaMask)', false, t, [mmSeat, { ...phSeat, sign: async () => ({ static: '0x', dynamic: phantomSign(approvalText(st.safe, `0x${'11'.repeat(32)}`)) }) }]);
  await safeTx('S10. Phantom approval naming another Safe (+ MetaMask)', false, t, [mmSeat, keySeat('Phantom', () => st.pkPH, phantomSign, () => DEST)]);
  await safeTx('S11. Phantom seat with a MetaMask personal_sign of the text (+ MetaMask)', false, t, [mmSeat, keySeat('Phantom', () => st.pkPH, (x) => metamaskSign(x) as any)]);
}

// ── G. Sessions: one wallet signature, then session-key moves inside the Roles rule ──────────
for (const [w, pk, sign] of [['MetaMask', st.pkMM, metamaskSign], ['Freighter', st.pkFR, freighterSign], ['Phantom', st.pkPH, phantomSign]] as [string, Address, Signer][]) {
  const s = await grant(`G-${w}1. ${w} grants a 1-hour session (one signature)`, true, pk, sign, { tag: `grant${w}` });
  const b = await bal(VENUE);
  await move(`G-${w}2. move 1: 10 tokens to VENUE`, true, s, tokenTransfer(VENUE, 10n), { tag: `move1${w}` });
  const sig2 = await move(`G-${w}3. move 2: 5 tokens to VENUE`, true, s, tokenTransfer(VENUE, 5n), { tag: `move2${w}` });
  record(`G-${w}4. VENUE received exactly 15`, true, (await bal(VENUE)) - b === 15n * E18, `${((await bal(VENUE)) - b) / E18}`);
  await move(`G-${w}5. move 2 replayed`, false, s, tokenTransfer(VENUE, 5n), { replay: sig2 });
  await move(`G-${w}6. 1 token to another address (Roles rule)`, false, s, tokenTransfer(OTHER, 1n));
  await move(`G-${w}7. move signed by another key`, false, s, tokenTransfer(VENUE, 1n), { signer: privateKeyToAccount(generatePrivateKey()) });
  await grant(`G-${w}8. grant for 7 days + 1 hour`, false, pk, sign, { seconds: 7n * 86400n + 3600n });
  await grant(`G-${w}9. grant submitted with a later end than signed`, false, pk, sign, { end: s.end + 3600n, signedEnd: s.end });
  await grant(`G-${w}10. grant replayed with an earlier end (shortening)`, false, pk, sign, { key: s.key, end: s.end - 60n });
  await grant(`G-${w}11. grant for the zero key`, false, pk, sign, { key: { address: '0x0000000000000000000000000000000000000000' } as any });
  const r = await grant(`G-${w}12. second session`, true, pk, sign);
  await send(`G-${w}13. ${w} revokes it (one signature)`, true, pk, encodeFunctionData({ abi: PK.abi, functionName: 'revoke', args: [r.key.address, await sign(await text(pk, r.key.address, 0n))] }));
  await move(`G-${w}14. the revoked session`, false, r, tokenTransfer(VENUE, 1n));
  await grant(`G-${w}15. re-grant the revoked key`, false, pk, sign, { key: r.key });
  await move(`G-${w}16. first session still works after the other's revoke`, true, s, tokenTransfer(VENUE, 1n));
}
// cross-wallet / cross-contract
{
  await grant('X1. PrimeKey(Phantom) with a Freighter-signed grant', false, st.pkPH, freighterSign);
  await grant('X2. PrimeKey(Freighter) with the Freighter key WITHOUT the SEP-53 prefix', false, st.pkFR, (t) => toHex(fr.sign(Buffer.from(t, 'utf8'))));
  await grant('X3. PrimeKey(MetaMask) with a Phantom grant', false, st.pkMM, phantomSign);
  const key = privateKeyToAccount(generatePrivateKey()); const end = (await now()) + 3600n;
  const other = await text(st.pkFR, key.address, end);
  await send('X4. Phantom grant text made for PrimeKey(Freighter) replayed to PrimeKey(Phantom)', false, st.pkPH, encodeFunctionData({ abi: PK.abi, functionName: 'grant', args: [key.address, end, phantomSign(other)] }));
  const s = await grant('X5. Freighter session', true, st.pkFR, freighterSign);
  await move('X6. that session key used through PrimeKey(Phantom)', false, { ...s, pk: st.pkPH }, tokenTransfer(VENUE, 1n));
  await send('X7. a stranger calls Roles directly as if a member', false, st.roles, encodeFunctionData({ abi: parseAbi(['function execTransactionWithRole(address,uint256,bytes,uint8,bytes32,bool) returns (bool)']), functionName: 'execTransactionWithRole', args: [st.token, 0n, tokenTransfer(VENUE, 1n).data, 0, st.roleKey, true] }));
  // cap: 100/day across all members; 15+1 x3 = 48 spent
  await move('X8. a move over the daily cap (60 more)', false, s, tokenTransfer(VENUE, 60n));
  // expiry
  await rpc('evm_increaseTime', [3601]); await rpc('evm_mine', []);
  await move('X9. after the session ends', false, s, tokenTransfer(VENUE, 1n));
}
console.log('gas:', Object.entries(gasOf).map(([k, v]) => `${k} ${v}`).join(', '));
st.gas = gasOf; save();
console.log(`${results.filter((r) => r.pass).length}/${results.length} passed`);
for (const r of results.filter((r) => !r.pass)) console.log('FAIL', r.name, r.detail);
process.exit(0);
