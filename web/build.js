#!/usr/bin/env node
/* Assemble a SELF-CONTAINED static bundle in web/dist/ — the only thing served,
 * by both the dev server and Vercel (outputDirectory). This is what keeps the
 * deploy from exposing the rest of the repo: nothing outside these files can be
 * reached, because nothing else is in the served directory.
 *
 * No copies are committed — web/dist is gitignored and rebuilt on deploy, so the
 * "one source of truth, no lib copies" rule (scripts/check.js) still holds; the
 * shared libs live only in src/lib and are copied here at build time.
 *
 * Usage: node web/build.js
 */
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const DIST = path.join(__dirname, 'dist');
const LIBS = ['tz', 'recur', 'api', 'model', 'export', 'map'];   // shared with the extension/desktop
const RENDERER = ['app.css', 'cli-host.js', 'icons.js', 'store.js', 'app.js'];

fs.rmSync(DIST, { recursive: true, force: true });
fs.mkdirSync(path.join(DIST, 'lib'), { recursive: true });
fs.mkdirSync(path.join(DIST, 'renderer'), { recursive: true });

const copy = (from, to) => fs.copyFileSync(from, path.join(DIST, to));
copy(path.join(__dirname, 'index.html'), 'index.html');
copy(path.join(__dirname, 'host-web.js'), 'host-web.js');
copy(path.join(ROOT, 'icons', 'icon-32.png'), 'favicon.png');   // tab icon (reuse the app logo)
for (const l of LIBS) copy(path.join(ROOT, 'src', 'lib', `${l}.js`), `lib/${l}.js`);
for (const f of RENDERER) copy(path.join(ROOT, 'client', 'renderer', f), `renderer/${f}`);

const n = 3 + LIBS.length + RENDERER.length;
console.log(`built web/dist — ${n} files (index.html, host-web.js, favicon, ${LIBS.length} libs, ${RENDERER.length} renderer)`);
