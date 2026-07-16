#!/usr/bin/env node
/* End-to-end verification of reminders, against the real app.
 *
 * Three separate claims, because they can fail independently:
 *   1. the OS path works        — host.notify.show() reaches Electron and the
 *                                 desktop actually shows something
 *   2. the decision is right    — a due alert fires, on the real ticker
 *   3. it fires once            — a second tick doesn't repeat it
 *
 * WHEN a reminder is due is checked separately and exactly, in
 * scripts/check.js — that's pure arithmetic and doesn't need an app.
 *
 * The notify bridge is frozen by contextBridge (deliberately — the renderer
 * must not be able to reshape its own privileges), so this cannot stub the
 * call. It observes the two ends instead: show() answering true, and the
 * fired-ledger in localStorage gaining the key.
 *
 * NOTE: real toasts will appear on the desktop while this runs.
 *
 * Usage:
 *   cd client && npm run inspect
 *   npm i playwright-core
 *   npm run verify:notify
 *
 * SAFETY: refuses to run unless every enabled calendar is the throwaway `dowa`.
 */
let chromium;
try {
  ({ chromium } = require('playwright-core'));
} catch {
  console.error('playwright-core is not installed. For this script only:  npm i playwright-core');
  process.exit(1);
}

const CDP = 'http://127.0.0.1:9333';
const EXPECT_CALENDAR = 'dowa';
const TICK = 30000;

let pass = 0, fail = 0;
const ok = (m) => { pass++; console.log('  \x1b[32m✓\x1b[0m ' + m); };
const bad = (m) => { fail++; console.log('  \x1b[31m✗\x1b[0m ' + m); };
const sec = (t) => console.log('\n' + t);
const check = (c, m) => (c ? ok(m) : bad(m));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const browser = await chromium.connectOverCDP(CDP).catch(() => {
    console.error(`Nothing on ${CDP}. Start the client:  cd client && npm run inspect`);
    process.exit(1);
  });
  const page = browser.contexts()[0].pages().find((p) => p.url().includes('index.html'));
  if (!page) throw new Error('renderer page not found');
  page.on('pageerror', (e) => console.log('   [pageerror] ' + e.message));
  await page.waitForFunction(() => globalThis.TTX?.store?.state?.ready === true, { timeout: 90000 });

  sec('safety guard');
  const cals = await page.evaluate(() => TTX.store.state.calendars
    .filter((c) => TTX.store.state.enabled.has(c.id)).map((c) => c.name));
  if (!cals.length || !cals.every((c) => c === EXPECT_CALENDAR)) {
    console.error(`\n\x1b[31mABORT\x1b[0m: expected only "${EXPECT_CALENDAR}", got ${JSON.stringify(cals)}`);
    process.exit(2);
  }
  ok(`only "${EXPECT_CALENDAR}" is writable`);

  // Start from a known state. The off-switch section below deliberately turns
  // notifications off, and the live flag only re-reads prefs on load — so a
  // previous run could otherwise leave this one testing a silenced app.
  const reload = async () => {
    await page.reload();
    await page.waitForFunction(() => globalThis.TTX?.store?.state?.ready === true, { timeout: 90000 });
  };
  await page.evaluate(() => {
    const p = JSON.parse(localStorage.getItem('ttc.prefs') || '{}');
    p.notify = true;
    localStorage.setItem('ttc.prefs', JSON.stringify(p));
    localStorage.setItem('ttc.fired', '{}');
  });
  await reload();
  ok('notifications on, ledger empty');

  // --- 1. the OS path -------------------------------------------------------
  sec('the OS path');
  const shown = await page.evaluate(() => window.host.notify.show({
    title: 'TimeForest 検証', body: 'これはテスト通知です', key: null,
  }));
  check(shown === true, 'host.notify.show() reached Electron and the OS accepted it');
  check(await page.evaluate(() => Object.isFrozen(window.host.notify)),
    'the bridge is frozen — the renderer cannot reshape its own privileges');

  // --- 2. the decision ------------------------------------------------------
  sec('a due reminder fires, on the real ticker');
  const setup = await page.evaluate(async () => {
    const cal = [...TTX.store.state.enabled][0];
    // Started a minute ago with a 開始時 reminder: due now, inside the grace
    // window, so the next tick should pick it up.
    const start = Date.now() - 60000;
    const e = await TTX.api.createEvent(cal, {
      title: 'NF検証-通知', allDay: false, startAt: start, endAt: start + 1800000,
      tz: 'Asia/Tokyo', labelId: 1, alerts: [0],
    });
    TTX.store.applyEvent(cal, e);
    localStorage.setItem('ttc.fired', '{}');   // start from a clean ledger
    return { cal, uuid: e.uuid, start: e.start_at };
  });
  ok(`created an event due now (${new Date(setup.start).toISOString()})`);

  const ledger = () => page.evaluate(() => JSON.parse(localStorage.getItem('ttc.fired') || '{}'));
  const wantKey = `${setup.uuid}@${setup.start}#0`;

  let fired = null;
  for (let i = 0; i < Math.ceil((TICK + 8000) / 1000); i++) {
    const l = await ledger();
    if (l[wantKey]) { fired = l; break; }
    await sleep(1000);
  }
  check(!!fired, `the ticker fired it within one tick (${TICK / 1000}s)`);
  check(fired && Object.keys(fired).length === 1,
    `exactly one reminder fired, not a backlog (${fired ? Object.keys(fired).length : '—'})`);

  // --- 3. once, not every tick ---------------------------------------------
  sec('fires once');
  await sleep(TICK + 3000);
  const after = await ledger();
  check(Object.keys(after).length === 1, 'a second tick did not fire it again');
  check(after[wantKey] === fired?.[wantKey], 'the ledger entry is unchanged');

  // --- 3b. closing must not stop the reminders ------------------------------
  // The whole feature dies the first time somebody hits X unless close means
  // "hide". This is the assertion that keeps that honest.
  sec('closing the window hides it — reminders keep running');
  await page.evaluate(() => { localStorage.setItem('ttc.fired', '{}'); });
  const closed = await page.evaluate(() => { window.close(); return true; });
  await sleep(2000);
  check(closed && !page.isClosed(), 'the renderer is still alive after close');
  check(await page.evaluate(() => document.visibilityState !== undefined),
    'and still executing');

  const hiddenSetup = await page.evaluate(async () => {
    const cal = [...TTX.store.state.enabled][0];
    const start = Date.now() - 60000;
    const e = await TTX.api.createEvent(cal, {
      title: 'NF検証-トレイ', allDay: false, startAt: start, endAt: start + 1800000,
      tz: 'Asia/Tokyo', labelId: 1, alerts: [0],
    });
    TTX.store.applyEvent(cal, e);
    return { uuid: e.uuid, start: e.start_at };
  });
  let hiddenFired = false;
  for (let i = 0; i < Math.ceil((TICK + 8000) / 1000); i++) {
    const l = await ledger();
    if (l[`${hiddenSetup.uuid}@${hiddenSetup.start}#0`]) { hiddenFired = true; break; }
    await sleep(1000);
  }
  check(hiddenFired, 'a reminder still fires with the window closed to the tray');

  // Put the window back. A person would click the tray; a script can't, and
  // leaving someone's app hidden because a test closed it is rude.
  await page.bringToFront();
  await sleep(800);
  check(await page.evaluate(() => document.visibilityState === 'visible'),
    'the window comes back (as it would from the tray)');

  // --- 4. off means off -----------------------------------------------------
  sec('the off switch');
  await page.evaluate(() => {
    localStorage.setItem('ttc.fired', '{}');
    const p = JSON.parse(localStorage.getItem('ttc.prefs') || '{}');
    p.notify = false;
    localStorage.setItem('ttc.prefs', JSON.stringify(p));
  });
  await reload();
  await sleep(TICK + 3000);
  check(Object.keys(await ledger()).length === 0,
    'with notify off, the due reminders above are not fired');

  // Restore, and RELOAD — the live flag only re-reads prefs on load, so
  // writing storage alone would leave the app silent for whoever runs next.
  await page.evaluate(async () => {
    const p = JSON.parse(localStorage.getItem('ttc.prefs') || '{}');
    p.notify = true;
    localStorage.setItem('ttc.prefs', JSON.stringify(p));
    localStorage.setItem('ttc.fired', '{}');
    const cal = [...TTX.store.state.enabled][0];
    for (const e of TTX.store.state.events.get(cal) || []) {
      if (/^NF検証/.test(e.title || '') && !e.deactivated_at) {
        await TTX.api.deleteEvent(cal, e.uuid);
        TTX.store.markDeleted(cal, e.uuid);
      }
    }
  });
  const left = await page.evaluate(() => (TTX.store.state.events.get([...TTX.store.state.enabled][0]) || [])
    .filter((e) => /^NF検証/.test(e.title || '') && !e.deactivated_at).length);
  check(left === 0, 'no test events left behind');
  await reload();
  ok('notifications restored to on, in the running app as well as in prefs');

  console.log(`\n${fail ? '\x1b[31m' : '\x1b[32m'}${pass} passed, ${fail} failed\x1b[0m`);
  await browser.close();
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error('\n\x1b[31mVERIFY THREW\x1b[0m:', e.message);
  process.exit(1);
});
