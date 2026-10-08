// Read-only: how many slots does Solana produce per wall-clock day and per 7 days? (mainnet and devnet public RPC, getBlockTime only; no signing)
// Output feeds the choice of Swig's max_session_length (slots) for a 7-day cap.
const NETS: Record<string, string> = { mainnet: 'https://api.mainnet-beta.solana.com', devnet: 'https://api.devnet.solana.com' };
const DAYS = Number(process.env.PSW_DAYS ?? 70);
async function rpc(url: string, method: string, params: any[] = []) {
  for (let i = 0; i < 6; i++) {
    const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
    if (r.status === 429) { await new Promise((s) => setTimeout(s, 1500 * (i + 1))); continue; }
    const j: any = await r.json(); if (j.error) throw new Error(`${method}: ${j.error.message}`); return j.result;
  }
  throw new Error(`${method}: rate limited`);
}
/** block time of the first produced block at or after `slot` (skipped slots have none). */
async function timeAt(url: string, slot: number): Promise<{ slot: number; t: number }> {
  for (let k = 0; k < 40; k++) {
    try { const t = await rpc(url, 'getBlockTime', [slot + k]); if (t) return { slot: slot + k, t }; } catch (e: any) { if (!/skipped|missing|not available/i.test(String(e.message))) throw e; }
  }
  throw new Error(`no block near ${slot}`);
}
for (const [net, url] of Object.entries(NETS)) {
  const cur = await rpc(url, 'getSlot', [{ commitment: 'finalized' }]); const now = await timeAt(url, cur - 5);
  console.log(`\n== ${net}: slot ${now.slot} at ${new Date(now.t * 1000).toISOString()}`);
  // recent 60-second performance samples (about 12 hours)
  const perf = await rpc(url, 'getRecentPerformanceSamples', [720]);
  const spm = perf.map((p: any) => p.samplePeriodSecs / p.numSlots * 1000).sort((a: number, b: number) => a - b);
  console.log(`last ~12 h, 60 s windows: ms per slot min ${spm[0].toFixed(1)}  median ${spm[Math.floor(spm.length / 2)].toFixed(1)}  max ${spm.at(-1).toFixed(1)}  (n=${spm.length})`);
  // one boundary per day going back DAYS days: estimate the slot by the current rate, then read its real block time
  const rate = 1000 / spm[Math.floor(spm.length / 2)];
  const pts: { slot: number; t: number }[] = [now];
  for (let d = 1; d <= DAYS; d++) {
    const guess = Math.round(now.slot - d * 86400 * rate);
    try { pts.push(await timeAt(url, guess)); } catch (e: any) { console.log(`day -${d}: ${e.message}`); break; }
  }
  // slots per second between consecutive daily boundaries, and per 7-day window
  const day = (a: number, b: number) => (pts[a]!.slot - pts[b]!.slot) / (pts[a]!.t - pts[b]!.t);
  const daily: number[] = []; for (let i = 0; i + 1 < pts.length; i++) daily.push(1000 / day(i, i + 1));
  daily.sort((a, b) => a - b);
  console.log(`daily windows (${daily.length}): ms per slot min ${daily[0]!.toFixed(1)}  median ${daily[Math.floor(daily.length / 2)]!.toFixed(1)}  max ${daily.at(-1)!.toFixed(1)}`);
  const weekly: number[] = []; for (let i = 0; i + 7 < pts.length; i++) weekly.push((pts[i]!.slot - pts[i + 7]!.slot) / (pts[i]!.t - pts[i + 7]!.t));
  const slotsPer7d = weekly.map((r) => Math.round(r * 7 * 86400)).sort((a, b) => a - b);
  console.log(`7-day windows (${slotsPer7d.length}): slots per 7 days min ${slotsPer7d[0]}  median ${slotsPer7d[Math.floor(slotsPer7d.length / 2)]}  max ${slotsPer7d.at(-1)}  | ms per slot at the min ${(7 * 86400 * 1000 / slotsPer7d[0]!).toFixed(1)}, at the max ${(7 * 86400 * 1000 / slotsPer7d.at(-1)!).toFixed(1)}`);
  const total = (pts[0]!.slot - pts.at(-1)!.slot) / (pts[0]!.t - pts.at(-1)!.t);
  console.log(`whole span ${((pts[0]!.t - pts.at(-1)!.t) / 86400).toFixed(1)} days: ${(1000 / total).toFixed(1)} ms per slot -> ${Math.round(total * 7 * 86400)} slots per 7 days`);
  console.log(`nominal 400 ms -> ${7 * 86400 / 0.4} slots per 7 days`);
}
