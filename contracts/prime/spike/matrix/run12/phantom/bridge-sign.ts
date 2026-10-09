// Real Phantom signMessage through the Playwright bridge (bridge12.mjs): write req-N.txt, wait for req-N.sig (base58).
import { existsSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import bs58 from '/home/ubuntu/work/swig-spike/node_modules/bs58/src/esm/index.js';
const B = '/home/ubuntu/work/phantom-spike/bridge-r12';
const sleep = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
export function realPhantomSign(text: string): Uint8Array {
  const n = readdirSync(B).filter((f) => f.endsWith('.txt')).length + Math.floor(Math.random() * 1e6) * 1000;
  writeFileSync(`${B}/req-${n}.txt`, text);
  const sig = `${B}/req-${n}.sig`;
  for (let i = 0; i < 600 && !existsSync(sig); i++) sleep(300);
  if (!existsSync(sig)) throw new Error(`no Phantom signature for req-${n}`);
  sleep(200);
  console.log(`   REAL Phantom signed req-${n} (${Buffer.byteLength(text)} bytes of text)`);
  return bs58.decode(readFileSync(sig, 'utf8').trim());
}
