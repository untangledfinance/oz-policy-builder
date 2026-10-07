// Drive the real Freighter 5.49 extension: import the test recovery phrase, then sign texts via @stellar/freighter-api.
import { chromium } from '/home/ubuntu/work/phantom-spike/node_modules/playwright/index.mjs';
import { readFileSync, writeFileSync, appendFileSync, existsSync, readdirSync } from 'node:fs';
import https from 'node:https';
const EXT = '/home/ubuntu/work/freighter-ext/ext', DIR = '/home/ubuntu/work/freighter-ext', B = `${DIR}/bridge`;
const w = JSON.parse(readFileSync(`${DIR}/secrets/freighter-real.json`, 'utf8'));
const log = (...a) => { const l = a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' '); appendFileSync(`${DIR}/freighter.log`, l + '\n'); console.log(l); };
setTimeout(() => { log('GLOBAL TIMEOUT'); process.exit(2); }, 1_500_000);
const API = readFileSync('/home/ubuntu/git/github.com/untangledfinance/octopos/node_modules/.bun/@stellar+freighter-api@6.0.0/node_modules/@stellar/freighter-api/build/index.min.js', 'utf8');
const PAGE = `<!doctype html><meta charset=utf-8><title>Prime Freighter test</title><body>Prime<script>${API}</script><script>
window.signText = async (text) => { const api = window.freighterApi;
  const a = await api.requestAccess(); if (a.error) throw new Error('access: ' + JSON.stringify(a.error));
  const r = await api.signMessage(text, { address: a.address }); if (r.error) throw new Error('sign: ' + JSON.stringify(r.error));
  const s = r.signedMessage; return typeof s === 'string' ? s : btoa(String.fromCharCode(...new Uint8Array(s.data ?? s))); };
</script>`;
https.createServer({ key: readFileSync(`${DIR}/secrets/tls-key.pem`), cert: readFileSync(`${DIR}/tls-cert.pem`) }, (q, r) => { r.setHeader('content-type', 'text/html'); r.end(PAGE); }).listen(8792, '127.0.0.1');
const ctx = await chromium.launchPersistentContext(`${DIR}/profile`, {
  headless: false, executablePath: '/home/ubuntu/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome',
  viewport: { width: 1100, height: 800 }, args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, '--ignore-certificate-errors'], ignoreHTTPSErrors: true,
});
let sw = ctx.serviceWorkers()[0]; if (!sw) sw = await ctx.waitForEvent('serviceworker', { timeout: 20000 });
const id = new URL(sw.url()).host; log('extension id', id);
const shot = async (p, n) => { await p.screenshot({ path: `${DIR}/shot-${n}.png` }).catch(() => {}); };
const texts = async (p) => (await p.evaluate(() => document.body.innerText).catch(() => '')).replace(/\s+/g, ' ').slice(0, 600);
const click = async (p, re) => { try { const b = p.getByRole('button', { name: re }).first(); if (await b.count()) { await b.click({ timeout: 5000 }); return true; } const l = p.getByText(re).first(); if (await l.count()) { await l.click({ timeout: 5000 }); return true; } } catch (e) { log('click failed', String(e.message).slice(0, 80)); } return false; };

// ── onboarding: import wallet ───────────────────────────────────────────────
if (!existsSync(`${DIR}/onboarded`)) {
  const p = await ctx.newPage(); await p.goto(`chrome-extension://${id}/index.html`); await p.waitForTimeout(3000);
  for (let step = 0; step < 25; step++) {
    const t = await texts(p); log(`[step ${step}] ${t}`); await shot(p, step);
    if (/you.?re all set|welcome back/i.test(t)) { writeFileSync(`${DIR}/onboarded`, ''); log('onboarded'); break; }
    const pw = p.locator('input[type=password]');
    if (/recovery phrase/i.test(t)) { const inp = p.locator('input'); await inp.first().click(); await inp.first().fill('');
      await p.evaluate((m) => navigator.clipboard?.writeText?.(m).catch(() => {}), w.mnemonic).catch(() => {});
      await inp.first().fill(w.mnemonic); await p.waitForTimeout(800);
      const words = w.mnemonic.split(' '); const n = await inp.count();
      for (let i = 0; i < Math.min(12, n); i++) { const v = await inp.nth(i).inputValue().catch(() => ''); if (v !== words[i]) await inp.nth(i).fill(words[i]); }
      await shot(p, `import-${step}`); await click(p, /^import$/i); await p.waitForTimeout(5000); continue; }
    if (/I already have a wallet/i.test(t) && (await click(p, /I already have a wallet/i))) { await p.waitForTimeout(1500); continue; }
    if ((await pw.count()) >= 2) { await pw.nth(0).fill(w.password); await pw.nth(1).fill(w.password);
      const cb = p.locator('input[type=checkbox]'); for (let i = 0; i < (await cb.count()); i++) await cb.nth(i).check({ force: true }).catch(() => {});
      await click(p, /confirm|continue|next/i); await p.waitForTimeout(2500); continue; }
    const words = w.mnemonic.split(' ');
    const boxes = p.locator('input[type=text], input:not([type])');
    if ((await boxes.count()) >= 12) { for (let i = 0; i < 12; i++) await boxes.nth(i).fill(words[i]); await click(p, /import|confirm|continue/i); await p.waitForTimeout(4000); continue; }
    const ta = p.locator('textarea'); if (await ta.count()) { await ta.first().fill(w.mnemonic); await click(p, /import|confirm|continue/i); await p.waitForTimeout(4000); continue; }
    if (/all set|wallet is ready|you.?re all set|done/i.test(t) || /G[A-Z2-7]{3,}…|GBXP/i.test(t)) { writeFileSync(`${DIR}/onboarded`, ''); log('onboarded'); break; }
    if (!(await click(p, /continue|next|got it|done|skip|agree|accept/i))) await p.waitForTimeout(1500);
  }
  await p.close();
}
// ── signing bridge ────────────────────────────────────────────────────────
ctx.on('page', async (p) => {
  await p.waitForLoadState().catch(() => {}); if (!p.url().includes(id)) return;
  for (let i = 0; i < 60 && !p.isClosed(); i++) {
    await p.waitForTimeout(1000);
    const t = await texts(p);
    if (await p.locator('input[type=password]').count()) { const f = p.locator('input[type=password]').first(); await f.click().catch(() => {}); await f.fill(''); await f.pressSequentially(w.password, { delay: 20 });
      await p.waitForTimeout(500); await p.locator('[data-testid=enter-password-submit]').click({ timeout: 5000 }).catch(() => p.keyboard.press('Enter')); log('[popup] unlocked'); await p.waitForTimeout(2000); continue; }
    log('[popup]', t.slice(0, 300));
    if (/connect|share|grant/i.test(t) && (await click(p, /^connect$|^confirm$|^approve$|^allow$/i))) { log('[popup] connect', t.slice(0, 200)); continue; }
    if (/sign message|message/i.test(t)) { log('\n=== Freighter prompt ===\n' + t + '\n=== end ==='); await shot(p, `prompt-${Date.now()}`); if (await click(p, /^sign|^confirm|^approve/i)) return; }
  }
});
const page = await ctx.newPage(); await page.goto('https://127.0.0.1:8792/'); await page.waitForTimeout(3000);
log('bridge ready');
const done = new Set();
while (!existsSync(`${B}/done`)) {
  for (const f of readdirSync(B).filter((f) => f.endsWith('.txt'))) {
    const sig = `${B}/${f.replace('.txt', '.sig')}`; if (done.has(f) || existsSync(sig)) continue;
    done.add(f);
    try { const s = await page.evaluate((t) => window.signText(t), readFileSync(`${B}/${f}`, 'utf8')); writeFileSync(sig, s); log(`signed ${f}`); }
    catch (e) { log(`sign error ${f}: ${String(e?.message ?? e).slice(0, 300)}`); writeFileSync(sig + '.err', String(e?.message ?? e)); }
  }
  await new Promise((r) => setTimeout(r, 500));
}
log('done'); await ctx.close(); process.exit(0);
