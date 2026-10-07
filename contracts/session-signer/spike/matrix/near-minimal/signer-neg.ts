// Refusals of the prime-near-signer contract itself (each must fail in our contract, before any MPC call),
// plus one accepted control request per wallet and domain.
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import { Keypair } from '@stellar/stellar-sdk';
import { actionCreators } from '@near-js/transactions';
const { relayer } = await import('./mm.ts');
const { SIGNER, requestText } = await import('./nearsig.ts');
const FREIGHTER_FILE = '/home/ubuntu/work/near-wallet-spike/secrets/freighter-b.json';
const fr = Keypair.fromSecret(JSON.parse(readFileSync(FREIGHTER_FILE, 'utf8')).secret);
const phSecret = bs58.decode(JSON.parse(readFileSync('/home/ubuntu/work/phantom-spike/secrets/phantom-test.json', 'utf8')).secret);
const ph = nacl.sign.keyPair.fromSecretKey(phSecret.length === 64 ? phSecret : nacl.sign.keyPair.fromSeed(phSecret).secretKey);
const FR = Buffer.from(fr.rawPublicKey()).toString('hex'), PH = Buffer.from(ph.publicKey).toString('hex');
const sep53 = (t: string) => { const d = mkdtempSync(`${tmpdir()}/fs-`); writeFileSync(`${d}/m.txt`, t);
  try { return Buffer.from(execFileSync('bun', ['freighter-sign.ts', FREIGHTER_FILE, `${d}/m.txt`], { encoding: 'utf8' }), 'base64').toString('hex'); } finally { rmSync(d, { recursive: true }); } };
const text = (t: string) => Buffer.from(nacl.sign.detached(Buffer.from(t, 'utf8'), ph.secretKey)).toString('hex');
const results: any[] = [];
async function call(name: string, expectOk: boolean, args: any) {
  const out: any = await relayer.signAndSendTransaction({ receiverId: SIGNER, actions: [actionCreators.functionCall('sign', args, 300_000_000_000_000n, 1n)], waitUntil: 'FINAL', throwOnFailure: false });
  const ok = !!out.status?.SuccessValue;
  const why = ok ? 'MPC signature returned' : JSON.stringify(out.status?.Failure ?? out.status).match(/(not signed by this key|key|signature|payload)"?/)?.[0] ?? JSON.stringify(out.status).slice(0, 200);
  const pass = ok === expectOk; results.push({ name, pass });
  console.log(`${pass ? 'PASS' : 'FAIL'} ${name} | ${ok ? 'ok' : 'refused: ' + why}`);
}
const P = 'prime:neg', H = 'ab'.repeat(32);
await call('S1. Freighter, SEP-53, ed25519 domain (control)', true, { key: FR, sep53: true, path: P, domain_id: 1, payload: H, signature: sep53(requestText(P, 1, H)) });
await call('S2. Phantom, text, secp256k1 domain (control)', true, { key: PH, sep53: false, path: P, domain_id: 0, payload: H, signature: text(requestText(P, 0, H)) });
await call("S3. Phantom's signature presented as Freighter's key", false, { key: FR, sep53: false, path: P, domain_id: 1, payload: H, signature: text(requestText(P, 1, H)) });
await call('S4. Freighter SEP-53 signature submitted as plain text', false, { key: FR, sep53: false, path: P, domain_id: 1, payload: H, signature: sep53(requestText(P, 1, H)) });
await call('S5. Phantom plain-text signature submitted as SEP-53', false, { key: PH, sep53: true, path: P, domain_id: 1, payload: H, signature: text(requestText(P, 1, H)) });
await call('S6. signed for another payload', false, { key: PH, sep53: false, path: P, domain_id: 1, payload: 'cd'.repeat(32), signature: text(requestText(P, 1, H)) });
await call('S7. signed for another path', false, { key: PH, sep53: false, path: 'prime:other', domain_id: 1, payload: H, signature: text(requestText(P, 1, H)) });
await call('S8. signed for another domain', false, { key: PH, sep53: false, path: P, domain_id: 0, payload: H, signature: text(requestText(P, 1, H)) });
await call('S9. signed for another signer contract', false, { key: PH, sep53: false, path: P, domain_id: 1, payload: H,
  signature: text(requestText(P, 1, H).replace(`contract: ${SIGNER}`, 'contract: signer.someone-else.testnet')) });
await call('S10. malformed key', false, { key: 'zz', sep53: false, path: P, domain_id: 1, payload: H, signature: text(requestText(P, 1, H)) });
await call('S11. payload in upper-case hex (wallet signed the lower-case text)', true, { key: PH, sep53: false, path: P, domain_id: 1, payload: H.toUpperCase(), signature: text(requestText(P, 1, H)) });
console.log(`${results.filter((r) => r.pass).length}/${results.length} passed`);
process.exit(0);
