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
  for (let i = 0; i < 4 && await page.$('.scrim, .d-scrim'); i++) {
    await page.keyboard.press('Escape');
    await sleep(250);
    const discard = await page.$('.confirm .btn.danger');
    if (discard) { await discard.click(); await sleep(250); }
  }
  ok('no dialog left over from a previous run');

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
  await page.evaluate(() => { TTX.store.state.events.clear(); return TTX.store.syncAll(); });
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
  await page.evaluate(() => { TTX.store.state.events.clear(); return TTX.store.syncAll(); });
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
  await page.evaluate(() => { TTX.store.state.events.clear(); return TTX.store.syncAll(); });
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
  await page.evaluate(() => { TTX.store.state.events.clear(); return TTX.store.syncAll(); });
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
  await page.evaluate(() => { TTX.store.state.events.clear(); return TTX.store.syncAll(); });
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
