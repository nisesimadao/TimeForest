/* Electron main process.
 *
 * Three jobs the renderer can't do itself:
 *
 * 1. Auth. We never see a password. A real TimeTree login page opens in a
 *    normal window; the user signs in there (email, Apple, Google, Facebook —
 *    whatever they already use) and TimeTree sets its own session cookie in
 *    that account's partition. Same shape as signing in to a browser. This
 *    process only ever reads the CSRF token out of the served HTML.
 *
 * 2. Accounts. Each account gets its own `persist:tt-<id>` partition, which is
 *    a fully separate cookie jar. Switching accounts is just switching which
 *    partition we talk to — no logout, no re-login, and no chance of one
 *    account's session leaking into another's requests.
 *
 * 3. CORS. The renderer runs on file://, so a direct fetch to timetreeapp.com
 *    is blocked. `session.fetch` runs here against the account's cookie jar, so
 *    it is both authenticated and unblocked.
 *
 *    NB: it must be `ses.fetch`, never `net.fetch`. net.fetch always uses the
 *    DEFAULT session and silently ignores a `session` option — it reads an
 *    empty cookie jar and reports "signed out" forever no matter how many
 *    times you log in. With per-account partitions that trap is now fatal
 *    rather than merely confusing, so it is centralised in apiFetch() below.
 */
const { app, BrowserWindow, ipcMain, session, shell, nativeTheme, Notification, Tray, Menu, nativeImage } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');

const ORIGIN = 'https://timetreeapp.com';
const CLIENT_TAG = 'web/2.1.0/ja';
const DEV = process.argv.includes('--dev');

// The single-account build used this fixed partition. Adopt it on first run so
// nobody has to sign in again just because the app learned about accounts.
const LEGACY_PARTITION = 'persist:timetree';

/**
 * Pin the app name, and with it userData.
 *
 * Electron derives userData from package.json's `name`. Renaming the package
 * therefore MOVES the whole profile — sessions, accounts, prefs — and the app
 * silently comes up as a stranger asking everyone to log in again. That
 * happened once here (timetree-client -> timeforest-client) and cost both
 * signed-in accounts. Pinning it means the package can be renamed freely and
 * the profile stays put.
 */
app.setName('TimeForest');

const userData = () => app.getPath('userData');
const ACCOUNTS_FILE = () => path.join(userData(), 'accounts.json');
const STATE_FILE = () => path.join(userData(), 'window-state.json');

// Profiles written before the name was pinned. Ordered newest-first.
const LEGACY_USERDATA_DIRS = ['timeforest-client', 'timetree-client'];

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

/** @type {{id:string, partition:string, name:string, email:string, addedAt:number}[]} */
let accounts = [];
let activeId = null;

const csrfTokens = new Map();   // partition -> token

let mainWindow = null;
let authWindow = null;

// --- accounts --------------------------------------------------------------

/**
 * Electron's default UA advertises "Electron/x.y" and TimeTree greets it with
 * a full-width "お使いのブラウザはサポートされていません" banner across its own
 * sign-in page — the first thing a new user would see. We're a Chromium of the
 * same vintage rendering the same page, so present as one. Applied to the whole
 * session so the login window and the API calls agree about who we are.
 */
const CHROME_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  `(KHTML, like Gecko) Chrome/${process.versions.chrome.split('.')[0]}.0.0.0 Safari/537.36`;

const configured = new Set();

const findAccount = (id) => accounts.find((a) => a.id === id) || null;
const activeAccount = () => findAccount(activeId);

function sessionOf(acct) {
  const s = session.fromPartition(acct.partition);
  if (!configured.has(acct.partition)) {
    s.setUserAgent(CHROME_UA, 'ja-JP,ja');
    configured.add(acct.partition);
  }
  return s;
}

function publicAccounts() {
  return {
    accounts: accounts.map(({ id, name, email, addedAt }) => ({ id, name, email, addedAt })),
    activeId,
  };
}

function saveAccounts() {
  try {
    fs.writeFileSync(ACCOUNTS_FILE(), JSON.stringify({ accounts, activeId }, null, 2));
  } catch (e) {
    console.error('[accounts] save failed', e);
  }
}

function loadAccounts() {
  try {
    const j = JSON.parse(fs.readFileSync(ACCOUNTS_FILE(), 'utf8'));
    accounts = Array.isArray(j.accounts) ? j.accounts : [];
    activeId = j.activeId && findAccount(j.activeId) ? j.activeId : (accounts[0]?.id ?? null);
  } catch {
    accounts = [];
    activeId = null;
  }
}

/** Adopt a pre-accounts session so upgrading doesn't force a re-login. */
async function adoptLegacySession() {
  if (accounts.length) return;
  const probe = { id: 'legacy', partition: LEGACY_PARTITION, name: '', email: '', addedAt: Date.now() };
  if (!(await isSignedIn(probe))) return;
  const who = await identify(probe).catch(() => null);
  if (!who) return;
  probe.name = who.name;
  probe.email = who.email;
  accounts = [probe];
  activeId = probe.id;
  saveAccounts();
  console.log('[accounts] adopted legacy session for', who.name);
}

async function addAccount() {
  const id = crypto.randomUUID();
  const acct = { id, partition: `persist:tt-${id}`, name: '', email: '', addedAt: Date.now() };
  const ok = await openLogin(acct);
  if (!ok) return null;

  const who = await identify(acct).catch(() => ({ name: 'TimeTree', email: '' }));
  acct.name = who.name;
  acct.email = who.email;

  // Signing into an account that's already here should just select it.
  const dupe = accounts.find((a) => a.email && a.email === acct.email);
  if (dupe) {
    await session.fromPartition(acct.partition).clearStorageData();
    activeId = dupe.id;
    saveAccounts();
    return dupe.id;
  }

  accounts.push(acct);
  activeId = id;
  saveAccounts();
  return id;
}

async function switchAccount(id) {
  if (!findAccount(id)) throw new Error('unknown account: ' + id);
  activeId = id;
  saveAccounts();
  return publicAccounts();
}

async function removeAccount(id) {
  const acct = findAccount(id);
  if (!acct) return publicAccounts();
  // Legacy partition is shared with nothing else, so clearing it is safe too.
  await session.fromPartition(acct.partition).clearStorageData().catch(() => {});
  csrfTokens.delete(acct.partition);
  accounts = accounts.filter((a) => a.id !== id);
  if (activeId === id) activeId = accounts[0]?.id ?? null;
  saveAccounts();
  return publicAccounts();
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

// --- auth ------------------------------------------------------------------

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

/** Opens TimeTree's own sign-in page against `acct`'s partition. Resolves true on success. */
function openLogin(acct) {
  return new Promise((resolve) => {
    if (authWindow) {
      authWindow.focus();
      return resolve(false);
    }
    sessionOf(acct); // ensure the UA is set before the first request goes out
    authWindow = new BrowserWindow({
      width: 480,
      height: 720,
      title: 'TimeTree にログイン',
      autoHideMenuBar: true,
      parent: mainWindow ?? undefined,
      webPreferences: { partition: acct.partition, contextIsolation: true, nodeIntegration: false },
    });
    authWindow.webContents.setUserAgent(CHROME_UA);
    authWindow.loadURL(`${ORIGIN}/signin`);

    let settled = false;
    const finish = (ok) => {
      if (settled) return;
      settled = true;
      clearInterval(poll);
      if (authWindow && !authWindow.isDestroyed()) authWindow.close();
      resolve(ok);
    };

    // Don't hang on one navigation event firing at exactly the right moment:
    // the sign-in providers redirect unpredictably and the cookie can land
    // slightly after the navigation. Poll for the only thing that matters —
    // can we read the API yet?
    const check = async () => {
      if (settled || !authWindow) return;
      if (await isSignedIn(acct)) finish(true);
    };
    const poll = setInterval(check, 1500);
    authWindow.webContents.on('did-navigate', check);
    authWindow.webContents.on('did-navigate-in-page', check);
    authWindow.on('closed', () => {
      authWindow = null;
      // The user may have signed in and closed the window themselves.
      if (!settled) isSignedIn(acct).then((ok) => finish(ok));
    });
  });
}

// --- api -------------------------------------------------------------------

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

// --- ipc -------------------------------------------------------------------

const ALLOWED_METHODS = new Set(['GET', 'POST', 'PUT', 'DELETE']);

/**
 * The renderer's only door to the network. It may name a path under /api/ and
 * a method — nothing else. Keeping the account lookup here (rather than
 * letting the renderer pass an account id) means a renderer bug can't address
 * a session other than the active one.
 */
ipcMain.handle('api:request', async (_e, { path: pathname, method = 'GET', body } = {}) => {
  if (typeof pathname !== 'string' || !pathname.startsWith('/api/') || pathname.includes('..')) {
    throw new Error('unsupported path: ' + pathname);
  }
  const m = String(method).toUpperCase();
  if (!ALLOWED_METHODS.has(m)) throw new Error('unsupported method: ' + method);
  const acct = activeAccount();
  if (!acct) throw new Error('アカウントが選択されていません');
  return apiJSON(acct, pathname, m, body);
});

/**
 * Fire a reminder. The renderer decides WHEN — it's the side that holds the
 * events and the user's alert settings — and this side only knows how to make
 * the OS say something. `key` comes back on click so the renderer can show
 * whatever the notification was about.
 */
ipcMain.handle('notify:show', (_e, { title, body, key } = {}) => {
  if (!Notification.isSupported()) return false;
  const n = new Notification({ title: String(title || ''), body: String(body || '') });
  n.on('click', () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
    mainWindow.webContents.send('notify:clicked', key);
  });
  n.show();
  return true;
});

/**
 * Reminders need the app to be running, and a machine reboots. Opt-in, never
 * assumed: starting yourself at login without being asked is something a user
 * should get to refuse. Starts hidden — the tray is enough of an announcement.
 */
// --- maps ------------------------------------------------------------------
//
// TimeTree stores location_lat / location_lon on every event — its phone app
// has a place picker. Its WEB app doesn't; the location there is a plain text
// box. So a pin is something a third-party client can genuinely add.
//
// Everything map-related goes through here rather than the renderer, for three
// reasons that all point the same way:
//
//   1. The renderer's CSP is `img-src 'self' data:`. Tiles arrive as data:
//      URIs, so the policy stays shut rather than being widened to a tile CDN.
//   2. OpenStreetMap's tile policy requires a User-Agent that identifies the
//      app. A file:// renderer can't set one; this can.
//   3. Until now this app talked to exactly ONE host. Maps make it two. That
//      belongs in one auditable place, behind one switch, not sprinkled
//      through the UI — the renderer cannot reach OSM even if it wanted to.
//
// The switch is off by default and lives in settings. Turning it on means
// telling OpenStreetMap roughly where your family's events are, which is a
// thing to be asked rather than assumed.

const OSM_UA = `TimeForest/${app.getVersion()} (unofficial TimeTree desktop client)`;
const tileCache = new Map();
const TILE_CACHE_MAX = 400;
let mapsEnabled = false;

ipcMain.handle('map:setEnabled', (_e, on) => { mapsEnabled = !!on; return mapsEnabled; });

/**
 * Open a pin in the user's real map app.
 *
 * The renderer hands over coordinates, not a URL — `app:openExternal` only
 * ever allowed timetreeapp.com, and the way to keep that guarantee is to keep
 * building the URL on this side rather than widening the allowlist to
 * "anything that looks like a map". Works with maps switched off: this is the
 * user clicking a button, and nothing is fetched.
 */
ipcMain.handle('map:open', (_e, { lat, lon } = {}) => {
  const la = Number(lat);
  const lo = Number(lon);
  if (!Number.isFinite(la) || !Number.isFinite(lo)) throw new Error('bad coordinates');
  if (Math.abs(la) > 90 || Math.abs(lo) > 180) throw new Error('bad coordinates');
  // Coordinates only. The label used to be encoded here and then dropped on the
  // floor — what actually got appended was an EMPTY `query_place_id=` plus a
  // `z=17` that this URL form doesn't take. Both were junk, and the name never
  // reached Google either way. Coordinates are the precise thing to send; a
  // place name is a search, which can land somewhere else entirely.
  shell.openExternal(`https://www.google.com/maps/search/?api=1&query=${la},${lo}`);
  return true;
});

/** One OSM tile as a data: URI. Cached — panning revisits the same tiles. */
ipcMain.handle('map:tile', async (_e, { z, x, y } = {}) => {
  if (!mapsEnabled) throw new Error('地図はオフです');
  if (![z, x, y].every((n) => Number.isInteger(n) && n >= 0) || z > 19) {
    throw new Error('bad tile');
  }
  const key = `${z}/${x}/${y}`;
  if (tileCache.has(key)) return tileCache.get(key);
  const res = await fetch(`https://tile.openstreetmap.org/${key}.png`, {
    headers: { 'user-agent': OSM_UA },
  });
  if (!res.ok) throw new Error('tile ' + res.status);
  const buf = Buffer.from(await res.arrayBuffer());
  const uri = 'data:image/png;base64,' + buf.toString('base64');
  // Cheap FIFO: a Map keeps insertion order, so the oldest key is first.
  if (tileCache.size >= TILE_CACHE_MAX) tileCache.delete(tileCache.keys().next().value);
  tileCache.set(key, uri);
  return uri;
});

/** Place search, via Nominatim. Returns at most 8 candidates. */
ipcMain.handle('map:search', async (_e, q) => {
  if (!mapsEnabled) throw new Error('地図はオフです');
  const query = String(q || '').trim();
  if (query.length < 2) return [];
  const u = new URL('https://nominatim.openstreetmap.org/search');
  u.searchParams.set('q', query);
  u.searchParams.set('format', 'jsonv2');
  u.searchParams.set('limit', '8');
  u.searchParams.set('accept-language', 'ja');
  const res = await fetch(u, { headers: { 'user-agent': OSM_UA } });
  if (!res.ok) throw new Error('search ' + res.status);
  const j = await res.json();
  return (Array.isArray(j) ? j : []).map((r) => ({
    name: r.name || r.display_name.split(',')[0],
    address: r.display_name,
    lat: Number(r.lat),
    lon: Number(r.lon),
  }));
});

ipcMain.handle('app:getAutoStart', () => app.getLoginItemSettings().openAtLogin);
ipcMain.handle('app:setAutoStart', (_e, on) => {
  app.setLoginItemSettings({ openAtLogin: !!on, args: ['--hidden'] });
  return app.getLoginItemSettings().openAtLogin;
});

ipcMain.handle('accounts:list', () => publicAccounts());
ipcMain.handle('accounts:add', async () => {
  const id = await addAccount();
  mainWindow?.webContents.send('accounts:changed', publicAccounts());
  return { ...publicAccounts(), added: id };
});
ipcMain.handle('accounts:switch', async (_e, id) => {
  const r = await switchAccount(id);
  mainWindow?.webContents.send('accounts:changed', r);
  return r;
});
ipcMain.handle('accounts:remove', async (_e, id) => {
  const r = await removeAccount(id);
  mainWindow?.webContents.send('accounts:changed', r);
  return r;
});
ipcMain.handle('auth:check', async () => {
  const acct = activeAccount();
  return acct ? isSignedIn(acct) : false;
});

ipcMain.handle('app:openExternal', (_e, url) => {
  if (/^https:\/\/timetreeapp\.com\//.test(url)) shell.openExternal(url);
});
ipcMain.handle('app:setTheme', (_e, mode) => {
  nativeTheme.themeSource = ['system', 'light', 'dark'].includes(mode) ? mode : 'system';
  return nativeTheme.shouldUseDarkColors;
});
ipcMain.handle('app:shouldUseDark', () => nativeTheme.shouldUseDarkColors);

// --- tray ------------------------------------------------------------------
//
// Reminders only fire while the renderer is alive, so "close" has to mean
// "get out of the way", not "stop being a calendar". Closing hides to the
// tray; quitting is an explicit choice from the tray menu or Ctrl+Q. Without
// this the notification feature would quietly stop working the first time
// somebody hit the X, which is worse than not having it.

let tray = null;
let quitting = false;

const iconPath = (name) => path.join(__dirname, 'build', name);

function trayImage() {
  // The tray slot is 16px; hand it the size it asked for rather than letting
  // Windows downscale a 1024px master into mush.
  for (const n of ['icon-32.png', 'icon-16.png', 'icon.png']) {
    const p = iconPath(n);
    if (fs.existsSync(p)) {
      const img = nativeImage.createFromPath(p);
      if (!img.isEmpty()) return img;
    }
  }
  return null;
}

function showWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) return createWindow();
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function createTray() {
  const img = trayImage();
  if (!img || tray) return;
  tray = new Tray(img);
  tray.setToolTip('TimeForest');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'TimeForest を開く', click: showWindow },
    { type: 'separator' },
    { label: '終了', click: () => { quitting = true; app.quit(); } },
  ]));
  tray.on('click', showWindow);
}

// --- window ----------------------------------------------------------------

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE(), 'utf8'));
  } catch {
    return { width: 1180, height: 820 };
  }
}

function saveState() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  try {
    fs.writeFileSync(STATE_FILE(), JSON.stringify({
      ...mainWindow.getBounds(),
      maximized: mainWindow.isMaximized(),
    }));
  } catch { /* non-fatal */ }
}

function createWindow() {
  const s = loadState();
  mainWindow = new BrowserWindow({
    x: s.x,
    y: s.y,
    width: s.width || 1180,
    height: s.height || 820,
    minWidth: 720,
    minHeight: 520,
    title: 'TimeForest',
    icon: fs.existsSync(iconPath('icon.png')) ? iconPath('icon.png') : undefined,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#1c1c1e' : '#ffffff',
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  if (s.maximized) mainWindow.maximize();
  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  // Launched at login we start in the tray: the point of auto-start is the
  // reminders, not a window in your face every time you turn the machine on.
  const hidden = process.argv.includes('--hidden');
  mainWindow.once('ready-to-show', () => { if (!hidden) mainWindow.show(); });
  if (DEV) mainWindow.webContents.openDevTools({ mode: 'detach' });

  // Closing hides; only an explicit quit tears the renderer down, because the
  // renderer is what fires reminders.
  mainWindow.on('close', (e) => {
    saveState();
    if (quitting || !tray) return;
    e.preventDefault();
    mainWindow.hide();
  });
  mainWindow.on('closed', () => { mainWindow = null; });

  nativeTheme.on('updated', () => {
    mainWindow?.webContents.send('theme:changed', nativeTheme.shouldUseDarkColors);
  });

  // Never let the app navigate away from its own UI.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:/.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
}

// Before whenReady: sessions bake in their paths the moment they're created.
migrateUserData();

app.whenReady().then(async () => {
  loadAccounts();
  await adoptLegacySession();
  createTray();
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
    else showWindow();
  });
});

app.on('before-quit', () => { quitting = true; });

app.on('window-all-closed', () => {
  // With a tray we're a background app: the last window closing is the user
  // putting us away, not asking us to stop. Reminders keep working. Without a
  // tray (no icon built) there'd be no way back, so fall back to quitting.
  if (process.platform !== 'darwin' && !tray) app.quit();
});
