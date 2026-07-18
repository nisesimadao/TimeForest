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
// Every file the manifest names, across ALL content_scripts blocks — there are
// two now (the isolated-world bundle and the MAIN-world fetch wrapper), and a
// typo in the second one loads nothing with no error.
const referenced = [
  ...manifest.content_scripts.flatMap((cs) => [...(cs.js || []), ...(cs.css || [])]),
  manifest.background.service_worker,
];
for (const p of referenced) {
  if (fs.existsSync(path.join(ROOT, p))) ok(p);
  else bad(`manifest references missing file: ${p}`);
}
if (manifest.manifest_version !== 3) bad('manifest_version must be 3');

// --- 2b. README badges tell the truth ---------------------------------------
//
// The badges are static SVGs (shields.io can't read a private repo), so nothing
// stops one saying "dependencies 0" while a dependency creeps in, or "Electron
// 43" after a major bump. A badge you can't trust is worse than none — this is
// the same "green for the wrong reason" this file exists to prevent. So each
// badge's claim is checked against the source it claims to summarise.
section('README badges match reality');
{
  const rootPkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const clientPkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'client/package.json'), 'utf8'));
  const badge = (file) => {
    const p = path.join(ROOT, 'docs', file);
    if (!fs.existsSync(p)) return null;
    return fs.readFileSync(p, 'utf8');
  };
  const claims = (file, needle, why) => {
    const svg = badge(file);
    if (svg === null) bad(`docs/${file} is referenced by the README but missing`);
    else if (svg.includes(needle)) ok(`${file} says "${needle}", and ${why}`);
    else bad(`${file} no longer says "${needle}" — update the badge or the README stops matching`);
  };

  // dependencies 0: the runtime really has none. devDependencies (electron,
  // electron-builder) are build-time and don't count against this claim.
  const runtimeDeps = Object.keys(rootPkg.dependencies || {}).length
    + Object.keys(clientPkg.dependencies || {}).length;
  if (runtimeDeps === 0) claims('badge-deps.svg', '>0<', 'there really are no runtime dependencies');
  else bad(`badge says 0 dependencies but there are ${runtimeDeps} — ${JSON.stringify({ ...rootPkg.dependencies, ...clientPkg.dependencies })}`);

  // Electron 43: the badge names a major version, so read the major off the range.
  const major = (clientPkg.devDependencies.electron || '').match(/(\d+)/)?.[1];
  claims('badge-electron.svg', `Electron ${major}`, `client/package.json pins electron ^${major}`);

  // node 20 · 24: exactly the matrix CI runs. If ci.yml changes, this should too.
  const ci = fs.readFileSync(path.join(ROOT, '.github/workflows/ci.yml'), 'utf8');
  const matrix = (ci.match(/node:\s*\[([^\]]+)\]/)?.[1] || '').replace(/\s/g, '');
  if (matrix === '20,24') claims('badge-node.svg', '20', 'CI runs exactly that matrix');
  else bad(`badge says node 20·24 but CI matrix is [${matrix}] — keep them in step`);

  claims('badge-mv3.svg', 'MV3', `manifest_version is ${manifest.manifest_version}`);
  claims('badge-build.svg', 'none', 'there is no build step for the checks (check.js has zero deps)');

  // The claims above catch a value going stale. This catches the SVG being
  // hand-edited away from its generator — same idea as the userscript's
  // reproducible-build check in CI. tools/badges.js reads its values from the
  // repo, so "up to date" means both the shape and the numbers are current.
  try {
    execFileSync(process.execPath, [path.join(ROOT, 'tools/badges.js'), '--check'], { stdio: 'pipe' });
    ok('badges reproduce from tools/badges.js — no hand-edits');
  } catch (e) {
    bad(`docs/badge-*.svg drift from tools/badges.js — run \`node tools/badges.js\`\n${String(e.stderr || '').trim()}`);
  }

  // Every image the README points at must exist. This is the failure that was
  // actually shipped: the README referenced files that rendered as broken-image
  // icons on GitHub. Badges are SVG (relative-path images are served straight
  // from the repo, not through camo, and render at their true size); the banner
  // and screenshots are PNG.
  const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
  const refs = [...readme.matchAll(/(?:src|srcset)="(docs\/[^"]+)"/g), ...readme.matchAll(/\]\((docs\/[^)]+)\)/g)]
    .map((m) => m[1]);
  const missing = [...new Set(refs)].filter((r) => !fs.existsSync(path.join(ROOT, r)));
  if (!refs.length) bad('README references no docs/ images — did the banner/badges get dropped?');
  else if (missing.length) bad(`README points at missing files: ${missing.join(', ')} — these render as broken images on GitHub`);
  else ok(`all ${new Set(refs).size} README images exist (${[...new Set(refs)].map((r) => r.replace('docs/', '')).join(', ')})`);
}

// --- 3. the client loads the same libs, not copies --------------------------

section('shared library (no drift)');
const SHARED = ['tz', 'recur', 'api', 'model', 'export', 'map'];
const indexHtml = fs.readFileSync(path.join(ROOT, 'client/renderer/index.html'), 'utf8');
for (const name of SHARED) {
  const p = `src/lib/${name}.js`;
  const inExt = manifest.content_scripts[0].js.includes(p);
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

/* reset() has to clear every field the store holds, or switching accounts
 * leaves one person's data rendering under the other's name. That is what the
 * function is FOR, and it is still the easiest thing in the file to forget: add
 * a field to the store literal, wire it up, ship it, and reset() quietly keeps
 * the old value. `setting` (which decides how the grid is laid out) got exactly
 * that far. So check the two lists against each other rather than trusting the
 * next person to remember. */
const storeJs = fs.readFileSync(path.join(ROOT, 'client/renderer/store.js'), 'utf8');
{
  const lit = storeJs.match(/\n\s*const store = \{\n([\s\S]*?)\n\s*\};/);
  const body = storeJs.match(/\n\s*function reset\(\) \{\n([\s\S]*?)\n\s*\}/);
  if (!lit || !body) {
    bad('store.js: could not find the store literal or reset() — this guard is looking at the wrong shape');
  } else {
    const fields = [...lit[1].matchAll(/^\s{4}(\w+):/gm)].map((m) => m[1]);
    // Comments out, first. Without this the guard reads `// store.setting = null;`
    // as a reset and passes — measured, by commenting that exact line out and
    // watching it stay green. A guard that only catches the fields you forgot
    // to add, and not the ones you took away, is half a guard.
    const live = body[1].replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    const missed = fields.filter((f) => !new RegExp(`store\\.${f}\\b`).test(live));
    if (!fields.length) bad('store.js: read 0 fields off the store literal — the guard is broken, not the code');
    else if (missed.length) bad(`store.js: reset() never touches ${missed.join(', ')} — switching accounts would keep the last one's`);
    else ok(`store.js: reset() clears all ${fields.length} store fields (${fields.join(', ')})`);
  }
}

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

/* The app pins every clock to Asia/Tokyo and reads it through TTX.tz, which
 * shifts to the target zone and then uses the UTC getters. `new Date(ms)`
 * followed by .getHours()/.getDate() reads the MACHINE's zone instead — on a
 * machine set to anything but JST that silently disagrees with every other time
 * on screen, and it passes every test on a JST box.
 *
 * This is the same confusion that put all-day reminders 9 hours out (§3), and
 * it has already sneaked back in once, in the comment timestamps. There is no
 * legitimate use of these in the renderer: the model formats times, and TTX.tz
 * does the rest. */
const appJs = fs.readFileSync(path.join(ROOT, 'client/renderer/app.js'), 'utf8');
const localGetters = appJs.split('\n')
  .map((l, i) => [i + 1, l])
  .filter(([, l]) => /\.get(Hours|Minutes|Date|Month|FullYear|Day)\s*\(\s*\)/.test(l)
    && !l.trim().startsWith('*') && !l.trim().startsWith('//'));
if (localGetters.length) {
  bad(`client/renderer/app.js reads the machine's timezone at line(s) `
    + `${localGetters.map(([n]) => n).join(', ')} — use TTX.tz.hm/ymd with TZ`);
} else ok("app.js reads no clock in the machine's timezone — all times go through TTX.tz");

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

section('12時間表記 (behavioural)');
require(path.join(ROOT, 'src/lib/tz.js'));

/* Every one of these came off TimeTree's OWN web app, with the account's
 * user_setting.military_time set to false. It is NOT the English convention:
 * the hour runs 0–11 inside each half (h11), so midnight is 午前 0:30 rather
 * than 午前 12:30 and noon is 午後 0:00 rather than 午後 12:00. Both English
 * answers look completely reasonable, which is the whole problem. */
const clockCases = [
  ['00:30', '午前 0:30'],
  ['09:05', '午前 9:05'],
  ['11:59', '午前 11:59'],
  ['12:00', '午後 0:00'],
  ['12:30', '午後 0:30'],
  ['14:30', '午後 2:30'],
  ['23:59', '午後 11:59'],
];
for (const [input, want] of clockCases) {
  const got = globalThis.TTX.tz.clock(input, false);
  if (got === want) ok(`clock(${input}) = ${got}`);
  else bad(`clock(${input}): expected ${want}, got ${got} — measured against TimeTree's own web app`);
}
if (globalThis.TTX.tz.clock('14:30', true) === '14:30') ok('and military time is left exactly as it is');
else bad('clock(hm, true) must not touch the string — it is also the form input value');
/* The 24-hour string is the VALUE: `<input type="time">` and toEpoch() both
 * take it. A 12-hour string reaching either is a wrong time, not a wrong label. */
if (globalThis.TTX.tz.clock('終日', false) === '終日') ok('and something that is not a time passes through');
else bad('clock() mangled a non-time');

/* The week view's hour rail builds its own strings, so it sailed straight past
 * the sweep that put clock() on everything reading o.startTime — it wrote
 * 24-hour whatever the account said. TimeTree's own weekly view, read off it
 * both ways: 1..23 with military time, 午前1/午後0/午後10 without. */
const railCases = [[0, '00:00', '午前0'], [1, '01:00', '午前1'], [11, '11:00', '午前11'],
  [12, '12:00', '午後0'], [14, '14:00', '午後2'], [23, '23:00', '午後11']];
for (const [h, m24, m12] of railCases) {
  const a = globalThis.TTX.tz.hourLabel(h, true);
  const b = globalThis.TTX.tz.hourLabel(h, false);
  if (a === m24 && b === m12) ok(`hourLabel(${h}) = ${a} / ${b}`);
  else bad(`hourLabel(${h}): expected ${m24} / ${m12}, got ${a} / ${b}`);
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

// --- 5a. dates a person types -----------------------------------------------
//
// Pure, so it runs here with no app and no calendar. `now` is injected on
// purpose: a date helper whose tests only pass on the day you wrote them is
// the classic version of this file.

section('CLI dates (behavioural)');
const dates = require(path.join(ROOT, 'client/dates.js'));

// 2026-07-17 is a Friday, 09:00 JST (= 00:00Z).
const NOW = Date.UTC(2026, 6, 17, 0, 0);

const dayCases = [
  ['today', '2026-07-17'],
  ['tomorrow', '2026-07-18'],
  ['yesterday', '2026-07-16'],
  ['今日', '2026-07-17'],
  ['2026-08-01', '2026-08-01'],
  ['7/21', '2026-07-21'],
  ['12/3', '2026-12-03'],
  ['+7d', '2026-07-24'],
  ['-3d', '2026-07-14'],
  ['ごはん', null],
  ['', null],
];
for (const [input, want] of dayCases) {
  const got = dates.day(input, NOW);
  if (got === want) ok(`day(${JSON.stringify(input)}) = ${JSON.stringify(got)}`);
  else bad(`day(${JSON.stringify(input)}): expected ${JSON.stringify(want)}, got ${JSON.stringify(got)}`);
}

const rangeCases = [
  // Weeks start Monday here, same as the grid. 7/17 is a Friday.
  ['week', '2026-07-13', '2026-07-19'],
  ['nextweek', '2026-07-20', '2026-07-26'],
  ['lastweek', '2026-07-06', '2026-07-12'],
  ['month', '2026-07-01', '2026-07-31'],
  ['nextmonth', '2026-08-01', '2026-08-31'],
  ['today', '2026-07-17', '2026-07-17'],
  ['7/21', '2026-07-21', '2026-07-21'],
];
for (const [input, from, to] of rangeCases) {
  const got = dates.range(input, NOW);
  if (got && got.from === from && got.to === to) ok(`range(${JSON.stringify(input)}) = ${from}〜${to}`);
  else bad(`range(${JSON.stringify(input)}): expected ${from}〜${to}, got ${JSON.stringify(got)}`);
}

/* A moment, for `add`. The bare-day case is the load-bearing one: it has to
 * come back distinguishable from midnight, because that is how `add` knows the
 * person meant an all-day event. */
const whenCases = [
  ['7/21 10:00', '2026-07-21', '10:00'],
  ['7/21 9:30', '2026-07-21', '09:30'],
  ['2026-07-21T10:00', '2026-07-21', '10:00'],
  ['明日 9時', '2026-07-18', '09:00'],
  ['today 8:05', '2026-07-17', '08:05'],
  ['+7d 14:00', '2026-07-24', '14:00'],
  ['7/21', '2026-07-21', null],          // no clock → all-day, not 00:00
  ['明日', '2026-07-18', null],
  ['7/21 0:00', '2026-07-21', '00:00'],  // ...but midnight asked for is midnight
  ['7/21 25:00', null, null],
  ['7/21 10:70', null, null],
  ['10:00', null, null],                 // a time with no day is a wrong guess
  ['ごはん', null, null],
];
for (const [input, key, time] of whenCases) {
  const got = dates.when(input, NOW);
  const okd = key === null ? got === null : (got && got.key === key && got.time === time);
  if (okd) ok(`when(${JSON.stringify(input)}) = ${got ? `${got.key} ${got.time ?? '(終日)'}` : 'null'}`);
  else bad(`when(${JSON.stringify(input)}): expected ${key} ${time}, got ${JSON.stringify(got)}`);
}

const minsCases = [['1h', 60], ['90m', 90], ['1:30', 90], ['1.5h', 90], ['45', 45],
  ['2時間', 120], ['30分', 30], ['0', 0], ['あとで', null], ['', null]];
for (const [input, want] of minsCases) {
  const got = dates.mins(input);
  if (got === want) ok(`mins(${JSON.stringify(input)}) = ${JSON.stringify(got)}`);
  else bad(`mins(${JSON.stringify(input)}): expected ${want}, got ${got}`);
}

/* Reminders. Whole days stay days: 「1日前」 is 1440 minutes for a timed event
 * and 900 for an all-day one, and this function has no way to know which. */
const alertCases = [
  ['30m', { mins: 30 }],
  ['30分前', { mins: 30 }],
  ['1h', { mins: 60 }],
  ['1時間前', { mins: 60 }],
  ['15', { mins: 15 }],
  ['0', { mins: 0 }],
  ['開始時', { mins: 0 }],
  ['当日', { mins: 0 }],
  ['1d', { days: 1 }],
  ['2日前', { days: 2 }],
  ['7日', { days: 7 }],
  ['あとで', null],
  ['', null],
];
for (const [input, want] of alertCases) {
  const got = dates.alert(input);
  if (JSON.stringify(got) === JSON.stringify(want)) ok(`alert(${JSON.stringify(input)}) = ${JSON.stringify(got)}`);
  else bad(`alert(${JSON.stringify(input)}): expected ${JSON.stringify(want)}, got ${JSON.stringify(got)}`);
}

/* The JST rule, which is the whole reason this doesn't just use `new Date()`.
 * 2026-07-17 15:30Z is already the 18th in Tokyo. A machine in UTC would say
 * the 17th, and `tf ls today` would quietly list the wrong day. */
if (dates.today(Date.UTC(2026, 6, 17, 15, 30)) === '2026-07-18') {
  ok('today() is JST — 15:30Z on the 17th is already the 18th in Tokyo');
} else {
  bad(`today() must resolve in JST, got ${dates.today(Date.UTC(2026, 6, 17, 15, 30))}`);
}
if (dates.today(Date.UTC(2026, 6, 17, 14, 59)) === '2026-07-17') ok('and 14:59Z is still the 17th');
else bad('today() rolled over too early');

/* Month ends are the thing people get wrong by hand. */
for (const [key, want] of [['2026-02-05', '2026-02-28'], ['2024-02-05', '2024-02-29'], ['2026-12-31', '2026-12-31']]) {
  const got = dates.monthEnd(key);
  if (got === want) ok(`monthEnd(${key}) = ${got}`);
  else bad(`monthEnd(${key}): expected ${want}, got ${got}`);
}

// --- 5b0. the agenda doesn't lose its tail ----------------------------------
//
// daysBetween has a 400-day runaway guard, and going over it doesn't throw — it
// just stops returning days. That was invisible while the agenda always showed
// three months. It grows as you scroll now, and at full span the last year of
// it rendered as nothing at all: the months were in the range, the days were
// not. Exactly the silent truncation this project keeps finding.

section('agenda span (behavioural)');
require(path.join(ROOT, 'src/lib/tz.js'));

/* Mirrors client/renderer/app.js. If AGENDA_MAX_MONTHS moves and this doesn't,
 * the app goes back to dropping months without a word — so read it from the
 * source rather than restating the number here. */
const appSrc = fs.readFileSync(path.join(ROOT, 'client/renderer/app.js'), 'utf8');
const maxMonths = +(appSrc.match(/AGENDA_MAX_MONTHS\s*=\s*(\d+)/) || [])[1];
const capExpr = appSrc.match(/AGENDA_DAY_CAP\s*=\s*AGENDA_MAX_MONTHS\s*\*\s*(\d+)\s*\+\s*(\d+)/);
const dayCap = capExpr ? maxMonths * +capExpr[1] + +capExpr[2] : NaN;

if (maxMonths > 0) ok(`AGENDA_MAX_MONTHS is ${maxMonths} — the most that may be rendered at once`);
else bad('could not read AGENDA_MAX_MONTHS out of app.js');
if (Number.isFinite(dayCap)) ok(`AGENDA_DAY_CAP reads as ${dayCap}`);
else bad('could not read AGENDA_DAY_CAP out of app.js — has the expression changed shape?');

/* The worst case: every month in the span is a 31-day month. */
if (dayCap >= maxMonths * 31) ok(`AGENDA_DAY_CAP (${dayCap}) covers ${maxMonths} × 31-day months`);
else bad(`AGENDA_DAY_CAP ${dayCap} is short of ${maxMonths} × 31 = ${maxMonths * 31} days`);

/* And the real thing: ask daysBetween for the full span and count what comes
 * back. A default cap silently returns 400 and the last year vanishes. */
{
  const from = '2026-01-01';
  const to = globalThis.TTX.tz.ymd(Date.UTC(2026, maxMonths, 0), 'UTC'); // end of the last month
  const want = globalThis.TTX.tz.daysBetween(from, to, dayCap);
  const capped = globalThis.TTX.tz.daysBetween(from, to);              // the 400 default
  if (want[want.length - 1] === to) ok(`the full ${maxMonths}-month span reaches its last day (${to})`);
  else bad(`span truncated: asked to ${to}, got ${want[want.length - 1]}`);
  if (capped.length < want.length) {
    ok(`and the default cap would have cut it at ${capped[capped.length - 1]} — this guard is not decorative`);
  } else {
    bad('the default cap no longer truncates this span — the guard proves nothing; widen the case');
  }
}

// --- 5b1. the month grid is as tall as the month needs -----------------------
//
// A fixed 6 rows draws a spare week of next month in most months, and worse,
// the grid divides one height between them: every cell loses ~17% and events
// that would have fit get rolled into 「+N件」. The counts on the right are what
// TimeTree Web actually rendered for the throwaway calendar, read off the screen
// one month at a time — not a formula checked against itself.

section('month grid height (behavioural)');
const { tz } = globalThis.TTX;

/* Same arithmetic renderMonth() uses. Kept here rather than imported because
 * app.js is a renderer file with no module boundary — so this asserts the RULE,
 * and scripts/verify-month.js asserts the app obeys it. */
const weeksIn = (y, m, weekStartDow) => {
  const first = `${y}-${String(m).padStart(2, '0')}-01`;
  const last = tz.ymd(Date.UTC(y, m, 0), 'UTC');
  const gridFrom = tz.addDays(first, -((tz.weekdayOf(first) - weekStartDow + 7) % 7));
  return Math.ceil(tz.daysBetween(gridFrom, last).length / 7);
};

/* Measured off TimeTree Web (月曜始まり), 2026, one month at a time. */
const HONKE_2026 = [[7, 5], [8, 6], [9, 5], [10, 5], [11, 6], [12, 5]];
for (const [m, want] of HONKE_2026) {
  const got = weeksIn(2026, m, 1);
  if (got === want) ok(`2026年${m}月 needs ${got} weeks — matches 本家`);
  else bad(`2026年${m}月: 本家 renders ${want} weeks, we compute ${got}`);
}

/* Sunday-start is our other option, so it has to be right too. 2026-03-01 is a
 * Sunday: starting the week on Sunday puts the 1st alone at the top of row 1 and
 * 31 days then need 5 rows; starting on Monday pulls it into the row above and
 * needs 6. Same month, different answer — which is the whole reason this is
 * computed and not a constant. */
if (weeksIn(2026, 3, 0) === 5) ok('2026年3月 日曜始まり → 5 weeks');
else bad(`2026年3月 日曜始まり should be 5, got ${weeksIn(2026, 3, 0)}`);
if (weeksIn(2026, 3, 1) === 6) ok('2026年3月 月曜始まり → 6 weeks (same month, different answer)');
else bad(`2026年3月 月曜始まり should be 6, got ${weeksIn(2026, 3, 1)}`);

/* February 2027 starts on a Monday and has 28 days: exactly 4 rows. If anything
 * ever clamps this to a minimum of 5 or 6, this is the case that catches it. */
if (weeksIn(2027, 2, 1) === 4) ok('2027年2月 月曜始まり → 4 weeks, and nothing pads it');
else bad(`2027年2月 月曜始まり should be 4, got ${weeksIn(2027, 2, 1)}`);

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
  // +343ms: a real edit, measured. Not a round number on purpose — an earlier
  // version allowed 1000ms of slack and would have called this "not edited",
  // which is the most common edit there is (fixing your own typo right after
  // sending). A fresh comment comes back with updated_at - created_at == 0
  // exactly, so the predicate needs no slack at all.
  { id: 'd', type: 0, author_id: 1, attachment: { content: 'なおした' }, created_at: 400, updated_at: 743 },
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

// --- 5d. the hosted web client's bundle is complete -------------------------
//
// web/build.js assembles web/dist from src/lib + client/renderer, and the Vercel
// deploy serves ONLY that. A renamed lib/renderer file, or an index.html <script>
// the build doesn't produce, white-screens the deploy with no other signal — the
// same silent-truncation this file guards for the packaged desktop app.
section('web client bundle');
{
  const buildJs = fs.readFileSync(path.join(ROOT, 'web/build.js'), 'utf8');
  const arr = (name) => {
    const m = buildJs.match(new RegExp(name + '\\s*=\\s*\\[([^\\]]*)\\]'));
    return m ? [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]) : [];
  };
  const libs = arr('LIBS');
  const renderer = arr('RENDERER');
  let webBad = 0;
  if (!libs.length || !renderer.length) { bad('web/build.js: could not read LIBS/RENDERER — guard is looking at the wrong shape'); webBad++; }
  for (const l of libs) if (!fs.existsSync(path.join(ROOT, `src/lib/${l}.js`))) { bad(`web/build.js copies src/lib/${l}.js, which is missing`); webBad++; }
  for (const f of renderer) if (!fs.existsSync(path.join(ROOT, `client/renderer/${f}`))) { bad(`web/build.js copies client/renderer/${f}, which is missing`); webBad++; }
  // every ./-relative <script>/<link> in web/index.html must be produced by the build
  const html = fs.readFileSync(path.join(ROOT, 'web/index.html'), 'utf8');
  const refs = [...html.matchAll(/(?:src|href)="\.\/([^"]+)"/g)].map((m) => m[1]);
  const produced = new Set(['index.html', 'host-web.js', 'favicon.png', ...libs.map((l) => `lib/${l}.js`), ...renderer.map((f) => `renderer/${f}`)]);
  for (const r of refs) if (!produced.has(r)) { bad(`web/index.html loads ./${r}, which web/build.js does not produce`); webBad++; }
  if (!webBad) ok(`web/index.html's ${refs.length} assets are all produced by web/build.js (${libs.length} libs + ${renderer.length} renderer)`);
}

// --- 5e. the Vercel build isn't sabotaged by .vercelignore ------------------
//
// web/build.js runs ON Vercel (buildCommand) and reads src/lib, client/renderer
// AND the favicon under icons/. If .vercelignore excludes any of those from the
// upload, the deploy build fails ("cannot find …") — invisible until you deploy.
// A blanket *.png once hid icons/icon-32.png exactly this way.
section('web deploy — .vercelignore keeps build.js inputs');
{
  const vi = fs.readFileSync(path.join(ROOT, '.vercelignore'), 'utf8')
    .split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
  const excluded = (rel) => vi.some((pat) => {
    if (pat.endsWith('/')) return rel === pat.slice(0, -1) || rel.startsWith(pat);
    if (pat.startsWith('*.')) return rel.endsWith(pat.slice(1));
    return rel === pat || rel.startsWith(pat + '/');
  });
  const b = fs.readFileSync(path.join(ROOT, 'web/build.js'), 'utf8');
  const readArr = (n) => { const m = b.match(new RegExp(n + '\\s*=\\s*\\[([^\\]]*)\\]')); return m ? [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]) : []; };
  const icon = (b.match(/'icons',\s*'([^']+)'/) || [])[1] || 'icon-32.png';
  const inputs = [
    'web/index.html', 'web/host-web.js', `icons/${icon}`,
    ...readArr('LIBS').map((l) => `src/lib/${l}.js`),
    ...readArr('RENDERER').map((f) => `client/renderer/${f}`),
  ];
  const blocked = inputs.filter(excluded);
  if (blocked.length) bad(`.vercelignore excludes web/build.js inputs — the Vercel build would fail: ${blocked.join(', ')}`);
  else ok(`all ${inputs.length} web/build.js inputs survive .vercelignore (the deploy build has them)`);
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
