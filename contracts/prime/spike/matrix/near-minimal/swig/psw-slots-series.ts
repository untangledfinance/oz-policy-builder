// Read-only: daily slot rate on mainnet for the last 90 days (to see when slot time changed). getBlockTime only.
const url = 'https://api.mainnet-beta.solana.com';
async function rpc(method: string, params: any[] = []) {
  for (let i = 0; i < 6; i++) {
    const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
    if (r.status === 429) { await new Promise((s) => setTimeout(s, 1500 * (i + 1))); continue; }
    const j: any = await r.json(); if (j.error) throw new Error(j.error.message); return j.result;
  }
  throw new Error('rate limited');
}
async function timeAt(slot: number) { for (let k = 0; k < 40; k++) { try { const t = await rpc('getBlockTime', [slot + k]); if (t) return { slot: slot + k, t }; } catch (e: any) { if (!/skipped|missing|not available/i.test(String(e.message))) throw e; } } throw new Error('no block'); }
const cur = await rpc('getSlot', [{ commitment: 'finalized' }]); const now = await timeAt(cur - 5);
const pts = [now]; for (let d = 1; d <= 90; d++) pts.push(await timeAt(Math.round(now.slot - d * 86400 * 3.2)).catch(() => pts.at(-1)!));
// day d: from pts[d] to pts[d-1]
for (let d = 1; d < pts.length; d++) { const ds = pts[d - 1]!.slot - pts[d]!.slot, dt = pts[d - 1]!.t - pts[d]!.t; if (dt > 0) console.log(`${new Date(pts[d]!.t * 1000).toISOString().slice(0, 10)}  ${(dt * 1000 / ds).toFixed(1)} ms/slot  (${ds} slots in ${dt} s)`); }
