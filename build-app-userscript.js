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

const header = `// ==UserScript==
// @name         TimeForest（デスクトップUI）
// @namespace    https://github.com/nisesimadao/TimeForest
// @version      ${version}
// @description  timetreeapp.com 上でデスクトップ版 TimeForest の UI を動かす（同オリジンなのでログイン受け渡し不要・スマホ可）
// @match        https://timetreeapp.com/*
// @run-at       document-idle
// @grant        none
// ==/UserScript==
`;

const out = [
  header,
  '(function () {',
  "'use strict';",
  '\n/* ===== web/host-userscript.js ===== */\n' + read('web/host-userscript.js'),
  "\n// Not signed in (no csrf meta) -> leave TimeTree's own page (incl. its login) alone.",
  "if (!document.querySelector('meta[name=\"csrf-token\"]')) return;",
  '\nvar __TTX_APP_CSS__ = ' + JSON.stringify(appCss) + ';',
  '\n/* ===== web/app-userscript-boot.js ===== */\n' + read('web/app-userscript-boot.js'),
  ...LIBS.map((p) => `\n/* ===== ${p} ===== */\n` + read(p)),
  ...RENDERER.map((p) => `\n/* ===== ${p} ===== */\n` + read(p)),
  '})();',
  '',
].join('\n');

fs.mkdirSync(path.join(ROOT, 'dist'), { recursive: true });
const target = path.join(ROOT, 'dist', 'timeforest-app.user.js');
fs.writeFileSync(target, out);
console.log('built', path.relative(ROOT, target), '—', (out.length / 1024).toFixed(1), 'KB');
console.log('sources:', LIBS.length, 'libs +', RENDERER.length, 'renderer + host-userscript + boot + app.css');
