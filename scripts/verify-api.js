#!/usr/bin/env node
/* Unit-test the Vercel serverless adapters (api/*.js) with mock req/res — the
 * code that actually runs in production, which the local dev server never
 * exercises (it has its own routing). No network: only the guard, parse and
 * error paths are checked (the happy paths call proxy-core, which is covered by
 * the browser E2E). proxy-core.proxy is stubbed so the /api/tt path/body mapping
 * can be asserted without hitting TimeTree. Zero-dep; runs in CI.
 */
const path = require('node:path');
const ROOT = path.join(__dirname, '..');

// Stub proxy-core.proxy BEFORE the tt handler destructures it, to capture args.
const proxyCore = require(path.join(ROOT, 'web', 'proxy-core'));
let lastProxyArgs = null;
proxyCore.proxy = async (args) => { lastProxyArgs = args; return { status: 299, contentType: 'application/json', text: '{}' }; };

const connect = require(path.join(ROOT, 'api', 'connect'));
const disconnect = require(path.join(ROOT, 'api', 'disconnect'));
const whoami = require(path.join(ROOT, 'api', 'whoami'));
const ttHandler = require(path.join(ROOT, 'api', 'tt', '[...path]'));

let fail = 0;
const ok = (m) => console.log('  \x1b[32mok\x1b[0m   ' + m);
const bad = (m) => { fail++; console.log('  \x1b[31mFAIL\x1b[0m ' + m); };
const check = (c, m) => (c ? ok(m) : bad(m));

function mockRes() {
  return { _s: 0, _body: undefined, _headers: {}, status(c) { this._s = c; return this; }, json(o) { this._body = o; return this; }, send(t) { this._body = t; return this; }, setHeader(k, v) { this._headers[k.toLowerCase()] = v; } };
}
const run = async (handler, req) => { const res = mockRes(); await handler(req, res); return res; };
const JSONH = { 'content-type': 'application/json' };

(async () => {
  // --- connect: guards before any network ---
  check((await run(connect, { method: 'GET', headers: {} }))._s === 405, 'connect rejects non-POST (405)');
  check((await run(connect, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: { session: 'x' } }))._s === 403, 'connect rejects a non-JSON body — blocks simple-form CSRF (403)');
  check((await run(connect, { method: 'POST', headers: { ...JSONH, origin: 'https://evil.example', host: 'app.vercel.app' }, body: { session: 'x' } }))._s === 403, 'connect rejects a cross-origin POST (403)');
  check((await run(connect, { method: 'POST', headers: { ...JSONH }, body: {} }))._s === 400, 'connect with no token → 400 (never reaches the network)');

  // --- disconnect: POST + same-origin JSON, else refused ---
  check((await run(disconnect, { method: 'GET', headers: {} }))._s === 405, 'disconnect ignores a bare GET — blocks logout-CSRF (405)');
  check((await run(disconnect, { method: 'POST', headers: { 'content-type': 'text/plain' } }))._s === 403, 'disconnect rejects a non-JSON POST (403)');
  {
    const res = await run(disconnect, { method: 'POST', headers: { ...JSONH } });
    check(res._s === 200 && /tt_session=;/.test(res._headers['set-cookie'] || ''), 'disconnect (POST, JSON) clears the cookie (200 + expiring Set-Cookie)');
    check(/Secure/.test(res._headers['set-cookie'] || ''), 'and the cleared cookie carries Secure (https deploy)');
  }

  // --- whoami: no cookie → 401 before the network ---
  check((await run(whoami, { method: 'GET', headers: {} }))._s === 401, 'whoami with no cookie → 401');

  // --- tt proxy: path/search/body mapping (proxy-core stubbed) ---
  lastProxyArgs = null;
  await run(ttHandler, { method: 'GET', url: '/api/tt/api/v1/calendar/123/events?since=5', query: { path: ['api', 'v1', 'calendar', '123', 'events'], since: '5' }, headers: { cookie: 'tt_session=abc' } });
  check(lastProxyArgs && lastProxyArgs.path === '/api/v1/calendar/123/events', `tt maps the catch-all to the API path (${lastProxyArgs && lastProxyArgs.path})`);
  check(lastProxyArgs && lastProxyArgs.search === '?since=5', `and preserves the query string (${lastProxyArgs && lastProxyArgs.search})`);
  check(lastProxyArgs && lastProxyArgs.session === 'abc', 'and reads the session from the cookie');

  // body: an empty object (Vercel's parse of a body-less DELETE) forwards NO body
  lastProxyArgs = null;
  await run(ttHandler, { method: 'DELETE', url: '/api/tt/api/v1/calendar/1/event/u', query: { path: ['api', 'v1', 'calendar', '1', 'event', 'u'] }, headers: { cookie: 'tt_session=abc' }, body: {} });
  check(lastProxyArgs && lastProxyArgs.body === undefined, 'a body-less DELETE forwards NO body (empty {} → undefined)');

  // body: a real object is stringified
  lastProxyArgs = null;
  await run(ttHandler, { method: 'PUT', url: '/api/tt/api/v1/calendar/1/event/u', query: { path: ['api', 'v1', 'calendar', '1', 'event', 'u'] }, headers: { cookie: 'tt_session=abc' }, body: { title: 'x' } });
  check(lastProxyArgs && lastProxyArgs.body === '{"title":"x"}', 'a PUT body is forwarded as JSON text');

  if (fail) { console.log(`\n\x1b[31m${fail} check(s) failed\x1b[0m`); process.exit(1); }
  console.log('\n\x1b[32mapi adapters ok\x1b[0m');
})().catch((e) => { console.error('VERIFY-API THREW:', e && e.stack || e); process.exit(1); });
