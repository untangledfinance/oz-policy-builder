// The Roles moves of pkn.ts (grant, relayed and self-paid moves, replays, revoke, combined grant + move) on the new PrimeSession, plus cross-wallet grants.
import { st, rpc, send, record, note, pub, prepare, execData, pack, safeTx, byOwner, tokenTransfer, bal, VENUE, OTHER, DEST, E18, MM, grant, revoke, sessionOf, now, move, execHash, grantText, PK, safeAbi, tokenAbi, fresh, ZERO, CHAIN_ID,
  encodeFunctionData, parseAbi, keccak256, toHex, privateKeyToAccount, generatePrivateKey, execHash as eh, type Address, type Hex, type Call, type Session, type W } from './pse-core.ts';
import { FR, PH } from './pse-setup.ts';
import { sv } from './pse-seats.ts';

const wallets: [W, Address][] = [[MM, st.pkMM], [FR, st.pkFR], [PH, st.pkPH]];
const fundGas = (a: Address) => rpc('anvil_setBalance', [a, '0x2386f26fc10000']);
const noGas = (a: Address) => rpc('anvil_setBalance', [a, '0x0']);
const nonceOf = async (s: Session) => (await sessionOf(s.pk, s.key.address))[1];
async function moveSelf(name: string, expectOk: boolean, s: Session, call: Call, o: { funded?: boolean; tag?: string } = {}) {
  const sig = await s.key.sign({ hash: eh(s.pk, await nonceOf(s), call) });
  await (o.funded === false ? noGas : fundGas)(s.key.address);
  await send(name, expectOk, s.pk, encodeFunctionData({ abi: PK.abi, functionName: 'exec', args: [call.to, call.value, call.data, call.operation, st.roleKey, s.key.address, sig] }), { from: s.key, tag: o.tag });
}
const MULTICALL3: Address = '0xcA11bde05977b3631167028862bE2a173976CA11';
const multicallAbi = parseAbi(['struct Call3 { address target; bool allowFailure; bytes callData; }', 'struct Result { bool success; bytes returnData; }', 'function aggregate3(Call3[] calls) payable returns (Result[] returnData)']);
async function grantAndMove(name: string, expectOk: boolean, pk: Address, w: W, call: Call, o: { selfPay?: boolean; tag?: string; vote?: boolean } = {}): Promise<Session> {
  const key = privateKeyToAccount(generatePrivateKey()); const end = (await now()) + 3600n; const vote = o.vote ?? false; const s: Session = { pk, key, end, vote };
  const g = encodeFunctionData({ abi: PK.abi, functionName: 'grant', args: [key.address, end, vote, await w.personalSign(await grantText(pk, key.address, end, vote))] });
  const e = encodeFunctionData({ abi: PK.abi, functionName: 'exec', args: [call.to, call.value, call.data, call.operation, st.roleKey, key.address, await key.sign({ hash: eh(pk, 0n, call) })] });
  const data = encodeFunctionData({ abi: multicallAbi, functionName: 'aggregate3', args: [[{ target: pk, allowFailure: true, callData: g }, { target: pk, allowFailure: false, callData: e }]] });
  if (o.selfPay) await fundGas(key.address);
  await send(name, expectOk, MULTICALL3, data, { from: o.selfPay ? key : undefined, tag: o.tag });
  return s;
}

note('N. a session (vote or not) cannot use Roles to govern');
for (const [i, s] of [[1, sv[1]!], [2, sv[2]!]] as [number, Session][]) {
  const w = wallets[i]![0].name;
  await move(`N-${w}1. ${w}'s vote session asks Roles to add its key as a Safe owner`, false, s, { to: st.safe, value: 0n, operation: 0, data: encodeFunctionData({ abi: safeAbi, functionName: 'addOwnerWithThreshold', args: [s.key.address, 1n] }) });
  await move(`N-${w}2. ${w}'s vote session asks Roles for a delegatecall`, false, s, { ...tokenTransfer(VENUE, 1n), operation: 1 });
  await move(`N-${w}3. ${w}'s vote session asks Roles to re-assign roles`, false, s, { to: st.roles, value: 0n, operation: 0, data: encodeFunctionData({ abi: parseAbi(['function assignRoles(address,bytes32[],bool[])']), functionName: 'assignRoles', args: [s.key.address, [st.roleKey], [true]] }) });
}

note('G. sessions and moves, every wallet');
for (const [w, pk] of wallets) {
  const s = await grant(`G-${w.name}1. ${w.name} grants a 1-hour move-only session (one signature${w === MM ? '' : ' through NEAR'}), relayer submits`, true, pk, w, { tag: `grant${w.name}` });
  const b = await bal(VENUE);
  await move(`G-${w.name}2. move via relayer: 10 to VENUE`, true, s, tokenTransfer(VENUE, 10n), { tag: `moveRelayer${w.name}` });
  await moveSelf(`G-${w.name}3. relayer down: the session key submits and pays gas itself, 5 to VENUE`, true, s, tokenTransfer(VENUE, 5n), { tag: `moveSelf${w.name}` });
  await moveSelf(`G-${w.name}4. relayer down and the session key has no ETH`, false, s, tokenTransfer(VENUE, 1n), { funded: false });
  record(`G-${w.name}5. VENUE received exactly 15`, true, (await bal(VENUE)) - b === 15n * E18, `${((await bal(VENUE)) - b) / E18}`);
  const sig = await move(`G-${w.name}6. move 3: 1 to VENUE`, true, s, tokenTransfer(VENUE, 1n), { tag: `moveLater${w.name}` });
  await move(`G-${w.name}7. move 3 replayed`, false, s, tokenTransfer(VENUE, 1n), { replay: sig });
  await move(`G-${w.name}8. 1 to another address (Roles rule)`, false, s, tokenTransfer(OTHER, 1n));
  await move(`G-${w.name}9. move signed by another key`, false, s, tokenTransfer(VENUE, 1n), { signer: privateKeyToAccount(generatePrivateKey()) });
  await grant(`G-${w.name}10. grant for 7 days + 1 hour`, false, pk, w, { seconds: 7n * 86400n + 3600n });
  await grant(`G-${w.name}11. grant submitted with a later end than signed`, false, pk, w, { end: s.end + 3600n, signedEnd: s.end });
  await grant(`G-${w.name}12. old grant replayed with an earlier end`, false, pk, w, { key: s.key, end: s.end - 60n });
  const zero = { address: ZERO } as any;
  await grant(`G-${w.name}13. grant for the zero key is accepted (owner-signed, stored)`, true, pk, w, { key: zero });
  await move(`G-${w.name}13b. the zero key can never move (no signature recovers to it)`, false, { pk, key: zero }, tokenTransfer(VENUE, 1n), { replay: `0x${'11'.repeat(32)}${'22'.repeat(32)}1b` as Hex });
  const r = await grant(`G-${w.name}14. second session`, true, pk, w);
  await revoke(`G-${w.name}15. ${w.name} revokes it: grant with end 0 (one signature)`, pk, w, r.key.address);
  await move(`G-${w.name}16. the revoked session`, false, r, tokenTransfer(VENUE, 1n));
  await grant(`G-${w.name}17. re-grant the revoked key`, false, pk, w, { key: r.key });
  await move(`G-${w.name}18. first session still works`, true, s, tokenTransfer(VENUE, 1n));
  const bc = await bal(VENUE);
  const c1 = await grantAndMove(`G-${w.name}19. grant + first move in one Multicall3 transaction, relayer submits`, true, pk, w, tokenTransfer(VENUE, 2n), { tag: `grantMoveRelayer${w.name}` });
  record(`G-${w.name}20. that session is live with nonce 1 afterwards, and VENUE got the 2`, true, (await nonceOf(c1)) === 1n && (await sessionOf(pk, c1.key.address))[0] === c1.end && (await bal(VENUE)) - bc === 2n * E18, `nonce ${await nonceOf(c1)}`);
  const c2 = await grantAndMove(`G-${w.name}21. grant + first move in one transaction, the session key pays its own gas`, true, pk, w, tokenTransfer(VENUE, 2n), { selfPay: true, tag: `grantMoveSelf${w.name}` });
  await move(`G-${w.name}22. the combined session's second move`, true, c2, tokenTransfer(VENUE, 1n));
  const bad = await grantAndMove(`G-${w.name}23. grant + a refused first move (1 to another address): the whole transaction reverts`, false, pk, w, tokenTransfer(OTHER, 1n));
  record(`G-${w.name}24. and the grant was not stored`, true, (await sessionOf(pk, bad.key.address))[0] === 0n, `until ${(await sessionOf(pk, bad.key.address))[0]}`);
  const v = await grantAndMove(`G-${w.name}30. a VOTE session also makes Roles moves: grant (vote flag set) + first move, 1 to VENUE`, true, pk, w, tokenTransfer(VENUE, 1n), { vote: true });
  record(`G-${w.name}31. that session is stored with the vote flag and nonce 1`, true, (await sessionOf(pk, v.key.address))[2] === true && (await nonceOf(v)) === 1n, `${await sessionOf(pk, v.key.address)}`);
  await move(`G-${w.name}32. the vote session is still held to the Roles rule (1 to another address)`, false, v, tokenTransfer(OTHER, 1n));
}
await move('G-cap. a move over the daily cap (60 more)', false, sv[0]!, tokenTransfer(VENUE, 60n));

note('X. cross-wallet grants, and grants versus votes');
{
  await grant('X1. PrimeSession(Freighter) with a grant signed by Phantom', false, st.pkFR, PH);
  await grant('X2. PrimeSession(MetaMask) with a grant signed by Freighter', false, st.pkMM, FR);
  await grant('X3. PrimeSession(Phantom) with a grant signed by MetaMask', false, st.pkPH, MM);
  await grant('X5. grant text made for PrimeSession(Freighter) presented to PrimeSession(Phantom), signed by Phantom', false, st.pkPH, PH, { textFor: st.pkFR });
  await grant('X6. raw-hash signature instead of personal_sign (Freighter)', false, st.pkFR, { ...FR, personalSign: async (t) => FR.signHash(keccak256(toHex(t))) });
  // a vote is a signature over a 32-byte Safe hash; a grant is a personal_sign over text: neither passes as the other
  const c = await prepare(st.safe, tokenTransfer(DEST, 1n));
  const grantAsVote = await MM.personalSign(await grantText(st.pkMM, fresh(), (await now()) + 3600n, true));
  await send("X7. MetaMask's grant signature (personal_sign of the grant text) filed as its vote + Freighter's owner vote", false, st.safe,
    execData(c, pack([{ owner: st.pkMM, sig: '0x', dynamic: grantAsVote }, await byOwner(FR, st.pkFR)(c)])));
  const voteAsGrant = await MM.signHash(c.hash);
  await send("X8. MetaMask's vote signature over a Safe hash offered as a grant signature", false, st.pkMM, encodeFunctionData({ abi: PK.abi, functionName: 'grant', args: [fresh(), (await now()) + 3600n, true, voteAsGrant] }));
  const s = await grant('X9. Freighter vote session (used below)', true, st.pkFR, FR, { vote: true });
  await send("X10. Phantom's end-0 (revoke) signature on PrimeSession(Freighter) for Freighter's live session", false, st.pkFR, encodeFunctionData({ abi: PK.abi, functionName: 'grant', args: [s.key.address, 0n, false, await PH.personalSign(await grantText(st.pkFR, s.key.address, 0n, false))] }));
  await move('X11. Freighter session still works after X10', true, s, tokenTransfer(VENUE, 1n));
}
