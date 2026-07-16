/* The drawer: agenda + search + filters + export. */
(() => {
  const TTX = (globalThis.TTX = globalThis.TTX || {});
  const { DAY, ymd, addDays, parseYmd, WEEKDAY_JA, weekdayOf } = TTX.tz;

  const TZ = 'Asia/Tokyo';
  const el = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  };

  const state = {
    calendars: [],
    enabled: new Set(),      // calendar ids to include
    events: new Map(),       // calendarId -> raw events
    labels: new Map(),       // calendarId -> label list
    members: new Map(),      // calendarId -> Map(user_id -> member)
    holidays: [],
    holidayKey: '',          // range the cached holidays cover
    showHolidays: true,
    mutedLabels: new Set(),  // "calId:labelId"
    from: '',
    to: '',
    query: '',
    loading: false,
  };

  let root, panel, listEl, footEl, fab, toastEl;

  // --- helpers ---------------------------------------------------------

  const todayKey = () => ymd(Date.now(), TZ);

  function monthRange(offset = 0) {
    const now = new Date(Date.now() + TTX.tz.tzOffset(TZ, Date.now()));
    const y = now.getUTCFullYear();
    const m = now.getUTCMonth() + offset;
    const from = ymd(Date.UTC(y, m, 1), 'UTC');
    const to = ymd(Date.UTC(y, m + 1, 0), 'UTC');
    return { from, to };
  }

  const PRESETS = {
    'this-month': { label: '今月', get: () => monthRange(0) },
    'next-month': { label: '来月', get: () => monthRange(1) },
    'two-months': { label: '今月＋来月', get: () => ({ from: monthRange(0).from, to: monthRange(1).to }) },
    'next-30': { label: '今後30日', get: () => ({ from: todayKey(), to: addDays(todayKey(), 30) }) },
    'next-90': { label: '今後90日', get: () => ({ from: todayKey(), to: addDays(todayKey(), 90) }) },
    'this-year': { label: '今年', get: () => ({ from: todayKey().slice(0, 4) + '-01-01', to: todayKey().slice(0, 4) + '-12-31' }) },
  };

  function toast(msg) {
    toastEl.textContent = msg;
    toastEl.classList.add('ttx-show');
    clearTimeout(toast._t);
    toast._t = setTimeout(() => toastEl.classList.remove('ttx-show'), 1900);
  }

  function download(name, text, mime) {
    const blob = new Blob([text], { type: mime + ';charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = el('a');
    a.href = url;
    a.download = name;
    document.documentElement.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }

  const labelOf = (calId, labelId) => (state.labels.get(calId) || []).find((l) => l.id === labelId);

  // --- data ------------------------------------------------------------

  function currentOccurrences() {
    const from = parseYmd(state.from);
    const to = parseYmd(state.to) + DAY - 1;
    let all = [];
    for (const cal of state.calendars) {
      if (!state.enabled.has(cal.id)) continue;
      const raw = state.events.get(cal.id);
      if (!raw) continue;
      all = all.concat(
        TTX.model.occurrences(raw, from, to, cal, { membersById: state.members.get(cal.id) })
      );
    }
    all = all.filter((o) => !state.mutedLabels.has(o.calendarId + ':' + o.labelId));
    if (state.showHolidays) {
      all = all.concat(TTX.model.holidayOccurrences(state.holidays));
    }
    return all.filter((o) => TTX.model.matchesQuery(o, state.query));
  }

  async function loadCalendar(cal) {
    if (state.events.has(cal.id)) return;
    const [events, labels, members] = await Promise.all([
      TTX.api.allEvents(cal.id, (n) => setStatus(`${cal.name}: ${n} 件読み込み中…`)),
      TTX.api.labels(cal.id),
      TTX.api.members(cal.id),
    ]);
    state.events.set(cal.id, events);
    state.labels.set(cal.id, labels);
    state.members.set(cal.id, new Map(members.map((m) => [m.user_id, m])));
  }

  /** Holidays are range-scoped, so refetch whenever the window moves. */
  async function loadHolidays() {
    const key = state.from + '|' + state.to;
    if (state.holidayKey === key) return;
    state.holidays = await TTX.api.memorialdays(parseYmd(state.from), parseYmd(state.to) + DAY - 1);
    state.holidayKey = key;
  }

  async function refresh() {
    if (state.loading) return;
    state.loading = true;
    try {
      for (const cal of state.calendars) {
        if (state.enabled.has(cal.id)) await loadCalendar(cal);
      }
      await loadHolidays();
      renderFilters();
      render();
    } catch (e) {
      setStatus('エラー: ' + e.message);
      console.error('[TimeForest]', e);
    } finally {
      state.loading = false;
    }
  }

  /** Range changes need holidays refetched; everything else is already cached. */
  async function rangeChanged() {
    render();
    try {
      await loadHolidays();
      render();
    } catch (e) {
      console.error('[TimeForest] holidays', e);
    }
  }

  // --- render ----------------------------------------------------------

  function setStatus(text) {
    if (!footEl) return;
    footEl.querySelector('.ttx-status').textContent = text;
  }

  function render() {
    const occs = currentOccurrences();
    const byDay = TTX.model.groupByDay(occs, state.from, state.to);
    const today = todayKey();

    listEl.textContent = '';
    let month = '';
    let shown = 0;

    for (const [key, list] of Object.entries(byDay)) {
      const m = key.slice(0, 7);
      if (m !== month) {
        month = m;
        listEl.appendChild(el('div', 'ttx-month', `${m.slice(0, 4)}年 ${Number(m.slice(5, 7))}月`));
      }

      const dow = weekdayOf(key);
      const day = el('div', 'ttx-day' + (list.length ? '' : ' ttx-empty') + (key === today ? ' ttx-today' : ''));

      const date = el('div', 'ttx-date' + (dow === 0 ? ' ttx-sun' : dow === 6 ? ' ttx-sat' : ''));
      date.appendChild(el('div', 'ttx-d', String(Number(key.slice(8, 10)))));
      date.appendChild(el('div', 'ttx-w', WEEKDAY_JA[dow]));
      day.appendChild(date);

      const evs = el('div', 'ttx-events');
      if (!list.length) {
        evs.appendChild(el('div', 'ttx-none', '—'));
      } else {
        for (const o of list) {
          shown++;
          const row = el('div', 'ttx-ev' +
            (o.allDay ? ' ttx-allday' : '') +
            (o.holiday ? ' ttx-holiday' : ''));

          const bar = el('div', 'ttx-bar');
          const lb = labelOf(o.calendarId, o.labelId);
          if (lb) bar.style.background = TTX.api.colorHex(lb.color);
          row.appendChild(bar);

          row.appendChild(el('div', 'ttx-t', o.holiday ? (o.workday ? '暦' : '祝') : o.allDay ? '終日' : o.startTime));

          const t = el('div', 'ttx-title');
          t.appendChild(document.createTextNode(o.title));
          const meta = [];
          if (o.multiDay) {
            const i = o.days.indexOf(key) + 1;
            meta.push(`${i}/${o.days.length}日目`);
          }
          if (o.location) meta.push('@' + o.location);
          if (state.enabled.size > 1 && o.calendarName) meta.push(o.calendarName);
          if (meta.length) {
            t.appendChild(document.createTextNode(' '));
            t.appendChild(el('span', 'ttx-meta', meta.join(' · ')));
          }
          row.appendChild(t);
          evs.appendChild(row);
        }
      }
      day.appendChild(evs);
      listEl.appendChild(day);
    }

    const total = state.calendars.filter((c) => state.enabled.has(c.id))
      .reduce((n, c) => n + (state.events.get(c.id)?.length || 0), 0);
    setStatus(`${shown} 件・${state.from} 〜 ${state.to}・全 ${total} 件から展開`);
  }

  function renderFilters() {
    const box = panel.querySelector('.ttx-labels');
    box.textContent = '';
    for (const cal of state.calendars) {
      if (!state.enabled.has(cal.id)) continue;
      for (const lb of state.labels.get(cal.id) || []) {
        if (!lb.name) continue; // TimeTree ships unnamed placeholder labels
        const key = cal.id + ':' + lb.id;
        const on = !state.mutedLabels.has(key);
        const chip = el('button', 'ttx-chip ' + (on ? 'ttx-on' : 'ttx-off'));
        const dot = el('span', 'ttx-dot');
        dot.style.background = TTX.api.colorHex(lb.color);
        chip.appendChild(dot);
        chip.appendChild(document.createTextNode(lb.name));
        chip.onclick = () => {
          if (on) state.mutedLabels.add(key); else state.mutedLabels.delete(key);
          renderFilters();
          render();
        };
        box.appendChild(chip);
      }
    }
  }

  // --- build -----------------------------------------------------------

  function build() {
    root = el('div', 'ttx-root');
    root.id = 'ttx-root';

    fab = el('button', 'ttx-fab');
    fab.textContent = '☰';
    fab.title = 'TimeForest';
    fab.onclick = open;
    root.appendChild(fab);

    panel = el('aside', 'ttx-panel');
    panel.innerHTML = `
      <div class="ttx-head">
        <h1>TimeForest<span class="ttx-sub"></span></h1>
        <button class="ttx-icon-btn ttx-dark-btn" title="テーマ">🌗</button>
        <button class="ttx-icon-btn ttx-reload" title="再取得">⟳</button>
        <button class="ttx-icon-btn ttx-close" title="閉じる">✕</button>
      </div>
      <div class="ttx-tools">
        <div class="ttx-row">
          <select class="ttx-preset"></select>
          <input type="date" class="ttx-from">
          <span class="ttx-dash">〜</span>
          <input type="date" class="ttx-to">
        </div>
        <div class="ttx-row">
          <input type="search" class="ttx-q" placeholder="タイトル・場所・メモを検索">
        </div>
        <div class="ttx-row ttx-cals"></div>
        <div class="ttx-row ttx-labels"></div>
      </div>
      <div class="ttx-list"></div>
      <div class="ttx-foot">
        <span class="ttx-status">読み込み中…</span>
        <span class="ttx-spacer"></span>
        <button class="ttx-btn ttx-primary" data-x="md">MD</button>
        <button class="ttx-btn" data-x="csv">CSV</button>
        <button class="ttx-btn" data-x="json">JSON</button>
        <button class="ttx-btn" data-x="ics">ICS</button>
      </div>
    `;
    root.appendChild(panel);

    toastEl = el('div', 'ttx-toast');
    root.appendChild(toastEl);

    listEl = panel.querySelector('.ttx-list');
    footEl = panel.querySelector('.ttx-foot');

    // Live outside <body> so the dark-mode filter on <body> can't capture our
    // fixed positioning or invert our colours.
    document.documentElement.appendChild(root);

    const preset = panel.querySelector('.ttx-preset');
    for (const [k, v] of Object.entries(PRESETS)) {
      const o = el('option', null, v.label);
      o.value = k;
      preset.appendChild(o);
    }
    const custom = el('option', null, 'カスタム');
    custom.value = 'custom';
    preset.appendChild(custom);

    const fromI = panel.querySelector('.ttx-from');
    const toI = panel.querySelector('.ttx-to');

    preset.onchange = () => {
      const p = PRESETS[preset.value];
      if (!p) return;
      const r = p.get();
      state.from = r.from;
      state.to = r.to;
      fromI.value = r.from;
      toI.value = r.to;
      rangeChanged();
    };
    const onDate = () => {
      if (!fromI.value || !toI.value) return;
      if (fromI.value > toI.value) return;
      state.from = fromI.value;
      state.to = toI.value;
      preset.value = 'custom';
      rangeChanged();
    };
    fromI.onchange = onDate;
    toI.onchange = onDate;

    let qTimer;
    panel.querySelector('.ttx-q').oninput = (e) => {
      clearTimeout(qTimer);
      qTimer = setTimeout(() => {
        state.query = e.target.value.trim();
        render();
      }, 140);
    };

    panel.querySelector('.ttx-close').onclick = close;
    panel.querySelector('.ttx-dark-btn').onclick = () => {
      const m = TTX.dark.cycle();
      toast('テーマ: ' + TTX.dark.LABEL[m]);
    };
    panel.querySelector('.ttx-reload').onclick = () => {
      state.events.clear();
      state.holidayKey = '';
      setStatus('再取得中…');
      refresh();
    };

    footEl.addEventListener('click', (e) => {
      const kind = e.target.dataset?.x;
      if (kind) doExport(kind);
    });

    const syncTheme = () => {
      root.classList.toggle('ttx-ui-dark', TTX.dark.isDark());
      const btn = panel.querySelector('.ttx-dark-btn');
      btn.textContent = TTX.dark.ICON[TTX.dark.mode];
      btn.title = 'テーマ: ' + TTX.dark.LABEL[TTX.dark.mode];
    };
    window.addEventListener('ttx:dark', syncTheme);
    syncTheme();

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && panel.classList.contains('ttx-open')) close();
    });
  }

  function doExport(kind) {
    const occs = currentOccurrences();
    const byDay = TTX.model.groupByDay(occs, state.from, state.to);
    const names = state.calendars.filter((c) => state.enabled.has(c.id)).map((c) => c.name).join('・');
    const title = `${names} ${state.from}〜${state.to}`;
    const stem = `timetree_${state.from}_${state.to}`;

    if (kind === 'md') {
      const md = TTX.exporters.toMarkdown(byDay, { title, skipEmpty: false });
      navigator.clipboard.writeText(md).then(
        () => toast('Markdown をコピーしました'),
        () => download(stem + '.md', md, 'text/markdown')
      );
    } else if (kind === 'csv') {
      download(stem + '.csv', TTX.exporters.toCSV(occs), 'text/csv');
      toast('CSV を保存しました');
    } else if (kind === 'json') {
      download(stem + '.json', TTX.exporters.toJSON(byDay), 'application/json');
      toast('JSON を保存しました');
    } else if (kind === 'ics') {
      download(stem + '.ics', TTX.exporters.toICS(occs, { title }), 'text/calendar');
      toast('ICS を保存しました');
    }
  }

  function renderCalPicker() {
    const box = panel.querySelector('.ttx-cals');
    box.textContent = '';
    for (const cal of state.calendars) {
      const on = state.enabled.has(cal.id);
      const chip = el('button', 'ttx-chip ' + (on ? 'ttx-on' : 'ttx-off'), cal.name);
      chip.onclick = async () => {
        if (on) {
          if (state.enabled.size === 1) return toast('最低1つは必要です');
          state.enabled.delete(cal.id);
        } else {
          state.enabled.add(cal.id);
        }
        renderCalPicker();
        await refresh();
      };
      box.appendChild(chip);
    }
  }

  const open = () => {
    panel.classList.add('ttx-open');
    fab.hidden = true;
  };
  const close = () => {
    panel.classList.remove('ttx-open');
    fab.hidden = false;
  };
  const toggle = () => (panel.classList.contains('ttx-open') ? close() : open());

  async function init() {
    build();
    const r = monthRange(0);
    state.from = r.from;
    state.to = addDays(monthRange(1).to, 0);
    panel.querySelector('.ttx-preset').value = 'two-months';
    panel.querySelector('.ttx-from').value = state.from;
    panel.querySelector('.ttx-to').value = state.to;

    try {
      const { list, current } = await TTX.api.currentCalendar();
      state.calendars = list;
      if (current) state.enabled.add(current.id);
      panel.querySelector('.ttx-sub').textContent = current ? current.name : '';
      renderCalPicker();
      await refresh();
    } catch (e) {
      setStatus('エラー: ' + e.message);
      console.error('[TimeForest]', e);
    }
  }

  TTX.panel = { init, open, close, toggle };
})();
