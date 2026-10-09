// Reviewer probe: a classic Token account posing as custody's multisig. votes() reads m from byte 0, n from byte 1 and signer slots every 32 bytes from byte 3,
// so a token account whose mint address starts with a zero byte gives m = 0, and its close authority (bytes 133..165) fills slot 4 (bytes 131..163) behind the
// two zero bytes of the close-authority tag. A key with two leading zero bytes then counts as a signer of this "multisig".
import * as lib from './lib';
import * as sc from './setup-checks';
import { SystemProgram, Keypair, PublicKey } from '@solana/web3.js';
import { MINT_SIZE, TOKEN_PROGRAM_ID, getMinimumBalanceForRentExemptMint, createInitializeMint2Instruction } from '@solana/spl-token';
const { conn, payer, custody, trustee, recovery, owners, stranger, check, send, must, mkMs, mkGate, mkOwned, mkAcct, allowIx, releaseIx, Prime, acct, finish, U, GATE, FAR } = lib as any;

let K: Keypair, tries = 0;
do { K = Keypair.generate(); tries++; } while (K.publicKey.toBytes()[0] !== 0 || K.publicKey.toBytes()[1] !== 0);
let mk: Keypair;
do { mk = Keypair.generate(); } while (mk.publicKey.toBytes()[0] !== 0);
console.log(`key with two leading zero bytes after ${tries} tries`);
await must('mint at an address whose first byte is 0', [SystemProgram.createAccount({ fromPubkey: payer.publicKey, newAccountPubkey: mk.publicKey, lamports: await getMinimumBalanceForRentExemptMint(conn), space: MINT_SIZE, programId: TOKEN_PROGRAM_ID }),
  createInitializeMint2Instruction(mk.publicKey, 6, payer.publicKey, null, TOKEN_PROGRAM_ID)], [mk]);
const ca = new PublicKey(Buffer.concat([Buffer.from(K.publicKey.toBytes().slice(2)), Buffer.from([7, 7])]));
const F = await mkAcct(mk.publicKey, payer.publicKey, { closeAuth: ca });
const fd = (await conn.getAccountInfo(F))!;
check('FM0. the token account is 165 bytes, owned by the Token program, byte 0 (read as m) is 0 and bytes 131..163 (signer slot 4) equal the key', fd.data.length === 165 && fd.owner.equals(TOKEN_PROGRAM_ID) && fd.data[0] === 0 && Buffer.from(fd.data.slice(131, 163)).equals(K.publicKey.toBuffer()), `m ${fd.data[0]} n ${fd.data[1]}`);
await must('fund the key', [SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: K.publicKey, lamports: 20_000_000 })], []);
const P = await new Prime(owners, 2).create();
if (process.env.EXPECT_REFUSE) {
  await send('FX1. with the length check, create refuses the token account as the multisig (Custom 5)', false, [lib.createIx(K.publicKey, F, P, [P.vault(1)], { seed: lib.newSeed() })], [K], /custom program error: 0x5\b/);
  const MS = await mkMs('', [custody.publicKey, trustee.publicKey], 2);
  const g2 = await mkGate(MS.key, P, [P.vault(1)], { label: 'FX2. a gate on a real 355-byte multisig is still created' });
  const x2 = await mkOwned(g2, mk.publicKey, 10n);
  await send('FX3. release by both signers still works', true, [releaseIx(g2, x2, stranger.publicKey, [custody.publicKey, trustee.publicKey])], [custody, trustee]);
  finish(); process.exit(0);
}
const g = await mkGate(F, P, [P.vault(1)], { member: K, label: 'FM1. create accepts the token account as the multisig: the ground key is the "member" (any party can do this, no custody key involved)' });
check('FM1b. the gate stores the token account as its multisig', Buffer.from((await conn.getAccountInfo(g.addr))!.data.slice(0, 32)).equals(F.toBuffer()));
const x = await mkOwned(g, mk.publicKey, 100n);
await send('FM2. allow raises the cap with no signer at all (m = 0)', true, [allowIx(g, x, 1000n * U, [])], []);
await send('FM3. release hands the account to a stranger with no signer at all', true, [releaseIx(g, x, stranger.publicKey, [])], []);
check('FM3b. the stranger now owns the account', (await acct(x)).owner.equals(stranger.publicKey));
const MS = await mkMs('', [custody.publicKey, trustee.publicKey], 2);
const want = { program: GATE, multisig: MS.key, settings: P.settings, agentLane: P.vault(1), ownersLane: P.vault(3), recovery: recovery.publicKey, until: FAR, window: 60, seed: g.seed, destinations: [P.vault(1)], custody: [custody.publicKey, MS.key] };
const issues = sc.checkGate({ address: g.addr, owner: GATE, data: (await conn.getAccountInfo(g.addr))!.data }, want);
check('FM4. checkGate refuses this gate against custody\'s real multisig (gate-multisig and gate-address)', issues.some((i: any) => i.code === 'gate-multisig') && issues.some((i: any) => i.code === 'gate-address'), issues.map((i: any) => i.code).join());
let parsed = '';
try { parsed = JSON.stringify(sc.checkMultisig(sc.parseMultisig(fd.data), { custody: [custody.publicKey], trustee: trustee.publicKey }).map((i: any) => i.code)); } catch (e) { parsed = 'throws: ' + String((e as Error).message).slice(0, 120); }
check('FM5. setup-checks refuses the token account as a multisig (parseMultisig or checkMultisig)', parsed.startsWith('throws') || parsed !== '[]', parsed);
finish();
