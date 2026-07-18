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
importScripts(chrome.runtime.getURL('src/lib/api.js'));

/* Toolbar button and keyboard shortcuts -> tell the content script. */
const send = async (msg) => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.url?.startsWith('https://timetreeapp.com/')) {
    chrome.tabs.sendMessage(tab.id, msg).catch(() => {});
  }
};

chrome.action.onClicked.addListener(() => send('ttx:toggle'));
chrome.commands?.onCommand.addListener((cmd) => {
  if (cmd === 'toggle-panel') send('ttx:toggle');
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
 *      three. Keeping that in one auditable place, behind the same off-by-default
 *      switch, beats sprinkling host access through the content script.
 *
 * One thing the desktop could do and this can't: set a User-Agent. MV3 forbids
 * it on fetch. Measured against the real services from a Chrome context: tiles
 * and Nominatim both answer 200 without one. (If OSM ever tightens that, the
 * switch is already the single place to notice.)
 *
 * The map stays OFF until the user turns it on — turning it on tells OSM roughly
 * where the family's events are, which is a thing to ask rather than assume. The
 * flag lives in chrome.storage; the content script owns the asking.
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
async function installOsmUaRule() {
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
      }],
    });
  } catch (e) { /* older Chrome without DNR header edit — tiles will be blocked */ }
}
installOsmUaRule();

const mapsOn = () => chrome.storage.local.get('maps').then((s) => !!s.maps);

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

// The content script can't fetch OSM itself (its page CSP forbids it and it has
// no host access), so it asks here. One message channel, two verbs.
chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  if (msg?.ttx === 'tile') { tile(msg.z, msg.x, msg.y).then((uri) => reply({ uri }), (e) => reply({ err: String(e.message) })); return true; }
  if (msg?.ttx === 'search') { search(msg.q).then((list) => reply({ list }), (e) => reply({ err: String(e.message) })); return true; }
  // The isolated world's fetch hangs here instead — see the header note.
  if (msg?.ttx === 'api') { self.TTX.api.request(msg.method, msg.path, msg.body).then((json) => reply({ json }), (e) => reply({ err: String(e && e.message || e) })); return true; }
  return false;
});
