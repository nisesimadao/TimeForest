#!/usr/bin/env node
/* Bundle the DESKTOP UI into a userscript that runs ON timetreeapp.com.
 *
 * This is the mobile answer: the hosted client (web/) can't get a cross-origin
 * session without a devtools paste, but a userscript runs same-origin, so the
 * page's existing login (any method — email, Google, Apple) just rides along.
 * No proxy, no _session_id, works on a phone with a userscript manager.
 *
 * It bundles the SAME shared libs and renderer as the desktop/hosted client (no
 * copies — read straight from src/lib and client/renderer), a same-origin
 * window.host shim, and a boot that mounts the UI over TimeTree's page.
 *
 * Usage: node build-app-userscript.js
 */
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const version = JSON.parse(read('package.json')).version;

const LIBS = ['tz', 'recur', 'api', 'model', 'export', 'map'].map((l) => `src/lib/${l}.js`);
const RENDERER = ['icons.js', 'store.js', 'cli-host.js', 'app.js'].map((f) => `client/renderer/${f}`);
const appCss = read('client/renderer/app.css');

// Where the built script is served from, so a userscript manager can auto-update
// it. Defaults to the production deploy; override with TF_WEB_ORIGIN if you host
// it elsewhere. It must be the STABLE production URL, never a per-deploy one, or
// @updateURL would chase a URL that 404s next deploy. web/build.js copies the
// built file to web/dist/ so this path resolves on the same origin as the app.
const HOST = (process.env.TF_WEB_ORIGIN || 'https://time-forest-five.vercel.app').replace(/\/$/, '');
const SELF_URL = `${HOST}/timeforest-app.user.js`;

const header = `// ==UserScript==
// @name         TimeForest（デスクトップUI）
// @namespace    https://github.com/nisesimadao/TimeForest
// @version      ${version}
// @description  timetreeapp.com 上でデスクトップ版 TimeForest の UI を動かす（同オリジンなのでログイン受け渡し不要・スマホ可）
// @match        https://timetreeapp.com/calendars*
// @run-at       document-idle
// @grant        none
// @downloadURL  ${SELF_URL}
// @updateURL    ${SELF_URL}
// ==/UserScript==
`;

// Return the whole userscript as a string. Both the CLI below and web/build.js
// call this — the bundling logic lives in exactly one place, so the file the
// deploy serves and the file CI checks can never drift apart.
function build() {
  return [
    header,
    '(function () {',
    "'use strict';",
    '\n/* ===== web/host-userscript.js ===== */\n' + read('web/host-userscript.js'),
    "\n// Only take over the calendar app itself. /signin, /signup and the marketing",
    "// pages ALSO ship a csrf meta, so a csrf check alone would strip TimeTree's own",
    "// login and lock the user out (measured). @match already scopes us to",
    "// /calendars*, but self-guard too, in case a manager is set to a broader match.",
    "if (!/^\\/calendars(\\/|$)/.test(location.pathname)) return;",
    "// And bail if there's no csrf token — we couldn't call the API to sync anyway.",
    "if (!document.querySelector('meta[name=\"csrf-token\"]')) return;",
    '\nvar __TTX_APP_CSS__ = ' + JSON.stringify(appCss) + ';',
    '\n/* ===== web/app-userscript-boot.js ===== */\n' + read('web/app-userscript-boot.js'),
    ...LIBS.map((p) => `\n/* ===== ${p} ===== */\n` + read(p)),
    ...RENDERER.map((p) => `\n/* ===== ${p} ===== */\n` + read(p)),
    '})();',
    '',
  ].join('\n');
}

module.exports = { build };

if (require.main === module) {
  const out = build();
  fs.mkdirSync(path.join(ROOT, 'dist'), { recursive: true });
  const target = path.join(ROOT, 'dist', 'timeforest-app.user.js');
  fs.writeFileSync(target, out);
  console.log('built', path.relative(ROOT, target), '—', (out.length / 1024).toFixed(1), 'KB');
  console.log('sources:', LIBS.length, 'libs +', RENDERER.length, 'renderer + host-userscript + boot + app.css');
}
