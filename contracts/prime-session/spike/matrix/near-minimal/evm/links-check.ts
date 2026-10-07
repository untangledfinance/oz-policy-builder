// Re-check every explorer link in the doc against its chain.
import { readFileSync } from 'node:fs';
import { createPublicClient, http } from 'viem';
import { baseSepolia } from 'viem/chains';
const md = readFileSync(process.argv[2], 'utf8');
const pub = createPublicClient({ chain: baseSepolia, transport: http('https://base-sepolia-rpc.publicnode.com') });
const j = (u: string, b?: unknown) => fetch(u, b ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) } : undefined).then((r) => r.json());
let ok = 0, bad = 0; const fail = (m: string) => { bad++; console.log('BAD', m); };
for (const [, h] of md.matchAll(/sepolia\.basescan\.org\/tx\/(0x[0-9a-f]{64})/g)) { const r = await pub.getTransactionReceipt({ hash: h as any }).catch(() => null); r?.status === 'success' ? ok++ : fail(`basescan tx ${h}`); }
for (const [, a] of md.matchAll(/sepolia\.basescan\.org\/address\/(0x[0-9a-fA-F]{40})/g)) { const c = await pub.getCode({ address: a as any }); c && c.length > 2 ? ok++ : fail(`basescan addr ${a}`); }
for (const [, h] of md.matchAll(/stellar\.expert\/explorer\/testnet\/tx\/([0-9a-f]{64})/g)) { const r: any = await j(`https://horizon-testnet.stellar.org/transactions/${h}`); r.successful ? ok++ : fail(`stellar tx ${h}`); }
const { rpc: SR, xdr, Address } = await import('/home/ubuntu/work/near-session-spike/node_modules/@stellar/stellar-sdk/lib/index.js' as any).catch(() => import('@stellar/stellar-sdk' as any));
const ss = new SR.Server('https://soroban-testnet.stellar.org');
for (const [, c] of md.matchAll(/stellar\.expert\/explorer\/testnet\/contract\/(C[A-Z2-7]{55})/g)) { const k = xdr.LedgerKey.contractData(new xdr.LedgerKeyContractData({ contract: new Address(c).toScAddress(), key: xdr.ScVal.scvLedgerKeyContractInstance(), durability: xdr.ContractDataDurability.persistent() })); (await ss.getLedgerEntries(k)).entries.length === 1 ? ok++ : fail(`stellar contract ${c}`); }
for (const [, h] of md.matchAll(/testnet\.nearblocks\.io\/txns\/([1-9A-HJ-NP-Za-km-z]{43,44})/g)) { const r: any = await j('https://test.rpc.fastnear.com', { jsonrpc: '2.0', id: 1, method: 'tx', params: { tx_hash: h, sender_account_id: 'prime-spike-muwguc60.testnet', wait_until: 'FINAL' } }); r.result?.status?.SuccessValue !== undefined ? ok++ : fail(`near tx ${h} ${JSON.stringify(r.error ?? r.result?.status).slice(0, 100)}`); }
console.log(`links ok ${ok}, bad ${bad}`);
