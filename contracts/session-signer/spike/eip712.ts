import { keccak256, toBytes, hashDomain } from 'viem';
export const DOMAIN = { name: 'Prime Session', version: '1' } as const;
export const TYPES = { PrimeSession: [
  { name: 'account', type: 'string' }, { name: 'sessionKey', type: 'bytes32' },
  { name: 'validUntil', type: 'uint32' }, { name: 'network', type: 'bytes32' } ] } as const;
if (import.meta.main) {
  const th = keccak256(toBytes('PrimeSession(string account,bytes32 sessionKey,uint32 validUntil,bytes32 network)'));
  const ds = hashDomain({ domain: DOMAIN, types: { EIP712Domain: [{ name: 'name', type: 'string' }, { name: 'version', type: 'string' }] } });
  const arr = (h: string) => '[' + (h.slice(2).match(/../g)!.map((b) => '0x' + b).join(', ')) + ']';
  console.log('TYPEHASH', th, '\n', arr(th)); console.log('DOMAIN', ds, '\n', arr(ds));
}
