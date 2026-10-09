// Imports the local test seed into the real MetaMask extension (profile ./profile). Public output only.
import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
const { srp, pw } = JSON.parse(readFileSync('secrets/mm-test.json', 'utf8'));
const ctx = await chromium.launchPersistentContext('/home/ubuntu/work/metamask-sol/profile', {
  headless: false, executablePath: '/home/ubuntu/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome',
  viewport: { width: 1280, height: 800 }, args: ['--disable-extensions-except=/home/ubuntu/work/metamask-sol/ext', '--load-extension=/home/ubuntu/work/metamask-sol/ext'],
});
let p = ctx.pages().find((x) => x.url().includes('home.html'));
for (let i = 0; i < 30 && !p; i++) { await new Promise((r) => setTimeout(r, 1000)); p = ctx.pages().find((x) => x.url().includes('home.html')); }
console.log('URL', p?.url());
const dump = async (n) => { await p.screenshot({ path: `ob-${n}.png` }); console.log(n, JSON.stringify((await p.locator('button, input, a').evaluateAll(() => 0).catch(() => null))), JSON.stringify((await p.locator('body').innerText()).slice(0, 600))); };
await new Promise((r) => setTimeout(r, 3000)); await dump(0);
await ctx.close();
