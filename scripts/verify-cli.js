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

  // Write through the app's own API, not through `tf add`: this section is about
  // whether the CLI SEES what the app holds, and seeding with the thing under
  // test would only prove it agrees with itself.
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
  // --- 6c. writing ----------------------------------------------------------
  //
  // 「来週の金曜に歯医者入れといて」 is the first thing anyone says to an
  // assistant with a calendar. Reading everything and writing nothing is a
  // viewer with opinions.
  //
  // Every check reads back through `ls`, which goes the long way round (the
  // occurrence expansion, the holiday merge). Trusting add's own echo would only
  // prove the CLI agrees with itself about what it just sent.
  sec('add / edit / rm');
  {
    const made = tf('add', 'CLI検証-会議', '--at', '7/22 10:00', '--for', '90m', '--where', '会議室A', '--json');
    check(made.code === 0, `add makes an event (${(made.err || made.out).trim().slice(0, 60)})`);
    const back = JSON.parse(tf('ls', '7/22', '--json').out).events.find((e) => e.title === 'CLI検証-会議');
    check(back?.startTime === '10:00' && back?.endTime === '11:30',
      `and --for sets the length (${back?.startTime}–${back?.endTime})`);
    check(back?.location === '会議室A' && !back?.allDay, 'and --where lands, timed not all-day');

    // A day with no clock is a whole day. Someone typing `--at 8/1` means the
    // 1st, not one minute past midnight on the 1st.
    const span = tf('add', 'CLI検証-旅行', '--at', '8/1', '--to', '8/3', '--json');
    const spanBack = JSON.parse(tf('ls', '--from', '8/1', '--to', '8/3', '--json').out)
      .events.find((e) => e.title === 'CLI検証-旅行');
    check(span.code === 0 && spanBack?.allDay,
      'a start with no time makes an all-day event, rather than one at 00:00');
    check(spanBack?.startKey === '2026-08-01' && spanBack?.endKey === '2026-08-03',
      `and --to is the last day, inclusive (${spanBack?.startKey}〜${spanBack?.endKey})`);

    if (back) {
      const id = back.uuid.slice(0, 8);
      // Moving the start keeps the length. That is what 「ずらして」 means, and
      // what dragging does everywhere else — an edit that silently shortened the
      // event to zero would look like it worked.
      const moved = tf('edit', id, '--at', '7/22 14:00', '--json');
      const after = JSON.parse(tf('ls', '7/22', '--json').out).events.find((e) => e.uuid === back.uuid);
      check(moved.code === 0 && after?.startTime === '14:00' && after?.endTime === '15:30',
        `--at moves the start and keeps the length (${after?.startTime}–${after?.endTime})`);
      check(moved.code === 0 && JSON.parse(moved.out).changed.join() === 'start_at,end_at',
        `and sends only what changed — PUT is a merge (${moved.code === 0 ? JSON.parse(moved.out).changed.join(', ') : '—'})`);

      const kept = tf('edit', id, '--title', 'CLI検証-会議(改)', '--json');
      const titled = JSON.parse(tf('ls', '7/22', '--json').out).events.find((e) => e.uuid === back.uuid);
      check(kept.code === 0 && titled?.title === 'CLI検証-会議(改)' && titled?.startTime === '14:00',
        'a title-only edit leaves the time alone');

      const nothing = tf('edit', id, '--title', 'CLI検証-会議(改)');
      check(nothing.code === 1 && /変更はありません/.test(nothing.err),
        'and an edit that changes nothing says so rather than writing');

      const gone = tf('rm', id);
      check(gone.code === 0 && /dowa/.test(gone.out), `rm deletes, and names the calendar (${gone.out.trim()})`);
      check(!JSON.parse(tf('ls', '7/22', '--json').out).events.some((e) => e.uuid === back.uuid),
        'and it is really gone when you look again');
    }
    if (spanBack) tf('rm', spanBack.uuid.slice(0, 8));
  }

  // --- 6b-ii. a hidden calendar is hidden from the WINDOW, not from you -----
  //
  // occurrences() expands the enabled calendars, because that is what the view
  // shows. `ls` used to filter that result, so unticking a calendar's sidebar
  // box made `tf ls --cal プライベート` answer 「予定はありません」 about a
  // calendar that was named out loud and had events in it. Same question, one
  // checkbox later, opposite answer, nothing in the reply to catch it — and via
  // MCP an assistant cannot know the box exists at all.
  sec('a calendar hidden in the sidebar is still yours');
  {
    const day = '2026-07-31';
    tf('add', 'CLI検証-隠', '--at', `${day} 10:00`);
    const lit = JSON.parse(tf('ls', day, '--json').out).events.some((e) => e.title === 'CLI検証-隠');
    const off = await withPage((page) => page.evaluate(() => {
      const id = [...TTX.store.state.enabled][0];
      TTX.store.state.enabled.delete(id);          // untick it, the way the sidebar does
      return id;
    }));
    check(lit && off != null, 'staged an event on a calendar, then hid it in the sidebar');

    const named = JSON.parse(tf('ls', day, '--cal', 'dowa', '--json').out).events;
    check(named.some((e) => e.title === 'CLI検証-隠'),
      'naming it still answers about it — the checkbox is a window control');
    const unnamed = JSON.parse(tf('ls', day, '--json').out).events;
    check(unnamed.some((e) => e.title === 'CLI検証-隠'),
      'and so does asking generally — hiding an event you have is a missed appointment');

    await withPage((page) => page.evaluate((id) => TTX.store.state.enabled.add(id), off));
    check((await withPage((page) => page.evaluate(() => TTX.store.state.enabled.size))) === 1,
      'and the sidebar is back the way we found it');
  }

  // --- 6c-i. the ways a shell hands you something you didn't mean -----------
  //
  // Both of these got past the section above, and both write silently.
  sec('typos that used to land');
  {
    // `--where` with nothing after it. parse() cannot tell that from `--json`,
    // so it answers `true` for both — which went over the wire as JSON true,
    // through `location || ''`, into TimeTree, which stored the location as `t`.
    const bare = tf('add', 'CLI検証-裸フラグ', '--at', '7/30 10:00', '--where');
    check(bare.code === 1 && /値が要ります/.test(bare.err),
      `a flag with no value is refused, not sent (${(bare.err || bare.out).trim()})`);
    check(!JSON.parse(tf('ls', '7/30', '--json').out).events.some((e) => e.title === 'CLI検証-裸フラグ'),
      'and nothing was written');

    // `--at 7/21 10:00` without the quotes: the shell hands the time over as its
    // own word. It landed in the title and made an all-day event called
    // 「歯医者 10:00」 — nothing about which looks like an error.
    const unquoted = tf('add', 'CLI検証-引用符', '--at', '7/30', '11:00');
    check(unquoted.code === 1 && /引用符/.test(unquoted.err),
      `a time left loose is caught rather than folded into the title (${(unquoted.err || '').trim().split('\n')[0]})`);
    check(!JSON.parse(tf('ls', '7/30', '--json').out).events.some((e) => /CLI検証-引用符/.test(e.title)),
      'and nothing was written');

    // Same word, same silence, different damage: edit drops it and moves the
    // event to the right day at whatever time it already had.
    const badEdit = tf('edit', 'deadbeef', '--at', '7/30', '11:00');
    check(badEdit.code === 1 && /引用符/.test(badEdit.err), 'edit catches it too');
  }

  // --- 6c-ii. the window doesn't go stale, and doesn't get yanked -----------
  //
  // The store has no subscribers: a CLI write reaches the window only because
  // the CLI's own path re-renders. Without that, `tf add` says 作成しました and
  // the window shows nothing — and then nobody trusts either of them.
  //
  // Today, so this doesn't quietly depend on which month the window opens on.
  sec('a write from the CLI reaches the window');
  {
    const today = require('../client/dates').today();
    const put = tf('add', 'CLI検証-窓', '--at', `${today} 9:00`);
    const shown = await withPage((page) => page.evaluate(() =>
      document.body.innerText.includes('CLI検証-窓')));
    check(put.code === 0 && shown === true,
      'a CLI write shows up in the window without anyone touching it');

    // ...but not over the top of someone. paint() starts by closing the detail
    // card, so a write arriving while you read one would take it away — the
    // event is in the store either way, and the next repaint shows it.
    const opened = await withPage(async (page) => {
      await page.evaluate(() => {
        for (const n of document.querySelectorAll('*')) {
          if (!n.children.length && /CLI検証-窓/.test(n.textContent || '')) return n.closest('[class]').click();
        }
      });
      await page.waitForTimeout(700);
      return page.evaluate(() => !!document.querySelector('.d-card'));
    });
    if (!opened) {
      ok('detail card — could not open one here, skipped');
    } else {
      tf('add', 'CLI検証-邪魔', '--at', `${today} 10:00`);
      const survived = await withPage((page) => page.evaluate(() => {
        const still = !!document.querySelector('.d-card');
        document.querySelector('.d-scrim')?.click();      // put it back the way we found it
        return still;
      }));
      check(survived, 'and does not repaint over a detail card someone is reading');
    }
  }

  // --- 6d. the id `ls` prints covers the WHOLE series ------------------------
  //
  // model.js gives every occurrence the master's uuid, so a weekly event prints
  // the same eight characters on all five rows. Someone reading "delete the
  // piano lesson on the 21st" off that listing would lose all five, and on a
  // shared calendar everyone gets told.
  sec('repeating events are not one event');
  {
    const rec = await seedRepeating();
    check(!!rec, 'seeded a weekly event');
    if (rec) {
      const rows = JSON.parse(tf('ls', '--from', '7/21', '--to', '8/11', '--json').out)
        .events.filter((e) => e.title === 'CLI検証-ピアノ');
      check(rows.length > 1 && new Set(rows.map((e) => e.uuid)).size === 1,
        `ls prints ${rows.length} rows that all carry the same id — this is the trap`);

      const id = rec.slice(0, 8);
      const nope = tf('rm', id);
      check(nope.code === 1 && /繰り返し/.test(nope.err), 'rm refuses it rather than taking the whole series');
      const nope2 = tf('edit', id, '--at', '7/21 11:00');
      check(nope2.code === 1 && /繰り返し/.test(nope2.err), 'and so does edit');
      check(JSON.parse(tf('ls', '7/21', '--json').out).events.some((e) => e.uuid === rec),
        'and after both refusals the event is still there');

      const yes = tf('rm', id, '--all');
      check(yes.code === 0 && /繰り返し全部/.test(yes.out), `--all takes it, and says that is what it did (${yes.out.trim()})`);
      check(!JSON.parse(tf('ls', '--from', '7/21', '--to', '8/11', '--json').out)
        .events.some((e) => e.title === 'CLI検証-ピアノ'), 'and every occurrence goes');
    }
  }

  // --- 6e. it will not guess which calendar ---------------------------------
  //
  // Creating on a shared calendar notifies its members, so a guess here tells
  // the wrong family about your dentist. The throwaway has one calendar, which
  // is exactly the case the guard doesn't cover — so give the renderer a second
  // one. It is fake, and its id addresses nothing: if the guard ever breaks,
  // this test fails loudly instead of posting somewhere real.
  sec('it will not guess which calendar');
  {
    const injected = await withPage((page) => page.evaluate(() => {
      const st = TTX.store.state;
      if (st.calendars.length !== 1) return null;          // don't touch a real multi-calendar account
      st.calendars.push({ id: -99, name: 'CLI検証-偽', color: 0 });
      return true;
    }));
    if (!injected) {
      ok('two-calendar guard — could not stage it here, skipped');
    } else {
      const guessed = tf('add', 'CLI検証-まよい', '--at', '7/23 10:00');
      check(guessed.code === 1 && /どのカレンダーに作るか/.test(guessed.err),
        'add refuses rather than picking one of two calendars');
      const named = tf('add', 'CLI検証-まよい', '--at', '7/23 10:00', '--cal', 'dowa', '--json');
      check(named.code === 0, `and takes it once you say which (${(named.err || '').trim() || 'ok'})`);
      await withPage((page) => page.evaluate(() => {
        TTX.store.state.calendars = TTX.store.state.calendars.filter((c) => c.id !== -99);
      }));
      const stray = JSON.parse(tf('ls', '7/23', '--json').out).events.find((e) => e.title === 'CLI検証-まよい');
      check(!!stray, 'and it landed on the real calendar, not the fake one');
      if (stray) tf('rm', stray.uuid.slice(0, 8));
    }
  }

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

/** A weekly event, for the trap where one id means five rows. */
async function seedRepeating() {
  return withPage((page) => page.evaluate(async () => {
    const cal = [...TTX.store.state.enabled][0];
    const at = Date.UTC(2026, 6, 21, 1, 0);   // 7/21 10:00 JST
    const e = await TTX.api.createEvent(cal, {
      title: 'CLI検証-ピアノ', allDay: false, startAt: at, endAt: at + 3600000,
      tz: 'Asia/Tokyo', labelId: 1, recurrences: ['RRULE:FREQ=WEEKLY'],
    });
    TTX.store.applyEvent(cal, e);
    return e.uuid;
  }));
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
