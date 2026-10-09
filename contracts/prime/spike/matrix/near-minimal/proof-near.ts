// One NEAR-routed MPC signature per wallet route, with NEAR tx ids, checked against the on-chain seats and the
// derived keys. Also reads the signer contract's code hash and access keys.
import { readFileSync } from 'node:fs';
import { StrKey } from '@stellar/stellar-sdk';
import { recoverAddress, keccak256, toHex } from 'viem';
import nacl from 'tweetnacl';
const { edKey, edSign, secpAddr, secpSign, nearTxs, SIGNER, metamask } = await import('./nearsig.ts');
const { rpc } = await import('./near.ts');
const stn = JSON.parse(readFileSync('state-stn.json', 'utf8'));
const acct = await rpc('query', { request_type: 'view_account', finality: 'final', account_id: SIGNER });
const keys = await rpc('query', { request_type: 'view_access_key_list', finality: 'final', account_id: SIGNER });
console.log('signer', SIGNER, 'code_hash', acct.code_hash, 'access keys', keys.keys.map((k: any) => typeof k.access_key.permission === 'string' ? k.access_key.permission : 'FunctionCall').join(','));
const msg = new TextEncoder().encode(`prime proof ${new Date().toISOString()}`);
for (const [w, seat] of [['MetaMask', stn.G_mm], ['Freighter', stn.G_fr], ['Phantom', stn.G_ph]] as const) {
  const path = 'prime:stellar';
  if (w === 'Freighter') { console.log('Freighter on Stellar uses its own key; seat', seat); continue; }
  const k = await edKey(w, path);
  const G = StrKey.encodeEd25519PublicKey(Buffer.from(k));
  const sig = await edSign(w, path, msg);
  console.log(`${w} -> NEAR MPC ed25519 (Stellar seat) key ${G} == on-chain seat ${seat}: ${G === seat}; signature verifies: ${nacl.sign.detached.verify(msg, sig, k)}; NEAR tx ${nearTxs.at(-1)}`);
}
const h = keccak256(toHex(msg));
for (const w of ['Freighter', 'Phantom'] as const) {
  const a = await secpAddr(w, 'prime:evm'); const s = await secpSign(w, 'prime:evm', h);
  console.log(`${w} -> NEAR MPC secp256k1 (EVM) address ${a}; recovers: ${(await recoverAddress({ hash: h, signature: s })) === a}; NEAR tx ${nearTxs.at(-1)}`);
}
console.log('MetaMask EVM address (own key)', metamask.address);
process.exit(0);
