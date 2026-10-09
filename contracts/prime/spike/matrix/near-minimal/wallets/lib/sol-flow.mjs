import { readFileSync, writeFileSync } from 'node:fs';
import { H, mkLog, sleep } from './pw.mjs';
import { watcher, timed } from './flow.mjs?v=7';
export async function solFlow(ctx, extId, name, o) {
  const log = mkLog(name); const P = JSON.parse(readFileSync(`${H}/payloads/solana.json`, 'utf8'));
  const outf = `${H}/out/${name}.solana.json`; let out = {}; try { out = JSON.parse(readFileSync(outf, 'utf8')); } catch {}
  const w = watcher(ctx, extId, { tag: name, log, labels: o.labels, skip: o.skip, extra: o.extra, unlock: o.unlock, openPopup: o.openPopup, reloadMs: o.reloadMs });
  const page = await ctx.newPage(); await page.goto('http://localhost:8801/solana.html'); await sleep(2500);
  const save = () => writeFileSync(outf, JSON.stringify(out, null, 1));
  const steps = o.steps ?? ['detect', 'connect', 'near', 'grant', 'legacy', 'v0', 'relayer'];
  const tryStep = async (k, fn) => { if (!steps.includes(k)) return; w.setStep(k); try { const v = await timed(fn, o.timeout ?? 90000); out[k + 'Raw'] = v; log(`[${k}] ok`, JSON.stringify(v).slice(0, 200)); return v; } catch (e) { log(`[${k}] ERROR`, String(e.message).slice(0, 400)); out[k + 'Error'] = String(e.message).slice(0, 400); } finally { save(); await sleep(o.gap ?? 3000); } };
  const n = o.provider ?? name;
  if (steps.includes('detect')) { out.detect = await page.evaluate(() => window.wm.detect()); log('detect', out.detect); save(); }
  const c = await tryStep('connect', () => page.evaluate((n) => window.wm.connect(n), n)); if (c) { out.address = c; save(); }
  const msg = (k, text) => tryStep(k, () => page.evaluate(([n, t]) => window.wm.signMessage(n, t), [n, text]));
  const nr = await msg('near', P.nearText); if (nr) out.near = nr.sig;
  const gr = await msg('grant', P.grantText); if (gr) out.grant = gr.sig;
  const tx = (k, b64, v) => tryStep(k, () => page.evaluate(([n, b, v]) => window.wm.signTransaction(n, b, v), [n, b64, v]));
  const lr = await tx('legacy', P.legacyTx, false); if (lr) out.legacy = lr.signed;
  const vr = await tx('v0', P.v0Tx, true); if (vr) out.v0 = vr.signed;
  const rr = await tx('relayer', P.relayerTx, false); if (rr) out.relayer = rr.signed;
  save(); await w.stop(); return out;
}
