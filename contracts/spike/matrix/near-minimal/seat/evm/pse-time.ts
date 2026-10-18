// Vote sessions that end: expiry, revoke, and the vote flag bound by the owner's signature.
import { st, rpc, send, record, note, safeTx, byOwner, bySession, tokenTransfer, DEST, grant, revoke, sessionOf, now, MM, privateKeyToAccount, generatePrivateKey, encodeFunctionData, PK, grantText, type Address } from './pse-core.ts';
import { FR, PH } from './pse-setup.ts';

const t = tokenTransfer(DEST, 1n);
const safe = st.safe as Address;
const mine = async (secs: number) => { await rpc('evm_increaseTime', [secs]); await rpc('evm_mine', []); };

note('S. expiry');
{
  const s = await grant('E1. MetaMask grants a 100-second vote session', true, st.pkMM, MM, { seconds: 100n, vote: true });
  await safeTx(safe, 'E2. the session + Phantom: accepted while live', true, t, [bySession(s), byOwner(PH, st.pkPH)]);
  await mine(101);
  await safeTx(safe, 'E3. the same session + Phantom after its end', false, t, [bySession(s), byOwner(PH, st.pkPH)]);
  await safeTx(safe, 'E4. MetaMask owner + Phantom owner after that time: still accepted', true, t, [byOwner(MM, st.pkMM), byOwner(PH, st.pkPH)]);
}
note('S. revoke');
{
  const s = await grant('R1. MetaMask grants a 1-hour vote session', true, st.pkMM, MM, { vote: true });
  await safeTx(safe, 'R2. the session + Freighter: accepted', true, t, [bySession(s), byOwner(FR, st.pkFR)]);
  await revoke('R3. MetaMask revokes it (grant with end 0, one signature)', st.pkMM, MM, s.key.address);
  await safeTx(safe, 'R4. the revoked session + Freighter', false, t, [bySession(s), byOwner(FR, st.pkFR)]);
  await grant('R5. the same key granted again after the revoke (any end, vote flag set)', false, st.pkMM, MM, { key: s.key, vote: true });
  await safeTx(safe, 'R6. still refused after the failed re-grant', false, t, [bySession(s), byOwner(FR, st.pkFR)]);
  await safeTx(safe, 'R7. owner votes are unaffected (MetaMask + Freighter)', true, t, [byOwner(MM, st.pkMM), byOwner(FR, st.pkFR)]);
  const pre = privateKeyToAccount(generatePrivateKey());
  await revoke('R8. MetaMask revokes a key it never granted (pre-emptive)', st.pkMM, MM, pre.address);
  await grant('R9. that key can never be granted a vote session afterwards', false, st.pkMM, MM, { key: pre, vote: true });
}
note('S. the vote flag is bound by the owner signature');
{
  const key = privateKeyToAccount(generatePrivateKey()); const end = (await now()) + 3000n;
  await grant('F1. owner signed "moves only", submitted with vote = true', false, st.pkMM, MM, { key, end, vote: true, signedVote: false });
  await grant('F2. owner signed "moves and votes", submitted with vote = false', false, st.pkMM, MM, { key, end, vote: false, signedVote: true });
  const s0 = await grant('F3. move-only grant for the key (default)', true, st.pkMM, MM, { key, end, vote: false });
  await safeTx(safe, 'F4. that session + Freighter', false, t, [bySession(s0), byOwner(FR, st.pkFR)]);
  const s1 = await grant('F5. later grant for the same key, longer, with the vote flag (upgrade)', true, st.pkMM, MM, { key, end: end + 60n, vote: true });
  record('F6. stored: vote flag set, end extended', true, (await sessionOf(st.pkMM, key.address))[2] === true && (await sessionOf(st.pkMM, key.address))[0] === end + 60n, `${await sessionOf(st.pkMM, key.address)}`);
  await safeTx(safe, 'F7. that session + Freighter: accepted', true, t, [bySession(s1), byOwner(FR, st.pkFR)]);
  const s2 = await grant('F8. later grant, longer, without the flag (downgrade)', true, st.pkMM, MM, { key, end: end + 120n, vote: false });
  await safeTx(safe, 'F9. that session + Freighter after the downgrade', false, t, [bySession(s2), byOwner(FR, st.pkFR)]);
  await grant('F10. a grant with the same end and the vote flag (no extension) is refused', false, st.pkMM, MM, { key, end: end + 120n, vote: true });
}
