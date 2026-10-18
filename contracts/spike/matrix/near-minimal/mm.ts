// MetaMask -> NEAR testnet -> MPC ed25519 signature, as the Prime app does on
// mainnet (chain 397, our relayer submits rlp_execute), but on testnet (398).
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { encodeFunctionData, keccak256, toBytes, toHex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { Account } from '@near-js/accounts';
import { JsonRpcProvider } from '@near-js/providers';
import { KeyPairSigner } from '@near-js/signers';
import { KeyPair } from '@near-js/crypto';
import { actionCreators } from '@near-js/transactions';
import { MPC, NEAR_RPC, rpc, view } from './near.ts';

const MM_FILE = 'secrets/metamask.json';
if (!existsSync(MM_FILE)) writeFileSync(MM_FILE, JSON.stringify({ pk: generatePrivateKey() }), { mode: 0o600 });
/** Stand-in for the user's MetaMask: a testnet-only key, never funded on any EVM chain. */
export const metamask = privateKeyToAccount(JSON.parse(readFileSync(MM_FILE, 'utf8')).pk);
export const ethAccountId = metamask.address.toLowerCase();

const near = JSON.parse(readFileSync('secrets/near.json', 'utf8'));
const provider = new JsonRpcProvider({ url: NEAR_RPC });
/** Our testnet NEAR account: plays the Prime relayer (submits rlp_execute, pays gas). */
export const relayer = new Account(near.accountId, provider, new KeyPairSigner(KeyPair.fromString(near.secret)));

export async function ensureEthAccount() {
  try { await rpc('query', { request_type: 'view_account', finality: 'final', account_id: ethAccountId }); }
  catch {
    await relayer.signAndSendTransaction({ receiverId: ethAccountId, actions: [actionCreators.transfer(2n * 10n ** 24n)], waitUntil: 'FINAL' });
  }
  const a = await rpc('query', { request_type: 'view_account', finality: 'final', account_id: ethAccountId });
  return { amount: Number(BigInt(a.amount) / 10n ** 21n) / 1000, codeHash: a.code_hash, globalId: a.global_contract_account_id ?? a.global_contract_hash ?? null };
}

const FN_CALL = [{ type: 'function', name: 'functionCall', stateMutability: 'nonpayable', outputs: [], inputs: [
  { name: 'receiverId', type: 'string' }, { name: 'methodName', type: 'string' }, { name: 'args', type: 'bytes' },
  { name: 'gas', type: 'uint64' }, { name: 'yoctoNear', type: 'uint32' } ] }] as const;

/** One MPC ed25519 signature over `message`, requested by the MetaMask account. */
export async function mpcSign(message: Uint8Array, path: string): Promise<{ sig: Uint8Array; ms: number; nearTx: string }> {
  const t0 = Date.now();
  const nonce = Number(await view(ethAccountId, 'get_nonce', {}));
  const args = { request: { path, payload_v2: { Eddsa: Buffer.from(message).toString('hex') }, domain_id: 1 } };
  const data = encodeFunctionData({ abi: FN_CALL, functionName: 'functionCall',
    args: [MPC, 'sign', toHex(new TextEncoder().encode(JSON.stringify(args))), 250_000_000_000_000n, 1] });
  const to = ('0x' + keccak256(toBytes(MPC)).slice(26)) as `0x${string}`;
  // What MetaMask signs (one prompt): a chain-398 transaction to v1.signer's eth alias.
  const raw = await metamask.signTransaction({ chainId: 398, type: 'legacy', nonce, to, value: 0n, data, gas: 3_000_000n, gasPrice: 100_000_000_000n });
  const out: any = await relayer.signAndSendTransaction({
    receiverId: ethAccountId,
    actions: [actionCreators.functionCall('rlp_execute', { target: MPC, tx_bytes_b64: Buffer.from(raw.slice(2), 'hex').toString('base64') }, 300_000_000_000_000n, 0n)],
    waitUntil: 'FINAL', throwOnFailure: false,
  });
  const nearTx = out.transaction_outcome?.id ?? out.transaction?.hash;
  for (const r of out.receipts_outcome ?? []) {
    const v = r.outcome?.status?.SuccessValue;
    if (!v) continue;
    try {
      const j = JSON.parse(Buffer.from(v, 'base64').toString());
      const s = j?.signature ?? j?.Ed25519?.signature;
      if (Array.isArray(s) && s.length === 64) return { sig: Uint8Array.from(s), ms: Date.now() - t0, nearTx };
    } catch {}
  }
  throw new Error(`no MPC signature in ${nearTx}: ${JSON.stringify(out.status ?? out).slice(0, 1500)}`);
}

if (import.meta.main) {
  console.log('MetaMask stand-in', metamask.address, await ensureEthAccount());
}
