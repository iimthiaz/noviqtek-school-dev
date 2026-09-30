// Local test server: Worker API on the D1 shim + static files from ./public.
// Usage: node test/dev-server.mjs [port]  (prints a one-time school setup link)
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { createD1 } from './d1-shim.mjs';
import worker from '../src/worker.js';
import { sha256Hex } from '../src/lib/util.js';

const root = new URL('../public', import.meta.url).pathname;
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json', '.txt': 'text/plain' };
const env = {
  DB: createD1(new URL('../migrations', import.meta.url).pathname),
  AUDIT_KEY: 'dev-audit-key',
  SETUP_KEY: process.env.SETUP_KEY || '',
  ASSETS: { async fetch(req) {
    const p = normalize(decodeURIComponent(new URL(req.url).pathname)).replace(/^(\.\.[/\\])+/, '');
    const file = p === '/' ? '/index.html' : p;
    try { const body = await readFile(join(root, file)); return new Response(body, { headers: { 'content-type': TYPES[extname(file)] || 'application/octet-stream' } }); }
    catch { if (p.startsWith('/vendor/')) return new Response('not found', { status: 404 }); return new Response(await readFile(join(root, 'index.html')), { headers: { 'content-type': 'text/html' } }); }
  } },
};
const port = Number(process.argv[2] || 8787);
const token = 'dev-setup-' + Date.now();
env.DB.raw.prepare("INSERT INTO one_time_tokens (token_hash, purpose, created_at, expires_at) VALUES (?, 'school_setup', ?, ?)").run(await sha256Hex(token), new Date().toISOString(), new Date(Date.now() + 86400e3).toISOString());

http.createServer(async (req, res) => {
  const chunks = []; for await (const c of req) chunks.push(c);
  const body = chunks.length ? Buffer.concat(chunks) : undefined;
  const r = await worker.fetch(new Request(`http://localhost:${port}${req.url}`, { method: req.method, headers: req.headers, body: ['GET', 'HEAD'].includes(req.method) ? undefined : body }), env);
  const headers = {}; r.headers.forEach((v, k) => { headers[k] = v; });
  res.writeHead(r.status, headers);
  res.end(Buffer.from(await r.arrayBuffer()));
}).listen(port, () => console.log(`Dev server http://localhost:${port}\nSetup link: http://localhost:${port}/#/setup/${token}`));
