// Offline-style verification of one EVM wallet's signatures with the same checks the contracts use:
//   PrimeSession.grant (OpenZeppelin recover over the EIP-191 digest of the grant text) and Safe 1.4.1 checkNSignatures.
import { createPublicClient, http, getAddress, hashMessage, recoverAddress, hexToBytes, parseAbi, type Hex } from 'viem';
import { baseSepolia } from 'viem/chains';
import { readFileSync, writeFileSync } from 'node:fs';
const H = '/home/ubuntu/work/wallet-matrix/real';
const name = process.argv[2];
const P = JSON.parse(readFileSync(`${H}/payloads/evm.json`, 'utf8'));
const S = JSON.parse(readFileSync(`${H}/out/${name}.evm.json`, 'utf8'));
const art = JSON.parse(readFileSync('/home/ubuntu/work/prime-evm/out/PrimeSession.sol/PrimeSession.json', 'utf8'));
const pub = createPublicClient({ chain: baseSepolia, transport: http(P.rpc) });
const safeAbi = parseAbi(['function checkNSignatures(bytes32 dataHash, bytes data, bytes signatures, uint256 requiredSignatures) view']);
const res: Record<string, string> = {};
const rec = (k: string, ok: boolean, why = '') => { res[k] = (ok ? 'PASS' : 'FAIL') + (why ? ` ${why}` : ''); console.log(name, k, res[k]); };
const rpc = (method: string, params: unknown[] = []) => fetch(P.rpc, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) }).then((r) => r.json());
const swap = (sig: Hex, v: number) => (sig.slice(0, 130) + v.toString(16).padStart(2, '0')) as Hex;
const vOf = (sig: Hex) => parseInt(sig.slice(130, 132), 16);
const norm = (sig: Hex) => (vOf(sig) < 27 ? swap(sig, vOf(sig) + 27) : sig);
const owner = getAddress(P.owner);
const rcv = async (hash: Hex, sig: Hex) => getAddress(await recoverAddress({ hash, signature: sig }));
if (S.address) rec('address', getAddress(S.address) === owner, `${S.address}`);
// 1. grant text (personal_sign over the UTF-8 text) accepted by the real PrimeSession.grant
if (S.grant) {
  const sig = S.grant as Hex;
  rec('grant: recovers to owner (EIP-191 over text)', (await rcv(hashMessage(P.grantText), sig)) === owner);
  const snap = (await rpc('evm_snapshot')).result;
  const call = (end: string, s: Hex) => pub.simulateContract({ address: P.session, abi: art.abi, functionName: 'grant', args: [P.key, BigInt(end), s], account: '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266' });
  try { await call(P.end, sig); rec('grant: PrimeSession.grant accepts it', true); } catch (e: any) { rec('grant: PrimeSession.grant accepts it', false, String(e.shortMessage ?? e).slice(0, 100)); }
  try { await call((BigInt(P.end) + 1n).toString(), sig); rec('grant: changed end refused (control)', false); } catch (e: any) { rec('grant: changed end refused (control)', /grant sig/.test(String(e.message)), 'grant sig'); }
  await rpc('evm_revert', [snap]);
}
// 2. prime-near-signer text via personal_sign: EIP-191 recover
if (S.near) rec('near text: recovers to owner (EIP-191 over text)', (await rcv(hashMessage(P.nearText), S.near as Hex)) === owner);
// 3. Safe vote as EIP-712 SafeTx (v 27/28), checked by Safe.checkNSignatures
const check = (h: Hex, sig: Hex) => pub.simulateContract({ address: P.safe, abi: safeAbi, functionName: 'checkNSignatures', args: [h, '0x', sig, 1n], account: '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266' });
if (S.typed) {
  const sig = norm(S.typed as Hex);
  rec('typed: recovers to owner over the SafeTx hash', (await rcv(P.safeTxHash, sig)) === owner);
  try { await check(P.safeTxHash, sig); rec('typed: Safe.checkNSignatures accepts (EIP-712 vote)', true); } catch (e: any) { rec('typed: Safe.checkNSignatures accepts (EIP-712 vote)', false, String(e.shortMessage ?? e).slice(0, 100)); }
  try { await check(('0x' + '11'.repeat(32)) as Hex, sig); rec('typed: other hash refused (control)', false); } catch { rec('typed: other hash refused (control)', true); }
}
// 4. Safe vote as personal_sign over the 32 raw hash bytes, filed as eth_sign type (v + 4)
if (S.ethSign) {
  const sig = norm(S.ethSign as Hex);
  rec('eth_sign: recovers to owner over EIP-191(32 raw bytes)', (await rcv(hashMessage({ raw: hexToBytes(P.safeTxHash) }), sig)) === owner);
  try { await check(P.safeTxHash, swap(sig, vOf(sig) + 4)); rec('eth_sign: Safe.checkNSignatures accepts (v + 4)', true); } catch (e: any) { rec('eth_sign: Safe.checkNSignatures accepts (v + 4)', false, String(e.shortMessage ?? e).slice(0, 100)); }
}
writeFileSync(`${H}/out/${name}.evm.verify.json`, JSON.stringify(res, null, 1));
process.exit(0);
