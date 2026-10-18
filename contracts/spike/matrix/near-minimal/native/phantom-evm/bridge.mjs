// Real Phantom (its own EVM account) as a signing service for pkn.ts. POST / {method:'personal_sign', message: <text or 0x hex>} -> {sig, addr, ms}.
// A 0x-hex message is signed as raw bytes (EIP-191), the Safe eth_sign form. Prompts are confirmed by this script. Public data only in logs.
import { chromium } from 'playwright';
import { readFileSync, appendFileSync } from 'node:fs';
import http from 'node:http';
const ID = 'bfnaelmomeimhlpmgjnjophhpkkoljpa', ext = '/home/ubuntu/work/phantom-spike/ext', HERE = '/home/ubuntu/work/phantom-evm';
const pw = JSON.parse(readFileSync('/home/ubuntu/work/phantom-spike/secrets/phantom-pw.json', 'utf8')).pw;
const log = (o) => appendFileSync(`${HERE}/bridge.log`, JSON.stringify(o) + '\n');
const PAGE = `<!doctype html><meta charset=utf-8><title>PrimeX</title><body><script>
window.addr = async () => { const eth = window.phantom.ethereum; const [a] = await eth.request({ method: 'eth_requestAccounts' }); return a; };
window.sign = async (m) => { const eth = window.phantom.ethereum; const [a] = await eth.request({ method: 'eth_requestAccounts' }); return { addr: a, sig: await eth.request({ method: 'personal_sign', params: [m, a] }) }; };
window.typed = async (data) => { const eth = window.phantom.ethereum; const [a] = await eth.request({ method: 'eth_requestAccounts' }); try { return { addr: a, sig: await eth.request({ method: 'eth_signTypedData_v4', params: [a, JSON.stringify(data)] }) }; } catch (e) { return { addr: a, refused: String(e.message || JSON.stringify(e)).slice(0, 300), code: e.code }; } };
window.chain = async (id) => { const eth = window.phantom.ethereum; const before = await eth.request({ method: 'eth_chainId' }); let sw; try { sw = await eth.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: id }] }) ?? 'ok'; } catch (e) { sw = 'error: ' + (e.message || JSON.stringify(e)); } return { before, switch: sw, after: await eth.request({ method: 'eth_chainId' }) }; };
</script>`;
http.createServer((q, r) => { r.setHeader('content-type', 'text/html'); r.end(PAGE); }).listen(8832, '127.0.0.1');
const ctx = await chromium.launchPersistentContext(`${HERE}/profile`, {
  headless: false, executablePath: '/home/ubuntu/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome',
  viewport: { width: 1100, height: 800 }, args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`],
});
process.on('unhandledRejection', (e) => console.log('unhandled', String(e).slice(0, 160)));
const prompts = [];
ctx.on('page', async (p) => {
  await p.waitForLoadState().catch(() => {});
  if (!p.url().startsWith(`chrome-extension://${ID}/`) || p.url().includes('popup.html')) return;
  for (let i = 0; i < 60 && !p.isClosed(); i++) {
    await p.waitForTimeout(500).catch(() => {});
    if (await p.locator('input[type=password]').count().catch(() => 0)) { await p.locator('input[type=password]').first().fill(pw); await p.getByRole('button', { name: 'Unlock' }).click().catch(() => {}); await p.waitForTimeout(2000); continue; }
    const btns = await p.evaluate(() => [...document.querySelectorAll('button')].map((b) => b.innerText.trim()).filter(Boolean)).catch(() => []);
    const label = ['Connect', 'Confirm', 'Sign', 'Approve', 'Switch', 'Switch Network', 'Continue', 'Close'].find((l) => btns.includes(l)); if (!label) continue;
    let text = ''; for (let k = 0; k < 12; k++) { text = (await p.evaluate(() => document.body.innerText).catch(() => '')).slice(0, 900); if (/Message\n+\S/.test(text) || /requested|prevented/.test(text)) break; await p.waitForTimeout(250).catch(() => {}); }   // wait until the message is on screen
    prompts.push({ label, text, t: Date.now() }); log({ prompt: label, text });
    await p.getByRole('button', { name: label, exact: true }).first().click().catch(() => {}); if (p.isClosed()) return;
    await p.waitForTimeout(500).catch(() => {});
  }
});
const pop = await ctx.newPage(); await pop.goto(`chrome-extension://${ID}/popup.html`); await pop.waitForTimeout(7000);
if (await pop.locator('input[type=password]').count()) { await pop.locator('input[type=password]').first().fill(pw); await pop.getByRole('button', { name: 'Unlock' }).click(); await pop.waitForTimeout(3000); }
const page = await ctx.newPage(); await page.goto('http://127.0.0.1:8832/'); await page.waitForTimeout(4000); if (!(await page.evaluate(() => !!window.phantom?.ethereum))) { await page.reload(); await page.waitForTimeout(4000); } console.log('phantom.ethereum', await page.evaluate(() => !!window.phantom?.ethereum));
let busy = Promise.resolve();
http.createServer(async (q, r) => {
  let b = ''; for await (const c of q) b += c; const a = JSON.parse(b || '{}');
  busy = busy.then(async () => {
    const t0 = Date.now(); let out;
    try {
      if (a.method === 'personal_sign') out = { ...(await page.evaluate((m) => window.sign(m), a.message)), ms: Date.now() - t0 };
      else if (a.method === 'typed') out = { ...(await page.evaluate((d) => window.typed(d), a.data)), ms: Date.now() - t0 };
      else if (a.method === 'address') out = { addr: await page.evaluate(() => window.addr()) };
      else if (a.method === 'chain') out = await page.evaluate((id) => window.chain(id), a.chainId);
      else if (a.method === 'prompts') out = { prompts };
      else if (a.method === 'quit') { r.end('{}'); await ctx.close(); process.exit(0); }
    } catch (e) { out = { error: String(e.message ?? e).slice(0, 300) }; }
    r.end(JSON.stringify(out));
  });
}).listen(8831, '127.0.0.1');
console.log('ready');
