// Render every ```mermaid block of a Markdown file with the real Mermaid library in Chromium; report errors.
import { chromium } from '/home/ubuntu/work/phantom-spike/node_modules/playwright/index.mjs';
import { readFileSync, writeFileSync } from 'node:fs';
const md = readFileSync(process.argv[2], 'utf8');
const blocks = [...md.matchAll(/```mermaid\n([\s\S]*?)```/g)].map((m) => m[1]);
const b = await chromium.launch({ executablePath: '/home/ubuntu/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome' });
const p = await b.newPage();
await p.setContent('<html><body></body></html>');
await p.addScriptTag({ content: readFileSync('/tmp/claude-1002/mmd/node_modules/mermaid/dist/mermaid.min.js', 'utf8') });
const out = await p.evaluate(async (blocks) => {
  mermaid.initialize({ startOnLoad: false });
  const r = [];
  for (let i = 0; i < blocks.length; i++) {
    try { const { svg } = await mermaid.render('d' + i, blocks[i]); r.push({ i, ok: true, len: svg.length, svg }); } catch (e) { r.push({ i, ok: false, err: String(e.message || e).slice(0, 300) }); }
  }
  return r;
}, blocks);
for (const r of out) { console.log(r.i, r.ok ? `ok svg ${r.len}` : `ERROR ${r.err}`); if (r.ok) writeFileSync(`/home/ubuntu/work/mmd-check/d${r.i}.svg`, r.svg); }
await b.close();
