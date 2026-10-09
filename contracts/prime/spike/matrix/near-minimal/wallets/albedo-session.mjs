// Albedo is a web wallet (no extension): plain Chromium profile, intent popups from albedo.link. usage: DISPLAY=:87 node albedo-session.mjs <port>
import http from 'node:http';
import { chromium } from 'playwright';
import { CHROME, H, shot, body, click, sleep } from './lib/pw.mjs';
import { load } from './lib/seed.mjs';
import * as fs from 'node:fs';
const [port] = process.argv.slice(2);
const ctx = await chromium.launchPersistentContext(`${H}/profiles/albedo`, { headless: false, executablePath: CHROME, viewport: { width: 1280, height: 900 }, args: ['--no-first-run'] });
ctx.on('close', () => process.exit(0));
const secret = load().stellar.secret();
const pages = () => ctx.pages().map((p, i) => `${i}:${p.url().slice(0, 100)}`);
const P = (sub) => ctx.pages().find((p) => p.url().includes(sub));
const AF = Object.getPrototypeOf(async function () {}).constructor;
const G = { ctx, H, shot, body, click, sleep, pages, P, fs, secret };
http.createServer(async (q, r) => {
  let b = ''; for await (const c of q) b += c;
  try { const out = await new AF(...Object.keys(G), b)(...Object.values(G)); r.end(JSON.stringify(out ?? null, (k, v) => (typeof v === 'bigint' ? v.toString() : v)).slice(0, 20000)); }
  catch (e) { r.statusCode = 500; r.end(JSON.stringify({ error: String(e?.stack ?? e).slice(0, 1500) })); }
}).listen(Number(port), '127.0.0.1');
console.log('albedo session ready', port);
