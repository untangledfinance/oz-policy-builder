// Real Phantom (its own EVM account) as a Safe 1.4.1 owner on the Base Sepolia fork, no NEAR.
//   prepare: create a Safe owned by MetaMask + Phantom's EVM address (threshold 2), write the safeTxHash for Phantom
//   execute: MetaMask signs the hash; real Phantom's personal_sign of the hash is submitted with v + 4 (eth_sign type)
import { createPublicClient, createWalletClient, http, encodeFunctionData, parseAbi, getAddress, concat, keccak256, toHex, hashTypedData, recoverAddress, hashMessage, type Address, type Hex } from 'viem';
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts';
import { baseSepolia } from 'viem/chains';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
const { metamask } = await import('/home/ubuntu/work/near-session-spike/nearsig.ts');
const OCT = '/home/ubuntu/git/github.com/untangledfinance/octopos/apps/evm-web/src/core';
const ob = await import(`${OCT}/onboarding.ts`);
const { CONTRACTS } = await import(`${OCT}/contracts.ts`);
const RPC = 'http://127.0.0.1:8547';
const pub = createPublicClient({ chain: baseSepolia, transport: http(RPC) });
const relayer = createWalletClient({ chain: baseSepolia, transport: http(RPC), account: privateKeyToAccount('0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80') });
const ST = 'state-phx.json', IN = '/home/ubuntu/work/phantom-spike/pevm-in.json';
const st: any = existsSync(ST) ? JSON.parse(readFileSync(ST, 'utf8')) : {};
const safeAbi = parseAbi(['function nonce() view returns (uint256)', 'function getOwners() view returns (address[])']);
const Z = '0x0000000000000000000000000000000000000000' as Address;
const tx = (nonce: bigint) => ({ to: st.dest as Address, value: 1000n, data: '0x' as Hex, operation: 0 as const, safeTxGas: 0n, baseGas: 0n, gasPrice: 0n, gasToken: Z, refundReceiver: Z, nonce });

if (process.argv[2] === 'prepare') {
  const ph = getAddress(JSON.parse(process.argv[3]).addr);
  const proxyCreationCode = await pub.readContract({ address: CONTRACTS.safeProxyFactory, abi: parseAbi(['function proxyCreationCode() view returns (bytes)']), functionName: 'proxyCreationCode' }) as Hex;
  const init = ob.encodeSafeInitializer([metamask.address, ph], 2n, CONTRACTS.compatibilityFallbackHandler);
  const salt = BigInt(keccak256(toHex(`phx-${Date.now()}`)));
  st.safe = ob.predictSafeAddress(proxyCreationCode, init, salt); st.ph = ph; st.dest = privateKeyToAccount(generatePrivateKey()).address;
  const c = ob.encodeCreateSafe(init, salt);
  await pub.waitForTransactionReceipt({ hash: await relayer.sendTransaction({ to: c.to, data: c.data }) });
  await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'anvil_setBalance', params: [st.safe, '0xde0b6b3a7640000'] }) });
  const owners = await pub.readContract({ address: st.safe, abi: safeAbi, functionName: 'getOwners' });
  const h = ob.hashSafeTransaction(84532, st.safe, tx(0n));
  const j = JSON.parse(readFileSync(IN, 'utf8')); j.typed.safeTxHash = h; writeFileSync(IN, JSON.stringify(j));
  writeFileSync(ST, JSON.stringify({ ...st, hash: h }, null, 1));
  console.log('Safe', st.safe, 'owners', owners.join(','), 'safeTxHash', h);
}
if (process.argv[2] === 'execute') {
  const r = JSON.parse(process.argv[3]);
  const h = st.hash as Hex;
  const asRaw = getAddress(await recoverAddress({ hash: hashMessage({ raw: h }), signature: r.hashSig }));
  console.log('Phantom personal_sign(hash) recovers, as the 32 raw bytes, to', asRaw, asRaw === getAddress(st.ph) ? '(Phantom: signed the raw hash)' : '(not Phantom)');
  const v = parseInt(r.hashSig.slice(130, 132), 16);
  const phSig = (r.hashSig.slice(0, 130) + (v + 4).toString(16)) as Hex; // Safe: v > 30 means eth_sign (personal_sign of the hash)
  const mmSig = await metamask.sign({ hash: h });
  const parts = [[metamask.address, mmSig], [getAddress(st.ph), phSig]].sort((a, b) => (BigInt(a[0]) < BigInt(b[0]) ? -1 : 1));
  const before = await pub.getBalance({ address: st.dest });
  try {
    const hash = await relayer.sendTransaction({ to: st.safe, data: ob.encodeExecTransaction(tx(0n), concat(parts.map((p) => p[1] as Hex))), gas: 500_000n });
    const rc = await pub.waitForTransactionReceipt({ hash });
    console.log(rc.status === 'success' && (await pub.getBalance({ address: st.dest })) - before === 1000n
      ? 'PASS P1. Safe tx executed with MetaMask + real Phantom (own EVM account, personal_sign, no NEAR)' : `FAIL P1. ${rc.status}`);
  } catch (e: any) { console.log('FAIL P1.', String(e?.shortMessage ?? e).slice(0, 200)); }
  // Refusal: Phantom's signature alone (threshold 2)
  try { await pub.call({ account: relayer.account, to: st.safe, data: ob.encodeExecTransaction(tx(1n), phSig) }); console.log('FAIL P2. Phantom alone executed'); }
  catch (e: any) { console.log('PASS P2. Phantom alone refused:', String(e?.shortMessage ?? e).match(/GS0\d\d/)?.[0] ?? String(e).slice(0, 80)); }
}
process.exit(0);
