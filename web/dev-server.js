#!/usr/bin/env node
/* Local stand-in for the Vercel deployment. Serves the SAME self-contained
 * bundle (web/dist, from build.js) that Vercel serves, and the same API routes:
 *   /...                   -> web/dist/... (static, confined to that dir)
 *   POST /api/connect      -> verify a pasted _session_id, set it as an httpOnly cookie
 *   POST /api/disconnect   -> clear it
 *   GET  /api/whoami       -> the connected account, or 401
 *   *    /api/tt/*         -> proxied to timetreeapp.com/api/* (web/proxy-core.js)
 *
 * Serving only web/dist (never the repo) is what makes traversal harmless: there
 * is nothing sensitive under the served root. Binds loopback only. Zero deps.
 * Usage: node web/build.js && node web/dev-server.js [port]
 */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { proxy, whoami } = require('./proxy-core');
const { readSession, serializeSession, isTrustedWrite } = require('./cookie');

const DIST = path.join(__dirname, 'dist');
const PORT = Number(process.argv[2]) || 8787;
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml', '.json': 'application/json', '.ico': 'image/x-icon' };

const readBody = (req) => new Promise((res) => { let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => res(b)); });
const json = (res, status, obj, extra = {}) => { res.writeHead(status, { 'content-type': 'application/json', ...extra }); res.end(JSON.stringify(obj)); };
const setSession = (v) => serializeSession(v, { secure: false });   // dev is http://localhost

function serveStatic(req, res) {
  let rel = decodeURIComponent((req.url.split('?')[0]) || '/');
  if (rel === '/' || rel === '') rel = '/index.html';
  const abs = path.resolve(DIST, '.' + rel);
  // Confine to DIST: resolve() collapses any ../, so a path that escaped would no
  // longer start with DIST. (There is nothing sensitive under DIST anyway.)
  if (abs !== DIST && !abs.startsWith(DIST + path.sep)) return json(res, 403, { error: 'no' });
  fs.readFile(abs, (err, buf) => {
    if (err) return json(res, 404, { error: 'not found' });
    res.writeHead(200, { 'content-type': TYPES[path.extname(abs)] || 'application/octet-stream' });
    res.end(buf);
  });
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://localhost:${PORT}`);
    const p = url.pathname;

    if (p === '/api/connect' && req.method === 'POST') {
      if (!isTrustedWrite(req)) return json(res, 403, { error: 'bad request' });
      const { session } = JSON.parse((await readBody(req)) || '{}');
      if (!session) return json(res, 400, { error: 'no token' });
      const me = await whoami(session.trim());
      if (!me) return json(res, 401, { error: 'そのトークンではログインできませんでした' });
      return json(res, 200, { user: { id: me.id, name: me.name } }, { 'set-cookie': setSession(session.trim()) });
    }
    if (p === '/api/disconnect' && req.method === 'POST') {
      if (!isTrustedWrite(req)) return json(res, 403, { error: 'bad request' });
      return json(res, 200, { ok: true }, { 'set-cookie': setSession('') });
    }
    if (p === '/api/whoami') {
      const session = readSession(req);
      if (!session) return json(res, 401, { error: 'not connected' });
      const me = await whoami(session);
      return me ? json(res, 200, { user: { id: me.id, name: me.name } }) : json(res, 401, { error: 'session expired' }, { 'set-cookie': setSession('') });
    }
    if (p.startsWith('/api/tt/')) {
      const session = readSession(req);
      const rest = p.slice('/api/tt'.length);               // keeps leading slash
      const out = await proxy({ method: req.method, path: rest, search: url.search, body: ['GET', 'HEAD'].includes(req.method) ? undefined : await readBody(req), session });
      res.writeHead(out.status, { 'content-type': out.contentType });
      return res.end(out.text);
    }
    return serveStatic(req, res);
  } catch (e) {
    json(res, 500, { error: String(e && e.message || e) });
  }
});

if (!fs.existsSync(path.join(DIST, 'index.html'))) {
  console.error('web/dist is missing — run `node web/build.js` first.');
  process.exit(1);
}
server.listen(PORT, '127.0.0.1', () => console.log(`TimeForest web client (dev) on http://localhost:${PORT}`));
