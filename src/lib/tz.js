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

  /** Wall-clock HH:MM of `ms` in `tz`. */
  function hm(ms, tz) {
    const d = new Date(toLocal(ms, tz));
    return String(d.getUTCHours()).padStart(2, '0') + ':' + String(d.getUTCMinutes()).padStart(2, '0');
  }

  /** Parse "YYYY-MM-DD" as UTC midnight. */
  const parseYmd = (s) => {
    const [y, m, d] = s.split('-').map(Number);
    return Date.UTC(y, m - 1, d);
  };

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

  TTX.tz = { DAY, tzOffset, toLocal, ymd, hm, parseYmd, addDays, daysBetween, WEEKDAY_JA, weekdayOf };
})();
