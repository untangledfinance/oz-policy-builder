// Compares the gate program's on-chain code with the local .so (devnet only) and prints the upgrade authority.
import { Connection, PublicKey } from '@solana/web3.js';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
const c = new Connection('https://api.devnet.solana.com');
const so = readFileSync('/home/ubuntu/git/github.com/untangledfinance/oz-policy-builder/contracts/prime/solana/custody-gate/target/deploy/gate.so');
const id = new PublicKey(process.argv[2]!);
console.log('genesis', await c.getGenesisHash());
console.log('sha256(.so)', createHash('sha256').update(so).digest('hex'), `${so.length} bytes`);
const p = (await c.getAccountInfo(id))!;
const pdAddr = new PublicKey(p.data.subarray(4, 36)), pd = (await c.getAccountInfo(pdAddr))!, d = pd.data.subarray(45);
console.log(`program ${id.toBase58()}: executable ${p.executable}, program data ${pdAddr.toBase58()} (${pd.data.length - 45} B of code space), upgrade authority ${pd.data[12] === 0 ? 'none (final)' : new PublicKey(pd.data.subarray(13, 45)).toBase58()}`);
console.log('on-chain code starts with the local .so:', Buffer.compare(d.subarray(0, so.length), so) === 0, '| code space equals .so length:', d.length === so.length, '| sha256(on-chain code, .so length)', createHash('sha256').update(d.subarray(0, so.length)).digest('hex'));
