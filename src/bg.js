/* --- TimeTree API, routed through the worker -------------------------------
 *
 * The content script lives in the page's ISOLATED world, where a same-origin
 * fetch to TimeTree INTERMITTENTLY hangs — the same request that answers 200 in
 * one run never settles in the next, presumably contending with the page's own
 * Service Worker. The worker context has no such contention. So the content
 * script installs a transport (TTX.api.setTransport) that forwards every api.js
 * request() here, and THIS side performs the fetch: the user's cookies ride
 * along via host_permissions + credentials:'include', exactly as the map fetch
 * below does. We load the SAME api.js rather than a second copy so headers, the
 * csrf handshake and error handling stay identical — request() with no
 * transport of its own does the real fetch, and csrfToken() scrapes the token
 * from the /calendars HTML (a worker has no DOM), which it already supports. */
// api.js does the network; tz/recur/model expand events into occurrences and
// compute alert fire-times for reminders (same libs the renderer uses — they're
// DOM-agnostic, verified by scripts/check.js). Order matters: recur needs tz,
// model needs tz + recur.
importScripts(
  chrome.runtime.getURL('src/lib/tz.js'),
  chrome.runtime.getURL('src/lib/recur.js'),
  chrome.runtime.getURL('src/lib/api.js'),
  chrome.runtime.getURL('src/lib/model.js'),
);

/* Toolbar button and keyboard shortcuts -> tell the content script. */
const send = async (msg) => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.url?.startsWith('https://timetreeapp.com/')) {
    chrome.tabs.sendMessage(tab.id, msg).catch(() => {});
  }
};

chrome.action.onClicked.addListener(() => send('ttx:agenda'));
chrome.commands?.onCommand.addListener((cmd) => {
  if (cmd === 'toggle-agenda') send('ttx:agenda');
  if (cmd === 'toggle-dark') send('ttx:dark');
});

/* --- maps -----------------------------------------------------------------
 *
 * The extension's map picker (over TimeTree's own event form) needs OSM tiles
 * and Nominatim search. This is the extension's version of the desktop's
 * client/main.js map handlers, and it lives here for the same reasons that one
 * lived in the main process:
 *
 *   1. Tiles come back as data: URIs, so the content script's page — whose CSP
 *      is TimeTree's, not ours — never has to be allowed to load a tile CDN.
 *   2. The extension talked to exactly one host (timetreeapp.com). Maps make it
 *      three. Keeping that in one auditable place, behind a single switch, beats
 *      sprinkling host access through the content script.
 *
 * One thing the desktop could do and this can't: set a User-Agent. MV3 forbids
 * it on fetch. Measured against the real services from a Chrome context: tiles
 * and Nominatim both answer 200 without one. (If OSM ever tightens that, the
 * switch is already the single place to notice.)
 *
 * The map is ON by default (requested). The flag still lives in chrome.storage,
 * so an explicit off is possible; only then does the content script re-ask before
 * the next OSM request (telling OSM roughly where the family's events are).
 */
const OSM_TILES = 'https://tile.openstreetmap.org';
const NOMINATIM = 'https://nominatim.openstreetmap.org/search';
const tileCache = new Map();
const TILE_CACHE_MAX = 400;

/* OSM's tile policy requires a User-Agent that identifies the app. MV3 forbids
 * setting it on fetch, and — measured, painfully — OSM does NOT reject an
 * unidentified request with an error. It returns an "Access blocked" PNG with
 * status 200 (every one exactly 6987 bytes; a real Tokyo tile is ~33KB). So the
 * fetch looked fine and drew a blocked image.
 *
 * declarativeNetRequest CAN set the header that fetch cannot. One rule rewrites
 * the User-Agent on requests to OSM's two hosts. Registered once at startup;
 * cleared first so a reload doesn't stack duplicates. */
const OSM_UA = `TimeForest/${chrome.runtime.getManifest().version} (unofficial TimeTree extension)`;

/* Rule 1 (OSM UA): see above. Rule 2 (TimeTree Origin): when api.js runs HERE
 * — see the API-routing note at the top — the worker's fetch carries
 * `Origin: chrome-extension://<id>`. TimeTree's WRITE endpoints reject a foreign
 * Origin with 422 {"code":-1} (reads don't check it, writes do — measured). fetch
 * can't set Origin (a forbidden header), but declarativeNetRequest can, so we
 * rewrite it to the site's own origin. On the page's own requests this is a
 * no-op (they already carry it); on the worker's it's what makes writes work. */
async function installHeaderRules() {
  try {
    const existing = await chrome.declarativeNetRequest.getDynamicRules();
    await chrome.declarativeNetRequest.updateDynamicRules({
      removeRuleIds: existing.map((r) => r.id),
      addRules: [{
        id: 1,
        priority: 1,
        condition: {
          requestDomains: ['tile.openstreetmap.org', 'nominatim.openstreetmap.org'],
          resourceTypes: ['xmlhttprequest'],
        },
        action: {
          type: 'modifyHeaders',
          requestHeaders: [{ header: 'user-agent', operation: 'set', value: OSM_UA }],
        },
      }, {
        id: 2,
        priority: 1,
        condition: {
          requestDomains: ['timetreeapp.com'],
          resourceTypes: ['xmlhttprequest'],
        },
        action: {
          type: 'modifyHeaders',
          requestHeaders: [
            { header: 'origin', operation: 'set', value: 'https://timetreeapp.com' },
            { header: 'referer', operation: 'set', value: 'https://timetreeapp.com/' },
          ],
        },
      }],
    });
  } catch (e) { /* older Chrome without DNR header edit — writes/tiles may fail */ }
}
installHeaderRules();

// On by default (requested); only an explicit false disables it.
const mapsOn = () => chrome.storage.local.get('maps').then((s) => s.maps !== false);

async function tile(z, x, y) {
  if (!(await mapsOn())) throw new Error('maps off');
  if (![z, x, y].every((n) => Number.isInteger(n) && n >= 0) || z > 19) throw new Error('bad tile');
  const key = `${z}/${x}/${y}`;
  if (tileCache.has(key)) return tileCache.get(key);
  const res = await fetch(`${OSM_TILES}/${key}.png`);
  if (!res.ok) throw new Error('tile ' + res.status);
  const buf = await res.arrayBuffer();
  // btoa on the raw bytes — a service worker has no Buffer.
  let bin = '';
  const bytes = new Uint8Array(buf);
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  const uri = 'data:image/png;base64,' + btoa(bin);
  if (tileCache.size >= TILE_CACHE_MAX) tileCache.delete(tileCache.keys().next().value);
  tileCache.set(key, uri);
  return uri;
}

async function search(q) {
  if (!(await mapsOn())) throw new Error('maps off');
  const query = String(q || '').trim();
  if (query.length < 2) return [];
  const u = new URL(NOMINATIM);
  u.searchParams.set('q', query);
  u.searchParams.set('format', 'jsonv2');
  u.searchParams.set('limit', '8');
  u.searchParams.set('accept-language', 'ja');
  const res = await fetch(u);
  if (!res.ok) throw new Error('search ' + res.status);
  const j = await res.json();
  return (Array.isArray(j) ? j : []).map((r) => ({
    name: r.name || r.display_name.split(',')[0],
    address: r.display_name,
    lat: Number(r.lat),
    lon: Number(r.lon),
  }));
}

/* --- account switching (session-cookie swap) ------------------------------
 *
 * TimeTree's web app has no account switcher — one browser session, one
 * account. The desktop client gets multiple accounts by giving each its own
 * Electron partition (a separate cookie jar). An extension shares the browser's
 * single cookie jar for timetreeapp.com, so it can't do that. What it CAN do is
 * remember each account's `_session_id` and swap the live cookie: set it to the
 * chosen account's value and reload, and the site is that account — a real login
 * switch, not a shadow view.
 *
 * Only the service worker can touch cookies (chrome.cookies exists nowhere else),
 * which is why this lives here rather than in a content-script lib. Accounts are
 * keyed by TimeTree user id and carry the session token verbatim; that token is
 * the login, so it never leaves storage, never rides a log line, never reaches a
 * page. It's the same secret host_permissions already lets this extension send on
 * every API call — held now so switching is possible, not newly exposed.
 *
 * Sessions rotate. The content script asks for a `capture` on every boot, which
 * refreshes whoever is signed in and auto-adds a newly-logged-in account — so
 * each account's stored token is as fresh as its last page load. If a token
 * rotates mid-session with no reload and you switch away and back, that one is
 * stale; TimeTree then shows its sign-in page (where this switcher isn't
 * mounted), and logging into that account re-captures it. */
const SESSION_COOKIE = '_session_id';
const TT_URL = 'https://timetreeapp.com/';
const TT_TABS = 'https://timetreeapp.com/*';
const ACCTS_KEY = 'ttx_accounts';

const readSessionCookie = () => chrome.cookies.get({ url: TT_URL, name: SESSION_COOKIE });

/** Swap only the value; keep the live cookie's own domain/path/flags so the site
 *  treats it identically to one it set itself. A hostOnly cookie must NOT carry a
 *  domain (that would turn it into a broader domain cookie), hence the guard. */
async function writeSessionCookie(value) {
  const cur = await readSessionCookie();
  const details = {
    url: TT_URL,
    name: SESSION_COOKIE,
    value,
    path: cur?.path || '/',
    secure: cur?.secure ?? true,
    httpOnly: cur?.httpOnly ?? true,
    // TimeTree's own _session_id is SameSite=None (measured: "no_restriction");
    // match it when recreating one into an empty jar rather than downgrading.
    sameSite: cur?.sameSite || 'no_restriction',
  };
  if (cur && !cur.hostOnly && cur.domain) details.domain = cur.domain;
  // Deliberately NOT copying expirationDate: _session_id is a session cookie (no
  // expiry, measured), and copying the OUTGOING account's expiry onto the
  // incoming token would stamp the wrong lifetime the day TimeTree sets one.
  await chrome.cookies.set(details);
}

const getAccounts = () => chrome.storage.local.get(ACCTS_KEY).then((s) => s[ACCTS_KEY] || {});

/* chrome.storage has no transaction, and several paths mutate the accounts map
 * (boot capture, forget). A bare get→modify→set lets a concurrent capture and
 * forget read the same snapshot and clobber each other — a just-removed account
 * (its token) reappears, or a fresh capture is dropped. Serialise every
 * read-modify-write through one chain so they can't interleave. */
let storeChain = Promise.resolve();
function mutateAccounts(fn) {
  const run = storeChain.then(async () => {
    const accts = await getAccounts();
    const ret = await fn(accts);                 // fn mutates accts in place
    await chrome.storage.local.set({ [ACCTS_KEY]: accts });
    return ret;
  });
  storeChain = run.then(() => {}, () => {});     // keep the chain alive past any failure
  return run;
}

// me() carries a display `name` and nothing else human — measured: no email, no
// nickname (the throwaway has name:""). So label by name, and when it's blank
// fall back to the id's last four digits rather than the bare id, which reads as
// an account rather than a database key.
const accountLabel = (me) => (me.name && me.name.trim()) || ('アカウント ' + String(me.id).slice(-4));

/** Record whoever is signed in right now, labelled by their TimeTree profile.
 *  Returns null when signed out or unidentifiable — we never store a nameless
 *  token, since a switcher row you can't recognise is worse than none. */
async function captureCurrent() {
  const before = await readSessionCookie();
  if (!before?.value) return null;
  const me = await self.TTX.api.me().catch(() => null);
  if (me?.id == null) return null;               // == null: an id of 0 is still an id
  // me() rode whatever cookie was live at fetch time. If a switch landed while it
  // was in flight, that identity belongs to a DIFFERENT token than the one we
  // read — storing it would label this id with another account's session. Only
  // commit when the live cookie is still the one me() actually used.
  const after = await readSessionCookie();
  if (after?.value !== before.value) return null;
  return mutateAccounts((accts) => {
    accts[me.id] = { id: me.id, name: accountLabel(me), sessionId: before.value };
    return { id: me.id, name: accts[me.id].name };
  });
}

/** Accounts for the menu, each flagged active if its token is the live cookie. */
async function listAccounts() {
  const [accts, cur] = await Promise.all([getAccounts(), readSessionCookie()]);
  const live = cur?.value || null;
  return Object.values(accts)
    .map((a) => ({ id: a.id, name: a.name, active: a.sessionId === live }))
    .sort((x, y) => (y.active ? 1 : 0) - (x.active ? 1 : 0) || String(x.name).localeCompare(String(y.name)));
}

/** Make `id` the signed-in account: write its token, warm a fresh CSRF, and
 *  reload EVERY TimeTree tab. The cookie jar is shared across tabs, so one left
 *  un-reloaded would keep showing the old account while its next request already
 *  rides the new one's cookie — a silent wrong-account read or write on a shared
 *  calendar. (The outgoing account isn't re-captured here: boot capture already
 *  keeps it fresh, and doing it now would put a me() round-trip on the critical
 *  path of every switch, slowest exactly when that session is degraded.) */
async function switchTo(id) {
  const accts = await getAccounts();
  const target = accts[id];
  if (!target) throw new Error('unknown account');
  await writeSessionCookie(target.sessionId);
  self.TTX.api.csrfToken(true).catch(() => {});     // worker's cached CSRF belonged to the old account
  const tabs = await chrome.tabs.query({ url: TT_TABS }).catch(() => []);
  for (const t of tabs) if (t.id != null) chrome.tabs.reload(t.id).catch(() => {});
  return { id: target.id, name: target.name };
}

/** Drop an account from the switcher — but never the live one. That's the
 *  account you're using; the UI hides its × and this mirrors the rule
 *  worker-side, so a stray message can't delete the session in use. */
async function forgetAccount(id) {
  const cur = await readSessionCookie();
  return mutateAccounts((accts) => {
    if (accts[id] && accts[id].sessionId === cur?.value) return false;
    delete accts[id];
    return true;
  });
}

// Exposed on self so the mechanism can be exercised directly (service-worker
// E2E) without driving the UI; the message handler below is the real entry.
self.ttxSession = { readSessionCookie, writeSessionCookie, captureCurrent, listAccounts, switchTo, forgetAccount };

/* --- reminders (chrome.alarms + chrome.notifications) ----------------------
 *
 * TimeTree's servers already push reminders to the user's PHONE; this fires the
 * same ones on the desktop while Chrome is running — the browser counterpart to
 * the Electron client's "while I'm open" reminders. The renderer decides WHEN
 * from the events and each event's `alerts`; this is that scheduler
 * (client/renderer/app.js checkAlerts) moved into the worker, using the identical
 * model.occurrences / model.alertAt / api.alertLabel.
 *
 * A service worker can't hold a setInterval — it's evicted when idle — so a
 * periodic chrome.alarm (min 1 min) wakes it. Each tick expands the cached events
 * around now and fires any alert whose moment has just passed (within GRACE, so a
 * throttled/slept tick doesn't drop one). Off by default: reminders are opt-in
 * (a second stream on top of TimeTree's own phone push), armed by the 🔔 toggle. */
const NOTIFY_ALARM = 'ttx-notify';
const NOTIFY_KEY = 'notify';                     // storage flag (default false)
const FIRED_KEY = 'ttx_notify_fired';            // { key: firedAtMs } — dedupe across worker restarts
const EVENTS_KEY = 'ttx_notify_events';          // { at, cals: [{ id, name, alias, raw:[…] }] }
const NOTIFY_TZ = 'Asia/Tokyo';
const GRACE = 5 * 60 * 1000;                     // "missed while closed is missed" (mirror the client)
const EVENTS_TTL = 10 * 60 * 1000;               // re-fetch events at most this often
const ALERT_HORIZON = 8 * 24 * 60 * 60 * 1000;   // an alert can precede its event by ~7d (all-day 7日前)
const FIRED_TTL = 2 * 24 * 60 * 60 * 1000;       // forget fired keys after 2 days

const notifyOn = () => chrome.storage.local.get(NOTIFY_KEY).then((s) => s[NOTIFY_KEY] === true);

/** Cache the alert-bearing events for every calendar. Only events that carry
 *  `alerts` can ever notify, so the rest are dropped; each is slimmed to the
 *  fields the expander reads, keeping the stored cache small. Recurring masters
 *  are kept regardless of date — they expand into future occurrences. */
async function refreshEvents(force = false) {
  const prev = (await chrome.storage.local.get(EVENTS_KEY))[EVENTS_KEY];
  if (!force && prev && (Date.now() - prev.at) < EVENTS_TTL) return prev;
  const cals = await self.TTX.api.calendars();
  const outCals = [];
  for (const cal of cals) {
    const raw = await self.TTX.api.allEvents(cal.id).catch(() => []);
    const kept = raw
      .filter((e) => Array.isArray(e.alerts) && e.alerts.length && !e.deactivated_at)
      .map((e) => ({
        uuid: e.uuid, title: e.title, all_day: e.all_day,
        start_at: e.start_at, end_at: e.end_at,
        start_timezone: e.start_timezone, end_timezone: e.end_timezone,
        recurrences: e.recurrences || [], recurring_uuid: e.recurring_uuid,
        alerts: e.alerts, location: e.location || '', category: e.category,
        calendar_id: cal.id,
      }));
    outCals.push({ id: cal.id, name: cal.name, alias: cal.alias_code, raw: kept });
  }
  const cache = { at: Date.now(), cals: outCals };
  await chrome.storage.local.set({ [EVENTS_KEY]: cache }).catch(() => {});
  return cache;
}

/** Alerts whose fire-time just passed (in the GRACE window), across all calendars.
 *  Mirrors app.js dueAlerts: expand occurrences, then each occurrence's raw
 *  event's `alerts` give the minutes-before, and model.alertAt the instant. */
function dueAlerts(cache, now) {
  const out = [];
  for (const cal of cache.cals) {
    const rawByUuid = new Map(cal.raw.map((e) => [e.uuid, e]));
    const occs = self.TTX.model.occurrences(
      cal.raw, now - GRACE, now + ALERT_HORIZON,
      { id: cal.id, name: cal.name, calendar_labels: [] }, {},
    );
    for (const o of occs) {
      if (o.holiday || !o.calendarId) continue;
      const raw = rawByUuid.get(o.uuid);
      for (const m of raw?.alerts || []) {
        const at = self.TTX.model.alertAt(o, m, NOTIFY_TZ);
        if (at <= now && at > now - GRACE) out.push({ cal, o, m, at });
      }
    }
  }
  return out;
}

async function checkAlerts() {
  if (!(await notifyOn())) return;
  const cache = await refreshEvents().catch(() => null);
  if (!cache) return;
  const now = Date.now();
  const fired = (await chrome.storage.local.get(FIRED_KEY))[FIRED_KEY] || {};
  let dirty = false;
  for (const { cal, o, m, at } of dueAlerts(cache, now)) {
    const key = `${o.uuid}@${o.start}#${m}`;
    if (fired[key]) continue;
    fired[key] = at;
    dirty = true;
    const when = o.allDay ? '終日' : `${o.startTime}〜${o.endTime}`;
    const body = [self.TTX.api.alertLabel(m, o.allDay), when, o.location].filter(Boolean).join(' · ');
    // The alias rides in the notification id so a click can open that calendar
    // even after the worker was evicted and restarted (no in-memory lookup).
    const nid = `ttx~${cal.alias || '-'}~${key}`;
    chrome.notifications.create(nid, {
      type: 'basic',
      iconUrl: chrome.runtime.getURL('icons/icon-128.png'),
      title: o.title || '(無題)',
      message: body || cal.name,
    });
  }
  if (dirty) {
    for (const k of Object.keys(fired)) if (fired[k] < now - FIRED_TTL) delete fired[k];
    await chrome.storage.local.set({ [FIRED_KEY]: fired }).catch(() => {});
  }
}

/** Arm or disarm the periodic tick to match the stored flag. */
async function syncNotifyAlarm() {
  if (await notifyOn()) chrome.alarms.create(NOTIFY_ALARM, { periodInMinutes: 1 });
  else chrome.alarms.clear(NOTIFY_ALARM);
}

async function setNotify(on) {
  await chrome.storage.local.set({ [NOTIFY_KEY]: on === true });
  await syncNotifyAlarm();
  if (on === true) checkAlerts().catch(() => {});   // don't wait a whole minute for the first tick
  return on === true;
}

chrome.alarms.onAlarm.addListener((a) => { if (a.name === NOTIFY_ALARM) checkAlerts().catch(() => {}); });
// Re-arm after a browser restart / update (alarms persist, but this covers a
// cleared-alarms edge and a freshly-installed worker reading an on flag).
chrome.runtime.onStartup?.addListener(() => { syncNotifyAlarm(); });
chrome.runtime.onInstalled?.addListener(() => { syncNotifyAlarm(); });
syncNotifyAlarm();   // worker cold-start

chrome.notifications.onClicked.addListener(async (id) => {
  const alias = String(id || '').startsWith('ttx~') ? id.split('~')[1] : '';
  const url = alias && alias !== '-' ? `https://timetreeapp.com/calendars/${alias}` : 'https://timetreeapp.com/';
  const [tab] = await chrome.tabs.query({ url: 'https://timetreeapp.com/*' }).catch(() => []);
  if (tab) { chrome.tabs.update(tab.id, { active: true, url }).catch(() => {}); chrome.windows.update(tab.windowId, { focused: true }).catch(() => {}); }
  else chrome.tabs.create({ url }).catch(() => {});
  chrome.notifications.clear(id);
});

self.ttxNotify = { refreshEvents, dueAlerts, checkAlerts, setNotify, notifyOn, syncNotifyAlarm };

// The content script can't fetch OSM itself (its page CSP forbids it and it has
// no host access), so it asks here. One message channel, several verbs.
chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  if (msg?.ttx === 'tile') { tile(msg.z, msg.x, msg.y).then((uri) => reply({ uri }), (e) => reply({ err: String(e && e.message || e) })); return true; }
  if (msg?.ttx === 'search') { search(msg.q).then((list) => reply({ list }), (e) => reply({ err: String(e && e.message || e) })); return true; }
  // The isolated world's fetch hangs here instead — see the header note.
  if (msg?.ttx === 'api') { self.TTX.api.request(msg.method, msg.path, msg.body).then((json) => reply({ json }), (e) => reply({ err: String(e && e.message || e) })); return true; }
  if (msg?.ttx === 'session') {
    const op = msg.op;
    const done = (p) => { p.then((r) => reply({ ok: r }), (e) => reply({ err: String(e && e.message || e) })); return true; };
    if (op === 'list') return done(listAccounts());
    if (op === 'capture') return done(captureCurrent());
    if (op === 'switch') return done(switchTo(msg.id));
    if (op === 'forget') return done(forgetAccount(msg.id));
    return false;
  }
  if (msg?.ttx === 'notify') {
    const done = (p) => { p.then((r) => reply({ ok: r }), (e) => reply({ err: String(e && e.message || e) })); return true; };
    if (msg.op === 'get') return done(notifyOn());
    if (msg.op === 'set') return done(setNotify(msg.on));
    return false;
  }
  return false;
});
