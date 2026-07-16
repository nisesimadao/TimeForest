/* Data layer: sync from TimeTree, cache in memory, expand on demand.
 *
 * The whole design bet: TimeTree's entire history is ~2400 events and arrives
 * in about 8 chunks. That's small. So we pull it all once, keep it in memory,
 * and every view (agenda, month, search) becomes a pure local computation.
 * That's why this client can feel instant where the web app has to round-trip.
 */
(() => {
  const TTX = (globalThis.TTX = globalThis.TTX || {});
  const { DAY, parseYmd } = TTX.tz;

  const store = {
    calendars: [],
    enabled: new Set(),
    events: new Map(),    // calendarId -> raw events
    labels: new Map(),    // calendarId -> labels
    members: new Map(),   // calendarId -> Map(user_id -> member)
    holidays: new Map(),  // 'YYYY' -> memorialdays
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
    store.ready = false;
    store.syncedAt = 0;
    emit({ type: 'reset' });
  }

  async function loadCalendarList() {
    store.calendars = await TTX.api.calendars();
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

  /** Occurrences across all enabled calendars for [fromKey, toKey]. */
  function occurrences(fromKey, toKey, opts = {}) {
    const from = parseYmd(fromKey);
    const to = parseYmd(toKey) + DAY - 1;
    let all = [];
    for (const cal of store.calendars) {
      if (!store.enabled.has(cal.id)) continue;
      const raw = store.events.get(cal.id);
      if (!raw) continue;
      all = all.concat(TTX.model.occurrences(raw, from, to, cal, { membersById: store.members.get(cal.id) }));
    }
    if (store.enabled.size > 1) all = dedupeMirrors(all);
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

  /** Full-history search, unbounded by the current view. */
  function searchAll(query, limit = 60) {
    if (!query || !query.trim()) return [];
    const now = Date.now();
    const from = now - 365 * DAY;
    const to = now + 730 * DAY;
    let all = [];
    for (const cal of store.calendars) {
      if (!store.enabled.has(cal.id)) continue;
      const raw = store.events.get(cal.id);
      if (!raw) continue;
      all = all.concat(TTX.model.occurrences(raw, from, to, cal, { membersById: store.members.get(cal.id) }));
    }
    return all
      .filter((o) => TTX.model.matchesQuery(o, query))
      .sort((a, b) => Math.abs(a.start - now) - Math.abs(b.start - now))
      .slice(0, limit);
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
