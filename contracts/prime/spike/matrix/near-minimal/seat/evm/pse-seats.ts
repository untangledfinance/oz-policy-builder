// Owner votes through the PrimeSession contracts, then vote sessions: accepted and refused cases.
import { pub, st, rpc, send, record, note, results, gasOf, ob, MM, safeTx, byOwner, bySession, byEoa, tokenTransfer, bal, DEST, E18, grant, revoke, sessionOf, now, safeAbi, tokenAbi, lc, CHAIN_ID, CONTRACTS,
  ownerCalls, isValidSigAbi, decodeFunctionData, keccak256, hashTypedData, privateKeyToAccount, generatePrivateKey, type PartFn, type Session, type Address, type Hex, encodeFunctionData } from './pse-core.ts';
import { metamask } from './pse-core.ts';
import { FR, PH } from './pse-setup.ts';

export const seats = [{ w: MM, pk: st.pkMM as Address }, { w: FR, pk: st.pkFR as Address }, { w: PH, pk: st.pkPH as Address }];
const [sMM, sFR, sPH] = seats;
const t = tokenTransfer(DEST, 1n);
const safe = st.safe as Address;

note('V. owner votes (contract signatures, v = 0)');
{
  const typed = (c: any) => ({ domain: { chainId: CHAIN_ID, verifyingContract: c.safe }, types: { SafeTx: [{ name: 'to', type: 'address' }, { name: 'value', type: 'uint256' }, { name: 'data', type: 'bytes' }, { name: 'operation', type: 'uint8' }, { name: 'safeTxGas', type: 'uint256' }, { name: 'baseGas', type: 'uint256' }, { name: 'gasPrice', type: 'uint256' }, { name: 'gasToken', type: 'address' }, { name: 'refundReceiver', type: 'address' }, { name: 'nonce', type: 'uint256' }] }, primaryType: 'SafeTx' as const, message: c.tx });
  // MetaMask votes the way it does today: eth_signTypedData_v4 of the SafeTx fields (readable in the wallet). Its digest is the Safe hash.
  const mmTyped: PartFn = async (c) => {
    const d = hashTypedData(typed(c)); if (d !== c.hash) throw new Error('typed-data digest differs from the Safe hash');
    return { owner: st.pkMM, sig: '0x', dynamic: await metamask.signTypedData(typed(c)) };
  };
  const r = await safeTx(safe, 'V1. MetaMask (typed data, as a seat vote today) + Freighter (MPC raw hash), both through their PrimeSession', true, t, [mmTyped, byOwner(FR, st.pkFR)]);
  const tx = results[results.length - 1].tx as Hex;
  const subs = (await ownerCalls(tx, [st.pkMM, st.pkFR, st.pkPH])).filter((s) => s.selector === '0x20c13b0b');
  const dec = subs.map((s) => decodeFunctionData({ abi: isValidSigAbi, data: s.input }).args as [Hex, Hex]);
  const dom = await pub.readContract({ address: safe, abi: safeAbi, functionName: 'domainSeparator' });
  record('V1b. the Safe calls each contract owner with isValidSignature(bytes,bytes) 0x20c13b0b by STATICCALL; data is 0x1901 | domainSeparator | SafeTx hash, 66 bytes, and keccak256(data) is the Safe transaction hash', true,
    subs.length === 2 && subs.every((s) => s.type === 'STATICCALL') && dec.every(([d, s]) => (d.length - 2) / 2 === 66 && d.startsWith('0x1901') && d.slice(6, 70) === dom.slice(2) && keccak256(d) === r.ctx.hash && (s.length - 2) / 2 === 65),
    `${subs.length} calls, ${subs.map((s) => s.type).join('/')}, gas ${subs.map((s) => s.gasUsed).join('/')}`);
  gasOf.isValidSignatureOwner = subs[0]!.gasUsed;
  await safeTx(safe, 'V2. Freighter + Phantom (both NEAR MPC, no MetaMask)', true, t, [byOwner(FR, st.pkFR), byOwner(PH, st.pkPH)]);
  await safeTx(safe, 'V3. Phantom + MetaMask', true, t, [byOwner(PH, st.pkPH), byOwner(MM, st.pkMM)]);
  const b = await bal(DEST);
  for (const s of seats) await safeTx(safe, `V4-${s.w.name}. ${s.w.name} alone`, false, t, [byOwner(s.w, s.pk)]);
  await safeTx(safe, 'V5. MetaMask + an outsider key (plain ECDSA entry)', false, t, [byOwner(MM, st.pkMM), byEoa(privateKeyToAccount(generatePrivateKey()))]);
  await safeTx(safe, "V6. MetaMask's key as a plain ECDSA owner entry + Freighter (the wallet key itself is no longer a Safe owner)", false, t, [byEoa(metamask as any), byOwner(FR, st.pkFR)]);
  await safeTx(safe, "V7. Freighter's signature under MetaMask's PrimeSession + Phantom's own", false, t, [async (c) => ({ owner: st.pkMM, sig: '0x', dynamic: await FR.signHash(c.hash) }), byOwner(PH, st.pkPH)]);
  await safeTx(safe, "V8. MetaMask's signature over another hash + Freighter", false, t, [async () => ({ owner: st.pkMM, sig: '0x', dynamic: await MM.signHash(keccak256('0x1234')) }), byOwner(FR, st.pkFR)]);
  // the eth_sign form Phantom's own EVM account would produce (personal_sign over the 32 raw bytes) is not a vote on a PrimeSession
  await safeTx(safe, "V10. MetaMask's personal_sign over the 32 raw bytes of the Safe hash (EIP-191 prefix) + Freighter", false, t, [async (c) => ({ owner: st.pkMM, sig: '0x', dynamic: await metamask.signMessage({ message: { raw: c.hash } }) }), byOwner(FR, st.pkFR)]);
  await safeTx(safe, "V11. the same signature with v + 4 (the Safe's own eth_sign marker) + Freighter", false, t, [async (c) => { const g = await metamask.signMessage({ message: { raw: c.hash } }); return { owner: st.pkMM, sig: '0x', dynamic: `${g.slice(0, -2)}${(parseInt(g.slice(-2), 16) + 4).toString(16)}` as Hex }; }, byOwner(FR, st.pkFR)]);
  record('V12. DEST received exactly 3 (the accepted transactions only)', true, (await bal(DEST)) - b === 0n && (await bal(DEST)) === 3n * E18, `${(await bal(DEST)) / E18}`);
}

note('S. vote sessions');
export const sv: Session[] = [], sm: Session[] = [];   // vote sessions and move-only sessions, one per wallet
for (const s of seats) {
  sv.push(await grant(`S0-${s.w.name}a. ${s.w.name} grants a 1-hour VOTE session (flag signed in the grant text)`, true, s.pk, s.w, { vote: true, tag: `grantVote${s.w.name}` }));
  sm.push(await grant(`S0-${s.w.name}b. ${s.w.name} grants a 1-hour move-only session`, true, s.pk, s.w, { vote: false, tag: `grantMoveOnly${s.w.name}` }));
}
st.sv = sv.map((s) => ({ pk: s.pk, key: s.key.address, end: s.end })); st.sm = sm.map((s) => ({ pk: s.pk, key: s.key.address, end: s.end }));
const other = (i: number) => seats[(i + 1) % 3]!;
for (const [i, s] of seats.entries()) {
  const o = other(i);
  await safeTx(safe, `S1-${s.w.name}. ${s.w.name}'s vote session + ${o.w.name}'s owner vote`, true, t, [bySession(sv[i]!), byOwner(o.w, o.pk)], { tag: i === 1 ? 'safeSO' : undefined });
}
for (const [i, s] of seats.entries()) {
  const o = other(i);
  await safeTx(safe, `S2-${s.w.name}. ${s.w.name}'s MOVE-ONLY session + ${o.w.name}'s owner vote`, false, t, [bySession(sm[i]!), byOwner(o.w, o.pk)]);
}
for (const [i, s] of seats.entries()) {
  await safeTx(safe, `S3-${s.w.name}a. ${s.w.name}'s owner vote + its own vote session (owner entry first)`, false, t, [byOwner(s.w, s.pk), bySession(sv[i]!)], { sort: false });
  await safeTx(safe, `S3-${s.w.name}b. ${s.w.name}'s own vote session + its owner vote (session entry first)`, false, t, [bySession(sv[i]!), byOwner(s.w, s.pk)], { sort: false });
}
note('S. duplicate-owner ordering rules, 3-of-3 Safe');
{
  const tri = st.tri as Address;
  const o = [...seats.map((s, i) => ({ ...s, i }))].sort((a, b) => (BigInt(a.pk) < BigInt(b.pk) ? -1 : 1)); // by address, as the Safe requires
  const [a, b, c] = o as [typeof o[0], typeof o[0], typeof o[0]];
  st.triOrder = o.map((x) => x.w.name);
  await safeTx(tri, `T1. three different contracts in address order: ${a.w.name} owner, ${b.w.name} owner, ${c.w.name} vote session`, true, t, [byOwner(a.w, a.pk), byOwner(b.w, b.pk), bySession(sv[c.i]!)], { sort: false });
  await safeTx(tri, `T2. ${a.w.name} owner, ${a.w.name} vote session, ${b.w.name} owner (same contract twice, adjacent)`, false, t, [byOwner(a.w, a.pk), bySession(sv[a.i]!), byOwner(b.w, b.pk)], { sort: false });
  await safeTx(tri, `T3. ${a.w.name} owner, ${b.w.name} owner, ${a.w.name} vote session (same contract again, after a larger address)`, false, t, [byOwner(a.w, a.pk), byOwner(b.w, b.pk), bySession(sv[a.i]!)], { sort: false });
  await safeTx(tri, `T4. ${a.w.name} owner, ${b.w.name} owner, ${b.w.name} vote session`, false, t, [byOwner(a.w, a.pk), byOwner(b.w, b.pk), bySession(sv[b.i]!)], { sort: false });
  await safeTx(tri, `T5. ${b.w.name} owner first, then ${a.w.name} owner (descending addresses), ${c.w.name} session`, false, t, [byOwner(b.w, b.pk), byOwner(a.w, a.pk), bySession(sv[c.i]!)], { sort: false });
  await safeTx(tri, `T6. ${a.w.name} owner + ${a.w.name} session + ${a.w.name} owner (three entries, one contract)`, false, t, [byOwner(a.w, a.pk), bySession(sv[a.i]!), byOwner(a.w, a.pk)], { sort: false });
}

note('S. session alone, wrong seat, strangers');
{
  await safeTx(safe, "S4. A vote session alone (one signature of the two needed)", false, t, [bySession(sv[0]!)]);
  await safeTx(safe, "S5. MetaMask's vote session under both MetaMask's and Freighter's PrimeSession", false, t, [bySession(sv[0]!), async (c) => ({ owner: st.pkFR, sig: '0x', dynamic: await sv[0]!.key.sign({ hash: c.hash }) })]);
  for (const [i, s] of seats.entries()) {
    const b = other(i), c3 = other(i + 1);
    await safeTx(safe, `S6-${s.w.name}. ${s.w.name}'s vote session presented for ${b.w.name}'s seat + ${c3.w.name}'s owner vote`, false, t,
      [async (c) => ({ owner: b.pk, sig: '0x', dynamic: await sv[i]!.key.sign({ hash: c.hash }) }), byOwner(c3.w, c3.pk)]);
  }
  await safeTx(safe, "S7. A stranger key under MetaMask's PrimeSession + Freighter's owner vote", false, t, [bySession({ pk: st.pkMM, key: privateKeyToAccount(generatePrivateKey()) }), byOwner(FR, st.pkFR)]);
  await safeTx(safe, "S8. A session key's signature in the plain ECDSA slot (as an EOA owner) + Freighter", false, t, [byEoa(sv[0]!.key), byOwner(FR, st.pkFR)]);
}
