import { createPublicClient, http } from 'viem';
import { baseSepolia } from 'viem/chains';
import { readFileSync } from 'node:fs';
const st = JSON.parse(readFileSync('state-pkn-live.json', 'utf8'));
const art = JSON.parse(readFileSync('/home/ubuntu/work/prime-evm/out/PrimeKey.sol/PrimeKey.json', 'utf8'));
const pub = createPublicClient({ chain: baseSepolia, transport: http('https://base-sepolia-rpc.publicnode.com') });
const local = Buffer.from(art.deployedBytecode.object.slice(2), 'hex');
const refs = Object.values(art.deployedBytecode.immutableReferences ?? {}).flat() as { start: number; length: number }[];
for (const k of ['pkMM', 'pkFR', 'pkPH']) {
  const chain = Buffer.from((await pub.getCode({ address: st[k] }))!.slice(2), 'hex');
  const a = Buffer.from(local), b = Buffer.from(chain);
  for (const r of refs) { a.fill(0, r.start, r.start + r.length); b.fill(0, r.start, r.start + r.length); }
  console.log(k, st[k], 'bytes', chain.length, 'equal to local build (immutables masked):', a.equals(b), 'immutable slots', refs.length);
}
console.log('compiler', art.metadata?.compiler?.version);
