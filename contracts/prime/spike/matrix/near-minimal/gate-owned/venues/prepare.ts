// Reads mainnet (read-only) and writes what the venue run clones: venues/accounts.txt (addresses for --clone), venues/patched/<mint>.json (the USDC mint with a
// local mint authority, so the harness can fund custody) and venues/venues.json (addresses the harness uses). Nothing is signed or sent.
import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
const here = new URL('.', import.meta.url).pathname;
const conn = new Connection('https://api.mainnet-beta.solana.com', 'confirmed');
const WHIRLPOOL = new PublicKey('whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc'), KLEND = new PublicKey('KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD');
const POOL = new PublicKey('4fuUiYxTQ6QCrdSq9ouBYcTM7bqSwYTSyLueGZLTy4T4');
const MARKET = new PublicKey('7u3HeHxYDLhnCoErrtycNokbQYbWGzLs6JSDqGAv5PfF'), RESERVE = new PublicKey('D6q6wuQSrifJKZYpR1M8R4YawnLDtDsMmWM1NbBmgJ59');
const pk = (b: Buffer, o: number) => new PublicKey(b.subarray(o, o + 32));
const clone = new Set<string>(); const out: any = {};
// Orca Whirlpool: layout offsets (653 bytes): spacing 41, tick current 81, mint A 101, vault A 133, mint B 181, vault B 213
const pool = (await conn.getAccountInfo(POOL))!; if (!pool.owner.equals(WHIRLPOOL) || pool.data.length !== 653) throw new Error('not a whirlpool');
const spacing = pool.data.readUInt16LE(41), tick = pool.data.readInt32LE(81), mintA = pk(pool.data, 101), vaultA = pk(pool.data, 133), mintB = pk(pool.data, 181), vaultB = pk(pool.data, 213);
const span = 88 * spacing, startOf = (t: number) => Math.floor(t / span) * span;
const tickPda = (start: number) => PublicKey.findProgramAddressSync([Buffer.from('tick_array'), POOL.toBuffer(), Buffer.from(String(start))], WHIRLPOOL)[0];
const starts = [-3, -2, -1, 0, 1, 2, 3].map((i) => startOf(tick) + i * span);
const infos = await conn.getMultipleAccountsInfo(starts.map(tickPda));
const ticks = starts.map((s, i) => ({ start: s, addr: tickPda(s), exists: infos[i] !== null && infos[i]!.owner.equals(WHIRLPOOL) }));
out.orca = { pool: POOL.toBase58(), spacing, tick, mintA: mintA.toBase58(), mintB: mintB.toBase58(), vaultA: vaultA.toBase58(), vaultB: vaultB.toBase58(), oracle: PublicKey.findProgramAddressSync([Buffer.from('oracle'), POOL.toBuffer()], WHIRLPOOL)[0].toBase58(),
  ticks: ticks.map((t) => ({ start: t.start, addr: t.addr.toBase58(), exists: t.exists })), feeRate: pool.data.readUInt16LE(45), liquidity: pool.data.readBigUInt64LE(49).toString() };
for (const k of [POOL, vaultA, vaultB, mintB]) clone.add(k.toBase58());
for (const t of ticks) if (t.exists) clone.add(t.addr.toBase58());
// Kamino lending: reserve fields found by decoding with the IDL: lending market 32, liquidity mint 128, supply vault 160, fee vault 192; collateral mint at 2560 (see harness)
const res = (await conn.getAccountInfo(RESERVE))!; if (!res.owner.equals(KLEND)) throw new Error('not a klend reserve');
const lm = pk(res.data, 32), liqMint = pk(res.data, 128), supplyVault = pk(res.data, 160), feeVault = pk(res.data, 192);
const collMint = new PublicKey(process.env.COLL_MINT ?? 'B8V6WVjPxW1UGwVDfxH2d2r8SyT4cqn7dQRK6XneVa7D'), scope = new PublicKey(process.env.SCOPE ?? '3t4JZcueEzTbVP6kLxXrL3VpWx45jDer4eqysweBchNH');
if (!lm.equals(MARKET)) throw new Error('market mismatch');
out.kamino = { market: MARKET.toBase58(), reserve: RESERVE.toBase58(), liquidityMint: liqMint.toBase58(), supplyVault: supplyVault.toBase58(), feeVault: feeVault.toBase58(), collateralMint: collMint.toBase58(), scope: scope.toBase58(),
  marketAuthority: PublicKey.findProgramAddressSync([Buffer.from('lma'), MARKET.toBuffer()], KLEND)[0].toBase58() };
for (const k of [MARKET, RESERVE, supplyVault, feeVault, collMint, scope]) clone.add(k.toBase58());
// USDC: patch the mint authority to a local key (offsets: tag u32 at 0, authority 4..36)
if (!liqMint.equals(mintA)) throw new Error('the Orca pool and the Kamino reserve should share one mint');
const usdc = (await conn.getAccountInfo(mintA))!; const d = Buffer.from(usdc.data); const auth = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(`${here}../secrets/usdc-authority.json`, 'utf8'))));
d.writeUInt32LE(1, 0); auth.publicKey.toBuffer().copy(d, 4);
mkdirSync(`${here}patched`, { recursive: true });
writeFileSync(`${here}patched/${mintA.toBase58()}.json`, JSON.stringify({ pubkey: mintA.toBase58(), account: { lamports: usdc.lamports, data: [d.toString('base64'), 'base64'], owner: usdc.owner.toBase58(), executable: false, rentEpoch: 0, space: d.length } }));
out.usdc = { mint: mintA.toBase58(), authority: auth.publicKey.toBase58(), decimals: d[44] };
clone.delete(mintA.toBase58());
writeFileSync(`${here}accounts.txt`, [...clone].join('\n') + '\n'); writeFileSync(`${here}venues.json`, JSON.stringify(out, null, 1));
console.log(JSON.stringify(out, null, 1)); console.log([...clone].length, 'accounts to clone');
