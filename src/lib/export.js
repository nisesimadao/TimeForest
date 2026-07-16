/* Serializers: Markdown / CSV / JSON / ICS. */
(() => {
  const TTX = (globalThis.TTX = globalThis.TTX || {});
  const { WEEKDAY_JA, weekdayOf, ymd, addDays, DAY } = TTX.tz;

  const dayLabel = (key) => `${Number(key.slice(5, 7))}/${Number(key.slice(8, 10))}(${WEEKDAY_JA[weekdayOf(key)]})`;

  function timeLabel(o) {
    if (o.allDay) return o.multiDay ? '終日・複数日' : '終日';
    if (o.multiDay) return `${o.startTime}〜${o.endTime}`;
    return o.startTime === o.endTime ? o.startTime : `${o.startTime}〜${o.endTime}`;
  }

  function toMarkdown(byDay, opts = {}) {
    const lines = [];
    if (opts.title) lines.push(`# ${opts.title}`, '');
    let month = '';
    for (const [key, list] of Object.entries(byDay)) {
      if (opts.skipEmpty && !list.length) continue;
      const m = key.slice(0, 7);
      if (m !== month) {
        month = m;
        lines.push('', `## ${Number(m.slice(5, 7))}月 (${m})`, '');
      }
      if (!list.length) {
        lines.push(`- **${dayLabel(key)}** — 予定なし`);
        continue;
      }
      lines.push(`- **${dayLabel(key)}**`);
      for (const o of list) {
        const bits = [timeLabel(o), o.title];
        if (o.location) bits.push(`@${o.location}`);
        if (o.multiDay) bits.push(`(${o.startKey}〜${o.endKey})`);
        lines.push(`    - ${bits.filter(Boolean).join(' ')}`);
      }
    }
    return lines.join('\n').trim() + '\n';
  }

  const csvCell = (v) => {
    const s = String(v ?? '');
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };

  function toCSV(occs) {
    const head = ['date', 'weekday', 'start', 'end', 'all_day', 'title', 'location', 'note', 'calendar', 'multi_day_start', 'multi_day_end', 'recurring'];
    const rows = [head.join(',')];
    for (const o of occs) {
      rows.push([
        o.startKey,
        WEEKDAY_JA[weekdayOf(o.startKey)],
        o.startTime,
        o.endTime,
        o.allDay ? 'true' : 'false',
        o.title,
        o.location,
        (o.note || '').replace(/\r?\n/g, ' '),
        o.calendarName,
        o.multiDay ? o.startKey : '',
        o.multiDay ? o.endKey : '',
        o.recurring ? 'true' : 'false',
      ].map(csvCell).join(','));
    }
    return '﻿' + rows.join('\r\n') + '\r\n'; // BOM so Excel reads UTF-8
  }

  function toJSON(byDay) {
    const out = {};
    for (const [key, list] of Object.entries(byDay)) {
      out[key] = list.map((o) => ({
        title: o.title,
        time: o.allDay ? '' : `${o.startTime}〜${o.endTime}`,
        allDay: o.allDay,
        span: o.days.length,
        start: o.startKey,
        end: o.endKey,
        location: o.location || undefined,
        note: o.note || undefined,
        calendar: o.calendarName || undefined,
      }));
    }
    return JSON.stringify(out, null, 2);
  }

  // --- ICS -------------------------------------------------------------

  const pad = (n) => String(n).padStart(2, '0');
  const icsUTC = (ms) => {
    const d = new Date(ms);
    return d.getUTCFullYear() + pad(d.getUTCMonth() + 1) + pad(d.getUTCDate()) + 'T' +
           pad(d.getUTCHours()) + pad(d.getUTCMinutes()) + pad(d.getUTCSeconds()) + 'Z';
  };
  const icsDate = (key) => key.replace(/-/g, '');
  const icsEsc = (s) => String(s ?? '').replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');

  /** Fold to 75 octets per RFC 5545. Counts UTF-8 bytes, not JS chars. */
  function fold(line) {
    const enc = new TextEncoder();
    if (enc.encode(line).length <= 75) return line;
    const out = [];
    let cur = '';
    let bytes = 0;
    for (const ch of line) {
      const n = enc.encode(ch).length;
      const limit = out.length === 0 ? 75 : 74; // continuation lines carry a leading space
      if (bytes + n > limit) {
        out.push(cur);
        cur = '';
        bytes = 0;
      }
      cur += ch;
      bytes += n;
    }
    if (cur) out.push(cur);
    return out.join('\r\n ');
  }

  function toICS(occs, opts = {}) {
    const now = icsUTC(Date.now());
    const lines = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'PRODID:-//TimeForest//JP',
      'CALSCALE:GREGORIAN',
      'METHOD:PUBLISH',
      `X-WR-CALNAME:${icsEsc(opts.title || 'TimeTree')}`,
    ];
    occs.forEach((o, i) => {
      lines.push('BEGIN:VEVENT');
      lines.push(`UID:${o.uuid || 'ttx'}-${o.start}-${i}@timeforest`);
      lines.push(`DTSTAMP:${now}`);
      if (o.allDay) {
        // TimeTree's all-day end_at is inclusive; iCal DTEND is exclusive.
        lines.push(`DTSTART;VALUE=DATE:${icsDate(o.startKey)}`);
        lines.push(`DTEND;VALUE=DATE:${icsDate(addDays(o.endKey, 1))}`);
      } else {
        lines.push(`DTSTART:${icsUTC(o.start)}`);
        lines.push(`DTEND:${icsUTC(Math.max(o.end, o.start))}`);
      }
      lines.push(`SUMMARY:${icsEsc(o.title)}`);
      if (o.location) lines.push(`LOCATION:${icsEsc(o.location)}`);
      if (o.note) lines.push(`DESCRIPTION:${icsEsc(o.note)}`);
      if (o.url) lines.push(`URL:${icsEsc(o.url)}`);
      lines.push('END:VEVENT');
    });
    lines.push('END:VCALENDAR');
    return lines.map(fold).join('\r\n') + '\r\n';
  }

  TTX.exporters = { toMarkdown, toCSV, toJSON, toICS, dayLabel, timeLabel };
})();
