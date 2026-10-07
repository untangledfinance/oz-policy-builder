// Read-only: re-check the live Base Sepolia run from the chain itself.
import { createPublicClient, http, parseAbi } from 'viem';
import { baseSepolia } from 'viem/chains';
import { readFileSync } from 'node:fs';
const st = JSON.parse(readFileSync('state-pkn-live.json', 'utf8'));
const pub = createPublicClient({ chain: baseSepolia, transport: http('https://base-sepolia-rpc.publicnode.com') });
const relayer = '0xecebBf71Faa6682Ff31fD145646f8Eda82E98E11'.toLowerCase();
let ok = 0, bad = 0;
for (const r of st.results.filter((r: any) => r.tx)) {
  const [rc, tx] = await Promise.all([pub.getTransactionReceipt({ hash: r.tx }), pub.getTransaction({ hash: r.tx })]);
  const self = tx.from.toLowerCase() !== relayer;
  if (rc.status === 'success') ok++; else bad++;
  if (self) console.log('self-paid:', r.name.slice(0, 60), 'from', tx.from, 'block', rc.blockNumber);
}
console.log(`receipts success ${ok}, failed ${bad}`);
const safe = parseAbi(['function getOwners() view returns (address[])', 'function getThreshold() view returns (uint256)', 'function isModuleEnabled(address) view returns (bool)', 'function VERSION() view returns (string)']);
console.log('Safe', st.safe, 'version', await pub.readContract({ address: st.safe, abi: safe, functionName: 'VERSION' }), 'owners', await pub.readContract({ address: st.safe, abi: safe, functionName: 'getOwners' }), 'threshold', await pub.readContract({ address: st.safe, abi: safe, functionName: 'getThreshold' }));
console.log('Roles enabled on Safe:', await pub.readContract({ address: st.safe, abi: safe, functionName: 'isModuleEnabled', args: [st.roles] }));
for (const k of ['pkMM', 'pkFR', 'pkPH']) console.log(k, 'enabled module on Roles:', await pub.readContract({ address: st.roles, abi: safe, functionName: 'isModuleEnabled', args: [st[k]] }), 'is Safe owner:', (await pub.readContract({ address: st.safe, abi: safe, functionName: 'getOwners' }) as string[]).map((a) => a.toLowerCase()).includes(st[k].toLowerCase()));
const pk = parseAbi(['function owner() view returns (address)']);
for (const k of ['pkMM', 'pkFR', 'pkPH']) console.log(k, 'owner', await pub.readContract({ address: st[k], abi: pk, functionName: 'owner' }));
const code = await pub.getCode({ address: st.roles }); console.log('Roles proxy code', code?.slice(0, 120));
