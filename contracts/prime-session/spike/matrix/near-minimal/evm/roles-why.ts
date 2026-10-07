// Ran against the round-7 live deployment (the contract was then named PrimeKey).
import { encodeFunctionData, parseAbi, parseEther } from 'viem';
import { readFileSync } from 'node:fs';
const st = JSON.parse(readFileSync('state-pkn-live.json', 'utf8'));
const abi = parseAbi(['function execTransactionWithRole(address,uint256,bytes,uint8,bytes32,bool) returns (bool)', 'function transfer(address,uint256) returns (bool)']);
const t = (to: string, n: bigint) => encodeFunctionData({ abi, functionName: 'transfer', args: [to as any, n * 10n ** 18n] });
const venue = (st.results as any[]).length && JSON.parse(readFileSync('state-pkn-live.json','utf8')).venue;
const call = async (rpc: string, from: string, data: string) => (await (await fetch(rpc, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_call', params: [{ from, to: st.roles, data }, 'latest'] }) })).json());
const ROLES: Record<number, string> = { 2: 'TargetAddressNotAllowed', 3: 'FunctionNotAllowed', 7: 'ParameterNotAllowed', 17: 'AllowanceExceeded' };
const show = (r: any) => { const d: string = r.error?.data ?? r.result ?? ''; if (/^0xd0a9bf58/.test(d)) return `ConditionViolation(${ROLES[parseInt(d.slice(10, 74), 16)] ?? parseInt(d.slice(10, 74), 16)}) ${d.slice(0, 10)}`; if (/^0xfd8e9f28/.test(d)) return 'NoMembership 0xfd8e9f28'; return JSON.stringify(r).slice(0, 200); };
const rk = st.roleKey;
const other = '0x000000000000000000000000000000000000dEaD';
for (const rpc of ['https://sepolia.base.org', 'https://base-sepolia-rpc.publicnode.com']) {
  console.log('rpc', rpc);
  console.log(' stranger calls Roles:', show(await call(rpc, other, encodeFunctionData({ abi, functionName: 'execTransactionWithRole', args: [st.token, 0n, t(other, 1n), 0, rk, true] }))));
  console.log(' PrimeKey(MetaMask) -> token transfer to another address:', show(await call(rpc, st.pkMM, encodeFunctionData({ abi, functionName: 'execTransactionWithRole', args: [st.token, 0n, t(other, 1n), 0, rk, true] }))));
  console.log(' PrimeKey(Freighter) -> delegatecall:', show(await call(rpc, st.pkFR, encodeFunctionData({ abi, functionName: 'execTransactionWithRole', args: [st.token, 0n, t(other, 1n), 1, rk, true] }))));
  console.log(' PrimeKey(Phantom) -> Safe addOwner:', show(await call(rpc, st.pkPH, encodeFunctionData({ abi, functionName: 'execTransactionWithRole', args: [st.safe, 0n, encodeFunctionData({ abi: parseAbi(['function addOwnerWithThreshold(address,uint256)']), functionName: 'addOwnerWithThreshold', args: [other, 1n] }), 0, rk, true] }))));
}
console.log(Object.keys(st).filter((k) => k !== 'results').join(','));
