import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { appendFileSync, writeFileSync } from 'node:fs';
writeFileSync('run.log','');
const _log = console.log; console.log = (...a) => { const l = a.map(x => typeof x === 'string' ? x : JSON.stringify(x)).join(' '); appendFileSync('run.log', l + '\n'); _log(l); };
setTimeout(() => { console.log('GLOBAL TIMEOUT'); process.exit(2); }, 240000);
const ID = 'bfnaelmomeimhlpmgjnjophhpkkoljpa', ext = '/home/ubuntu/work/phantom-spike/ext';
const pw = JSON.parse(readFileSync('secrets/phantom-pw.json', 'utf8')).pw;
const ctx = await chromium.launchPersistentContext('/home/ubuntu/work/phantom-spike/profile', {
  headless: false, executablePath: '/home/ubuntu/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome',
  viewport: { width: 1100, height: 800 }, args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`],
});
// 1. unlock
const pop = await ctx.newPage(); await pop.goto(`chrome-extension://${ID}/popup.html`); await pop.waitForTimeout(2500);
if (await pop.getByTestId('unlock-form-password-input').count()) {
  await pop.getByTestId('unlock-form-password-input').fill(pw); await pop.getByTestId('unlock-form-submit-button').click(); await pop.waitForTimeout(9000);
}
console.log('popup after unlock:', (await pop.evaluate(() => document.body.innerText)).slice(0, 200).replace(/\n+/g, ' | '));
// 2. approve every Phantom notification window, recording what the user sees
let n = 0;
ctx.on('page', async (p) => {
  if (!p.url().includes('notification.html')) { await p.waitForLoadState().catch(() => {}); if (!p.url().includes('notification.html')) return; }
  const k = ++n;
  for (let i = 0; i < 60 && !p.isClosed(); i++) {
    await p.waitForTimeout(1000);
    if (await p.getByTestId('unlock-form-password-input').count().catch(() => 0)) {
      await p.getByTestId('unlock-form-password-input').fill(pw); await p.getByTestId('unlock-form-submit-button').click();
      console.log(`prompt ${k}: unlocked wallet`); await p.waitForTimeout(3000); continue;
    }
    const btns = await p.evaluate(() => [...document.querySelectorAll('button')].map(b => b.innerText.trim()).filter(Boolean)).catch(() => []);
    const label = ['Connect', 'Confirm', 'Sign', 'Approve'].find(l => btns.includes(l));
    if (!label) continue;
    await p.waitForTimeout(1500);
    const text = await p.evaluate(() => document.body.innerText).catch(() => '');
    console.log(`\n=== Phantom prompt ${k} ===\n${text}\n=== end prompt ${k} ===\nbuttons: ${btns.join(' | ')}`);
    await p.screenshot({ path: `prompt-${k}.png` }).catch(() => {});
    await p.getByRole('button', { name: label, exact: true }).first().click().catch(e => console.log('click err', e.message));
    console.log(`prompt ${k}: clicked ${label}`); return;
  }
  console.log(`prompt ${k}: no approve button found`);
});
// 3. the dApp
const page = await ctx.newPage(); await page.goto('http://127.0.0.1:8790/'); await page.waitForTimeout(2500);
const payloadHex = createHash('sha256').update('Prime session grant: Phantom via NEAR testnet').digest('hex');
const watch = setInterval(async () => { for (const p of ctx.pages()) console.log('  [page]', p.url().slice(0, 90)); }, 15000);
const res = await page.evaluate((h) => window.runTest(h).catch(e => ({ error: String(e?.message ?? e) })), payloadHex);
console.log('\nRESULT', JSON.stringify(res, null, 1));
await page.waitForTimeout(1000); await ctx.close();
