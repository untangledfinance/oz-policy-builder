// Real Freighter signMessage through the Playwright bridge (explore.mjs): write req-N.txt, wait for req-N.sig (base64).
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
const B = '/home/ubuntu/work/freighter-ext/bridge';
const sleep = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
export function realFreighterSign(text: string): Buffer {
  const n = Date.now();
  writeFileSync(`${B}/req-${n}.txt`, text);
  const sig = `${B}/req-${n}.sig`;
  for (let i = 0; i < 600 && !existsSync(sig) && !existsSync(sig + '.err'); i++) sleep(300);
  if (!existsSync(sig)) throw new Error(`no Freighter signature for req-${n}: ${existsSync(sig + '.err') ? readFileSync(sig + '.err', 'utf8') : 'timeout'}`);
  sleep(200);
  console.log(`   REAL Freighter signed req-${n} (${Buffer.byteLength(text)} bytes of text)`);
  return Buffer.from(readFileSync(sig, 'utf8').trim(), 'base64');
}
export const realFreighterPublic = JSON.parse(readFileSync('/home/ubuntu/work/freighter-ext/secrets/freighter-real.json', 'utf8')).public as string;
