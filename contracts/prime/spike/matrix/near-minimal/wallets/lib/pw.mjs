import { chromium } from 'playwright';
import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync } from 'node:fs';
export const H = '/home/ubuntu/work/wallet-matrix/real';
export const LOGD = '/home/ubuntu/work/prime-refine/logs/wallets';
export const CHROME = '/home/ubuntu/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome';
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const mkLog = (name) => (...a) => { const l = a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' '); appendFileSync(`${LOGD}/${name}.log`, l + '\n'); console.log(l); };
export async function launch(name, extra = []) {
  const ext = `${H}/ext/${name}`;
  const ctx = await chromium.launchPersistentContext(`${H}/profiles/${name}`, {
    headless: false, executablePath: CHROME, viewport: { width: 1280, height: 900 }, ignoreHTTPSErrors: true,
    args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`, '--no-first-run', '--disable-features=DisableLoadExtensionCommandLineSwitch', ...extra],
  });
  let id = null;
  const sw = ctx.serviceWorkers()[0] ?? (await ctx.waitForEvent('serviceworker', { timeout: 15000 }).catch(() => null));
  if (sw) id = new URL(sw.url()).host;
  return { ctx, id, ext };
}
export const shot = async (p, path) => p.screenshot({ path: `${H}/shots/${path}.png`, fullPage: false }).catch(() => {});
export const body = async (p) => (await p.evaluate(() => document.body.innerText).catch(() => '')).replace(/\n{2,}/g, '\n');
export async function click(p, re, o = {}) {
  const tries = [() => p.getByRole('button', { name: re }), () => p.getByRole('link', { name: re }), () => p.getByText(re), () => p.locator(`[data-testid*="${typeof re === 'string' ? re : ''}"]`)];
  for (const t of tries) { try { const l = t().first(); if (await l.count()) { await l.click({ timeout: o.timeout ?? 4000 }); return true; } } catch {} }
  return false;
}
