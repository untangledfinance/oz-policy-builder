// Read-only: classify the newest successful transactions that touched the Swig ProgramData account on mainnet (upgrade, extend, set authority). Public RPC.
import { Connection, PublicKey } from '@solana/web3.js';
const conn = new Connection('https://api.mainnet-beta.solana.com', 'confirmed');
const PD = new PublicKey('Bb6gN8CtkMXf7cfXKnWysmdBg5B8EZfP5kus5TsyH5Es');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const sigs = (await conn.getSignaturesForAddress(PD, { limit: 40 })).filter((s) => !s.err);
console.log(`${sigs.length} successful transactions among the newest 40`);
const counts: Record<string, number> = {};
for (const s of sigs) {
  let t = null; for (let i = 0; i < 5 && !t; i++) { try { t = await conn.getParsedTransaction(s.signature, { maxSupportedTransactionVersion: 0 }); } catch { await sleep(1500 * (i + 1)); } }
  const inner: string[] = []; for (const g of t?.meta?.innerInstructions ?? []) for (const i of g.instructions as any[]) if (i.program === 'bpf-upgradeable-loader') inner.push(i.parsed?.type);
  for (const i of (t?.transaction.message.instructions ?? []) as any[]) if (i.program === 'bpf-upgradeable-loader') inner.push(i.parsed?.type);
  const kinds = [...new Set(inner)].join('+') || 'other';
  counts[kinds] = (counts[kinds] ?? 0) + 1;
  console.log(`${new Date((s.blockTime ?? 0) * 1000).toISOString()} slot ${s.slot} ${kinds}`);
  await sleep(400);
}
console.log(JSON.stringify(counts));
