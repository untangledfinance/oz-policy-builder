// Long-lived wallet session with an eval endpoint. usage: DISPLAY=:87 node session.mjs <wallet> <port>
// POST /eval (body = async function body; has ctx, id, H, shot, body, click, sleep, pages(), P(name)) -> JSON result
import http from 'node:http';
import { launch, shot, body, click, sleep, H } from './lib/pw.mjs';
import * as fs from 'node:fs';
const [name, port] = process.argv.slice(2);
const { ctx, id } = await launch(name);
ctx.on('close', () => process.exit(0));
const pages = () => ctx.pages().map((p, i) => `${i}:${p.url().slice(0, 100)}`);
const P = (sub) => ctx.pages().find((p) => p.url().includes(sub));
const AF = Object.getPrototypeOf(async function () {}).constructor;
const G = { ctx, id, H, shot, body, click, sleep, pages, P, fs, name };
http.createServer(async (q, r) => {
  let b = ''; for await (const c of q) b += c;
  try { const out = await new AF(...Object.keys(G), b)(...Object.values(G)); r.end(JSON.stringify(out ?? null, (k, v) => (typeof v === 'bigint' ? v.toString() : v)).slice(0, 20000)); }
  catch (e) { r.statusCode = 500; r.end(JSON.stringify({ error: String(e?.stack ?? e).slice(0, 1500) })); }
}).listen(Number(port), '127.0.0.1');
console.log('session ready', name, id, port);
