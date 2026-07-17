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
  if (!n) console.log(dim(`${data.from} 〜 ${data.to} に予定はありません`));
  else console.log(dim(`\n${n}件  ${data.from} 〜 ${data.to}`));
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

const HELP = `TimeForest — TimeTree を端末から

  tf ls [today|week|month|7/21] [--from …] [--to …] [--cal 名前] [--json]
  tf show <uuid> [--json]
  tf comments <uuid> [--json]
  tf say <uuid> "コメント"
  tf calendars
  tf accounts
  tf use <メール|id>

${DATE_HELP}

uuid は ls が出す先頭8文字で足ります（曖昧なら候補を出します）。

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
        const from = args.flags.from ? dates.day(args.flags.from) : span?.from;
        const to = args.flags.to ? dates.day(args.flags.to) : span?.to;
        if (args.flags.from && !from) return die(`--from が読めません: ${args.flags.from}
${DATE_HELP}`);
        if (args.flags.to && !to) return die(`--to が読めません: ${args.flags.to}
${DATE_HELP}`);
        const r = await talk(sock, 'ls', { from, to, cal: args.flags.cal });
        if (args.flags.json) json(r); else printLs(r);
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
