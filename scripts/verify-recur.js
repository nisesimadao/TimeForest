#!/usr/bin/env node
/* End-to-end verification of the recurring-series UI, against the real API.
 *
 * The six operations under test were not invented: they were captured off
 * TimeTree's own web client, driven through its real UI on a throwaway
 * calendar. This script drives OUR UI through the same six and checks the
 * server ends up in the same state — including the two facts that could not
 * have been guessed, that `parent_id` is the write-side name for the master
 * link, and that the resulting child comes back carrying `recurring_uuid`.
 *
 * Usage:
 *   1. cd client && npm run inspect
 *   2. npm i playwright-core
 *   3. npm run verify:recur
 *
 * SAFETY: refuses to run unless every enabled calendar is the throwaway
 * account's `dowa`. Rewriting somebody's family series is not recoverable.
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
// A Monday, far enough out that nothing real is nearby.
const D1 = '2026-08-03';
const D2 = '2026-08-10';
const D3 = '2026-08-17';

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

  // --- guard ---------------------------------------------------------------
  sec('safety guard');
  const cals = await page.evaluate(() => TTX.store.state.calendars
    .filter((c) => TTX.store.state.enabled.has(c.id)).map((c) => ({ id: c.id, name: c.name })));
  if (!cals.length || !cals.every((c) => c.name === EXPECT_CALENDAR)) {
    console.error(`\n\x1b[31mABORT\x1b[0m: expected only "${EXPECT_CALENDAR}", got ` +
      JSON.stringify(cals.map((c) => c.name)));
    process.exit(2);
  }
  ok(`only "${EXPECT_CALENDAR}" is writable`);
  const CAL = cals[0].id;

  const sweep = () => page.evaluate(async (cal) => {
    const list = TTX.store.state.events.get(cal) || [];
    let n = 0;
    for (const e of list) {
      if (/^RC-/.test(e.title || '') && !e.deactivated_at) {
        await TTX.api.deleteEvent(cal, e.uuid);
        TTX.store.markDeleted(cal, e.uuid);
        n++;
      }
    }
    return n;
  }, CAL);

  const resync = () => page.evaluate(() => {
    TTX.store.state.events.clear();
    return TTX.store.syncAll();
  });

  /** Everything the server holds for our test titles, after a real re-sync. */
  const server = async () => {
    await resync();
    return page.evaluate((cal) => (TTX.store.state.events.get(cal) || [])
      .filter((e) => /^RC-/.test(e.title || '') && !e.deactivated_at)
      .map((e) => ({
        title: e.title, uuid: e.uuid,
        parent_id: e.parent_id ?? null, recurring_uuid: e.recurring_uuid ?? null,
        rec: e.recurrences || [], start: e.start_at,
        note: e.note || '', location: e.location || '',
      })), CAL);
  };

  /** Occurrence dates our reader produces for a title, across August. */
  const dates = (title) => page.evaluate((t) => TTX.store
    .occurrences('2026-08-01', '2026-09-30')
    .filter((o) => o.title === t)
    .map((o) => o.startKey), title);

  sec('setup');
  ok(`swept ${await sweep()} leftover test event(s)`);
  await page.click('.seg button:text-is("アジェンダ")');
  await page.waitForSelector('.agenda', { timeout: 5000 });
  ok('view = agenda');

  const openRow = async (t, nth = 0) => {
    const row = page.locator('.ev', { hasText: t }).nth(nth);
    await row.scrollIntoViewIfNeeded();
    await row.click();
    await page.waitForSelector('.d-card', { timeout: 5000 });
  };
  const fillWhen = async (key) => {
    await page.fill('.f-row:has(> .f-k:text-is("開始")) .f-date', key);
    await page.fill('.f-row:has(> .f-k:text-is("開始")) .f-time', '10:00');
  };

  // --- 1. create a weekly series through the form ---------------------------
  sec('create — a weekly series through the repeat control');
  await page.click('.new-btn');
  await page.waitForSelector('.form', { timeout: 5000 });
  await page.fill('.f-title', 'RC-weekly');
  await fillWhen(D1);
  await page.fill('.f-text', 'もとの場所');
  await page.fill('.f-note', 'もとのメモ');

  check(await page.isHidden('.f-byday'), '曜日 chips are hidden while it does not repeat');
  check(await page.isHidden('.f-until'), '終了日 is hidden while it does not repeat');
  await page.selectOption('.f-row:has(> .f-k:text-is("繰り返し")) .f-sel', 'WEEKLY');
  await sleep(300);
  check(await page.isVisible('.f-byday'), '曜日 chips appear for 毎週');
  check(await page.isVisible('.f-until'), '終了日 appears once it repeats');
  const onDays = await page.evaluate(() =>
    [...document.querySelectorAll('.f-day.on')].map((n) => n.textContent));
  check(onDays.length === 1 && onDays[0] === '月', `毎週 defaults to the start's own weekday (${onDays})`);

  await page.click('.btn.primary');
  await page.waitForSelector('.form', { state: 'detached', timeout: 15000 });

  let s = await server();
  const master = s.find((e) => e.title === 'RC-weekly');
  check(!!master, 'series created and survives a re-sync');
  check(master?.rec.includes('RRULE:FREQ=WEEKLY;BYDAY=MO'),
    `server stored the rule (${JSON.stringify(master?.rec)})`);
  let d = await dates('RC-weekly');
  check(d.length >= 8 && d[0] === D1 && d[1] === D2,
    `expands weekly from ${D1} (${d.slice(0, 3).join(', ')} … ${d.length} total)`);

  // --- 2. edit just one occurrence ------------------------------------------
  sec('edit — この予定だけ (POST parent_id + PUT EXDATE)');
  await openRow('RC-weekly', 1);              // the 8/10 occurrence
  await page.click('.d-acts .btn:text-is("編集")');
  await page.waitForSelector('.confirm', { timeout: 5000 });
  const scopes = await page.evaluate(() =>
    [...document.querySelectorAll('.cf-opt-t')].map((n) => n.textContent));
  check(scopes.length === 3 && scopes[0].includes('この予定だけ'),
    `three scopes offered (${scopes.join(' / ')})`);
  await page.click('.cf-opt:has(.cf-opt-t:text-is("この予定だけを編集"))');
  await page.waitForSelector('.form', { timeout: 5000 });

  check((await page.inputValue('.f-row:has(> .f-k:text-is("開始")) .f-date')) === D2,
    `the form opens on the occurrence clicked (${D2}), not the master's first date`);
  check(await page.isHidden('.f-row:has(> .f-k:text-is("繰り返し"))'),
    'a single-occurrence edit offers no repeat control — it cannot repeat');
  await page.fill('.f-title', 'RC-only-this');
  await page.click('.btn.primary');
  await page.waitForSelector('.form', { state: 'detached', timeout: 20000 });

  s = await server();
  const child = s.find((e) => e.title === 'RC-only-this');
  const m2 = s.find((e) => e.title === 'RC-weekly');
  check(!!child, 'the replacement occurrence exists on the server');
  // The one thing that could not be guessed: we send parent_id, the server
  // answers with recurring_uuid as well.
  check(child?.parent_id === master.uuid, 'child.parent_id points at the master');
  check(child?.recurring_uuid === master.uuid,
    'server derived recurring_uuid from parent_id — the link the reader uses');
  check(child?.rec.length === 0, 'child carries no rule of its own');
  check(child?.note === 'もとのメモ' && child?.location === 'もとの場所',
    'the untouched fields came along');
  check(m2?.rec.some((l) => l.startsWith('EXDATE:')),
    `master gained an EXDATE (${JSON.stringify(m2?.rec)})`);
  d = await dates('RC-weekly');
  check(!d.includes(D2), `the original ${D2} occurrence is gone from the series`);
  check(d.includes(D1) && d.includes(D3), 'the回 either side are untouched');
  check((await dates('RC-only-this')).join() === D2, `the replacement renders on ${D2}`);

  // --- 3. delete just one occurrence ----------------------------------------
  sec('delete — この予定だけ (PUT EXDATE)');
  await openRow('RC-weekly', 1);              // now 8/17
  await page.click('.d-acts .btn.danger');
  await page.waitForSelector('.confirm', { timeout: 5000 });
  await page.click('.cf-opt:has(.cf-opt-t:text-is("この予定だけを削除"))');
  await page.waitForSelector('.confirm', { timeout: 5000 });
  check((await page.textContent('.cf-b')).includes('8月17日'), 'the confirm names the回 being removed');
  await page.click('.confirm .btn.danger');
  await sleep(2500);

  s = await server();
  const m3 = s.find((e) => e.title === 'RC-weekly');
  check(m3?.rec.filter((l) => l.startsWith('EXDATE:')).length === 2,
    `master now has two EXDATEs (${JSON.stringify(m3?.rec)})`);
  check(!!m3, 'the series itself still exists — a single回 is not a DELETE');
  d = await dates('RC-weekly');
  check(!d.includes(D3), `${D3} no longer renders`);
  check(d.includes(D1), `${D1} still renders`);

  // --- 4. edit this and later -----------------------------------------------
  sec('edit — これ以降 (POST copy + PUT UNTIL)');
  const D4 = d.find((k) => k > D3);
  await openRow('RC-weekly', 1);              // the first回 after the two holes
  await page.click('.d-acts .btn:text-is("編集")');
  await page.waitForSelector('.confirm', { timeout: 5000 });
  await page.click('.cf-opt:has(.cf-opt-t:text-is("これ以降の予定を編集"))');
  await page.waitForSelector('.form', { timeout: 5000 });
  check((await page.inputValue('.f-row:has(> .f-k:text-is("開始")) .f-date')) === D4,
    `the split form opens on ${D4}`);
  await page.fill('.f-title', 'RC-future');
  await page.click('.btn.primary');
  await page.waitForSelector('.form', { state: 'detached', timeout: 20000 });

  s = await server();
  const oldM = s.find((e) => e.title === 'RC-weekly');
  const newM = s.find((e) => e.title === 'RC-future');
  check(!!newM, 'a new series exists from the split point');
  check(newM?.rec.some((l) => /RRULE:FREQ=WEEKLY/.test(l)), 'it carries the same rule');
  check(newM?.parent_id === null && newM?.recurring_uuid === null,
    'the two series are independent — matching TimeTree, which does not link them');
  const until = (oldM?.rec.find((l) => l.startsWith('RRULE:')) || '').match(/UNTIL=(\d+)/)?.[1];
  check(!!until, `the old series was truncated with UNTIL (${until})`);
  // The last kept回 is D1: the two after it were EXDATE'd out, so "the
  // occurrence before the split" is not "the split minus one week".
  check(until === D1.replace(/-/g, ''),
    `UNTIL names the last KEPT occurrence ${D1}, not simply a week before the split`);
  const oldDates = await dates('RC-weekly');
  check(oldDates.join() === D1, `the old series is now exactly [${D1}] (got [${oldDates.join()}])`);
  const newDates = await dates('RC-future');
  check(newDates[0] === D4 && newDates.length > 1, `the new series runs from ${D4} (${newDates.length}回)`);

  // --- 5. delete this and later ---------------------------------------------
  sec('delete — これ以降 (PUT UNTIL)');
  const cut = newDates[2];
  await openRow('RC-future', 2);
  await page.click('.d-acts .btn.danger');
  await page.waitForSelector('.confirm', { timeout: 5000 });
  await page.click('.cf-opt:has(.cf-opt-t:text-is("これ以降の予定を削除"))');
  await page.waitForSelector('.confirm', { timeout: 5000 });
  await page.click('.confirm .btn.danger');
  await sleep(2500);

  const after = await dates('RC-future');
  check(after.length === 2 && !after.includes(cut),
    `the series stops before ${cut} (now ${after.join(', ')})`);
  s = await server();
  check(!!s.find((e) => e.title === 'RC-future'), 'truncating is not a DELETE — the series remains');

  // --- 6. edit all -----------------------------------------------------------
  sec('edit — すべて (plain PUT on the master)');
  await openRow('RC-future', 0);
  await page.click('.d-acts .btn:text-is("編集")');
  await page.waitForSelector('.confirm', { timeout: 5000 });
  await page.click('.cf-opt:has(.cf-opt-t:text-is("すべての予定を編集"))');
  await page.waitForSelector('.form', { timeout: 5000 });
  check((await page.inputValue('.f-row:has(> .f-k:text-is("開始")) .f-date')) === D4,
    `editing the whole series shows the MASTER's date (${D4}) — showing the clicked回 would move the series`);
  const beforeRec = (await server()).find((e) => e.title === 'RC-future').rec;
  await page.fill('.f-title', 'RC-all');
  await page.click('.btn.primary');
  await page.waitForSelector('.form', { state: 'detached', timeout: 20000 });

  s = await server();
  const allM = s.find((e) => e.title === 'RC-all');
  check(!!allM, 'the whole series was renamed');
  check(JSON.stringify(allM?.rec) === JSON.stringify(beforeRec),
    'a title-only edit left the rule and its UNTIL exactly as they were');
  check(allM?.note === 'もとのメモ', 'and the note survived');

  // --- 7. delete all ---------------------------------------------------------
  sec('delete — すべて (DELETE)');
  await openRow('RC-all', 0);
  await page.click('.d-acts .btn.danger');
  await page.waitForSelector('.confirm', { timeout: 5000 });
  await page.click('.cf-opt:has(.cf-opt-t:text-is("すべての予定を削除"))');
  await page.waitForSelector('.confirm', { timeout: 5000 });
  await page.click('.confirm .btn.danger');
  await sleep(2500);
  check((await dates('RC-all')).length === 0, 'every回 left the grid at once');
  s = await server();
  check(!s.find((e) => e.title === 'RC-all'), 'and the master is deactivated server-side');

  sec('cleanup');
  ok(`swept ${await sweep()} remaining test event(s)`);
  await resync();
  const left = await page.evaluate((cal) => (TTX.store.state.events.get(cal) || [])
    .filter((e) => /^RC-/.test(e.title || '') && !e.deactivated_at).length, CAL);
  check(left === 0, `nothing left behind in "${EXPECT_CALENDAR}"`);

  console.log(`\n${fail ? '\x1b[31m' : '\x1b[32m'}${pass} passed, ${fail} failed\x1b[0m`);
  await browser.close();
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error('\n\x1b[31mVERIFY THREW\x1b[0m:', e.message);
  process.exit(1);
});
