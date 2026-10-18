// The dangerous case (a vote session plus one other owner is a 2-of-3), Safe messages, and the no-governance variant.
import { st, deploy, PK, makeSafe, send, record, note, pub, prepare, safeTx, byOwner, byEoa, bySession, bySessionWithFields, txWords, tokenTransfer, bal, DEST, E18, MM, grant, safeAbi, tokenAbi, ob, CONTRACTS, concat, keccak256, toHex, pack,
  encodeFunctionData, parseAbi, ATTACKER, SENTINEL, ZERO, fresh, lc, gasOf, results, ownerCalls, execData, sessionOf, privateKeyToAccount, generatePrivateKey, encodeAbiParameters, type Address, type Hex, type PartFn, type Call } from './pse-core.ts';
import { FR, PH } from './pse-setup.ts';
import { sv, sm } from './pse-seats.ts';

const safeCall = (to: Address, name: 'addOwnerWithThreshold' | 'removeOwner' | 'swapOwner' | 'changeThreshold' | 'enableModule' | 'setGuard', args: any[]): Call => ({ to, value: 0n, operation: 0, data: encodeFunctionData({ abi: safeAbi, functionName: name, args } as any) });
const owners = async (s: Address) => (await pub.readContract({ address: s, abi: safeAbi, functionName: 'getOwners' }) as Address[]);

note('D. the dangerous case: a vote session and one other owner are a 2-of-3');
{
  const d = st.danger as Address;
  await safeTx(d, "D1. Freighter's vote session + MetaMask's owner vote: addOwnerWithThreshold(attacker, 1) on the Safe itself", true, safeCall(d, 'addOwnerWithThreshold', [ATTACKER.address, 1n]), [bySession(sv[1]!), byOwner(MM, st.pkMM)]);
  const o1 = (await owners(d)).map(lc), thr = await pub.readContract({ address: d, abi: safeAbi, functionName: 'getThreshold' });
  record('D2. the Safe now has 4 owners including the attacker, threshold 1', true, o1.length === 4 && o1.includes(lc(ATTACKER.address)) && thr === 1n, `${o1.length} owners / ${thr}`);
  const b = await bal(ATTACKER.address);
  await safeTx(d, 'D3. the attacker alone moves all 1000 tokens out', true, tokenTransfer(ATTACKER.address, 1000n), [byEoa(ATTACKER)]);
  record('D4. the attacker holds 1000 tokens', true, (await bal(ATTACKER.address)) - b === 1000n * E18, `${(await bal(ATTACKER.address)) / E18}`);
  for (const pk of [st.pkMM, st.pkFR, st.pkPH] as Address[]) {
    const list = await owners(d), i = list.findIndex((a) => lc(a) === lc(pk)), prev = i === 0 ? SENTINEL : list[i - 1]!;
    await safeTx(d, `D5. the attacker removes ${pk.slice(0, 8)}… (a wallet's seat)`, true, safeCall(d, 'removeOwner', [prev, pk, 1n]), [byEoa(ATTACKER)]);
  }
  const o2 = (await owners(d)).map(lc);
  record('D6. the three wallets are locked out: the attacker is the only owner', true, o2.length === 1 && o2[0] === lc(ATTACKER.address), o2.join(','));
  // the same try with a move-only session
  await safeTx(st.dangerTwo, "D7. Freighter's MOVE-ONLY session + MetaMask's owner vote: addOwnerWithThreshold(attacker, 1)", false, safeCall(st.dangerTwo, 'addOwnerWithThreshold', [ATTACKER.address, 1n]), [bySession(sm[1]!), byOwner(MM, st.pkMM)]);
  // two vote sessions need no wallet at all
  const e = st.dangerTwo as Address;
  await safeTx(e, 'D8. two vote sessions (MetaMask and Freighter) alone: all 1000 tokens to the attacker, no wallet prompt', true, tokenTransfer(ATTACKER.address, 1000n), [bySession(sv[0]!), bySession(sv[1]!)]);
  await safeTx(e, 'D9. the same two vote sessions: addOwnerWithThreshold(attacker, 1)', true, safeCall(e, 'addOwnerWithThreshold', [ATTACKER.address, 1n]), [bySession(sv[0]!), bySession(sv[1]!)]);
}

note('M. Safe messages (EIP-1271 on the Safe itself) accept the same signatures');
const msgCheck = async (name: string, expectOk: boolean, safe: Address, dataHash: Hex, parts: PartFn[]) => {
  const message = encodeAbiParameters([{ type: 'bytes32' }], [dataHash]);
  const hash = await pub.readContract({ address: safe, abi: safeAbi, functionName: 'getMessageHash', args: [message] });
  let ok = true, d = '';
  try { const ps = await Promise.all(parts.map((p) => p({ hash, safe, tx: undefined as any })));
    const r = await pub.readContract({ address: safe, abi: safeAbi, functionName: 'isValidSignature', args: [dataHash, pack(ps)] }); ok = r === '0x1626ba7e'; d = String(r); }
  catch (e: any) { ok = false; d = String(e?.shortMessage ?? e).replace(/\s+/g, ' ').match(/(GS\d{3}|reverted with reason string '[^']*'|reverted[^.]*)/)?.[0] ?? 'reverted'; }
  return record(name, expectOk, ok, d);
};
{
  const m = keccak256(toHex('a Permit2-style order the Safe signs off chain'));
  await msgCheck('M1. two owners sign a Safe message (control)', true, st.safe, m, [byOwner(MM, st.pkMM), byOwner(FR, st.pkFR)]);
  await msgCheck("M2. Freighter's vote session + MetaMask's owner sign a Safe message", true, st.safe, m, [bySession(sv[1]!), byOwner(MM, st.pkMM)]);
  await msgCheck("M3. Freighter's MOVE-ONLY session + MetaMask's owner sign a Safe message", false, st.safe, m, [bySession(sm[1]!), byOwner(MM, st.pkMM)]);
}

note('NG. no-governance variant: a vote session must show the Safe transaction and it may not govern');
{
  const ng = st.ng as Address;
  const s = await grant('NG0. Freighter grants a vote session on its no-governance PrimeSession', true, st.ngFR, FR, { vote: true });
  const owner: PartFn = byOwner(MM, st.ngMM);
  const vote = bySessionWithFields(s);
  const plain = tokenTransfer(DEST, 1n);
  await safeTx(ng, 'NG1. vote session (signature + tx fields) + MetaMask owner: a token transfer', true, plain, [vote, owner]);
  const ng2 = await safeTx(ng, 'NG2. vote session + MetaMask owner: a token transfer again', true, plain, [vote, owner], { tag: 'safeNoGovSO' });
  st.noGovCalldataBytes = (execData(ng2.ctx, pack(ng2.parts)).length - 2) / 2;
  await safeTx(ng, 'NG3. the same session without the tx fields', false, plain, [bySession(s), owner]);
  const gov: [string, Call][] = [
    ['addOwnerWithThreshold(attacker, 1)', safeCall(ng, 'addOwnerWithThreshold', [ATTACKER.address, 1n])],
    ['changeThreshold(1)', safeCall(ng, 'changeThreshold', [1n])],
    ['swapOwner', safeCall(ng, 'swapOwner', [SENTINEL, st.ngMM, fresh()])],
    ['removeOwner', safeCall(ng, 'removeOwner', [SENTINEL, st.ngMM, 1n])],
    ['enableModule(attacker)', safeCall(ng, 'enableModule', [ATTACKER.address])],
    ['setGuard(attacker)', safeCall(ng, 'setGuard', [ATTACKER.address])],
    ['a call to the Roles modifier', { to: st.roles, value: 0n, operation: 0, data: encodeFunctionData({ abi: parseAbi(['function assignRoles(address,bytes32[],bool[])']), functionName: 'assignRoles', args: [ATTACKER.address, [st.roleKey], [true]] }) }],
    ['a delegatecall', { ...plain, operation: 1 }],
    ['a MultiSend batch (delegatecall) with addOwnerWithThreshold inside', ob.buildConfigBatch([safeCall(ng, 'addOwnerWithThreshold', [ATTACKER.address, 1n])])],
  ];
  for (const [n, call] of gov) await safeTx(ng, `NG4. vote session + MetaMask owner: ${n}`, false, call, [vote, owner]);
  // a session that lies about the transaction: signs the governance hash but sends the fields of a harmless transfer
  await safeTx(ng, 'NG5. vote session signs addOwnerWithThreshold but supplies the fields of a token transfer', false, gov[0]![1], [async (c) => ({ owner: st.ngFR, sig: '0x', dynamic: concat([await s.key.sign({ hash: c.hash }), txWords({ ...plain, safeTxGas: 0n, baseGas: 0n, gasPrice: 0n, gasToken: ZERO, refundReceiver: ZERO, nonce: c.tx.nonce })]) }), owner]);
  const b = await bal(ATTACKER.address);
  await safeTx(ng, 'NG6. what stays possible: the vote session + MetaMask owner send 500 tokens to the attacker', true, tokenTransfer(ATTACKER.address, 500n), [vote, owner]);
  record('NG7. the attacker holds 500 more tokens', true, (await bal(ATTACKER.address)) - b === 500n * E18, `${((await bal(ATTACKER.address)) - b) / E18}`);
  const m = keccak256(toHex('a Permit2-style order'));
  const anyFields: PartFn = async (c) => ({ owner: st.ngFR, sig: '0x', dynamic: concat([await s.key.sign({ hash: c.hash }), txWords({ ...plain, safeTxGas: 0n, baseGas: 0n, gasPrice: 0n, gasToken: ZERO, refundReceiver: ZERO, nonce: 0n })]) });
  await msgCheck('NG8. the vote session cannot sign a Safe message (no SafeTx fields can match a message hash)', false, ng, m, [anyFields, owner]);
  await msgCheck('NG9. two owners can still sign a Safe message', true, ng, m, [owner, byOwner(FR, st.ngFR)]);
  await safeTx(ng, 'NG10. owners still govern: MetaMask + Freighter add an owner', true, safeCall(ng, 'addOwnerWithThreshold', [fresh(), 2n]), [owner, byOwner(FR, st.ngFR)]);
}

note('W. the Safe counts contracts, so onboarding must keep the three owner keys different');
{
  const dup = await deploy(PK, [MM.addr, st.roles]);               // a second PrimeSession with MetaMask's owner key
  const w = await makeSafe('duplicate-key', [st.pkMM, dup, st.pkFR], 2);
  await safeTx(w, 'W1. one MetaMask signature filed under two PrimeSessions that share its owner key: the Safe counts two votes', true, tokenTransfer(DEST, 1n), [byOwner(MM, st.pkMM), byOwner(MM, dup)]);
}
