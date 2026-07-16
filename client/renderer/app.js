/* TimeTree client — UI.
 *
 * What this does that the web app doesn't:
 *   - an agenda view at all (the web app only has month/week grids)
 *   - a month grid that *counts* what it can't fit instead of silently
 *     dropping it (TimeTree drops events past the cell height with no hint)
 *   - one merged view across every calendar rather than switching between them
 *   - instant search over the entire history, because it's all in memory
 *   - a command palette, so nothing needs the mouse
 *   - dark mode
 */
(() => {
  const TTX = globalThis.TTX;
  const { DAY, ymd, addDays, parseYmd, WEEKDAY_JA, weekdayOf, tzOffset } = TTX.tz;
  const TZ = 'Asia/Tokyo';
  const $ = (sel, root = document) => root.querySelector(sel);

  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  const ui = {
    view: 'agenda',
    cursor: '',            // any date inside the focused month
    query: '',
    mutedLabels: new Set(),
    theme: 'system',
    dark: false,
    holidays: [],
    palette: null,
    detail: null,
    menu: null,
    accounts: [],
    activeId: null,
    cellCap: 4,
    status: '',
  };

  const todayKey = () => ymd(Date.now(), TZ);
  const monthOf = (key) => key.slice(0, 7);
  const monthStart = (key) => key.slice(0, 8) + '01';
  const monthEnd = (key) => {
    const [y, m] = key.split('-').map(Number);
    return ymd(Date.UTC(y, m, 0), 'UTC');
  };
  const addMonths = (key, n) => {
    const [y, m, d] = key.split('-').map(Number);
    const t = Date.UTC(y, m - 1 + n, 1);
    const last = +monthEnd(ymd(t, 'UTC')).slice(8);
    return ymd(Date.UTC(y, m - 1 + n, Math.min(d, last)), 'UTC');
  };

  const weekStart = (key) => addDays(key, -weekdayOf(key));

  /** Agenda spans three months; month spans one; week spans seven days. */
  function range() {
    if (ui.view === 'month') return { from: monthStart(ui.cursor), to: monthEnd(ui.cursor) };
    if (ui.view === 'week') {
      const s = weekStart(ui.cursor);
      return { from: s, to: addDays(s, 6) };
    }
    return { from: monthStart(ui.cursor), to: monthEnd(addMonths(ui.cursor, 2)) };
  }

  // --- persistence ------------------------------------------------------

  const PREF = 'ttc.prefs';
  function savePrefs() {
    try {
      localStorage.setItem(PREF, JSON.stringify({
        view: ui.view,
        theme: ui.theme,
        muted: [...ui.mutedLabels],
        disabled: TTX.store.state.calendars
          .filter((c) => !TTX.store.state.enabled.has(c.id)).map((c) => c.id),
      }));
    } catch { /* non-fatal */ }
  }
  function loadPrefs() {
    try {
      const p = JSON.parse(localStorage.getItem(PREF) || '{}');
      if (p.view) ui.view = p.view;
      if (p.theme) ui.theme = p.theme;
      if (p.muted) ui.mutedLabels = new Set(p.muted);
      return p;
    } catch {
      return {};
    }
  }

  // --- theme ------------------------------------------------------------

  const THEME_LABEL = { system: 'システムに従う', light: 'ライト', dark: 'ダーク' };
  const THEME_ICON = { system: '◐', light: '☀', dark: '☾' };

  /**
   * The attribute swap has to happen *inside* the transition callback. Flip it
   * beforehand and the "old" snapshot is captured already wearing the new
   * colours, so there's nothing to dissolve between and the theme just snaps.
   */
  async function applyTheme(mode, animate = true) {
    ui.theme = mode;
    const dark = await window.host.theme.set(mode);
    const swap = () => {
      ui.dark = dark;
      document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light');
      paint();
    };
    savePrefs();
    if (!animate || !document.startViewTransition || reducedMotion()) return swap();
    document.documentElement.dataset.nav = 'theme';
    endNav(document.startViewTransition(swap));
  }

  // --- toast ------------------------------------------------------------

  let toastEl;
  function toast(msg) {
    if (!toastEl) {
      toastEl = el('div', 'toast');
      document.body.appendChild(toastEl);
    }
    toastEl.textContent = msg;
    toastEl.classList.add('show');
    clearTimeout(toast._t);
    toast._t = setTimeout(() => toastEl.classList.remove('show'), 2000);
  }

  function download(name, text, mime) {
    const blob = new Blob([text], { type: mime + ';charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = el('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 3000);
  }

  // --- data helpers -----------------------------------------------------

  function occs() {
    const { from, to } = range();
    return TTX.store.occurrences(from, to, {
      mutedLabels: ui.mutedLabels,
      holidays: ui.holidays,
      query: ui.query,
    });
  }

  const railColor = (o) => {
    if (o.holiday) return 'var(--red)';
    const lb = TTX.store.labelOf(o.calendarId, o.labelId);
    return lb ? TTX.api.colorHex(lb.color) : 'var(--label-3)';
  };

  /** Lowest `order` among enabled calendars — the user's main one. */
  function primaryCalendarId() {
    const st = TTX.store.state;
    const on = st.calendars.filter((c) => st.enabled.has(c.id));
    if (on.length < 2) return null;
    return on.slice().sort((a, b) => (a.order ?? 0) - (b.order ?? 0))[0]?.id ?? null;
  }

  async function ensureHolidays() {
    const { from, to } = range();
    ui.holidays = await TTX.store.holidaysFor(from, to).catch(() => []);
  }

  // --- render: toolbar --------------------------------------------------

  /** The title has to name what's actually on screen, not always a month. */
  function titleText() {
    const [y, m] = ui.cursor.split('-');
    if (ui.view !== 'week') return `${y}年 ${+m}月`;
    const s = weekStart(ui.cursor);
    const e = addDays(s, 6);
    return monthOf(s) === monthOf(e)
      ? `${s.slice(0, 4)}年 ${+s.slice(5, 7)}月 ${+s.slice(8)}–${+e.slice(8)}日`
      : `${s.slice(0, 4)}年 ${+s.slice(5, 7)}/${+s.slice(8)} – ${+e.slice(5, 7)}/${+e.slice(8)}`;
  }

  function renderToolbar() {
    const t = el('div', 'toolbar');

    t.appendChild(el('div', 'tb-title', titleText()));

    const nav = el('div', 'nav');
    const prev = el('button', 'icon-btn', '‹');
    prev.title = (ui.view === 'week' ? '前の週' : '前の月') + ' (←)';
    prev.onclick = () => go(-1);
    const today = el('button', 'pill', '今日');
    today.title = '今日 (T)';
    today.onclick = () => jumpTo(todayKey());
    const next = el('button', 'icon-btn', '›');
    next.title = (ui.view === 'week' ? '次の週' : '次の月') + ' (→)';
    next.onclick = () => go(1);
    nav.append(prev, today, next);
    t.appendChild(nav);

    t.appendChild(el('div', 'tb-spacer'));

    const seg = el('div', 'seg');
    for (const [key, label] of [['agenda', 'アジェンダ'], ['week', '週'], ['month', '月']]) {
      const b = el('button', ui.view === key ? 'on' : '', label);
      b.onclick = () => setView(key);
      seg.appendChild(b);
    }
    t.appendChild(seg);

    const search = el('button', 'search-hint');
    search.append(el('span', null, '⌕'), el('span', null, ui.query || '検索・移動'));
    search.appendChild(el('kbd', null, 'Ctrl K'));
    search.onclick = () => openPalette();
    t.appendChild(search);

    const theme = el('button', 'icon-btn', THEME_ICON[ui.theme]);
    theme.title = 'テーマ: ' + THEME_LABEL[ui.theme];
    theme.onclick = () => {
      const order = ['system', 'light', 'dark'];
      applyTheme(order[(order.indexOf(ui.theme) + 1) % 3]);
      toast('テーマ: ' + THEME_LABEL[ui.theme]);
    };
    t.appendChild(theme);

    const sync = el('button', 'icon-btn', '⟳');
    sync.title = '再同期';
    sync.onclick = () => resync();
    t.appendChild(sync);

    return t;
  }

  /** Step by whatever the current view actually shows. */
  function go(n) {
    ui.cursor = ui.view === 'week' ? addDays(ui.cursor, n * 7) : addMonths(ui.cursor, n);
    refresh(n > 0 ? 'next' : 'prev');
  }

  /** Jumping to an arbitrary date should still feel directional. */
  function jumpTo(key, view) {
    const dir = key > ui.cursor ? 'next' : key < ui.cursor ? 'prev' : 'fade';
    ui.cursor = key;
    if (view) { ui.view = view; savePrefs(); }
    refresh(dir);
  }

  function setView(v) {
    if (ui.view === v) return;
    ui.view = v;
    savePrefs();
    refresh('fade');
  }

  // --- accounts ---------------------------------------------------------

  /** Deterministic colour per account so the avatar is recognisable at a glance. */
  const ACCT_COLORS = ['#2ecc87', '#47b2f7', '#f35f8c', '#fdc02d', '#b38bdc', '#3dc2c8'];
  const acctColor = (id) => {
    let h = 0;
    for (const c of id) h = (h * 31 + c.charCodeAt(0)) >>> 0;
    return ACCT_COLORS[h % ACCT_COLORS.length];
  };

  function renderAccountBar() {
    const cur = ui.accounts.find((a) => a.id === ui.activeId);
    const bar = el('button', 'acct');
    const av = el('span', 'acct-av', (cur?.name || '?').slice(0, 1));
    av.style.background = cur ? acctColor(cur.id) : 'var(--label-3)';
    const box = el('span', 'acct-box');
    box.append(el('span', 'acct-nm', cur?.name || 'アカウント'),
      el('span', 'acct-em', cur?.email || ''));
    bar.append(av, box, el('span', 'acct-cv', '⌄'));
    bar.title = 'アカウントを切り替え';
    bar.onclick = () => openAccountMenu(bar);
    return bar;
  }

  function openAccountMenu(anchor) {
    closeMenus();
    const scrim = el('div', 'd-scrim');
    const menu = el('div', 'menu');

    for (const a of ui.accounts) {
      const on = a.id === ui.activeId;
      const it = el('button', 'menu-i' + (on ? ' on' : ''));
      const av = el('span', 'acct-av sm', a.name.slice(0, 1));
      av.style.background = acctColor(a.id);
      const box = el('span', 'acct-box');
      box.append(el('span', 'acct-nm', a.name), el('span', 'acct-em', a.email || ''));
      it.append(av, box);
      if (on) it.appendChild(el('span', 'menu-ck', '✓'));
      it.onclick = () => { closeMenus(); if (!on) switchAccount(a.id); };
      menu.appendChild(it);

      if (ui.accounts.length > 1) {
        const rm = el('button', 'menu-x', '✕');
        rm.title = a.name + ' を削除';
        rm.onclick = (e) => { e.stopPropagation(); closeMenus(); removeAccount(a); };
        it.appendChild(rm);
      }
    }

    menu.appendChild(el('div', 'menu-sep'));
    const add = el('button', 'menu-i');
    add.append(el('span', 'menu-ic', '＋'), el('span', 'acct-nm', 'アカウントを追加'));
    add.onclick = () => { closeMenus(); addAccount(); };
    menu.appendChild(add);

    scrim.appendChild(menu);
    document.body.appendChild(scrim);

    const r = anchor.getBoundingClientRect();
    menu.style.left = r.left + 'px';
    menu.style.top = r.bottom + 4 + 'px';
    menu.style.minWidth = Math.max(r.width, 220) + 'px';
    requestAnimationFrame(() => menu.classList.add('in'));
    scrim.onclick = (e) => { if (e.target === scrim) closeMenus(); };
    ui.menu = scrim;
  }

  function closeMenus() {
    ui.menu?.remove();
    ui.menu = null;
  }

  async function refreshAccounts() {
    const r = await window.host.accounts.list();
    ui.accounts = r.accounts;
    ui.activeId = r.activeId;
    return r;
  }

  async function addAccount() {
    const r = await window.host.accounts.add();
    ui.accounts = r.accounts;
    ui.activeId = r.activeId;
    if (r.added) await loadActiveAccount();
    else if (!ui.activeId) bootUI();
  }

  async function switchAccount(id) {
    const r = await window.host.accounts.switch(id);
    ui.accounts = r.accounts;
    ui.activeId = r.activeId;
    await loadActiveAccount();
  }

  async function removeAccount(a) {
    const wasActive = a.id === ui.activeId;
    const r = await window.host.accounts.remove(a.id);
    ui.accounts = r.accounts;
    ui.activeId = r.activeId;
    toast(`${a.name} を削除しました`);
    if (wasActive) await loadActiveAccount();
    else render();
  }

  // --- render: sidebar --------------------------------------------------

  function renderSidebar() {
    const s = el('aside', 'sidebar');
    const st = TTX.store.state;

    s.appendChild(renderAccountBar());
    s.appendChild(el('div', 'side-h', 'カレンダー'));
    for (const cal of st.calendars) {
      const on = st.enabled.has(cal.id);
      const b = el('button', 'side-item' + (on ? '' : ' off'));
      const dot = el('span', 'dot');
      dot.style.background = TTX.api.colorHex(cal.color ?? 0x2ecc87);
      b.append(dot, el('span', 'nm', cal.name));
      b.onclick = () => {
        if (on && st.enabled.size === 1) return toast('最低1つは必要です');
        on ? st.enabled.delete(cal.id) : st.enabled.add(cal.id);
        savePrefs();
        render();
      };
      s.appendChild(b);
    }

    const labels = [];
    for (const cal of st.calendars) {
      if (!st.enabled.has(cal.id)) continue;
      for (const lb of st.labels.get(cal.id) || []) {
        if (lb.name) labels.push({ cal, lb });
      }
    }
    if (labels.length) {
      s.appendChild(el('div', 'side-h', 'ラベル'));
      for (const { cal, lb } of labels) {
        const key = cal.id + ':' + lb.id;
        const on = !ui.mutedLabels.has(key);
        const b = el('button', 'side-item' + (on ? '' : ' off'));
        const dot = el('span', 'dot');
        dot.style.background = TTX.api.colorHex(lb.color);
        b.append(dot, el('span', 'nm', lb.name));
        b.onclick = () => {
          on ? ui.mutedLabels.add(key) : ui.mutedLabels.delete(key);
          savePrefs();
          render();
        };
        s.appendChild(b);
      }
    }

    const foot = el('div', 'side-foot');
    for (const [kind, label] of [['md', 'MD'], ['csv', 'CSV'], ['json', 'JSON'], ['ics', 'ICS']]) {
      const b = el('button', 'mini-btn', label);
      b.title = label + ' で書き出し';
      b.onclick = () => doExport(kind);
      foot.appendChild(b);
    }
    s.appendChild(foot);
    s.appendChild(el('div', 'side-status', ui.status));
    return s;
  }

  // --- render: agenda ---------------------------------------------------

  function renderAgenda() {
    const { from, to } = range();
    const byDay = TTX.model.groupByDay(occs(), from, to);
    const wrap = el('div', 'agenda');
    const today = todayKey();
    let month = '';
    let count = 0;

    for (const [key, list] of Object.entries(byDay)) {
      const m = monthOf(key);
      if (m !== month) {
        month = m;
        wrap.appendChild(el('div', 'ag-month', `${m.slice(0, 4)}年 ${Number(m.slice(5))}月`));
      }
      const dow = weekdayOf(key);
      const day = el('div', 'ag-day' + (list.length ? '' : ' empty') + (key === today ? ' today' : ''));

      const date = el('div', 'ag-date' + (dow === 0 ? ' sun' : dow === 6 ? ' sat' : ''));
      date.append(el('div', 'd', String(+key.slice(8))), el('div', 'w', WEEKDAY_JA[dow]));
      day.appendChild(date);

      const evs = el('div', 'ag-events');
      if (!list.length) {
        evs.appendChild(el('div', 'none', '—'));
      } else {
        for (const o of list) {
          count++;
          evs.appendChild(eventRow(o, key));
        }
      }
      day.appendChild(evs);
      wrap.appendChild(day);
    }
    ui.status = `${count} 件 / ${from} 〜 ${to}`;
    return wrap;
  }

  function eventRow(o, dayKey) {
    const row = el('div', 'ev' + (o.allDay ? ' allday' : '') + (o.holiday ? ' holiday' : ''));
    const rail = el('div', 'rail');
    rail.style.background = railColor(o);
    row.appendChild(rail);
    row.appendChild(el('div', 't', o.holiday ? (o.workday ? '暦' : '祝') : o.allDay ? '終日' : o.startTime));

    const ti = el('div', 'ti');
    ti.appendChild(document.createTextNode(o.title));
    const meta = [];
    if (o.multiDay) meta.push(`${o.days.indexOf(dayKey) + 1}/${o.days.length}日目`);
    if (o.location) meta.push('@' + o.location);
    // Tag only the *other* calendars. Stamping "家族" on all 255 rows is noise;
    // leaving the main calendar implicit makes the odd one out actually visible.
    const primary = primaryCalendarId();
    if (primary && o.calendarId && o.calendarId !== primary && o.calendarName) {
      meta.push(o.calendarName);
    }
    if (meta.length) {
      ti.appendChild(document.createTextNode(' '));
      ti.appendChild(el('span', 'meta', meta.join(' · ')));
    }
    row.appendChild(ti);
    row.onclick = () => openDetail(o, row);
    return row;
  }

  // --- render: month ----------------------------------------------------

  function renderMonth() {
    const from = monthStart(ui.cursor);
    const to = monthEnd(ui.cursor);
    const gridFrom = addDays(from, -weekdayOf(from));
    const gridTo = addDays(gridFrom, 41);

    const all = TTX.store.occurrences(gridFrom, gridTo, {
      mutedLabels: ui.mutedLabels,
      holidays: ui.holidays,
      query: ui.query,
    });
    const byDay = TTX.model.groupByDay(all, gridFrom, gridTo);

    const wrap = el('div', 'month');
    const head = el('div', 'm-head');
    for (let i = 0; i < 7; i++) {
      head.appendChild(el('div', i === 0 ? 'sun' : i === 6 ? 'sat' : '', WEEKDAY_JA[i]));
    }
    wrap.appendChild(head);

    const grid = el('div', 'm-grid');
    const today = todayKey();
    let count = 0;

    for (const key of TTX.tz.daysBetween(gridFrom, gridTo)) {
      const dow = weekdayOf(key);
      const inMonth = monthOf(key) === monthOf(ui.cursor);
      const cell = el('div', 'm-cell'
        + (inMonth ? '' : ' outside')
        + (key === today ? ' today' : '')
        + (dow === 0 ? ' sun' : dow === 6 ? ' sat' : ''));
      cell.appendChild(el('div', 'm-num', String(+key.slice(8))));

      const list = byDay[key] || [];
      if (inMonth) count += list.length;

      const evs = el('div', 'm-evs');
      // If it doesn't all fit, give up one slot so the "+N" line has a home.
      const shown = list.length > ui.cellCap ? list.slice(0, Math.max(0, ui.cellCap - 1)) : list;
      for (const o of shown) {
        const c = railColor(o);
        const chip = el('div', 'm-ev ' + (o.allDay || o.holiday ? 'chip' : 'dotted'));
        if (o.allDay || o.holiday) {
          chip.style.background = c;
        } else {
          const dot = el('span', 'm-dot');
          dot.style.background = c;
          chip.appendChild(dot);
          chip.appendChild(el('span', 'm-t', o.startTime));
        }
        chip.appendChild(el('span', 'm-ti', o.title));
        chip.title = o.title;
        chip.onclick = (e) => { e.stopPropagation(); openDetail(o, chip); };
        evs.appendChild(chip);
      }
      // TimeTree just clips here and says nothing. Say something.
      if (list.length > shown.length) {
        const more = el('button', 'm-more', `+${list.length - shown.length} 件`);
        more.onclick = () => jumpTo(key, 'agenda');
        evs.appendChild(more);
      }
      cell.appendChild(evs);
      grid.appendChild(cell);
    }
    wrap.appendChild(grid);
    ui.status = `${count} 件 / ${monthOf(ui.cursor)}`;
    return wrap;
  }

  // --- render: week (time grid) -----------------------------------------

  const HOUR_H = 44;   // px per hour

  /**
   * A real time grid — the one thing an agenda can't show: how long things run
   * and where the gaps are. All-day and multi-day events get a banner strip on
   * top instead of being crammed into the 00:00 row.
   */
  function renderWeek() {
    const from = weekStart(ui.cursor);
    const days = TTX.tz.daysBetween(from, addDays(from, 6));
    const list = TTX.store.occurrences(days[0], days[6], {
      mutedLabels: ui.mutedLabels,
      holidays: ui.holidays,
      query: ui.query,
    });
    const today = todayKey();
    const wrap = el('div', 'week');

    const head = el('div', 'w-head');
    head.appendChild(el('div', 'w-gut'));
    for (const key of days) {
      const dow = weekdayOf(key);
      const d = el('div', 'w-hd' + (key === today ? ' today' : '') + (dow === 0 ? ' sun' : dow === 6 ? ' sat' : ''));
      d.append(el('span', 'w-hw', WEEKDAY_JA[dow]), el('span', 'w-hn', String(+key.slice(8))));
      d.onclick = () => jumpTo(key, 'agenda');
      head.appendChild(d);
    }
    wrap.appendChild(head);

    const banners = list.filter((o) => o.allDay || o.holiday || o.multiDay);
    if (banners.length) {
      const strip = el('div', 'w-allday');
      strip.appendChild(el('div', 'w-gut', '終日'));
      for (const key of days) {
        const cell = el('div', 'w-ad-cell' + (key === today ? ' today' : ''));
        for (const o of banners.filter((x) => x.days.includes(key))) {
          const c = el('div', 'w-ad', o.title);
          c.style.background = railColor(o);
          c.title = o.title;
          c.onclick = () => openDetail(o, c);
          cell.appendChild(c);
        }
        strip.appendChild(cell);
      }
      wrap.appendChild(strip);
    }

    const scroll = el('div', 'w-scroll');
    const grid = el('div', 'w-grid');
    grid.style.setProperty('--hour-h', HOUR_H + 'px');

    const gut = el('div', 'w-gut-col');
    for (let h = 0; h < 24; h++) {
      const l = el('div', 'w-hour');
      if (h) l.textContent = String(h).padStart(2, '0') + ':00';
      gut.appendChild(l);
    }
    grid.appendChild(gut);

    for (const key of days) {
      const col = el('div', 'w-col' + (key === today ? ' today' : ''));
      for (let h = 0; h < 24; h++) col.appendChild(el('div', 'w-slot'));

      const timed = list.filter((o) => !o.allDay && !o.holiday && !o.multiDay && o.startKey === key);
      for (const o of layoutColumns(timed)) {
        const startMin = +o.startTime.slice(0, 2) * 60 + +o.startTime.slice(3);
        const endMin = Math.max(startMin + 20, +o.endTime.slice(0, 2) * 60 + +o.endTime.slice(3));
        const box = el('div', 'w-ev');
        box.style.top = (startMin / 60) * HOUR_H + 'px';
        box.style.height = ((endMin - startMin) / 60) * HOUR_H - 2 + 'px';
        box.style.left = `calc(${(o._col / o._cols) * 100}% + 1px)`;
        box.style.width = `calc(${(1 / o._cols) * 100}% - 3px)`;
        box.style.background = railColor(o);
        box.append(el('div', 'w-ev-t', o.startTime), el('div', 'w-ev-n', o.title));
        box.title = `${o.startTime}〜${o.endTime} ${o.title}`;
        box.onclick = () => openDetail(o, box);
        col.appendChild(box);
      }
      grid.appendChild(col);
    }
    scroll.appendChild(grid);
    wrap.appendChild(scroll);

    ui.status = `${list.length} 件 / ${days[0]} 〜 ${days[6]}`;
    // Open on the working day rather than at midnight.
    requestAnimationFrame(() => { scroll.scrollTop = 7 * HOUR_H; });
    return wrap;
  }

  /** Place overlapping events side by side instead of stacking them. */
  function layoutColumns(evs) {
    const sorted = evs.slice().sort((a, b) => a.start - b.start || b.end - a.end);
    const active = [];
    for (const o of sorted) {
      for (let i = active.length - 1; i >= 0; i--) if (active[i].end <= o.start) active.splice(i, 1);
      const used = new Set(active.map((x) => x._col));
      let c = 0;
      while (used.has(c)) c++;
      o._col = c;
      active.push(o);
      const cols = Math.max(...active.map((x) => x._col)) + 1;
      for (const x of active) x._cols = Math.max(x._cols || 1, cols);
    }
    for (const o of sorted) o._cols = o._cols || 1;
    return sorted;
  }

  /**
   * How many chips fit in a month cell? Measure it — an assumed row height was
   * wrong by ~4px, which let cells overflow and clip silently. That's exactly
   * the TimeTree behaviour this view exists to fix, so it has to be measured
   * from the real laid-out chip, and re-measured whenever the window resizes.
   */
  function measureCells() {
    const evs = $('.m-evs');
    const chip = $('.m-ev');
    if (!evs || !chip) return;
    const rowH = chip.getBoundingClientRect().height + 1; // + flex gap
    if (rowH < 4) return;
    const cap = Math.max(1, Math.floor((evs.clientHeight + 1) / rowH));
    if (cap !== ui.cellCap) {
      ui.cellCap = cap;
      render();
    }
  }

  // --- export -----------------------------------------------------------

  function doExport(kind) {
    const { from, to } = range();
    const list = occs();
    const byDay = TTX.model.groupByDay(list, from, to);
    const names = TTX.store.state.calendars
      .filter((c) => TTX.store.state.enabled.has(c.id)).map((c) => c.name).join('・');
    const title = `${names} ${from}〜${to}`;
    const stem = `timetree_${from}_${to}`;

    if (kind === 'md') {
      const md = TTX.exporters.toMarkdown(byDay, { title });
      navigator.clipboard.writeText(md).then(
        () => toast('Markdown をコピーしました'),
        () => download(stem + '.md', md, 'text/markdown')
      );
    } else if (kind === 'csv') {
      download(stem + '.csv', TTX.exporters.toCSV(list), 'text/csv');
      toast('CSV を保存しました');
    } else if (kind === 'json') {
      download(stem + '.json', TTX.exporters.toJSON(byDay), 'application/json');
      toast('JSON を保存しました');
    } else if (kind === 'ics') {
      download(stem + '.ics', TTX.exporters.toICS(list, { title }), 'text/calendar');
      toast('ICS を保存しました');
    }
  }

  // --- event detail -----------------------------------------------------

  /**
   * Anchored popover rather than a modal: opening an event shouldn't cover the
   * agenda you're reading it against. It grows from the row you clicked so the
   * connection between "this row" and "this card" is spatial, not inferred.
   */
  function openDetail(o, anchor) {
    closeDetail();
    const scrim = el('div', 'd-scrim');
    const card = el('div', 'd-card');

    const accent = railColor(o);
    card.style.setProperty('--d-accent', accent);

    const head = el('div', 'd-head');
    head.appendChild(el('div', 'd-title', o.title));
    card.appendChild(head);

    const rows = [];
    const jp = (k) => `${+k.slice(5, 7)}月${+k.slice(8)}日(${WEEKDAY_JA[weekdayOf(k)]})`;
    let when;
    if (o.holiday) {
      when = `${jp(o.startKey)} ・ ${o.workday ? '暦・行事' : '祝日'}`;
    } else if (o.multiDay) {
      when = o.allDay
        ? `${jp(o.startKey)} 〜 ${jp(o.endKey)} ・ 終日 (${o.days.length}日間)`
        : `${jp(o.startKey)} ${o.startTime} 〜 ${jp(o.endKey)} ${o.endTime}`;
    } else {
      when = o.allDay
        ? `${jp(o.startKey)} ・ 終日`
        : `${jp(o.startKey)} ${o.startTime} 〜 ${o.endTime}`;
    }
    rows.push(['🕐', '日時', when]);

    if (o.location) rows.push(['📍', '場所', o.location]);
    const lb = TTX.store.labelOf(o.calendarId, o.labelId);
    if (lb?.name) rows.push(['🏷', 'ラベル', lb.name]);
    if (o.calendarName) rows.push(['📅', 'カレンダー', o.calendarName]);

    const members = TTX.store.state.members.get(o.calendarId);
    if (members && o.attendees?.length) {
      const names = o.attendees.map((id) => members.get(id)?.name).filter(Boolean);
      if (names.length) rows.push(['👥', 'メンバー', names.join('、')]);
    }
    if (o.recurring) rows.push(['🔁', '繰り返し', '繰り返しの予定']);
    if (o.isException) rows.push(['✎', '例外', 'この回だけ変更されています']);
    if (o.birthday) rows.push(['🎂', '種別', '誕生日']);

    for (const [ic, k, v] of rows) {
      const r = el('div', 'd-row');
      r.append(el('span', 'd-ic', ic), el('span', 'd-k', k), el('span', 'd-v', v));
      card.appendChild(r);
    }
    if (o.note) {
      const n = el('div', 'd-note', o.note);
      card.appendChild(n);
    }

    scrim.appendChild(card);
    document.body.appendChild(scrim);

    // Position beside the row, clamped into the window.
    const a = anchor.getBoundingClientRect();
    const w = 320;
    card.style.width = w + 'px';
    const left = Math.min(Math.max(8, a.left), innerWidth - w - 8);
    card.style.left = left + 'px';
    const h = card.offsetHeight;
    const below = a.bottom + 6;
    card.style.top = (below + h > innerHeight - 8 ? Math.max(8, a.top - h - 6) : below) + 'px';
    card.style.transformOrigin = `${Math.min(Math.max(0, a.left - left + 20), w)}px ${below + h > innerHeight - 8 ? h : 0}px`;

    requestAnimationFrame(() => card.classList.add('in'));
    scrim.onclick = (e) => { if (e.target === scrim) closeDetail(); };
    ui.detail = scrim;
  }

  function closeDetail() {
    ui.detail?.remove();
    ui.detail = null;
  }

  // --- command palette --------------------------------------------------

  /** "7/20", "2026-07-20", "7月20日", "20260720" -> a date key. */
  function parseDateQuery(q) {
    const s = q.trim();
    let m;
    const today = todayKey();
    const yr = +today.slice(0, 4);
    if ((m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/))) return keyOf(+m[1], +m[2], +m[3]);
    if ((m = s.match(/^(\d{4})\/(\d{1,2})\/(\d{1,2})$/))) return keyOf(+m[1], +m[2], +m[3]);
    if ((m = s.match(/^(\d{1,2})[/-](\d{1,2})$/))) return keyOf(yr, +m[1], +m[2]);
    if ((m = s.match(/^(\d{1,2})月(\d{1,2})日?$/))) return keyOf(yr, +m[1], +m[2]);
    if ((m = s.match(/^(\d{4})(\d{2})(\d{2})$/))) return keyOf(+m[1], +m[2], +m[3]);
    if ((m = s.match(/^(\d{4})年(\d{1,2})月$/))) return keyOf(+m[1], +m[2], 1);
    if (/^(今日|きょう|today)$/i.test(s)) return today;
    if (/^(明日|あした|tomorrow)$/i.test(s)) return addDays(today, 1);
    if (/^(昨日|きのう|yesterday)$/i.test(s)) return addDays(today, -1);
    return null;
  }
  const keyOf = (y, m, d) => {
    if (m < 1 || m > 12 || d < 1 || d > 31) return null;
    return ymd(Date.UTC(y, m - 1, d), 'UTC');
  };

  function paletteItems(q) {
    const out = [];
    const dateKey = parseDateQuery(q);
    if (dateKey) {
      out.push({
        sec: '移動',
        icon: '→',
        main: `${dateKey} へ移動`,
        sub: WEEKDAY_JA[weekdayOf(dateKey)] + '曜日',
        run: () => jumpTo(dateKey),
      });
    }

    if (q.trim()) {
      for (const o of TTX.store.searchAll(q, 40)) {
        out.push({
          sec: '予定',
          rail: railColor(o),
          main: o.title,
          when: `${o.startKey.replace(/-/g, '/')} ${o.allDay ? '終日' : o.startTime}`,
          sub: o.location || '',
          run: () => jumpTo(o.startKey, 'agenda'),
        });
      }
    }

    const cmds = [
      { icon: '⌂', main: '今日へ', run: () => jumpTo(todayKey()) },
      { icon: '☰', main: 'アジェンダ表示', run: () => setView('agenda') },
      { icon: '▤', main: '週表示', run: () => setView('week') },
      { icon: '▦', main: '月表示', run: () => setView('month') },
      { icon: '☾', main: 'テーマ: ダーク', run: () => applyTheme('dark') },
      { icon: '☀', main: 'テーマ: ライト', run: () => applyTheme('light') },
      { icon: '◐', main: 'テーマ: システムに従う', run: () => applyTheme('system') },
      { icon: '⟳', main: '再同期', run: () => resync() },
      { icon: '↧', main: 'Markdown をコピー', run: () => doExport('md') },
      { icon: '↧', main: 'CSV を書き出し', run: () => doExport('csv') },
      { icon: '↧', main: 'ICS を書き出し', run: () => doExport('ics') },
      { icon: '↧', main: 'JSON を書き出し', run: () => doExport('json') },
      { icon: '＋', main: 'アカウントを追加', run: () => addAccount() },
      ...ui.accounts.filter((a) => a.id !== ui.activeId).map((a) => ({
        icon: '⇄', main: `アカウント切替: ${a.name}`, run: () => switchAccount(a.id),
      })),
    ].filter((c) => !q.trim() || c.main.toLowerCase().includes(q.trim().toLowerCase()));

    for (const c of cmds) out.push({ sec: 'コマンド', ...c });
    return out;
  }

  function openPalette() {
    if (ui.palette) return;
    const scrim = el('div', 'scrim');
    const box = el('div', 'palette');
    const input = el('input');
    input.placeholder = '予定を検索、日付へ移動 (例: 7/20)、コマンド…';
    input.spellcheck = false;
    const list = el('div', 'p-list');
    box.append(input, list);
    scrim.appendChild(box);
    document.body.appendChild(scrim);
    ui.palette = { scrim, input, sel: 0, items: [] };

    const paint = () => {
      const items = paletteItems(input.value);
      ui.palette.items = items;
      ui.palette.sel = Math.min(ui.palette.sel, Math.max(0, items.length - 1));
      list.textContent = '';
      if (!items.length) {
        list.appendChild(el('div', 'p-empty', '該当なし'));
        return;
      }
      let sec = '';
      items.forEach((it, i) => {
        if (it.sec !== sec) {
          sec = it.sec;
          list.appendChild(el('div', 'p-sec', sec));
        }
        const b = el('button', 'p-item' + (i === ui.palette.sel ? ' sel' : ''));
        if (it.rail) {
          const r = el('span', 'p-rail');
          r.style.background = it.rail;
          b.appendChild(r);
        } else {
          b.appendChild(el('span', 'p-ic', it.icon || '·'));
        }
        b.appendChild(el('span', 'p-main', it.main));
        if (it.sub) b.appendChild(el('span', 'p-sub', it.sub));
        if (it.when) b.appendChild(el('span', 'p-when', it.when));
        b.onclick = () => { closePalette(); it.run(); };
        b.onmouseenter = () => { ui.palette.sel = i; paint(); };
        list.appendChild(b);
      });
      const selEl = list.querySelector('.p-item.sel');
      if (selEl) selEl.scrollIntoView({ block: 'nearest' });
    };

    input.oninput = () => { ui.palette.sel = 0; paint(); };
    input.onkeydown = (e) => {
      const n = ui.palette.items.length;
      if (e.key === 'ArrowDown') { e.preventDefault(); ui.palette.sel = (ui.palette.sel + 1) % n; paint(); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); ui.palette.sel = (ui.palette.sel - 1 + n) % n; paint(); }
      else if (e.key === 'Enter') {
        e.preventDefault();
        const it = ui.palette.items[ui.palette.sel];
        if (it) { closePalette(); it.run(); }
      } else if (e.key === 'Escape') { e.preventDefault(); closePalette(); }
    };
    scrim.onclick = (e) => { if (e.target === scrim) closePalette(); };

    paint();
    input.focus();
  }

  function closePalette() {
    ui.palette?.scrim.remove();
    ui.palette = null;
  }

  // --- shell ------------------------------------------------------------

  const reducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

  /**
   * Clear the direction flag once the transition settles — either way.
   * Starting a transition while one is running aborts the old one, and its
   * `finished` promise REJECTS with AbortError. `.finally()` re-throws that,
   * so it surfaced as an unhandled rejection every time you clicked twice
   * quickly. Settle on both paths and interrupting becomes a non-event, which
   * is what fast repeated ←/→ presses need anyway.
   */
  function endNav(t) {
    const done = () => { delete document.documentElement.dataset.nav; };
    t.finished.then(done, done);
  }

  function paint() {
    closeDetail(); // its anchor is about to be destroyed
    closeMenus();
    const app = $('#app');
    const scrollTop = $('.agenda')?.scrollTop;
    app.textContent = '';
    app.appendChild(renderToolbar());

    const body = el('div', 'body');
    const main = el('div', 'main');
    main.appendChild(ui.view === 'month' ? renderMonth() : ui.view === 'week' ? renderWeek() : renderAgenda());
    body.append(renderSidebar(), main);
    app.appendChild(body);

    // status is computed during the view render, so backfill the sidebar label
    const st = $('.side-status');
    if (st) st.textContent = ui.status;

    if (ui.view === 'agenda' && scrollTop != null && !ui.keepScroll) $('.agenda').scrollTop = scrollTop;
    if (ui.view === 'month') requestAnimationFrame(measureCells);
  }

  /**
   * Motion carries meaning here, so it's directional: moving to next month
   * pushes the old view left and brings the new one in from the right, which
   * makes ←/→ feel like travel along a timeline rather than a redraw.
   * View Transitions give us a real crossfade of two DOM states without
   * hand-rolling a double-render; `dir` just picks which keyframes run.
   */
  function render(dir = 'fade') {
    if (!document.startViewTransition || reducedMotion()) return paint();
    document.documentElement.dataset.nav = dir;
    endNav(document.startViewTransition(() => paint()));
  }

  async function refresh(dir) {
    await ensureHolidays();
    render(dir);
    if (ui.view === 'agenda') scrollToCursor();
  }

  /** Put the cursor's month at the top of the agenda instead of guessing. */
  function scrollToCursor() {
    const wrap = $('.agenda');
    if (!wrap) return;
    const want = `${ui.cursor.slice(0, 4)}年 ${Number(ui.cursor.slice(5, 7))}月`;
    const target = [...wrap.querySelectorAll('.ag-month')].find((h) => h.textContent === want);
    if (target) wrap.scrollTop = target.offsetTop;
  }

  async function resync() {
    ui.status = '同期中…';
    render();
    TTX.store.state.events.clear();
    try {
      await TTX.store.syncAll((cal, n) => {
        ui.status = `${cal.name}: ${n} 件…`;
        const s = $('.side-status');
        if (s) s.textContent = ui.status;
      });
      await refresh();
      toast(`同期完了 — ${TTX.store.totalEvents()} 件`);
    } catch (e) {
      toast('同期エラー: ' + e.message);
    }
  }

  function centerCard(build) {
    const app = $('#app');
    app.textContent = '';
    const c = el('div', 'center');
    const stack = el('div', 'stack');
    build(stack);
    c.appendChild(stack);
    app.appendChild(c);
  }

  function keys(e) {
    if (e.key === 'Escape' && ui.menu) { e.preventDefault(); return closeMenus(); }
    if (e.key === 'Escape' && ui.detail) { e.preventDefault(); return closeDetail(); }
    if (ui.palette) return;
    const typing = /^(INPUT|TEXTAREA)$/.test(e.target.tagName);
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); return openPalette(); }
    if (typing) return;
    if (e.key === '/') { e.preventDefault(); return openPalette(); }
    if (e.key === 'ArrowLeft') { e.preventDefault(); return go(-1); }
    if (e.key === 'ArrowRight') { e.preventDefault(); return go(1); }
    if (e.key.toLowerCase() === 't') return jumpTo(todayKey());
    if (e.key === '1') return setView('agenda');
    if (e.key === '2') return setView('week');
    if (e.key === '3') return setView('month');
  }

  // --- boot -------------------------------------------------------------

  function signInCard() {
    centerCard((s) => {
      s.appendChild(el('h2', null, 'TimeTree にログイン'));
      s.appendChild(el('p', null,
        'TimeTree の公式ログイン画面が開きます。パスワードはこのアプリを経由しません。'));
      const b = el('button', 'cta', 'ログイン');
      b.onclick = () => addAccount();
      s.appendChild(b);
    });
  }

  /**
   * Load whatever account is active — the single path used by first boot,
   * account switching, and adding an account. Everything account-scoped is
   * wiped first: leaving one calendar id behind would render the previous
   * account's data under the new account's name.
   */
  async function loadActiveAccount() {
    closeMenus();
    closeDetail();
    TTX.store.reset();

    if (!ui.activeId) return signInCard();

    centerCard((s) => {
      s.appendChild(el('div', 'spinner'));
      s.appendChild(el('p', null, '接続中…'));
    });

    if (!(await window.host.auth.check())) return signInCard();

    let progress;
    centerCard((s) => {
      s.appendChild(el('div', 'spinner'));
      const p = el('p', null, '同期中…');
      s.appendChild(p);
      progress = (msg) => { p.textContent = msg; };
    });

    try {
      await TTX.store.syncAll((cal, n) => progress?.(`${cal.name}: ${n} 件…`));
    } catch (e) {
      centerCard((s) => {
        s.appendChild(el('h2', null, '同期に失敗しました'));
        s.appendChild(el('p', null, e.message));
        const b = el('button', 'cta', '再試行');
        b.onclick = () => loadActiveAccount();
        s.appendChild(b);
      });
      return;
    }

    // Calendar visibility is per-account; ids from another account mean nothing.
    const prefs = loadPrefs();
    const mine = new Set(TTX.store.state.calendars.map((c) => c.id));
    for (const id of prefs.disabled || []) if (mine.has(id)) TTX.store.state.enabled.delete(id);
    if (!TTX.store.state.enabled.size && TTX.store.state.calendars[0]) {
      TTX.store.state.enabled.add(TTX.store.state.calendars[0].id);
    }
    await refresh();
  }

  const bootUI = () => (ui.activeId ? loadActiveAccount() : signInCard());

  async function main() {
    // file:// renderer can't reach timetreeapp.com — the host does it for us.
    TTX.api.setTransport((path) => window.host.api.get(path));

    loadPrefs();
    ui.cursor = todayKey();
    await applyTheme(ui.theme, false); // no dissolve on first paint
    window.host.theme.onChanged(async () => {
      if (ui.theme === 'system') await applyTheme('system');
    });
    window.host.accounts.onChanged((r) => {
      ui.accounts = r.accounts;
      ui.activeId = r.activeId;
    });
    document.addEventListener('keydown', keys);
    window.addEventListener('resize', () => { if (ui.view === 'month') measureCells(); });

    await refreshAccounts();
    await bootUI();
  }

  main().catch((e) => {
    console.error(e);
    document.getElementById('app').textContent = 'ERROR: ' + e.message;
  });
})();
