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
 *    rather than merely confusing, so it is centralised in session.js.
 */
const { app, BrowserWindow, ipcMain, session, shell, nativeTheme, Notification, Tray, Menu, nativeImage } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');

const S = require('./session');
const rpc = require('./rpc');

const { ORIGIN, CLIENT_TAG, CHROME_UA } = S;
const DEV = process.argv.includes('--dev');

// Must run before app.whenReady(): userData is derived from the app name, and a
// session's path is fixed the moment it is instantiated. See session.js.
S.pin();
S.migrateUserData();

let mainWindow = null;
let authWindow = null;

/**
 * One TimeForest per profile.
 *
 * Two Electron processes on the same userData don't fail cleanly — they fight
 * over the Chromium profile and the loser gets nonsense: a CSRF token comes
 * back fine, and then /api/v1/calendars answers an empty list, or a 400 with
 * code -493. Both read as "you have no calendars", which is a lie, and it costs
 * an hour every time. Measured both ways during this session.
 *
 * Taking the lock also means the CLI can ASK, and say something useful instead
 * of relaying -493.
 */
if (!app.requestSingleInstanceLock()) {
  console.error('TimeForest はもう起動しています。');
  app.exit(0);
}
app.on('second-instance', () => {
  // Someone launched it again — they want the window, not another copy.
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  }
});

// --- accounts --------------------------------------------------------------

async function addAccount() {
  const id = crypto.randomUUID();
  const acct = { id, partition: `persist:tt-${id}`, name: '', email: '', addedAt: Date.now() };
  const ok = await openLogin(acct);
  if (!ok) return null;

  const who = await S.identify(acct).catch(() => ({ name: 'TimeTree', email: '' }));
  acct.name = who.name;
  acct.email = who.email;

  // Signing into an account that's already here should just select it.
  const dupe = S.all().find((a) => a.email && a.email === acct.email);
  if (dupe) {
    await session.fromPartition(acct.partition).clearStorageData();
    S.setActive(dupe.id);
    S.save();
    return dupe.id;
  }

  return S.add(acct);
}

async function switchAccount(id) {
  S.setActive(id);
  S.save();
  return S.publicAccounts();
}

async function removeAccount(id) {
  const acct = S.find(id);
  if (!acct) return S.publicAccounts();
  // Legacy partition is shared with nothing else, so clearing it is safe too.
  await session.fromPartition(acct.partition).clearStorageData().catch(() => {});
  S.remove(id);
  return S.publicAccounts();
}

/** Opens TimeTree's own sign-in page against `acct`'s partition. Resolves true on success. */
function openLogin(acct) {
  return new Promise((resolve) => {
    if (authWindow) {
      authWindow.focus();
      return resolve(false);
    }
    S.sessionOf(acct); // ensure the UA is set before the first request goes out
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
      if (await S.isSignedIn(acct)) finish(true);
    };
    const poll = setInterval(check, 1500);
    authWindow.webContents.on('did-navigate', check);
    authWindow.webContents.on('did-navigate-in-page', check);
    authWindow.on('closed', () => {
      authWindow = null;
      // The user may have signed in and closed the window themselves.
      if (!settled) S.isSignedIn(acct).then((ok) => finish(ok));
    });
  });
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
  const acct = S.active();
  if (!acct) throw new Error('アカウントが選択されていません');
  return S.apiJSON(acct, pathname, m, body);
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

ipcMain.handle('accounts:list', () => S.publicAccounts());
ipcMain.handle('accounts:add', async () => {
  const id = await addAccount();
  mainWindow?.webContents.send('accounts:changed', S.publicAccounts());
  return { ...S.publicAccounts(), added: id };
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
  const acct = S.active();
  return acct ? S.isSignedIn(acct) : false;
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

/**
 * The CLI's door. The work happens in the renderer because that is where the
 * store is — the whole cache, the recurrence expansion, the holiday merge.
 * Asking it costs nothing; a separate process would re-sync 4298 events first
 * (measured: 8 seconds).
 */
async function dispatchCli({ cmd, args }) {
  // Accounts belong to this side — session.js owns the list. Answering here
  // also means `tf accounts` works before the renderer has finished syncing.
  if (cmd === 'accounts') return S.publicAccounts();
  if (cmd === 'use') {
    const want = String(args?.account || '');
    const hit = S.all().find((a) => a.email === want || a.id === want || a.name === want);
    if (!hit) throw new Error(`アカウント "${want}" がありません`);
    await switchAccount(hit.id);
    mainWindow?.webContents.send('accounts:changed', S.publicAccounts());
    return S.publicAccounts();
  }

  if (!mainWindow || mainWindow.isDestroyed()) throw new Error('ウィンドウがありません');
  // Straight into the page's own world, so preload.js stays as narrow as it is.
  // Only strings this process built reach it — the CLI's argv never does.
  const call = `globalThis.TTX.cli.handle(${JSON.stringify(String(cmd))}, ${JSON.stringify(args ?? {})})`;
  return mainWindow.webContents.executeJavaScript(call, true);
}

app.whenReady().then(async () => {
  S.load();
  await S.adoptLegacy();
  createTray();
  createWindow();
  rpc.serve({ userDataDir: S.userData(), dispatch: dispatchCli });
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
