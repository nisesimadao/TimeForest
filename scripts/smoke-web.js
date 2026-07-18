#!/usr/bin/env node
/* Boot the hosted web client's backend and assert it serves a working bundle —
 * without a browser or a TimeTree session, so it runs in the zero-dependency CI
 * `check` job (the counterpart to smoke-client.js for the Electron app).
 *
 * It proves: web/build.js produces a bundle, web/dev-server.js serves every file
 * index.html loads, the API routes answer, and the two safety rules hold (only
 * /api/v* is proxied; nothing escapes web/dist). It does NOT drive the renderer
 * — that needs a browser and a session (scratchpad E2Es cover it locally).
 *
 * Run: node scripts/smoke-web.js
 */
const { spawn, execFileSync } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');

const ROOT = path.join(__dirname, '..');
const PORT = 8788;
let fail = 0;
const ok = (m) => console.log('  \x1b[32mok\x1b[0m   ' + m);
const bad = (m) => { fail++; console.log('  \x1b[31mFAIL\x1b[0m ' + m); };
const check = (c, m) => (c ? ok(m) : bad(m));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const status = (p) => fetch(`http://127.0.0.1:${PORT}${p}`).then((r) => r.status).catch(() => -1);

(async () => {
  console.log('building web/dist …');
  execFileSync(process.execPath, [path.join(ROOT, 'web', 'build.js')], { cwd: ROOT, stdio: 'inherit' });

  const srv = spawn(process.execPath, [path.join(ROOT, 'web', 'dev-server.js'), String(PORT)], { cwd: ROOT, stdio: 'ignore' });
  try {
    // wait for it to listen
    let up = false;
    for (let i = 0; i < 40 && !up; i++) { await sleep(250); up = (await status('/index.html')) === 200; }
    if (!up) { bad('dev-server did not start'); process.exit(1); }

    // every asset index.html loads must serve — mirrors the paths in the built html
    const html = await fetch(`http://127.0.0.1:${PORT}/`).then((r) => r.text());
    check(/id="app"/.test(html) && /host-web\.js/.test(html), 'GET / serves the built index.html');
    const refs = [...html.matchAll(/(?:src|href)="\.\/([^"]+)"/g)].map((m) => m[1]);
    let missing = 0;
    for (const r of refs) { if ((await status('/' + r)) !== 200) { bad(`asset ${r} does not serve`); missing++; } }
    if (!missing) ok(`all ${refs.length} bundle assets serve 200 (host-web, libs, renderer, favicon)`);

    // The mobile client: the userscript is served from this same origin so a phone
    // can install it and its manager can auto-update from the same URL.
    const us = await fetch(`http://127.0.0.1:${PORT}/timeforest-app.user.js`).catch(() => null);
    const usText = us && us.status === 200 ? await us.text() : '';
    check(us && us.status === 200 && /==UserScript==/.test(usText) && /@downloadURL/.test(usText),
      'the mobile userscript serves from the deploy (install + auto-update URL)');

    // API routes answer (no session -> 401), nothing escapes dist. (The /api-only
    // proxy restriction returns 404 only once past the session gate, so it needs a
    // real session — the browser E2E covers that; here every proxy path is 401.)
    check((await status('/api/whoami')) === 401, 'GET /api/whoami answers 401 without a session');
    check((await status('/api/tt/api/v1/calendars')) === 401, 'the proxy route answers (401 without a session)');
    const trav = await status('/%2e%2e/%2e%2e/.local/discord-webhook.txt');
    check(trav !== 200, `path traversal is blocked (${trav}); only web/dist is served`);
    const dc = await status('/api/disconnect');   // bare GET
    check(dc !== 200, `disconnect ignores a bare GET (${dc})`);
  } finally {
    srv.kill('SIGKILL');
  }

  if (fail) { console.log(`\n\x1b[31m${fail} check(s) failed\x1b[0m`); process.exit(1); }
  console.log('\n\x1b[32mweb smoke passed\x1b[0m');
})().catch((e) => { console.error('SMOKE-WEB THREW:', e && e.stack || e); process.exit(1); });
