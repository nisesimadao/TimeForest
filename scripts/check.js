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

section('reminder timing (behavioural)');
require(path.join(ROOT, 'src/lib/model.js'));
const { model } = globalThis.TTX;

/* `alerts` counts minutes before the start, but an all-day event's start is
 * LOCAL midnight while TimeTree STORES it as UTC midnight. Subtracting from
 * the stored instant puts every all-day reminder 9 hours out in JST — and the
 * error is invisible in the data, it only shows up as a notification at the
 * wrong time. That offset is why 1日前 is 900 minutes and not 1440.
 *
 * Measured against the real client: all-day 1日前 == 09:00 the day before. */
const iso = (ms) => new Date(ms).toISOString();
const AD = { allDay: true, startKey: '2026-08-03', start: Date.UTC(2026, 7, 3) };
const TIMED = { allDay: false, startKey: '2026-08-03', start: Date.UTC(2026, 7, 3, 1, 0) };

const timing = [
  // 09:00 JST on 8/2 is 00:00Z on 8/2.
  ['all-day 1日前 (900) fires 09:00 the day before', iso(model.alertAt(AD, 900, 'Asia/Tokyo')), '2026-08-02T00:00:00.000Z'],
  ['all-day 2日前 (2340) fires 09:00 two days before', iso(model.alertAt(AD, 2340, 'Asia/Tokyo')), '2026-08-01T00:00:00.000Z'],
  // 当日 (0) is local midnight, NOT the stored UTC midnight.
  ['all-day 当日 (0) fires at LOCAL midnight', iso(model.alertAt(AD, 0, 'Asia/Tokyo')), '2026-08-02T15:00:00.000Z'],
  ['timed 開始時 (0) fires at the start', iso(model.alertAt(TIMED, 0, 'Asia/Tokyo')), '2026-08-03T01:00:00.000Z'],
  ['timed 30分前', iso(model.alertAt(TIMED, 30, 'Asia/Tokyo')), '2026-08-03T00:30:00.000Z'],
  ['timed 1日前 (1440)', iso(model.alertAt(TIMED, 1440, 'Asia/Tokyo')), '2026-08-02T01:00:00.000Z'],
];
for (const [name, got, want] of timing) {
  if (got === want) ok(`${name} — ${got}`);
  else bad(`${name}: expected ${want}, got ${got}`);
}

// --- 5b2. the comment feed says what actually happened -----------------------
//
// The item codes were measured one field at a time against the real server, so
// the mapping is knowledge that cost something and is easy to break silently:
// get it wrong and the app calmly tells someone their partner changed the DATE
// when they changed the LOCATION. The last two cases are the load-bearing ones
// — an unmeasured code must degrade to a vaguer sentence, never a wrong one.

section('comment feed (behavioural)');
require(path.join(ROOT, 'src/lib/api.js'));
const { api } = globalThis.TTX;
const act = (type, items) => ({ type, attachment: items ? { items } : {} });

const stories = [
  ['created', api.activityText(act(1, [1])), '予定を作成しました'],
  ['title', api.activityText(act(2, [0])), 'タイトルを変更しました'],
  ['date', api.activityText(act(2, [1])), '日時を変更しました'],
  ['label', api.activityText(act(2, [2])), 'ラベルを変更しました'],
  ['note', api.activityText(act(2, [3])), 'メモを変更しました'],
  ['location', api.activityText(act(2, [4])), '場所を変更しました'],
  ['alerts', api.activityText(act(2, [6])), '通知を変更しました'],
  ['url', api.activityText(act(2, [8])), 'URLを変更しました'],
  ['combined edit', api.activityText(act(2, [0, 1, 3])), 'タイトル・日時・メモを変更しました'],
  ['a comment tells no story', api.activityText(act(0)), ''],
  // 5 and 7 were never observed. Guessing puts a false sentence in a family's
  // calendar; this is the assertion that keeps the guess out.
  ['an unmeasured code degrades', api.activityText(act(2, [5])), '予定を変更しました'],
  ['a known code survives an unknown one', api.activityText(act(2, [4, 7])), '場所を変更しました'],
];
for (const [name, got, want] of stories) {
  if (got === want) ok(`${name} — ${JSON.stringify(got)}`);
  else bad(`${name}: expected ${JSON.stringify(want)}, got ${JSON.stringify(got)}`);
}

/* The id the client mints for a comment. The real app sends a bare 32-hex
 * string — a dashed UUID is a different thing and the server may or may not
 * care, so don't find out in production. */
const aid = api.newActivityId();
if (/^[0-9a-f]{32}$/.test(aid)) ok(`newActivityId is 32 hex — ${aid}`);
else bad(`newActivityId must be 32 lowercase hex, got ${JSON.stringify(aid)}`);
if (api.newActivityId() !== aid) ok('and it is not a constant');
else bad('newActivityId returned the same id twice');

/* Soft-deleted comments must not render: the server keeps them so other
 * clients can sync the removal, but somebody meant them to be gone. */
require(path.join(ROOT, 'src/lib/model.js'));
const feed = globalThis.TTX.model.normalizeActivities([
  { id: 'a', type: 0, author_id: 1, attachment: { content: 'あとで' }, created_at: 300, updated_at: 300 },
  { id: 'b', type: 0, author_id: 2, attachment: { content: '消した' }, created_at: 200, updated_at: 200,
    deactivated_at: 999 },
  { id: 'c', type: 1, author_id: 1, attachment: { items: [1] }, created_at: 100, updated_at: 100 },
  { id: 'd', type: 0, author_id: 1, attachment: { content: 'なおした' }, created_at: 400, updated_at: 99400 },
], { membersById: new Map([[1, { name: 'たろう' }], [2, { name: 'はなこ' }]]) }, 1);

const ids = feed.map((f) => f.id).join(',');
if (ids === 'c,a,d') ok(`deleted dropped, rest oldest-first — ${ids}`);
else bad(`expected c,a,d (b deleted), got ${ids}`);
if (feed[0].text === '予定を作成しました' && !feed[0].comment) ok('system rows carry their story');
else bad(`system row wrong: ${JSON.stringify(feed[0])}`);
if (feed[1].authorName === 'たろう') ok('author resolved through membersById');
else bad(`author unresolved: ${JSON.stringify(feed[1].authorName)}`);
if (feed[2].edited && !feed[1].edited) ok('an edited comment is marked, an untouched one is not');
else bad(`edited flag wrong: ${feed.map((f) => f.edited).join(',')}`);
if (feed[1].mine && !feed.find((f) => f.id === 'c' && !f.mine)) ok('own comments are identified');
else bad('mine flag wrong');

// --- 5c. the package includes what the renderer loads ------------------------
//
// electron-builder's `files` is an ALLOWLIST, and it has to be: the app root is
// the repo root (so ../../src/lib/* still resolves inside the asar) and the
// repo root also holds scripts/, .local/ and 144MB of Electron. The failure
// mode is nasty and silent — the app runs perfectly from source and the
// packaged build is a white screen, which you only find out after shipping.

section('packaging');
const builder = require(path.join(ROOT, 'electron-builder.config.js'));

/* Enough of glob for the patterns this config actually uses. */
const globRe = (g) => new RegExp('^' + g
  .replace(/[.+^${}()|[\]\\]/g, '\\$&')
  .replace(/\*\*\//g, '(?:.*/)?')
  .replace(/\*\*/g, '.*')
  .replace(/\*/g, '[^/]*') + '$');

const allow = builder.files.filter((p) => typeof p === 'string' && !p.startsWith('!')).map(globRe);
const deny = builder.files.filter((p) => typeof p === 'string' && p.startsWith('!'))
  .map((p) => globRe(p.slice(1)));
const packaged = (rel) => allow.some((re) => re.test(rel)) && !deny.some((re) => re.test(rel));

const refs = [...indexHtml.matchAll(/(?:src|href)=["']([^"']+)["']/g)]
  .map((m) => m[1])
  .filter((s) => !/^(https?:|data:|#)/.test(s));
let missing = 0;
for (const ref of refs) {
  // index.html sits in client/renderer/; resolve the way the browser will.
  const abs = path.resolve(ROOT, 'client', 'renderer', ref);
  const relPath = rel(abs);
  if (!fs.existsSync(abs)) { bad(`index.html references a missing file: ${ref}`); missing++; continue; }
  if (!packaged(relPath)) {
    bad(`index.html loads ${relPath}, which electron-builder's files[] does not include — the packaged app would fail to load it`);
    missing++;
  }
}
if (!missing) ok(`all ${refs.length} files index.html loads are inside the package`);

if (builder.extraMetadata?.main === 'client/main.js') ok('packaged main points at client/main.js');
else bad('electron-builder extraMetadata.main must point at client/main.js');

// The version has to come from where Electron is actually installed.
const clientPkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'client/package.json'), 'utf8'));
const want = (clientPkg.devDependencies.electron || '').replace(/^[^\d]*/, '');
if (builder.electronVersion === want) ok(`electronVersion tracks client/package.json (${want})`);
else bad(`electronVersion is ${builder.electronVersion} but client/package.json has ${want}`);

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
