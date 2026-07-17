/* Answers the CLI, from inside the running app.
 *
 * This side exists because the store does: the whole cache, the recurrence
 * expansion, the holiday merge, all already in memory and already up to date.
 * A separate process asking the same questions has to re-sync 4298 events
 * first — measured, 8 seconds. The app is a tray app; it is normally running;
 * asking it costs nothing.
 *
 * main.js reaches this through executeJavaScript rather than an IPC channel, so
 * preload.js stays exactly as narrow as it was. Nothing here touches Node: it
 * reads the store and returns plain objects.
 *
 * Everything returns DATA, never text. Formatting is the CLI's job — it knows
 * whether it is talking to a terminal or to a pipe, and the same answers feed
 * MCP later without going through a string.
 */
(() => {
  const TTX = (globalThis.TTX = globalThis.TTX || {});
  const TZ = 'Asia/Tokyo';

  const ready = () => {
    if (!TTX.store?.state?.ready) throw new Error('まだ同期が終わっていません');
    return TTX.store.state;
  };

  /** The calendars a command should look at: all of them, or the named one. */
  function pick(state, name) {
    if (!name) return state.calendars;
    const want = String(name);
    const hit = state.calendars.filter((c) => c.name === want || String(c.id) === want);
    if (!hit.length) {
      throw new Error(`カレンダー "${want}" がありません。あるのは: ${state.calendars.map((c) => c.name).join(', ')}`);
    }
    return hit;
  }

  /** Find an event by uuid across every calendar. Returns {cal, raw}. */
  function locate(state, uuid) {
    for (const cal of state.calendars) {
      const raw = TTX.store.rawEvent(cal.id, uuid);
      if (raw && !raw.deactivated_at) return { cal, raw };
    }
    throw new Error(`予定 ${uuid} が見つかりません`);
  }

  const commands = {
    ping: () => ({ ok: true, ready: !!TTX.store?.state?.ready }),

    calendars: () => ready().calendars.map((c) => ({
      id: c.id, name: c.name, enabled: ready().enabled.has(c.id),
    })),

    async ls({ from, to, cal } = {}) {
      const state = ready();
      const a = from || TTX.tz.ymd(Date.now(), TZ);
      const b = to || TTX.tz.ymd(Date.now() + 30 * 86400000, TZ);
      const cals = pick(state, cal);

      // Ask for exactly the calendars named, without disturbing what the window
      // is showing — the person at the keyboard didn't run this command.
      const ids = new Set(cals.map((c) => c.id));
      const holidays = await TTX.store.holidaysFor(a, b).catch(() => []);
      const occs = TTX.store.occurrences(a, b, { holidays })
        .filter((o) => o.holiday || ids.has(o.calendarId));

      return {
        from: a,
        to: b,
        events: occs.map((o) => ({
          uuid: o.uuid, title: o.title,
          startKey: o.startKey, endKey: o.endKey,
          startTime: o.startTime, endTime: o.endTime,
          allDay: o.allDay, multiDay: o.multiDay, holiday: !!o.holiday,
          start: o.start, end: o.end,
          location: o.location || '', note: o.note || '',
          calendar: o.calendarName || '', author: o.authorName || '',
          lat: o.lat ?? null, lon: o.lon ?? null,
        })),
      };
    },

    show({ uuid } = {}) {
      const { cal, raw } = locate(ready(), uuid);
      return { calendar: cal.name, event: raw };
    },

    async comments({ uuid } = {}) {
      const state = ready();
      const { cal } = locate(state, uuid);
      const raw = await TTX.api.activities(cal.id, uuid);
      return {
        calendar: cal.name,
        items: TTX.model.normalizeActivities(raw, { membersById: state.members.get(cal.id) }, state.me?.id ?? null),
      };
    },

    async say({ uuid, text } = {}) {
      if (!String(text || '').trim()) throw new Error('本文が空です');
      const state = ready();
      const { cal, raw } = locate(state, uuid);
      await TTX.api.postComment(cal.id, uuid, String(text));
      // Name the calendar back. On a shared one this just notified other
      // people, and a terminal gives you no other clue about where it landed.
      return { calendar: cal.name, title: raw.title || '(無題)' };
    },
  };

  TTX.cli = {
    async handle(cmd, args) {
      const fn = commands[cmd];
      if (!fn) throw new Error('知らないコマンド: ' + cmd);
      return fn(args || {});
    },
  };
})();
