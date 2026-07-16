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
   *
   * Signature: (path, { method, body }) => Promise<json>
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

  async function request(method, path, body) {
    if (transport) return transport(path, { method, body });

    const send = async (token) => fetch(url(path), {
      method,
      headers: headers(token),
      credentials: 'include',
      body: body === undefined ? undefined : JSON.stringify(body),
    });

    let res = await send(await csrfToken());
    // A stale token reads as 400/-401; refetch once before giving up.
    if (res.status === 400 || res.status === 401 || res.status === 403) {
      res = await send(await csrfToken(true));
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`API ${res.status} ${path} ${text.slice(0, 160)}`);
    }
    const text = await res.text();
    return text ? JSON.parse(text) : null;   // DELETE answers {} , app_launch answers 204
  }

  const get = (path) => request('GET', path);

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

  // --- writes ---------------------------------------------------------
  //
  // Captured from the web app itself (on a throwaway account):
  //   POST   /api/v1/calendar/{id}/event         create — full body
  //   PUT    /api/v1/calendar/{id}/event/{uuid}  update — CHANGED FIELDS ONLY
  //   DELETE /api/v1/calendar/{id}/event/{uuid}  delete
  // Note the singular `/event`; the read endpoint is the plural `/events`.

  /**
   * Build a create payload. Callers pass friendly fields; this fills in the
   * shape TimeTree expects, including the bits the web app always sends
   * (`attachment.virtual_user_attendees`, `category: 1`) that the server is
   * fussy about.
   *
   * `allDay` events must use the UTC-midnight convention with tz "UTC", and an
   * INCLUSIVE end — same rule the reader relies on (see model.js).
   */
  function buildEvent(e) {
    return {
      title: e.title,
      all_day: !!e.allDay,
      start_at: e.startAt,
      start_timezone: e.allDay ? 'UTC' : (e.tz || 'Asia/Tokyo'),
      end_at: e.endAt,
      end_timezone: e.allDay ? 'UTC' : (e.tz || 'Asia/Tokyo'),
      label_id: e.labelId ?? 1,
      note: e.note || '',
      location: e.location || '',
      attendees: e.attendees || [],
      recurrences: e.recurrences || [],
      alerts: e.alerts || [],
      attachment: { virtual_user_attendees: [] },
      category: 1,
    };
  }

  async function createEvent(calendarId, event) {
    const j = await request('POST', `/api/v1/calendar/${calendarId}/event`, buildEvent(event));
    return j?.event ?? j;
  }

  /**
   * `patch` carries only what changed — the server merges. Sending a full
   * object would work but risks clobbering fields we didn't model.
   */
  async function updateEvent(calendarId, uuid, patch) {
    const j = await request('PUT', `/api/v1/calendar/${calendarId}/event/${uuid}`, patch);
    return j?.event ?? j;
  }

  const deleteEvent = (calendarId, uuid) =>
    request('DELETE', `/api/v1/calendar/${calendarId}/event/${uuid}`);

  /** TimeTree stores label colours as a 24-bit int. */
  const colorHex = (n) => '#' + Number(n >>> 0).toString(16).padStart(6, '0').slice(-6);

  TTX.api = {
    calendars, currentCalendar, allEvents, labels, members, memorialdays,
    createEvent, updateEvent, deleteEvent, buildEvent,
    colorHex, setTransport, csrfToken, request, CLIENT_TAG, ORIGIN,
  };
})();
