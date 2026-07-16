#!/usr/bin/env node
/* Structural checks. No test framework, no dependencies — this project has no
 * build step and shouldn't grow one just to be checkable.
 *
 * These aren't unit tests; they guard the things that actually broke during
 * development and would break silently again:
 *   - a manifest pointing at a file that no longer exists
 *   - src/lib drifting into per-build copies
 *   - net.fetch creeping back into main.js (see below — it cost hours)
 *
 * Usage: node scripts/check.js
 */
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const rel = (p) => path.relative(ROOT, p).replace(/\\/g, '/');

let failures = 0;
const ok = (msg) => console.log('  [32m✓[0m ' + msg);
const bad = (msg) => { failures++; console.log('  [31m✗[0m ' + msg); };
const section = (t) => console.log('\n' + t);

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (/^(node_modules|dist|\.git|out|release)$/.test(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

const files = walk(ROOT);
const jsFiles = files.filter((f) => f.endsWith('.js'));
const jsonFiles = files.filter((f) => f.endsWith('.json') && !f.includes('package-lock'));

// --- 1. everything parses ---------------------------------------------------

section('syntax');
for (const f of jsFiles) {
  try {
    execFileSync(process.execPath, ['--check', f], { stdio: 'pipe' });
  } catch (e) {
    bad(`${rel(f)} — ${String(e.stderr || e).split('\n').find((l) => l.includes('Error')) || 'parse error'}`);
  }
}
if (!failures) ok(`${jsFiles.length} js files parse`);

section('json');
for (const f of jsonFiles) {
  try {
    JSON.parse(fs.readFileSync(f, 'utf8'));
  } catch (e) {
    bad(`${rel(f)} — ${e.message}`);
  }
}
ok(`${jsonFiles.length} json files valid`);

// --- 2. manifest points at real files --------------------------------------

section('extension manifest');
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));
const cs = manifest.content_scripts[0];
for (const p of [...cs.js, ...cs.css, manifest.background.service_worker]) {
  if (fs.existsSync(path.join(ROOT, p))) ok(p);
  else bad(`manifest references missing file: ${p}`);
}
if (manifest.manifest_version !== 3) bad('manifest_version must be 3');

// --- 3. the client loads the same libs, not copies --------------------------

section('shared library (no drift)');
const SHARED = ['tz', 'recur', 'api', 'model', 'export'];
const indexHtml = fs.readFileSync(path.join(ROOT, 'client/renderer/index.html'), 'utf8');
for (const name of SHARED) {
  const p = `src/lib/${name}.js`;
  const inExt = cs.js.includes(p);
  const inClient = indexHtml.includes(`../../${p}`);
  if (inExt && inClient) ok(`${name}: extension + client both load ${p}`);
  else bad(`${name}: ext=${inExt} client=${inClient} — a copy has crept in`);
}
// A second copy of a lib anywhere is the drift we're guarding against.
for (const name of SHARED) {
  const copies = jsFiles.filter((f) => path.basename(f) === `${name}.js` && !f.includes(`src${path.sep}lib`));
  if (copies.length) bad(`${name}.js duplicated at: ${copies.map(rel).join(', ')}`);
}

// --- 4. libs must not assume a DOM -----------------------------------------

section('libs stay environment-agnostic');
for (const name of SHARED) {
  const src = fs.readFileSync(path.join(ROOT, 'src/lib', `${name}.js`), 'utf8');
  if (/\bwindow\.TTX\b/.test(src)) {
    bad(`${name}.js uses window.TTX — must be globalThis.TTX to run in a service worker`);
  } else ok(`${name}.js uses globalThis`);
}

// --- 5. regression guards ---------------------------------------------------

section('regression guards');

/* net.fetch always uses the DEFAULT session and silently ignores a `session`
 * option. With per-account partitions that doesn't just report a false
 * "signed out" — it can read a DIFFERENT ACCOUNT's cookie jar. Every request
 * must go through ses.fetch via apiFetch(). */
const mainJs = fs.readFileSync(path.join(ROOT, 'client/main.js'), 'utf8');
const netFetch = mainJs.split('\n')
  .map((l, i) => [i + 1, l])
  .filter(([, l]) => /\bnet\.fetch\s*\(/.test(l) && !l.trim().startsWith('*') && !l.trim().startsWith('//'));
if (netFetch.length) {
  bad(`client/main.js uses net.fetch at line(s) ${netFetch.map(([n]) => n).join(', ')} — use ses.fetch (see README)`);
} else ok('client/main.js does not call net.fetch');

/* TimeTree's all-day end_at is inclusive; iCal DTEND is exclusive. Dropping the
 * +1 makes every multi-day export a day short. */
const exportJs = fs.readFileSync(path.join(ROOT, 'src/lib/export.js'), 'utf8');
if (/DTEND;VALUE=DATE:\$\{icsDate\(addDays\(o\.endKey, 1\)\)\}/.test(exportJs)) {
  ok('ICS converts inclusive end_at to exclusive DTEND');
} else bad('src/lib/export.js: all-day DTEND must be endKey + 1 day');

/* Keep/メモ items (category 2) are not calendar events and must never render. */
const modelJs = fs.readFileSync(path.join(ROOT, 'src/lib/model.js'), 'utf8');
if (/CATEGORY_KEEP\s*=\s*2/.test(modelJs) && /category === CATEGORY_KEEP\) continue/.test(modelJs)) {
  ok('model.js filters Keep (category 2) items');
} else bad('src/lib/model.js must skip category 2 (Keep/メモ) items');

// --- 5b. behaviour, not spelling ---------------------------------------------
//
// The guards above read source text, which only proves a line still exists.
// The libs are plain IIFEs that hang themselves off globalThis, so requiring
// them here runs the real thing — still with zero dependencies.

section('recurrence expansion (behavioural)');
require(path.join(ROOT, 'src/lib/tz.js'));
require(path.join(ROOT, 'src/lib/recur.js'));
const { recur } = globalThis.TTX;

const master = (recurrences, startAt) => ({
  uuid: 'test', title: 'test', start_at: startAt, end_at: startAt + 3600000,
  start_timezone: 'Asia/Tokyo', all_day: false, recurrences,
});
const S2020 = Date.UTC(2020, 0, 6, 1, 0);           // Mon 2020-01-06 10:00 JST
const YEAR2020 = [Date.UTC(2020, 0, 1), Date.UTC(2020, 11, 31)];
const JULY2026 = [Date.UTC(2026, 6, 1), Date.UTC(2026, 6, 31)];
const count = (m, w) => recur.expand(m, w[0], w[1]).length;

/* COUNT bounds a series from ITS OWN START, not from the window being drawn.
 * Ignoring it expanded a 5-occurrence 2020 series to 52 in 2020 — and still
 * drew 4 a year in 2026, six years after it ended. The write API accepts and
 * stores COUNT, so this is reachable with real data. */
const cases = [
  ['COUNT=5 yields 5 in its own year', count(master(['RRULE:FREQ=WEEKLY;COUNT=5'], S2020), YEAR2020), 5],
  ['a spent COUNT series is gone later', count(master(['RRULE:FREQ=WEEKLY;COUNT=5'], S2020), JULY2026), 0],
  // RFC 5545: EXDATE subtracts from the set COUNT already sized.
  ['EXDATE spends a COUNT slot', count(master(['RRULE:FREQ=WEEKLY;COUNT=5', 'EXDATE:20200113T010000Z'], S2020), YEAR2020), 4],
  ['DAILY COUNT', count(master(['RRULE:FREQ=DAILY;COUNT=3'], S2020), YEAR2020), 3],
  ['MONTHLY COUNT', count(master(['RRULE:FREQ=MONTHLY;COUNT=2'], S2020), YEAR2020), 2],
  // ...and a rule without COUNT must stay unbounded.
  ['no COUNT stays weekly forever', count(master(['RRULE:FREQ=WEEKLY'], S2020), JULY2026), 4],
  ['UNTIL still bounds the series', count(master(['RRULE:FREQ=WEEKLY;UNTIL=20200131T000000Z'], S2020), YEAR2020), 4],
];
for (const [name, got, want] of cases) {
  if (got === want) ok(`${name} — ${got}`);
  else bad(`${name}: expected ${want}, got ${got}`);
}

// --- 6. userscript builds ---------------------------------------------------

section('userscript build');
try {
  execFileSync(process.execPath, [path.join(ROOT, 'build-userscript.js')], { stdio: 'pipe' });
  const out = path.join(ROOT, 'dist/timeforest.user.js');
  execFileSync(process.execPath, ['--check', out], { stdio: 'pipe' });
  const txt = fs.readFileSync(out, 'utf8');
  if (!/==UserScript==/.test(txt)) bad('userscript is missing its metadata block');
  else if (!/@match\s+https:\/\/timetreeapp\.com/.test(txt)) bad('userscript @match is wrong');
  else ok(`builds and parses (${(txt.length / 1024).toFixed(1)} KB)`);
} catch (e) {
  bad('userscript build failed: ' + String(e.stderr || e.message).slice(0, 200));
}

// --- done -------------------------------------------------------------------

console.log('');
if (failures) {
  console.log(`[31m${failures} check(s) failed[0m`);
  process.exit(1);
}
console.log('[32mall checks passed[0m');
