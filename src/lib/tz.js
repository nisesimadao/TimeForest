/* Timezone helpers.
 *
 * TimeTree stores every event as an epoch-ms instant plus an IANA timezone.
 * Two conventions matter:
 *   - all_day events use timezone "UTC" with start_at/end_at at UTC midnight,
 *     and end_at is INCLUSIVE (7/1..7/3 means three days).
 *   - timed events use the real timezone (Asia/Tokyo here) with a normal instant.
 */
(() => {
  const TTX = (globalThis.TTX = globalThis.TTX || {});

  const DAY = 86400000;
  const offsetCache = new Map();

  /** Offset of `tz` from UTC, in ms, at instant `ms`. */
  function tzOffset(tz, ms) {
    // Cache per (tz, UTC day): enough granularity for DST boundaries.
    const key = tz + '|' + Math.floor(ms / DAY);
    const hit = offsetCache.get(key);
    if (hit !== undefined) return hit;
    let off = 0;
    try {
      const parts = new Intl.DateTimeFormat('en-US', {
        timeZone: tz,
        hourCycle: 'h23',
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit',
      }).formatToParts(new Date(ms));
      const p = {};
      for (const x of parts) if (x.type !== 'literal') p[x.type] = Number(x.value);
      off = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(ms / 1000) * 1000;
    } catch {
      off = 0;
    }
    offsetCache.set(key, off);
    return off;
  }

  /** Shift an instant so that UTC getters read out wall-clock fields in `tz`. */
  const toLocal = (ms, tz) => ms + tzOffset(tz, ms);

  /** YYYY-MM-DD of `ms` as seen in `tz`. */
  function ymd(ms, tz) {
    const d = new Date(toLocal(ms, tz));
    return (
      d.getUTCFullYear() +
      '-' + String(d.getUTCMonth() + 1).padStart(2, '0') +
      '-' + String(d.getUTCDate()).padStart(2, '0')
    );
  }

  /**
   * Wall-clock HH:MM of `ms` in `tz`.
   *
   * This is the VALUE, always 24-hour: it feeds `<input type="time">`,
   * `toEpoch()` and every comparison. What a person reads is `clock()`.
   */
  function hm(ms, tz) {
    const d = new Date(toLocal(ms, tz));
    return String(d.getUTCHours()).padStart(2, '0') + ':' + String(d.getUTCMinutes()).padStart(2, '0');
  }

  /**
   * An HH:MM as TimeTree writes it for a reader. `military` false gives its
   * 12-hour form — which is NOT the English one. Measured against TimeTree's
   * own web app, with user_setting.military_time = false:
   *
   *     00:30 → 午前 0:30      (English would say 12:30 AM)
   *     09:05 → 午前 9:05
   *     12:00 → 午後 0:00      (English would say 12:00 PM)
   *     12:30 → 午後 0:30
   *     14:30 → 午後 2:30
   *
   * The hour runs 0–11 inside each half — hourCycle h11, the Japanese
   * convention, not h12. Deriving this from the English one puts midnight and
   * noon both wrong, and both wrong answers look perfectly reasonable.
   */
  function clock(t, military = true) {
    if (military || !/^\d{1,2}:\d{2}$/.test(String(t))) return t;
    const [h, m] = String(t).split(':').map(Number);
    return `${h < 12 ? '午前' : '午後'} ${h % 12}:${String(m).padStart(2, '0')}`;
  }

  /** Parse "YYYY-MM-DD" as UTC midnight. */
  const parseYmd = (s) => {
    const [y, m, d] = s.split('-').map(Number);
    return Date.UTC(y, m - 1, d);
  };

  /**
   * The inverse of ymd/hm: wall-clock fields -> the instant TimeTree stores.
   *
   * all_day events are the UTC-midnight convention, so the date alone is the
   * answer and `tz` is irrelevant — that's what start_timezone "UTC" means.
   *
   * For a timed event we know the wall clock but need the instant, while
   * tzOffset() wants an instant to answer with. Seed it with the naive value
   * and refine once: the first pass is exact unless the guess landed on the
   * far side of a DST transition, and the second pass corrects that. In a
   * fixed-offset zone like JST both passes agree immediately.
   */
  function toEpoch(dateKey, time, allDay, tz = 'Asia/Tokyo') {
    const [y, m, d] = dateKey.split('-').map(Number);
    if (allDay) return Date.UTC(y, m - 1, d);
    const [hh, mm] = (time || '00:00').split(':').map(Number);
    const naive = Date.UTC(y, m - 1, d, hh, mm);
    const guess = naive - tzOffset(tz, naive);
    return naive - tzOffset(tz, guess);
  }

  /** Advance a (YYYY-MM-DD, HH:MM) wall-clock pair by `mins`, rolling the date. */
  function shiftWall(dateKey, time, mins) {
    const [hh, mm] = (time || '00:00').split(':').map(Number);
    const t = parseYmd(dateKey) + (hh * 60 + mm + mins) * 60000;
    return [ymd(t, 'UTC'), hm(t, 'UTC')];
  }

  /** Add `n` days to a YYYY-MM-DD string. */
  const addDays = (s, n) => ymd(parseYmd(s) + n * DAY, 'UTC');

  /** Inclusive list of YYYY-MM-DD between two keys. Capped to stay sane. */
  function daysBetween(fromKey, toKey, cap = 400) {
    const out = [];
    let t = parseYmd(fromKey);
    const end = parseYmd(toKey);
    while (t <= end && out.length < cap) {
      out.push(ymd(t, 'UTC'));
      t += DAY;
    }
    return out;
  }

  const WEEKDAY_JA = ['日', '月', '火', '水', '木', '金', '土'];
  const weekdayOf = (key) => new Date(parseYmd(key)).getUTCDay();

  TTX.tz = {
    DAY, tzOffset, toLocal, ymd, hm, clock, parseYmd, toEpoch, shiftWall,
    addDays, daysBetween, WEEKDAY_JA, weekdayOf,
  };
})();
