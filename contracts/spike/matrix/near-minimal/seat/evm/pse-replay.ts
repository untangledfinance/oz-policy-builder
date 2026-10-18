// Replay: signatures made for one Safe or one chain presented to another.
import { st, rpc, send, record, note, prepare, pack, execData, byOwner, bySession, tokenTransfer, DEST, VENUE, MM, pub, safeAbi, grantText, PK, execHash, move, tokenAbi, bal, E18, CHAIN_ID,
  encodeFunctionData, privateKeyToAccount, type Address, type Hex } from './pse-core.ts';
import { sv, sm } from './pse-seats.ts';

const t = tokenTransfer(DEST, 1n);
const [RA, RB] = [st.ra, st.rb] as Address[];
const dom = (a: Address) => pub.readContract({ address: a, abi: safeAbi, functionName: 'domainSeparator' });

note('Z. replay across Safes (A and B: same three PrimeSession owners, both at nonce 0)');
{
  // MetaMask's owner vote and Freighter's vote session: both keys are local, so no NEAR call
  const cA = await prepare(RA, t), cB = await prepare(RB, t);
  const forA = await Promise.all([bySession(sv[1]!), byOwner(MM, st.pkMM)].map((p) => p(cA)));
  const forB = await Promise.all([bySession(sv[1]!), byOwner(MM, st.pkMM)].map((p) => p(cB)));
  record('Z0. A and B have different hashes for the identical transaction (the domain separator holds the Safe address)', true, cA.hash !== cB.hash && (await dom(RA)) !== (await dom(RB)) && cA.tx.nonce === cB.tx.nonce, `${cA.hash.slice(0, 10)}… vs ${cB.hash.slice(0, 10)}…`);
  await send('Z1. signatures made for Safe A presented to Safe B (vote session + owner)', false, RB, execData(cB, pack(forA)));
  await send('Z2. signatures made for Safe B presented to Safe A', false, RA, execData(cA, pack(forB)));
  await send('Z3. control: Safe A with its own signatures', true, RA, execData(cA, pack(forA)));
  await send('Z4. the accepted signatures of Safe A sent again to Safe A', false, RA, execData(cA, pack(forA)));
  await send('Z5. control: Safe B with its own signatures', true, RB, execData(cB, pack(forB)));
}

note('Z. replay across chains');
{
  const text = await grantText(st.pkMM, sm[0]!.key.address, sm[0]!.end + 600n, true);
  const grantSig = await MM.personalSign(text);                                   // made on chain 84532
  const grantData = encodeFunctionData({ abi: PK.abi, functionName: 'grant', args: [sm[0]!.key.address, sm[0]!.end + 600n, true, grantSig] });
  const call = tokenTransfer(DEST, 2n);
  const cB = await prepare(RB, call);                                               // Safe B is at nonce 1 now
  const signed = await Promise.all([bySession(sv[1]!), byOwner(MM, st.pkMM)].map((p) => p(cB)));
  const mv = await sm[0]!.key.sign({ hash: execHash(st.pkMM, (await pub.readContract({ address: st.pkMM, abi: PK.abi, functionName: 'sessions', args: [sm[0]!.key.address] }) as any)[1], tokenTransfer(VENUE, 1n)) });
  const d0 = await dom(RB);
  await rpc('anvil_setChainId', [1]);
  try {
    const d1 = await dom(RB);
    record('Y0. on another chain id the Safe has another domain separator', true, d0 !== d1 && (await pub.getChainId()) === 1, `${d0.slice(0, 10)}… vs ${d1.slice(0, 10)}…`);
    await send('Y1. Safe signatures (vote session + owner) made on chain 84532, sent on chain 1', false, RB, execData(cB, pack(signed)), { chainId: 1 });
    await send('Y2. an owner grant (vote flag set) signed on chain 84532, sent on chain 1', false, st.pkMM, grantData, { chainId: 1 });
    await send('Y3. a session move signed on chain 84532, sent on chain 1', false, st.pkMM, encodeFunctionData({ abi: PK.abi, functionName: 'exec', args: [tokenTransfer(VENUE, 1n).to, 0n, tokenTransfer(VENUE, 1n).data, 0, st.roleKey, sm[0]!.key.address, mv] }), { chainId: 1 });
  } finally { await rpc('anvil_setChainId', [CHAIN_ID]); }
  record('Y4. chain id is back to 84532 and the domain separator is the first one', true, (await pub.getChainId()) === CHAIN_ID && (await dom(RB)) === d0, `${await pub.getChainId()}`);
  await send('Y5. control: the same Safe signatures on chain 84532', true, RB, execData(cB, pack(signed)));
  await send('Y6. control: the same owner grant on chain 84532', true, st.pkMM, grantData);
  await send('Y7. control: the same session move on chain 84532', true, st.pkMM, encodeFunctionData({ abi: PK.abi, functionName: 'exec', args: [tokenTransfer(VENUE, 1n).to, 0n, tokenTransfer(VENUE, 1n).data, 0, st.roleKey, sm[0]!.key.address, mv] }));
}
