import { mnemonicToAccount } from 'viem/accounts';
import { readFileSync, writeFileSync } from 'node:fs';
const H='/home/ubuntu/work/wallet-matrix/real';
const { srp } = JSON.parse(readFileSync(`${H}/secrets/wm.json`,'utf8')); const a = mnemonicToAccount(srp);
const P = JSON.parse(readFileSync(`${H}/payloads/evm.json`,'utf8'));
writeFileSync(`${H}/out/selftest.evm.json`, JSON.stringify({ address: a.address,
  grant: await a.signMessage({ message: P.grantText }), near: await a.signMessage({ message: P.nearText }),
  typed: await a.signTypedData({ domain: P.typed.domain, types: { SafeTx: P.typed.types.SafeTx }, primaryType: 'SafeTx', message: { to: P.typed.message.to, value: 1000n, data: '0x', operation: 0, safeTxGas: 0n, baseGas: 0n, gasPrice: 0n, gasToken: P.typed.message.gasToken, refundReceiver: P.typed.message.refundReceiver, nonce: 0n } }),
  ethSign: await a.signMessage({ message: { raw: P.safeTxHash } }) }));
