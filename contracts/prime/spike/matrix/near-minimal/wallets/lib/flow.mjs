import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { H, mkLog, sleep, shot } from './pw.mjs';
export const hex = (s) => '0x' + Buffer.from(s, 'utf8').toString('hex');
/** Watches extension popup pages and clicks the first matching button (labels = regexes in priority order). */
export function watcher(ctx, extId, o) {
  const log = o.log, seen = new Map(); let step = 'idle', run = true, n = 0, lastAct = Date.now();
  const extRe = new RegExp(`^chrome-extension://${extId}/`);
  const loop = (async () => {
    while (run) {
      await sleep(600);
      if (o.openPopup && step !== 'idle') {
        const pop = ctx.pages().find((q) => q.url().includes(o.openPopup) && q.url().startsWith(`chrome-extension://${extId}/`));
        if (!pop) { const np = await ctx.newPage().catch(() => null); if (np) await np.goto(`chrome-extension://${extId}/${o.openPopup}`).catch(() => {}); lastAct = Date.now(); }
        else if (Date.now() - lastAct > (o.reloadMs ?? 7000)) { await pop.reload().catch(() => {}); lastAct = Date.now(); }
      }
      for (const p of ctx.pages()) {
        if (!extRe.test(p.url()) || (o.skip && o.skip.test(p.url()))) continue;
        let F = p.frames().find((f) => /ses\.html/.test(f.url())) ?? p; let t = ''; try { t = (await F.evaluate(() => document.body?.innerText ?? '')).replace(/\n{2,}/g, '\n'); if (!t.trim() && F !== p) { F = p; t = (await F.evaluate(() => document.body?.innerText ?? '')).replace(/\n{2,}/g, '\n'); } } catch { continue; }
        if (!t.trim()) continue;
        const btns = await F.evaluate(() => [...document.querySelectorAll('button, [role=button]')].map((b) => ({ t: (b.innerText || '').trim(), d: b.disabled || b.getAttribute('aria-disabled') === 'true' }))).catch(() => []);
        if (o.unlock !== false && (await F.locator('input[type=password]:visible').count().catch(() => 0)) === 1 && /unlock|welcome back|enter your password|password/i.test(t) && !/create|confirm password|set password/i.test(t)) {
          const pw = JSON.parse(readFileSync(`${H}/secrets/wm.json`, 'utf8')).pw; const f = F.locator('input[type=password]:visible').first();
          await f.fill(pw).catch(() => {}); await p.keyboard.press('Enter').catch(() => {}); log(`unlocked [${step}]`); await sleep(2500); continue;
        }
        const key = p.url() + '|' + t;
        if (!seen.has(key)) {
          seen.set(key, 1); n++;
          const f = `${o.tag}-${step}-p${n}`;
          log(`\n--- prompt [${step}] ${p.url().replace(extRe, '')} buttons=${JSON.stringify(btns.map((b) => b.t + (b.d ? '(disabled)' : '')).filter(Boolean))}\n${t.slice(0, 2500)}\n---`);
          await shot(p, f);
        }
        for (const re of o.labels) {
          const b = btns.find((b) => !b.d && re.test(b.t));
          if (b) { try { const first = b.t.split('\n')[0]; await F.getByRole('button', { name: first }).filter({ hasText: first }).first().click({ timeout: 3000 }).catch(() => F.getByText(first, { exact: true }).first().click({ timeout: 3000 })); log(`clicked "${first}" [${step}]`); lastAct = Date.now(); await sleep(500); } catch (e) { log('click err', b.t, String(e.message).slice(0, 80)); } break; }
        }
        if (o.extra) await o.extra(p, t, btns, step).catch(() => {});
      }
    }
  })();
  return { setStep: (s) => { step = s; }, stop: async () => { run = false; await loop; } };
}
export async function timed(fn, ms = 90000) { return Promise.race([fn(), new Promise((_, r) => setTimeout(() => r(new Error('timeout ' + ms)), ms))]); }
