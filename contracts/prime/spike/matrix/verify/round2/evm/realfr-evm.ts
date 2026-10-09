// Round 2: the REAL Freighter extension approves an EVM Safe transaction through Ed25519Owner (ERC-1271), no NEAR.
import { createPublicClient, createWalletClient, http, toHex, keccak256, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { baseSepolia } from 'viem/chains';
import { readFileSync, writeFileSync } from 'node:fs';
const { realFreighterSign, realFreighterPublic } = await import('/home/ubuntu/work/freighter-ext/bridge-sign.ts');
const { StrKey } = await import('/home/ubuntu/work/near-session-spike/node_modules/@stellar/stellar-sdk/lib/index.js');
const RPC = 'http://127.0.0.1:8546';
const pub = createPublicClient({ chain: baseSepolia, transport: http(RPC) });
const relayer = createWalletClient({ chain: baseSepolia, transport: http(RPC), account: privateKeyToAccount('0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a') }); // anvil dev #2 (public)
const OWN = JSON.parse(readFileSync('/home/ubuntu/work/evm-matrix/out/Ed25519Auth.sol/Ed25519Owner.json', 'utf8'));
const verifier = JSON.parse(readFileSync('state-edvectors.json', 'utf8')).verifier;
const pk = toHex(StrKey.decodeEd25519PublicKey(realFreighterPublic));
const owner = (await pub.waitForTransactionReceipt({ hash: await relayer.deployContract({ abi: OWN.abi, bytecode: OWN.bytecode.object, args: [1, pk, verifier] }) })).contractAddress!;
const safe = '0x000000000000000000000000000000000000dEaD' as Hex, other = '0x000000000000000000000000000000000000bEEF' as Hex;
const h = keccak256(toHex('some safe tx'));
const text = await pub.readContract({ address: owner, abi: OWN.abi, functionName: 'approvalText', args: [safe, h] }) as string;
const sig = toHex(realFreighterSign(text));
const ABI32 = [{ type: 'function', name: 'isValidSignature', stateMutability: 'view', inputs: [{ name: 'hash', type: 'bytes32' }, { name: 'sig', type: 'bytes' }], outputs: [{ name: '', type: 'bytes4' }] }] as const;
const call = (from: Hex, hash: Hex) => pub.readContract({ account: from, address: owner, abi: ABI32, functionName: 'isValidSignature', args: [hash, sig] });
const res = { approvalText: text, ownSafe: await call(safe, h), otherHash: await call(safe, keccak256(toHex('another tx'))), otherSafe: await call(other, h) };
const pass = res.ownSafe === '0x1626ba7e' && res.otherHash === '0xffffffff' && res.otherSafe === '0xffffffff';
console.log(`${pass ? 'PASS' : 'FAIL'} RF4. real Freighter signs the Safe approval text: valid for its Safe + tx only`, JSON.stringify(res));
writeFileSync('state-realfr-evm.json', JSON.stringify({ owner, ...res, pass }, null, 1));
