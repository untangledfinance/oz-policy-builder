import { privateKeyToAccount } from 'viem/accounts';
import { hashTypedData, sha256, toBytes } from 'viem';
import { signTypedData, SignTypedDataVersion } from '@metamask/eth-sig-util';
import { DOMAIN, TYPES } from './eip712.ts';
// Fixed, public test key (never funded anywhere).
const pk = ('0x' + '42'.repeat(32)) as `0x${string}`;
const message = { signer: 'CDRLTNNG2APUPPWNWZBVMUYRVWFJLQIN5LTAPILC7ZD6G6MGI2XJFVWN', sessionKey: ('0x' + '11'.repeat(32)) as `0x${string}`, validUntil: 1000, network: sha256(toBytes('Test SDF Network ; September 2015')) };
const digest = hashTypedData({ domain: DOMAIN, types: TYPES, primaryType: 'PrimeSession', message });
const sig = await privateKeyToAccount(pk).signTypedData({ domain: DOMAIN, types: TYPES, primaryType: 'PrimeSession', message });
const mm = signTypedData({ privateKey: Buffer.from(pk.slice(2), 'hex'), version: SignTypedDataVersion.V4,
  data: { types: { EIP712Domain: [{ name: 'name', type: 'string' }, { name: 'version', type: 'string' }], ...TYPES } as any, primaryType: 'PrimeSession', domain: DOMAIN, message } });
console.log(JSON.stringify({ owner: privateKeyToAccount(pk).address, digest, sig, metamaskLibIdentical: mm === sig }, null, 1));
