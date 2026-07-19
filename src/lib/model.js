/* Turn raw TimeTree events into concrete, dated occurrences.
 *
 * The rules that matter, all confirmed by diffing against TimeTree's own
 * rendered month grid (104/107 exact matches, remainder explained below):
 *   1. deactivated_at != null  -> deleted, drop it.
 *   2. category 2 is a Keep/メモ item, not a calendar event. It carries a
 *      `row_order` (its position in the Keep list) and never appears on the
 *      grid. Dropping it is what makes us agree with the UI.
 *   3. type 1 is a birthday. Title comes back empty and the UI composes
 *      "🎂 <name>の誕生日" from author_id -> calendar member.
 *   4. A recurring master carries RRULE + EXDATE lines. Cancelled/edited
 *      occurrences are punched out by EXDATE and re-added as separate child
 *      events carrying `recurring_uuid`. So expanding masters (minus EXDATEs)
 *      and treating children as plain events reproduces the UI exactly —
 *      the 【休】-prefixed entries are those children.
 *   5. all_day events use tz "UTC" and an INCLUSIVE end_at (7/1..7/3 = 3 days).
 *      Timed events can also span days (start 8/8 21:00 -> end 8/16 22:00).
 *
 * Public holidays (七夕, 海の日 …) are NOT in this feed — they come from
 * /api/v2/memorialdays and are merged in separately.
 */
(() => {
  const TTX = (globalThis.TTX = globalThis.TTX || {});
  const { ymd, hm, daysBetween } = TTX.tz;

  const CATEGORY_KEEP = 2;
  const TYPE_BIRTHDAY = 1;

  const tzOf = (e) => e.start_timezone || 'Asia/Tokyo';

  function titleOf(raw, ctx) {
    if (raw.type === TYPE_BIRTHDAY) {
      const who = ctx && ctx.membersById && ctx.membersById.get(raw.author_id);
      return who ? `🎂 ${who.name}の誕生日` : '🎂 誕生日';
    }
    return raw.title || '(無題)';
  }

  function normalize(raw, startAt, endAt, calendar, ctx) {
    const tz = tzOf(raw);
    const allDay = !!raw.all_day;

    // A timed event ending exactly at 00:00 belongs to the previous day.
    let effEnd = endAt;
    if (!allDay && endAt > startAt && hm(endAt, tz) === '00:00') effEnd = endAt - 1;

    const startKey = ymd(startAt, tz);
    const endKey = ymd(Math.max(startAt, effEnd), tz);
    const days = daysBetween(startKey, endKey);

    return {
      uuid: raw.uuid,
      title: titleOf(raw, ctx),
      birthday: raw.type === TYPE_BIRTHDAY,
      holiday: false,
      allDay,
      start: startAt,
      end: endAt,
      tz,
      startKey,
      endKey,
      days,
      multiDay: days.length > 1,
      startTime: allDay ? '' : hm(startAt, tz),
      endTime: allDay ? '' : hm(endAt, tz),
      labelId: raw.label_id,
      // Who put this here. On a shared calendar that is not a detail — it's
      // half of what the entry means. "10:30 歯医者" that you didn't write
      // tells you something only because you know your partner wrote it.
      authorId: raw.author_id ?? null,
      authorName: (ctx?.membersById?.get(raw.author_id)?.name) || '',
      location: raw.location || '',
      // TimeTree's phone app pins places; the API returns the coordinates as
      // STRINGS ("35.681236"), and its own web app ignores them entirely. Guard
      // "" / non-numeric: Number("") is 0, which would pin an un-located event to
      // null-island (0,0) and show a bogus "map" link. Only a finite number counts.
      lat: raw.location_lat != null && raw.location_lat !== '' && Number.isFinite(Number(raw.location_lat)) ? Number(raw.location_lat) : null,
      lon: raw.location_lon != null && raw.location_lon !== '' && Number.isFinite(Number(raw.location_lon)) ? Number(raw.location_lon) : null,
      note: raw.note || '',
      // `url` is written inside `attachment` but read back at BOTH levels —
      // the server mirrors it up. Read the top one; prefer the attachment if
      // a write hasn't been mirrored yet.
      url: raw.url || raw.attachment?.url || '',
      checklist: raw.attachment?.checklist || [],
      attendees: raw.attendees || [],
      recurring: !!(raw.recurrences && raw.recurrences.length),
      isException: !!raw.recurring_uuid,
      calendarId: raw.calendar_id,
      calendarName: calendar ? calendar.name : '',
    };
  }

  /**
   * Expand `rawEvents` into occurrences overlapping [from, to] (epoch ms).
   * `calendar` tags each occurrence with a name; `ctx.membersById` resolves
   * birthday titles.
   */
  function occurrences(rawEvents, from, to, calendar, ctx) {
    const out = [];
    const seen = new Set();

    for (const e of rawEvents) {
      if (e.deactivated_at) continue;
      if (e.category === CATEGORY_KEEP) continue;

      const isMaster = !!(e.recurrences && e.recurrences.some((l) => l.startsWith('RRULE:')));
      const duration = Math.max(0, e.end_at - e.start_at);

      if (isMaster) {
        for (const start of TTX.recur.expand(e, from, to)) {
          const key = e.uuid + '@' + start;
          if (seen.has(key)) continue;
          seen.add(key);
          out.push(normalize(e, start, start + duration, calendar, ctx));
        }
      } else {
        if (e.end_at < from || e.start_at > to) continue;
        out.push(normalize(e, e.start_at, e.end_at, calendar, ctx));
      }
    }

    out.sort((a, b) => (a.startKey === b.startKey
      ? (a.allDay === b.allDay ? a.start - b.start : (a.allDay ? -1 : 1))
      : (a.startKey < b.startKey ? -1 : 1)));
    return out;
  }

  /** Shape memorialdays like occurrences so the agenda can render them uniformly. */
  function holidayOccurrences(memorialdays) {
    return (memorialdays || []).map((d) => {
      const startKey = ymd(d.start_at, 'UTC');
      const endKey = ymd(Math.max(d.start_at, d.end_at), 'UTC');
      const days = daysBetween(startKey, endKey);
      return {
        uuid: 'holiday-' + d.id,
        title: d.title,
        holiday: true,
        birthday: false,
        workday: !!d.workday,
        allDay: true,
        start: d.start_at,
        end: d.end_at,
        tz: 'UTC',
        startKey, endKey, days,
        multiDay: days.length > 1,
        startTime: '', endTime: '',
        labelId: null, authorId: null, authorName: '',
        location: '', lat: null, lon: null,
        note: '', url: '', checklist: [], attendees: [],
        recurring: false, isException: false,
        calendarId: null, calendarName: '',
      };
    });
  }

  /** Group occurrences into { 'YYYY-MM-DD': [occ, ...] }, repeating multi-day spans. */
  /**
   * `cap` is daysBetween's runaway guard, and the caller is the only one who
   * knows how many days it legitimately wants. The default (400) is fine for a
   * month grid, and was fine for an agenda back when it always showed three
   * months — but the agenda now grows as you scroll, and a range past 400 days
   * got its tail cut off in silence: the span kept growing, the days stopped.
   */
  function groupByDay(occs, fromKey, toKey, cap) {
    const byDay = {};
    for (const key of daysBetween(fromKey, toKey, cap)) byDay[key] = [];
    for (const o of occs) {
      for (const key of o.days) {
        if (!(key in byDay)) continue;
        byDay[key].push(o);
      }
    }
    // Holidays first, then all-day, then timed by clock order.
    const rank = (o) => (o.holiday ? 0 : o.allDay ? 1 : 2);
    for (const key of Object.keys(byDay)) {
      byDay[key].sort((a, b) => (rank(a) - rank(b)) || (a.start - b.start));
    }
    return byDay;
  }

  /**
   * The instant a reminder fires for `occ`.
   *
   * `alerts` counts minutes before the start — but for an all-day event the
   * start TimeTree measures from is LOCAL midnight, not the UTC midnight it
   * stores. Subtracting from `occ.start` directly would put every all-day
   * reminder 9 hours out in JST. That offset is exactly why 1日前 is 900
   * minutes and not 1440: 15 hours before local midnight is 09:00 the day
   * before.
   */
  function alertAt(occ, mins, tz = 'Asia/Tokyo') {
    const base = occ.allDay ? TTX.tz.toEpoch(occ.startKey, '00:00', false, tz) : occ.start;
    return base - mins * 60000;
  }

  function matchesQuery(o, q) {
    if (!q) return true;
    const hay = (o.title + ' ' + o.location + ' ' + o.note + ' ' + o.calendarName).toLowerCase();
    return q.toLowerCase().split(/\s+/).filter(Boolean).every((t) => hay.includes(t));
  }

  /**
   * One entry in an event's comment feed, ready to render.
   *
   * Deleted records are dropped, not tombstoned: the server soft-deletes so
   * that other clients can sync the removal, but a person who deleted a
   * comment meant it to be gone, and 「削除されました」 rows would be a worse
   * calendar than no rows.
   *
   * `me` is the signed-in user id, and drives nothing but whether the edit and
   * delete affordances appear — the server is the one that enforces it.
   */
  function normalizeActivities(list, ctx, me) {
    return (list || [])
      .filter((a) => !a.deactivated_at)
      .map((a) => ({
        id: a.id,
        type: a.type,
        authorId: a.author_id ?? null,
        authorName: (ctx?.membersById?.get(a.author_id)?.name) || '',
        comment: a.type === TTX.api.ACTIVITY.COMMENT,
        text: a.type === TTX.api.ACTIVITY.COMMENT
          ? (a.attachment?.content || '')
          : TTX.api.activityText(a),
        at: a.created_at,
        // A comment that was edited says so, the way every chat app does —
        // otherwise the text silently differs from what someone replied to.
        //
        // Exactly `>`, with no slack: measured, a fresh comment comes back with
        // updated_at - created_at == 0 (both on the POST reply and on a
        // refetch), and a real edit showed +343ms. An earlier version allowed
        // 1000ms of slop "to be safe", which did the opposite — it swallowed
        // the most common edit there is, fixing your own typo right after
        // sending.
        edited: a.type === TTX.api.ACTIVITY.COMMENT && a.updated_at > a.created_at,
        mine: me != null && a.author_id === me,
      }))
      .sort((a, b) => a.at - b.at);
  }

  TTX.model = {
    occurrences, holidayOccurrences, groupByDay, matchesQuery, normalize, alertAt,
    normalizeActivities,
  };
})();
