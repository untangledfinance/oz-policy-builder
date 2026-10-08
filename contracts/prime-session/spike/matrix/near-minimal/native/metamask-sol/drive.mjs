// Exploration driver for the real MetaMask extension: holds one browser context, takes commands on 127.0.0.1:8820.
import { chromium } from 'playwright';
import http from 'node:http';
import { readFileSync } from 'node:fs';
const SEC = JSON.parse(readFileSync('/home/ubuntu/work/metamask-sol/secrets/mm-test.json', 'utf8'));
const val = (v) => (v === '@srp' ? SEC.srp : v === '@pw' ? SEC.pw : v);
const ctx = await chromium.launchPersistentContext('/home/ubuntu/work/metamask-sol/profile', {
  headless: false, executablePath: '/home/ubuntu/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome',
  viewport: { width: 1280, height: 800 }, args: ['--disable-extensions-except=/home/ubuntu/work/metamask-sol/ext', '--load-extension=/home/ubuntu/work/metamask-sol/ext'],
});
http.createServer((q, r) => { r.setHeader('content-type', 'text/html'); r.end(readFileSync('/home/ubuntu/work/metamask-sol/page.html')); }).listen(8821, '127.0.0.1');
const pages = () => ctx.pages().filter((p) => !p.isClosed());
const pick = (u) => pages().find((p) => (u ? p.url().includes(u) : true));
http.createServer(async (q, r) => {
  let b = ''; for await (const c of q) b += c; const a = b ? JSON.parse(b) : {};
  const out = {};
  try {
    const p = a.page === 'last' ? pages().at(-1) : pick(a.page) ?? pages().at(-1);
    if (a.cmd === 'eval') out.value = await p.evaluate(a.expr);
    if (a.cmd === 'newpage') { const np = await ctx.newPage(); await np.goto(a.url); }
    if (a.cmd === 'xy') await p.mouse.click(a.x, a.y);
    if (a.cmd === 'pages') out.pages = pages().map((x) => x.url());
    if (a.cmd === 'goto') await p.goto(a.url);
    if (a.cmd === 'click') await p.locator(a.sel).first().click({ timeout: 15000 });
    if (a.cmd === 'clicktext') await p.getByText(a.text, { exact: !!a.exact }).first().click({ timeout: 15000 });
    if (a.cmd === 'fill') await p.locator(a.sel).first().fill(val(a.value), { timeout: 15000 });
    if (a.cmd === 'type') await p.locator(a.sel).first().pressSequentially(val(a.value), { delay: 5 });
    if (a.cmd === 'press') await p.keyboard.press(a.key);
    if (a.cmd === 'text') out.text = (await p.locator('body').innerText()).slice(0, a.n ?? 1500);
    if (a.cmd === 'shot') { await p.screenshot({ path: a.path ?? 'shot.png' }); }
    if (a.cmd === 'testids') out.ids = await p.locator('[data-testid]').evaluateAll((es) => es.map((e) => e.getAttribute('data-testid')));
    if (a.cmd === 'quit') { r.end('bye'); await ctx.close(); process.exit(0); }
    out.url = p?.url();
  } catch (e) { out.error = String(e.message ?? e).slice(0, 400); }
  r.end(JSON.stringify(out));
}).listen(8820, '127.0.0.1');
console.log('ready');
