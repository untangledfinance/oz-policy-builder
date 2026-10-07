import { signTypedData, SignTypedDataVersion, recoverTypedSignature } from '@metamask/eth-sig-util';
import { privateKeyToAccount } from 'viem/accounts';
import { sha256, toBytes } from 'viem';
import { DOMAIN, TYPES } from './eip712.ts';
const pk = '0x' + '42'.repeat(32) as `0x${string}`; // public test key from the Rust vector
const message = { account: 'CD77AAD766IG4U64GIBCFHTQMCOX65FSDMP3CNPB75PSNEOFLX4G32RB', sessionKey: '0x' + '11'.repeat(32), validUntil: 1000, network: sha256(toBytes('Test SDF Network ; September 2015')) };
const typed = { types: { EIP712Domain: [{ name: 'name', type: 'string' }, { name: 'version', type: 'string' }], ...TYPES }, primaryType: 'PrimeSession', domain: DOMAIN, message } as any;
const mm = signTypedData({ privateKey: Buffer.from(pk.slice(2), 'hex'), data: typed, version: SignTypedDataVersion.V4 });
const viem = await privateKeyToAccount(pk).signTypedData({ domain: DOMAIN, types: TYPES, primaryType: 'PrimeSession', message: message as any });
console.log({ identical: mm === viem, metamaskLib: mm.slice(0, 20) + '…', rustVector: '0xc5dae286ff48…', recovered: recoverTypedSignature({ data: typed, signature: mm, version: SignTypedDataVersion.V4 }) });
