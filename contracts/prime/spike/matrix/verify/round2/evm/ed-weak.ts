// Round 2: Ed25519Owner / SessionMemberEd refuse small-order and non-canonical public keys (the forgery in ed-vectors V13).
import { createPublicClient, createWalletClient, http, toHex, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { baseSepolia } from 'viem/chains';
import nacl from 'tweetnacl';
import { readFileSync, writeFileSync } from 'node:fs';
const RPC = 'http://127.0.0.1:8546';
const pub = createPublicClient({ chain: baseSepolia, transport: http(RPC) });
const relayer = createWalletClient({ chain: baseSepolia, transport: http(RPC), account: privateKeyToAccount('0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d') }); // anvil dev #1 (public), not #0 (busy)
const OWN = JSON.parse(readFileSync('/home/ubuntu/work/evm-matrix/out/Ed25519Auth.sol/Ed25519Owner.json', 'utf8'));
const verifier = JSON.parse(readFileSync('state-edvectors.json', 'utf8')).verifier;
const results: any[] = [];
async function tryDeploy(name: string, pk: Hex, expectOk: boolean) {
  let ok = true, d = '';
  try { const h = await relayer.deployContract({ abi: OWN.abi, bytecode: OWN.bytecode.object, args: [2, pk, verifier] }); const r = await pub.waitForTransactionReceipt({ hash: h }); ok = r.status === 'success'; d = r.contractAddress ?? ''; }
  catch (e: any) { ok = false; d = (String(e?.shortMessage ?? e).match(/reverted with reason: [^.]*|weak key/)?.[0]) ?? String(e?.shortMessage ?? e).slice(0, 100); }
  const pass = ok === expectOk; results.push({ name, pass, ok, d }); console.log(`${pass ? 'PASS' : 'FAIL'} ${name} | ${ok ? 'deployed' : 'refused: ' + d}`);
}
const le = (y: bigint, sign = 0) => { const b = Buffer.from(y.toString(16).padStart(64, '0'), 'hex').reverse(); if (sign) b[31]! |= 0x80; return toHex(b); };
const P = 2n ** 255n - 19n, Y8 = 0x7a03ac9277fdc74ec6cc392cfa53202a0f67100d760b3cba4fd84d3d706a17c7n;
await tryDeploy('K1. identity (y = 1)', le(1n), false);
await tryDeploy('K2. order 2 (y = p - 1)', le(P - 1n), false);
await tryDeploy('K3. order 4 (y = 0)', le(0n), false);
await tryDeploy('K4. order 4 (y = 0, sign bit)', le(0n, 1), false);
await tryDeploy('K5. order 8 (y8)', le(Y8), false);
await tryDeploy('K6. order 8 (y8, sign bit)', le(Y8, 1), false);
await tryDeploy('K7. order 8 (p - y8)', le(P - Y8), false);
await tryDeploy('K8. order 8 (p - y8, sign bit)', le(P - Y8, 1), false);
await tryDeploy('K9. non-canonical y = p + 1 (identity again)', le(P + 1n), false);
await tryDeploy('K10. a real Phantom-style key', toHex(nacl.sign.keyPair().publicKey), true);
writeFileSync('state-edweak.json', JSON.stringify(results, null, 1));
console.log(`${results.filter((r) => r.pass).length}/${results.length} passed`);
