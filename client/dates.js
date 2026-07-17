/* Dates a person types.
 *
 * `--from 2026-07-01 --to 2026-07-31` is correct and nobody types it twice.
 * The reason to be at a terminal is that it's quicker than reaching for the
 * window, and that isn't.
 *
 * Everything resolves in Asia/Tokyo, like the rest of the app — never the
 * machine's zone. `tf ls today` has to mean the same day on a laptop that
 * travelled, for the same reason the app pins every clock to JST.
 *
 * Its own file because it is pure and testable: scripts/check.js runs these
 * without an app, an Electron, or a calendar.
 */

/** Today in JST. Shift, then read UTC fields — same trick as src/lib/tz.js. */
function today(now = Date.now()) {
  return new Date(now + 9 * 3600000).toISOString().slice(0, 10);
}

function addDays(key, n) {
  const d = new Date(key + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** Monday of the week containing `key` — this app starts weeks on Monday. */
function weekStart(key) {
  const dow = new Date(key + 'T00:00:00Z').getUTCDay();   // 0 = Sunday
  return addDays(key, -((dow + 6) % 7));
}

function monthEnd(key) {
  const d = new Date(key.slice(0, 8) + '01T00:00:00Z');
  d.setUTCMonth(d.getUTCMonth() + 1);
  d.setUTCDate(0);
  return d.toISOString().slice(0, 10);
}

/**
 * One day: `2026-07-21`, `7/21` (this year), `today`, `+7d`.
 * @returns {string|null} YYYY-MM-DD, or null if it isn't a date
 */
function day(word, now = Date.now()) {
  const t = today(now);
  const w = String(word ?? '').trim().toLowerCase();
  if (!w) return null;
  if (w === 'today' || w === '今日') return t;
  if (w === 'tomorrow' || w === '明日') return addDays(t, 1);
  if (w === 'yesterday' || w === '昨日') return addDays(t, -1);
  if (/^\d{4}-\d{2}-\d{2}$/.test(w)) return w;
  let m = w.match(/^(\d{1,2})\/(\d{1,2})$/);
  if (m) return `${t.slice(0, 4)}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`;
  m = w.match(/^([+-])(\d+)d$/);
  if (m) return addDays(t, (m[1] === '-' ? -1 : 1) * Number(m[2]));
  return null;
}

/**
 * A span: `today`, `week`, `month`, or any single day.
 * @returns {{from:string,to:string}|null}
 */
function range(word, now = Date.now()) {
  const t = today(now);
  const w = String(word ?? '').trim().toLowerCase();
  if (!w) return null;
  if (w === 'week' || w === '今週') { const a = weekStart(t); return { from: a, to: addDays(a, 6) }; }
  if (w === 'nextweek' || w === '来週') { const a = addDays(weekStart(t), 7); return { from: a, to: addDays(a, 6) }; }
  if (w === 'lastweek' || w === '先週') { const a = addDays(weekStart(t), -7); return { from: a, to: addDays(a, 6) }; }
  if (w === 'month' || w === '今月') { const a = t.slice(0, 8) + '01'; return { from: a, to: monthEnd(a) }; }
  if (w === 'nextmonth' || w === '来月') {
    const d = new Date(t.slice(0, 8) + '01T00:00:00Z');
    d.setUTCMonth(d.getUTCMonth() + 1);
    const a = d.toISOString().slice(0, 10);
    return { from: a, to: monthEnd(a) };
  }
  const one = day(w, now);
  return one ? { from: one, to: one } : null;
}

/**
 * A moment: a day, plus the time after it if there is one.
 *   `7/21 10:00`   `明日 9:30`   `2026-07-21T10:00`   `7/21 9時`   `today`
 *
 * A bare day comes back with `time: null` rather than midnight, because the
 * caller needs to tell the two apart: a person who types a day and no clock
 * means an all-day event, not one that starts at 00:00.
 *
 * A time with no day is null on purpose. `10:00` looks obvious at 09:00 and
 * means something else at 15:00, and guessing puts the event on the wrong day.
 * @returns {{key:string, time:string|null}|null}
 */
function when(word, now = Date.now()) {
  const w = String(word ?? '').trim();
  if (!w) return null;
  const m = w.match(/^(.+?)[T\s]+(\d{1,2})(?::(\d{2}))?\s*時?$/);
  if (!m) {
    const only = day(w, now);
    return only ? { key: only, time: null } : null;
  }
  const key = day(m[1], now);
  if (!key) return null;
  const hh = Number(m[2]);
  const mm = Number(m[3] || 0);
  if (hh > 23 || mm > 59) return null;
  return { key, time: `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}` };
}

/**
 * How long something lasts, in minutes: `1h` `90m` `1:30` `1.5h` `45` `2時間`.
 * @returns {number|null} minutes — 0 is a real answer, so test for null
 */
function mins(word) {
  const w = String(word ?? '').trim().toLowerCase();
  if (!w) return null;
  let m = w.match(/^(\d+(?:\.\d+)?)\s*(?:h|時間)$/);
  if (m) return Math.round(Number(m[1]) * 60);
  m = w.match(/^(\d+)\s*(?:m|分)$/);
  if (m) return Number(m[1]);
  m = w.match(/^(\d{1,2}):(\d{2})$/);
  if (m) return Number(m[1]) * 60 + Number(m[2]);
  if (/^\d+$/.test(w)) return Number(w);
  return null;
}

module.exports = { today, addDays, weekStart, monthEnd, day, range, when, mins };
