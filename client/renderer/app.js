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
  const { DAY, ymd, hm, addDays, parseYmd, WEEKDAY_JA, weekdayOf, tzOffset } = TTX.tz;
  const TZ = 'Asia/Tokyo';
  const $ = (sel, root = document) => root.querySelector(sel);

  /** Name the modifier the keyboard in front of the user actually has. */
  const MOD = /mac/i.test(navigator.userAgentData?.platform || navigator.platform || '')
    ? '⌘' : 'Ctrl';

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
    form: null,
    formClose: null,
    confirm: false,
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

    const add = el('button', 'new-btn');
    add.append(el('span', null, '＋'), el('span', null, '予定'));
    add.title = '新しい予定 (N)';
    add.onclick = () => openForm();
    t.appendChild(add);

    const seg = el('div', 'seg');
    for (const [key, label] of [['agenda', 'アジェンダ'], ['week', '週'], ['month', '月']]) {
      const b = el('button', ui.view === key ? 'on' : '', label);
      b.onclick = () => setView(key);
      seg.appendChild(b);
    }
    t.appendChild(seg);

    const search = el('button', 'search-hint');
    search.append(el('span', null, '⌕'), el('span', null, ui.query || '検索・移動'));
    search.appendChild(el('kbd', null, MOD + ' K'));
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
        // An empty day is the most natural place to start one. The dash is the
        // reading state; hovering turns the same spot into the writing one.
        const add = el('button', 'ag-add');
        add.append(el('span', 'ag-dash', '—'), el('span', 'ag-plus', '＋ 予定を追加'));
        add.onclick = () => openForm({ dateKey: key });
        evs.appendChild(add);
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
        more.onclick = (e) => { e.stopPropagation(); jumpTo(key, 'agenda'); };
        evs.appendChild(more);
      }
      cell.appendChild(evs);
      // Anywhere the chips aren't is free space on that day — clicking it means
      // "put something here".
      cell.onclick = () => openForm({ dateKey: key });
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
          c.onclick = (e) => { e.stopPropagation(); openDetail(o, c); };
          cell.appendChild(c);
        }
        cell.onclick = () => openForm({ dateKey: key, allDay: true });
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
        box.onclick = (e) => { e.stopPropagation(); openDetail(o, box); };
        col.appendChild(box);
      }
      // Click an empty slot to create at that hour — the one gesture a time
      // grid earns that an agenda can't. Snapped to 30 minutes, because
      // pixel-accurate minutes are a lie at 44px/hour.
      col.onclick = (e) => {
        const y = e.clientY - col.getBoundingClientRect().top;
        const mins = Math.min(23 * 60 + 30, Math.max(0, Math.round(y / HOUR_H * 2) * 30));
        openForm({
          dateKey: key,
          time: String(Math.floor(mins / 60)).padStart(2, '0') + ':' + (mins % 60 ? '30' : '00'),
        });
      };
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
    if (o.url) rows.push(['🔗', 'URL', o.url]);
    const lb = TTX.store.labelOf(o.calendarId, o.labelId);
    if (lb?.name) rows.push(['🏷', 'ラベル', lb.name]);
    if (o.calendarName) rows.push(['📅', 'カレンダー', o.calendarName]);

    const members = TTX.store.state.members.get(o.calendarId);
    if (members && o.attendees?.length) {
      const names = o.attendees.map((id) => members.get(id)?.name).filter(Boolean);
      if (names.length) rows.push(['👥', 'メンバー', names.join('、')]);
    }
    const alerts = TTX.store.rawEvent(o.calendarId, o.uuid)?.alerts;
    if (alerts?.length) {
      rows.push(['🔔', '通知', alerts.slice().sort((a, b) => a - b)
        .map((m) => TTX.api.alertLabel(m, o.allDay)).join('、')]);
    }
    if (o.recurring) rows.push(['🔁', '繰り返し', repeatText(o)]);
    if (o.isException) rows.push(['✎', '例外', 'この回だけ変更されています']);
    if (o.birthday) rows.push(['🎂', '種別', '誕生日']);

    for (const [ic, k, v] of rows) {
      const r = el('div', 'd-row');
      r.append(el('span', 'd-ic', ic), el('span', 'd-k', k), el('span', 'd-v', v));
      card.appendChild(r);
    }
    if (o.checklist?.length) {
      const done = o.checklist.filter((i) => i.checked).length;
      card.appendChild(el('div', 'd-k', `リスト ${done}/${o.checklist.length}`));
      const list = el('div', 'd-cl');
      for (const i of o.checklist) {
        const r = el('div', 'd-cl-i' + (i.checked ? ' on' : ''));
        r.append(el('span', 'd-cl-b', i.checked ? '☑' : '☐'), el('span', null, i.title));
        list.appendChild(r);
      }
      card.appendChild(list);
    }
    if (o.note) {
      const n = el('div', 'd-note', o.note);
      card.appendChild(n);
    }

    if (canEdit(o)) {
      const acts = el('div', 'd-acts');
      const edit = el('button', 'btn', '編集');
      edit.onclick = () => { closeDetail(); editEvent(o); };
      const del = el('button', 'btn danger', '削除');
      del.onclick = () => { closeDetail(); removeEvent(o); };
      acts.append(edit, del);
      card.appendChild(acts);
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
    const flip = below + h > innerHeight - 8;
    // Preferred spot: under the row, or above it when it won't fit. Then clamp
    // to BOTH edges. Clamping only the top used to let a tall card hang off the
    // bottom, which put 編集/削除 somewhere you couldn't click.
    const top = Math.min(
      Math.max(8, flip ? a.top - h - 6 : below),
      Math.max(8, innerHeight - h - 8)
    );
    card.style.top = top + 'px';
    // Grow from wherever the row actually is relative to the card we landed on.
    card.style.transformOrigin =
      `${Math.min(Math.max(0, a.left - left + 20), w)}px ` +
      `${Math.min(Math.max(0, a.top - top), h)}px`;

    requestAnimationFrame(() => card.classList.add('in'));
    scrim.onclick = (e) => { if (e.target === scrim) closeDetail(); };
    ui.detail = scrim;
  }

  function closeDetail() {
    ui.detail?.remove();
    ui.detail = null;
  }

  // --- confirm ----------------------------------------------------------

  /**
   * Deleting is the one irreversible thing this app does, so it asks. Captures
   * keys so the grid's shortcuts behind it stay inert while it's up.
   */
  function confirmDialog({ title, body, ok = 'OK', danger = false }) {
    return new Promise((resolve) => {
      const scrim = el('div', 'scrim cf-scrim');
      const card = el('div', 'confirm');
      card.append(el('div', 'cf-t', title), el('div', 'cf-b', body));

      const foot = el('div', 'cf-f');
      const cancel = el('button', 'btn', 'キャンセル');
      const go = el('button', 'btn ' + (danger ? 'danger' : 'primary'), ok);
      foot.append(cancel, go);
      card.appendChild(foot);
      scrim.appendChild(card);
      document.body.appendChild(scrim);
      ui.confirm = true;

      const done = (v) => {
        document.removeEventListener('keydown', onKey, true);
        scrim.remove();
        ui.confirm = false;
        resolve(v);
      };
      const onKey = (e) => {
        if (e.key !== 'Escape' && e.key !== 'Enter') return;
        e.preventDefault();
        e.stopPropagation();
        done(e.key === 'Enter');
      };
      document.addEventListener('keydown', onKey, true);
      cancel.onclick = () => done(false);
      go.onclick = () => done(true);
      scrim.onclick = (e) => { if (e.target === scrim) done(false); };
      requestAnimationFrame(() => go.focus());
    });
  }

  /**
   * "This one" and "all of them" are different acts on a series, so the scope
   * is asked before the form rather than after — by the time you're typing, the
   * form should already be showing the thing you chose to change. TimeTree asks
   * first for the same reason.
   */
  function chooseScope(kind) {
    const verb = kind === 'delete' ? '削除' : '編集';
    return new Promise((resolve) => {
      const scrim = el('div', 'scrim cf-scrim');
      const card = el('div', 'confirm');
      card.append(
        el('div', 'cf-t', `繰り返しの予定を${verb}`),
        el('div', 'cf-b', `どの範囲に適用しますか。`)
      );

      const opts = el('div', 'cf-opts');
      for (const [key, label, sub] of [
        ['this', `この予定だけを${verb}`, 'ほかの回はそのまま'],
        ['future', `これ以降の予定を${verb}`, 'この回より前はそのまま'],
        ['all', `すべての予定を${verb}`, '過去の回も含めて'],
      ]) {
        const b = el('button', 'cf-opt' + (kind === 'delete' && key === 'all' ? ' danger' : ''));
        b.append(el('span', 'cf-opt-t', label), el('span', 'cf-opt-s', sub));
        b.onclick = () => done(key);
        opts.appendChild(b);
      }
      card.appendChild(opts);

      const foot = el('div', 'cf-f');
      const cancel = el('button', 'btn', 'キャンセル');
      cancel.onclick = () => done(null);
      foot.appendChild(cancel);
      card.appendChild(foot);

      scrim.appendChild(card);
      document.body.appendChild(scrim);
      ui.confirm = true;

      const done = (v) => {
        document.removeEventListener('keydown', onKey, true);
        scrim.remove();
        ui.confirm = false;
        resolve(v);
      };
      const onKey = (e) => {
        if (e.key !== 'Escape') return;
        e.preventDefault();
        e.stopPropagation();
        done(null);
      };
      document.addEventListener('keydown', onKey, true);
      scrim.onclick = (e) => { if (e.target === scrim) done(null); };
      requestAnimationFrame(() => opts.firstChild.focus());
    });
  }

  // --- event form -------------------------------------------------------

  const FREQ_LABEL = [
    ['', '繰り返さない'],
    ['DAILY', '毎日'],
    ['WEEKLY', '毎週'],
    ['MONTHLY', '毎月'],
    ['YEARLY', '毎年'],
  ];
  const BYDAY = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];

  /**
   * Pull apart an RRULE into the parts this form edits, and keep everything
   * else verbatim. INTERVAL and COUNT are not editable here but absolutely must
   * survive a title change — rebuilding the rule from a simplified model would
   * quietly turn "every 2 weeks, 10 times" into "every week, forever".
   */
  function parseRepeat(rule) {
    const parts = {};
    if (rule) {
      for (const p of rule.slice('RRULE:'.length).split(';')) {
        const i = p.indexOf('=');
        if (i > 0) parts[p.slice(0, i).toUpperCase()] = p.slice(i + 1);
      }
    }
    const until = parts.UNTIL ? TTX.recur.parseICalDate(parts.UNTIL) : null;
    const { FREQ, BYDAY: BD, UNTIL, ...rest } = parts;
    return {
      freq: FREQ || '',
      byday: BD ? BD.split(',') : [],
      until: until ? ymd(until.ms, 'UTC') : '',
      rest,
    };
  }

  function buildRepeat(r) {
    if (!r.freq) return null;
    let s = 'RRULE:FREQ=' + r.freq;
    if (r.rest.INTERVAL) s += ';INTERVAL=' + r.rest.INTERVAL;
    if (r.freq === 'WEEKLY' && r.byday.length) s += ';BYDAY=' + r.byday.join(',');
    // COUNT and UNTIL are mutually exclusive in RFC 5545; an explicit end date
    // is the more specific intent, so it wins.
    if (r.until) s += ';UNTIL=' + r.until.replace(/-/g, '');
    else if (r.rest.COUNT) s += ';COUNT=' + r.rest.COUNT;
    return s;
  }

  const sameRepeat = (a, b) =>
    a.freq === b.freq && a.until === b.until && a.byday.join() === b.byday.join();

  const FREQ_EVERY = { DAILY: '毎日', WEEKLY: '毎週', MONTHLY: '毎月', YEARLY: '毎年' };
  const FREQ_UNIT = { DAILY: '日', WEEKLY: '週間', MONTHLY: 'か月', YEARLY: '年' };

  /**
   * Say what the rule actually is — 「毎週 月曜日」 — instead of "this repeats".
   * The reader already had to parse the rule to place the event; refusing to
   * tell you what it found is just withholding.
   */
  function repeatText(o) {
    const rule = TTX.api.ruleOf(TTX.store.rawEvent(o.calendarId, o.uuid) || {});
    const r = parseRepeat(rule);
    if (!r.freq) return '繰り返しの予定';
    const n = +r.rest.INTERVAL || 1;
    let s = n > 1 ? `${n}${FREQ_UNIT[r.freq] || ''}ごと` : (FREQ_EVERY[r.freq] || '繰り返し');
    if (r.freq === 'WEEKLY' && r.byday.length) {
      s += ' ' + r.byday.map((d) => WEEKDAY_JA[BYDAY.indexOf(d)] + '曜日').join('・');
    }
    if (r.until) s += ` — ${r.until.replace(/-/g, '/')} まで`;
    else if (r.rest.COUNT) s += ` — ${r.rest.COUNT}回`;
    return s;
  }

  /** What the picker offers. All-day reminders live on their own ladder. */
  const alertChoices = (allDay) => (allDay
    ? [0, 1, 2, 3, 7].map((d) => TTX.api.alldayAlert(d))
    : [0, 5, 10, 15, 30, 60, 120, 1440]);

  /**
   * Toggling all-day changes what "before" is measured from, so a reminder's
   * stored number stops meaning what the user picked. Carry the intent over
   * instead of dropping it: the exact minute is unrecoverable either way, but
   * "roughly a day ahead" survives, and 開始時/当日 map cleanly onto each other.
   */
  function remapAlerts(list, toAllDay) {
    const out = list.map((m) => {
      if (m === 0) return 0;
      if (toAllDay) return TTX.api.alldayAlert(Math.max(1, Math.round(m / 1440)));
      const d = TTX.api.alldayAlertDays(m);
      return d === null ? m : d * 1440;
    });
    return [...new Set(out)].sort((a, b) => a - b);
  }

  /**
   * Holidays aren't events at all (they come from memorialdays and have no
   * calendar), and a birthday's title is synthesised from a member name rather
   * than stored — editing either would be editing something that isn't there.
   */
  const canEdit = (o) => !o.holiday && !o.birthday && !!o.calendarId && !!o.uuid;

  /** Next half-hour boundary — today's default. Other days open at 09:00. */
  function defaultTime(dateKey) {
    if (dateKey !== todayKey()) return '09:00';
    const now = new Date(TTX.tz.toLocal(Date.now(), TZ));
    let h = now.getUTCHours();
    const m = now.getUTCMinutes() < 30 ? 30 : 0;
    if (m === 0) h++;
    return h > 23 ? '23:00' : String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0');
  }

  /**
   * Creating from the toolbar or `n`: today if it's on screen, else the cursor.
   * Ask range() rather than comparing months — in week view "same month" is not
   * "on screen", and it would open the form on a day you can't see.
   */
  function newEventDate() {
    const t = todayKey();
    const { from, to } = range();
    return t >= from && t <= to ? t : ui.cursor;
  }

  function freshFields(opts) {
    const st = TTX.store.state;
    const calId = opts.calendarId || primaryCalendarId()
      || st.calendars.find((c) => st.enabled.has(c.id))?.id || null;
    const startKey = opts.dateKey || newEventDate();
    const allDay = !!opts.allDay;
    const startTime = opts.time || defaultTime(startKey);
    const [endKey, endTime] = TTX.tz.shiftWall(startKey, startTime, 60);
    const labels = st.labels.get(calId) || [];
    return {
      calendarId: calId,
      title: '',
      allDay,
      startKey,
      startTime,
      // An all-day event is one day by default; end_at is inclusive.
      endKey: allDay ? startKey : endKey,
      endTime,
      location: '',
      note: '',
      labelId: labels[0]?.id ?? 1,
      repeat: { freq: '', byday: [], until: '', rest: {} },
      url: '',
      checklist: [],
      alerts: [],
      // TimeTree's own form assigns the event to you by default, and the
      // user's phone renders that avatar. Match it rather than quietly
      // producing events that look different from the ones they make there.
      attendees: st.me?.id ? [st.me.id] : [],
    };
  }

  /**
   * Read the raw event, not the occurrence: the view drops fields the form
   * needs and rewrites others (an event ending at 00:00 is displayed on the
   * previous day, which would silently move it if we round-tripped that).
   *
   * `occ` overrides the when. Editing one occurrence of a series, or splitting
   * at it, is about the date the user clicked — but editing the whole series
   * means editing the master, so there the master's own date is the truth. Show
   * the occurrence's date for an "all" edit and an untouched save would move
   * the entire series onto it.
   */
  function fieldsFromRaw(raw, occ) {
    const tz = raw.all_day ? 'UTC' : (raw.start_timezone || TZ);
    const startAt = occ ? occ.start : raw.start_at;
    const endAt = occ ? occ.end : raw.end_at;
    const startKey = ymd(startAt, tz);
    const endKey = ymd(endAt, tz);
    return {
      calendarId: raw.calendar_id,
      title: raw.title || '',
      allDay: !!raw.all_day,
      startKey,
      endKey,
      // Latent values, so toggling all-day off has somewhere sensible to land.
      startTime: raw.all_day ? defaultTime(startKey) : hm(startAt, tz),
      endTime: raw.all_day ? '10:00' : hm(endAt, tz),
      location: raw.location || '',
      note: raw.note || '',
      labelId: raw.label_id ?? 1,
      repeat: parseRepeat(TTX.api.ruleOf(raw)),
      url: raw.url || raw.attachment?.url || '',
      checklist: (raw.attachment?.checklist || []).map((i) => ({ ...i })),
      alerts: [...(raw.alerts || [])].sort((a, b) => a - b),
      attendees: [...(raw.attendees || [])],
    };
  }

  const startEpoch = (f) => TTX.tz.toEpoch(f.startKey, f.startTime, f.allDay, TZ);
  const endEpoch = (f) => TTX.tz.toEpoch(f.endKey, f.endTime, f.allDay, TZ);

  /**
   * PUT is a merge, not a replace — send only what changed. A full-object PUT
   * would round-trip fields we never modelled (lunar, row_order …) and can
   * clobber them.
   */
  function diffPatch(raw, f) {
    const p = {};
    const put = (k, v, cur = raw[k]) => { if (cur !== v) p[k] = v; };
    put('title', f.title);
    put('all_day', f.allDay, !!raw.all_day);
    put('start_at', startEpoch(f));
    put('end_at', endEpoch(f));
    put('start_timezone', f.allDay ? 'UTC' : TZ);
    put('end_timezone', f.allDay ? 'UTC' : TZ);
    put('label_id', f.labelId, raw.label_id ?? 1);
    put('note', f.note, raw.note || '');
    put('location', f.location, raw.location || '');
    // Arrays never compare equal by identity, so diff them by value or every
    // save would send them back untouched.
    const same = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);
    if (!same(f.alerts, [...(raw.alerts || [])].sort((a, b) => a - b))) p.alerts = f.alerts;
    if (!same(f.attendees, raw.attendees || [])) p.attendees = f.attendees;

    // `attachment` is a nested object, so a patch replaces the whole thing.
    // Build it FROM the original rather than from scratch — same reason the
    // event patch only carries changed fields: whatever we didn't model must
    // survive. Only send it at all if the user actually touched something.
    const next = TTX.api.buildAttachment({ url: f.url, checklist: f.checklist }, raw.attachment);
    const cur = TTX.api.buildAttachment(
      { url: raw.url || raw.attachment?.url || '', checklist: raw.attachment?.checklist || [] },
      raw.attachment
    );
    if (JSON.stringify(next) !== JSON.stringify(cur)) p.attachment = next;
    // Only touch the rule if the user touched the control — and keep the
    // master's EXDATEs when we do, or every occurrence deleted with
    // "この予定だけを削除" would come back to life on the next title edit.
    if (!sameRepeat(f.repeat, parseRepeat(TTX.api.ruleOf(raw)))) {
      const rule = buildRepeat(f.repeat);
      p.recurrences = rule ? TTX.api.withRule(raw, rule) : [];
    }
    return p;
  }

  function closeForm() {
    ui.form?.remove();
    ui.form = null;
    ui.formClose = null;
  }

  /**
   * Create/edit sheet. Unlike the detail popover this IS a modal: the popover
   * is anchored because you read it *against* the grid behind it, but writing
   * is a committed act on one thing, and the grid is what's about to change
   * rather than reference material.
   */
  function openForm(opts = {}) {
    if (ui.form) return;
    closeDetail();
    closeMenus();

    const st = TTX.store.state;
    const editing = !!opts.occ;
    const raw = editing ? TTX.store.rawEvent(opts.occ.calendarId, opts.occ.uuid) : null;
    if (editing && !raw) return toast('元の予定が見つかりません。再同期してください');
    if (!editing && !st.calendars.some((c) => st.enabled.has(c.id))) {
      return toast('書き込めるカレンダーがありません');
    }

    // A master carries the RRULE; its exception children are plain events.
    const series = editing && TTX.api.isMaster(raw);
    const scope = series ? (opts.scope || 'all') : 'all';
    const f = editing ? fieldsFromRaw(raw, scope === 'all' ? null : opts.occ) : freshFields(opts);
    // One occurrence broken out of a series is a standalone event; letting it
    // carry a rule of its own would nest a series inside a series.
    const canRepeat = !(series && scope === 'this');

    const scrim = el('div', 'scrim f-scrim');
    const card = el('div', 'form');
    ui.form = scrim;

    // --- head
    const head = el('div', 'f-head');
    head.appendChild(el('div', 'f-h-t', editing ? '予定を編集' : '新しい予定'));
    card.appendChild(head);

    const body = el('div', 'f-body');
    card.appendChild(body);

    if (series) {
      const jp = (k) => `${+k.slice(5, 7)}月${+k.slice(8)}日`;
      body.appendChild(el('div', 'f-warn', {
        this: `この回（${jp(opts.occ.startKey)}）だけを変更します。ほかの回はそのままです。`,
        future: `${jp(opts.occ.startKey)} 以降のすべての回を変更します。それより前はそのままです。`,
        all: '繰り返しのすべての回を変更します。過去の回も含まれます。',
      }[scope]));
    }

    // --- title
    const title = el('input', 'f-title');
    title.placeholder = 'タイトル';
    title.value = f.title;
    title.spellcheck = false;
    title.oninput = () => { f.title = title.value; validate(); };
    body.appendChild(title);

    // --- label swatches. TimeTree buries these in a dropdown; the colour IS
    //     the meaning here, so show them all at once.
    const labelRow = el('div', 'f-row');
    labelRow.appendChild(el('span', 'f-k', 'ラベル'));
    const swatches = el('div', 'f-labels');
    const labelName = el('span', 'f-lb-n');
    labelRow.append(swatches, labelName);
    body.appendChild(labelRow);

    function paintLabels() {
      swatches.textContent = '';
      const labels = (st.labels.get(f.calendarId) || []).filter((l) => l.id != null);
      // Only re-pick when there is something to pick from. labels() swallows a
      // failed fetch and returns [], and defaulting to 1 on that path would
      // silently relabel the event we're editing on the next save.
      if (labels.length && !labels.some((l) => l.id === f.labelId)) f.labelId = labels[0].id;
      for (const lb of labels) {
        const b = el('button', 'f-lb' + (lb.id === f.labelId ? ' on' : ''));
        b.style.background = TTX.api.colorHex(lb.color);
        b.title = lb.name || `ラベル ${lb.id}`;
        b.onclick = () => { f.labelId = lb.id; paintLabels(); };
        swatches.appendChild(b);
      }
      const cur = labels.find((l) => l.id === f.labelId);
      labelName.textContent = cur?.name || '';
    }
    paintLabels();

    // Snapshot after paintLabels(), which may normalise labelId — otherwise an
    // untouched form would already read as dirty.
    const pristine = JSON.stringify(f);
    const dirty = () => JSON.stringify(f) !== pristine;

    // --- all-day toggle
    const adRow = el('div', 'f-row');
    adRow.appendChild(el('span', 'f-k', '終日'));
    const sw = el('button', 'sw' + (f.allDay ? ' on' : ''));
    sw.appendChild(el('span', 'sw-k'));
    sw.setAttribute('aria-pressed', String(f.allDay));
    adRow.appendChild(sw);
    body.appendChild(adRow);

    // --- when
    const startRow = el('div', 'f-row');
    startRow.appendChild(el('span', 'f-k', '開始'));
    const sDate = el('input', 'f-date');
    sDate.type = 'date';
    const sTime = el('input', 'f-time');
    sTime.type = 'time';
    startRow.append(sDate, sTime);
    body.appendChild(startRow);

    const endRow = el('div', 'f-row');
    endRow.appendChild(el('span', 'f-k', '終了'));
    const eDate = el('input', 'f-date');
    eDate.type = 'date';
    const eTime = el('input', 'f-time');
    eTime.type = 'time';
    endRow.append(eDate, eTime);
    body.appendChild(endRow);

    const span = el('div', 'f-span');
    body.appendChild(span);

    // --- repeat
    let repeatSel, dayChips, untilInput;
    if (canRepeat) {
      const rRow = el('div', 'f-row');
      rRow.appendChild(el('span', 'f-k', '繰り返し'));
      repeatSel = el('select', 'f-sel');
      for (const [v, label] of FREQ_LABEL) {
        const o = el('option', null, label);
        o.value = v;
        if (v === f.repeat.freq) o.selected = true;
        repeatSel.appendChild(o);
      }
      rRow.appendChild(repeatSel);
      body.appendChild(rRow);

      // Weekly is the only frequency where "which days" is a real question,
      // and it's the common one — 毎週 月・水 shouldn't need a second dialog.
      const dRow = el('div', 'f-row f-byday');
      dRow.appendChild(el('span', 'f-k', '曜日'));
      dayChips = el('div', 'f-days');
      for (let i = 0; i < 7; i++) {
        const b = el('button', 'f-day', WEEKDAY_JA[i]);
        if (i === 0) b.classList.add('sun');
        if (i === 6) b.classList.add('sat');
        b.onclick = () => {
          const code = BYDAY[i];
          const at = f.repeat.byday.indexOf(code);
          if (at >= 0) f.repeat.byday.splice(at, 1);
          else f.repeat.byday.push(code);
          f.repeat.byday.sort((a, b2) => BYDAY.indexOf(a) - BYDAY.indexOf(b2));
          syncRepeat();
        };
        dayChips.appendChild(b);
      }
      dRow.appendChild(dayChips);
      body.appendChild(dRow);

      const uRow = el('div', 'f-row f-until');
      uRow.appendChild(el('span', 'f-k', '終了日'));
      untilInput = el('input', 'f-date');
      untilInput.type = 'date';
      untilInput.value = f.repeat.until;
      uRow.appendChild(untilInput);
      const clear = el('button', 'mini-btn', '無期限');
      clear.onclick = () => { f.repeat.until = ''; syncRepeat(); };
      uRow.appendChild(clear);
      body.appendChild(uRow);

      repeatSel.onchange = () => {
        f.repeat.freq = repeatSel.value;
        // Default weekly to the day the event actually starts on — that's what
        // "every week" means when you haven't said otherwise.
        if (f.repeat.freq === 'WEEKLY' && !f.repeat.byday.length) {
          f.repeat.byday = [BYDAY[weekdayOf(f.startKey)]];
        }
        syncRepeat();
      };
      untilInput.onchange = () => { f.repeat.until = untilInput.value || ''; syncRepeat(); };
    }

    function syncRepeat() {
      if (!canRepeat) return;
      const on = !!f.repeat.freq;
      card.classList.toggle('repeats', on);
      card.classList.toggle('weekly', f.repeat.freq === 'WEEKLY');
      for (let i = 0; i < 7; i++) {
        dayChips.children[i].classList.toggle('on', f.repeat.byday.includes(BYDAY[i]));
      }
      untilInput.value = f.repeat.until;
      validate();
    }

    // --- reminders. TimeTree's own apps deliver these, so setting one here
    //     reaches the user's phone — which is most of the point.
    const alertRow = el('div', 'f-row');
    alertRow.appendChild(el('span', 'f-k', '通知'));
    const alertBox = el('div', 'f-alerts');
    const alertAdd = el('select', 'f-sel f-add');
    alertRow.append(alertBox, alertAdd);
    body.appendChild(alertRow);

    function paintAlerts() {
      alertBox.textContent = '';
      for (const m of f.alerts) {
        const chip = el('span', 'f-chip', TTX.api.alertLabel(m, f.allDay));
        const x = el('button', 'f-chip-x', '✕');
        x.title = '削除';
        x.onclick = () => { f.alerts = f.alerts.filter((v) => v !== m); paintAlerts(); };
        chip.appendChild(x);
        alertBox.appendChild(chip);
      }
      alertAdd.textContent = '';
      const rest = alertChoices(f.allDay).filter((m) => !f.alerts.includes(m));
      const head = el('option', null, f.alerts.length ? '＋ 追加' : '通知なし');
      head.value = '';
      alertAdd.appendChild(head);
      for (const m of rest) {
        const o = el('option', null, TTX.api.alertLabel(m, f.allDay));
        o.value = String(m);
        alertAdd.appendChild(o);
      }
      alertAdd.value = '';
      alertAdd.disabled = !rest.length;
    }
    alertAdd.onchange = () => {
      if (!alertAdd.value) return;
      f.alerts = [...new Set([...f.alerts, +alertAdd.value])].sort((a, b) => a - b);
      paintAlerts();
    };
    paintAlerts();

    // --- attendees. The detail popover could already show these; not being
    //     able to SET them made the form a downgrade from TimeTree on the one
    //     thing a shared family calendar is actually for.
    const mRow = el('div', 'f-row');
    mRow.appendChild(el('span', 'f-k', '参加者'));
    const mBox = el('div', 'f-members');
    mRow.appendChild(mBox);
    body.appendChild(mRow);

    /** Read the roster fresh: it belongs to whichever calendar f points at. */
    function paintMembers() {
      const roster = st.members.get(f.calendarId);
      mRow.style.display = roster?.size ? '' : 'none';
      mBox.textContent = '';
      if (!roster?.size) return;
      for (const m of roster.values()) {
        const on = f.attendees.includes(m.user_id);
        const b = el('button', 'f-mem' + (on ? ' on' : ''));
        const av = el('span', 'acct-av sm', (m.name || '?').slice(0, 1));
        av.style.background = acctColor(String(m.user_id));
        b.append(av, el('span', 'f-mem-n', m.name || '(名前なし)'));
        b.onclick = () => {
          f.attendees = on
            ? f.attendees.filter((id) => id !== m.user_id)
            : [...f.attendees, m.user_id];
          paintMembers();
        };
        mBox.appendChild(b);
      }
    }
    paintMembers();

    // --- location / note
    const locRow = el('div', 'f-row');
    locRow.appendChild(el('span', 'f-k', '場所'));
    const loc = el('input', 'f-text');
    loc.placeholder = '任意';
    loc.value = f.location;
    loc.oninput = () => { f.location = loc.value; };
    locRow.appendChild(loc);
    body.appendChild(locRow);

    const urlRow = el('div', 'f-row');
    urlRow.appendChild(el('span', 'f-k', 'URL'));
    const urlInput = el('input', 'f-text');
    urlInput.placeholder = '任意';
    urlInput.value = f.url;
    urlInput.oninput = () => { f.url = urlInput.value; };
    urlRow.appendChild(urlInput);
    body.appendChild(urlRow);

    const noteRow = el('div', 'f-row top');
    noteRow.appendChild(el('span', 'f-k', 'メモ'));
    const note = el('textarea', 'f-note');
    note.placeholder = '任意';
    note.rows = 3;
    note.value = f.note;
    note.oninput = () => { f.note = note.value; };
    noteRow.appendChild(note);
    body.appendChild(noteRow);

    // --- checklist. Position is what the server keeps (the `order` field it
    //     sends is ignored on read), so the array IS the list.
    const clRow = el('div', 'f-row top');
    clRow.appendChild(el('span', 'f-k', 'リスト'));
    const clBox = el('div', 'f-cl');
    clRow.appendChild(clBox);
    body.appendChild(clRow);

    function addItem(at) {
      f.checklist.splice(at, 0, { title: '', checked: false });
      paintChecklist(at);
    }

    function paintChecklist(focusAt) {
      clBox.textContent = '';
      f.checklist.forEach((it, i) => {
        const row = el('div', 'f-cl-i');
        const cb = el('button', 'f-cl-c' + (it.checked ? ' on' : ''), it.checked ? '✓' : '');
        cb.onclick = () => { it.checked = !it.checked; paintChecklist(); };
        const inp = el('input', 'f-cl-t');
        inp.value = it.title;
        inp.placeholder = '項目';
        inp.oninput = () => { it.title = inp.value; };
        inp.onkeydown = (e) => {
          // The form saves on Enter in a plain input; in a list, Enter means
          // "next item". Stop it here rather than special-casing up there.
          if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); return addItem(i + 1); }
          // Backspace on an empty row removes it, the way every list editor works.
          if (e.key === 'Backspace' && !inp.value) {
            e.preventDefault();
            e.stopPropagation();
            f.checklist.splice(i, 1);
            paintChecklist(Math.max(0, i - 1));
          }
        };
        const x = el('button', 'f-cl-x', '✕');
        x.title = '削除';
        x.onclick = () => { f.checklist.splice(i, 1); paintChecklist(); };
        row.append(cb, inp, x);
        clBox.appendChild(row);
      });
      const add = el('button', 'f-cl-add', '＋ 項目を追加');
      add.onclick = () => addItem(f.checklist.length);
      clBox.appendChild(add);
      if (focusAt != null) clBox.querySelectorAll('.f-cl-t')[focusAt]?.focus();
    }
    paintChecklist();

    // --- calendar. Only worth asking when there's a choice. Moving an event
    //     between calendars isn't a field the API patches, so edit shows it
    //     as a fact rather than a control.
    const enabled = st.calendars.filter((c) => st.enabled.has(c.id));
    if (editing) {
      const cal = TTX.store.calendarOf(f.calendarId);
      if (cal && enabled.length > 1) {
        const r = el('div', 'f-row');
        r.append(el('span', 'f-k', 'カレンダー'), el('span', 'f-fact', cal.name));
        body.appendChild(r);
      }
    } else if (enabled.length > 1) {
      const r = el('div', 'f-row');
      r.appendChild(el('span', 'f-k', 'カレンダー'));
      const sel = el('select', 'f-sel');
      for (const c of enabled) {
        const o = el('option', null, c.name);
        o.value = c.id;
        if (c.id === f.calendarId) o.selected = true;
        sel.appendChild(o);
      }
      sel.onchange = () => {
        // select.value is a STRING; calendar ids are numbers, and both the
        // label and event caches are Maps keyed by the number. Taking
        // sel.value directly made every lookup miss — which meant a created
        // event never reached the cache and didn't appear until a full
        // re-sync. Round-trip through the calendar to keep the id's type.
        const c = enabled.find((x) => String(x.id) === sel.value);
        if (!c) return;
        f.calendarId = c.id;
        // Labels and members both belong to a calendar, so the ids we were
        // holding mean nothing now.
        paintLabels();
        const roster = st.members.get(c.id);
        f.attendees = st.me?.id && roster?.has(st.me.id) ? [st.me.id] : [];
        paintMembers();
      };
      r.appendChild(sel);
      body.appendChild(r);
    }

    // --- foot
    const foot = el('div', 'f-foot');
    if (editing) {
      const del = el('button', 'btn danger', '削除');
      del.onclick = async () => {
        closeForm();
        await removeEvent(opts.occ);
      };
      foot.appendChild(del);
    }
    foot.appendChild(el('div', 'tb-spacer'));
    const err = el('div', 'f-err');
    foot.appendChild(err);
    const cancel = el('button', 'btn', 'キャンセル');
    cancel.onclick = () => tryClose();
    const saveBtn = el('button', 'btn primary', '保存');
    saveBtn.appendChild(el('kbd', null, MOD + ' ↵'));
    foot.append(cancel, saveBtn);
    card.appendChild(foot);

    scrim.appendChild(card);
    document.body.appendChild(scrim);

    // --- behaviour

    /** Keep the duration when the start moves: that's almost always the intent. */
    function onStartChanged(prevStart) {
      const mins = Math.round((endEpoch(f) - prevStart) / 60000);
      if (mins < 0) return;
      const [k, t] = TTX.tz.shiftWall(f.startKey, f.startTime, mins);
      f.endKey = k;
      if (!f.allDay) f.endTime = t;
    }

    function syncWhen() {
      sDate.value = f.startKey;
      sTime.value = f.startTime;
      eDate.value = f.endKey;
      eTime.value = f.endTime;
      card.classList.toggle('allday', f.allDay);
      sw.className = 'sw' + (f.allDay ? ' on' : '');
      sw.setAttribute('aria-pressed', String(f.allDay));
      const days = TTX.tz.daysBetween(f.startKey, f.endKey).length;
      span.textContent = f.allDay && days > 1 ? `${days}日間` : '';
      validate();
    }

    function validate() {
      const bad = endEpoch(f) < startEpoch(f);
      err.textContent = bad ? '終了が開始より前です' : '';
      saveBtn.disabled = bad || !title.value.trim();
      return !saveBtn.disabled;
    }

    sw.onclick = () => {
      f.allDay = !f.allDay;
      // Only one combination is actually invalid; leave the rest literal.
      if (f.allDay && f.endKey < f.startKey) f.endKey = f.startKey;
      f.alerts = remapAlerts(f.alerts, f.allDay);
      paintAlerts();
      syncWhen();
    };
    sDate.onchange = () => {
      if (!sDate.value) return syncWhen();
      const prev = startEpoch(f);
      f.startKey = sDate.value;
      onStartChanged(prev);
      syncWhen();
    };
    sTime.onchange = () => {
      if (!sTime.value) return syncWhen();
      const prev = startEpoch(f);
      f.startTime = sTime.value;
      onStartChanged(prev);
      syncWhen();
    };
    eDate.onchange = () => { if (eDate.value) f.endKey = eDate.value; syncWhen(); };
    eTime.onchange = () => { if (eTime.value) f.endTime = eTime.value; syncWhen(); };

    /** The friendly shape the api layer's writers take. */
    const asEvent = () => ({
      title: f.title,
      allDay: f.allDay,
      startAt: startEpoch(f),
      endAt: endEpoch(f),
      tz: TZ,
      labelId: f.labelId,
      note: f.note,
      location: f.location,
      alerts: f.alerts,
      attendees: f.attendees,
      url: f.url,
      checklist: f.checklist,
      // Carry the original attachment as the base so keys we never modelled
      // ride along into the copy an occurrence edit or a split creates.
      attachment: raw?.attachment,
    });

    async function save() {
      if (!validate()) return;
      f.title = title.value.trim();
      saveBtn.disabled = true;
      saveBtn.textContent = '保存中…';
      try {
        let msg = '保存しました';
        if (editing && series && scope === 'this') {
          // Replace one occurrence: a new event linked to the master, plus an
          // EXDATE where it used to be. Both come back and both must land.
          const { child, master } = await TTX.api.editOccurrence(
            f.calendarId, raw, opts.occ.start, asEvent());
          if (!child?.uuid) throw new Error('サーバーが予定を返しませんでした');
          TTX.store.applyEvent(f.calendarId, child);
          if (master?.uuid) TTX.store.applyEvent(f.calendarId, master);
          msg = 'この回だけを変更しました';
        } else if (editing && series && scope === 'future') {
          // Split: a new series from here, the old one ended at the previous
          // occurrence. Ask the expander which one that is rather than
          // subtracting a day — the rule decides where the gaps are.
          const prev = previousOccurrence(raw, opts.occ.start);
          if (!prev) {
            // Nothing before it, so "from here on" is the whole thing.
            const patch = diffPatch(raw, f);
            if (Object.keys(patch).length) {
              const saved = await TTX.api.updateEvent(f.calendarId, raw.uuid, patch);
              TTX.store.applyEvent(f.calendarId, saved?.uuid ? saved : { ...raw, ...patch });
            }
            msg = 'すべての回を変更しました';
          } else {
            const { created, master } = await TTX.api.splitSeries(
              f.calendarId, raw, ymd(prev, raw.start_timezone || TZ), asEvent());
            if (!created?.uuid) throw new Error('サーバーが予定を返しませんでした');
            TTX.store.applyEvent(f.calendarId, created);
            if (master?.uuid) TTX.store.applyEvent(f.calendarId, master);
            msg = 'これ以降の回を変更しました';
          }
        } else if (editing) {
          const patch = diffPatch(raw, f);
          if (!Object.keys(patch).length) {
            closeForm();
            return toast('変更はありません');
          }
          const saved = await TTX.api.updateEvent(f.calendarId, raw.uuid, patch);
          // Trust the server's echo when we get one; fall back to the merge we
          // just asked for, which is what PUT semantics promise anyway.
          TTX.store.applyEvent(f.calendarId, saved?.uuid ? saved : { ...raw, ...patch });
          if (series) msg = 'すべての回を変更しました';
        } else {
          const rule = buildRepeat(f.repeat);
          const saved = await TTX.api.createEvent(f.calendarId, {
            ...asEvent(),
            recurrences: rule ? [rule] : [],
          });
          if (!saved?.uuid) throw new Error('サーバーが予定を返しませんでした');
          TTX.store.applyEvent(f.calendarId, saved);
          msg = rule ? '繰り返しの予定を作成しました' : '予定を作成しました';
        }
        closeForm();
        await showKey(f.startKey);
        toast(msg);
      } catch (e) {
        saveBtn.disabled = false;
        saveBtn.textContent = '保存';
        saveBtn.appendChild(el('kbd', null, MOD + ' ↵'));
        err.textContent = '';
        toast('保存に失敗しました: ' + e.message);
      }
    }
    saveBtn.onclick = () => save();

    /**
     * A stray click on the backdrop shouldn't cost you what you typed. An
     * untouched form closes instantly — asking there would be nagging — but a
     * form with anything in it asks first.
     */
    async function tryClose() {
      if (!dirty()) return closeForm();
      const discard = await confirmDialog({
        title: '編集を破棄しますか',
        body: '入力した内容は保存されません。',
        ok: '破棄',
        danger: true,
      });
      if (discard) closeForm();
    }

    // Escape is handled centrally in keys(), not here: a listener on the card
    // plus the document one would both fire and stack two confirm dialogs.
    ui.formClose = tryClose;

    scrim.onclick = (e) => { if (e.target === scrim) tryClose(); };
    card.addEventListener('keydown', (e) => {
      // ⌘/Ctrl+Enter saves from anywhere, including the note textarea.
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); return save(); }
      // Plain Enter in a single-line field means "done", as in a native form.
      if (e.key === 'Enter' && /^(INPUT|SELECT)$/.test(e.target.tagName)) {
        e.preventDefault();
        save();
      }
    });

    syncWhen();
    syncRepeat();
    // Synchronously, as the palette does: a frame where the sheet is up but
    // unfocused is a frame where a fast typist loses their first keystroke.
    title.focus();
  }

  /** Bring `key` into view if the current range doesn't already cover it. */
  async function showKey(key) {
    const { from, to } = range();
    if (key < from || key > to) return jumpTo(key);
    await refresh('fade');
  }

  /**
   * The occurrence before `startMs`, or null if it's the first. Truncating a
   * series means naming the last occurrence to KEEP, and only the rule knows
   * where that is — "one day earlier" is a different date entirely for a weekly
   * or monthly series, and can land on a hole punched by an EXDATE.
   */
  function previousOccurrence(master, startMs) {
    const before = TTX.recur.expand(master, master.start_at, startMs - 1);
    return before.length ? before[before.length - 1] : null;
  }

  /** Editing a series asks which回 first; a plain event just opens. */
  async function editEvent(o) {
    const raw = TTX.store.rawEvent(o.calendarId, o.uuid);
    if (!raw) return toast('元の予定が見つかりません。再同期してください');
    if (!TTX.api.isMaster(raw)) return openForm({ occ: o });
    const scope = await chooseScope('edit');
    if (scope) openForm({ occ: o, scope });
  }

  async function removeEvent(o) {
    const raw = TTX.store.rawEvent(o.calendarId, o.uuid);
    if (!raw) return toast('元の予定が見つかりません。再同期してください');

    if (TTX.api.isMaster(raw)) {
      const scope = await chooseScope('delete');
      if (!scope) return;
      return removeSeries(o, raw, scope);
    }

    const okd = await confirmDialog({
      title: '予定を削除',
      body: `「${o.title}」を削除します。取り消せません。`,
      ok: '削除',
      danger: true,
    });
    if (!okd) return;
    try {
      await TTX.api.deleteEvent(o.calendarId, o.uuid);
      TTX.store.markDeleted(o.calendarId, o.uuid);
      await refresh('fade');
      toast('削除しました');
    } catch (e) {
      toast('削除に失敗しました: ' + e.message);
    }
  }

  /**
   * Deleting part of a series is not a DELETE — it's a rewrite of the master's
   * rule. Only "all" actually removes the event.
   */
  async function removeSeries(o, raw, scope) {
    const jp = (k) => `${+k.slice(5, 7)}月${+k.slice(8)}日`;
    const prev = scope === 'future' ? previousOccurrence(raw, o.start) : null;
    // "Everything from the first occurrence onwards" is just "everything".
    const effective = scope === 'future' && !prev ? 'all' : scope;

    const okd = await confirmDialog({
      title: '繰り返しの予定を削除',
      body: {
        this: `「${o.title}」の ${jp(o.startKey)} の回だけを削除します。取り消せません。`,
        future: `「${o.title}」の ${jp(o.startKey)} 以降の回を削除します。取り消せません。`,
        all: `「${o.title}」をすべての回で削除します。取り消せません。`,
      }[effective],
      ok: '削除',
      danger: true,
    });
    if (!okd) return;

    try {
      if (effective === 'all') {
        await TTX.api.deleteEvent(o.calendarId, raw.uuid);
        TTX.store.markDeleted(o.calendarId, raw.uuid);
      } else {
        const updated = effective === 'this'
          ? await TTX.api.excludeOccurrence(o.calendarId, raw, o.start)
          : await TTX.api.truncateSeries(o.calendarId, raw, ymd(prev, raw.start_timezone || TZ));
        if (updated?.uuid) TTX.store.applyEvent(o.calendarId, updated);
      }
      await refresh('fade');
      toast({ this: 'この回を削除しました', future: 'これ以降の回を削除しました', all: '削除しました' }[effective]);
    } catch (e) {
      toast('削除に失敗しました: ' + e.message);
    }
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
      { icon: '＋', main: '新しい予定', run: () => openForm() },
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
    // The form and the confirm own every key while they're up — otherwise the
    // grid behind them would still navigate under the user's typing. The
    // confirm swallows its own Escape in the capture phase, so this only ever
    // sees the form's.
    if (ui.form || ui.confirm) {
      if (e.key === 'Escape' && ui.form && !ui.confirm) { e.preventDefault(); ui.formClose?.(); }
      return;
    }
    if (e.key === 'Escape' && ui.detail) { e.preventDefault(); return closeDetail(); }
    if (ui.palette) return;
    const typing = /^(INPUT|TEXTAREA)$/.test(e.target.tagName);
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); return openPalette(); }
    if (typing) return;
    if (e.key === '/') { e.preventDefault(); return openPalette(); }
    if (e.key.toLowerCase() === 'n') { e.preventDefault(); return openForm(); }
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
    TTX.api.setTransport((path, opts) => window.host.api.request(path, opts));

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
