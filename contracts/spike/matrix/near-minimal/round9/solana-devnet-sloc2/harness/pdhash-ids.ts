// On-chain code equals a local .so: bun pdhash-ids.ts <so> <name=programId>...   (devnet; PSN_RPC overrides the URL)
import { Connection, PublicKey } from '@solana/web3.js';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
const c = new Connection(process.env.PSN_RPC ?? 'https://api.devnet.solana.com');
if ((await c.getGenesisHash()) !== 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG') throw new Error('devnet only');
const so = readFileSync(process.argv[2]!);
console.log('sha256(.so)', createHash('sha256').update(so).digest('hex'), `${so.length} bytes`);
let bad = 0;
for (const arg of process.argv.slice(3)) {
  const [name, id] = arg.split('=') as [string, string];
  const p = await c.getAccountInfo(new PublicKey(id));
  if (!p) { console.log(`program ${name} ${id}: not deployed`); bad++; continue; }
  const pd = (await c.getAccountInfo(new PublicKey(p.data.subarray(4, 36))))!, d = pd.data.subarray(45);
  const startsWith = Buffer.compare(d.subarray(0, so.length), so) === 0, restZero = d.subarray(so.length).every((x) => x === 0);
  console.log(`program ${name} ${id}: executable ${p.executable}, upgrade authority ${pd.data[12] === 0 ? 'none (final)' : new PublicKey(pd.data.subarray(13, 45)).toBase58()}`);
  console.log(`program ${name} ${id}: program data ${new PublicKey(p.data.subarray(4, 36)).toBase58()}, code space ${d.length} bytes, on-chain code starts with local .so: ${startsWith}, rest zero: ${restZero}, sha256(on-chain code) ${createHash('sha256').update(d).digest('hex')}, sha256(first ${so.length} bytes) ${createHash('sha256').update(d.subarray(0, so.length)).digest('hex')}`);
  if (!startsWith || !restZero || d.length !== so.length) bad++;
}
console.log(bad ? `MISMATCH (${bad})` : 'OK: on-chain code equals the .so');
process.exit(bad ? 1 : 0);
