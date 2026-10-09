// Squads Smart Account owner-count probe on the local validator: how many signers one create transaction holds,
// and how far addSignerAsAuthority grows an account. Run from /home/ubuntu/work/swig-spike: bun psn-limits.ts
import { Connection, Keypair, SystemProgram, Transaction } from '@solana/web3.js';
import * as sa from '@sqds/smart-account';
import { payer } from '/home/ubuntu/work/swig-spike/keys.ts';
const conn = new Connection('http://127.0.0.1:8989', { commitment: 'confirmed' });
const ix = sa.instructions, ALL = { mask: 7 };
const log = (...a: any[]) => console.log(new Date().toISOString().slice(11, 19), ...a);
const send = async (tx: Transaction) => { let s: string; try { s = await conn.sendTransaction(tx, [payer]); } catch (e: any) { const l = e.logs ?? (await e.getLogs?.(conn).catch(() => undefined)); throw new Error(`${e.message} | ${(l ?? []).slice(-14).join(' / ')}`); } for (let i = 0; i < 120; i++) { const v = (await conn.getSignatureStatus(s)).value; if (v?.err) throw new Error(JSON.stringify(v.err)); if (v?.confirmationStatus) return s; await new Promise((r) => setTimeout(r, 500)); } throw new Error('unconfirmed'); };
if ((await conn.getBalance(payer.publicKey)) < 50e9) await conn.confirmTransaction(await conn.requestAirdrop(payer.publicKey, 100e9));
const pc = await sa.accounts.ProgramConfig.fromAccountAddress(conn, sa.getProgramConfigPda({})[0]);
const create = async (n: number, authority: boolean) => {
  const idx = BigInt((await sa.accounts.ProgramConfig.fromAccountAddress(conn, sa.getProgramConfigPda({})[0])).smartAccountIndex.toString()) + 1n;
  const [settingsPda] = sa.getSettingsPda({ accountIndex: idx });
  const signers = Array.from({ length: n }, () => ({ key: Keypair.generate().publicKey, permissions: ALL }));
  const tx = new Transaction().add(ix.createSmartAccount({ treasury: pc.treasury, creator: payer.publicKey, settings: settingsPda, settingsAuthority: authority ? payer.publicKey : null, threshold: 1, timeLock: 0, rentCollector: null, signers }));
  const bytes = (() => { try { tx.feePayer = payer.publicKey; tx.recentBlockhash = '11111111111111111111111111111111'; tx.sign(payer); return tx.serialize().length; } catch (e: any) { return -1; } })();
  const t = new Transaction().add(...tx.instructions);
  try { await send(t); return { ok: true, settingsPda, bytes }; } catch (e: any) { return { ok: false, settingsPda, bytes, err: String(e.message ?? e).slice(0, 160) }; }
};
for (const n of [20, 25, 28, 29, 30, 32, 35, 40]) { const r = await create(n, false); log(`create with ${n} signers in one transaction:`, r.ok ? 'ok' : 'refused', `tx bytes ${r.bytes}`, r.err ?? ''); }
const r = await create(1, true); if (!r.ok) throw new Error('base account: ' + r.err);
let have = 1; const targets = [50, 55, 58, 60, 64, 70, 80, 100, 150];
for (const target of targets) {
  try {
    while (have < target) {
      const batch = Math.min(1, target - have), tx = new Transaction();
      for (let i = 0; i < batch; i++) tx.add(ix.addSignerAsAuthority({ settingsPda: r.settingsPda, settingsAuthority: payer.publicKey, rentPayer: payer.publicKey, newSigner: { key: Keypair.generate().publicKey, permissions: ALL } }));
      await send(tx); have += batch;
    }
    const s = await sa.accounts.Settings.fromAccountAddress(conn, r.settingsPda), info = (await conn.getAccountInfo(r.settingsPda))!;
    log(`grown to ${have} signers:`, `settings has ${s.signers.length}, ${info.data.length} bytes, rent ${info.lamports} lamports`);
  } catch (e: any) { log(`growth stopped at ${have} signers (target ${target}):`, String(e.message ?? e).slice(0, 6000)); break; }
}
