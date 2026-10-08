// a4-min extra: the trustee is a vault of the Prime Account itself (a Squads vault signs through the owners' approval count). The gate counts a slot when its key is a signer account of the
// call, and Squads signs vault PDAs on inner instructions, so a vault can fill a multisig slot. Custody's own key signs the outer transaction.
import * as lib from './lib';
const { AL, E, U, TOKEN_PROGRAM_ID, conn, custody, owners, check, send, mkMs, mkOwned, mkGate, allowIx, releaseIx, Prime, viaOwners, finish, newKey, acct, info, Keypair, PublicKey, mkAta, ata, must, createMintToInstruction, mkMint, payer } = lib;
const P = await new Prime(owners, 2).create(), own2 = [owners[0], owners[1]], V = 5, trusteeVault = new PublicKey(P.vault(5).toBase58());
const MU = await mkMint(); const vin = ata(MU, P.vault(AL));
await must('ata', [mkAta(MU, P.vault(AL))], []);
const MS = await mkMs('T0. custody and Prime vault 5 form a 2-of-2 SPL multisig (the Prime Account itself is the trustee)', [custody.publicKey, trusteeVault], 2);
const g = await mkGate(MS.key, P, [P.vault(AL)], { label: 'T1. custody creates the gate for that multisig' });
const x = await mkOwned(g, MU, 100n);
const vs = (i: lib.TransactionInstruction) => { i.keys[i.keys.length - 1].isWritable = true; return i; };    // Squads needs a writable signer in the inner call
await send('T2. custody alone raises the cap: refused (one slot of two)', false, [allowIx(g, x, 50n * U, [custody.publicKey])], [custody], E.lane);
await send('T3. the owners (2 of 3) as vault 5 alone, without custody: refused (one slot of two)', false, [viaOwners(P, own2, V, [vs(allowIx(g, x, 50n * U, [P.vault(V)]))])], own2, E.lane);
await send('T4. one owner alone as vault 5 with custody: refused by Squads (below the approval count)', false, [viaOwners(P, [owners[0]], V, [vs(allowIx(g, x, 50n * U, [custody.publicKey, P.vault(V)]))])], [owners[0], custody], E.signers);
await send('T5. the owners (2 of 3) as vault 5 with custody\'s signature raise the cap to 50: both slots are filled', true, [viaOwners(P, own2, V, [vs(allowIx(g, x, 50n * U, [custody.publicKey, P.vault(V)]))])], [...own2, custody], undefined, { cost: 'allow by custody + the Prime vault as trustee (sync)' });
check('T5b. the cap is 50', (await acct(x)).delegatedAmount === 50n * U, await info(x));
await send('T6. the same pair releases the account to newKey', true, [viaOwners(P, own2, V, [vs(releaseIx(g, x, newKey.publicKey, [custody.publicKey, P.vault(V)]))])], [...own2, custody], undefined, { cost: 'release by custody + the Prime vault as trustee (sync)' });
check('T6b. owner and close authority are newKey', (await acct(x)).owner.equals(newKey.publicKey) && (await acct(x)).closeAuthority?.equals(newKey.publicKey) === true, await info(x));
const rc = finish(); process.exit(rc ? 1 : 0);
