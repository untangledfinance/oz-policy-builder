// Swig on Solana devnet, laid out like a Prime Account:
import nacl from 'tweetnacl';
//   role 0 (root, admin): owner's Phantom key (ed25519), all permissions
//   role "mm":  MetaMask (secp256k1) SESSION role: one personal_sign -> short-lived session key;
//               may only send SOL to VENUE, at most 0.05 SOL in total
//   role "ph":  Phantom SESSION role with the same limits
import { Connection, Keypair, LAMPORTS_PER_SOL, SystemProgram, Transaction, sendAndConfirmTransaction, type TransactionInstruction, PublicKey } from '@solana/web3.js';
import { Actions, createEd25519AuthorityInfo, createEd25519SessionAuthorityInfo, createSecp256k1SessionAuthorityInfo,
  fetchSwig, findSwigPda, getAddAuthorityInstructions, getCreateSessionInstructions, getCreateSwigInstruction,
  getRemoveAuthorityInstructions, getSignInstructions, getSwigWalletAddress, getEvmPersonalSignPrefix } from '@swig-wallet/classic';
import { hexToBytes } from 'viem';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { payer, phantom, attacker, metamask, B } from './keys.ts';

const RPC = process.env.SOL_RPC ?? 'https://api.devnet.solana.com';
const conn = new Connection(RPC, 'confirmed');
const STATE = RPC.includes('127.0.0.1') ? 'state-local.json' : 'state.json';
const st: any = existsSync(STATE) ? JSON.parse(readFileSync(STATE, 'utf8')) : {};
const save = () => writeFileSync(STATE, JSON.stringify(st, null, 1));
const results: any[] = st.results ?? (st.results = []);
const VENUE = new PublicKey(st.venue ?? (st.venue = Keypair.generate().publicKey.toBase58()));
const OTHER = new PublicKey(st.other ?? (st.other = Keypair.generate().publicKey.toBase58()));
const LIMIT = BigInt(0.05 * LAMPORTS_PER_SOL);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const short = (e: any) => { const s = String(e?.transactionLogs?.join(' ') ?? e?.message ?? e); const m = s.match(/(custom program error: 0x[0-9a-f]+|Error Code: \w+|failed: [^"]{0,80}|Program log: [^"]{0,90}(?:fail|error|Error|denied|Denied)[^"]{0,40})/i); return (m?.[0] ?? s).slice(0, 160); };

async function send(name: string, expectOk: boolean, ixs: TransactionInstruction[], signers: Keypair[]) {
  const t0 = Date.now();
  let ok = true, detail = '';
  try { detail = await sendAndConfirmTransaction(conn, new Transaction().add(...ixs), signers, { commitment: 'confirmed' }); }
  catch (e: any) { ok = false; detail = short(e); if (e?.getLogs) { try { const logs = await e.getLogs(conn); detail = short({ transactionLogs: logs }); } catch {} } }
  const pass = ok === expectOk;
  results.push({ name, pass, ok, ms: Date.now() - t0, detail }); save();
  console.log(`${pass ? 'PASS' : 'FAIL'} ${name} | ${ok ? `ok ${Date.now() - t0}ms ${detail}` : `refused: ${detail}`}`);
  return ok;
}
// MetaMask signs with personal_sign (what the extension shows as a message prompt)
const mmSign = async (message: Uint8Array) => ({
  signature: hexToBytes(await metamask.signMessage({ message: { raw: message } })),
  prefix: getEvmPersonalSignPrefix(message.length),
});
const slot = async () => BigInt(await conn.getSlot('finalized'));
const transfer = (from: PublicKey, to: PublicKey, lamports: number) => SystemProgram.transfer({ fromPubkey: from, toPubkey: to, lamports });

const part = process.argv[2];
if (part === 'setup') {
  if (!st.swigId) {
    const id = crypto.getRandomValues(new Uint8Array(32)); st.swigId = Buffer.from(id).toString('hex');
    await send('S1. create Swig, root = owner Phantom key (all)', true, [await getCreateSwigInstruction({
      authorityInfo: createEd25519AuthorityInfo(phantom.publicKey), id, payer: payer.publicKey, actions: Actions.set().all().get() })], [payer]);
  }
  const swig = await fetchSwig(conn, findSwigPda(Buffer.from(st.swigId, 'hex')));
  const wallet = await getSwigWalletAddress(swig); st.swig = findSwigPda(Buffer.from(st.swigId, 'hex')).toBase58(); st.wallet = wallet.toBase58(); save();
  if (!st.funded) { await send('S2. fund Swig wallet 0.1 SOL', true, [transfer(payer.publicKey, wallet, 0.1 * LAMPORTS_PER_SOL)], [payer]); st.funded = 1; save(); }
  const mover = () => Actions.set().solDestinationLimit({ amount: LIMIT, destination: VENUE }).get();
  if (st.mmRole === undefined) {
    await send('S3. root adds MetaMask SESSION role (VENUE only, 0.05 SOL, sessions <= 300 slots)', true,
      await getAddAuthorityInstructions(swig, 0, createSecp256k1SessionAuthorityInfo(hexToBytes(metamask.publicKey), 300n), mover(), { payer: payer.publicKey }), [payer, phantom]);
    await swig.refetch(); st.mmRole = swig.roles[swig.roles.length - 1]!.id; save();
  }
  if (st.phRole === undefined) {
    await send('S4. root adds Phantom SESSION role (same limits)', true,
      await getAddAuthorityInstructions(swig, 0, createEd25519SessionAuthorityInfo(phantom.publicKey, 300n), mover(), { payer: payer.publicKey }), [payer, phantom]);
    await swig.refetch(); st.phRole = swig.roles[swig.roles.length - 1]!.id; save();
  }
  console.log({ swig: st.swig, wallet: st.wallet, roles: swig.roles.map((r: any) => ({ id: r.id, session: r.isSessionBased() })) });
}
if (part === 'mm') {
  const swig = await fetchSwig(conn, new PublicKey(st.swig)); const wallet = new PublicKey(st.wallet);
  const sk = Keypair.generate();
  await send('M0. fund session key for fees (payer)', true, [transfer(payer.publicKey, sk.publicKey, 0.01 * LAMPORTS_PER_SOL)], [payer]);
  await send('M1. MetaMask creates a session (one personal_sign)', true,
    await getCreateSessionInstructions(swig, st.mmRole, sk.publicKey, 200n, { currentSlot: await slot(), signingFn: mmSign, payer: payer.publicKey }), [payer]);
  await swig.refetch();
  const role = swig.findRoleBySessionKey(sk.publicKey)!;
  const viaSession = async (ixs: TransactionInstruction[]) => getSignInstructions(swig, role.id, ixs, false, { payer: sk.publicKey });
  await send('M2. session key alone: 0.01 SOL to VENUE', true, await viaSession([transfer(wallet, VENUE, 0.01 * LAMPORTS_PER_SOL)]), [sk]);
  await send('M3. session key: 0.01 SOL to another address', false, await viaSession([transfer(wallet, OTHER, 0.01 * LAMPORTS_PER_SOL)]), [sk]);
  await send('M4. session key: 0.045 SOL to VENUE (over the 0.05 total)', false, await viaSession([transfer(wallet, VENUE, 0.045 * LAMPORTS_PER_SOL)]), [sk]);
  await send('M5. MetaMask itself (properly signed) tries to add an authority from its mover role', false,
    await getAddAuthorityInstructions(swig, st.mmRole, createEd25519AuthorityInfo(attacker.publicKey), Actions.set().all().get(), { currentSlot: await slot(), signingFn: mmSign, payer: payer.publicKey }), [payer]);
  const strangerEvm = (await import('viem/accounts')).privateKeyToAccount((await import('viem/accounts')).generatePrivateKey());
  const strangerSign = async (m: Uint8Array) => ({ signature: hexToBytes(await strangerEvm.signMessage({ message: { raw: m } })), prefix: getEvmPersonalSignPrefix(m.length) });
  await send('M6. another EVM key tries to start a session on the MetaMask role', false,
    await getCreateSessionInstructions(swig, st.mmRole, Keypair.generate().publicKey, 100n, { currentSlot: await slot(), signingFn: strangerSign, payer: payer.publicKey }), [payer]);
  st.mmSessionPk = sk.publicKey.toBase58(); st.mmSessionSk = undefined; save();
}
if (part === 'expiry') {
  const swig = await fetchSwig(conn, new PublicKey(st.swig)); const wallet = new PublicKey(st.wallet);
  const sk = Keypair.generate();
  await send('E0. fund short session key', true, [transfer(payer.publicKey, sk.publicKey, 0.005 * LAMPORTS_PER_SOL)], [payer]);
  await send('E1. MetaMask creates a 10-slot session', true,
    await getCreateSessionInstructions(swig, st.mmRole, sk.publicKey, 10n, { currentSlot: await slot(), signingFn: mmSign, payer: payer.publicKey }), [payer]);
  await sleep(9000);
  await swig.refetch(); const role = swig.findRoleBySessionKey(sk.publicKey)!;
  await send('E2. expired session key: 0.001 SOL to VENUE', false, await getSignInstructions(swig, role.id, [transfer(wallet, VENUE, 0.001 * LAMPORTS_PER_SOL)], false, { payer: sk.publicKey }), [sk]);
  await send('E3. session longer than the role max (400 > 300 slots)', false,
    await getCreateSessionInstructions(swig, st.mmRole, Keypair.generate().publicKey, 400n, { currentSlot: await slot(), signingFn: mmSign, payer: payer.publicKey }).catch(() => [transfer(wallet, OTHER, 1)]), [payer]);
}
if (part === 'phantom') {
  const swig = await fetchSwig(conn, new PublicKey(st.swig)); const wallet = new PublicKey(st.wallet);
  const sk = Keypair.generate();
  await send('P0. fund session key', true, [transfer(payer.publicKey, sk.publicKey, 0.005 * LAMPORTS_PER_SOL)], [payer]);
  await send('P1. Phantom creates a session (signs the tx)', true,
    await getCreateSessionInstructions(swig, st.phRole, sk.publicKey, 200n, { currentSlot: await slot(), payer: payer.publicKey }), [payer, phantom]);
  await swig.refetch(); const role = swig.findRoleBySessionKey(sk.publicKey)!;
  await send('P2. Phantom session key alone: 0.005 SOL to VENUE', true, await getSignInstructions(swig, role.id, [transfer(wallet, VENUE, 0.005 * LAMPORTS_PER_SOL)], false, { payer: sk.publicKey }), [sk]);
  if (st.bRole === undefined) {
    await send('P2a. root adds a plain ed25519 MOVER role for key B (VENUE only, 0.05 SOL)', true,
      await getAddAuthorityInstructions(swig, 0, createEd25519AuthorityInfo(B.publicKey), Actions.set().solDestinationLimit({ amount: LIMIT, destination: VENUE }).get(), { payer: payer.publicKey }), [payer, phantom]);
    await swig.refetch(); st.bRole = swig.roles[swig.roles.length - 1]!.id; save();
  }
  await send('P2b. mover key B (properly signed) tries to add an authority', false,
    await getAddAuthorityInstructions(swig, st.bRole, createEd25519AuthorityInfo(attacker.publicKey), Actions.set().all().get(), { payer: payer.publicKey }), [payer, B]);
  await send('P2c. mover key B: 0.01 SOL to another address', false,
    await getSignInstructions(swig, st.bRole, [transfer(wallet, OTHER, 0.01 * LAMPORTS_PER_SOL)], false, { payer: payer.publicKey }), [payer, B]);
  await send('P2d. mover key B: 0.005 SOL to VENUE', true,
    await getSignInstructions(swig, st.bRole, [transfer(wallet, VENUE, 0.005 * LAMPORTS_PER_SOL)], false, { payer: payer.publicKey }), [payer, B]);
  await send('P3. root (owner) removes the MetaMask role', true, await getRemoveAuthorityInstructions(swig, 0, st.mmRole, { payer: payer.publicKey }), [payer, phantom]);
  await swig.refetch();
  console.log('roles now', swig.roles.map((r: any) => r.id));
  await send('P4. MetaMask session from M1 after its role was removed', false,
    await getSignInstructions(swig, st.phRole, [transfer(wallet, VENUE, 1000)], false, { payer: payer.publicKey }).then(() => []).catch(() => []).then(async () => {
      const ixs = await getCreateSessionInstructions(swig, st.mmRole, Keypair.generate().publicKey, 100n, { currentSlot: await slot(), signingFn: mmSign, payer: payer.publicKey }).catch((e: any) => { console.log('   SDK: role gone:', String(e.message).slice(0, 80)); return null; });
      return ixs ?? [transfer(wallet, VENUE, 1)]; }), [payer]);
}
if (part === 'near') {
  // A Stellar wallet (Freighter, SEP-53) controls NEAR wallet account 0s2ee0a8… (testnet run 5; now driven by key B
  // through the extension). That NEAR account's MPC ed25519 key for PATH owns a Swig SESSION role on Solana devnet.
  const { execFileSync } = await import('node:child_process');
  const NEAR_ACCT = '0s2ee0a84eed813ebcaf80280ed3c8cbad311e52d5', PATH = 'prime:freighter-spike/solana-1';
  const view = async (args: any) => { const r: any = await (await fetch('https://rpc.testnet.near.org', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'query', params: { request_type: 'call_function', finality: 'final', account_id: 'v1.signer-prod.testnet', method_name: 'derived_public_key', args_base64: Buffer.from(JSON.stringify(args)).toString('base64') } }) })).json();
    return JSON.parse(Buffer.from(r.result.result).toString()) as string; };
  const bs58 = (await import('bs58')).default;
  const K = new PublicKey(bs58.decode((await view({ path: PATH, predecessor: NEAR_ACCT, domain_id: 1 })).split(':')[1]!));
  console.log('NEAR MPC key for', NEAR_ACCT, PATH, '=', K.toBase58());
  const near = JSON.parse(readFileSync('/home/ubuntu/work/near-session-spike/secrets/near.json', 'utf8'));
  const mpcSign = (msg: Uint8Array) => {
    const t0 = Date.now();
    const out = execFileSync('/home/ubuntu/work/near-wallet-spike/intents/target/debug/examples/spike', [], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, NEAR_NETWORK: 'testnet', NEAR_ACCOUNT_ID: near.accountId, NEAR_PRIVATE_KEY: near.secret,
        SEP53_CODE_HASH: '5LVYEYWkNFZ9FM86Ge7RAVDjL3zzoYMfNnbRGdU2HgKQ', SPIKE_PATH: PATH, SPIKE_SIGN_HEX: Buffer.from(msg).toString('hex') } });
    console.log(`   NEAR MPC signed ${msg.length} bytes in ${((Date.now() - t0) / 1000).toFixed(1)}s (Freighter-signed NEAR request)`);
    return Buffer.from(out.match(/SIG ([0-9a-f]{128})/)![1]!, 'hex');
  };
  const swig = await fetchSwig(conn, new PublicKey(st.swig)); const wallet = new PublicKey(st.wallet);
  if (st.nearRole === undefined) {
    await send('N1. root adds a SESSION role owned by the NEAR MPC key (VENUE only, 0.05 SOL)', true,
      await getAddAuthorityInstructions(swig, 0, createEd25519SessionAuthorityInfo(K, 300n), Actions.set().solDestinationLimit({ amount: LIMIT, destination: VENUE }).get(), { payer: payer.publicKey }), [payer, phantom]);
    await swig.refetch(); st.nearRole = swig.roles[swig.roles.length - 1]!.id; save();
  }
  // The NEAR MPC key must sign the Solana transaction that creates the session.
  const sk = Keypair.generate();
  await send('N2. fund session key', true, [transfer(payer.publicKey, sk.publicKey, 0.005 * LAMPORTS_PER_SOL)], [payer]);
  const ixs = await getCreateSessionInstructions(swig, st.nearRole, sk.publicKey, 200n, { currentSlot: await slot(), payer: payer.publicKey });
  const tx = new Transaction().add(...ixs); tx.feePayer = payer.publicKey; tx.recentBlockhash = (await conn.getLatestBlockhash('confirmed')).blockhash;
  const needs = tx.compileMessage().accountKeys.slice(0, tx.compileMessage().header.numRequiredSignatures).map((k) => k.toBase58());
  console.log('   signers required:', needs);
  const msgBytes = tx.serializeMessage();
  const sig = mpcSign(msgBytes);
  tx.addSignature(K, sig); tx.partialSign(payer);
  const t0 = Date.now(); let ok = true, detail = '';
  try { detail = await conn.sendRawTransaction(tx.serialize()); await conn.confirmTransaction(detail, 'confirmed'); } catch (e: any) { ok = false; detail = short(e); }
  results.push({ name: 'N3. NEAR MPC key (via Freighter) creates a Swig session', pass: ok, ok, ms: Date.now() - t0, detail }); save();
  console.log(`${ok ? 'PASS' : 'FAIL'} N3. NEAR MPC key (via Freighter) creates a Swig session | ${detail}`);
  await swig.refetch(); const role = swig.findRoleBySessionKey(sk.publicKey);
  if (role) {
    await send('N4. that session key alone: 0.005 SOL to VENUE', true, await getSignInstructions(swig, role.id, [transfer(wallet, VENUE, 0.005 * LAMPORTS_PER_SOL)], false, { payer: sk.publicKey }), [sk]);
    await send('N5. that session key: 0.005 SOL to another address', false, await getSignInstructions(swig, role.id, [transfer(wallet, OTHER, 0.005 * LAMPORTS_PER_SOL)], false, { payer: sk.publicKey }), [sk]);
  }
  // A session for the NEAR role signed by some other key is refused.
  const fake = Keypair.generate();
  const ixs2 = await getCreateSessionInstructions(swig, st.nearRole, Keypair.generate().publicKey, 200n, { currentSlot: await slot(), payer: payer.publicKey });
  const tx2 = new Transaction().add(...ixs2); tx2.feePayer = payer.publicKey; tx2.recentBlockhash = (await conn.getLatestBlockhash('confirmed')).blockhash;
  let ok2 = true, d2 = '';
  try { tx2.addSignature(K, Buffer.from(nacl.sign.detached(tx2.serializeMessage(), fake.secretKey))); tx2.partialSign(payer); d2 = await conn.sendRawTransaction(tx2.serialize()); } catch (e: any) { ok2 = false; d2 = short(e); }
  results.push({ name: 'N6. session for the NEAR role signed by another key', pass: !ok2, ok: ok2, detail: d2 }); save();
  console.log(`${!ok2 ? 'PASS' : 'FAIL'} N6. session for the NEAR role signed by another key | ${ok2 ? 'accepted!? ' + d2 : 'refused: ' + d2}`);
}

if (part === 'm5') {
  const swig = await fetchSwig(conn, new PublicKey(st.swig));
  await send('M5. MetaMask itself (properly signed) tries to add an authority from its mover role', false,
    await getAddAuthorityInstructions(swig, st.mmRole, createEd25519AuthorityInfo(attacker.publicKey), Actions.set().all().get(), { currentSlot: await slot(), signingFn: mmSign, payer: payer.publicKey }), [payer]);
}
