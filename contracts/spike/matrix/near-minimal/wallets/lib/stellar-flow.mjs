import { readFileSync, writeFileSync } from 'node:fs';
import { H, mkLog, sleep } from './pw.mjs';
import { watcher, timed } from './flow.mjs?v=7';
const pick = (r) => { if (r == null) return null; if (typeof r === 'string') return r; if (r.type === 'Buffer' && Array.isArray(r.data)) return Buffer.from(r.data).toString('base64'); if (r.error) return null; for (const k of ['signedMessage', 'signedAuthEntry', 'signedTxXdr', 'signature', 'result', 'xdr', 'signed_envelope_xdr']) if (r[k] != null) return r[k]; return null; };
export async function stellarFlow(ctx, extId, name, o) {
  const log = mkLog(name); const P = JSON.parse(readFileSync(`${H}/payloads/stellar.json`, 'utf8'));
  const outf = `${H}/out/${name}.stellar.json`; let out = {}; try { out = JSON.parse(readFileSync(outf, 'utf8')); } catch {}
  const w = watcher(ctx, extId, { tag: name, log, labels: o.labels, skip: o.skip, extra: o.extra, unlock: o.unlock, openPopup: o.openPopup, reloadMs: o.reloadMs });
  const page = await ctx.newPage(); await page.goto(o.url ?? 'http://localhost:8801/stellar.html'); await sleep(2500);
  const api = o.api, steps = o.steps ?? ['detect', 'connect', 'near', 'grant', 'vote', 'tx'];
  const save = () => writeFileSync(outf, JSON.stringify(out, null, 1));
  const call = (fn, args) => page.evaluate(([a, f, x]) => window.wm[a][f](...x), [api, fn, args]);
  const tryStep = async (k, fn) => { if (!steps.includes(k)) return; w.setStep(k); try { const v = await timed(fn, o.timeout ?? 90000); out[k + 'Raw'] = v; log(`[${k}] ok`, JSON.stringify(v).slice(0, 200)); return v; } catch (e) { log(`[${k}] ERROR`, String(e.message).slice(0, 400)); out[k + 'Error'] = String(e.message).slice(0, 400); } finally { save(); await sleep(o.gap ?? 3000); } };
  if (steps.includes('detect')) { out.detect = await page.evaluate(() => window.wm.detect()); log('detect', out.detect); save(); }
  let addr = null;
  const c = await tryStep('connect', () => call('connect', [])); if (c) { addr = typeof c === 'string' ? c : (c.address ?? c.publicKey ?? pick(c)); out.address = addr; save(); }
  const m = o.methods ?? {};
  const near = await tryStep('near', () => call(m.signMessage ?? 'signMessage', m.msgArgs ? m.msgArgs(P.nearText, addr, P) : [P.nearText, addr, P.passphrase])); if (near) out.near = pick(near);
  const g = await tryStep('grant', () => call(m.signAuthEntry ?? 'signAuthEntry', [P.grantPreimage, addr])); if (g) out.grant = pick(g);
  const v = await tryStep('vote', () => call(m.signAuthEntry ?? 'signAuthEntry', [P.votePreimage, addr])); if (v) out.vote = pick(v);
  const t = await tryStep('tx', () => call(m.signTransaction ?? 'signTransaction', m.txArgs ? m.txArgs(P, addr) : [P.txXdr, addr, P.passphrase])); if (t) out.tx = pick(t);
  save(); await w.stop(); return out;
}
