// Switch the real Freighter test profile's network to Test Net (it showed "Main Net" on message prompts).
import { chromium } from '/home/ubuntu/work/phantom-spike/node_modules/playwright/index.mjs';
import { readFileSync } from 'node:fs';
const EXT = '/home/ubuntu/work/freighter-ext/ext', DIR = '/home/ubuntu/work/freighter-ext';
const w = JSON.parse(readFileSync(`${DIR}/secrets/freighter-real.json`, 'utf8'));
const ctx = await chromium.launchPersistentContext(`${DIR}/profile`, {
  headless: false, executablePath: '/home/ubuntu/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome',
  viewport: { width: 420, height: 700 }, args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
});
let sw = ctx.serviceWorkers()[0]; if (!sw) sw = await ctx.waitForEvent('serviceworker', { timeout: 20000 });
const id = new URL(sw.url()).host;
const p = await ctx.newPage(); await p.goto(`chrome-extension://${id}/index.html`); await p.waitForTimeout(4000);
const texts = async () => (await p.evaluate(() => document.body.innerText).catch(() => '')).replace(/\s+/g, ' ').slice(0, 400);
if (await p.locator('input[type=password]').count()) {
  const f = p.locator('input[type=password]').first(); await f.click(); await f.pressSequentially(w.password, { delay: 20 });
  await p.locator('[data-testid=enter-password-submit]').click({ timeout: 5000 }).catch(() => p.keyboard.press('Enter'));
  await p.waitForTimeout(4000);
}
console.log('BEFORE', await texts());
console.log('BUTTONS', JSON.stringify(await p.evaluate(() => [...document.querySelectorAll('button,[role=button],[data-testid]')].map((b) => [b.tagName, b.getAttribute('data-testid'), b.getAttribute('aria-label'), (b.innerText || '').trim().slice(0, 30), b.offsetParent !== null]).filter((x) => x[1] || x[2] || x[3]).slice(0, 60))));
await p.screenshot({ path: `${DIR}/net-0.png` });
const step = async (n, re) => {
  const c = p.getByText(re).first();
  if (!(await c.count())) { console.log(`step ${n}: no ${re}`); return false; }
  await c.click({ timeout: 5000 }).catch((e) => console.log('click err', String(e).slice(0, 80)));
  await p.waitForTimeout(2500); await p.screenshot({ path: `${DIR}/net-${n}.png` }); console.log(`step ${n}`, await texts()); return true;
};
console.log('NETWORK-BEFORE', JSON.stringify(await p.evaluate(async () => { const all = await chrome.storage.local.get(null); return Object.fromEntries(Object.entries(all).filter(([k]) => /network/i.test(k)).map(([k, v]) => [k, JSON.stringify(v).slice(0, 200)])); })));
await p.locator('[data-testid=network-selector-open]').click({ timeout: 5000 }); await p.waitForTimeout(1500);
console.log('OPTIONS', JSON.stringify(await p.evaluate(() => [...document.querySelectorAll('[data-testid]')].filter((b) => /network/i.test(b.getAttribute('data-testid')) && b.offsetParent !== null).map((b) => [b.getAttribute('data-testid'), (b.innerText || '').trim().slice(0, 20)]))));
await p.getByText(/^Testnet$/).first().click({ timeout: 5000 }); await p.waitForTimeout(3000);
await p.goto(`chrome-extension://${id}/index.html`); await p.waitForTimeout(4000);
console.log('AFTER', await texts());
const net = async () => p.evaluate(async () => { const all = await chrome.storage.local.get(null); return Object.fromEntries(Object.entries(all).filter(([k]) => /network/i.test(k)).map(([k, v]) => [k, typeof v === 'string' ? v.slice(0, 200) : JSON.stringify(v).slice(0, 200)])); });
console.log('NETWORK', JSON.stringify(await net()));
await p.screenshot({ path: `${DIR}/net-after.png` });
await ctx.close(); process.exit(0);
