#!/usr/bin/env node
/* Local stand-in for the Vercel deployment, so the browser client can be run and
 * tested without deploying. Same routes the Vercel functions expose:
 *   /                      -> web/index.html
 *   /web/* /src/* /client/*-> static repo files (frontend + shared libs + renderer)
 *   POST /api/connect      -> verify a pasted _session_id, set it as an httpOnly cookie
 *   POST /api/disconnect   -> clear it
 *   GET  /api/whoami       -> the connected account, or 401
 *   *    /api/tt/*         -> proxied to timetreeapp.com/api/* (proxy-core.js)
 *
 * Zero dependencies — Node builtins only, like the rest of the repo.
 * Usage: node web/dev-server.js [port]
 */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { proxy, whoami } = require('./proxy-core');
const { readSession, serializeSession } = require('./cookie');

const ROOT = path.join(__dirname, '..');
const PORT = Number(process.argv[2]) || 8787;
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml', '.json': 'application/json', '.ico': 'image/x-icon' };

const readBody = (req) => new Promise((res) => { let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => res(b)); });
const json = (res, status, obj, extra = {}) => { res.writeHead(status, { 'content-type': 'application/json', ...extra }); res.end(JSON.stringify(obj)); };
// dev runs on http://localhost, so the session cookie can't be Secure here.
const setSession = (v) => serializeSession(v, { secure: false });

function serveStatic(req, res) {
  let rel = decodeURIComponent(req.url.split('?')[0]);
  if (rel === '/' || rel === '') rel = '/web/index.html';
  // only these trees are public
  if (!/^\/(web|src|client)\//.test(rel)) return json(res, 404, { error: 'not found' });
  const abs = path.join(ROOT, rel);
  if (!abs.startsWith(ROOT)) return json(res, 403, { error: 'no' });     // traversal guard
  fs.readFile(abs, (err, buf) => {
    if (err) return json(res, 404, { error: 'not found', rel });
    res.writeHead(200, { 'content-type': TYPES[path.extname(abs)] || 'application/octet-stream' });
    res.end(buf);
  });
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://localhost:${PORT}`);
    const p = url.pathname;

    if (p === '/api/connect' && req.method === 'POST') {
      const { session } = JSON.parse((await readBody(req)) || '{}');
      if (!session) return json(res, 400, { error: 'no token' });
      const me = await whoami(session.trim());
      if (!me) return json(res, 401, { error: 'そのトークンではログインできませんでした' });
      return json(res, 200, { user: { id: me.id, name: me.name } }, { 'set-cookie': setSession(session.trim()) });
    }
    if (p === '/api/disconnect' && req.method === 'POST') {
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

server.listen(PORT, () => console.log(`TimeForest web client (dev) on http://localhost:${PORT}`));
