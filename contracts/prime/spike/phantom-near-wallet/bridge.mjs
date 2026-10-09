// Real Phantom signs the readable NEAR wallet request texts written by examples/phantom.rs.
import { chromium } from 'playwright';
import { readFileSync, writeFileSync, existsSync, readdirSync, appendFileSync } from 'node:fs';
import http from 'node:http';
const ID = 'bfnaelmomeimhlpmgjnjophhpkkoljpa', ext = '/home/ubuntu/work/phantom-spike/ext', B = '/home/ubuntu/work/phantom-spike/bridge';
const pw = JSON.parse(readFileSync('secrets/phantom-pw.json', 'utf8')).pw;
appendFileSync('bridge.log', '\n--- restart ---\n');
const log = (...a) => { const l = a.map(x => typeof x === 'string' ? x : JSON.stringify(x)).join(' '); appendFileSync('bridge.log', l + '\n'); console.log(l); };
setTimeout(() => { log('GLOBAL TIMEOUT'); process.exit(2); }, 900000);
const PAGE = `<!doctype html><meta charset=utf-8><title>Prime NEAR wallet</title><body><script>
const A='123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const b58=(b)=>{let n=0n;for(const x of b)n=n*256n+BigInt(x);let s='';while(n>0n){s=A[Number(n%58n)]+s;n/=58n;}for(const x of b){if(x)break;s='1'+s;}return s;};
window.signText = async (text) => { const sol = window.phantom.solana; await sol.connect();
  const { signature } = await sol.signMessage(new TextEncoder().encode(text), 'utf8'); return b58(signature); };
</script>`;
http.createServer((q, r) => { r.setHeader('content-type', 'text/html'); r.end(PAGE); }).listen(8791, '127.0.0.1');
const ctx = await chromium.launchPersistentContext('/home/ubuntu/work/phantom-spike/profile', {
  headless: false, executablePath: '/home/ubuntu/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome',
  viewport: { width: 1100, height: 800 }, args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`],
});
let n = 0;
ctx.on('page', async (p) => {
  await p.waitForLoadState().catch(() => {}); if (!p.url().includes('notification.html')) return;
  const k = ++n;
  for (let i = 0; i < 60 && !p.isClosed(); i++) {
    await p.waitForTimeout(1000);
    if (await p.getByTestId('unlock-form-password-input').count().catch(() => 0)) {
      await p.getByTestId('unlock-form-password-input').fill(pw); await p.getByTestId('unlock-form-submit-button').click(); await p.waitForTimeout(3000); continue;
    }
    const btns = await p.evaluate(() => [...document.querySelectorAll('button')].map(b => b.innerText.trim()).filter(Boolean)).catch(() => []);
    const label = ['Connect', 'Confirm', 'Sign', 'Approve'].find(l => btns.includes(l)); if (!label) continue;
    await p.waitForTimeout(1500);
    const text = await p.evaluate(() => document.body.innerText).catch(() => '');
    log(`\n=== Phantom prompt ${k} (${label}) ===\n${text.slice(0, 1500)}\n=== end prompt ${k} ===`);
    await p.screenshot({ path: `bridge-prompt-${k}.png`, fullPage: true }).catch(() => {});
    await p.getByRole('button', { name: label, exact: true }).first().click().catch(e => log('click err', e.message));
    return;
  }
});
let page = await ctx.newPage(); await page.goto('http://127.0.0.1:8791/'); await page.waitForTimeout(2500);
const fresh = async () => { page = await ctx.newPage(); await page.goto('http://127.0.0.1:8791/'); await page.waitForTimeout(2500); };
log('bridge ready');
const done = new Set();
while (!existsSync(`${B}/done`)) {
  for (const f of readdirSync(B).filter(f => f.endsWith('.txt'))) {
    const sig = `${B}/${f.replace('.txt', '.sig')}`; if (done.has(f) || existsSync(sig)) continue;
    done.add(f); const text = readFileSync(`${B}/${f}`, 'utf8');
    try { const s = await page.evaluate((t) => window.signText(t), text); writeFileSync(sig, s); log(`signed ${f}`); }
    catch (e) { log(`sign error ${f}: ${String(e?.message ?? e).slice(0, 200)}`); done.delete(f); if (page.isClosed()) await fresh(); }
  }
  await new Promise(r => setTimeout(r, 500));
}
log('done'); await ctx.close(); process.exit(0);
