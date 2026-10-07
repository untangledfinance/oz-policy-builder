// Real Phantom, its own EVM account: personal_sign of a PrimeKey grant text and eth_signTypedData_v4 of a Safe
// transaction on Base Sepolia (84532). Prompts are approved automatically. Writes pevm-result.json (public data only).
import { chromium } from 'playwright';
import { readFileSync, writeFileSync } from 'node:fs';
import http from 'node:http';
const ID = 'bfnaelmomeimhlpmgjnjophhpkkoljpa', ext = '/home/ubuntu/work/phantom-spike/ext';
const pw = JSON.parse(readFileSync('secrets/phantom-pw.json', 'utf8')).pw;
const PAGE = `<!doctype html><meta charset=utf-8><title>PrimeX</title><body><script>
window.R = {};
window.run = async (text, typed) => {
  const eth = window.phantom.ethereum, R = window.R;
  [R.addr] = await eth.request({ method: 'eth_requestAccounts' });
  R.chainBefore = await eth.request({ method: 'eth_chainId' });
  try { R.switch = await eth.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: '0x14a34' }] }) ?? 'ok'; } catch (e) { R.switch = 'error: ' + (e.message || JSON.stringify(e)); }
  for (let i = 0; i < 10; i++) { R.chainAfter = await eth.request({ method: 'eth_chainId' }); if (R.chainAfter === '0x14a34') break; await new Promise((r) => setTimeout(r, 1000)); }
  try { R.personal = await eth.request({ method: 'personal_sign', params: [text, R.addr] }); } catch (e) { R.personal = 'error: ' + (e.message || e); }
  try { R.hashSig = await eth.request({ method: 'personal_sign', params: [typed.safeTxHash, R.addr] }); } catch (e) { R.hashSig = 'error: ' + (e.message || e); }
  return R;
};
</script>`;
http.createServer((q, r) => { r.setHeader('content-type', 'text/html'); r.end(PAGE); }).listen(8793, '127.0.0.1');
const ctx = await chromium.launchPersistentContext('/home/ubuntu/work/phantom-spike/profile', {
  headless: false, executablePath: '/home/ubuntu/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome',
  viewport: { width: 1100, height: 800 }, args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`],
});
const prompts = [];
process.on('unhandledRejection', (e) => console.log('unhandled', String(e).slice(0, 120)));
ctx.on('page', async (p) => {
  await p.waitForLoadState().catch(() => {}); console.log('PAGE', p.url().slice(0, 120));
  if (!p.url().startsWith(`chrome-extension://${ID}/`) || p.url().includes('popup.html')) return;
  for (let i = 0; i < 60 && !p.isClosed(); i++) {
    await p.waitForTimeout(1000).catch(() => {});
    if (await p.locator('input[type=password]').count().catch(() => 0)) { await p.locator('input[type=password]').first().fill(pw); await p.getByRole('button', { name: 'Unlock' }).click().catch(() => {}); await p.waitForTimeout(3000); continue; }
    const btns = await p.evaluate(() => [...document.querySelectorAll('button')].map(b => b.innerText.trim()).filter(Boolean)).catch(() => []);
    if (i % 5 === 0) console.log('BTNS', JSON.stringify(btns).slice(0, 300), 'TEXT', JSON.stringify((await p.evaluate(() => document.body.innerText).catch(() => '')).slice(0, 400)));
    const label = ['Connect', 'Confirm', 'Sign', 'Approve', 'Switch', 'Switch Network', 'Continue', 'Close'].find(l => btns.includes(l)); if (!label) continue;
    await p.waitForTimeout(1500).catch(() => {});
    prompts.push({ label, text: (await p.evaluate(() => document.body.innerText).catch(() => '')).slice(0, 700) });
    await p.screenshot({ path: `pevm-prompt-${prompts.length}.png` }).catch(() => {});
    await p.getByRole('button', { name: label, exact: true }).first().click().catch(() => {});
    console.log('CLICKED', label); await p.waitForTimeout(2000).catch(() => {}); if (p.isClosed()) return;
  }
});
// unlock first in the popup
const pop = await ctx.newPage(); await pop.goto(`chrome-extension://${ID}/popup.html`); await pop.waitForTimeout(6000);
if (await pop.locator('input[type=password]').count()) { await pop.locator('input[type=password]').first().fill(pw); await pop.getByRole('button', { name: 'Unlock' }).click(); await pop.waitForTimeout(4000); }
const input = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const page = await ctx.newPage(); await page.goto('http://127.0.0.1:8793/'); await page.waitForTimeout(3000);
let result;
try { result = await Promise.race([page.evaluate(({ text, typed }) => window.run(text, typed), input), new Promise((_, rej) => setTimeout(() => rej(new Error('timeout 120 s')), 120000))]); }
catch (e) { result = { error: e.message, partial: await page.evaluate(() => window.R).catch(() => null) }; }
writeFileSync('pevm-result.json', JSON.stringify({ result, prompts }, null, 1));
console.log(JSON.stringify(result));
await ctx.close(); process.exit(0);
