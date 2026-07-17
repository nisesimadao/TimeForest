#!/usr/bin/env node
/* TimeForest from a terminal.
 *
 *   tf ls [--from 2026-07-01] [--to 2026-07-31] [--cal 家族] [--json]
 *   tf show <uuid>
 *   tf comments <uuid>
 *   tf say <uuid> "text"
 *   tf accounts
 *
 * Why this is an Electron process and not plain Node: the sessions belong to
 * Electron partitions — Chromium cookie jars under userData, SQLite encrypted
 * with DPAPI. Nothing outside Electron can read them. Running here means the
 * CLI reuses the login you already did in the app: no second sign-in, no
 * credentials on disk anywhere new, and one place (session.js) that knows how
 * to be authenticated.
 *
 * And why it shares src/lib with the app rather than talking to the API itself:
 * everything hard-won about TimeTree lives there — that writes are singular and
 * reads are plural, that all-day events store UTC midnight, how a recurrence is
 * really edited. A CLI with its own client would be a second place for all of
 * that to be wrong.
 *
 * ⚠ Not while the app is running. They share userData, and a second Electron on
 *   the same profile does not fail — it answers a CSRF token and then an empty
 *   calendar list, which reads as "you have no calendars".
 */
const { app } = require('electron');
const S = require('./session');

S.pin();                 // before whenReady: userData is derived from the name
app.disableHardwareAcceleration();

// The libs are IIFEs that hang themselves off globalThis, so requiring them
// runs the real thing. Order matters: model reads api, api reads tz.
require('../src/lib/tz.js');
require('../src/lib/recur.js');
require('../src/lib/api.js');
require('../src/lib/model.js');
require('../src/lib/export.js');
require('./renderer/store.js');
const { TTX } = globalThis;

const TZ = 'Asia/Tokyo';

// --- argv -------------------------------------------------------------------

function parse(argv) {
  const out = { _: [], flags: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) { out._.push(a); continue; }
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) out.flags[key] = true;
    else { out.flags[key] = next; i++; }
  }
  return out;
}

const die = (msg) => { console.error(msg); app.exit(1); };

// --- output -----------------------------------------------------------------

const DIM = '\x1b[2m';
const OFF = '\x1b[0m';
const BOLD = '\x1b[1m';
const tty = process.stdout.isTTY;
const dim = (s) => (tty ? DIM + s + OFF : s);
const bold = (s) => (tty ? BOLD + s + OFF : s);

const WEEK = ['日', '月', '火', '水', '木', '金', '土'];
const jp = (key) => `${+key.slice(5, 7)}/${+key.slice(8)}(${WEEK[TTX.tz.weekdayOf(key)]})`;

function line(o) {
  const when = o.allDay ? '終日   ' : `${o.startTime}–${o.endTime}`;
  const bits = [o.title];
  if (o.location) bits.push(dim(o.location));
  return `  ${dim(when)}  ${bits.join('  ')}`;
}

// --- commands ---------------------------------------------------------------

async function cmdAccounts() {
  const list = S.all();
  if (!list.length) return console.log('アカウントがありません。先にアプリでログインしてください。');
  for (const a of list) {
    const mark = a.id === S.activeIdOf() ? '*' : ' ';
    console.log(`${mark} ${a.name || '(名前なし)'}  ${dim(a.email || a.id)}`);
  }
}

async function cmdLs(args) {
  const from = args.flags.from || TTX.tz.ymd(Date.now(), TZ);
  const to = args.flags.to || TTX.tz.ymd(Date.now() + 30 * 86400000, TZ);
  await TTX.store.syncAll();
  const state = TTX.store.state;

  let cals = state.calendars;
  if (args.flags.cal) {
    const want = String(args.flags.cal);
    cals = cals.filter((c) => c.name === want || String(c.id) === want);
    if (!cals.length) {
      return die(`カレンダー "${want}" がありません。あるのは: ${state.calendars.map((c) => c.name).join(', ')}`);
    }
    state.enabled.clear();
    for (const c of cals) state.enabled.add(c.id);
  }

  // holidaysFor(), not state.holidays — that one is a Map of year → list, and
  // occurrences() wants the flat array. Passing the Map doesn't throw where you
  // wrote it; it throws four frames down inside model.js.
  const holidays = await TTX.store.holidaysFor(from, to).catch(() => []);
  const occs = TTX.store.occurrences(from, to, { holidays });
  if (args.flags.json) {
    return console.log(JSON.stringify(occs.map((o) => ({
      uuid: o.uuid, title: o.title, startKey: o.startKey, endKey: o.endKey,
      allDay: o.allDay, start: o.start, end: o.end,
      location: o.location, note: o.note, calendar: o.calendarName,
      author: o.authorName, lat: o.lat, lon: o.lon,
    })), null, 2));
  }

  const byDay = TTX.model.groupByDay(occs, from, to);
  let shown = 0;
  for (const key of Object.keys(byDay).sort()) {
    const list = byDay[key];
    if (!list.length) continue;
    console.log(bold(jp(key)));
    for (const o of list) console.log(line(o));
    shown += list.length;
  }
  if (!shown) console.log(dim(`${from} 〜 ${to} に予定はありません`));
  else console.log(dim(`\n${shown}件  ${from} 〜 ${to}`));
}

async function cmdShow(args) {
  const uuid = args._[1];
  if (!uuid) return die('使い方: tf show <uuid>');
  await TTX.store.syncAll();
  const state = TTX.store.state;
  for (const cal of state.calendars) {
    const raw = TTX.store.rawEvent(cal.id, uuid);
    if (!raw) continue;
    if (args.flags.json) return console.log(JSON.stringify(raw, null, 2));
    console.log(bold(raw.title || '(無題)'));
    console.log(`  カレンダー  ${cal.name}`);
    console.log(`  日時        ${new Date(raw.start_at).toLocaleString('ja-JP', { timeZone: TZ })}`
      + ` 〜 ${new Date(raw.end_at).toLocaleString('ja-JP', { timeZone: TZ })}${raw.all_day ? ' (終日)' : ''}`);
    if (raw.location) console.log(`  場所        ${raw.location}`);
    if (raw.note) console.log(`  メモ        ${raw.note.replace(/\n/g, '\n              ')}`);
    if (raw.recurrences?.length) console.log(`  繰り返し    ${raw.recurrences.join(' / ')}`);
    return;
  }
  die(`予定 ${uuid} が見つかりません`);
}

async function withEvent(uuid, fn) {
  await TTX.store.syncAll();
  for (const cal of TTX.store.state.calendars) {
    if (TTX.store.rawEvent(cal.id, uuid)) return fn(cal);
  }
  return die(`予定 ${uuid} が見つかりません`);
}

async function cmdComments(args) {
  const uuid = args._[1];
  if (!uuid) return die('使い方: tf comments <uuid>');
  await withEvent(uuid, async (cal) => {
    const raw = await TTX.api.activities(cal.id, uuid);
    const me = TTX.store.state.me?.id ?? null;
    const items = TTX.model.normalizeActivities(raw, { membersById: TTX.store.state.members.get(cal.id) }, me);
    if (args.flags.json) return console.log(JSON.stringify(items, null, 2));
    if (!items.length) return console.log(dim('（何もありません）'));
    for (const a of items) {
      const when = new Date(a.at).toLocaleString('ja-JP', { timeZone: TZ });
      if (a.comment) console.log(`${bold(a.authorName || '(名前なし)')} ${dim(when)}${a.edited ? dim(' 編集済み') : ''}\n  ${a.text}`);
      else console.log(dim(`— ${a.authorName ? a.authorName + 'が' : ''}${a.text}  ${when}`));
    }
  });
}

async function cmdSay(args) {
  const [, uuid, ...rest] = args._;
  const text = rest.join(' ').trim();
  if (!uuid || !text) return die('使い方: tf say <uuid> "text"');
  await withEvent(uuid, async (cal) => {
    // Naming the calendar matters: on a shared one this notifies the other
    // members, and a terminal gives you no other clue about where it landed.
    await TTX.api.postComment(cal.id, uuid, text);
    console.log(`${cal.name} の「${TTX.store.rawEvent(cal.id, uuid).title}」に投稿しました`);
  });
}

const HELP = `TimeForest — TimeTree を端末から

  tf ls [--from YYYY-MM-DD] [--to YYYY-MM-DD] [--cal 名前] [--json]
  tf show <uuid> [--json]
  tf comments <uuid> [--json]
  tf say <uuid> "コメント"
  tf accounts

  --account <メール|id>   使うアカウント（既定はアプリで選んでいるもの）

アプリを起動したまま実行しないこと。同じ profile を奪い合って、
CSRF は取れるのにカレンダーが空、という嘘の結果になります。`;

// --- main -------------------------------------------------------------------

const COMMANDS = { ls: cmdLs, show: cmdShow, comments: cmdComments, say: cmdSay, accounts: cmdAccounts };

(async () => {
  const args = parse(process.argv.slice(app.isPackaged ? 1 : 2));
  const cmd = args._[0];
  if (!cmd || cmd === 'help' || args.flags.help) { console.log(HELP); return app.exit(0); }
  if (!COMMANDS[cmd]) { console.error(`知らないコマンド: ${cmd}\n`); console.log(HELP); return app.exit(1); }

  // The app holds a single-instance lock on this profile. If we can't take it,
  // it's running — and going ahead anyway does not fail cleanly: two Electrons
  // fighting over one Chromium profile produce a good CSRF token and then an
  // empty calendar list, or a 400 with code -493. Both read as "you have no
  // calendars", which is a lie. Measured both ways. Say the true thing instead.
  if (!app.requestSingleInstanceLock()) {
    return die('TimeForest のアプリが起動しています。同じログイン情報を奪い合って\n'
      + '結果が嘘になるので、アプリを閉じてから実行してください。');
  }

  await app.whenReady();
  S.load();

  if (args.flags.account) {
    const want = String(args.flags.account);
    const hit = S.all().find((a) => a.email === want || a.id === want || a.name === want);
    if (!hit) return die(`アカウント "${want}" がありません。tf accounts で一覧が見られます。`);
    S.setActive(hit.id);
  }
  const acct = S.active();
  if (!acct) return die('アカウントがありません。先にアプリでログインしてください。');

  // Everything in src/lib goes through this. Same code as the app, same
  // session as the app.
  TTX.api.setTransport((path, { method, body } = {}) => S.apiJSON(acct, path, method || 'GET', body));

  try {
    await COMMANDS[cmd](args);
    app.exit(0);
  } catch (e) {
    console.error(String(e.message || e));
    app.exit(1);
  }
})();
