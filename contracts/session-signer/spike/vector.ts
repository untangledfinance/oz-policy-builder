import { privateKeyToAccount } from 'viem/accounts';
import { hashTypedData, sha256, toBytes } from 'viem';
import { DOMAIN, TYPES } from './eip712.ts';
// Fixed, public test key (never funded anywhere).
const pk = '0x' + '42'.repeat(32) as `0x${string}`;
const acct = privateKeyToAccount(pk);
const message = { account: 'CD77AAD766IG4U64GIBCFHTQMCOX65FSDMP3CNPB75PSNEOFLX4G32RB', sessionKey: ('0x' + '11'.repeat(32)) as `0x${string}`, validUntil: 1000, network: sha256(toBytes('Test SDF Network ; September 2015')) };
const digest = hashTypedData({ domain: DOMAIN, types: TYPES, primaryType: 'PrimeSession', message });
const sig = await acct.signTypedData({ domain: DOMAIN, types: TYPES, primaryType: 'PrimeSession', message });
console.log(JSON.stringify({ owner: acct.address, network: message.network, digest, sig }, null, 1));
