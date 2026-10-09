// Real MetaMask (13.50.0, built-in Solana account) as a signing service for psn.ts. Localhost HTTP, one request at a time:
//   POST {method:'address'} -> {address}
//   POST {method:'signMessage', text} | {method:'signMessage', hex} -> {signature:[..], ms}
//   POST {method:'signTransaction', tx:<base64 serialized tx with zeroed signature slots>, chain} -> {signedTransaction:<base64>, ms}
// The script confirms every MetaMask prompt and logs its text to bridge.log (public data only).
import { chromium } from 'playwright';
import { readFileSync, appendFileSync } from 'node:fs';
import http from 'node:http';
const HERE = '/home/ubuntu/work/metamask-sol', ID = (process.env.MM_EXT_ID ?? 'nfffegkmfgaaggpipdegnpoifanidlcb');
const { pw } = JSON.parse(readFileSync(`${HERE}/secrets/mm-test.json`, 'utf8'));
const log = (o) => appendFileSync(`${HERE}/bridge.log`, JSON.stringify(o) + '\n');
http.createServer((q, r) => { r.setHeader('content-type', 'text/html'); r.end(readFileSync(`${HERE}/page.html`)); }).listen(8821, '127.0.0.1');
const ctx = await chromium.launchPersistentContext(`${HERE}/profile`, {
  headless: false, executablePath: '/home/ubuntu/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome',
  viewport: { width: 1280, height: 800 }, args: [`--disable-extensions-except=${HERE}/ext`, `--load-extension=${HERE}/ext`],
});
process.on('unhandledRejection', (e) => console.log('unhandled', String(e).slice(0, 200)));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const home = await ctx.newPage(); await home.goto(`chrome-extension://${ID}/home.html`); await sleep(6000);
for (let i = 0; i < 20; i++) { if (await home.locator('input[type=password]').count().catch(() => 0)) { await home.locator('input[type=password]').first().fill(pw); await home.keyboard.press('Enter'); await sleep(3000); break; } if (!home.url().includes('unlock') && i > 3) break; await sleep(1000); }
const note = await ctx.newPage(); await note.goto(`chrome-extension://${ID}/notification.html`); await sleep(2000);
const app = await ctx.newPage(); await app.goto('http://127.0.0.1:8821/'); await sleep(2500);
// click Confirm / Connect on whatever the notification page shows until `done` resolves
async function answerPrompts(done) {
  let fin = false, shotDone = false; done.finally(() => { fin = true; });
  while (!fin) {
    await sleep(250);
    const label = ['Connect', 'Confirm'].find((l) => true && false);
    const body = await note.locator('body').innerText().catch(() => '');
    if (!body || !/Cancel/.test(body)) continue;
    const btn = /Connect this website/.test(body) ? 'Connect' : 'Confirm';
    const target = note.getByText(btn, { exact: true }).last();
    const dis = await note.getByRole('button', { name: btn, exact: true }).last().isDisabled().catch(() => null);
    if (!shotDone) { shotDone = true; await note.screenshot({ path: `${HERE}/last-prompt.png` }).catch(() => {}); }
    log({ prompt: btn, disabled: dis, text: body.slice(0, 700) });
    await target.click({ timeout: 3000 }).catch((e) => log({ clickError: String(e.message).slice(0, 200) }));
    await sleep(600);
  }
}
const withPrompts = async (fn) => { const p = fn(); const guarded = p.then((v) => v, (e) => { throw e; }); const a = answerPrompts(guarded.catch(() => {})); try { return await guarded; } finally { await a; } };
let busy = Promise.resolve();
const accounts = async () => { const l = await app.evaluate(() => window.mm()?.accounts.length ?? 0); if (!l) await withPrompts(() => app.evaluate(() => window.connect().then((r) => r.length))); };
http.createServer(async (q, r) => {
  let b = ''; for await (const c of q) b += c; const a = JSON.parse(b || '{}');
  busy = busy.then(async () => {
    const t0 = Date.now(); let out;
    try {
      await accounts();
      if (a.method === 'address') out = { address: await app.evaluate(() => window.mm().accounts[0].address) };
      else if (a.method === 'useScope') { const v = await withPrompts(() => app.evaluate((s) => window.useScope(s), a.scope)); out = v; }
      else if (a.method === 'signMessage') { const v = await withPrompts(() => a.hex ? app.evaluate((h) => window.signMsgHex(h), a.hex) : app.evaluate((t) => window.signMsg(t), a.text)); out = { signature: v.signature, signedMessage: v.signedMessage, ms: Date.now() - t0 }; }
      else if (a.method === 'signTransaction') { const v = await withPrompts(() => app.evaluate(([x, c]) => window.signTx(x, c), [a.tx, a.chain])); out = { signedTransaction: v.signedTransaction, ms: Date.now() - t0 }; }
      else if (a.method === 'shot') { await note.screenshot({ path: `${HERE}/${a.name ?? 'note'}.png` }); out = { ok: 1, body: (await note.locator('body').innerText()).slice(0, 1500) }; }
      else if (a.method === 'quit') { r.end('{}'); await ctx.close(); process.exit(0); }
    } catch (e) { out = { error: String(e.message ?? e).slice(0, 400) }; }
    r.end(JSON.stringify(out));
  });
}).listen(8830, '127.0.0.1');
console.log('ready');
