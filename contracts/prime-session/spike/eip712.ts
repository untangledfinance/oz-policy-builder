import { keccak256, toBytes, hashDomain } from 'viem';
export const DOMAIN = { name: 'Prime Session', version: '1' } as const;
/** `signer` is the session-signer contract (bound to one Prime Account); validUntil 0 = revoke. */
export const TYPES = { PrimeSession: [
  { name: 'signer', type: 'string' }, { name: 'sessionKey', type: 'bytes32' },
  { name: 'validUntil', type: 'uint32' }, { name: 'network', type: 'bytes32' } ] } as const;
if (import.meta.main) {
  const th = keccak256(toBytes('PrimeSession(string signer,bytes32 sessionKey,uint32 validUntil,bytes32 network)'));
  const ds = hashDomain({ domain: DOMAIN, types: { EIP712Domain: [{ name: 'name', type: 'string' }, { name: 'version', type: 'string' }] } });
  console.log(th, ds);
}
