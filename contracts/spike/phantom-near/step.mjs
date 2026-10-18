// Runs one step against a persistent Phantom profile; usage: node step.mjs <url> [actions.json]
import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
const ext = '/home/ubuntu/work/phantom-spike/ext';
const ctx = await chromium.launchPersistentContext('/home/ubuntu/work/phantom-spike/profile', {
  headless: false, executablePath: '/home/ubuntu/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome',
  viewport: { width: 1100, height: 800 }, args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`],
});
const page = await ctx.newPage();
page.on('console', m => { if (m.type() === 'error') console.log('CONSOLE', m.text().slice(0, 200)); });
page.on('requestfailed', r => console.log('REQFAIL', r.url().slice(0, 120), r.failure()?.errorText));
await page.goto(process.argv[2]); await page.waitForTimeout(3000);
const acts = process.argv[3] ? JSON.parse(readFileSync(process.argv[3], 'utf8')) : [];
for (const a of acts) {
  try {
    if (a.click) await page.getByText(a.click, { exact: a.exact ?? false }).first().click({ timeout: 8000 });
    if (a.testid) await page.getByTestId(a.testid).first().click({ timeout: 8000 });
    if (a.fill) await page.locator(a.fill).first().fill(a.text, { timeout: 8000 });
    if (a.fillSecret) await page.locator(a.fillSecret).first().fill(JSON.parse(readFileSync('/home/ubuntu/work/phantom-spike/secrets/phantom-test.json','utf8')).secret, { timeout: 8000 });
    if (a.fillPassword) await page.locator(a.fillPassword).first().fill(JSON.parse(readFileSync('/home/ubuntu/work/phantom-spike/secrets/phantom-pw.json','utf8')).pw, { timeout: 8000 });
    if (a.check) await page.locator(a.check).first().check({ timeout: 8000 });
    await page.waitForTimeout(a.wait ?? 1500);
    console.log('ok', JSON.stringify(a).replace(/"text":"[^"]*"/, '"text":"…"'));
  } catch (e) { console.log('FAIL', JSON.stringify(a).replace(/"text":"[^"]*"/, '"text":"…"'), e.message.split('\n')[0]); break; }
}
await page.waitForTimeout(2000);
for (const [i, p] of ctx.pages().entries()) { const t = await p.evaluate(() => document.body?.innerText || '').catch(() => ''); console.log(`=== page ${i} ${p.url()}\n${t.slice(0, 600)}`); }
const btns = await page.evaluate(() => [...document.querySelectorAll('button,[role=button],a')].map(b => (b.innerText||b.getAttribute('aria-label')||'').trim()).filter(Boolean));
console.log('---BUTTONS---\n' + btns.join(' | '));
await page.screenshot({ path: 'step.png' });
const text = await page.evaluate(() => document.body.innerText);
console.log('---TEXT---\n' + text.slice(0, 1200));
const ids = await page.evaluate(() => [...document.querySelectorAll('[data-testid]')].map(e => e.getAttribute('data-testid')).slice(0, 60));
console.log('---TESTIDS---\n' + ids.join(' '));
const inputs = await page.evaluate(() => [...document.querySelectorAll('input,textarea')].map(e => `${e.tagName} name=${e.name} type=${e.type} ph=${e.placeholder}`));
console.log('---INPUTS---\n' + inputs.join('\n'));
const dd = await page.evaluate(() => [...document.querySelectorAll('[data-testid^=dropdown-item]')].map(e => e.getAttribute('data-testid')+'='+e.innerText.trim()));
console.log('---DROPDOWN---\n' + dd.join(' | '));
await ctx.close();
