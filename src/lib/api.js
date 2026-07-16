/* TimeTree private web API client.
 *
 * There is no public API for this data. The web app talks to /api/v1|v2 with
 * two headers beyond the session cookie:
 *   x-csrf-token  — same value as <meta name="csrf-token">
 *   x-timetreea   — client tag, "web/<version>/<locale>"
 * Without them the server answers 400 {"error":{"code":-401}}.
 *
 * We run in the content script's isolated world, but same-origin fetch still
 * carries the page's cookies, so riding the user's existing session is enough —
 * no credentials are ever read, stored or transmitted anywhere by this code.
 */
(() => {
  const TTX = (globalThis.TTX = globalThis.TTX || {});

  const CLIENT_TAG = 'web/2.1.0/ja';
  const MAX_CHUNKS = 200;
  const ORIGIN = 'https://timetreeapp.com';

  let cachedToken = null;
  let transport = null;

  /**
   * Swap out how requests are made. The browser build talks to TimeTree
   * directly (same origin, cookies ride along). The desktop client can't —
   * its renderer is on a different origin, so CORS blocks it. There the host
   * process installs a transport that performs the request itself and returns
   * parsed JSON. Everything above this line stays identical in both.
   */
  const setTransport = (fn) => { transport = fn; };

  /**
   * In a page we read the token straight out of the DOM. A service worker has
   * no DOM, so it fetches the HTML shell and scrapes the same meta tag — the
   * token is server-rendered, and a token obtained that way authorises API
   * calls identically (verified). That's what lets background reminders work
   * with no TimeTree tab open.
   */
  async function csrfToken(force = false) {
    if (cachedToken && !force) return cachedToken;

    if (typeof document !== 'undefined') {
      const meta = document.querySelector('meta[name="csrf-token"]');
      if (meta && meta.content) return (cachedToken = meta.content);
    }

    const res = await fetch(`${ORIGIN}/calendars`, { credentials: 'include' });
    const html = await res.text();
    const m = html.match(/<meta[^>]+name=["']csrf-token["'][^>]+content=["']([^"']+)["']/i)
           || html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+name=["']csrf-token["']/i);
    if (!m) throw new Error('csrf-token が取得できません。TimeTree にログインしていますか？');
    return (cachedToken = m[1]);
  }

  const headers = (token) => ({
    'content-type': 'application/json',
    'x-csrf-token': token,
    'x-timetreea': CLIENT_TAG,
  });

  const url = (path) => (path.startsWith('http') ? path : ORIGIN + path);

  async function get(path) {
    if (transport) return transport(path);

    let res = await fetch(url(path), { headers: headers(await csrfToken()), credentials: 'include' });
    // A stale token reads as 400/-401; refetch once before giving up.
    if (res.status === 400 || res.status === 401 || res.status === 403) {
      res = await fetch(url(path), { headers: headers(await csrfToken(true)), credentials: 'include' });
    }
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`API ${res.status} ${path} ${body.slice(0, 160)}`);
    }
    return res.json();
  }

  /** All calendars the signed-in user can see. `alias_code` matches the URL slug. */
  async function calendars() {
    const j = await get('/api/v1/calendars');
    return j.calendars || (Array.isArray(j) ? j : []);
  }

  /** Resolve the calendar for the current /calendars/<alias> URL. */
  async function currentCalendar() {
    const path = typeof location !== 'undefined' ? location.pathname : '';
    const alias = (path.match(/\/calendars\/([^/?#]+)/) || [])[1];
    const list = await calendars();
    return {
      list,
      current: list.find((c) => c.alias_code === alias) || list[0] || null,
    };
  }

  /**
   * Every event ever, for one calendar. The endpoint is a sync cursor:
   * since=0 returns the first chunk plus a `since` for the next one, and
   * `chunk:false` marks the end. ~2400 events comes back in 8 chunks.
   */
  async function allEvents(calendarId, onProgress) {
    let since = 0;
    let out = [];
    for (let i = 0; i < MAX_CHUNKS; i++) {
      const j = await get(`/api/v1/calendar/${calendarId}/events?since=${since}`);
      out = out.concat(j.events || []);
      if (onProgress) onProgress(out.length);
      if (!j.chunk) break;
      since = j.since;
    }
    return out;
  }

  async function labels(calendarId) {
    const j = await get(`/api/v1/calendar/${calendarId}/labels`).catch(() => ({}));
    return j.calendar_labels || [];
  }

  async function members(calendarId) {
    const j = await get(`/api/v2/calendars/${calendarId}/users`).catch(() => ({}));
    return j.calendar_users || [];
  }

  /**
   * Public holidays / observances. These are not part of the events feed —
   * 七夕 and 海の日 show up on the grid but come from here. `workday:true`
   * means "observance, still a working day" (七夕); false is a real day off.
   */
  async function memorialdays(fromMs, toMs, countryIso = 'JP') {
    const q = new URLSearchParams();
    q.append('country_iso[]', countryIso);
    q.append('from', new Date(fromMs).toISOString().replace(/\.\d+Z$/, 'Z'));
    q.append('to', new Date(toMs).toISOString().replace(/\.\d+Z$/, 'Z'));
    const j = await get(`/api/v2/memorialdays?${q}`).catch(() => ({}));
    return (j.memorialdays || []).filter((d) => !d.deactivated_at);
  }

  /** TimeTree stores label colours as a 24-bit int. */
  const colorHex = (n) => '#' + Number(n >>> 0).toString(16).padStart(6, '0').slice(-6);

  TTX.api = {
    calendars, currentCalendar, allEvents, labels, members, memorialdays,
    colorHex, setTransport, csrfToken, CLIENT_TAG, ORIGIN,
  };
})();
