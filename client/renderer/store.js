/* Data layer: sync from TimeTree, cache in memory, expand on demand.
 *
 * The whole design bet: TimeTree's entire history is ~2400 events and arrives
 * in about 8 chunks. That's small. So we pull it all once, keep it in memory,
 * and every view (agenda, month, search) becomes a pure local computation.
 * That's why this client can feel instant where the web app has to round-trip.
 */
(() => {
  const TTX = (globalThis.TTX = globalThis.TTX || {});
  const { DAY, parseYmd, ymd } = TTX.tz;
  const TZ = 'Asia/Tokyo';

  const store = {
    calendars: [],
    enabled: new Set(),
    events: new Map(),    // calendarId -> raw events
    labels: new Map(),    // calendarId -> labels
    members: new Map(),   // calendarId -> Map(user_id -> member)
    holidays: new Map(),  // 'YYYY' -> memorialdays
    me: null,             // the signed-in user; `attendees` holds their id
    // The account's own TimeTree preferences, as TimeTree stores them:
    // { start_weekday, military_time, holiday, saturday_blue_color, lang, … }.
    // Null for an account that has never set any — TimeTree's own defaults
    // then apply (measured: 週は月曜始まり).
    setting: null,
    ready: false,
    syncedAt: 0,
  };

  const listeners = new Set();
  const subscribe = (fn) => (listeners.add(fn), () => listeners.delete(fn));
  const emit = (evt) => listeners.forEach((f) => f(evt));

  /**
   * Wipe everything. Switching accounts must not leave a single event, label,
   * member or holiday behind — a stale calendar id from the previous account
   * would silently render another person's data under the new name.
   */
  function reset() {
    store.calendars = [];
    store.enabled.clear();
    store.events.clear();
    store.labels.clear();
    store.members.clear();
    store.holidays.clear();
    store.me = null;
    // Including this one: it decides how the grid is laid out, so leaving the
    // previous account's behind draws one person's week under the other's name
    // until the next sync lands. scripts/check.js compares this list against
    // the store literal above, because "remember to reset it too" is not a
    // thing anyone remembers.
    store.setting = null;
    store.ready = false;
    store.syncedAt = 0;
    emit({ type: 'reset' });
  }

  async function loadCalendarList() {
    // Who we are is needed before the first write, not before the first paint,
    // so it rides along here rather than costing a round trip later. A failure
    // must not block the calendars — it only softens a form default.
    const [cals, who, setting] = await Promise.all([
      TTX.api.calendars(),
      TTX.api.me().catch(() => null),
      TTX.api.setting().catch(() => null),
    ]);
    store.calendars = cals;
    store.me = who;
    store.setting = setting;
    if (!store.enabled.size) {
      for (const c of store.calendars) store.enabled.add(c.id);
    }
    emit({ type: 'calendars' });
    return store.calendars;
  }

  async function syncCalendar(cal, onProgress) {
    const [events, labels, members] = await Promise.all([
      TTX.api.allEvents(cal.id, (n) => onProgress && onProgress(cal, n)),
      TTX.api.labels(cal.id),
      TTX.api.members(cal.id),
    ]);
    store.events.set(cal.id, events);
    store.labels.set(cal.id, labels);
    store.members.set(cal.id, new Map(members.map((m) => [m.user_id, m])));
  }

  async function syncAll(onProgress) {
    await loadCalendarList();
    for (const cal of store.calendars) {
      await syncCalendar(cal, onProgress);
      emit({ type: 'calendar-synced', cal });
    }
    store.ready = true;
    store.syncedAt = Date.now();
    emit({ type: 'synced' });
  }

  /** Holidays are cheap and yearly; cache per calendar year. */
  async function holidaysFor(fromKey, toKey) {
    const years = new Set();
    for (let y = +fromKey.slice(0, 4); y <= +toKey.slice(0, 4); y++) years.add(String(y));
    const missing = [...years].filter((y) => !store.holidays.has(y));
    await Promise.all(missing.map(async (y) => {
      const list = await TTX.api.memorialdays(Date.UTC(+y, 0, 1), Date.UTC(+y, 11, 31)).catch(() => []);
      store.holidays.set(y, list);
    }));
    return [...years].flatMap((y) => store.holidays.get(y) || []);
  }

  const labelOf = (calId, labelId) => (store.labels.get(calId) || []).find((l) => l.id === labelId);
  const calendarOf = (calId) => store.calendars.find((c) => c.id === calId);

  /**
   * Fold a written event back into the cache. The write endpoints return the
   * full server-side object, so we can splice it in rather than re-pulling
   * 2400 events to see one change.
   */
  function applyEvent(calId, raw) {
    const list = store.events.get(calId);
    if (!list || !raw?.uuid) return;
    const i = list.findIndex((e) => e.uuid === raw.uuid);
    if (i >= 0) list[i] = raw;
    else list.push(raw);
    emit({ type: 'event-changed', calId, uuid: raw.uuid });
  }

  /**
   * Delete is a soft delete server-side — the event stays and gains
   * deactivated_at. Mirror exactly that locally, so the same reader filter
   * that hides it after a re-sync hides it right now.
   */
  function markDeleted(calId, uuid) {
    const list = store.events.get(calId);
    if (!list) return;
    const i = list.findIndex((e) => e.uuid === uuid);
    if (i >= 0) list[i] = { ...list[i], deactivated_at: Date.now() };
    emit({ type: 'event-changed', calId, uuid });
  }

  /** The raw event behind an occurrence — the form needs fields the view drops. */
  const rawEvent = (calId, uuid) => (store.events.get(calId) || []).find((e) => e.uuid === uuid);

  /**
   * Merging calendars surfaces genuine mirrors: a birthday, for instance, is
   * written into every calendar the person belongs to, so 🎂たろうの誕生日 lands in
   * both 家族 and プライベート and renders twice. Collapse those — but only
   * across calendars. Two identical entries inside ONE calendar are two real
   * events (そろばん教室 twice in a day happens), so the true count is the
   * highest count seen within any single calendar.
   */
  function dedupeMirrors(list) {
    const groups = new Map();
    for (const o of list) {
      const k = `${o.title}|${o.start}|${o.end}|${o.allDay}`;
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(o);
    }
    const out = [];
    for (const group of groups.values()) {
      if (group.length === 1) { out.push(group[0]); continue; }
      const perCal = new Map();
      for (const o of group) perCal.set(o.calendarId, (perCal.get(o.calendarId) || 0) + 1);
      out.push(...group.slice(0, Math.max(...perCal.values())));
    }
    return out;
  }

  /**
   * Occurrences for [fromKey, toKey], across the enabled calendars.
   *
   * `opts.only` (a Set of calendar ids) asks about those instead, enabled or
   * not. The sidebar checkbox says what the WINDOW shows; someone who names a
   * calendar out loud — `tf ls --cal プライベート` — is asking about that
   * calendar, and answering 「予定はありません」 because a box is unticked is
   * a lie they have no way to catch.
   */
  function occurrences(fromKey, toKey, opts = {}) {
    const from = parseYmd(fromKey);
    const to = parseYmd(toKey) + DAY - 1;
    const use = opts.only || store.enabled;
    let all = [];
    for (const cal of store.calendars) {
      if (!use.has(cal.id)) continue;
      const raw = store.events.get(cal.id);
      if (!raw) continue;
      all = all.concat(TTX.model.occurrences(raw, from, to, cal, { membersById: store.members.get(cal.id) }));
    }
    if (use.size > 1) all = dedupeMirrors(all);
    if (opts.mutedLabels) {
      all = all.filter((o) => !opts.mutedLabels.has(o.calendarId + ':' + o.labelId));
    }
    if (opts.holidays) {
      all = all.concat(TTX.model.holidayOccurrences(opts.holidays).filter((h) =>
        h.startKey <= toKey && h.endKey >= fromKey));
    }
    if (opts.query) all = all.filter((o) => TTX.model.matchesQuery(o, opts.query));
    return all;
  }

  /**
   * Search, unbounded by the current view but not by time: expanding every
   * recurrence forever is not free, so it looks a year back and two forward.
   *
   * `opts.only` picks the calendars, the same as occurrences() — the window
   * searches what it is showing, the CLI searches what you have.
   *
   * @returns {{events:Array, from:string, to:string}} — the window too, because
   *   "nothing found" only means something if you know where it looked.
   */
  function searchAll(query, limit = 60, opts = {}) {
    const now = Date.now();
    const from = now - 365 * DAY;
    const to = now + 730 * DAY;
    const span = { from: ymd(from, TZ), to: ymd(to, TZ) };
    if (!query || !query.trim()) return { events: [], ...span };
    const use = opts.only || store.enabled;
    let all = [];
    for (const cal of store.calendars) {
      if (!use.has(cal.id)) continue;
      const raw = store.events.get(cal.id);
      if (!raw) continue;
      all = all.concat(TTX.model.occurrences(raw, from, to, cal, { membersById: store.members.get(cal.id) }));
    }
    return {
      events: all
        .filter((o) => TTX.model.matchesQuery(o, query))
        .sort((a, b) => Math.abs(a.start - now) - Math.abs(b.start - now))
        .slice(0, limit),
      ...span,
    };
  }

  const totalEvents = () => store.calendars
    .filter((c) => store.enabled.has(c.id))
    .reduce((n, c) => n + (store.events.get(c.id)?.length || 0), 0);

  TTX.store = {
    state: store, subscribe, emit, reset,
    loadCalendarList, syncAll, syncCalendar, holidaysFor,
    occurrences, searchAll, labelOf, calendarOf, totalEvents,
    applyEvent, markDeleted, rawEvent,
  };
})();
