// Setup: the Prime Account with three PrimeSession owners, plus the side Safes the checks need.
import { pub, st, save, send, deploy, record, note, makeSafe, deploy as _d, ob, pol, CONTRACTS, PK, NG, BASE, TK, MM, viaNear, E18, VENUE, tokenAbi, safeAbi, encodeFunctionData, parseAbi, keccak256, toHex, lc,
  privateKeyToAccount, generatePrivateKey, type Hex, type Address, CHAIN_ID } from './pse-core.ts';

export const FR = await viaNear('Freighter'), PH = await viaNear('Phantom');
console.log('owners (MetaMask own key; Freighter and Phantom prime:evm-session MPC keys):', MM.addr, FR.addr, PH.addr);

note('C. setup');
{ // what Safe L2 1.4.1 on Base Sepolia calls on a contract owner: the legacy bytes variant (0x20c13b0b), with a GS027 hash check
  const code = (await pub.getCode({ address: CONTRACTS.safeL2 }))!;
  record('C0. Safe L2 1.4.1 code carries the legacy ERC-1271 selector 0x20c13b0b and GS027, and not the bytes32 selector 0x1626ba7e', true,
    code.includes('20c13b0b') && code.includes(Buffer.from('GS027').toString('hex')) && !code.includes('1626ba7e'), `${(code.length - 2) / 2} bytes`);
}
st.token = await deploy(TK);
const proxyCreationCode = await pub.readContract({ address: CONTRACTS.safeProxyFactory, abi: parseAbi(['function proxyCreationCode() view returns (bytes)']), functionName: 'proxyCreationCode' }) as Hex;
const initializer = ob.encodeSafeInitializer([MM.addr], 1n, CONTRACTS.compatibilityFallbackHandler);
const salt = BigInt(keccak256(toHex(`pse-${Date.now()}`)));
st.safe = ob.predictSafeAddress(proxyCreationCode, initializer, salt); st.roles = ob.predictPrimeRolesAddress(st.safe);
st.pkMM = await deploy(PK, [MM.addr, st.roles], 'deploy'); st.pkFR = await deploy(PK, [FR.addr, st.roles]); st.pkPH = await deploy(PK, [PH.addr, st.roles]);
st.pkBase = await deploy(BASE, [MM.addr, st.roles], 'deployBase');          // production PrimeSession, for gas comparison only
const doc = { spendingLimit: 1 as const, token: st.token, recipients: [VENUE], amount: (100n * E18).toString(), period: '86400' };
const rule = pol.buildRuleInstall({ doc, docText: JSON.stringify(doc), name: 'movers', ctx: { prime: st.safe, primeRoles: st.roles }, proxyCreationCode, wallets: [st.pkMM, st.pkFR, st.pkPH, st.pkBase], threshold: 1 });
st.roleKey = rule.roleKey; save();
const c = ob.encodeCreateSafe(initializer, salt);
await send('C1. create the Safe with MetaMask as its only owner (PrimeX flow)', true, c.to, c.data);
// MetaMask's key signs the first transaction alone: add the FR and PH seats, threshold 2, Roles + rule, and swap its own key for its PrimeSession.
const swap = { to: st.safe as Address, value: 0n, operation: 0 as const, data: encodeFunctionData({ abi: safeAbi, functionName: 'swapOwner', args: [st.pkFR, MM.addr, st.pkMM] }) };
const init = ob.buildSafeInitializationTransaction(st.safe, [st.pkFR, st.pkPH], 2n, [...rule.calls, swap]);
await send('C2. first transaction: owners become the three PrimeSession contracts, threshold 2, Roles with the movers rule for the PrimeSessions', true, st.safe,
  ob.encodeExecTransaction(init, await MM.signHash(ob.hashSafeTransaction(CHAIN_ID, st.safe, init))), { tag: 'setupSafe' });
{ const owners = (await pub.readContract({ address: st.safe, abi: safeAbi, functionName: 'getOwners' }) as Address[]).map(lc);
  const thr = await pub.readContract({ address: st.safe, abi: safeAbi, functionName: 'getThreshold' });
  record('C3. Safe owners are exactly the three PrimeSession contracts (no wallet key), threshold 2', true,
    owners.length === 3 && [st.pkMM, st.pkFR, st.pkPH].every((a) => owners.includes(lc(a))) && !owners.includes(lc(MM.addr)) && thr === 2n, `${owners.length} owners / ${thr}`); }
await send('C4. mint 1000 tokens to the Safe', true, st.token, encodeFunctionData({ abi: tokenAbi, functionName: 'mint', args: [st.safe, 1000n * E18] }));

note('C. side Safes');
const owners3 = [st.pkMM, st.pkFR, st.pkPH] as Address[];
export const plainKeys = [0, 1, 2].map(() => privateKeyToAccount(generatePrivateKey()));
st.plain = await makeSafe('plain-key', plainKeys.map((k) => k.address), 2);   // the baseline: three ordinary keys
st.tri = await makeSafe('three-of-three', owners3, 3);                         // duplicate-owner ordering rules
st.ra = await makeSafe('replay-A', owners3, 2);                                // replay across Safes: A and B are identical
st.rb = await makeSafe('replay-B', owners3, 2);
st.danger = await makeSafe('danger', owners3, 2);                              // owner swap by a vote session
st.dangerTwo = await makeSafe('danger-two-sessions', owners3, 2);
st.ngMM = await deploy(NG, [MM.addr, st.roles], 'deployNoGov'); st.ngFR = await deploy(NG, [FR.addr, st.roles]); st.ngPH = await deploy(NG, [PH.addr, st.roles]);
st.ng = await makeSafe('no-governance', [st.ngMM, st.ngFR, st.ngPH], 2);        // the variant's three owners
save();
