#!/usr/bin/env node
/* Bundle the extension into a single userscript.
 *
 * Why this exists: TimeTree's *mobile app* has no dark mode, and you can't
 * install Chrome extensions on a phone. But TimeTree's mobile *web* is fully
 * responsive AND carries the same built-in dark theme — so a userscript in
 * Safari (Userscripts app) or Firefox Android (Tampermonkey) gets you dark
 * mode and the agenda on a phone today, with no app to rebuild.
 *
 * Same source of truth as the extension: this reads the file list straight out
 * of manifest.json so the two can't drift.
 *
 * Usage: node build-userscript.js
 */
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));
const cs = manifest.content_scripts[0];

const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

// `chrome` doesn't exist outside an extension. Everything we touch is
// storage.local (theme preference) and a runtime.onMessage listener that only
// the toolbar button uses, so a localStorage shim covers it exactly.
const SHIM = `
/* --- extension API shim (userscript build) ------------------------------ */
if (typeof globalThis.chrome === 'undefined' || !globalThis.chrome.storage) {
  const mem = {};
  globalThis.chrome = Object.assign({}, globalThis.chrome, {
    storage: {
      local: {
        async get(key) {
          const keys = typeof key === 'string' ? [key] : Array.isArray(key) ? key : Object.keys(key || {});
          const out = {};
          for (const k of keys) {
            let v = null;
            try { v = localStorage.getItem('ttx:' + k); } catch { v = mem[k] ?? null; }
            if (v != null) { try { out[k] = JSON.parse(v); } catch { out[k] = v; } }
          }
          return out;
        },
        async set(obj) {
          for (const [k, v] of Object.entries(obj)) {
            const s = JSON.stringify(v);
            mem[k] = s;
            try { localStorage.setItem('ttx:' + k, s); } catch { /* private mode */ }
          }
        },
      },
    },
    runtime: { onMessage: { addListener() {} } },
  });
}
`.trim();

const css = (cs.css || []).map(read).join('\n');
const STYLE = `
/* --- injected stylesheet ----------------------------------------------- */
(() => {
  const s = document.createElement('style');
  s.id = 'ttx-userscript-style';
  s.textContent = ${JSON.stringify(css)};
  (document.head || document.documentElement).appendChild(s);
})();
`.trim();

const header = `// ==UserScript==
// @name         TimeForest
// @namespace    https://github.com/nisesimadao/TimeForest
// @version      ${manifest.version}
// @description  TimeTree にダークモード・アジェンダ表示・検索・エクスポートを追加（非公式）
// @author       -
// @match        https://timetreeapp.com/*
// @run-at       document-start
// @grant        none
// ==/UserScript==
`;

const body = cs.js.map((p) => `\n/* ===== ${p} ===== */\n` + read(p)).join('\n');

const out = [
  header,
  '(() => {',
  "'use strict';",
  SHIM,
  '',
  '// The stylesheet and modules expect a document; at document-start there',
  '// may not be a <head> yet, so defer everything to DOM readiness.',
  'const boot = () => {',
  STYLE,
  body,
  '};',
  "if (document.readyState === 'loading') {",
  "  document.addEventListener('DOMContentLoaded', boot, { once: true });",
  '} else { boot(); }',
  '})();',
  '',
].join('\n');

const dir = path.join(ROOT, 'dist');
fs.mkdirSync(dir, { recursive: true });
const target = path.join(dir, 'timeforest.user.js');
fs.writeFileSync(target, out);

console.log('built', path.relative(ROOT, target), '—', (out.length / 1024).toFixed(1), 'KB');
console.log('sources:', cs.js.length, 'js +', (cs.css || []).length, 'css');
