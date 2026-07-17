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

  /**
   * Find an event across every calendar, by uuid or by any prefix of one.
   *
   * The prefix half is not a convenience, it's a bug fix: `ls` prints the first
   * 8 characters, because a 32-hex uuid across every row is a wall of noise
   * nobody reads. Requiring the full thing meant the CLI printed identifiers
   * you could not use — you'd have to go and find the long form somewhere else,
   * and there is nowhere else.
   *
   * An ambiguous prefix names the candidates rather than picking one. Guessing
   * here means commenting on the wrong event, which on a shared calendar
   * notifies people about the wrong thing.
   */
  function locate(state, uuid) {
    const want = String(uuid || '').trim().toLowerCase();
    if (!want) throw new Error('uuid を指定してください');
    const hits = [];
    for (const cal of state.calendars) {
      for (const raw of state.events.get(cal.id) || []) {
        if (raw.deactivated_at || !raw.uuid) continue;
        if (raw.uuid === want) return { cal, raw };          // exact always wins
        if (raw.uuid.startsWith(want)) hits.push({ cal, raw });
      }
    }
    if (!hits.length) throw new Error(`予定 ${uuid} が見つかりません`);
    if (hits.length > 1) {
      const list = hits.slice(0, 5)
        .map((h) => `  ${h.raw.uuid.slice(0, 12)}  ${h.raw.title || '(無題)'}`).join('\n');
      throw new Error(`"${uuid}" は ${hits.length}件に当てはまります。もう少し長く指定してください:\n${list}`);
    }
    return hits[0];
  }

  const commands = {
    ping: () => ({ ok: true, ready: !!TTX.store?.state?.ready }),

    /**
     * Switching accounts is the renderer's job, not main's — this is the only
     * path that reaches loadActiveAccount(), which throws away one account's
     * events and pulls the other's. main.js used to flip activeId and fire an
     * "accounts:changed" nobody was listening to, so `tf use たろう` reported
     * success and then `tf ls` kept answering with the throwaway's calendar.
     * Believing that is how you post to the wrong family.
     */
    async use({ account } = {}) {
      const want = String(account || '').trim();
      const r = await window.host.accounts.list();
      const hit = r.accounts.find((a) => a.email === want || a.id === want || a.name === want);
      if (!hit) {
        throw new Error(`アカウント "${want}" がありません。あるのは: `
          + r.accounts.map((a) => a.email || a.name).join(', '));
      }
      if (!TTX.cli._switch) throw new Error('アカウントを切り替えられません');
      await TTX.cli._switch(hit.id);
      return { account: hit.name || hit.email, calendars: ready().calendars.map((c) => c.name) };
    },

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
      // locate() is what turns a prefix into a real event — use what it found.
      // Passing `uuid` on from here hands the API the eight characters the
      // person typed, which is not an id, and it answers 400 -403.
      const { cal, raw: ev } = locate(state, uuid);
      const raw = await TTX.api.activities(cal.id, ev.uuid);
      return {
        calendar: cal.name,
        items: TTX.model.normalizeActivities(raw, { membersById: state.members.get(cal.id) }, state.me?.id ?? null),
      };
    },

    async say({ uuid, text } = {}) {
      if (!String(text || '').trim()) throw new Error('本文が空です');
      const state = ready();
      const { cal, raw } = locate(state, uuid);
      await TTX.api.postComment(cal.id, raw.uuid, String(text));
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
