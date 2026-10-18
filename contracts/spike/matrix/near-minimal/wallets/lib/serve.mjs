import http from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
const H = '/home/ubuntu/work/wallet-matrix/real';
const [port] = process.argv.slice(2);
http.createServer((q, r) => { const f = `${H}/dapp${q.url.split('?')[0] === '/' ? '/index.html' : q.url.split('?')[0]}`; if (!existsSync(f)) { r.statusCode = 404; return r.end('nf'); }
  r.setHeader('content-type', f.endsWith('.js') ? 'text/javascript' : 'text/html'); r.end(readFileSync(f)); }).listen(Number(port), '127.0.0.1');
console.log('serving dapp on', port);
