/* Minimal RRULE expander, scoped to what TimeTree actually emits.
 *
 * Observed in the wild (2395 events / 73 recurring masters):
 *   FREQ=DAILY|WEEKLY|YEARLY, plus optional BYDAY, UNTIL, INTERVAL.
 *   EXDATE arrives as separate lines in the same `recurrences` array.
 * No COUNT, BYMONTHDAY, BYSETPOS or WKST — so this stays small on purpose.
 * MONTHLY is handled anyway since it costs three lines and users can create it.
 */
(() => {
  const TTX = (globalThis.TTX = globalThis.TTX || {});
  const { DAY, tzOffset } = TTX.tz;

  const WD = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 };
  const MAX_OCCURRENCES = 5000;

  /** Parse "20260403" or "20260403T062000Z" to epoch ms. Returns {ms, dateOnly}. */
  function parseICalDate(raw) {
    const s = String(raw).trim().replace(/^;?VALUE=DATE:/, '');
    const m = s.match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})Z?)?$/);
    if (!m) return null;
    const [, y, mo, d, h, mi, sec] = m;
    return {
      ms: Date.UTC(+y, +mo - 1, +d, +(h || 0), +(mi || 0), +(sec || 0)),
      dateOnly: h === undefined,
    };
  }

  function parseRule(line) {
    const out = {};
    for (const part of line.slice('RRULE:'.length).split(';')) {
      const [k, v] = part.split('=');
      if (k) out[k.toUpperCase()] = v;
    }
    return out;
  }

  /**
   * Expand a recurring master into occurrence start instants (epoch ms)
   * overlapping [from, to]. Returns [] for non-recurring events.
   *
   * Arithmetic runs in the event's own wall-clock space: we shift by the tz
   * offset at the master's start, iterate with UTC date math, then shift back.
   * Exact for fixed-offset zones (Asia/Tokyo, UTC — i.e. all TimeTree JP data).
   * A DST zone could drift by an hour across a transition; acceptable for now.
   */
  function expand(master, from, to) {
    const lines = master.recurrences || [];
    const ruleLine = lines.find((l) => l.startsWith('RRULE:'));
    if (!ruleLine) return [];

    const rule = parseRule(ruleLine);
    const tz = master.start_timezone || 'Asia/Tokyo';
    const off = tzOffset(tz, master.start_at);
    const localStart = master.start_at + off;
    const duration = Math.max(0, master.end_at - master.start_at);

    const excluded = new Set();
    for (const l of lines) {
      if (!l.startsWith('EXDATE')) continue;
      const p = parseICalDate(l.slice(l.indexOf(':') + 1));
      if (p) excluded.add(p.ms);
    }

    // UNTIL is a UTC instant; a date-only UNTIL means "through the end of that day".
    let until = Infinity;
    if (rule.UNTIL) {
      const p = parseICalDate(rule.UNTIL);
      if (p) until = p.dateOnly ? p.ms + DAY - 1 : p.ms;
    }

    // An occurrence counts if it *overlaps* the window, so start scanning
    // `duration` before `from` and stop once starts pass `to`.
    const hardStop = Math.min(until, to);
    const limitLocal = hardStop + off;
    const minLocal = from - duration + off;

    const freq = (rule.FREQ || '').toUpperCase();
    const interval = Math.max(1, Number(rule.INTERVAL || 1));
    const byday = rule.BYDAY ? rule.BYDAY.split(',').map((d) => WD[d.replace(/^[+-]?\d+/, '')]).filter((n) => n !== undefined) : null;

    const starts = [];
    const push = (localT) => {
      if (localT > limitLocal || localT < localStart) return;
      const utc = localT - off;
      if (utc > until || utc > to) return;
      if (localT < minLocal) return;
      if (excluded.has(utc)) return;
      starts.push(utc);
    };

    const d0 = new Date(localStart);

    if (freq === 'DAILY') {
      for (let n = 0; n < MAX_OCCURRENCES; n++) {
        const t = localStart + n * interval * DAY;
        if (t > limitLocal) break;
        push(t);
      }
    } else if (freq === 'WEEKLY') {
      const dows = byday && byday.length ? [...new Set(byday)].sort((a, b) => a - b) : [d0.getUTCDay()];
      const weekStart = localStart - d0.getUTCDay() * DAY; // Sunday of week 0, time-of-day preserved
      outer: for (let w = 0; w < MAX_OCCURRENCES; w++) {
        const base = weekStart + w * interval * 7 * DAY;
        if (base > limitLocal + 7 * DAY) break;
        for (const dow of dows) {
          const t = base + dow * DAY;
          if (t > limitLocal) break outer;
          push(t);
        }
      }
    } else if (freq === 'MONTHLY') {
      for (let n = 0; n < MAX_OCCURRENCES; n++) {
        const t = Date.UTC(
          d0.getUTCFullYear(), d0.getUTCMonth() + n * interval, d0.getUTCDate(),
          d0.getUTCHours(), d0.getUTCMinutes(), d0.getUTCSeconds()
        );
        if (t > limitLocal) break;
        // Skip month-end rollovers (Jan 31 -> Mar 3), matching iCal semantics.
        if (new Date(t).getUTCDate() === d0.getUTCDate()) push(t);
      }
    } else if (freq === 'YEARLY') {
      for (let n = 0; n < MAX_OCCURRENCES; n++) {
        const t = Date.UTC(
          d0.getUTCFullYear() + n * interval, d0.getUTCMonth(), d0.getUTCDate(),
          d0.getUTCHours(), d0.getUTCMinutes(), d0.getUTCSeconds()
        );
        if (t > limitLocal) break;
        push(t);
      }
    }

    return starts;
  }

  TTX.recur = { expand, parseICalDate, WD };
})();
