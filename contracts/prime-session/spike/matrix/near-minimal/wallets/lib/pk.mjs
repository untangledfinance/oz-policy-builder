import { mnemonicToAccount } from 'viem/accounts';
import { readFileSync } from 'node:fs';
export const evmPrivateKey = () => { const { srp } = JSON.parse(readFileSync('/home/ubuntu/work/wallet-matrix/real/secrets/wm.json', 'utf8')); return '0x' + Buffer.from(mnemonicToAccount(srp).getHdKey().privateKey).toString('hex'); };
