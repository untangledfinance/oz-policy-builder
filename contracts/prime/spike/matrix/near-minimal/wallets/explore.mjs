// usage: DISPLAY=:87 node explore.mjs <wallet> [path-or-url] [waitSec]
import { launch, shot, body, sleep } from './lib/pw.mjs';
const [name, target, wait] = process.argv.slice(2);
const { ctx, id } = await launch(name);
console.log('ext id', id);
ctx.on('page', (p) => p.on('console', (m) => ['error'].includes(m.type()) && console.log('console.error', m.text().slice(0, 200))));
await sleep(3000);
if (target) { const p = await ctx.newPage(); p.on('console', (m) => m.type() === 'error' && console.log('console.error', m.text().slice(0, 200))); p.on('pageerror', (e) => console.log('pageerror', String(e).slice(0, 200))); await p.goto(target.startsWith('http') || target.startsWith('chrome') ? target : `chrome-extension://${id}/${target}`); await sleep(Number(wait ?? 5) * 1000); }
let i = 0;
for (const p of ctx.pages()) { console.log('PAGE', p.url()); console.log((await body(p)).slice(0, 800)); await shot(p, `${name}-explore-${i++}`); }
await ctx.close(); process.exit(0);
