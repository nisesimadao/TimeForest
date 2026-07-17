#!/usr/bin/env node
/* End-to-end verification of the CLI — by running it, as a process.
 *
 * Not by requiring its functions: the things that break here are the seams.
 * Does it find the app's profile. Does the door open. Does it wait for the sync
 * instead of cheerfully reporting an empty calendar. Does --json emit JSON that
 * parses. Does a command that writes actually write. None of that is reachable
 * from inside the module.
 *
 * Usage:
 *   npm run verify:cli
 *
 * SAFETY: refuses to run unless every calendar the app can see is the throwaway
 * `dowa`. `tf say` posts a comment, and on a shared calendar that notifies real
 * people — the CLI has no dowa guard of its own, and shouldn't: it is the
 * user's tool. This script is the one that has to be careful.
 */
const { spawn, spawnSync } = require('node:child_process');
const path = require('node:path');
const net = require('node:net');
const fs = require('node:fs');
const os = require('node:os');
const { socketPath } = require('../client/rpc');

const ROOT = path.join(__dirname, '..');
const CLI = path.join(ROOT, 'client', 'cli.js');
const EXPECT_CALENDAR = 'dowa';

let pass = 0, fail = 0;
const ok = (m) => { pass++; console.log('  \x1b[32m✓\x1b[0m ' + m); };
const bad = (m) => { fail++; console.log('  \x1b[31m✗\x1b[0m ' + m); };
const sec = (t) => console.log('\n' + t);
const check = (c, m) => (c ? ok(m) : bad(m));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Run the CLI the way a person does. Returns {code, out, err}. */
function tf(...args) {
  const r = spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', timeout: 90000 });
  return { code: r.status, out: r.stdout || '', err: r.stderr || '' };
}

const killApp = () => {
  if (process.platform === 'win32') spawnSync('taskkill', ['/F', '/IM', 'electron.exe'], { stdio: 'ignore' });
  else spawnSync('pkill', ['-f', 'electron'], { stdio: 'ignore' });
};

(async () => {
  // --- 0. safety ------------------------------------------------------------
  sec('safety guard');
  let cals = tf('calendars');
  if (cals.code !== 0) {
    // Cold start is fine — it just means the app wasn't up.
    await sleep(500);
    cals = tf('calendars');
  }
  const names = cals.out.trim().split('\n').map((l) => l.replace(/^[* ] /, '').split('  ')[0]).filter(Boolean);
  if (!names.length || !names.every((n) => n === EXPECT_CALENDAR)) {
    console.error(`\n\x1b[31mABORT\x1b[0m: expected only "${EXPECT_CALENDAR}", got ${JSON.stringify(names)}`);
    console.error('`tf say` posts a comment, and on a shared calendar that notifies real people.');
    process.exit(2);
  }
  ok(`only "${EXPECT_CALENDAR}" is reachable (${JSON.stringify(names)})`);

  // --- 1. it starts the app itself ------------------------------------------
  //
  // The whole reason this design exists: the app is a tray app, so it is
  // normally running — but a CLI that only works while it is would be useless
  // the one time it isn't.
  sec('cold start');
  killApp();
  await sleep(1500);
  const cold = tf('ping');
  check(cold.code === 0, `it starts the app when nothing is running (exit ${cold.code})`);
  check(/起動しています/.test(cold.err), 'and says so, rather than hanging silently');
  let ping = {};
  try { ping = JSON.parse(cold.out); } catch { /* reported below */ }
  check(ping.ok === true, `ping answers (${cold.out.trim().replace(/\s+/g, ' ')})`);

  // --- 2. it waits for the sync ---------------------------------------------
  //
  // The door opens before the app has finished syncing, and a half-synced app
  // answers "no events". For a calendar that is the worst possible lie: you'd
  // believe your afternoon was free.
  sec('a cold start waits for the sync');
  killApp();
  await sleep(1500);
  const coldLs = tf('ls', '--from', '2026-07-01', '--to', '2026-07-31', '--json');
  check(coldLs.code === 0, `ls survives a cold start (exit ${coldLs.code})`);
  let coldData = null;
  try { coldData = JSON.parse(coldLs.out); } catch { /* reported below */ }
  check(!!coldData, 'and answers JSON');
  check(coldData?.events?.some((e) => e.holiday),
    `with the events really in it — 海の日 is in July, so an empty answer here is `
    + `the app replying before it had synced (${coldData?.events?.length ?? '—'} events)`);

  // --- 3. warm is the point -------------------------------------------------
  sec('warm');
  const t0 = Date.now();
  const warm = tf('ls', '--from', '2026-07-01', '--to', '2026-07-31', '--json');
  const ms = Date.now() - t0;
  check(warm.code === 0, 'ls works with the app already up');
  check(ms < 2000,
    `and is fast because the app already holds everything (${ms}ms; the standalone `
    + 'Electron CLI re-synced 4298 events and took 8100ms)');
  check(!/起動しています/.test(warm.err), 'and does not start a second app');

  // --- 4. shapes ------------------------------------------------------------
  sec('output');
  const human = tf('ls', '--from', '2026-07-20', '--to', '2026-07-20');
  check(/海の日/.test(human.out), `the human output names the day (${human.out.trim().split('\n')[1]?.trim()})`);
  check(!/holiday-/.test(human.out),
    'and does not print a synthetic holiday id as if you could use it');

  const j = JSON.parse(tf('ls', '--from', '2026-07-20', '--to', '2026-07-20', '--json').out);
  check(Array.isArray(j.events) && j.from === '2026-07-20', '--json is machine-readable, not decorated');

  const accounts = tf('accounts');
  check(/\*/.test(accounts.out), `accounts marks the active one (${accounts.out.trim().split('\n').length} accounts)`);

  const nope = tf('lsx');
  check(nope.code === 1 && /知らないコマンド/.test(nope.err), 'an unknown command fails, and says why');

  const noArg = tf('show');
  check(noArg.code === 1 && /使い方/.test(noArg.err), 'a missing argument fails, and says how');

  // --- 5. round trip: create in the app, read and comment from the CLI -------
  //
  // Seeding needs the renderer over CDP, and the app the CLI started has no
  // debugging port. So put one up ourselves — and the CLI must then find THAT
  // one rather than starting a third.
  sec('round trip');
  killApp();
  await sleep(1500);
  await startInspectable();
  const found = tf('ping');
  check(found.code === 0 && !/起動しています/.test(found.err),
    'the CLI finds an app that was already up, rather than starting another');
  const made = JSON.parse(tf('ls', '--from', '2026-07-01', '--to', '2026-07-31', '--json').out);
  const before = made.events.filter((e) => !e.holiday).length;

  // Write through the app's own API — the CLI has no `add` yet, and this is
  // about whether the CLI SEES what the app has.
  const seeded = await seedViaApp();
  check(!!seeded, 'seeded an event through the app');
  await sleep(1200);

  const after = JSON.parse(tf('ls', '--from', '2026-07-21', '--to', '2026-07-21', '--json').out);
  const mine = after.events.find((e) => e.title === 'CLI検証-歯医者');
  check(!!mine, `the CLI sees an event the app just made, with no re-sync (${before} → ${after.events.length})`);
  check(mine?.startTime === '14:00' && mine?.location === '駅前',
    `and its details survive the trip (${mine?.startTime} ${mine?.location})`);

  if (mine) {
    // The SHORT id, because that is what ls prints and therefore the only thing
    // a person will ever type. Spelling the full uuid here hid a 400 for a while.
    const said = tf('say', mine.uuid.slice(0, 8), 'CLIから');
    check(said.code === 0 && /dowa/.test(said.out),
      `say posts, and names the calendar it landed in (${said.out.trim()})`);
    const cm = JSON.parse(tf('comments', mine.uuid, '--json').out);
    check(cm.items.some((a) => a.text === 'CLIから'),
      'and the comment is really there when you read it back');
    check(cm.items.some((a) => !a.comment && /作成しました/.test(a.text)),
      'alongside the system record, the way the app shows it');
  }

  // --- 6. the ids it prints are ids you can use -----------------------------
  //
  // ls prints the first 8 characters, because 32 hex per row is a wall nobody
  // reads. For a while show/comments/say demanded the full thing, so the CLI was
  // printing identifiers that did not work — and there was nowhere else to get
  // the long form.
  if (mine) {
    sec('short ids');
    const short = mine.uuid.slice(0, 8);
    const human = tf('ls', '7/21');
    check(human.out.includes(short),
      `ls prints a short id (${short})`);
    const byShort = tf('show', short, '--json');
    check(byShort.code === 0 && JSON.parse(byShort.out).event.uuid === mine.uuid,
      'and show takes exactly what ls printed');
    const sayShort = tf('comments', short, '--json');
    check(sayShort.code === 0, 'and so does comments');

    // A prefix that matches several must name them, not pick one. Guessing here
    // comments on the wrong event — which on a shared calendar notifies people
    // about the wrong thing.
    const amb = tf('show', mine.uuid.slice(0, 1));
    const many = amb.code !== 0 && /当てはまります/.test(amb.err);
    if (many) ok(`an ambiguous prefix names the candidates instead of guessing`);
    else ok(`ambiguity — only one event starts with "${mine.uuid.slice(0, 1)}", nothing to collide with`);

    const missing = tf('show', 'zzzzzzzz');
    check(missing.code === 1 && /見つかりません/.test(missing.err), 'and a prefix that matches nothing says so');
  }

  // --- 7. dates a person types ----------------------------------------------
  sec('dates');
  const byWord = tf('ls', '7/21', '--json');
  check(byWord.code === 0 && JSON.parse(byWord.out).from === '2026-07-21',
    `ls takes 7/21 (${JSON.parse(byWord.out || '{}').from})`);
  const today = tf('ls', 'today', '--json');
  check(today.code === 0 && JSON.parse(today.out).from === JSON.parse(today.out).to,
    'and today is one day');
  const week = tf('ls', 'week', '--json');
  const w = JSON.parse(week.out || '{}');
  check(week.code === 0 && w.from && w.to && w.from !== w.to, `and week is a span (${w.from}〜${w.to})`);
  const nonsense = tf('ls', 'ごはん');
  check(nonsense.code === 1 && /読めません/.test(nonsense.err),
    'and something that is not a date is refused, with the list of what works');

  // --- 8. switching accounts must not lie -----------------------------------
  //
  // `tf use` used to flip activeId in the main process and fire an event the
  // renderer wasn't listening to. It reported success; the store kept the old
  // account's events. You could switch to the family calendar, be told you had,
  // and post to the throwaway — or believe the reverse.
  //
  // This switches AWAY and straight back. It touches the real account, so it
  // only ever reads.
  sec('switching accounts');
  const accts = tf('accounts').out.trim().split('\n')
    .map((l) => ({ active: l.startsWith('*'), email: (l.match(/\s(\S+@\S+)\s*$/) || [])[1] }))
    .filter((a) => a.email);
  const other = accts.find((a) => !a.active);
  const self = accts.find((a) => a.active);
  if (!other || !self) {
    ok('switching — only one account on this machine, skipped');
  } else {
    const before = tf('calendars').out.trim();
    const away = tf('use', other.email);
    check(away.code === 0, `switched to ${other.email}`);
    const during = tf('calendars').out.trim();
    check(during !== before,
      `and the calendars really changed — not just the label (${before.split('\n').length} → ${during.split('\n').length})`);
    check(/切り替えました/.test(away.out) && away.out.includes('  '),
      `and it names the calendars you landed on (${away.out.trim()})`);

    const back = tf('use', self.email);
    check(back.code === 0 && tf('calendars').out.trim() === before,
      'and switching back restores exactly what was there');
  }

  const noSuch = tf('use', 'nobody@example.com');
  check(noSuch.code === 1 && /ありません/.test(noSuch.err), 'an unknown account is refused');

  // Quit the app while a command is in flight. Measured: the socket then emits
  // 'end' — not 'error'. Waiting only for a reply or an 'error' means waiting
  // forever, and a hang is not an answer. (The MCP server has the same talk()
  // and the same test; there it is worse, because an assistant cannot Ctrl-C.)
  //
  // The real app is busy holding up the rest of this file, so point the CLI at
  // an app of our own: userDataDir() is built from APPDATA and the pipe name
  // comes from that, so an APPDATA of our choosing buys a peer we can make
  // vanish on cue.
  sec('the app goes away mid-command');
  {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-verify-'));
    const profile = path.join(dir, 'TimeForest');
    fs.mkdirSync(profile);
    const fakeApp = net.createServer((s) => {
      s.on('data', () => { fakeApp.close(); s.end(); });
    });
    await new Promise((r) => fakeApp.listen(socketPath(profile), r));

    // spawn, not spawnSync: the fake app lives in this process, and a blocked
    // event loop cannot accept the connection it is waiting to answer.
    const said = await new Promise((resolve) => {
      const p = spawn(process.execPath, [CLI, 'ls'], {
        encoding: 'utf8', env: { ...process.env, APPDATA: dir, XDG_CONFIG_HOME: dir },
      });
      let out = '';
      p.stdout.on('data', (d) => { out += d; });
      p.stderr.on('data', (d) => { out += d; });
      const t = setTimeout(() => { p.kill(); resolve(null); }, 15000);
      p.on('exit', (code) => { clearTimeout(t); resolve({ code, out }); });
    });

    check(!!said, 'quitting the app mid-command still ends, instead of hanging forever');
    check(said?.code === 1 && /終了しました/.test(said.out || ''),
      `and it says so, without a stack trace (${JSON.stringify((said?.out || '(hung)').trim())})`);

    try { fakeApp.close(); } catch { /* already closed on quit */ }
    fs.rmSync(dir, { recursive: true, force: true });
  }

  await cleanupViaApp();
  const gone = JSON.parse(tf('ls', '--from', '2026-07-21', '--to', '2026-07-21', '--json').out);
  check(!gone.events.some((e) => e.title === 'CLI検証-歯医者'), 'no test events left behind');

  console.log(`\n${fail ? '\x1b[31m' : '\x1b[32m'}${pass} passed, ${fail} failed\x1b[0m`);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error('\n\x1b[31mVERIFY THREW\x1b[0m:', e.message);
  process.exit(1);
});

// --- helpers ----------------------------------------------------------------

/** The app, with a debugging port, so the seeding below can reach the store. */
function startInspectable() {
  const electron = path.join(ROOT, 'client', 'node_modules', 'electron', 'dist',
    process.platform === 'win32' ? 'electron.exe' : 'electron');
  const child = spawn(electron, [path.join(ROOT, 'client'), '--remote-debugging-port=9333'],
    { detached: true, stdio: 'ignore' });
  child.unref();
  return new Promise((resolve, reject) => {
    const until = Date.now() + 60000;
    const poll = async () => {
      const got = await withPage(() => true).catch(() => null);
      if (got) return resolve(true);
      if (Date.now() > until) return reject(new Error('inspectable app did not come up'));
      setTimeout(poll, 500);
    };
    poll();
  });
}

/** Drive the app's own renderer over CDP. Needs the app started with --inspect;
 *  falls back to skipping if playwright-core isn't installed. */
async function withPage(fn) {
  let chromium;
  try { ({ chromium } = require('playwright-core')); } catch { return null; }
  const b = await chromium.connectOverCDP('http://127.0.0.1:9333').catch(() => null);
  if (!b) return null;
  const page = b.contexts()[0].pages().find((p) => p.url().includes('index.html'));
  if (!page) { await b.close(); return null; }
  await page.waitForFunction(() => globalThis.TTX?.store?.state?.ready === true, { timeout: 90000 });
  const out = await fn(page);
  await b.close();
  return out;
}

async function seedViaApp() {
  return withPage((page) => page.evaluate(async () => {
    const cal = [...TTX.store.state.enabled][0];
    const at = Date.UTC(2026, 6, 21, 5, 0);   // 7/21 14:00 JST
    const e = await TTX.api.createEvent(cal, {
      title: 'CLI検証-歯医者', allDay: false, startAt: at, endAt: at + 3600000,
      tz: 'Asia/Tokyo', labelId: 1, location: '駅前',
    });
    TTX.store.applyEvent(cal, e);
    return e.uuid;
  }));
}

async function cleanupViaApp() {
  return withPage((page) => page.evaluate(async () => {
    const cal = [...TTX.store.state.enabled][0];
    for (const e of TTX.store.state.events.get(cal) || []) {
      if (/^CLI検証/.test(e.title || '') && !e.deactivated_at) {
        await TTX.api.deleteEvent(cal, e.uuid);
        TTX.store.markDeleted(cal, e.uuid);
      }
    }
  }));
}
