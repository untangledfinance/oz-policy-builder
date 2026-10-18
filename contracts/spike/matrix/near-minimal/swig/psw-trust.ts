// Read-only trust facts for the Swig program (and the Squads program) on devnet and mainnet. Public RPC reads and one HTTP GET to verify.osec.io. No signing.
import { Connection, PublicKey } from '@solana/web3.js';
import { createHash } from 'node:crypto';
const SWIG = new PublicKey('swigypWHEksbC64pWKwah1WTeh9JXwx8H1rJHLdbQMB');
const SQUADS = new PublicKey('SMRTzfY6DfH5ik3TKiyLFfXexV8uSG3d2UksSCYdunG');
const SQDS_V4 = new PublicKey('SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf');
const LOADER = new PublicKey('BPFLoaderUpgradeab1e11111111111111111111111');
const NETS: Record<string, string> = { mainnet: 'https://api.mainnet-beta.solana.com', devnet: 'https://api.devnet.solana.com' };
const when = (t: number | null | undefined) => (t ? new Date(t * 1000).toISOString().replace('.000Z', 'Z') : '?');

async function programInfo(conn: Connection, id: PublicKey) {
  const acct = await conn.getAccountInfo(id); if (!acct) return null;
  const pd = new PublicKey(acct.data.subarray(4, 36)); const d = (await conn.getAccountInfo(pd))!.data;
  const slot = Number(d.readBigUInt64LE(4)); const hasAuth = d[12] === 1; const auth = hasAuth ? new PublicKey(d.subarray(13, 45)) : null;
  const elf = d.subarray(45); let end = elf.length; while (end > 0 && elf[end - 1] === 0) end--;
  return { programData: pd, slot, auth, elfBytes: elf.length, elfTrimmed: end, sha256: createHash('sha256').update(elf.subarray(0, end)).digest('hex'), blockTime: await conn.getBlockTime(slot).catch(() => null) };
}
async function multisigOf(conn: Connection, vault: PublicKey, hint: PublicKey) {
  const a = await conn.getAccountInfo(hint); if (!a || !a.owner.equals(SQDS_V4)) return null;
  const d = a.data; let off = 8 + 32 + 32; const threshold = d.readUInt16LE(off), timeLock = d.readUInt32LE(off + 2);
  off = 8 + 32 + 32 + 2 + 4 + 8 + 8; const hasRc = d[off]; off += 1 + (hasRc ? 32 : 0); off += 1;
  const n = d.readUInt32LE(off); off += 4; const members: string[] = []; for (let i = 0; i < n; i++) { members.push(new PublicKey(d.subarray(off, off + 32)).toBase58()); off += 33; }
  const [v0] = PublicKey.findProgramAddressSync([Buffer.from('multisig'), hint.toBuffer(), Buffer.from('vault'), Buffer.from([0])], SQDS_V4);
  return { threshold, timeLock, members, vault0IsAuthority: v0.equals(vault), configAuthority: new PublicKey(d.subarray(8 + 32, 8 + 64)).toBase58() };
}
for (const [net, url] of Object.entries(NETS)) {
  const conn = new Connection(url, 'confirmed');
  console.log(`\n== ${net}`);
  for (const [name, id] of [['Swig', SWIG], ['Squads Smart Account', SQUADS]] as const) {
    const p = await programInfo(conn, id);
    if (!p) { console.log(`${name}: not deployed`); continue; }
    console.log(`${name} ${id.toBase58()}: programdata ${p.programData.toBase58()}, last deployed slot ${p.slot} (${when(p.blockTime)}), upgrade authority ${p.auth?.toBase58() ?? 'none (immutable)'}, data ${p.elfBytes} B (ELF ${p.elfTrimmed} B), sha256(ELF) ${p.sha256}`);
    if (p.auth) {
      const ai = await conn.getAccountInfo(p.auth);
      console.log(`  authority account: owner ${ai?.owner.toBase58() ?? 'none'}, data ${ai?.data.length ?? 0} B, ${ai ? ai.lamports / 1e9 : 0} SOL`);
      // find the Squads v4 multisig by reading the latest upgrade transaction
      const sigs = await conn.getSignaturesForAddress(p.programData, { limit: 60 });
      let found = false;
      for (const s of sigs.filter((x) => !x.err).slice(0, 12)) {
        const t = await conn.getParsedTransaction(s.signature, { maxSupportedTransactionVersion: 0 });
        const sq = t?.transaction.message.instructions.find((i: any) => i.programId?.equals?.(SQDS_V4) || String(i.programId) === SQDS_V4.toBase58()) as any;
        if (sq?.accounts?.[0]) { const ms = await multisigOf(conn, p.auth, new PublicKey(sq.accounts[0])); if (ms) { console.log(`  authority is the vault of Squads v4 multisig ${sq.accounts[0]}: threshold ${ms.threshold} of ${ms.members.length}, time lock ${ms.timeLock} s, config authority ${ms.configAuthority}, vault 0 matches: ${ms.vault0IsAuthority}`); console.log(`  members: ${ms.members.join(' ')}`); found = true; break; } }
      }
      if (!found) console.log('  authority is not a Squads v4 vault in the 12 newest upgrade-history transactions (a plain key or another program)');
      // upgrade history
      let ok = 0, failed = 0, first = sigs.at(-1)?.blockTime ?? null; for (const s of sigs) (s.err ? failed++ : ok++);
      console.log(`  ProgramData account activity: ${sigs.length} newest signatures (oldest ${when(first)}), ${ok} succeeded, ${failed} failed; newest ${sigs.slice(0, 6).map((s) => `${s.slot}@${when(s.blockTime)}${s.err ? '(failed)' : ''}`).join(', ')}`);
    }
  }
}
// verified-build registry (OtterSec): is the on-chain Swig program a verified build of a public commit?
for (const prog of [SWIG, SQUADS]) {
  const r = await fetch(`https://verify.osec.io/status/${prog.toBase58()}`).then((x) => x.json()).catch((e) => ({ error: String(e) }));
  console.log(`\nverify.osec.io ${prog.toBase58()}: ${JSON.stringify(r)}`);
}
