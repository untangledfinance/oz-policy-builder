// Prepares the EVM payloads on a private Base Sepolia fork (anvil :8591): a real PrimeSession (owner = the test wallet),
// a real Safe 1.4.1 (owner = the test wallet, threshold 1), the grant text read from the contract, the SafeTx typed data.
import { createPublicClient, createWalletClient, http, parseAbi, getAddress, toHex, keccak256, hashTypedData, type Address, type Hex } from 'viem';
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts';
import { baseSepolia } from 'viem/chains';
import { readFileSync, writeFileSync } from 'node:fs';
const OCT = '/home/ubuntu/git/github.com/untangledfinance/octopos/apps/evm-web/src/core';
const ob = await import(`${OCT}/onboarding.ts`);
const { CONTRACTS } = await import(`${OCT}/contracts.ts`);
const H = '/home/ubuntu/work/wallet-matrix/real', RPC = 'http://127.0.0.1:8591';
const pub = createPublicClient({ chain: baseSepolia, transport: http(RPC) });
const relayer = createWalletClient({ chain: baseSepolia, transport: http(RPC), account: privateKeyToAccount('0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80') });
const owner = getAddress(JSON.parse(readFileSync(`${H}/secrets/pub.json`, 'utf8')).evm) as Address;
const art = JSON.parse(readFileSync('/home/ubuntu/work/prime-evm/out/PrimeSession.sol/PrimeSession.json', 'utf8'));
const Z = '0x0000000000000000000000000000000000000000' as Address;
const roles = privateKeyToAccount(generatePrivateKey()).address;
const dep = await relayer.deployContract({ abi: art.abi, bytecode: art.bytecode.object as Hex, args: [owner, roles] });
const session = (await pub.waitForTransactionReceipt({ hash: dep })).contractAddress as Address;
const key = privateKeyToAccount(generatePrivateKey()).address;
const block = await pub.getBlock();
const end = block.timestamp + 3n * 86400n;
const grantText = await pub.readContract({ address: session, abi: art.abi, functionName: 'grantText', args: [key, end] }) as string;
const proxyCreationCode = await pub.readContract({ address: CONTRACTS.safeProxyFactory, abi: parseAbi(['function proxyCreationCode() view returns (bytes)']), functionName: 'proxyCreationCode' }) as Hex;
const init = ob.encodeSafeInitializer([owner], 1n, CONTRACTS.compatibilityFallbackHandler);
const salt = BigInt(keccak256(toHex(`wm-${Date.now()}`)));
const safe = ob.predictSafeAddress(proxyCreationCode, init, salt) as Address;
const c = ob.encodeCreateSafe(init, salt);
await pub.waitForTransactionReceipt({ hash: await relayer.sendTransaction({ to: c.to, data: c.data }) });
const dest = privateKeyToAccount(generatePrivateKey()).address;
const tx = { to: dest, value: 1000n, data: '0x' as Hex, operation: 0 as const, safeTxGas: 0n, baseGas: 0n, gasPrice: 0n, gasToken: Z, refundReceiver: Z, nonce: 0n };
const safeTxHash = ob.hashSafeTransaction(84532, safe, tx) as Hex;
const typed = {
  types: { EIP712Domain: [{ name: 'chainId', type: 'uint256' }, { name: 'verifyingContract', type: 'address' }],
    SafeTx: [{ name: 'to', type: 'address' }, { name: 'value', type: 'uint256' }, { name: 'data', type: 'bytes' }, { name: 'operation', type: 'uint8' }, { name: 'safeTxGas', type: 'uint256' }, { name: 'baseGas', type: 'uint256' }, { name: 'gasPrice', type: 'uint256' }, { name: 'gasToken', type: 'address' }, { name: 'refundReceiver', type: 'address' }, { name: 'nonce', type: 'uint256' }] },
  primaryType: 'SafeTx', domain: { chainId: 84532, verifyingContract: safe },
  message: { to: dest, value: '1000', data: '0x', operation: 0, safeTxGas: '0', baseGas: '0', gasPrice: '0', gasToken: Z, refundReceiver: Z, nonce: '0' },
};
const vh = hashTypedData({ domain: typed.domain, types: { SafeTx: typed.types.SafeTx }, primaryType: 'SafeTx', message: { ...tx } });
if (vh !== safeTxHash) throw new Error(`hash mismatch ${vh} ${safeTxHash}`);
const nearText = `Prime NEAR signer\ncontract: signer.prime-spike-muwguc60.testnet\npath: prime:evm\ndomain: 0\npayload: ${keccak256(toHex('wm-near-payload')).slice(2)}`;
writeFileSync(`${H}/payloads/evm.json`, JSON.stringify({ owner, session, key, end: end.toString(), grantText, nearText, safe, safeTxHash, typed, rpc: RPC, chainId: 84532 }, null, 1));
console.log(JSON.stringify({ owner, session, safe, safeTxHash, grantText }, null, 1));
process.exit(0);
