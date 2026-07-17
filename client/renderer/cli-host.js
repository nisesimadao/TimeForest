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

  /**
   * Is this id the head of a repeating series?
   *
   * It matters because every occurrence carries the MASTER's uuid — model.js
   * maps `uuid: raw.uuid` for each expansion — so `tf ls week` prints the same
   * eight characters on all five rows of a weekly event. Whatever you do with
   * that id lands on the whole series, not the row you were reading. The window
   * asks (この回だけ / これ以降 / すべて); a one-shot command can't, so it says
   * so and stops.
   */
  const series = (raw) => (raw.recurrences || []).length > 0;

  /**
   * A text field off the wire.
   *
   * Absent means empty. Anything that isn't a string is a caller's bug — the
   * CLI's parser turns a value-less `--where` into `true` — and there is no
   * safe guess: String(true) put the location `t` on a real event, and
   * coercing to '' would delete the location instead. Say no.
   */
  const text = (v) => {
    if (v === undefined || v === null) return '';
    if (typeof v !== 'string') throw new Error(`文字列で指定してください: ${JSON.stringify(v)}`);
    return v;
  };

  /** One occurrence, the way every listing here hands it back. */
  const shape = (o) => ({
    uuid: o.uuid, title: o.title,
    startKey: o.startKey, endKey: o.endKey,
    startTime: o.startTime, endTime: o.endTime,
    allDay: o.allDay, multiDay: o.multiDay, holiday: !!o.holiday,
    start: o.start, end: o.end,
    location: o.location || '', note: o.note || '',
    calendar: o.calendarName || '', author: o.authorName || '',
    lat: o.lat ?? null, lon: o.lon ?? null,
  });

  /**
   * Reminders, in the minutes TimeTree stores — which depend on the event.
   *
   * 「1日前」 is 1440 for a timed event and **900** for an all-day one: an
   * all-day starts at local midnight but is stored at UTC midnight, so its
   * ladder is offset nine hours (HANDOFF §3, measured both ways against
   * TimeTree itself). Send 1440 for an all-day event and the reminder lands at
   * the wrong hour, silently.
   *
   * And there is no rung for 「30分前」 on the all-day ladder at all — the
   * form's own picker offers days only. Refuse rather than round to something.
   */
  function alertsFor(list, allDay) {
    return list.map((a) => {
      if (a.days !== undefined) return allDay ? TTX.api.alldayAlert(a.days) : a.days * 1440;
      if (allDay && a.mins > 0) {
        throw new Error('終日の予定の通知は「当日」か「N日前」だけです（分・時間は指定できません）');
      }
      return a.mins;
    }).sort((x, y) => x - y);
  }

  /**
   * The reminders on an event, in TimeTree's own words.
   *
   * Words, not the stored minutes, because reading `900` needs the all-day
   * ladder to make sense of and that ladder lives here. A copy of it in cli.js
   * would be the same drift this file has already been burned by — and for a
   * model, 「1日前」 is an answer where `900` is a puzzle.
   */
  const words = (raw) => (raw.alerts || []).slice().sort((a, b) => a - b)
    .map((m) => TTX.api.alertLabel(m, !!raw.all_day));

  /** Put the end `ms` after the start, back in wall-clock fields. */
  function endAfter(f, ms) {
    const t = TTX.tz.toEpoch(f.startKey, f.startTime, f.allDay, TZ) + ms;
    const z = f.allDay ? 'UTC' : TZ;
    f.endKey = TTX.tz.ymd(t, z);
    f.endTime = TTX.tz.hm(t, z);
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

      // Every calendar the account has — not just the ones ticked in the
      // sidebar — and without disturbing what the window is showing, because
      // the person at the keyboard didn't run this command.
      //
      // That checkbox is a window control: it hides a calendar from the view
      // you are looking at. This has no window. Honouring it here meant `tf ls
      // --cal プライベート` answered 「予定はありません」 about a calendar that
      // was named out loud and had events in it — the same question, one
      // checkbox later, with the opposite answer and nothing to suggest it was
      // not true. MCP made it worse: an assistant cannot know the box exists,
      // so it repeats the lie with confidence.
      //
      // Of the two ways to be wrong, showing an event you had hidden is an
      // annoyance; hiding one you have is a missed appointment.
      const ids = new Set(cals.map((c) => c.id));
      const holidays = await TTX.store.holidaysFor(a, b).catch(() => []);
      const occs = TTX.store.occurrences(a, b, { holidays, only: ids });

      // Name the calendars, even when there are events. An empty list is the
      // reason: 「予定はありません」 could equally mean "nothing on" or "I
      // reached nothing", and a model reading this has no other way to tell
      // them apart — it said so itself, unprompted, the first time it saw a
      // zero. Same rule as `find` returning the window it searched.
      return { from: a, to: b, calendars: cals.map((c) => c.name), events: occs.map(shape) };
    },

    /**
     * Find an event when you don't know the date — 「先月の歯医者いつだっけ」.
     * Without this the only way to answer that is to guess ranges and sweep,
     * which an assistant will happily do and quietly get wrong at the edges.
     *
     * The answer carries the window it searched. A search that finds nothing is
     * evidence of absence only if you know where it looked, and this one has a
     * horizon (a year back, two forward — the recurrence expansion has to stop
     * somewhere). Handing back "no results" alone invites 「そんな予定は無い」
     * about an event that is simply outside it.
     */
    find({ query, limit } = {}) {
      const state = ready();
      const q = text(query).trim();
      if (!q) throw new Error('探す語を指定してください');
      const ids = new Set(state.calendars.map((c) => c.id));   // same rule as ls
      const n = Math.min(Math.max(Number(limit) || 20, 1), 100);
      const r = TTX.store.searchAll(q, n, { only: ids });
      return { query: q, from: r.from, to: r.to, events: r.events.map(shape) };
    },

    show({ uuid } = {}) {
      const { cal, raw } = locate(ready(), uuid);
      return { calendar: cal.name, event: raw, reminders: words(raw) };
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

    /**
     * Create an event. `startTime` null means all-day — a person who types a
     * day and no clock means the whole day, not midnight.
     *
     * The calendar must be named unless the account has exactly one. pick()
     * hands back all of them when nothing is named, which is right for reading
     * and wrong here: a shared calendar notifies its members, so guessing tells
     * the wrong family about your dentist.
     */
    async add({ title, startKey, startTime, endKey, endTime, mins, cal, location, note, alerts } = {}) {
      const state = ready();
      const name = String(title || '').trim();
      if (!name) throw new Error('タイトルを指定してください');
      if (!startKey) throw new Error('いつの予定か指定してください');

      const cals = pick(state, cal);
      if (!cals.length) throw new Error('書き込めるカレンダーがありません');
      if (cals.length > 1) {
        throw new Error(`どのカレンダーに作るか指定してください（--cal）: ${cals.map((c) => c.name).join('、')}`);
      }
      const target = cals[0];
      const allDay = !startTime;

      // toEpoch is the form's own function: it knows all-day is stored at UTC
      // midnight while a timed event resolves through the zone. Two answers to
      // "what time is this really" is one too many.
      const startAt = TTX.tz.toEpoch(startKey, startTime, allDay, TZ);
      let endAt;
      if (mins != null) {
        if (allDay) throw new Error('終日の予定に長さは指定できません');
        endAt = startAt + mins * 60000;
      } else if (!allDay && !endKey && !endTime) {
        endAt = startAt + 3600000;   // an hour. Nobody types an end time for a dentist
      } else {
        endAt = TTX.tz.toEpoch(endKey || startKey, endTime || startTime, allDay, TZ);
      }
      if (endAt < startAt) throw new Error('終わりが始まりより前です');

      // String(), not `|| ''`: a caller that hands us a boolean — the CLI's
      // parser turns a value-less `--where` into `true` — would otherwise pass
      // it straight through to TimeTree, which stored it as the location `t`.
      // The CLI refuses that now; this is so the next caller can't reintroduce it.
      const saved = await TTX.api.createEvent(target.id, {
        title: name, allDay, startAt, endAt, tz: TZ, labelId: 1,
        location: text(location), note: text(note),
        // The creator is an attendee, because that is what TimeTree's form does
        // and what the window's form does — measured, both. Leaving it off
        // makes an event that renders without your avatar on everyone's phone,
        // which is not "made from the terminal", it just looks like a mistake.
        attendees: state.me?.id ? [state.me.id] : [],
        // No reminder asked for means TimeTree's default, not silence: its own
        // form puts a day-ahead reminder on everything (measured — [1440]
        // timed, [900] all-day), and 「歯医者入れといて」 does not mean "and
        // don't tell me about it". `--alert none` / `reminders: []` is how you
        // say none. alertsFor picks the right rung.
        alerts: alertsFor(alerts === undefined ? [{ days: 1 }] : alerts, allDay),
      });
      if (!saved?.uuid) throw new Error('サーバーが予定を返しませんでした');
      TTX.store.applyEvent(target.id, saved);
      TTX.cli._render?.();
      return { calendar: target.name, event: saved, reminders: words(saved) };
    },

    /**
     * Change one event. Anything not given stays as it is — including the half
     * of a time you didn't mention: `--at 7/21` on a 10:00 event means the 21st
     * at 10:00, not the 21st at midnight.
     *
     * Moving the start keeps the length, which is what 「ずらして」 means and
     * what dragging does everywhere else.
     */
    async edit({ uuid, title, at, to, mins, location, note, alerts } = {}) {
      const state = ready();
      const { cal, raw } = locate(state, uuid);
      if (series(raw)) {
        throw new Error(`"${raw.title || '(無題)'}" は繰り返しの予定です。この id は全部の回を指すので、`
          + `ここから直すと毎回が変わります。1回だけ直すならウィンドウから編集してください。`);
      }
      if (!TTX.cli._fields || !TTX.cli._patch) throw new Error('編集できません');

      const f = TTX.cli._fields(raw);           // the form's own reading of it
      if (title !== undefined && text(title).trim()) f.title = text(title).trim();
      if (location !== undefined) f.location = text(location);
      if (note !== undefined) f.note = text(note);

      if (at) {
        const from = TTX.tz.toEpoch(f.startKey, f.startTime, f.allDay, TZ);
        let span = TTX.tz.toEpoch(f.endKey, f.endTime, f.allDay, TZ) - from;
        f.startKey = at.key;
        if (at.time) {
          // An all-day event handed a clock becomes a timed one — and its old
          // length was measured in days, which is not what "10時から" means.
          if (f.allDay) { f.allDay = false; span = 3600000; }
          f.startTime = at.time;
        }
        endAfter(f, span);
      }
      if (to) {
        f.endKey = to.key;
        if (to.time) { f.allDay = false; f.endTime = to.time; }
      }
      if (mins != null) {
        if (f.allDay) throw new Error('終日の予定に長さは指定できません');
        endAfter(f, mins * 60000);
      }
      if (TTX.tz.toEpoch(f.endKey, f.endTime, f.allDay, TZ)
        < TTX.tz.toEpoch(f.startKey, f.startTime, f.allDay, TZ)) {
        throw new Error('終わりが始まりより前です');
      }

      // Reminders last, because which ladder they ride is decided by everything
      // above: `--at "7/21 10:00"` on an all-day event has just made it timed.
      if (alerts !== undefined) {
        f.alerts = alertsFor(alerts, f.allDay);
      } else if (f.allDay !== !!raw.all_day) {
        // The person didn't mention reminders, but we just moved the goalposts
        // out from under the ones they had. The exact minute is unrecoverable
        // either way; 「だいたい1日前」 survives, and dropping them silently
        // does not. Same call the form's all-day toggle makes.
        f.alerts = TTX.cli._remapAlerts ? TTX.cli._remapAlerts(f.alerts, f.allDay) : f.alerts;
      }

      const patch = TTX.cli._patch(raw, f);     // the form's own diff — PUT is a merge
      if (!Object.keys(patch).length) throw new Error('変更はありません');
      const saved = await TTX.api.updateEvent(cal.id, raw.uuid, patch);
      const now = saved?.uuid ? saved : { ...raw, ...patch };
      TTX.store.applyEvent(cal.id, now);
      TTX.cli._render?.();
      return { calendar: cal.name, changed: Object.keys(patch), event: now, reminders: words(now) };
    },

    async rm({ uuid, all } = {}) {
      const state = ready();
      const { cal, raw } = locate(state, uuid);
      if (series(raw) && !all) {
        // Not naming a flag: this same message goes to the CLI and to MCP, and
        // the two say yes differently. The parenthetical is for the person at
        // the terminal, who has no schema to read.
        throw new Error(`"${raw.title || '(無題)'}" は繰り返しの予定で、この id は全部の回を指しています。`
          + `すべての回を消すと明示してください（tf なら --all）。1回だけ消すならウィンドウから。`);
      }
      await TTX.api.deleteEvent(cal.id, raw.uuid);
      TTX.store.markDeleted(cal.id, raw.uuid);
      TTX.cli._render?.();
      return { calendar: cal.name, title: raw.title || '(無題)', series: series(raw) };
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
