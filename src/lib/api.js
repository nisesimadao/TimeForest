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

  /** The signed-in user. `id` is what `attendees` holds. */
  async function me() {
    const j = await get('/api/v1/user').catch(() => ({}));
    return j.user || null;
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
   * The URL and the checklist live inside `attachment`, not beside it — even
   * though a read answers with `url` at the top level TOO (the server mirrors
   * it). Writing the top-level one does nothing.
   *
   * `attachment` is a nested object, so a PUT REPLACES it whole; there is no
   * merging. That's why this builds from `base`: the server puts things in
   * there that we never sent and can't reconstruct — set a url and it crawls
   * the page and stores an `ogp` preview beside it (title, favicon, image).
   * Rebuilding the object from scratch silently threw that away.
   *
   * Measured, not assumed:
   *   - checklist items the real client sends carry `id` and `order`, but a
   *     write with neither round-trips fine, and sending order:1 before
   *     order:0 came back in ARRAY order. Position is the truth.
   *   - `checklist: []` is REJECTED (400 / code -403). Omitting the key is how
   *     you clear the list.
   *   - `url: ''` is accepted, and IS how you clear the url.
   */
  function buildAttachment(e, base) {
    const a = { ...(base || {}) };
    a.virtual_user_attendees = a.virtual_user_attendees || [];
    if (e.url !== undefined) a.url = e.url || '';
    if (e.checklist !== undefined) {
      const items = (e.checklist || [])
        .filter((i) => (i.title || '').trim())
        .map((i) => ({ title: i.title.trim(), checked: !!i.checked }));
      if (items.length) a.checklist = items;
      else delete a.checklist;
    }
    return a;
  }

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
      // Coordinates ride alongside the text, never instead of it: the phone
      // app shows the text, and a pin with no name is a riddle. Sent only when
      // we have both — writing nulls would clear a pin the phone app set.
      ...(Number.isFinite(e.lat) && Number.isFinite(e.lon)
        ? { location_lat: e.lat, location_lon: e.lon }
        : {}),
      attendees: e.attendees || [],
      recurrences: e.recurrences || [],
      alerts: e.alerts || [],
      attachment: buildAttachment(e, e.attachment),
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

  // --- comments (the "activity" feed) ----------------------------------
  //
  // Captured from the web app itself (on a throwaway account):
  //   GET    /api/v1/calendar/{id}/event/{uuid}/activities      read the feed
  //   POST   /api/v1/calendar/{id}/event/{uuid}/activity        post a comment
  //   PUT    /api/v1/calendar/{id}/event/{uuid}/activity/{aid}  edit one
  //   DELETE /api/v1/calendar/{id}/event/{uuid}/activity/{aid}  delete one
  // Plural to read, singular to write — the same split as events.
  //
  // The feed mixes what people SAID with what people DID, which is the point:
  // 「明日雨だから中止？」 sitting under 「日時を変更しました」 is the story.
  //
  //   type 0 — a comment.  attachment.content is the text.
  //   type 1 — created.
  //   type 2 — edited.     attachment.items lists WHICH FIELDS changed.
  //
  // DELETE is a soft delete: the record stays in the feed with
  // `deactivated_at` set, exactly like an event.
  //
  // There is no calendar-wide feed (tried /activities, /event_activities,
  // /feed — all 404), and posting a comment does not touch the event object at
  // all, not even `updated_at`. So there is no way to know an event HAS
  // comments without asking for that event specifically. That's why this loads
  // lazily, per event, when the detail panel opens — same as the real app.
  const ACTIVITY = { COMMENT: 0, CREATED: 1, EDITED: 2 };

  /**
   * `attachment.items` on an edit record, measured one field at a time against
   * the real server (change exactly one thing, read back which code appears):
   *
   *   0 タイトル   1 日時   2 ラベル   3 メモ   4 場所   6 通知   8 URL
   *
   * A combined title+date+note edit answered [0,1,3], which confirms the codes
   * compose. 5 and 7 never came back — probably 参加者 and チェックリスト, but
   * a one-member throwaway can't produce the first and the second is rejected
   * on this plan, so they are UNMEASURED and deliberately absent: an unknown
   * code degrades to a plain 「予定を変更しました」 rather than a confident
   * guess that could put a wrong sentence in someone's family calendar.
   */
  const ACTIVITY_FIELDS = {
    0: 'タイトル', 1: '日時', 2: 'ラベル', 3: 'メモ', 4: '場所', 6: '通知', 8: 'URL',
  };

  /** The one-line story an activity record tells. */
  function activityText(a) {
    if (a.type === ACTIVITY.CREATED) return '予定を作成しました';
    if (a.type !== ACTIVITY.EDITED) return '';
    const names = (a.attachment?.items || []).map((i) => ACTIVITY_FIELDS[i]).filter(Boolean);
    // Unknown codes: say only what's true.
    if (!names.length) return '予定を変更しました';
    return `${names.join('・')}を変更しました`;
  }

  /**
   * The 32-hex id the client generates for a comment. The real web app sends
   * one on POST rather than letting the server mint it, so we do too.
   */
  function newActivityId() {
    const c = globalThis.crypto;
    if (c?.randomUUID) return c.randomUUID().replace(/-/g, '');
    const b = new Uint8Array(16);
    c.getRandomValues(b);
    return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
  }

  async function activities(calendarId, uuid) {
    const j = await get(`/api/v1/calendar/${calendarId}/event/${uuid}/activities`);
    return j?.event_activities || [];
  }

  async function postComment(calendarId, uuid, text) {
    const j = await request('POST', `/api/v1/calendar/${calendarId}/event/${uuid}/activity`, {
      attachment: { content: text },
      id: newActivityId(),
    });
    return j?.event_activity ?? j;
  }

  async function editComment(calendarId, uuid, id, text) {
    const j = await request('PUT', `/api/v1/calendar/${calendarId}/event/${uuid}/activity/${id}`, {
      attachment: { content: text },
    });
    return j?.event_activity ?? j;
  }

  const deleteComment = (calendarId, uuid, id) =>
    request('DELETE', `/api/v1/calendar/${calendarId}/event/${uuid}/activity/${id}`);

  // --- recurring series ------------------------------------------------
  //
  // There is no "edit this occurrence" endpoint. A series is edited by
  // rewriting the master's RRULE lines and, where a single occurrence has to
  // differ, adding a separate event that points back at the master.
  //
  // All six operations below were captured from TimeTree's own web client,
  // driven through its real UI on a throwaway calendar, by recording what it
  // put on the wire. Two things could not have been guessed:
  //
  //   parent_id  — the write-side name for the master link. The READ side
  //                returns the same relationship as `recurring_uuid`, and
  //                sending THAT is silently ignored (verified: echoed null,
  //                and null again on read-back). Send parent_id and the
  //                server sets both fields itself.
  //   silent     — TimeTree sets it on the two calls that make up a
  //                single-occurrence edit. That edit is one act to the user
  //                but two writes to the server, and a shared calendar would
  //                otherwise notify its members twice. We send exactly what
  //                the official client sends rather than theorise about it.

  /** iCal UTC stamp of an instant: 1785114000000 -> "20260727T010000Z". */
  function icalStamp(ms) {
    const d = new Date(ms);
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}` +
      `T${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
  }

  const ruleOf = (raw) => (raw.recurrences || []).find((l) => l.startsWith('RRULE:')) || null;
  const isMaster = (raw) => !!ruleOf(raw);

  /** The master's lines with a new/updated RRULE, keeping its EXDATEs. */
  function withRule(raw, rule) {
    return [rule, ...(raw.recurrences || []).filter((l) => !l.startsWith('RRULE:'))];
  }

  /**
   * TimeTree writes UNTIL date-only, set to the DISPLAY DATE of the last
   * occurrence it wants to keep — not the day before the split, and not an
   * instant. Matching that exactly matters: this value is read back by
   * TimeTree's own apps, and a date-only UNTIL is inherently ambiguous about
   * whose midnight it means, so the only safe choice is to write what they
   * write. (`dateKey` is YYYY-MM-DD in the event's own timezone.)
   */
  const withUntil = (rule, dateKey) =>
    rule.replace(/;UNTIL=[^;]*/g, '') + ';UNTIL=' + dateKey.replace(/-/g, '');

  /** Punch a hole in the series at `startMs`. Used by both "delete this one"
   *  and, paired with a replacement event, "edit this one". */
  function excludeOccurrence(calendarId, master, startMs, extra = {}) {
    const line = 'EXDATE:' + icalStamp(startMs);
    const recurrences = (master.recurrences || []).includes(line)
      ? master.recurrences
      : [...(master.recurrences || []), line];
    return updateEvent(calendarId, master.uuid, { recurrences, ...extra });
  }

  /** End the series after `lastKeptKey`. This is "delete this and later". */
  function truncateSeries(calendarId, master, lastKeptKey) {
    const rule = ruleOf(master);
    if (!rule) throw new Error('繰り返しの予定ではありません');
    return updateEvent(calendarId, master.uuid, {
      recurrences: withRule(master, withUntil(rule, lastKeptKey)),
    });
  }

  /**
   * Replace one occurrence with a different event.
   *
   * Order is deliberate and copied from TimeTree: create the replacement
   * first, then punch the hole. If the second call fails you are left with a
   * duplicate on that day, which is visible and fixable. The other order would
   * lose the occurrence outright if the create failed.
   */
  async function editOccurrence(calendarId, master, startMs, event) {
    const j = await request('POST', `/api/v1/calendar/${calendarId}/event`, {
      ...buildEvent(event),
      parent_id: master.uuid,
      silent: true,
    });
    // Both events changed, so both come back: the caller has to fold the
    // master's new EXDATE into its cache too, or the old occurrence keeps
    // rendering underneath the replacement.
    const updated = await excludeOccurrence(calendarId, master, startMs, { silent: true });
    return { child: j?.event ?? j, master: updated };
  }

  /**
   * Split the series at an occurrence: everything from there on becomes a new,
   * independent master carrying the same rule, and the old one is truncated to
   * end at `lastKeptKey`. The two series are NOT linked afterwards — that is
   * TimeTree's own behaviour, verified by reading both back with
   * recurring_uuid null.
   */
  async function splitSeries(calendarId, master, lastKeptKey, event) {
    const rule = ruleOf(master);
    if (!rule) throw new Error('繰り返しの予定ではありません');
    const j = await request('POST', `/api/v1/calendar/${calendarId}/event`, {
      ...buildEvent({ ...event, recurrences: [rule] }),
      copy: true,
    });
    const updated = await truncateSeries(calendarId, master, lastKeptKey);
    return { created: j?.event ?? j, master: updated };
  }

  // --- alerts ----------------------------------------------------------
  //
  // `alerts` is a list of MINUTES BEFORE THE START. Timed events are the
  // obvious reading of that — 0 は開始時, 30 は 30分前, 1440 は 1日前.
  //
  // All-day is not obvious, and was measured rather than assumed: TimeTree
  // treats an all-day event's start as LOCAL midnight, and its "N日前"
  // reminder fires at 09:00 on that day — which is 15 hours (900 minutes)
  // before the following midnight. So 1日前 is 900, and each extra day adds a
  // full 1440. 当日 is the one that breaks the pattern: it's plain 0.
  //
  // Confirmed both directions on a throwaway calendar: the real client emitted
  // 900 for 1日前, and writing 900 / 2340 / 3780 back made it render 1日前 /
  // 2日前 / 3日前. 0 renders as 当日 (all-day) and 開始時 (timed).
  const ALLDAY_ALERT_BASE = 900;   // 15h: 09:00 the day before

  /** Days-before -> the value TimeTree stores for an all-day event. */
  const alldayAlert = (days) => (days <= 0 ? 0 : ALLDAY_ALERT_BASE + (days - 1) * 1440);

  /** The inverse. Returns null for values that aren't on the ladder. */
  function alldayAlertDays(mins) {
    if (mins === 0) return 0;
    const d = (mins - ALLDAY_ALERT_BASE) / 1440 + 1;
    return Number.isInteger(d) && d > 0 ? d : null;
  }

  /** How TimeTree itself words an alert, so our label matches theirs. */
  function alertLabel(mins, allDay) {
    if (allDay) {
      const d = alldayAlertDays(mins);
      if (d === 0) return '当日';
      return d === null ? `${mins}分前` : `${d}日前`;
    }
    if (mins === 0) return '開始時';
    if (mins % 1440 === 0) return `${mins / 1440}日前`;
    if (mins % 60 === 0) return `${mins / 60}時間前`;
    return `${mins}分前`;
  }

  /** TimeTree stores label colours as a 24-bit int. */
  const colorHex = (n) => '#' + Number(n >>> 0).toString(16).padStart(6, '0').slice(-6);

  /**
   * The API answers `name: ""` for every label the user hasn't renamed, and
   * TimeTree's own UI fills the gap client-side with the colour's name. Without
   * this the picker is ten anonymous swatches.
   *
   * Read out of the real client's label picker; the ten defaults line up with
   * label ids 1..10 in order. Keyed by colour rather than id because the name
   * describes the colour — a label recoloured to something off-palette gets no
   * name, which is exactly where we were before, so nothing regresses.
   */
  const COLOR_NAMES = {
    '#2ecc87': 'エメラルド・グリーン',
    '#3dc2c8': 'モダーン・サイアン',
    '#47b2f7': 'ディープ・スカイブルー',
    '#948078': 'パステル・ブラウン',
    '#212121': 'ミッドナイト・ブラック',
    '#e73b3b': 'アップル・レッド',
    '#f35f8c': 'フレンチ・ローズ',
    '#fb7f77': 'コーラル・ピンク',
    '#fdc02d': 'ブライト・オレンジ',
    '#b38bdc': 'ソフト・バイオレット',
  };

  /** What to call a label: what the user named it, else what colour it is. */
  const labelName = (lb) =>
    (lb && (lb.name || COLOR_NAMES[colorHex(lb.color)])) || '';

  /**
   * Black or white text on `color`, whichever you can actually read.
   *
   * Everything used to be white, unconditionally. Measured against the ten
   * default labels, that failed WCAG AA (4.5:1) on NINE of them — worst was
   * ブライト・オレンジ #fdc02d at 1.66:1, where a multi-day trip on a yellow
   * chip is close to invisible. Black on that same yellow is 12.7:1.
   *
   * WCAG relative luminance, not the old brightness formula: the two disagree
   * exactly on saturated yellows and cyans, which is where the failures are.
   */
  function contrastFg(color) {
    const n = Number(color >>> 0);
    const ch = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => {
      const c = v / 255;
      return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    });
    const L = 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2];
    // Contrast against white is (1.05)/(L+0.05); against black, (L+0.05)/0.05.
    // They cross at L ≈ 0.1791 — pick whichever side is further from it.
    return (1.05 / (L + 0.05)) >= ((L + 0.05) / 0.05) ? '#ffffff' : '#000000';
  }

  /** The text colour for a filled chip in this label's colour. */
  const labelFg = (lb) => contrastFg(lb?.color ?? 0);

  TTX.api = {
    calendars, currentCalendar, allEvents, labels, members, memorialdays, me,
    createEvent, updateEvent, deleteEvent, buildEvent, buildAttachment,
    activities, postComment, editComment, deleteComment,
    activityText, newActivityId, ACTIVITY, ACTIVITY_FIELDS,
    excludeOccurrence, truncateSeries, editOccurrence, splitSeries,
    icalStamp, ruleOf, isMaster, withRule, withUntil,
    alldayAlert, alldayAlertDays, alertLabel,
    colorHex, labelName, labelFg, contrastFg, COLOR_NAMES,
    setTransport, csrfToken, request, CLIENT_TAG, ORIGIN,
  };
})();
