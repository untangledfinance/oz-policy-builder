// Round 2: is the Solidity ed25519 verifier (chengwenxi/Ed25519, unaudited) correct? RFC 8032 vectors, random
// keys/messages, and every kind of bad signature, on the anvil fork.
import { createPublicClient, createWalletClient, http, toHex, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { baseSepolia } from 'viem/chains';
import nacl from 'tweetnacl';
import { readFileSync, writeFileSync } from 'node:fs';
const RPC = 'http://127.0.0.1:8546';
const pub = createPublicClient({ chain: baseSepolia, transport: http(RPC) });
const relayer = createWalletClient({ chain: baseSepolia, transport: http(RPC), account: privateKeyToAccount('0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80') }); // anvil dev #0
const VER = JSON.parse(readFileSync('/home/ubuntu/work/ed-evm/v06/out/Ed25519Verifier.sol/Ed25519Verifier.json', 'utf8'));
const addr = (await pub.waitForTransactionReceipt({ hash: await relayer.deployContract({ abi: VER.abi, bytecode: VER.bytecode.object }) })).contractAddress!;
const results: any[] = [];
const L = 2n ** 252n + 27742317777372353535851937790883648493n;
const h = (b: Uint8Array | string): Hex => (typeof b === 'string' ? (`0x${b}` as Hex) : toHex(b));
async function verify(pk: Hex, sig: Uint8Array, m: Uint8Array) {
  return pub.readContract({ address: addr, abi: VER.abi, functionName: 'verify', args: [pk, toHex(sig.slice(0, 32)), toHex(sig.slice(32, 64)), toHex(m)] }) as Promise<boolean>;
}
function rec(name: string, expect: boolean, got: boolean) { const pass = expect === got; results.push({ name, pass, got }); console.log(`${pass ? 'PASS' : 'FAIL'} ${name} | ${got}`); }
const unhex = (s: string) => Uint8Array.from(Buffer.from(s, 'hex'));

// RFC 8032 section 7.1 TEST 1-3
const rfc = [
  ['d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a', '', 'e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e065224901555fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b'],
  ['3d4017c3e843895a92b70aa74d1b7ebc9c982ccf2ec4968cc0cd55f12af4660c', '72', '92a009a9f0d4cab8720e820b5f642540a2b27b5416503f8fb3762223ebdb69da085ac1e43e15996e458f3613d0f11d8c387b2eaeb4302aeeb00d291612bb0c00'],
  ['fc51cd8e6218a1a38da47ed00230f0580816ed13ba3303ac5deb911548908025', 'af82', '6291d657deec24024827e69c3abe01a30ce548a284743a445e3680d7db5ac3ac18ff9b538d16f290ae67f760984dc6594a7c15e9716ed28dc027beceea1ec40a'],
];
for (const [i, [pk, m, s]] of rfc.entries()) rec(`V${i + 1}. RFC 8032 TEST ${i + 1} accepted`, true, await verify(h(pk!), unhex(s!), unhex(m!)));

// random keys and message lengths (including the grant/approval text sizes and > 1 block of SHA-512)
let ok = 0, n = 0;
for (const len of [0, 1, 31, 32, 63, 64, 111, 112, 127, 128, 129, 139, 148, 157, 200, 260, 300, 500, 777, 1024]) {
  for (let k = 0; k < 2; k++) {
    const kp = nacl.sign.keyPair(); const m = nacl.randomBytes(len); const sig = nacl.sign.detached(m, kp.secretKey);
    n++; if (await verify(toHex(kp.publicKey), sig, m)) ok++;
  }
}
rec(`V4. ${n} random key/message pairs (0..1024 bytes) all accepted`, true, ok === n);

// refusals
const kp = nacl.sign.keyPair(); const m = new TextEncoder().encode('Prime session\nmember: 0x00\nsession key: 0x00\nvalid until: 1\nchain: 84532');
const sig = nacl.sign.detached(m, kp.secretKey);
rec('V5. genuine signature', true, await verify(toHex(kp.publicKey), sig, m));
const flipMsg = m.slice(); flipMsg[5] ^= 1; rec('V6. one message bit flipped', false, await verify(toHex(kp.publicKey), sig, flipMsg));
const flipR = sig.slice(); flipR[3] ^= 1; rec('V7. one R bit flipped', false, await verify(toHex(kp.publicKey), flipR, m));
const flipS = sig.slice(); flipS[40] ^= 1; rec('V8. one S bit flipped', false, await verify(toHex(kp.publicKey), flipS, m));
rec('V9. another public key', false, await verify(toHex(nacl.sign.keyPair().publicKey), sig, m));
// malleability: S + L (same point equation, non-canonical S) must be refused
const sLE = BigInt('0x' + Buffer.from(sig.slice(32)).reverse().toString('hex'));
const s2 = sLE + L; const s2b = Buffer.from(s2.toString(16).padStart(64, '0'), 'hex').reverse();
const mall = new Uint8Array([...sig.slice(0, 32), ...s2b]);
rec('V10. malleated signature (S + L) refused', false, await verify(toHex(kp.publicKey), mall, m));
rec('V11. all-zero signature', false, await verify(toHex(kp.publicKey), new Uint8Array(64), m));
rec('V12. RFC TEST 2 signature with TEST 3 message', false, await verify(h(rfc[1]![0]!), unhex(rfc[1]![2]!), unhex('af82')));
// small-order public key (identity point encoding 0x01 00..00) with an all-zero-ish signature: must not verify an arbitrary message
const ident = new Uint8Array(32); ident[0] = 1;
const forged = new Uint8Array(64); forged[0] = 1; // R = identity, S = 0
rec('V13. small-order key (identity) + R=identity, S=0 forgery refused', false, await verify(toHex(ident), forged, m));
const g = await pub.estimateGas({ to: addr, data: (await import('viem')).encodeFunctionData({ abi: VER.abi, functionName: 'verify', args: [toHex(kp.publicKey), toHex(sig.slice(0, 32)), toHex(sig.slice(32)), toHex(m)] }) });
console.log(`gas for one ${m.length}-byte verification: ${g}`);
writeFileSync('state-edvectors.json', JSON.stringify({ verifier: addr, gas: g.toString(), results }, null, 1));
console.log(`${results.filter((r) => r.pass).length}/${results.length} passed`);
