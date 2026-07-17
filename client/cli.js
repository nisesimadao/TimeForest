#!/usr/bin/env node
/* TimeForest from a terminal. Plain Node — no Electron here.
 *
 *   tf ls [--from 2026-07-01] [--to 2026-07-31] [--cal 家族] [--json]
 *   tf show <uuid> [--json]
 *   tf comments <uuid> [--json]
 *   tf say <uuid> "14時でいい？"
 *   tf accounts
 *   tf use <メール|id>
 *
 * It asks the running app. That is the whole design:
 *
 *  - The login is a browser session cookie in a Chromium jar (DPAPI-encrypted
 *    SQLite). Only Electron can read it, and only one process at a time — two
 *    on the same profile don't fail cleanly, they answer a good CSRF token and
 *    then an empty calendar list. So a standalone CLI would have to close the
 *    app, and the app is a TRAY app: it is normally running. That's the wrong
 *    way round.
 *  - The app already holds every event in memory. Asking it is instant; a
 *    separate process re-syncs 4298 events first (measured: 8 seconds).
 *
 * If the app isn't running, this starts it. One code path either way — the only
 * difference is who opened the door.
 */
const net = require('node:net');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const { spawn } = require('node:child_process');
const { socketPath } = require('./rpc');
const dates = require('./dates');

const TZ = 'Asia/Tokyo';

/**
 * Where Electron puts userData for app.setName('TimeForest'). Recomputed here
 * because this process has no Electron to ask — if these two ever disagree, the
 * CLI talks to a profile that doesn't exist and reports "start the app" at an
 * app that is running. scripts/check.js guards the name.
 */
function userDataDir() {
  const name = 'TimeForest';
  if (process.platform === 'win32') return path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), name);
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support', name);
  return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), name);
}

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

const die = (msg) => { console.error(msg); process.exit(1); };

/**
 * The value of a flag that needs one.
 *
 * parse() cannot tell `--where` (a typo, or a shell that ate the argument) from
 * `--json` (a real switch): it hands back `true` for both. Passed on, that
 * boolean goes over the wire as JSON `true`, through `location || ''`, and into
 * TimeTree — which stored it as the location `t`. On a family calendar that is
 * a wrong edit that notifies everybody.
 */
const val = (flags, k) => {
  if (flags[k] === true) die(`--${k} には値が要ります`);
  return flags[k];
};

/**
 * `tf add 歯医者 --at 7/21 10:00` without the quotes. The shell hands the time
 * over as its own word: `add` puts it in the title and makes an all-day event
 * called 「歯医者 10:00」, and `edit` drops it and moves the event to the right
 * day at the wrong time. Neither looks like anything went wrong.
 */
const noStrayTime = (words) => {
  const t = words.find((w) => /^\d{1,2}:\d{2}$/.test(w));
  if (t) {
    die(`"${t}" が余っています。時刻は日付とひとまとめに引用符で囲んでください:\n`
      + `  --at "7/21 ${t}"    ← こう`);
  }
};

// --- the door ---------------------------------------------------------------

const connect = (file) => new Promise((resolve, reject) => {
  const sock = net.connect(file);
  sock.once('connect', () => resolve(sock));
  sock.once('error', reject);
});

/** Start the app and wait for its door to open. Windowless is not an option —
 *  the store lives in the renderer — but it opens to the tray, which is where
 *  this app lives anyway. */
async function startApp(file) {
  const root = path.join(__dirname);
  const electron = process.platform === 'win32'
    ? path.join(root, 'node_modules', 'electron', 'dist', 'electron.exe')
    : path.join(root, 'node_modules', 'electron', 'dist', 'electron');
  if (!fs.existsSync(electron)) {
    die('TimeForest が起動しておらず、起動もできません（electron が見つかりません）。\n'
      + 'アプリを手で起動してから、もう一度実行してください。');
  }
  console.error('TimeForest を起動しています…');
  const child = spawn(electron, [root], { detached: true, stdio: 'ignore' });
  child.unref();

  // Poll for the door. The app has to sync before it can answer anything, and
  // that is the 8 seconds we're avoiding on every LATER call.
  const until = Date.now() + 60000;
  while (Date.now() < until) {
    try { return await connect(file); } catch { /* not yet */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  return die('TimeForest を起動しましたが、応答がありません。');
}

let nextId = 1;
function talk(sock, cmd, args) {
  return new Promise((resolve, reject) => {
    const id = nextId++;
    let buf = '';
    // Every listener comes off on the way out, whichever way it goes. Leaving
    // them on leaked one per call — the cold-start path polls ping until the app
    // is synced, and Node started warning about it at ten.
    const done = (fn, v) => {
      sock.off('data', onData); sock.off('error', onErr); sock.off('end', onEnd);
      fn(v);
    };
    const onErr = (e) => done(reject, e);
    // Quitting the app is not an error, it is a FIN: measured, the socket emits
    // 'end' and nothing else. Settling only on a reply or an 'error' means the
    // promise never settles at all, and the caller waits forever.
    const onEnd = () => done(reject, new Error('TimeForest が終了しました。'));
    const onData = (chunk) => {
      buf += chunk;
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (!line.trim()) continue;
        const res = JSON.parse(line);
        if (res.id !== id) continue;
        return res.ok ? done(resolve, res.data) : done(reject, new Error(res.error));
      }
    };
    sock.on('data', onData);
    sock.on('error', onErr);
    sock.on('end', onEnd);
    sock.write(JSON.stringify({ id, cmd, args }) + '\n');
  });
}

// --- output -----------------------------------------------------------------

const tty = process.stdout.isTTY;
const dim = (s) => (tty ? '\x1b[2m' + s + '\x1b[0m' : s);
const bold = (s) => (tty ? '\x1b[1m' + s + '\x1b[0m' : s);

const WEEK = ['日', '月', '火', '水', '木', '金', '土'];
const jp = (key) => {
  const d = new Date(`${key}T00:00:00Z`);
  return `${+key.slice(5, 7)}/${+key.slice(8)}(${WEEK[d.getUTCDay()]})`;
};
/** With the year, for `find` — whose results span years, so 6/12 alone is a
 *  date you have to go and look up. `ls` leaves it off: you named the range. */
const jpY = (key) => `${key.slice(0, 4)}/${jp(key)}`;
const stamp = (ms) => new Date(ms).toLocaleString('ja-JP', { timeZone: TZ });

function printLs(data) {
  const byDay = new Map();
  for (const e of data.events) {
    // A span belongs to every day it covers, the way the agenda reads it.
    for (let k = e.startKey; k <= e.endKey; k = jpNext(k)) {
      if (k < data.from || k > data.to) continue;
      if (!byDay.has(k)) byDay.set(k, []);
      byDay.get(k).push(e);
      if (!e.multiDay) break;
    }
  }
  let n = 0;
  for (const key of [...byDay.keys()].sort()) {
    console.log(bold(jp(key)));
    for (const e of byDay.get(key)) {
      const when = e.holiday ? '祝' : e.allDay ? '終日   ' : `${e.startTime}–${e.endTime}`;
      const bits = [e.title];
      if (e.location) bits.push(dim(e.location));
      if (e.calendar && !e.holiday) bits.push(dim('[' + e.calendar + ']'));
      // The uuid is what every other command takes, so it earns its place —
      // except on holidays, whose ids are synthesised here and address nothing.
      if (!e.holiday && e.uuid) bits.push(dim(e.uuid.slice(0, 8)));
      console.log(`  ${dim(when)}  ${bits.join('  ')}`);
      n++;
    }
  }
  const where = (data.calendars || []).join('、');
  if (!n) console.log(dim(`${data.from} 〜 ${data.to}、${where || 'カレンダー'} に予定はありません`));
  else console.log(dim(`\n${n}件  ${data.from} 〜 ${data.to}  ${where}`));
}

/** next day for a YYYY-MM-DD key, without dragging in a date library */
function jpNext(key) {
  const d = new Date(`${key}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

// --- commands ---------------------------------------------------------------

const DATE_HELP = `  日付: today 明日 yesterday week nextweek month nextmonth
        7/21  2026-07-21  +7d  -3d`;
const WHEN_HELP = `  いつ: "7/21 10:00"  "明日 9時"  +7d  ← 時刻を書かなければ終日`;
const LONG_HELP = '  長さ: 1h  90m  1:30  1.5h  2時間  45';

/** What we just wrote, read back from what the server returned — not from what
 *  we sent. The server decides; if it moved something, that is what you need to
 *  see, and a terminal gives you no other clue. */
function printSaved(calendar, e, what) {
  console.log(`${bold(e.title || '(無題)')} を${what}`);
  console.log(`  カレンダー  ${calendar}`);
  console.log(`  日時        ${e.all_day
    ? `${jp(new Date(e.start_at).toISOString().slice(0, 10))} 〜 ${jp(new Date(e.end_at).toISOString().slice(0, 10))} (終日)`
    : `${stamp(e.start_at)} 〜 ${stamp(e.end_at)}`}`);
  if (e.location) console.log(`  場所        ${e.location}`);
  console.log(`  ${dim(e.uuid)}`);
}

const HELP = `TimeForest — TimeTree を端末から

  tf ls [today|week|month|7/21] [--from …] [--to …] [--cal 名前] [--json]
  tf find <語> [--limit 20] [--json]
  tf show <uuid> [--json]
  tf comments <uuid> [--json]
  tf say <uuid> "コメント"

  tf add <タイトル> --at <いつ> [--to …|--for 1h] [--where …] [--note …] [--cal 名前]
  tf edit <uuid> [--at …] [--to …|--for …] [--title …] [--where …] [--note …]
  tf rm <uuid> [--all]

  tf calendars
  tf accounts
  tf use <メール|id>

${DATE_HELP}
${WHEN_HELP}
${LONG_HELP}

  tf add 歯医者 --at "7/21 10:00" --for 1h --where 駅前歯科
  tf add 旅行 --at 8/1 --to 8/3
  tf edit 7110a578 --at "7/21 10:30"     ずらす。長さはそのまま

uuid は ls が出す先頭8文字で足ります（曖昧なら候補を出します）。

⚠ 共有カレンダーへの書き込みは他のメンバーに通知が飛びます。取り消せません。

起動しているアプリに訊きます。動いていなければ起動します（トレイに常駐します）。
ログインは要りません — アプリのものをそのまま使います。`;

async function main() {
  const args = parse(process.argv.slice(2));
  const cmd = args._[0];
  if (!cmd || cmd === 'help' || args.flags.help) { console.log(HELP); return; }

  const file = socketPath(userDataDir());
  let sock;
  let started = false;
  try { sock = await connect(file); } catch { sock = await startApp(file); started = true; }

  // The door opens before the app has finished syncing, and a half-synced app
  // answers "no events" — which is a lie, and the worst possible one for a
  // calendar. Wait for it. Only on a cold start: once it's up it stays synced.
  if (started && cmd !== 'ping' && cmd !== 'accounts') {
    const until = Date.now() + 60000;
    for (;;) {
      const p = await talk(sock, 'ping').catch(() => ({ ready: false }));
      if (p.ready) break;
      if (Date.now() > until) { sock.end(); return die('TimeForest の同期が終わりません。'); }
      await new Promise((r) => setTimeout(r, 300));
    }
  }

  const json = (d) => console.log(JSON.stringify(d, null, 2));

  try {
    switch (cmd) {
      case 'ping': json(await talk(sock, 'ping')); break;

      case 'accounts': {
        const r = await talk(sock, 'accounts');
        for (const a of r.accounts) {
          console.log(`${a.id === r.activeId ? '*' : ' '} ${a.name || '(名前なし)'}  ${dim(a.email || a.id)}`);
        }
        break;
      }

      case 'use': {
        if (!args._[1]) return die('使い方: tf use <メール|id>');
        const r = await talk(sock, 'use', { account: args._[1] });
        // Name the calendars, not just the account. That is the thing you
        // actually needed to know before typing the next command.
        console.log(`${r.account} に切り替えました  ${dim(r.calendars.join('、'))}`);
        break;
      }

      case 'calendars': {
        const r = await talk(sock, 'calendars');
        for (const c of r) console.log(`${c.enabled ? '*' : ' '} ${c.name}  ${dim(String(c.id))}`);
        break;
      }

      case 'ls': {
        // `tf ls today`, `tf ls week`, `tf ls 7/21` — and --from/--to still take
        // the same words, so `--from today --to +7d` reads the way you'd say it.
        const word = args._[1];
        let span = word ? dates.range(word) : null;
        if (word && !span) return die(`日付として読めません: ${word}
${DATE_HELP}`);
        const from = args.flags.from ? dates.day(val(args.flags, 'from')) : span?.from;
        const to = args.flags.to ? dates.day(val(args.flags, 'to')) : span?.to;
        if (args.flags.from && !from) return die(`--from が読めません: ${args.flags.from}
${DATE_HELP}`);
        if (args.flags.to && !to) return die(`--to が読めません: ${args.flags.to}
${DATE_HELP}`);
        const r = await talk(sock, 'ls', { from, to, cal: val(args.flags, 'cal') });
        if (args.flags.json) json(r); else printLs(r);
        break;
      }

      case 'find': {
        const q = args._.slice(1).join(' ').trim();
        if (!q) return die('使い方: tf find <語>\n\n  tf find 歯医者\n  tf find 駅前 --limit 5');
        const r = await talk(sock, 'find', { query: q, limit: val(args.flags, 'limit') });
        if (args.flags.json) return json(r);
        if (!r.events.length) {
          // Say where we looked. "Not found" is only an answer if you know the
          // question that was asked, and this one has a horizon.
          return console.log(dim(`「${r.query}」は ${r.from} 〜 ${r.to} に見つかりません`));
        }
        for (const e of r.events) {
          const when = e.allDay ? '終日   ' : `${e.startTime}–${e.endTime}`;
          const bits = [e.title];
          if (e.location) bits.push(dim(e.location));
          bits.push(dim('[' + e.calendar + ']'), dim(e.uuid.slice(0, 8)));
          console.log(`${bold(jpY(e.startKey))}  ${dim(when)}  ${bits.join('  ')}`);
        }
        console.log(dim(`\n${r.events.length}件  ${r.from} 〜 ${r.to} を探しました`));
        break;
      }

      case 'show': {
        if (!args._[1]) return die('使い方: tf show <uuid>');
        const r = await talk(sock, 'show', { uuid: args._[1] });
        if (args.flags.json) return json(r);
        const e = r.event;
        console.log(bold(e.title || '(無題)'));
        console.log(`  カレンダー  ${r.calendar}`);
        console.log(`  日時        ${stamp(e.start_at)} 〜 ${stamp(e.end_at)}${e.all_day ? ' (終日)' : ''}`);
        if (e.location) console.log(`  場所        ${e.location}`);
        if (e.note) console.log(`  メモ        ${e.note.replace(/\n/g, '\n              ')}`);
        if (e.recurrences?.length) console.log(`  繰り返し    ${e.recurrences.join(' / ')}`);
        break;
      }

      case 'comments': {
        if (!args._[1]) return die('使い方: tf comments <uuid>');
        const r = await talk(sock, 'comments', { uuid: args._[1] });
        if (args.flags.json) return json(r);
        if (!r.items.length) return console.log(dim('（何もありません）'));
        for (const a of r.items) {
          if (a.comment) console.log(`${bold(a.authorName || '(名前なし)')} ${dim(stamp(a.at))}${a.edited ? dim(' 編集済み') : ''}\n  ${a.text}`);
          else console.log(dim(`— ${a.authorName ? a.authorName + 'が' : ''}${a.text}  ${stamp(a.at)}`));
        }
        break;
      }

      case 'say': {
        const [, uuid, ...rest] = args._;
        const text = rest.join(' ').trim();
        if (!uuid || !text) return die('使い方: tf say <uuid> "コメント"');
        const r = await talk(sock, 'say', { uuid, text });
        console.log(`${r.calendar} の「${r.title}」に投稿しました`);
        break;
      }

      case 'add': {
        const f = args.flags;
        noStrayTime(args._.slice(1));
        const title = args._.slice(1).join(' ').trim();
        if (!title || !f.at) return die(`使い方: tf add <タイトル> --at <いつ> [--for 1h] [--cal 名前]

  tf add 歯医者 --at "7/21 10:00" --for 1h --where 駅前歯科
  tf add 旅行 --at 8/1 --to 8/3            # 時刻を書かなければ終日
${WHEN_HELP}`);
        const at = dates.when(val(f, 'at'));
        if (!at) return die(`--at が読めません: ${f.at}\n${WHEN_HELP}`);
        const to = f.to ? dates.when(val(f, 'to')) : null;
        if (f.to && !to) return die(`--to が読めません: ${f.to}\n${WHEN_HELP}`);

        // --for is the natural one to type for a timed event; --to is for spans.
        // The minutes go over as minutes: the clock arithmetic lives in the
        // renderer, which already owns it, and a second copy here would be a
        // second answer to what time an event really starts.
        let mins;
        if (f.for !== undefined) {
          mins = dates.mins(val(f, 'for'));
          if (mins == null) return die(`--for が読めません: ${f.for}\n${LONG_HELP}`);
        }

        const r = await talk(sock, 'add', {
          title, cal: val(f, 'cal'), mins,
          startKey: at.key, startTime: at.time,
          endKey: to?.key, endTime: to?.time,
          location: val(f, 'where'), note: val(f, 'note'),
        });
        if (f.json) return json(r);
        printSaved(r.calendar, r.event, '作成しました');
        break;
      }

      case 'edit': {
        const uuid = args._[1];
        const f = args.flags;
        noStrayTime(args._.slice(2));
        if (!uuid || !['title', 'at', 'to', 'for', 'where', 'note'].some((k) => f[k] !== undefined)) {
          return die(`使い方: tf edit <uuid> [--at …] [--for …] [--title …] [--where …] [--note …]

  tf edit 7110a578 --at "7/21 10:30"     # ずらす。長さはそのまま
  tf edit 7110a578 --for 90m
${WHEN_HELP}`);
        }
        const at = f.at ? dates.when(val(f, 'at')) : null;
        if (f.at && !at) return die(`--at が読めません: ${f.at}\n${WHEN_HELP}`);
        const to = f.to ? dates.when(val(f, 'to')) : null;
        if (f.to && !to) return die(`--to が読めません: ${f.to}\n${WHEN_HELP}`);
        let mins;
        if (f.for !== undefined) {
          mins = dates.mins(val(f, 'for'));
          if (mins == null) return die(`--for が読めません: ${f.for}\n${LONG_HELP}`);
        }

        const r = await talk(sock, 'edit', {
          uuid, at, to, mins,
          title: f.title === undefined ? undefined : val(f, 'title'),
          location: f.where === undefined ? undefined : val(f, 'where'),
          note: f.note === undefined ? undefined : val(f, 'note'),
        });
        if (f.json) return json(r);
        printSaved(r.calendar, r.event, `直しました  ${dim(r.changed.join(', '))}`);
        break;
      }

      case 'rm': {
        if (!args._[1]) return die('使い方: tf rm <uuid> [--all]');
        const r = await talk(sock, 'rm', { uuid: args._[1], all: !!args.flags.all });
        console.log(`${r.calendar} の「${r.title}」を削除しました${r.series ? dim('（繰り返し全部）') : ''}`);
        break;
      }

      default:
        console.error(`知らないコマンド: ${cmd}\n`);
        console.log(HELP);
        process.exitCode = 1;
    }
  } finally {
    sock.end();
  }
}

main().catch((e) => die(String(e.message || e)));
