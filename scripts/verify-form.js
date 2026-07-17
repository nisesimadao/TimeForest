#!/usr/bin/env node
/* End-to-end verification of the create / edit / delete UI, driven through the
 * real app over CDP against the real TimeTree API.
 *
 * This is deliberately not a "prints green" test. Every claim is read back from
 * something that could actually disagree: the rendered DOM, or a full re-sync
 * from the server. Writing 14:00 JST and asserting the stored instant is
 * 05:00Z is the whole point — a mocked API would have happily agreed with a
 * broken conversion.
 *
 * Usage:
 *   1. cd client && npm run inspect      # boots with --remote-debugging-port=9333
 *   2. npm i playwright-core             # not a project dep: CI stays dependency-free
 *   3. npm run verify:form
 *
 * SAFETY — the reason this file leads with a guard:
 * It refuses to run unless every enabled calendar is the throwaway account's
 * `dowa`. Writing to a shared calendar notifies its members; that is an
 * outward, irreversible act, and no test is worth sending a push notification
 * to someone's family. The guard is load-bearing, not ceremony — verified by
 * renaming a calendar to 家族 in a live session and watching this abort.
 */
let chromium;
try {
  ({ chromium } = require('playwright-core'));
} catch {
  console.error('playwright-core is not installed.\n' +
    'It is intentionally not a project dependency — scripts/check.js and CI run\n' +
    'with zero installs. For this script only:  npm i playwright-core');
  process.exit(1);
}

const CDP = 'http://127.0.0.1:9333';
const EXPECT_CALENDAR = 'dowa';
const DATE = '2026-07-20';

let pass = 0, fail = 0;
const ok = (m) => { pass++; console.log('  \x1b[32m✓\x1b[0m ' + m); };
const bad = (m) => { fail++; console.log('  \x1b[31m✗\x1b[0m ' + m); };
const sec = (t) => console.log('\n' + t);
const check = (cond, m) => (cond ? ok(m) : bad(m));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const browser = await chromium.connectOverCDP(CDP).catch(() => {
    console.error(`Nothing is listening on ${CDP}.\nStart the client first:  cd client && npm run inspect`);
    process.exit(1);
  });
  const ctx = browser.contexts()[0];
  const page = ctx.pages().find((p) => p.url().includes('index.html'));
  if (!page) {
    for (const p of ctx.pages()) console.log('page:', p.url());
    throw new Error('renderer page not found');
  }
  page.on('console', (m) => { if (m.type() === 'error') console.log('   [console] ' + m.text()); });
  page.on('pageerror', (e) => console.log('   [pageerror] ' + e.message));

  // Wait for the sync to finish before touching anything.
  await page.waitForFunction(() => globalThis.TTX?.store?.state?.ready === true, { timeout: 90000 });

  // --- 0. safety guard ------------------------------------------------------
  sec('safety guard');
  const info = await page.evaluate(() => ({
    calendars: TTX.store.state.calendars.map((c) => ({ id: c.id, name: c.name })),
    enabled: [...TTX.store.state.enabled],
    total: TTX.store.totalEvents(),
  }));
  console.log('  calendars: ' + JSON.stringify(info.calendars));
  const writable = info.calendars.filter((c) => info.enabled.includes(c.id));
  if (!writable.length || !writable.every((c) => c.name === EXPECT_CALENDAR)) {
    console.error(`\n\x1b[31mABORT\x1b[0m: expected only "${EXPECT_CALENDAR}", got ` +
      JSON.stringify(writable.map((c) => c.name)) +
      '\nRefusing to write. Switch to the throwaway account first.');
    process.exit(2);
  }
  ok(`only "${EXPECT_CALENDAR}" is writable (${info.total} events cached)`);
  const calId = writable[0].id;

  // --- 0b. control our own preconditions ------------------------------------
  // The app restores the last view from prefs; the first run of this script
  // silently asserted agenda selectors against a week grid. Set the view here
  // rather than inheriting whatever the last human session left behind.
  sec('setup');
  // A previous run may have died with a sheet up. Dismiss it the way a person
  // would — the app tracks what's open, so reaching in and deleting the DOM
  // leaves it believing a form is still there and refusing to open another.
  for (let i = 0; i < 6 && await page.$('.scrim, .d-scrim'); i++) {
    // Escape needs focus inside the sheet, and a sheet left over from another
    // session may not have it — so click the way out when there is one.
    const cancel = await page.$('.mp-card .btn:not(.primary), .confirm .btn.danger, .f-foot .btn:not(.primary)');
    if (cancel) { await cancel.click().catch(() => {}); await sleep(300); continue; }
    await page.keyboard.press('Escape');
    await sleep(250);
  }
  check(await page.$('.scrim, .d-scrim') === null, 'no dialog left over from a previous run');

  const swept = await page.evaluate(async (cid) => {
    const list = TTX.store.state.events.get(cid) || [];
    const junk = list.filter((e) => (e.title || '').startsWith('TF検証') && !e.deactivated_at);
    for (const e of junk) {
      await TTX.api.deleteEvent(cid, e.uuid);
      TTX.store.markDeleted(cid, e.uuid);
    }
    return junk.map((e) => e.title);
  }, calId);
  ok(`swept ${swept.length} leftover test event(s)` + (swept.length ? ': ' + swept.join(', ') : ''));

  await page.click('.seg button:text-is("アジェンダ")');
  await page.waitForSelector('.agenda', { timeout: 5000 });
  await page.click('.pill:text-is("今日")');
  await sleep(500);
  ok('view = agenda, cursor = today');

  const stamp = Date.now().toString(36).slice(-5);
  const T1 = `TF検証-作成-${stamp}`;
  const T2 = `TF検証-更新-${stamp}`;

  /** Wait for the grid to actually show a title — view transitions are async. */
  const waitRow = (t, present = true) => page.waitForFunction(
    ([title, want]) => ([...document.querySelectorAll('.ev .ti')]
      .some((n) => n.textContent.includes(title)) === want),
    [t, present], { timeout: 8000 });

  /** Click a row the way a person does: on screen. A raw .click() through
   *  evaluate() reaches rows scrolled past the fold, which no user can do —
   *  and then measures a popover anchored off-screen. */
  const openRow = async (t) => {
    const row = page.locator('.ev', { hasText: t }).first();
    await row.scrollIntoViewIfNeeded();
    await row.click();
    await page.waitForSelector('.d-card', { timeout: 5000 });
  };

  const findRaw = (t) => page.evaluate((title) => {
    const list = TTX.store.state.events.get([...TTX.store.state.enabled][0]) || [];
    const e = list.find((x) => x.title === title);
    return e ? {
      uuid: e.uuid, title: e.title, all_day: e.all_day, start_at: e.start_at,
      end_at: e.end_at, start_timezone: e.start_timezone, end_timezone: e.end_timezone,
      location: e.location, note: e.note, label_id: e.label_id,
      alerts: e.alerts ?? null, attendees: e.attendees ?? null,
      url: e.url ?? null, attachment: e.attachment ?? null,
      deactivated_at: e.deactivated_at ?? null, category: e.category,
    } : null;
  }, t);

  // --- 1. create ------------------------------------------------------------
  sec('create — through the toolbar button');
  await page.click('.new-btn');
  await page.waitForSelector('.form', { timeout: 5000 });
  ok('form opened');

  check(await page.evaluate(() => document.activeElement?.className === 'f-title'),
    'title field is focused the moment the sheet exists');

  await page.fill('.f-title', T1);
  await page.fill('.f-row:has(> .f-k:text-is("開始")) .f-date', DATE);
  await page.fill('.f-row:has(> .f-k:text-is("開始")) .f-time', '14:00');

  // The end should have tracked the start and kept the 1h default duration.
  const afterStart = await page.evaluate(() => ({
    endDate: document.querySelectorAll('.f-date')[1].value,
    endTime: document.querySelectorAll('.f-time')[1].value,
  }));
  check(afterStart.endDate === DATE && afterStart.endTime === '15:00',
    `end followed start keeping duration (${afterStart.endDate} ${afterStart.endTime})`);

  await page.fill('.f-text', '検証室A');
  await page.fill('.f-note', '一行目\n二行目');
  await page.click('.btn.primary');
  await page.waitForSelector('.form', { state: 'detached', timeout: 15000 });
  ok('form closed after save');

  let raw = await findRaw(T1);
  check(!!raw, 'created event is in the store');
  if (!raw) { console.error('cannot continue'); process.exit(1); }

  // 14:00 JST on 2026-07-20 == 05:00Z. This is the conversion that silently
  // ruins everything if it's wrong, so assert the actual instant.
  const want = Date.UTC(2026, 6, 20, 5, 0);
  check(raw.start_at === want, `start_at is 14:00 JST = ${new Date(want).toISOString()} (got ${new Date(raw.start_at).toISOString()})`);
  check(raw.end_at === want + 3600000, 'end_at is +1h');
  check(raw.start_timezone === 'Asia/Tokyo', `start_timezone = ${raw.start_timezone}`);
  check(raw.all_day === false, 'all_day = false');
  check(raw.location === '検証室A', `location round-tripped (${raw.location})`);
  check(raw.note === '一行目\n二行目', 'multi-line note round-tripped');
  check(raw.category === 1, `category = 1 (not a Keep item), got ${raw.category}`);

  let shown = true;
  await waitRow(T1).catch(() => { shown = false; });
  check(shown, 'event is rendered in the agenda without a resync');

  // --- 2. edit --------------------------------------------------------------
  sec('edit — through the detail popover');
  await openRow(T1);
  ok('detail popover opened');
  check(await page.locator('.d-acts .btn', { hasText: '編集' }).count() === 1, 'detail offers 編集');
  check(await page.locator('.d-acts .btn.danger').count() === 1, 'detail offers 削除');

  // The actions are the whole point of the popover now — they must be reachable.
  const fits = await page.evaluate(() => {
    const c = document.querySelector('.d-card').getBoundingClientRect();
    const a = document.querySelector('.d-acts').getBoundingClientRect();
    return {
      card: c.top >= 0 && c.bottom <= innerHeight && c.left >= 0 && c.right <= innerWidth,
      acts: a.top >= 0 && a.bottom <= innerHeight,
    };
  });
  check(fits.card, 'popover is fully inside the window');
  check(fits.acts, '編集/削除 are on screen, not clipped past the bottom edge');

  await page.click('.d-acts .btn:text-is("編集")');
  await page.waitForSelector('.form', { timeout: 5000 });

  const loaded = await page.evaluate(() => ({
    title: document.querySelector('.f-title').value,
    date: document.querySelectorAll('.f-date')[0].value,
    time: document.querySelectorAll('.f-time')[0].value,
    loc: document.querySelector('.f-text').value,
    note: document.querySelector('.f-note').value,
  }));
  check(loaded.title === T1, 'form loaded the existing title');
  check(loaded.date === DATE && loaded.time === '14:00', `form loaded the existing when (${loaded.date} ${loaded.time})`);
  check(loaded.loc === '検証室A', 'form loaded the existing location');
  check(loaded.note === '一行目\n二行目', 'form loaded the existing note');

  await page.fill('.f-title', T2);
  await page.click('.btn.primary');
  await page.waitForSelector('.form', { state: 'detached', timeout: 15000 });
  await waitRow(T2).catch(() => {});

  raw = await findRaw(T2);
  check(!!raw, 'edited title is in the store');
  // The whole reason PUT is a patch: untouched fields must survive.
  check(raw && raw.location === '検証室A', 'location survived a title-only PUT');
  check(raw && raw.note === '一行目\n二行目', 'note survived a title-only PUT');
  check(raw && raw.start_at === want, 'start_at survived a title-only PUT');

  // --- 3. does the server actually agree? -----------------------------------
  sec('re-sync — proving it landed server-side, not just locally');
  await page.evaluate(() => TTX.store.syncAll());
  raw = await findRaw(T2);
  check(!!raw, 'event is still there after a full re-sync from the server');
  check(raw && raw.location === '検証室A', 'server has the location');
  check(raw && raw.note === '一行目\n二行目', 'server has the note');
  check(raw && raw.start_at === want, 'server has the right instant');
  const uuid = raw?.uuid;

  // --- 4. all-day ------------------------------------------------------------
  sec('all-day — the UTC-midnight + inclusive-end convention');
  const T3 = `TF検証-終日-${stamp}`;
  await page.click('.new-btn');
  await page.waitForSelector('.form', { timeout: 5000 });
  await page.fill('.f-title', T3);
  await page.click('.sw');
  check(await page.evaluate(() => getComputedStyle(document.querySelector('.f-time')).display === 'none'),
    'time fields disappear when all-day is on');
  await page.fill('.f-row:has(> .f-k:text-is("開始")) .f-date', DATE);
  await page.fill('.f-row:has(> .f-k:text-is("終了")) .f-date', '2026-07-22');
  check((await page.textContent('.f-span')) === '3日間', 'span reads 3日間 for 7/20–7/22 inclusive');
  check((await page.textContent('.btn.primary')).includes('Ctrl ↵'),
    'save advertises the modifier this keyboard actually has');
  // Save with the shortcut the button advertises — an advertised shortcut that
  // does nothing is worse than never having offered it.
  await page.keyboard.press('Control+Enter');
  await page.waitForSelector('.form', { state: 'detached', timeout: 15000 });
  ok('Ctrl+Enter saved the form');

  await waitRow(T3).catch(() => {});
  const ad = await findRaw(T3);
  check(!!ad, 'all-day event created');
  check(ad && ad.all_day === true, 'all_day = true');
  check(ad && ad.start_timezone === 'UTC' && ad.end_timezone === 'UTC', 'timezones are UTC');
  check(ad && ad.start_at === Date.UTC(2026, 6, 20), 'start_at is UTC midnight of 7/20');
  check(ad && ad.end_at === Date.UTC(2026, 6, 22), 'end_at is UTC midnight of 7/22 (inclusive)');
  const spans = await page.evaluate((t) => {
    const occ = TTX.store.occurrences('2026-07-01', '2026-07-31').filter((o) => o.title === t);
    return occ.length ? occ[0].days.length : 0;
  }, T3);
  check(spans === 3, `renders across 3 days (got ${spans})`);

  // --- 5. validation --------------------------------------------------------
  sec('validation');
  await page.click('.new-btn');
  await page.waitForSelector('.form', { timeout: 5000 });
  check(await page.evaluate(() => document.querySelector('.btn.primary').disabled),
    'save is disabled with an empty title');
  await page.fill('.f-title', 'x');
  await page.fill('.f-row:has(> .f-k:text-is("終了")) .f-date', '2020-01-01');
  check(await page.evaluate(() => document.querySelector('.btn.primary').disabled),
    'save is disabled when end precedes start');
  check((await page.textContent('.f-err')) === '終了が開始より前です', 'the reason is shown, not just refused');

  // This form has typing in it, so Escape must not silently bin it.
  await page.keyboard.press('Escape');
  await page.waitForSelector('.confirm', { timeout: 5000 });
  ok('Escape on a filled form asks before discarding');
  await page.click('.confirm .btn:text-is("キャンセル")');
  await page.waitForSelector('.confirm', { state: 'detached', timeout: 5000 });
  check(await page.$('.form') !== null, 'declining the discard keeps the form and its input');
  check((await page.inputValue('.f-title')) === 'x', 'the typed title is still there');
  await page.keyboard.press('Escape');
  await page.waitForSelector('.confirm', { timeout: 5000 });
  await page.click('.confirm .btn.danger');
  await page.waitForSelector('.form', { state: 'detached', timeout: 5000 });
  ok('confirming the discard closes the form');

  // An untouched form is not worth a dialog.
  await page.click('.new-btn');
  await page.waitForSelector('.form', { timeout: 5000 });
  await page.keyboard.press('Escape');
  await page.waitForSelector('.form', { state: 'detached', timeout: 5000 });
  check(await page.$('.confirm') === null, 'Escape on an untouched form closes it without nagging');

  // --- 6. delete ------------------------------------------------------------
  sec('delete');
  for (const t of [T2, T3]) {
    await openRow(t);
    await page.click('.d-acts .btn.danger');
    await page.waitForSelector('.confirm', { timeout: 5000 });
    check((await page.textContent('.cf-b')).includes(t), `confirm names "${t}"`);
    await page.click('.confirm .btn.danger');
    await page.waitForSelector('.confirm', { state: 'detached', timeout: 15000 });
    let gone = true;
    await waitRow(t, false).catch(() => { gone = false; });
    check(gone, `"${t}" left the grid immediately`);
  }

  sec('re-sync — proving the delete landed server-side');
  await page.evaluate(() => TTX.store.syncAll());
  for (const t of [T2, T3]) {
    const after = await findRaw(t);
    // DELETE is a soft delete: the row stays and gains deactivated_at.
    check(after === null || after.deactivated_at != null,
      `"${t}" is deactivated server-side (${after ? 'deactivated_at set' : 'row gone'})`);
  }
  const visible = await page.evaluate((ts) => {
    const occ = TTX.store.occurrences('2026-07-01', '2026-07-31');
    return ts.filter((t) => occ.some((o) => o.title === t));
  }, [T2, T3]);
  check(visible.length === 0, 'neither deleted event renders after a re-sync');

  // --- 6b. reminders and attendees ------------------------------------------
  // These are the fields TimeTree's own apps act on: a reminder becomes a real
  // push to the user's phone, an attendee becomes the avatar shown there. The
  // all-day encoding is not guessable — it was measured off the real client —
  // so assert the exact stored numbers rather than "something non-empty".
  sec('reminders and attendees');
  const T4 = `TF検証-通知-${stamp}`;
  const T5 = `TF検証-終日通知-${stamp}`;
  const alertRow = '.f-row:has(> .f-k:text-is("通知")) .f-sel';
  const chipText = () => page.evaluate(() =>
    [...document.querySelectorAll('.f-chip')].map((n) => n.textContent.replace('✕', '')).join(', '));

  await page.click('.new-btn');
  await page.waitForSelector('.form', { timeout: 5000 });
  await page.fill('.f-title', T4);
  await page.fill('.f-row:has(> .f-k:text-is("開始")) .f-date', DATE);
  await page.fill('.f-row:has(> .f-k:text-is("開始")) .f-time', '14:00');

  check(await page.isVisible('.f-row:has(> .f-k:text-is("参加者"))'),
    'the form offers 参加者 even on a one-member calendar — TimeTree assigns there too');
  check(await page.evaluate(() => document.querySelectorAll('.f-mem.on').length) === 1,
    'you are assigned by default, matching what TimeTree\'s own form does');

  await page.selectOption(alertRow, '30');
  await page.selectOption(alertRow, '60');
  check((await chipText()) === '30分前, 1時間前',
    `reminders read the way TimeTree words them (${await chipText()})`);

  // Flipping all-day changes what "before" is measured from.
  await page.click('.sw');
  await sleep(300);
  check((await chipText()) === '1日前',
    `all-day carries the intent across instead of dropping it (${await chipText()})`);
  await page.click('.sw');
  await sleep(300);

  await page.selectOption(alertRow, '0');
  await page.click('.btn.primary');
  await page.waitForSelector('.form', { state: 'detached', timeout: 15000 });

  const al = await findRaw(T4);
  check(!!al, 'created with reminders');
  check(JSON.stringify(al?.alerts) === '[0,1440]',
    `timed reminders stored as minutes-before (${JSON.stringify(al?.alerts)})`);
  check(al?.attendees?.length === 1, `attendee stored (${JSON.stringify(al?.attendees)})`);

  // All-day has its own ladder: 900 == 1日前 == 09:00 the day before, and each
  // further day adds 1440. Measured against the real client in both directions.
  await page.click('.new-btn');
  await page.waitForSelector('.form', { timeout: 5000 });
  await page.fill('.f-title', T5);
  await page.click('.sw');
  await page.fill('.f-row:has(> .f-k:text-is("開始")) .f-date', DATE);
  await page.selectOption(alertRow, '900');
  await page.selectOption(alertRow, '2340');
  check((await chipText()) === '1日前, 2日前', `all-day ladder is worded in days (${await chipText()})`);
  await page.click('.btn.primary');
  await page.waitForSelector('.form', { state: 'detached', timeout: 15000 });
  check(JSON.stringify((await findRaw(T5))?.alerts) === '[900,2340]',
    `all-day 1日前/2日前 store as 900/2340 (${JSON.stringify((await findRaw(T5))?.alerts)})`);

  sec('re-sync — the reminders really reached the server');
  await page.evaluate(() => TTX.store.syncAll());
  check(JSON.stringify((await findRaw(T4))?.alerts) === '[0,1440]', 'server kept the timed reminders');
  check(JSON.stringify((await findRaw(T5))?.alerts) === '[900,2340]', 'server kept the all-day reminders');
  check((await findRaw(T4))?.attendees?.length === 1, 'server kept the attendee');

  await openRow(T4);
  // The popover is icon + value now, with no key column — "🕐 日時 7月21日"
  // said 日時 twice to an audience that can read a date. So look for the value
  // itself rather than a label that no longer exists.
  const shownAlerts = await page.evaluate(() =>
    [...document.querySelectorAll('.d-row .d-v')].map((n) => n.textContent));
  check(shownAlerts.includes('開始時、1日前'),
    `the detail popover reports them (${JSON.stringify(shownAlerts)})`);
  await page.keyboard.press('Escape');

  for (const t of [T4, T5]) {
    await openRow(t);
    await page.click('.d-acts .btn.danger');
    await page.waitForSelector('.confirm', { timeout: 5000 });
    await page.click('.confirm .btn.danger');
    await page.waitForSelector('.confirm', { state: 'detached', timeout: 15000 });
    await waitRow(t, false).catch(() => {});
  }
  ok('reminder test events cleaned up');

  // --- 6c. url and checklist ------------------------------------------------
  // Both live inside `attachment`, which a PUT replaces wholesale — so the
  // interesting assertion is not that they save, but that saving one does not
  // erase the other, or anything else in there.
  sec('URL and checklist');
  const T6 = `TF検証-リスト-${stamp}`;
  await page.click('.new-btn');
  await page.waitForSelector('.form', { timeout: 5000 });
  await page.fill('.f-title', T6);
  await page.fill('.f-row:has(> .f-k:text-is("開始")) .f-date', DATE);
  await page.fill('.f-row:has(> .f-k:text-is("URL")) .f-text', 'https://example.com/list');

  await page.click('.f-cl-add');
  await page.keyboard.type('牛乳');
  // Enter must add a row, not save the form.
  await page.keyboard.press('Enter');
  await page.keyboard.type('卵');
  check(await page.$('.form') !== null, 'Enter inside the list adds a row instead of saving');
  check(await page.evaluate(() => document.querySelectorAll('.f-cl-i').length) === 2,
    'two items after Enter');
  await page.evaluate(() => document.querySelectorAll('.f-cl-c')[1].click());
  await page.click('.btn.primary');
  await page.waitForSelector('.form', { state: 'detached', timeout: 15000 });

  // Compare structurally: the server echoes our key order on create and its
  // own after a re-sync, so a JSON string compare would fail on nothing.
  const clShape = (r) => (r?.attachment?.checklist || [])
    .map((i) => `${i.title}:${i.checked}`).join(', ');

  let cl = await findRaw(T6);
  check(clShape(cl) === '牛乳:false, 卵:true',
    `checklist stored in array order with its checks (${clShape(cl)})`);
  check(cl?.url === 'https://example.com/list',
    `url is written into attachment but read back at the top level (${cl?.url})`);
  check(Array.isArray(cl?.attachment?.virtual_user_attendees),
    'virtual_user_attendees survived — the key we never model');

  sec('re-sync — the attachment really reached the server');
  await page.evaluate(() => TTX.store.syncAll());
  cl = await findRaw(T6);
  check(cl?.attachment?.checklist?.length === 2, 'server kept the checklist');
  check(cl?.url === 'https://example.com/list', 'server kept the url');

  // Now edit ONLY the title: the attachment must not be collateral damage.
  await openRow(T6);
  await page.click('.d-acts .btn:text-is("編集")');
  await page.waitForSelector('.form', { timeout: 5000 });
  check((await page.inputValue('.f-row:has(> .f-k:text-is("URL")) .f-text')) === 'https://example.com/list',
    'the form loads the existing url');
  check(await page.evaluate(() => document.querySelectorAll('.f-cl-i').length) === 2,
    'the form loads the existing list');
  check(await page.evaluate(() => document.querySelectorAll('.f-cl-c.on').length) === 1,
    'and which item was ticked');
  const T7 = `${T6}-改`;
  await page.fill('.f-title', T7);
  await page.click('.btn.primary');
  await page.waitForSelector('.form', { state: 'detached', timeout: 15000 });
  await page.evaluate(() => TTX.store.syncAll());
  cl = await findRaw(T7);
  check(cl?.attachment?.checklist?.length === 2, 'a title-only edit left the checklist alone');
  check(cl?.url === 'https://example.com/list', 'and the url');

  await openRow(T7);
  check(await page.evaluate(() => document.querySelectorAll('.d-cl-i').length) === 2,
    'the detail popover lists the items');
  await page.click('.d-acts .btn.danger');
  await page.waitForSelector('.confirm', { timeout: 5000 });
  await page.click('.confirm .btn.danger');
  await page.waitForSelector('.confirm', { state: 'detached', timeout: 15000 });
  await waitRow(T7, false).catch(() => {});
  ok('checklist test event cleaned up');

  // --- 7. entry points ------------------------------------------------------
  // Each of these opens the same form; what matters is that it arrives
  // pre-filled with the date/time the click actually meant. Read the prefill
  // and cancel — no writes needed to prove the wiring.
  sec('entry points — every one pre-fills from what was clicked');

  const formPrefill = async () => {
    await page.waitForSelector('.form', { timeout: 5000 });
    const v = await page.evaluate(() => ({
      date: document.querySelectorAll('.f-date')[0].value,
      time: document.querySelectorAll('.f-time')[0].value,
      allDay: document.querySelector('.sw').classList.contains('on'),
    }));
    await page.keyboard.press('Escape');
    await page.waitForSelector('.form', { state: 'detached', timeout: 5000 });
    return v;
  };

  // agenda: a run of empty days. With 空いている日を隠す on (the default) the
  // per-day "＋ 予定を追加" is gone and the collapsed row is the affordance;
  // with it off, the per-day one is back. Check whichever is on screen.
  const emptyKey = await page.evaluate(() => {
    const gap = document.querySelector('.ag-gap');
    if (gap) {
      // "7/1 – 7/6 予定なし（6日）" — creating should land on the first day.
      const m = gap.textContent.match(/(\d+)\/(\d+)/);
      let h = gap.previousElementSibling;
      while (h && !h.classList.contains('ag-month')) h = h.previousElementSibling;
      const y = h.textContent.match(/(\d+)年/)[1];
      gap.click();
      return `${y}-${String(+m[1]).padStart(2, '0')}-${String(+m[2]).padStart(2, '0')}`;
    }
    const d = [...document.querySelectorAll('.ag-day')].find((n) => n.querySelector('.ag-add'));
    if (!d) return null;
    d.querySelector('.ag-add').click();
    let h = d.previousElementSibling;
    while (h && !h.classList.contains('ag-month')) h = h.previousElementSibling;
    const m = h.textContent.match(/(\d+)年\s*(\d+)月/);
    const day = d.querySelector('.ag-date .d').textContent;
    return `${m[1]}-${String(+m[2]).padStart(2, '0')}-${String(+day).padStart(2, '0')}`;
  });
  if (emptyKey) {
    const v = await formPrefill();
    check(v.date === emptyKey, `agenda empty day → form opens on ${emptyKey} (got ${v.date})`);
  } else {
    ok('agenda empty day — skipped, no empty day on screen');
  }

  // keyboard: N
  await page.keyboard.press('n');
  const vn = await formPrefill();
  const todayK = await page.evaluate(() => TTX.tz.ymd(Date.now(), 'Asia/Tokyo'));
  check(vn.date === todayK, `N key → form opens on today ${todayK} (got ${vn.date})`);

  // month: a cell
  await page.click('.seg button:text-is("月")');
  await page.waitForSelector('.m-grid', { timeout: 5000 });
  const monthKey = await page.evaluate(() => {
    const cells = [...document.querySelectorAll('.m-cell:not(.outside)')];
    const c = cells[14];
    c.click();
    const n = c.querySelector('.m-num').textContent;
    const cur = document.querySelector('.tb-title').textContent.match(/(\d+)年\s*(\d+)月/);
    return `${cur[1]}-${String(+cur[2]).padStart(2, '0')}-${String(+n).padStart(2, '0')}`;
  });
  const vm = await formPrefill();
  check(vm.date === monthKey, `month cell → form opens on ${monthKey} (got ${vm.date})`);

  // week: an empty slot at a known height, and the all-day strip
  await page.click('.seg button:text-is("週")');
  await page.waitForSelector('.w-grid', { timeout: 5000 });
  const slot = await page.evaluate(() => {
    const col = document.querySelectorAll('.w-col')[3];
    const r = col.getBoundingClientRect();
    // HOUR_H is 44px; aim at 10:00 and check it snaps there.
    col.dispatchEvent(new MouseEvent('click', { clientY: r.top + 44 * 10, bubbles: true }));
    return true;
  });
  const vw = await formPrefill();
  check(vw.time === '10:00', `week slot at 10× hour height → 10:00 (got ${vw.time})`);
  check(vw.allDay === false, 'week slot → timed, not all-day');

  const wad = await page.$('.w-ad-cell');
  if (wad) {
    await page.evaluate(() => document.querySelector('.w-ad-cell').click());
    const va = await formPrefill();
    check(va.allDay === true, 'week all-day strip → form opens with all-day on');
  } else {
    ok('week all-day strip — skipped, no banner row this week');
  }

  await page.click('.seg button:text-is("アジェンダ")');

  // --- 7b. the map pin ------------------------------------------------------
  // TimeTree's phone app pins places and its web app ignores them, so this is
  // the one feature here that beats 本家Web rather than matching it. The point
  // is the round trip: a pin dropped here has to come back on the phone.
  sec('map pin — location_lat/lon, which TimeTree Web never writes');

  const mapsWas = await page.evaluate(() => {
    const p = JSON.parse(localStorage.getItem('ttc.prefs') || '{}');
    return !!p.maps;
  });
  // Off by default is a promise, not a default — check it before turning it on.
  const refused = await page.evaluate(async () => {
    await window.host.map.setEnabled(false);
    try { await window.host.map.tile(12, 3637, 1612); return 'FETCHED'; }
    catch (e) { return 'refused'; }
  });
  check(refused === 'refused', 'with maps off, the host refuses to fetch a tile at all');
  await page.evaluate(() => window.host.map.setEnabled(true));

  const T8 = `TF検証-地図-${stamp}`;
  await page.click('.new-btn');
  await page.waitForSelector('.form', { timeout: 5000 });
  await page.fill('.f-title', T8);
  await page.fill('.f-row:has(> .f-k:text-is("開始")) .f-date', DATE);
  check((await page.textContent('.f-pin')) === '地図', 'the location row offers 地図 when nothing is pinned');

  await page.click('.f-pin');
  await page.waitForSelector('.mp-box', { timeout: 8000 });
  ok('picker opened');
  await page.fill('.mp-bar .f-text', '東京駅');
  await page.waitForSelector('.mp-r', { timeout: 10000 });
  await page.click('.mp-r');
  await sleep(1500);
  const drawn = await page.evaluate(() => {
    const t = [...document.querySelectorAll('.mp-t')];
    return { total: t.length, loaded: t.filter((i) => i.src.startsWith('data:')).length };
  });
  check(drawn.total > 0 && drawn.loaded === drawn.total,
    `the map actually drew (${drawn.loaded}/${drawn.total} tiles, all as data: URIs)`);
  check(await page.evaluate(() =>
    ![...document.querySelectorAll('.mp-t')].some((i) => /openstreetmap/.test(i.src))),
  'no third-party URL reached the renderer — the CSP is untouched');

  await page.click('.mp-card .btn.primary');
  await page.waitForSelector('.mp-box', { state: 'detached', timeout: 5000 });
  check((await page.textContent('.f-pin')) === 'ピン済み', 'the form says the place is pinned');
  check((await page.inputValue('.f-row:has(> .f-k:text-is("場所")) .f-text')).includes('東京駅'),
    'and filled the location text from the place name');

  await page.click('.btn.primary');
  await page.waitForSelector('.form', { state: 'detached', timeout: 15000 });

  sec('re-sync — the pin really reached the server');
  await page.evaluate(() => TTX.store.syncAll());
  const pinned = await page.evaluate((t) => {
    const list = TTX.store.state.events.get([...TTX.store.state.enabled][0]) || [];
    const e = list.find((x) => x.title === t);
    return e ? { lat: e.location_lat, lon: e.location_lon, loc: e.location } : null;
  }, T8);
  check(!!pinned, 'the event survived a re-sync');
  // The API answers with strings; the reader has to cope with that.
  check(pinned && Math.abs(Number(pinned.lat) - 35.681) < 0.05
    && Math.abs(Number(pinned.lon) - 139.767) < 0.05,
  `the server stored Tokyo Station's coordinates (${pinned?.lat}, ${pinned?.lon})`);

  const occ = await page.evaluate((t) => {
    const o = TTX.store.occurrences('2026-07-01', '2026-07-31').find((x) => x.title === t);
    return o ? { lat: o.lat, lon: o.lon, isNum: typeof o.lat === 'number' } : null;
  }, T8);
  check(occ?.isNum === true, `the reader turns them back into numbers (${occ?.lat})`);

  await openRow(T8);
  const mapRow = await page.evaluate(() =>
    [...document.querySelectorAll('.d-row.act .d-v')].map((n) => n.textContent));
  check(mapRow.includes('地図で開く'),
    `the detail popover offers to open the pin (${JSON.stringify(mapRow)})`);
  await page.click('.d-acts .btn.danger');
  await page.waitForSelector('.confirm', { timeout: 5000 });
  await page.click('.confirm .btn.danger');
  await page.waitForSelector('.confirm', { state: 'detached', timeout: 15000 });
  await waitRow(T8, false).catch(() => {});
  await page.evaluate((was) => window.host.map.setEnabled(was), mapsWas);
  ok('map test event cleaned up, maps switch restored');

  // --- 7c. multi-day spans in the month grid --------------------------------
  // A three-day trip used to draw as three chips, each with the full title, so
  // it read as three events. "The display disagrees with the facts" is the one
  // thing a calendar must never do, and it's invisible in the data — only the
  // rendered grid can catch it.
  sec('month grid — a span is one bar, not one chip per day');
  const M1 = `TF検証-帰省-${stamp}`;
  const M2 = `TF検証-夏休み-${stamp}`;
  const M3 = `TF検証-出張-${stamp}`;
  const seeded = await page.evaluate(async ([t1, t2, t3]) => {
    const cal = [...TTX.store.state.enabled][0];
    const ids = [];
    const mk = async (title, s, e, label) => {
      const ev = await TTX.api.createEvent(cal, {
        title, allDay: true, startAt: s, endAt: e, tz: 'Asia/Tokyo', labelId: label,
      });
      TTX.store.applyEvent(cal, ev);
      ids.push(ev.uuid);
    };
    await mk(t1, Date.UTC(2026, 6, 25), Date.UTC(2026, 6, 27), 9);   // crosses Sat->Sun
    await mk(t2, Date.UTC(2026, 6, 22), Date.UTC(2026, 7, 2), 3);    // three week rows
    await mk(t3, Date.UTC(2026, 6, 23), Date.UTC(2026, 6, 24), 6);   // shares a lane
    // And a pile of single-day events in the SAME week as those bars. Without
    // these the overflow check below is theatre: with nothing to stack under
    // the lanes, no cap can overfill a cell, and the assertion passes no
    // matter how wrong the cap is. (It did — until this line existed.)
    const cal2 = [...TTX.store.state.enabled][0];
    for (let i = 0; i < 6; i++) {
      const at = Date.UTC(2026, 6, 23, i + 8, 0);
      const ev = await TTX.api.createEvent(cal2, {
        title: `${t3}-${i}`, allDay: false, startAt: at, endAt: at + 1800000,
        tz: 'Asia/Tokyo', labelId: 1,
      });
      TTX.store.applyEvent(cal2, ev);
      ids.push(ev.uuid);
    }
    return ids;
  }, [M1, M2, M3]);

  await page.click('.seg button:text-is("月")');
  await page.waitForSelector('.m-grid', { timeout: 5000 });
  await page.click('.pill:text-is("今日")');
  await sleep(900);

  const grid = await page.evaluate(([t1, t2, t3]) => {
    const bars = [...document.querySelectorAll('.m-bar')].map((n) => ({
      t: n.querySelector('.m-ti').textContent,
      col: n.style.gridColumn,
      lane: n.style.gridRow,
    }));
    return {
      trip: bars.filter((b) => b.t === t1),
      holiday: bars.filter((b) => b.t === t2),
      trip2: bars.filter((b) => b.t === t3),
      // A span must not ALSO appear as a per-day chip.
      chips: [...document.querySelectorAll('.m-ev .m-ti')].map((n) => n.textContent)
        .filter((x) => x === t1 || x === t2 || x === t3),
      status: document.querySelector('.side-status')?.textContent,
    };
  }, [M1, M2, M3]);

  // Columns below are for 月曜始まり — the default, and what TimeTree Web
  // renders. July 2026's grid starts Mon 6/29, so within a week row
  // 月=1 火=2 水=3 木=4 金=5 土=6 日=7.
  //
  // 7/25 is a Saturday and 7/26 a Sunday, so they land in the SAME row (cols
  // 6-7) and only 7/27 spills to the next — the span still draws twice, but at
  // different columns than it did when weeks began on Sunday. These numbers
  // moved when 週の始まり became a setting; they are re-derived by hand, not
  // relaxed until green.
  check(grid.trip.length === 2,
    `a 3-day span crossing a week edge draws 2 bars, one per week (got ${grid.trip.length})`);
  check(grid.trip.some((b) => b.col === '6 / span 2') && grid.trip.some((b) => b.col === '1 / span 1'),
    `and they cover the right days (${grid.trip.map((b) => b.col).join(' | ')})`);
  check(grid.chips.length === 0,
    `the span does not also appear as per-day chips (${JSON.stringify(grid.chips)})`);
  // 7/22–8/2 covers 水…日 of [7/20-26] and the whole of [7/27-8/2]: two rows.
  // (Sunday-start split the same span across three.)
  check(grid.holiday.length === 2,
    `a 12-day span spills across 2 week rows (got ${grid.holiday.length})`);
  check(grid.holiday.some((b) => b.col === '1 / span 7'),
    'and fills a whole week row where it covers one');
  // 出張 (23-24, cols 4-5) and 帰省 (25-26, cols 6-7) don't overlap, so they
  // belong on the same lane.
  check(grid.trip2[0]?.lane === grid.trip.find((b) => b.col === '6 / span 2')?.lane,
    `non-overlapping spans share a lane (出張 lane ${grid.trip2[0]?.lane}, `
    + `帰省 lane ${grid.trip.find((b) => b.col === '6 / span 2')?.lane})`);
  check(grid.holiday[0]?.lane !== grid.trip2[0]?.lane,
    'overlapping spans get their own lanes');
  // The footer used to sum the cells, so a 12-day span counted as 12 events.
  check(!/1[5-9]件|2\d件/.test(grid.status || ''),
    `the footer counts events, not day-slots (${grid.status})`);

  // Bars eat the room the chips used to have, and a cell that overfills clips
  // in silence — the failure this app exists to fix. So measure the pixels,
  // not the intent.
  const spill = await page.evaluate(() => {
    let worst = 0;
    let where = '';
    for (const c of document.querySelectorAll('.m-cell')) {
      const bottom = c.getBoundingClientRect().bottom;
      for (const k of c.querySelectorAll('.m-ev, .m-more')) {
        const over = k.getBoundingClientRect().bottom - bottom;
        if (over > worst) { worst = over; where = k.textContent.slice(0, 14); }
      }
    }
    const weeks = [...document.querySelectorAll('.m-week')]
      .map((w) => ({ lanes: +w.style.getPropertyValue('--lanes') || 0,
        evsH: Math.round(w.querySelector('.m-evs').clientHeight) }));
    return { worst: Math.round(worst), where, weeks };
  });
  const busy = spill.weeks.find((w) => w.lanes > 0);
  const empty = spill.weeks.find((w) => w.lanes === 0);
  check(busy && empty && busy.evsH < empty.evsH,
    `a week with bars has less room for chips (${busy?.lanes} lanes: ${busy?.evsH}px vs ${empty?.evsH}px)`);
  check(spill.worst <= 1,
    `nothing spills past a cell edge (worst ${spill.worst}px${spill.where ? ' — ' + spill.where : ''})`);

  await page.evaluate(async (ids) => {
    const cal = [...TTX.store.state.enabled][0];
    for (const u of ids) { await TTX.api.deleteEvent(cal, u); TTX.store.markDeleted(cal, u); }
  }, seeded);
  await page.click('.seg button:text-is("アジェンダ")');
  await sleep(500);
  ok('span test events cleaned up');

  // --- 8. settings ----------------------------------------------------------
  sec('settings');
  await page.keyboard.press(',');
  await page.waitForSelector('.settings', { timeout: 5000 });
  ok('the , key opens settings');
  const st = await page.evaluate(() => ({
    role: document.querySelector('.settings').getAttribute('role'),
    inert: document.querySelector('#app')?.hasAttribute('inert'),
    focusInside: document.querySelector('.settings').contains(document.activeElement),
    sections: [...document.querySelectorAll('.st-sec')].map((n) => n.textContent),
    exports: [...document.querySelectorAll('.st-exp-t')].map((n) => n.textContent),
    note: document.querySelector('.st-note')?.textContent ?? '',
  }));
  check(st.role === 'dialog' && st.inert === true, 'it is a dialog and the app behind is inert');
  check(st.focusInside, 'focus moved into it');
  check(st.sections.join() === '表示,通知,書き出し,このアプリについて',
    `sections: ${st.sections.join(' / ')}`);
  check(st.exports.join() === 'Markdown,ICS,CSV,JSON',
    `the four exports moved here off the sidebar (${st.exports.join(', ')})`);
  // The sidebar used to carry these four abbreviations permanently.
  check(await page.evaluate(() => document.querySelectorAll('.side-foot .mini-btn').length) === 0,
    'and are gone from the sidebar');
  check(!/\d{4}-\d{2}-\d{2}/.test(st.note),
    `the range is written in Japanese, not ISO (${st.note})`);

  await page.keyboard.press('Escape');
  await page.waitForSelector('.settings', { state: 'detached', timeout: 5000 });
  check(await page.evaluate(() => !document.querySelector('#app')?.hasAttribute('inert')),
    'Escape closes it and the app is interactive again');

  console.log(`\n${fail ? '\x1b[31m' : '\x1b[32m'}${pass} passed, ${fail} failed\x1b[0m`);
  if (uuid) console.log(`(test events were created and deleted in "${EXPECT_CALENDAR}")`);
  await browser.close();
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error('\n\x1b[31mVERIFY THREW\x1b[0m:', e.message);
  process.exit(1);
});
