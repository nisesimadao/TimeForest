#!/usr/bin/env node
/* TimeForest as an MCP server, so an assistant can read and write the calendar.
 *
 *   claude mcp add timeforest -- node E:/coding/TimeTree/client/mcp.js
 *
 * It is the CLI's twin: same door (client/rpc.js), same answers (cli-host.js in
 * the renderer), same reason. The app is a tray app, it already holds every
 * event in memory, and asking it costs 118ms where a separate process would
 * re-sync 4298 events first. Nothing about TimeTree's API lives in this file.
 *
 * Hand-rolled JSON-RPC rather than @modelcontextprotocol/sdk: this repo has no
 * build step and no dependencies, and the whole protocol we need is four
 * methods over newline-delimited JSON. The shapes below come from the spec
 * (2025-06-18), not from memory.
 *
 * ⚠ stdout belongs to the protocol. One stray console.log and the client sees
 *   a parse error instead of a tool — which is why nothing here prints, and why
 *   the door-opening code is duplicated from cli.js rather than imported: the
 *   CLI's version reports progress on stderr, and its die() calls process.exit.
 */
const net = require('node:net');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const readline = require('node:readline');
const { spawn } = require('node:child_process');
const { socketPath } = require('./rpc');
const dates = require('./dates');

const PROTOCOL = '2025-06-18';
const SUPPORTED = ['2025-06-18', '2025-03-26', '2024-11-05'];
const VERSION = '0.1.0';

/** Same mapping as cli.js. If these ever disagree, both talk to a profile that
 *  isn't there and report that the app is closed while it is running. */
function userDataDir() {
  const name = 'TimeForest';
  if (process.platform === 'win32') return path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), name);
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support', name);
  return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), name);
}

// --- the app ----------------------------------------------------------------

const connect = (file) => new Promise((resolve, reject) => {
  const s = net.connect(file);
  s.once('connect', () => resolve(s));
  s.once('error', reject);
});

let sock = null;
let nextId = 1;

async function open() {
  if (sock && !sock.destroyed) return sock;
  const file = socketPath(userDataDir());
  try { sock = await connect(file); return sock; } catch { /* not up yet */ }

  const root = __dirname;
  const electron = path.join(root, 'node_modules', 'electron', 'dist',
    process.platform === 'win32' ? 'electron.exe' : 'electron');
  if (!fs.existsSync(electron)) throw new Error('TimeForest が起動しておらず、起動もできません（electron が見つかりません）');
  spawn(electron, [root], { detached: true, stdio: 'ignore' }).unref();

  const until = Date.now() + 60000;
  for (;;) {
    try { sock = await connect(file); break; } catch { /* keep waiting */ }
    if (Date.now() > until) throw new Error('TimeForest を起動しましたが、応答がありません');
    await new Promise((r) => setTimeout(r, 250));
  }
  // The door opens before the app has synced, and a half-synced app answers
  // "no events" — which for a calendar is the worst possible lie, and an
  // assistant has no way to know it was told one.
  const ready = Date.now() + 60000;
  for (;;) {
    const p = await talk('ping').catch(() => ({ ready: false }));
    if (p.ready) break;
    if (Date.now() > ready) throw new Error('TimeForest の同期が終わりません');
    await new Promise((r) => setTimeout(r, 300));
  }
  return sock;
}

function talk(cmd, args) {
  return new Promise((resolve, reject) => {
    const id = nextId++;
    let buf = '';
    const done = (fn, v) => { sock.off('data', onData); sock.off('error', onErr); fn(v); };
    const onErr = (e) => done(reject, e);
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
    sock.write(JSON.stringify({ id, cmd, args }) + '\n');
  });
}

// --- tools ------------------------------------------------------------------

const DATE_WORDS = 'today, tomorrow, yesterday, week, nextweek, lastweek, month, nextmonth, '
  + '7/21, 2026-07-21, +7d, -3d';

const TOOLS = [
  {
    name: 'list_events',
    title: '予定を読む',
    description: 'List calendar events in a date range. Dates accept plain words: '
      + DATE_WORDS + '. Omit both to get the next 30 days. '
      + 'Every event comes back with a uuid — pass that to the other tools.',
    inputSchema: {
      type: 'object',
      properties: {
        from: { type: 'string', description: `Start of the range. ${DATE_WORDS}` },
        to: { type: 'string', description: `End of the range. ${DATE_WORDS}` },
        calendar: { type: 'string', description: 'Only this calendar, by name. Omit for all of them.' },
      },
    },
    annotations: { readOnlyHint: true },
    run: async (a) => {
      const from = a.from ? need(dates.day(a.from), a.from) : undefined;
      const to = a.to ? need(dates.day(a.to), a.to) : undefined;
      return talk('ls', { from, to, cal: a.calendar });
    },
  },
  {
    name: 'get_event',
    title: '予定の詳細',
    description: 'Everything stored on one event: times, location, note, recurrence, '
      + 'reminders, attendees. The uuid may be any prefix of one that list_events returned.',
    inputSchema: {
      type: 'object',
      properties: { uuid: { type: 'string', description: 'Event uuid, or any prefix of one' } },
      required: ['uuid'],
    },
    annotations: { readOnlyHint: true },
    run: (a) => talk('show', { uuid: a.uuid }),
  },
  {
    name: 'get_comments',
    title: 'コメントを読む',
    description: 'The conversation on an event, plus the record of who changed what. '
      + 'On a family calendar this is usually where the reason lives: the event says '
      + '"10:30 dentist", the comments say why it moved.',
    inputSchema: {
      type: 'object',
      properties: { uuid: { type: 'string', description: 'Event uuid, or any prefix of one' } },
      required: ['uuid'],
    },
    annotations: { readOnlyHint: true },
    run: (a) => talk('comments', { uuid: a.uuid }),
  },
  {
    name: 'add_comment',
    title: 'コメントする',
    description: 'Post a comment on an event. On a SHARED calendar this notifies the '
      + 'other members on their phones — it is not a draft and it cannot be silent. '
      + 'The reply names the calendar it landed in.',
    inputSchema: {
      type: 'object',
      properties: {
        uuid: { type: 'string', description: 'Event uuid, or any prefix of one' },
        text: { type: 'string', description: 'What to say' },
      },
      required: ['uuid', 'text'],
    },
    // Not destructive — it adds — but it is outward-facing, and a client that
    // only prompts on destructiveHint should still prompt on this.
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    run: (a) => talk('say', { uuid: a.uuid, text: a.text }),
  },
  {
    name: 'list_calendars',
    title: 'カレンダー一覧',
    description: 'The calendars the signed-in account can see.',
    inputSchema: { type: 'object', properties: {} },
    annotations: { readOnlyHint: true },
    run: () => talk('calendars'),
  },
  {
    name: 'list_accounts',
    title: 'アカウント一覧',
    description: 'The TimeTree accounts signed in to the app. Only one is active at a '
      + 'time, and every other tool answers about that one.',
    inputSchema: { type: 'object', properties: {} },
    annotations: { readOnlyHint: true },
    run: () => talk('accounts'),
  },
  {
    name: 'switch_account',
    title: 'アカウントを切り替える',
    description: 'Change which TimeTree account every other tool answers about. This '
      + 'also changes what the desktop window is showing — the person looking at it '
      + 'did not ask for that, so say what you are doing first. The reply names the '
      + 'calendars you land on.',
    inputSchema: {
      type: 'object',
      properties: { account: { type: 'string', description: 'Email, name, or id from list_accounts' } },
      required: ['account'],
    },
    annotations: { readOnlyHint: false, destructiveHint: false },
    run: (a) => talk('use', { account: a.account }),
  },
];

const need = (v, raw) => {
  if (!v) throw new Error(`日付として読めません: ${raw}\n使えるのは: ${DATE_WORDS}`);
  return v;
};

// --- json-rpc over stdio ----------------------------------------------------

const send = (msg) => process.stdout.write(JSON.stringify(msg) + '\n');
const reply = (id, result) => send({ jsonrpc: '2.0', id, result });
const fail = (id, code, message) => send({ jsonrpc: '2.0', id, error: { code, message } });

async function handle(msg) {
  const { id, method, params } = msg;

  if (method === 'initialize') {
    // Echo the client's version if we know it; otherwise name our latest and
    // let it decide. Per spec §Version Negotiation.
    const want = params?.protocolVersion;
    reply(id, {
      protocolVersion: SUPPORTED.includes(want) ? want : PROTOCOL,
      capabilities: { tools: {} },
      serverInfo: { name: 'timeforest', title: 'TimeForest', version: VERSION },
      instructions: 'TimeTree の家族カレンダーです。日付は today / week / 7/21 のように'
        + '書けます。予定の uuid は list_events が返します（先頭8文字でも通ります）。'
        + 'add_comment は共有カレンダーだと他のメンバーのスマホに通知が飛びます。',
    });
    return;
  }

  // Notifications have no id and want no answer.
  if (method === 'notifications/initialized' || method?.startsWith('notifications/')) return;

  if (method === 'ping') return reply(id, {});

  if (method === 'tools/list') {
    return reply(id, {
      tools: TOOLS.map(({ name, title, description, inputSchema, annotations }) =>
        ({ name, title, description, inputSchema, annotations })),
    });
  }

  if (method === 'tools/call') {
    const tool = TOOLS.find((t) => t.name === params?.name);
    if (!tool) return fail(id, -32602, `Unknown tool: ${params?.name}`);
    try {
      await open();
      const data = await tool.run(params.arguments || {});
      // Text as well as structured, per spec: a client that doesn't read
      // structuredContent still gets the answer rather than nothing.
      return reply(id, {
        content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
        structuredContent: data && typeof data === 'object' && !Array.isArray(data) ? data : { result: data },
      });
    } catch (e) {
      // isError, not a protocol error: the model should see this and be able to
      // fix it (a bad date, an ambiguous uuid) rather than the client swallowing
      // it as a transport fault.
      return reply(id, { content: [{ type: 'text', text: String(e?.message || e) }], isError: true });
    }
  }

  if (id !== undefined) fail(id, -32601, `Method not found: ${method}`);
}

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', async (line) => {
  if (!line.trim()) return;
  let msg;
  try { msg = JSON.parse(line); } catch { return fail(null, -32700, 'Parse error'); }
  try { await handle(msg); } catch (e) {
    if (msg?.id !== undefined) fail(msg.id, -32603, String(e?.message || e));
  }
});
rl.on('close', () => { sock?.end(); process.exit(0); });
