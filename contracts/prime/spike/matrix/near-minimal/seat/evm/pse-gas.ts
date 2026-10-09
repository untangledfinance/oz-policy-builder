// Gas: one Safe vote by an owner and by a session against a plain-key Safe, and the new PrimeSession against the production one.
import { st, pub, send, record, note, results, gasOf, safeTx, byOwner, byEoa, bySession, tokenTransfer, DEST, MM, now, grantText, PK, BASE, execHash, sessionOf, VENUE, ownerCalls, execData, prepare, pack, grant,
  encodeFunctionData, privateKeyToAccount, generatePrivateKey, type Address, type Hex } from './pse-core.ts';
import { FR } from './pse-setup.ts';
import { sv } from './pse-seats.ts';
import { plainKeys } from './pse-setup.ts';

note('GAS. a Safe vote: plain keys, owner contracts, session contracts (second transaction on each Safe, warm state)');
const t = tokenTransfer(DEST, 1n);
const sizes: Record<string, number> = {};
const sub: Record<string, string> = {};
async function pair(label: string, safe: Address, parts: any[]) {
  await safeTx(safe, `GAS-${label}1. warm-up transaction`, true, t, parts);
  const r = await safeTx(safe, `GAS-${label}2. measured transaction`, true, t, parts, { tag: label });
  sizes[label] = (execData(r.ctx, pack(r.parts)).length - 2) / 2;
  const tx = results[results.length - 1].tx as Hex;
  const subs = (await ownerCalls(tx, [st.pkMM, st.pkFR, st.pkPH, st.ngMM, st.ngFR, st.ngPH])).filter((s) => s.selector === '0x20c13b0b');
  sub[label] = subs.map((s) => s.gasUsed).join('+');
}
await pair('plain', st.plain, [byEoa(plainKeys[0]!), byEoa(plainKeys[1]!)]);
await pair('ownerOwner', st.safe, [byOwner(MM, st.pkMM), byOwner(FR, st.pkFR)]);
await pair('sessionOwner', st.safe, [bySession(sv[1]!), byOwner(MM, st.pkMM)]);
await pair('sessionSession', st.safe, [bySession(sv[0]!), bySession(sv[1]!)]);
st.gasSafeVote = { plain: gasOf.plain, ownerOwner: gasOf.ownerOwner, sessionOwner: gasOf.sessionOwner, sessionSession: gasOf.sessionSession, noGovSessionOwner: gasOf.safeNoGovSO, calldataBytes: sizes, ownerSubcalls: sub };
record('GAS0. numbers collected', true, true, `plain ${gasOf.plain}, owner+owner ${gasOf.ownerOwner}, session+owner ${gasOf.sessionOwner}, session+session ${gasOf.sessionSession}, no-gov session+owner ${gasOf.safeNoGovSO}`);

note('GAS. PrimeSession against the production PrimeSession (same owner, same Roles rule)');
{
  const run = async (pk: Address, abi: any, label: string, newAbi: boolean, vote = false) => {
    const key = privateKeyToAccount(generatePrivateKey()); const end = (await now()) + 3600n;
    const text = (await pub.readContract({ address: pk, abi, functionName: 'grantText', args: newAbi ? [key.address, end, vote] : [key.address, end] })) as string;
    const sig = await MM.personalSign(text);
    await send(`GAS-${label}-grant`, true, pk, encodeFunctionData({ abi, functionName: 'grant', args: newAbi ? [key.address, end, vote, sig] : [key.address, end, sig] } as any), { tag: `${label}Grant${vote ? 'Vote' : ''}` });
    for (const n of [0n, 1n]) {
      const call = tokenTransfer(VENUE, 1n);
      await send(`GAS-${label}-move${n + 1n}`, true, pk, encodeFunctionData({ abi, functionName: 'exec', args: [call.to, 0n, call.data, 0, st.roleKey, key.address, await key.sign({ hash: execHash(pk, n, call) })] }), { tag: `${label}Move${n + 1n}${vote ? 'Vote' : ''}` });
    }
  };
  await run(st.pkBase, BASE.abi, 'production', false);
  await run(st.pkMM, PK.abi, 'seatSpike', true, false);
  await run(st.pkMM, PK.abi, 'seatSpike', true, true);
}
st.gasSession = Object.fromEntries(Object.entries(gasOf).filter(([k]) => /^(production|seatSpike)/.test(k)));
