// Explores the real Phantom popup step by step: node pevm-explore.mjs '<json steps>'
// Each step: { role: 'button', name: '…' } | { text: '…' } | { fillPw: true } | { fill: selector, secretFile, field } | { wait: ms }
import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
const ext = '/home/ubuntu/work/phantom-spike/ext', ID = 'bfnaelmomeimhlpmgjnjophhpkkoljpa';
const ctx = await chromium.launchPersistentContext('/home/ubuntu/work/phantom-spike/profile', {
  headless: false, executablePath: '/home/ubuntu/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome',
  viewport: { width: 1100, height: 800 }, args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`],
});
const page = await ctx.newPage();
await page.goto(`chrome-extension://${ID}/popup.html`); await page.waitForTimeout(7000);
const dump = async (p, tag) => {
  const btns = await p.evaluate(() => [...document.querySelectorAll('button,[role=button],a,[role=menuitem]')].filter(e => e.offsetParent !== null).map(b => (b.innerText || b.getAttribute('aria-label') || '').trim().replace(/\s+/g, ' ')).filter(Boolean)).catch(() => []);
  const inputs = await p.evaluate(() => [...document.querySelectorAll('input,textarea')].map(e => `${e.tagName}:${e.type}:${e.placeholder}:${e.name}`)).catch(() => []);
  console.log(`--- ${tag} ${p.url()}\nBUTTONS: ${btns.join(' | ')}\nINPUTS: ${inputs.join(' | ')}`);
};
for (const s of JSON.parse(process.argv[2] ?? '[]')) {
  const p = ctx.pages().at(-1);
  try {
    if (s.fillPw) { await p.locator('input[type=password]').first().fill(JSON.parse(readFileSync('secrets/phantom-pw.json', 'utf8')).pw); await p.getByRole('button', { name: 'Unlock' }).click(); }
    if (s.check) await p.locator('input[type=checkbox]').first().check({ timeout: 8000, force: true });
    if (s.role) await p.getByRole(s.role, { name: s.name, exact: s.exact ?? true }).first().click({ timeout: 8000 });
    if (s.text) await p.getByText(s.text, { exact: s.exact ?? true }).last().click({ timeout: 8000 });
    if (s.fill) await p.locator(s.fill).first().fill(s.secretFile ? JSON.parse(readFileSync(s.secretFile, 'utf8'))[s.field] : s.value, { timeout: 8000 });
    await p.waitForTimeout(s.wait ?? 2500);
    console.log('ok', JSON.stringify({ ...s, value: s.value ? '…' : undefined }));
  } catch (e) { console.log('FAIL', JSON.stringify(s), e.message.split('\n')[0]); await dump(p, 'after-fail'); break; }
}
for (const [i, p] of ctx.pages().entries()) await dump(p, `page ${i}`);
await ctx.pages().at(-1).screenshot({ path: 'pevm.png' });
await ctx.close();
