#!/usr/bin/env node
/* End-to-end verification of the comment feed, against the real server.
 *
 * The point of this file, over the unit checks in scripts/check.js: those
 * prove that item code 4 renders as 「場所を変更しました」. This proves that
 * TimeTree still SENDS 4 when you change the location — which is the half we
 * don't control and can't test by reading our own source.
 *
 * Comments are the reason a family uses TimeTree instead of a calendar each
 * person keeps alone, so "did it actually reach the server" is the assertion
 * that matters most here. Everything below re-reads through a fresh fetch
 * rather than trusting what the UI put on screen.
 *
 * Usage:
 *   cd client && npm run inspect
 *   npm i playwright-core
 *   node scripts/verify-comment.js
 *
 * SAFETY: refuses to run unless every enabled calendar is the throwaway `dowa`.
 * Comments are outward-facing — on a shared calendar they notify other people.
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
const TITLE = 'NF検証-コメント';

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
  const calId = await page.evaluate(() => [...TTX.store.state.enabled][0]);

  sec('setup');
  // A previous run may have died with the card up; the app tracks what's open,
  // so ripping the DOM out would leave it refusing to open another.
  for (let i = 0; i < 6 && await page.$('.scrim, .d-scrim'); i++) {
    await page.keyboard.press('Escape');
    await sleep(250);
  }
  check(await page.$('.scrim, .d-scrim') === null, 'no dialog left over from a previous run');

  const swept = await page.evaluate(async (cid) => {
    const junk = (TTX.store.state.events.get(cid) || [])
      .filter((e) => (e.title || '').startsWith('NF検証') && !e.deactivated_at);
    for (const e of junk) { await TTX.api.deleteEvent(cid, e.uuid); TTX.store.markDeleted(cid, e.uuid); }
    return junk.length;
  }, calId);
  ok(`swept ${swept} leftover test event(s)`);

  // The view the assertions below select against. Inheriting whatever the last
  // session left behind has silently passed agenda selectors against a week
  // grid more than once.
  await page.click('.seg button:text-is("アジェンダ")');
  await page.waitForSelector('.agenda', { timeout: 5000 });
  ok('view = agenda');

  const made = await page.evaluate(async (t) => {
    const cal = [...TTX.store.state.enabled][0];
    const start = Date.now() + 2 * 3600000;
    const e = await TTX.api.createEvent(cal, {
      title: t, allDay: false, startAt: start, endAt: start + 3600000,
      tz: 'Asia/Tokyo', labelId: 1,
    });
    TTX.store.applyEvent(cal, e);
    return { uuid: e.uuid };
  }, TITLE);
  // applyEvent updates the store but does NOT repaint — nothing in the client
  // subscribes, the code that writes repaints for itself. Click 今日 AFTER
  // creating, so the render is caused by this line and not by an auto-sync tick
  // that happens to land during a sleep.
  await page.click('.pill:text-is("今日")');
  await page.locator('.ev', { hasText: TITLE }).first().waitFor({ timeout: 8000 });
  ok(`created ${TITLE}, cursor = today, and it is on screen`);

  const open = async () => {
    const row = page.locator('.ev', { hasText: TITLE }).first();
    await row.click();
    await page.waitForSelector('.d-card .d-cin', { timeout: 5000 });
    // The feed is fetched after the card mounts; wait for the load to settle.
    await page.waitForFunction(
      () => !document.querySelector('.d-fmsg')?.textContent.includes('読み込んで'),
      { timeout: 8000 }
    );
  };
  // A system row's text is its first span; a comment's is .d-fx — the first
  // span there is the avatar, and reading it reported every comment as "?".
  const feedRows = () => page.evaluate(() => [...document.querySelectorAll('.d-card .d-fi')]
    .map((n) => (n.classList.contains('sys')
      ? 'sys|' + n.querySelector('span')?.textContent
      : 'cmt|' + n.querySelector('.d-fx')?.textContent)));

  // --- 1. a fresh event ------------------------------------------------------
  sec('a fresh event');
  await open();
  const first = await feedRows();
  check(first.length === 1 && first[0] === 'sys|予定を作成しました',
    `the feed opens with only 予定を作成しました (got ${JSON.stringify(first)})`);
  check(await page.evaluate(() => !!document.querySelector('.d-fmsg')?.textContent.includes('まだコメント')),
    'and says まだコメントはありません');
  check(await page.evaluate(() => document.querySelector('.d-csend')?.disabled === true),
    '送信 is disabled with an empty box');

  // --- 2. posting, through the UI -------------------------------------------
  sec('posting a comment');
  await page.fill('.d-cin', '駐車場ってある？');
  check(await page.evaluate(() => document.querySelector('.d-csend')?.disabled === false),
    '送信 enables once there is text');
  await page.press('.d-cin', 'Enter');
  await page.waitForFunction(() => [...document.querySelectorAll('.d-fx')]
    .some((n) => n.textContent === '駐車場ってある？'), { timeout: 8000 });
  ok('Enter posts it and it appears in the feed');
  check(await page.inputValue('.d-cin') === '', 'and the box is cleared');

  // The assertion that matters: not "the DOM changed" but "the server has it".
  const onServer = await page.evaluate(async ({ cid, uuid }) => {
    const list = await TTX.api.activities(cid, uuid);
    return list.filter((a) => a.type === 0).map((a) => a.attachment?.content);
  }, { cid: calId, uuid: made.uuid });
  check(onServer.length === 1 && onServer[0] === '駐車場ってある？',
    `a fresh fetch finds it on the server (${JSON.stringify(onServer)})`);

  // --- 3. Shift+Enter is a newline, not a send ------------------------------
  sec('Shift+Enter');
  await page.click('.d-cin');
  await page.type('.d-cin', '一行目');
  await page.keyboard.press('Shift+Enter');
  await page.type('.d-cin', '二行目');
  await sleep(300);
  const typed = await page.inputValue('.d-cin');
  check(typed === '一行目\n二行目', `Shift+Enter breaks the line instead of sending (${JSON.stringify(typed)})`);
  const stillOne = await page.evaluate(async ({ cid, uuid }) =>
    (await TTX.api.activities(cid, uuid)).filter((a) => a.type === 0).length, { cid: calId, uuid: made.uuid });
  check(stillOne === 1, 'and nothing was posted while typing');
  // Escape clears the draft rather than closing the card and losing it.
  await page.keyboard.press('Escape');
  await sleep(300);
  check(await page.$('.d-card') !== null, 'Escape with a draft does not close the card');
  check(await page.inputValue('.d-cin') === '', 'it clears the draft');
  await page.keyboard.press('Escape');
  await sleep(300);
  check(await page.$('.d-card') === null, 'a second Escape closes the card');

  // --- 4. the feed reports what the SERVER says changed ----------------------
  //
  // scripts/check.js proves 4 renders as 「場所を変更しました」. Only this can
  // prove TimeTree still answers 4 when the location changes — that mapping was
  // measured by hand and nothing but a real edit can catch it drifting.
  sec('edits are reported, with the field the server names');
  await page.evaluate(async ({ cid, uuid }) => {
    const cur = TTX.store.rawEvent(cid, uuid);
    const e = await TTX.api.updateEvent(cid, uuid, { ...cur, location: '東京駅' });
    TTX.store.applyEvent(cid, e);
  }, { cid: calId, uuid: made.uuid });
  await sleep(700);
  await open();
  const afterEdit = await feedRows();
  check(afterEdit.some((r) => r === 'sys|場所を変更しました'),
    `the feed says 場所を変更しました (got ${JSON.stringify(afterEdit)})`);
  check(afterEdit.filter((r) => r.startsWith('cmt|')).length === 1,
    'the comment is still there, under the edit');

  // --- 5. the card stays on screen ------------------------------------------
  //
  // The card is placed against its own height, and the feed arrives AFTER the
  // placement runs — so a card that fit when it was placed can grow by ~200px
  // and hang off the bottom, taking 送信 and 編集/削除 with it.
  //
  // This only reproduces when the row is near the BOTTOM of the window, which
  // is the ordinary case — you click the last event of the day. The first
  // version of this section opened a row at the top of the agenda, where the
  // card had 200px of room to grow into: deleting the re-place entirely still
  // passed every assertion. A green test that can't fail is worse than none,
  // so the setup below asserts it actually reached the hard case first.
  sec('a long thread does not push the card off screen');
  await page.evaluate(async ({ cid, uuid }) => {
    for (let i = 0; i < 12; i++) await TTX.api.postComment(cid, uuid, `埋め草 ${i} 行目`);
  }, { cid: calId, uuid: made.uuid });
  await page.keyboard.press('Escape');
  await sleep(300);

  // To scroll a row to the bottom there has to be a screenful of content above
  // it, and the throwaway calendar is too small for the agenda to scroll at all
  // (scrollHeight == clientHeight, measured). So: make today busy. This is the
  // real case anyway — a full day, and you open the last thing on it.
  await page.evaluate(async ({ cid, n }) => {
    const base = new Date(); base.setHours(0, 30, 0, 0);
    for (let i = 0; i < n; i++) {
      const s = base.getTime() + i * 1800000;
      const e = await TTX.api.createEvent(cid, {
        title: `NF検証-埋め${i}`, allDay: false, startAt: s, endAt: s + 900000,
        tz: 'Asia/Tokyo', labelId: 1,
      });
      TTX.store.applyEvent(cid, e);
    }
  }, { cid: calId, n: 22 });
  await page.click('.pill:text-is("今日")');
  await sleep(600);

  const rowY = await page.evaluate((t) => {
    const row = [...document.querySelectorAll('.ev')].find((n) => n.textContent.includes(t));
    row.scrollIntoView({ block: 'end' });
    const r = row.getBoundingClientRect();
    const ag = document.querySelector('.agenda');
    return {
      bottom: Math.round(r.bottom), win: innerHeight,
      canScroll: ag.scrollHeight > ag.clientHeight + 2,
    };
  }, TITLE);
  await sleep(400);
  check(rowY.canScroll, 'the agenda has enough on it to scroll');
  check(rowY.bottom > rowY.win * 0.6,
    `the row is low in the window — the case that breaks (${rowY.bottom} of ${rowY.win})`);

  await open();
  await sleep(400);
  const geo = await page.evaluate(() => {
    const c = document.querySelector('.d-card');
    const r = c.getBoundingClientRect();
    const send = c.querySelector('.d-csend').getBoundingClientRect();
    const acts = c.querySelector('.d-acts')?.getBoundingClientRect();
    return {
      top: Math.round(r.top), bottom: Math.round(r.bottom), win: innerHeight,
      sendBottom: Math.round(send.bottom),
      actsBottom: acts ? Math.round(acts.bottom) : null,
      feedScrolls: (() => { const f = c.querySelector('.d-feed'); return f.scrollHeight > f.clientHeight; })(),
    };
  });
  check(geo.top >= -1 && geo.bottom <= geo.win + 1,
    `the card is inside the window (${geo.top}..${geo.bottom} of ${geo.win})`);
  check(geo.sendBottom <= geo.win + 1, `送信 is reachable (bottom ${geo.sendBottom} of ${geo.win})`);
  check(geo.actsBottom === null || geo.actsBottom <= geo.win + 1,
    `編集/削除 are reachable (bottom ${geo.actsBottom} of ${geo.win})`);
  check(geo.feedScrolls, 'the thread scrolls rather than growing the card without bound');

  // --- 6. keyboard ----------------------------------------------------------
  sec('keyboard');
  check(await page.evaluate(() => document.activeElement?.classList.contains('d-card')),
    'the card takes focus itself, so a screen reader hears the event, not the comment box');
  const trapped = await page.evaluate(async () => {
    const card = document.querySelector('.d-card');
    const seen = new Set();
    for (let i = 0; i < 25; i++) {
      // Tab is synthesised by the browser, not reachable from evaluate — walk
      // the same list the trap uses instead and assert it is closed.
      const items = [...card.querySelectorAll('a[href], button:not([disabled]), input:not([disabled]), '
        + 'select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])')]
        .filter((n) => n.offsetParent !== null);
      if (!items.length) return { err: 'no focusable items in the card' };
      items.forEach((n) => seen.add(n.className));
      return { items: items.map((n) => n.className), allInside: items.every((n) => card.contains(n)) };
    }
  });
  check(trapped.allInside, 'every focusable control is inside the card');
  check(trapped.items?.includes('d-cin'), 'the comment box is among them');

  // Shift+Tab from the card must not escape the dialog.
  await page.keyboard.press('Shift+Tab');
  await sleep(200);
  check(await page.evaluate(() => document.querySelector('.d-card')?.contains(document.activeElement)),
    'Shift+Tab from the card stays inside it');

  // --- 7. holidays have nothing to comment on -------------------------------
  sec('holidays');
  await page.keyboard.press('Escape');
  await sleep(300);
  const holiday = page.locator('.ev', { hasText: '敬老の日' }).first();
  if (await holiday.count()) {
    await holiday.click();
    await sleep(600);
    check(await page.$('.d-card .d-cin') === null, '祝日 has no comment box — there is no event to hang one on');
    await page.keyboard.press('Escape');
    await sleep(300);
  } else {
    ok('祝日 — none on screen, skipped');
  }

  // --- cleanup --------------------------------------------------------------
  sec('cleanup');
  await page.evaluate(async (cid) => {
    for (const e of TTX.store.state.events.get(cid) || []) {
      if (/^NF検証/.test(e.title || '') && !e.deactivated_at) {
        await TTX.api.deleteEvent(cid, e.uuid);
        TTX.store.markDeleted(cid, e.uuid);
      }
    }
  }, calId);
  const left = await page.evaluate((cid) => (TTX.store.state.events.get(cid) || [])
    .filter((e) => /^NF検証/.test(e.title || '') && !e.deactivated_at).length, calId);
  check(left === 0, 'no test events left behind');

  console.log(`\n${fail ? '\x1b[31m' : '\x1b[32m'}${pass} passed, ${fail} failed\x1b[0m`);
  await browser.close();
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error('\n\x1b[31mVERIFY THREW\x1b[0m:', e.message);
  process.exit(1);
});
