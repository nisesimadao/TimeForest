#!/usr/bin/env node
/* End-to-end verification of the MCP server — by speaking the protocol to it.
 *
 * Hand-rolled JSON-RPC has one failure mode that matters: get a shape wrong and
 * the client shows nothing at all. No error, no tool, just an absence. So this
 * drives the real process over stdin/stdout and checks the exact shapes the
 * spec asks for.
 *
 * The one that will bite hardest is stdout discipline: stdout belongs to the
 * protocol, and a single stray console.log anywhere in the chain turns every
 * answer into a parse error.
 *
 * Usage: npm run verify:mcp
 *
 * SAFETY: refuses to run unless every calendar is the throwaway `dowa`.
 * add_comment posts for real, and on a shared calendar that notifies people.
 */
const { spawn } = require('node:child_process');
const path = require('node:path');

const SERVER = path.join(__dirname, '..', 'client', 'mcp.js');
const EXPECT_CALENDAR = 'dowa';

let pass = 0, fail = 0;
const ok = (m) => { pass++; console.log('  \x1b[32m✓\x1b[0m ' + m); };
const bad = (m) => { fail++; console.log('  \x1b[31m✗\x1b[0m ' + m); };
const sec = (t) => console.log('\n' + t);
const check = (c, m) => (c ? ok(m) : bad(m));

/** A live server, spoken to the way a client does. */
function client() {
  const proc = spawn(process.execPath, [SERVER], { stdio: ['pipe', 'pipe', 'pipe'] });
  let buf = '';
  const waiting = new Map();
  const notes = [];
  let stderr = '';

  proc.stdout.on('data', (chunk) => {
    buf += chunk;
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch {
        // The thing this test exists for: anything that isn't JSON on stdout
        // has already broken the client.
        notes.push({ garbage: line });
        continue;
      }
      if (msg.id !== undefined && waiting.has(msg.id)) { waiting.get(msg.id)(msg); waiting.delete(msg.id); }
      else notes.push(msg);
    }
  });
  proc.stderr.on('data', (d) => { stderr += d; });

  let id = 0;
  const rpc = (method, params) => new Promise((resolve, reject) => {
    const mine = ++id;
    const t = setTimeout(() => reject(new Error(`timeout: ${method}`)), 90000);
    waiting.set(mine, (m) => { clearTimeout(t); resolve(m); });
    proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: mine, method, params }) + '\n');
  });
  const notify = (method, params) => proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');

  return { rpc, notify, notes, stop: () => proc.kill(), stderrText: () => stderr };
}

const callTool = async (c, name, args) => {
  const r = await c.rpc('tools/call', { name, arguments: args || {} });
  const text = r.result?.content?.[0]?.text;
  let data = null;
  try { data = JSON.parse(text); } catch { /* isError replies are plain text */ }
  return { raw: r, isError: !!r.result?.isError, text, data, structured: r.result?.structuredContent };
};

(async () => {
  const c = client();

  // --- 1. the handshake -----------------------------------------------------
  sec('handshake');
  const init = await c.rpc('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'verify-mcp', version: '0' },
  });
  check(init.jsonrpc === '2.0' && !!init.result, 'initialize answers a JSON-RPC result');
  check(init.result?.protocolVersion === '2025-06-18',
    `and agrees on the version the client asked for (${init.result?.protocolVersion})`);
  check(!!init.result?.capabilities?.tools, 'and declares the tools capability');
  check(!!init.result?.serverInfo?.name, `and names itself (${init.result?.serverInfo?.name})`);
  c.notify('notifications/initialized');

  // A version we don't know must not be echoed back — the spec says answer with
  // one we do support, so the client can decide whether to disconnect.
  {
    const c2 = client();
    const r = await c2.rpc('initialize', { protocolVersion: '1.0.0', capabilities: {}, clientInfo: { name: 'x', version: '0' } });
    check(r.result?.protocolVersion !== '1.0.0' && !!r.result?.protocolVersion,
      `an unknown protocol version gets one we do support back (${r.result?.protocolVersion})`);
    c2.stop();
  }

  // --- 2. the tools ---------------------------------------------------------
  sec('tools/list');
  const list = await c.rpc('tools/list');
  const tools = list.result?.tools || [];
  check(tools.length > 0, `it lists tools (${tools.map((t) => t.name).join(', ')})`);
  check(tools.every((t) => t.name && t.description && t.inputSchema?.type === 'object'),
    'every tool has a name, a description and an object inputSchema');
  const write = tools.find((t) => t.name === 'add_comment');
  check(write?.annotations?.readOnlyHint === false,
    'add_comment is marked as not read-only, so a client can prompt before it posts');
  check(tools.find((t) => t.name === 'list_events')?.annotations?.readOnlyHint === true,
    'and list_events is marked read-only');

  // --- 3. safety ------------------------------------------------------------
  sec('safety guard');
  const cals = await callTool(c, 'list_calendars');
  const names = (cals.data || []).map((x) => x.name);
  if (!names.length || !names.every((n) => n === EXPECT_CALENDAR)) {
    console.error(`\n\x1b[31mABORT\x1b[0m: expected only "${EXPECT_CALENDAR}", got ${JSON.stringify(names)}`);
    console.error('add_comment posts for real, and on a shared calendar that notifies people.');
    c.stop();
    process.exit(2);
  }
  ok(`only "${EXPECT_CALENDAR}" is reachable (${JSON.stringify(names)})`);

  // --- 4. reading -----------------------------------------------------------
  sec('reading');
  const july = await callTool(c, 'list_events', { from: '2026-07-01', to: '2026-07-31' });
  check(!july.isError, 'list_events works');
  check(july.data?.events?.some((e) => e.holiday),
    `and the events are really there — 海の日 is in July (${july.data?.events?.length ?? '—'} events)`);
  check(!!july.structured?.events,
    'and it also sends structuredContent, so a client need not re-parse the text');

  const word = await callTool(c, 'list_events', { from: 'today', to: '+7d' });
  check(!word.isError && word.data?.from && word.data?.to,
    `dates take plain words (${word.data?.from}〜${word.data?.to})`);

  const badDate = await callTool(c, 'list_events', { from: 'ごはん' });
  check(badDate.isError && /読めません/.test(badDate.text),
    'a date it cannot read comes back as isError, so the model can fix it and retry');

  const noTool = await c.rpc('tools/call', { name: 'nope' });
  check(noTool.error?.code === -32602, `an unknown tool is a protocol error, not a tool result (${noTool.error?.code})`);

  // --- 5. writing -----------------------------------------------------------
  sec('writing');
  const seeded = await seed();
  check(!!seeded, 'seeded an event through the app');

  const found = await callTool(c, 'list_events', { from: '7/21', to: '7/21' });
  const mine = found.data?.events?.find((e) => e.title === 'MCP検証-歯医者');
  check(!!mine, 'the assistant can see an event the app just made');

  if (mine) {
    // Short uuid, because that is what an assistant will copy out of the list.
    const short = mine.uuid.slice(0, 8);
    const got = await callTool(c, 'get_event', { uuid: short });
    check(!got.isError && got.data?.event?.uuid === mine.uuid,
      'get_event takes the short uuid from the listing');

    const said = await callTool(c, 'add_comment', { uuid: short, text: 'MCPから' });
    check(!said.isError && said.data?.calendar === 'dowa',
      `add_comment posts, and names the calendar it landed in (${said.data?.calendar})`);

    const cm = await callTool(c, 'get_comments', { uuid: short });
    check(cm.data?.items?.some((a) => a.text === 'MCPから'),
      'and the comment is really there when read back');
  }

  // --- 6. stdout discipline -------------------------------------------------
  //
  // The whole protocol shares one pipe. Anything printed to stdout that isn't
  // JSON-RPC makes the client see a parse error instead of a tool, and this is
  // the exact path where it would happen: opening the app prints progress.
  sec('stdout belongs to the protocol');
  const junk = c.notes.filter((n) => n.garbage);
  check(junk.length === 0,
    junk.length ? `something non-JSON reached stdout: ${JSON.stringify(junk[0].garbage).slice(0, 80)}`
      : 'nothing but JSON-RPC ever reached stdout');

  await cleanup();
  c.stop();
  console.log(`\n${fail ? '\x1b[31m' : '\x1b[32m'}${pass} passed, ${fail} failed\x1b[0m`);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error('\n\x1b[31mVERIFY THREW\x1b[0m:', e.message);
  process.exit(1);
});

// --- helpers ----------------------------------------------------------------

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

const seed = () => withPage((page) => page.evaluate(async () => {
  const cal = [...TTX.store.state.enabled][0];
  const at = Date.UTC(2026, 6, 21, 5, 0);
  const e = await TTX.api.createEvent(cal, {
    title: 'MCP検証-歯医者', allDay: false, startAt: at, endAt: at + 3600000,
    tz: 'Asia/Tokyo', labelId: 1, location: '駅前',
  });
  TTX.store.applyEvent(cal, e);
  return e.uuid;
}));

const cleanup = () => withPage((page) => page.evaluate(async () => {
  const cal = [...TTX.store.state.enabled][0];
  for (const e of TTX.store.state.events.get(cal) || []) {
    if (/^MCP検証/.test(e.title || '') && !e.deactivated_at) {
      await TTX.api.deleteEvent(cal, e.uuid);
      TTX.store.markDeleted(cal, e.uuid);
    }
  }
}));
