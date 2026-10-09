import { readFileSync, writeFileSync } from 'node:fs';
import { H, mkLog, sleep } from './pw.mjs';
import { watcher, hex, timed } from './flow.mjs?v=7';
export async function evmFlow(ctx, extId, name, o) {
  const log = mkLog(name); const P = JSON.parse(readFileSync(`${H}/payloads/evm.json`, 'utf8'));
  const outf = `${H}/out/${name}.evm.json`; let out = {}; try { out = JSON.parse(readFileSync(outf, 'utf8')); } catch {}
  const w = watcher(ctx, extId, { tag: name, log, labels: o.labels, skip: o.skip, extra: o.extra, openPopup: o.openPopup, reloadMs: o.reloadMs });
  const page = await ctx.newPage(); await page.goto('http://127.0.0.1:8801/evm.html'); await sleep(2500);
  const run = (fn, arg) => page.evaluate(fn, arg);
  const steps = o.steps ?? ['connect', 'grant', 'near', 'ethSign', 'chain', 'typed'];
  const R = { providers: await run(() => window.wm.list()) }; log('providers', R.providers);
  const save = () => writeFileSync(outf, JSON.stringify(out, null, 1));
  const tryStep = async (k, fn) => { if (!steps.includes(k)) return; w.setStep(k); try { const v = await timed(fn, o.timeout ?? 90000); log(`[${k}] ok`, typeof v === 'string' ? v.slice(0, 40) + '…' : v); return v; } catch (e) { log(`[${k}] ERROR`, String(e.message).slice(0, 300)); out[k + 'Error'] = String(e.message).slice(0, 300); } finally { save(); await sleep(o.gap ?? 3000); } };
  const c = await tryStep('connect', () => run((n) => window.wm.connect(n), o.provider ?? null)); if (c) { out.address = c.accounts[0]; out.chainId = c.chainId; save(); }
  if (!out.address && !steps.includes('connect')) out.address = (await run(() => window.wm.connect(null))).accounts[0];
  if (!out.address) { await w.stop(); return out; }
  const g = await tryStep('grant', () => run(([m, a]) => window.wm.personal(m, a), [hex(P.grantText), out.address])); if (g) out.grant = g;
  const n = await tryStep('near', () => run(([m, a]) => window.wm.personal(m, a), [hex(P.nearText), out.address])); if (n) out.near = n;
  const e = await tryStep('ethSign', () => run(([m, a]) => window.wm.personal(m, a), [P.safeTxHash, out.address])); if (e) out.ethSign = e;
  if (steps.includes('chain')) {
    w.setStep('chain');
    try { await timed(() => run((h) => window.wm.switchChain(h), '0x14a34'), o.timeout ?? 90000); out.switched = 'switch'; }
    catch (err) { log('[chain] switch ERROR', String(err.message).slice(0, 200)); out.switchError = String(err.message).slice(0, 200);
      if (o.addChain !== false) try { await timed(() => run((p) => window.wm.addChain(p), { chainId: '0x14a34', chainName: 'Base Sepolia', nativeCurrency: { name: 'ETH', symbol: 'ETH', decimals: 18 }, rpcUrls: ['https://sepolia.base.org'], blockExplorerUrls: ['https://sepolia.basescan.org'] }), o.timeout ?? 90000); out.switched = 'add'; } catch (e2) { log('[chain] add ERROR', String(e2.message).slice(0, 200)); out.addError = String(e2.message).slice(0, 200); } }
    save(); }
  out.chainAfterSwitch = await run(() => window.wm.chain()).catch(() => null);
  const t = await tryStep('typed', () => run(([a, d]) => window.wm.typed(a, d), [out.address, P.typed])); if (t) out.typed = t;
  save(); await w.stop(); return out;
}
