import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
const devnet = process.env.PSN_NET === 'devnet';
const c = new Connection(process.env.PSN_RPC ?? (devnet ? 'https://api.devnet.solana.com' : 'http://127.0.0.1:8899'));
const so = readFileSync(`/home/ubuntu/work/prime-session/target/${devnet ? 'deploy-devnet' : 'deploy'}/prime_session.so`);
const progA = devnet ? Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync('/home/ubuntu/work/prime-session/target/deploy/prime_session-keypair.json', 'utf8')))).publicKey : new PublicKey('FTNMFWiECbRp7D5MwJUiNQfee6NuJPjE7S11J9yc2B9G');
const progB = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync('/home/ubuntu/work/swig-spike/secrets/prime-session-b.json', 'utf8')))).publicKey;
console.log('sha256(.so)', createHash('sha256').update(so).digest('hex'), `${so.length} bytes`);
for (const [name, id] of (devnet ? [['A', progA]] : [['A', progA], ['B', progB]]) as [string, PublicKey][]) {   // program B exists only on the local validator
  const p = await c.getAccountInfo(id);
  if (!p) { console.log(`program ${name} ${id.toBase58()}: not deployed`); continue; }
  const pd = (await c.getAccountInfo(new PublicKey(p.data.subarray(4, 36))))!, d = pd.data.subarray(45);
  console.log(`program ${name} ${id.toBase58()}: executable ${p.executable}, upgrade authority ${pd.data[12] === 0 ? 'none (final)' : new PublicKey(pd.data.subarray(13, 45)).toBase58()}`);
  console.log(`program ${name} ${id.toBase58()}: on-chain code starts with local .so:`, Buffer.compare(d.subarray(0, so.length), so) === 0, 'rest zero:', d.subarray(so.length).every((x) => x === 0), 'sha256(on-chain code, .so length)', createHash('sha256').update(d.subarray(0, so.length)).digest('hex'));
}
