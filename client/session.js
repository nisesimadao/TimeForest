/* Accounts, partitions, and authenticated fetch — everything needed to talk to
 * TimeTree as a signed-in user, and nothing that needs a window.
 *
 * This exists so the CLI doesn't have to grow a second copy of it. The desktop
 * app's sessions live in Electron partitions (Chromium cookie jars under
 * userData), which a plain Node process can't read: they're SQLite encrypted
 * with DPAPI. So the CLI is an Electron process too, and reuses this. Nobody
 * logs in twice, and there is one place that knows how to be authenticated.
 *
 * Signing IN stays in main.js — it needs a real browser window.
 *
 *   const S = require('./session');
 *   S.pin();                       // before app.whenReady()
 *   await app.whenReady();
 *   S.load();
 *   const j = await S.apiJSON(S.active(), '/api/v1/calendars');
 */
const { app, session } = require('electron');
const path = require('node:path');
const fs = require('node:fs');

const ORIGIN = 'https://timetreeapp.com';
const CLIENT_TAG = 'web/2.1.0/ja';

// The single-account build used this fixed partition. Adopt it on first run so
// nobody has to sign in again just because the app learned about accounts.
const LEGACY_PARTITION = 'persist:timetree';

// Profiles written before the name was pinned. Ordered newest-first.
const LEGACY_USERDATA_DIRS = ['timeforest-client', 'timetree-client'];

/**
 * Electron's default UA advertises "Electron/x.y" and TimeTree greets it with
 * a full-width "お使いのブラウザはサポートされていません" banner across its own
 * sign-in page. We're a Chromium of the same vintage rendering the same page,
 * so present as one.
 */
const CHROME_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  `(KHTML, like Gecko) Chrome/${process.versions.chrome.split('.')[0]}.0.0.0 Safari/537.36`;

/**
 * Pin the app name, and with it userData.
 *
 * Electron derives userData from package.json's `name`. Renaming the package
 * therefore MOVES the whole profile — sessions, accounts, prefs — and the app
 * silently comes up as a stranger asking everyone to log in again. That
 * happened once here (timetree-client -> timeforest-client) and cost both
 * signed-in accounts.
 *
 * The CLI must call this too, and with the same string: it is the only reason
 * the CLI finds the sessions the app made. Must run before app.whenReady().
 */
const pin = () => app.setName('TimeForest');

const userData = () => app.getPath('userData');
const accountsFile = () => path.join(userData(), 'accounts.json');

/** @type {{id:string, partition:string, name:string, email:string, addedAt:number}[]} */
let accounts = [];
let activeId = null;

const csrfTokens = new Map();   // partition -> token
const configured = new Set();   // partitions whose UA is set

const find = (id) => accounts.find((a) => a.id === id) || null;
const active = () => find(activeId);
const all = () => accounts;
const activeIdOf = () => activeId;

function setActive(id) {
  if (!find(id)) throw new Error('unknown account: ' + id);
  activeId = id;
}

function sessionOf(acct) {
  const s = session.fromPartition(acct.partition);
  if (!configured.has(acct.partition)) {
    s.setUserAgent(CHROME_UA, 'ja-JP,ja');
    configured.add(acct.partition);
  }
  return s;
}

function save() {
  try {
    fs.writeFileSync(accountsFile(), JSON.stringify({ accounts, activeId }, null, 2));
  } catch (e) {
    console.error('[accounts] save failed', e);
  }
}

function load() {
  try {
    const j = JSON.parse(fs.readFileSync(accountsFile(), 'utf8'));
    accounts = Array.isArray(j.accounts) ? j.accounts : [];
    activeId = j.activeId && find(j.activeId) ? j.activeId : (accounts[0]?.id ?? null);
  } catch {
    accounts = [];
    activeId = null;
  }
  return accounts;
}

function publicAccounts() {
  return {
    accounts: accounts.map(({ id, name, email, addedAt }) => ({ id, name, email, addedAt })),
    activeId,
  };
}

/**
 * One-time move of a pre-pinning profile into the pinned location. Copies the
 * whole directory rather than cherry-picking: the session cookies live in
 * Partitions/, the renderer's prefs in Local Storage/, and missing either one
 * still looks like "logged out" to the user.
 *
 * Must run before app.whenReady() — once a session is instantiated its path is
 * fixed.
 */
function migrateUserData() {
  const target = userData();
  if (fs.existsSync(path.join(target, 'accounts.json'))) return;

  const parent = path.dirname(target);
  for (const name of LEGACY_USERDATA_DIRS) {
    const src = path.join(parent, name);
    if (src === target || !fs.existsSync(path.join(src, 'accounts.json'))) continue;
    try {
      fs.mkdirSync(target, { recursive: true });
      fs.cpSync(src, target, { recursive: true, force: false, errorOnExist: false });
      console.log(`[migrate] adopted profile from ${name} -> ${path.basename(target)}`);
      return;
    } catch (e) {
      console.error('[migrate] failed from ' + name, e.message);
    }
  }
}

/** Scrape the CSRF token out of the served HTML. Server-rendered, so no DOM. */
async function fetchCsrf(acct) {
  const res = await sessionOf(acct).fetch(`${ORIGIN}/calendars`, {
    credentials: 'include',
    redirect: 'follow',
  });
  const html = await res.text();
  const m = html.match(/<meta[^>]+name=["']csrf-token["'][^>]+content=["']([^"']+)["']/i)
         || html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+name=["']csrf-token["']/i);
  const token = m ? m[1] : null;
  if (token) csrfTokens.set(acct.partition, token);
  // Signed out means TimeTree bounces us to /signin — which still serves a
  // token, so the token alone proves nothing.
  return { token, signedIn: !/\/signin/.test(res.url) };
}

/**
 * NB: it must be `ses.fetch`, never `net.fetch`. net.fetch always uses the
 * DEFAULT session and silently ignores a `session` option — it reads an empty
 * cookie jar and reports "signed out" forever no matter how many times you log
 * in. With per-account partitions that trap is fatal rather than merely
 * confusing, so it is centralised here. scripts/check.js guards it.
 */
async function apiFetch(acct, pathname, method = 'GET', body) {
  if (!csrfTokens.has(acct.partition)) await fetchCsrf(acct);
  const send = () => sessionOf(acct).fetch(ORIGIN + pathname, {
    method,
    credentials: 'include',
    headers: {
      'content-type': 'application/json',
      'x-csrf-token': csrfTokens.get(acct.partition) || '',
      'x-timetreea': CLIENT_TAG,
      accept: 'application/json',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  let res = await send();
  // A stale/absent token reads as 400 {"error":{"code":-401}}.
  if (res.status === 400 || res.status === 401 || res.status === 403) {
    await fetchCsrf(acct);
    res = await send();
  }
  return res;
}

async function apiJSON(acct, pathname, method = 'GET', body) {
  const res = await apiFetch(acct, pathname, method, body);
  const text = await res.text();
  if (!res.ok) throw new Error(`API ${res.status} ${pathname} ${text.slice(0, 160)}`);
  if (!text) return null; // 204
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`API ${pathname}: 応答が JSON ではありません`);
  }
}

async function isSignedIn(acct) {
  try {
    const { signedIn, token } = await fetchCsrf(acct);
    if (!signedIn || !token) return false;
    const res = await apiFetch(acct, '/api/v1/calendars');
    return res.ok;
  } catch {
    return false;
  }
}

/** Who is this session? Name from /user, email from /auths for disambiguation. */
async function identify(acct) {
  const user = await apiJSON(acct, '/api/v1/user');
  let email = '';
  try {
    const auths = await apiJSON(acct, '/api/v1/auths');
    email = auths?.auths?.email?.uid || '';
  } catch { /* email is a nicety, not a requirement */ }
  return { name: user?.user?.name || 'TimeTree', email };
}

/* The list lives here and only here. Two owners of the same array is how the
 * file on disk and the process in memory start disagreeing about who is
 * signed in. */
function add(acct) {
  accounts.push(acct);
  activeId = acct.id;
  save();
  return acct.id;
}

function remove(id) {
  accounts = accounts.filter((a) => a.id !== id);
  if (activeId === id) activeId = accounts[0]?.id ?? null;
  save();
}

/** Adopt a pre-accounts session so upgrading doesn't force a re-login. */
async function adoptLegacy() {
  if (accounts.length) return null;
  const probe = { id: 'legacy', partition: LEGACY_PARTITION, name: '', email: '', addedAt: Date.now() };
  if (!(await isSignedIn(probe))) return null;
  const who = await identify(probe).catch(() => null);
  if (!who) return null;
  probe.name = who.name;
  probe.email = who.email;
  accounts = [probe];
  activeId = probe.id;
  save();
  return probe;
}

module.exports = {
  ORIGIN, CLIENT_TAG, CHROME_UA, LEGACY_PARTITION,
  pin, userData, accountsFile, migrateUserData,
  load, save, all, find, active, activeIdOf, setActive, add, remove,
  publicAccounts, adoptLegacy,
  sessionOf, fetchCsrf, apiFetch, apiJSON, isSignedIn, identify,
};
