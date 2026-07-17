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

  const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), '
    + 'select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

  /**
   * Make `root` behave like a dialog: Tab stays inside it, the rest of the app
   * is hidden from assistive tech, and focus goes back where it came from when
   * it closes.
   *
   * All four overlays were missing every part of this. One Tab walked out of
   * the form into the agenda behind it — which was still focusable, still
   * clickable, and now wearing the focus ring — and closing anything dropped
   * focus on <body>, so the next Tab started over from the top of the app.
   *
   * Returns the release function; callers must call it when they tear down.
   */
  function dialog(root, { label, labelledBy } = {}) {
    const prev = document.activeElement;
    root.setAttribute('role', 'dialog');
    root.setAttribute('aria-modal', 'true');
    if (label) root.setAttribute('aria-label', label);
    if (labelledBy) root.setAttribute('aria-labelledby', labelledBy);

    const app = $('#app');
    app?.setAttribute('inert', '');

    const onKey = (e) => {
      if (e.key !== 'Tab') return;
      const items = [...root.querySelectorAll(FOCUSABLE)].filter((n) => n.offsetParent !== null);
      if (!items.length) return;
      const first = items[0];
      const last = items[items.length - 1];
      // Focus may sit on the dialog CONTAINER rather than a control inside it —
      // that's where the detail card starts, so a screen reader announces what
      // the dialog IS before reading its buttons. Tab from there falls inward
      // on its own, but Shift+Tab would walk straight out of the trap.
      if (document.activeElement === root || !root.contains(document.activeElement)) {
        e.preventDefault();
        (e.shiftKey ? last : first).focus();
        return;
      }
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    };
    root.addEventListener('keydown', onKey);

    return () => {
      root.removeEventListener('keydown', onKey);
      app?.removeAttribute('inert');
      // paint() rebuilds #app, so the element we came from may be gone.
      if (prev && document.contains(prev)) prev.focus();
    };
  }

  const ui = {
    view: 'agenda',
    cursor: '',            // any date inside the focused month
    query: '',
    mutedLabels: new Set(),
    // NOTE no weekStart here. It lives on the account, in TimeTree's own
    // `start_weekday` — see weekStartDow(). Keeping a local copy is what made
    // this window draw a Monday grid for someone whose TimeTree said Sunday.
    // Months either side of the cursor's month that the agenda has grown to
    // cover. See range(). Not persisted — a fresh window starts at three
    // months, the same as it always did.
    spanBack: 0,
    spanFwd: 2,
    seenMonth: '',         // the month the agenda is scrolled to; titles it
    growing: false,        // one extension at a time
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
    rowH: 0,
    cellH: 0,
    laneH: 0,
    status: '',
    syncing: false,
    syncFailed: false,
    notify: true,
    fired: new Map(),
    autoStart: false,
    settings: null,
    settingsRelease: null,
    hideEmpty: true,
    maps: false,
    mapPicker: null,
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

  /**
   * Which day a week begins on, 0 = 日曜 / 1 = 月曜.
   *
   * **This is TimeTree's setting, not ours.** `/api/v1/user/setting` carries
   * `start_weekday`, the phone app writes it, and it follows the account to
   * every device. Null means the account never set one, and TimeTree's own
   * default applies — 月曜 (measured: its web app renders 月火水木金土日 for
   * an account with no setting, and 日月火水木金土 for one with
   * start_weekday: 0).
   *
   * It was believed for a long time that TimeTree had no such setting and the
   * web app was simply hardcoded to Monday. That reading came from the
   * THROWAWAY account, whose setting is null. The real account had had
   * `start_weekday: 0` all along — so this app was the only screen in the
   * family showing a Monday grid.
   *
   * NOTE this is only about how the GRID is laid out. `weekdayOf()` answers
   * "what day is this", which is a fact and never moves: the 土/日 colours, the
   * 「7月21日(火)」 in the detail card and the BYDAY of a recurrence all keep
   * using it directly. And `recur.js` has its own `weekStart` for RRULE
   * arithmetic — RFC 5545's WKST, a different thing entirely. Don't wire this
   * to that.
   */
  const weekStartDow = () => (TTX.store.state.setting?.start_weekday === 0 ? 0 : 1);

  /**
   * A time, for a person to read. TimeTree's own setting again
   * (`user_setting.military_time`), and its 12-hour form is the Japanese one:
   * 午前 0:30 at midnight, 午後 0:00 at noon. See tz.clock().
   *
   * ⚠️ Reading only. The 24-hour string is the VALUE — `<input type="time">`
   * takes it, `toEpoch()` parses it, and the week grid does arithmetic on its
   * first two characters. Feed one of these into any of those and you have not
   * mislabelled a time, you have moved it.
   */
  const clock = (t) => TTX.tz.clock(t, TTX.store.state.setting?.military_time !== false);
  const weekStart = (key) => addDays(key, -((weekdayOf(key) - weekStartDow() + 7) % 7));

  /**
   * Agenda spans three months and GROWS as you scroll; month spans one; week
   * spans seven days.
   *
   * `spanBack`/`spanFwd` are months either side of the cursor's month. They
   * start at 0/2 — the three months this always showed — and the agenda's
   * scroll handler pushes them outward when you reach an edge, so a year is a
   * continuous scroll rather than twelve presses of →. The cursor itself does
   * not move while you scroll; if it did, the range would slide out from under
   * the very scroll that asked for it.
   *
   * Capped: the DOM is real, and an agenda nobody ever navigates away from
   * would otherwise grow without bound.
   */
  /**
   * How much agenda to keep ready beyond the edge you're heading for, measured
   * in SCREENFULS — not months.
   *
   * A month is not a unit of length here. An empty month collapses to a single
   * 「予定なし」 line; a busy one is several screens. So a fixed month count is
   * either far too little (a sparse calendar can add ten months and still not
   * fill the window — which makes the "am I near the edge?" test permanently
   * true, and it grows until it hits the cap in one flick) or far too much (a
   * busy calendar ends up rendering years of rows nobody asked for).
   *
   * So: work out how many months the runway actually needs from the density
   * that's on screen right now, and add them in ONE paint. Measured, a paint at
   * this size costs ~26ms — two dropped frames. Doing that once per month added
   * is exactly the stutter you feel while scrolling.
   */
  const AGENDA_RUNWAY = 2;
  /**
   * And how much may be RENDERED at once, also in screenfuls.
   *
   * Without this the list only ever grows, and the scrollbar is the thing that
   * pays: measured on a 10-month seed, the thumb went from 96px to 24px just by
   * scrolling to the end — and that was a calendar far quieter than a real
   * family's. A scrollbar that shrinks every time you use it stops telling you
   * where you are, which is the only job it has.
   *
   * So the window is finite: growing one end trims the far one, and the thumb
   * keeps roughly the same size no matter how far you go. Nothing is lost —
   * scrolling back re-grows what was trimmed, because you're heading that way.
   */
  const AGENDA_WINDOW = 6;
  /**
   * A ceiling on how many months may be RENDERED at once. Not a limit on how
   * far you can travel — the window slides, so there is no wall.
   *
   * The pixel budget above can't bound this on its own: a nearly empty calendar
   * answers "how many months fill six screens?" with about ninety, and past
   * AGENDA_DAY_CAP daysBetween quietly stops returning days, so the far end
   * renders as nothing at all.
   */
  const AGENDA_MAX_MONTHS = 49;
  /**
   * And how far a SINGLE growth may jump. Density decides how many months the
   * runway needs, and an empty stretch answers "dozens" — which lands deeper in
   * the empty part, where the answer is bigger still. Measured: 14 scrolls to
   * the bottom travelled from 2026年7月 to 2030年8月 and left the list showing
   * nothing at all.
   */
  const AGENDA_MAX_STEP = 3;
  /* daysBetween caps at 400 by default. The agenda can ask for far more than
   * that now, and going over doesn't error — it just stops handing back days,
   * so the last months render as nothing at all. Ask for what the cap allows. */
  const AGENDA_DAY_CAP = AGENDA_MAX_MONTHS * 31 + 31;
  const resetSpan = () => { ui.spanBack = 0; ui.spanFwd = 2; ui.seenMonth = ''; };

  function range() {
    if (ui.view === 'month') return { from: monthStart(ui.cursor), to: monthEnd(ui.cursor) };
    if (ui.view === 'week') {
      const s = weekStart(ui.cursor);
      return { from: s, to: addDays(s, 6) };
    }
    return {
      from: monthStart(addMonths(ui.cursor, -ui.spanBack)),
      to: monthEnd(addMonths(ui.cursor, ui.spanFwd)),
    };
  }

  // --- persistence ------------------------------------------------------

  const PREF = 'ttc.prefs';
  function savePrefs() {
    try {
      localStorage.setItem(PREF, JSON.stringify({
        view: ui.view,
        theme: ui.theme,
        notify: ui.notify,
        hideEmpty: ui.hideEmpty,
        maps: ui.maps,
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
      if (p.notify != null) ui.notify = !!p.notify;
      if (p.hideEmpty != null) ui.hideEmpty = !!p.hideEmpty;
      if (p.maps != null) ui.maps = !!p.maps;
      // p.weekStart is deliberately ignored, and no longer written. It was our
      // own default (月曜) that savePrefs baked in the first time anyone touched
      // any setting — so it was never a choice, and it silently outvoted the
      // account's real start_weekday. TimeTree's answer is the only one now.
      if (p.muted) ui.mutedLabels = new Set(p.muted);
      return p;
    } catch {
      return {};
    }
  }

  // --- theme ------------------------------------------------------------

  const THEME_LABEL = { system: 'システムに従う', light: 'ライト', dark: 'ダーク' };
  const THEME_ICON = { system: 'monitor', light: 'sun', dark: 'moon' };

  /**
   * An icon-only button. `title` shows a tooltip to people using a mouse;
   * `aria-label` is the only thing a screen reader gets, since the button's
   * content is a decorative svg. They were the same string every time, so it
   * takes one helper rather than remembering twice.
   */
  function iconBtn(name, label, onClick, cls = 'icon-btn') {
    const b = el('button', cls);
    b.appendChild(TTX.icon(name, 15));
    b.title = label;
    b.setAttribute('aria-label', label);
    b.onclick = onClick;
    return b;
  }

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
      // This is the app's ONLY channel for "that worked" / "that failed" —
      // 保存しました, 保存に失敗しました, コメントを送信できませんでした. Without
      // a live region every one of them is silent to a screen reader, so the
      // answer to "did my edit save?" is nothing at all. `polite` waits for a
      // gap rather than cutting in: none of these are emergencies.
      toastEl.setAttribute('role', 'status');
      toastEl.setAttribute('aria-live', 'polite');
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

  /**
   * The colour an occurrence carries.
   *
   * Red means "you are not at work". 七夕 and 海の日 are both memorialdays, but
   * one is a Tuesday you still go to school on and the other is a day off —
   * painting them the same red made the single most important thing a calendar
   * says unreadable. The agenda already told them apart ("暦" vs "祝"); the
   * grids were throwing that away.
   */
  const railColor = (o) => {
    if (o.holiday) return o.workday ? 'var(--label-3)' : 'var(--red)';
    const lb = TTX.store.labelOf(o.calendarId, o.labelId);
    return lb ? TTX.api.colorHex(lb.color) : 'var(--label-3)';
  };

  /**
   * Paint a filled block in the occurrence's colour, with text you can read on
   * it. Everything used to be white-on-colour unconditionally, which failed
   * WCAG AA on nine of the ten default labels — 八田野帰省 on ブライト・オレンジ
   * measured 1.65:1.
   */
  function fill(node, o) {
    node.style.background = railColor(o);
    const lb = o.holiday ? null : TTX.store.labelOf(o.calendarId, o.labelId);
    node.style.color = lb ? TTX.api.labelFg(lb) : '#ffffff';
  }

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
  /**
   * No spaces around 年月日. Japanese doesn't put them there — "2026年 7月" is
   * a Latin typesetting habit applied to a script that has its own rule, and
   * `text-autospace` already opens the gap where one belongs.
   */
  function titleText() {
    // Scrolling the agenda moves what you're looking at without moving the
    // cursor, so the cursor's month is the wrong answer there. Derived, not
    // poked into the node: paint() rebuilds the toolbar on every growth, and a
    // title written directly would be reset to the cursor's month each time —
    // then skipped by titleFromScroll's own "nothing changed" guard, which is
    // exactly how it got stuck reading 7月 in December.
    if (ui.view === 'agenda' && ui.seenMonth) return ui.seenMonth;
    const [y, m] = ui.cursor.split('-');
    if (ui.view !== 'week') return `${y}年${+m}月`;
    const s = weekStart(ui.cursor);
    const e = addDays(s, 6);
    return monthOf(s) === monthOf(e)
      ? `${s.slice(0, 4)}年${+s.slice(5, 7)}月${+s.slice(8)}–${+e.slice(8)}日`
      : `${s.slice(0, 4)}年${+s.slice(5, 7)}月${+s.slice(8)}日–${+e.slice(5, 7)}月${+e.slice(8)}日`;
  }

  function renderToolbar() {
    const t = el('div', 'toolbar');

    t.appendChild(el('div', 'tb-title', titleText()));

    const unit = ui.view === 'week' ? '週' : '月';
    const nav = el('div', 'nav');
    nav.appendChild(iconBtn('chevron-left', `前の${unit} (←)`, () => go(-1)));
    const today = el('button', 'pill', '今日');
    today.title = '今日 (T)';
    today.onclick = () => jumpTo(todayKey());
    nav.appendChild(today);
    nav.appendChild(iconBtn('chevron-right', `次の${unit} (→)`, () => go(1)));
    t.appendChild(nav);

    t.appendChild(el('div', 'tb-spacer'));

    const add = el('button', 'new-btn');
    add.append(TTX.icon('plus', 14), el('span', null, '予定'));
    add.title = '新しい予定 (N)';
    add.onclick = () => openForm();
    t.appendChild(add);

    const seg = el('div', 'seg');
    seg.setAttribute('role', 'tablist');
    for (const [key, label] of [['agenda', 'アジェンダ'], ['week', '週'], ['month', '月']]) {
      const on = ui.view === key;
      const b = el('button', on ? 'on' : '', label);
      b.setAttribute('role', 'tab');
      b.setAttribute('aria-selected', String(on));
      b.onclick = () => setView(key);
      seg.appendChild(b);
    }
    t.appendChild(seg);

    const search = el('button', 'search-hint');
    search.append(TTX.icon('search', 13), el('span', 'sh-t', ui.query || '検索・移動'));
    search.appendChild(el('kbd', null, MOD + ' K'));
    search.onclick = () => openPalette();
    t.appendChild(search);

    t.appendChild(iconBtn(THEME_ICON[ui.theme], 'テーマ: ' + THEME_LABEL[ui.theme], () => {
      const order = ['system', 'light', 'dark'];
      applyTheme(order[(order.indexOf(ui.theme) + 1) % 3]);
      toast('テーマ: ' + THEME_LABEL[ui.theme]);
    }));
    t.appendChild(iconBtn('refresh', '再同期', () => resync()));

    return t;
  }

  /** Step by whatever the current view actually shows. */
  function go(n) {
    ui.cursor = ui.view === 'week' ? addDays(ui.cursor, n * 7) : addMonths(ui.cursor, n);
    // → after scrolling six months down should move one month from the cursor,
    // not from wherever the scroll wandered to. Deliberate travel resets the
    // span the scroll accumulated.
    resetSpan();
    refresh(n > 0 ? 'next' : 'prev');
  }

  /** Jumping to an arbitrary date should still feel directional. */
  function jumpTo(key, view) {
    const dir = key > ui.cursor ? 'next' : key < ui.cursor ? 'prev' : 'fade';
    ui.cursor = key;
    resetSpan();
    if (view) { ui.view = view; savePrefs(); }
    refresh(dir);
  }

  function setView(v) {
    if (ui.view === v) return;
    ui.view = v;
    resetSpan();
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
    const cv = el('span', 'acct-cv'); cv.appendChild(TTX.icon('chevron-down', 12));
    bar.append(av, box, cv);
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
      if (on) { const ck = el('span', 'menu-ck'); ck.appendChild(TTX.icon('check', 13)); it.appendChild(ck); }
      it.onclick = () => { closeMenus(); if (!on) switchAccount(a.id); };
      menu.appendChild(it);

      if (ui.accounts.length > 1) {
        const rm = el('button', 'menu-x');
        rm.appendChild(TTX.icon('x', 12));
        rm.setAttribute('aria-label', a.name + ' を削除');
        rm.title = a.name + ' を削除';
        rm.onclick = (e) => { e.stopPropagation(); closeMenus(); removeAccount(a); };
        it.appendChild(rm);
      }
    }

    menu.appendChild(el('div', 'menu-sep'));
    const add = el('button', 'menu-i');
    const ai = el('span', 'menu-ic'); ai.appendChild(TTX.icon('user-plus', 14));
    add.append(ai, el('span', 'acct-nm', 'アカウントを追加'));
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
  // The CLI switches accounts through this same function, so the window ends up
  // showing what the CLI is talking about. Handing the function over rather than
  // letting cli-host.js re-implement the sequence: it would have to know to
  // reload the store AND re-render, and one of those gets forgotten.
  TTX.cli._switch = switchAccount;

  /**
   * A write from the CLI has to become visible — the store has no subscribers,
   * so whoever writes re-renders. Both rules here are the auto-sync's, which
   * answers the same question (a change arriving that nobody at this window
   * asked for):
   *
   *   · Don't paint over someone. paint() closes the detail card and rebuilds
   *     the row the form is anchored to. The event is in the store either way,
   *     and the next repaint shows it.
   *   · Don't navigate. The form calls showKey() after a save because you were
   *     looking at the form when you saved; the person at this window didn't
   *     run the command and shouldn't have their month yanked out from under
   *     them.
   */
  TTX.cli._render = () => { if (!busy()) render(); };

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
      // Every calendar comes with ten labels whether or not anyone uses them,
      // so offer a filter for the ones that mean something: named by the user,
      // or actually worn by an event. Filtering by "named" alone hid labels
      // that are in use but unnamed — you couldn't mute them at all. Judged
      // over the whole history, not the current view, so the list doesn't
      // reshuffle as you navigate.
      const used = new Set((st.events.get(cal.id) || [])
        .filter((e) => !e.deactivated_at)
        .map((e) => e.label_id));
      for (const lb of st.labels.get(cal.id) || []) {
        if (lb.name || used.has(lb.id)) labels.push({ cal, lb });
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
        b.append(dot, el('span', 'nm', TTX.api.labelName(lb)));
        b.onclick = () => {
          on ? ui.mutedLabels.add(key) : ui.mutedLabels.delete(key);
          savePrefs();
          render();
        };
        s.appendChild(b);
      }
    }

    // MD / CSV / JSON / ICS used to sit here, four buttons wide, permanently,
    // in the best real estate the sidebar has. They're export formats — things
    // you reach for a handful of times a year — and one of them is JSON, which
    // is a developer leaving their own tools on the shelf. They moved into
    // settings; this is the door.
    const foot = el('div', 'side-foot');
    const gear = el('button', 'side-item');
    gear.append(TTX.icon('sliders', 14), el('span', 'nm', '設定'));
    gear.title = '設定 (,)';
    gear.onclick = () => openSettings();
    foot.appendChild(gear);
    s.appendChild(foot);
    s.appendChild(el('div', 'side-status', ui.status));
    const sync = el('div', 'side-sync' + (ui.syncFailed ? ' bad' : ''), syncedText());
    s.appendChild(sync);
    return s;
  }

  // --- render: agenda ---------------------------------------------------

  function renderAgenda() {
    const { from, to } = range();
    const byDay = TTX.model.groupByDay(occs(), from, to, AGENDA_DAY_CAP);
    const wrap = el('div', 'agenda');
    const today = todayKey();
    let month = '';
    let count = 0;

    /**
     * A run of empty days becomes one line, not thirty.
     *
     * Measured on a real July: 63% of the agenda's scroll height was days
     * where nothing happens, and the loudest recurring mark on the page was a
     * dash. You were spending your best ink on absence, and 16 events meant 90
     * rows of scrolling. But deleting empty days outright loses something
     * real — "the week of the 13th is completely free" is an answer you often
     * want. So collapse the run and say so, in one row.
     */
    const runs = [];
    for (const [key, list] of Object.entries(byDay)) {
      const prev = runs[runs.length - 1];
      if (ui.hideEmpty && !list.length && prev && prev.gap) prev.keys.push(key);
      else if (ui.hideEmpty && !list.length) runs.push({ gap: true, keys: [key] });
      else runs.push({ gap: false, key, list });
    }

    for (const run of runs) {
      if (run.gap) {
        const m = monthOf(run.keys[0]);
        if (m !== month) {
          month = m;
          wrap.appendChild(el('div', 'ag-month', `${m.slice(0, 4)}年${Number(m.slice(5))}月`));
        }
        const jp = (k) => `${+k.slice(5, 7)}/${+k.slice(8)}`;
        const first = run.keys[0];
        const last = run.keys[run.keys.length - 1];
        const b = el('button', 'ag-gap');
        // Anchorable too — see growAgenda. A stretch of empty days collapses to
        // one of these, so in a quiet part of the calendar there are NO day
        // rows at all, and anchoring on days alone finds nothing and strands
        // the scroll there.
        b.dataset.key = run.keys[0];
        b.textContent = run.keys.length === 1
          ? `${jp(first)} 予定なし`
          : `${jp(first)} – ${jp(last)} 予定なし（${run.keys.length}日）`;
        b.title = '空いている日にも予定を追加できます';
        b.onclick = () => openForm({ dateKey: first });
        wrap.appendChild(b);
        continue;
      }
      const { key, list } = run;
      const m = monthOf(key);
      if (m !== month) {
        month = m;
        wrap.appendChild(el('div', 'ag-month', `${m.slice(0, 4)}年${Number(m.slice(5))}月`));
      }
      const dow = weekdayOf(key);
      const day = el('div', 'ag-day' + (list.length ? '' : ' empty') + (key === today ? ' today' : ''));
      // The one thing in this list with a stable identity across a re-render.
      // growAgenda holds onto a date to put the scroll back where it was, and
      // it can't use the 月 headers for that: they're `position: sticky`, so
      // their measured position tracks the scroll instead of their place in the
      // list, and every reading comes out ~0.
      day.dataset.key = key;

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
    ui.status = `${count}件の予定`;

    // Reaching an edge is the ask for more. 600px ahead of it, so the next
    // months are already there by the time you get to where they go — hitting
    // the floor first and loading after is what makes infinite scroll feel like
    // stalling.
    //
    // Only in the direction you're travelling. Without that, scrolling DOWN
    // while still near the top also grows backwards — and an empty month
    // collapses to a single 「予定なし」 line, so prepending one leaves you
    // still inside the trigger zone. It would run all the way to the 25-month
    // cap in one gesture.
    wrap.onscroll = () => {
      const top = wrap.scrollTop;
      const up = top < (ui.lastTop ?? top);
      ui.lastTop = top;
      titleFromScroll(wrap);
      // One screenful from the edge, not a fixed 600px: on a tall window 600px
      // is already the edge, and on a short one it is the whole list.
      const edge = wrap.clientHeight;
      const want = up ? (top < edge ? -1 : 0)
        : (wrap.scrollHeight - top - wrap.clientHeight < edge ? 1 : 0);
      if (!want) return;
      // When the scroll SETTLES, and then some — never during it. Growing
      // re-renders the list, which is both the stall you feel under your
      // fingers and, worse, the row you were reaching for being replaced
      // between the scroll and the click: the click then lands on a node that
      // no longer exists, or on whatever moved into its place.
      //
      // The wait is long on purpose. Stopping and clicking is the ordinary
      // thing to do, and it has to win the race — once the card is open,
      // busy() holds the growth off for as long as you are reading. The runway
      // means a screenful or two is normally already in hand, so nothing is
      // waiting on this.
      clearTimeout(ui.growTimer);
      ui.growTimer = setTimeout(() => growAgenda(want), 350);
    };
    return wrap;
  }

  function eventRow(o, dayKey) {
    const row = el('button', 'ev' + (o.allDay ? ' allday' : '')
      + (o.holiday ? ' holiday' : '') + (o.workday ? ' workday' : ''));
    // A dot, not a 3px stripe. The stripe carried real information, so it
    // wasn't the decorative version of the tell — but it was still the wrong
    // shape for the job: 3×17px of #e73b3b with 2px rounding reads as a smudge
    // rather than a hue, and it added a fourth left edge to a row that has one
    // thing to say. Apple Calendar uses a dot; the comparison writing is
    // unanimous that it scans better than Google's filled blocks.
    const dot = el('div', 'dot');
    dot.style.background = railColor(o);
    row.appendChild(dot);
    row.appendChild(el('div', 't', o.holiday ? (o.workday ? '暦' : '祝') : o.allDay ? '終日' : clock(o.startTime)));

    const ti = el('div', 'ti');
    ti.appendChild(document.createTextNode(o.title));
    const meta = [];
    if (o.multiDay) meta.push(`${o.days.indexOf(dayKey) + 1}/${o.days.length}日目`);
    if (o.location) meta.push(o.location);
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

    // Same logic as the calendar tag: name the author only when it isn't you.
    // "たろうが追加" on every one of your own 255 entries is noise; it's the ones
    // you DIDN'T write that you need to spot.
    if (o.authorName && o.authorId !== TTX.store.state.me?.id) {
      const av = el('span', 'ev-by');
      av.textContent = o.authorName.slice(0, 1);
      av.style.background = acctColor(String(o.authorId));
      av.title = o.authorName + ' が追加';
      row.appendChild(av);
    } else {
      row.appendChild(el('span', 'ev-by empty'));
    }
    row.onclick = () => openDetail(o, row);
    return row;
  }

  // --- render: month ----------------------------------------------------

  /**
   * Lay the week's spanning events into lanes.
   *
   * A three-day trip used to render as three separate chips, one per cell,
   * each carrying the full title — so 八田野帰省 appeared three times and read
   * as three events. A calendar showing something that isn't true is worse
   * than a calendar showing less, and this is the failure people notice first.
   *
   * So: one bar per event per week row, the width of its actual span. Lanes
   * stack them when they overlap. A span crossing Saturday is drawn once in
   * each week — you can't read a label that's off the top of the row.
   */
  function laneWeek(days, all) {
    const first = days[0];
    const last = days[days.length - 1];
    const bars = all
      .filter((o) => o.multiDay && o.endKey >= first && o.startKey <= last)
      // Longest first, then earliest: the eye follows a long bar across, and
      // starting with the long ones keeps them on the top lanes.
      .sort((a, b) => (b.days.length - a.days.length) || (a.startKey < b.startKey ? -1 : 1));

    const lanes = [];
    const out = [];
    for (const o of bars) {
      const col = Math.max(0, days.indexOf(o.startKey < first ? first : o.startKey));
      const endCol = Math.min(6, days.indexOf(o.endKey > last ? last : o.endKey));
      const span = endCol - col + 1;
      let lane = lanes.findIndex((cells) => !cells.some((c) => c >= col && c <= endCol));
      if (lane < 0) { lane = lanes.length; lanes.push([]); }
      for (let c = col; c <= endCol; c++) lanes[lane].push(c);
      out.push({
        o,
        lane,
        col,
        span,
        // A bar that continues past this row's edge shouldn't grow a rounded
        // cap there — the cap is what says "this is where it ends".
        openStart: o.startKey < first,
        openEnd: o.endKey > last,
      });
    }
    return { bars: out, lanes: lanes.length };
  }

  function renderMonth() {
    const from = monthStart(ui.cursor);
    const to = monthEnd(ui.cursor);
    const gridFrom = weekStart(from);
    // As many weeks as the month actually needs — 5 or 6 — not always 6.
    //
    // A fixed 41 draws a whole extra week of next month in most months (4 of
    // the 6 checked against 本家: it renders 5/6/5/5/6/5 for Jul–Dec 2026, and
    // this formula agrees on all six). That row isn't just waste: the grid
    // splits the same height, so every cell loses ~17% and events that would
    // have fit get silently rolled into 「+N件」 — the exact failure this
    // project already has a bug-table entry for.
    const weeks = Math.ceil((TTX.tz.daysBetween(gridFrom, to).length) / 7);
    const gridTo = addDays(gridFrom, weeks * 7 - 1);

    const all = TTX.store.occurrences(gridFrom, gridTo, {
      mutedLabels: ui.mutedLabels,
      holidays: ui.holidays,
      query: ui.query,
    });
    const byDay = TTX.model.groupByDay(all, gridFrom, gridTo);

    const wrap = el('div', 'month');
    const head = el('div', 'm-head');
    for (let i = 0; i < 7; i++) {
      // The column index is not the weekday any more. Colour by the DAY —
      // `i === 0 ? 'sun'` would paint Monday red the moment the week starts on
      // Monday, which is the whole point of the setting.
      const dow = (weekStartDow() + i) % 7;
      head.appendChild(el('div', dow === 0 ? 'sun' : dow === 6 ? 'sat' : '', WEEKDAY_JA[dow]));
    }
    wrap.appendChild(head);

    const grid = el('div', 'm-grid');
    grid.style.setProperty('--weeks', String(weeks));
    const today = todayKey();
    // Count events, not day-slots. groupByDay repeats a span into every day it
    // covers, so summing the cells called a 12-day holiday twelve events — the
    // same double-counting the bars exist to stop, in the footer.
    const seen = new Set();
    for (const key of TTX.tz.daysBetween(from, to)) {
      for (const o of byDay[key] || []) seen.add(o.uuid + '@' + o.start);
    }
    const count = seen.size;

    const allDays = TTX.tz.daysBetween(gridFrom, gridTo);
    for (let w = 0; w < allDays.length / 7; w++) {
      const days = allDays.slice(w * 7, w * 7 + 7);
      const { bars, lanes } = laneWeek(days, all);
      const week = el('div', 'm-week');
      week.style.setProperty('--lanes', lanes);

      for (const key of days) {
      const dow = weekdayOf(key);
      const inMonth = monthOf(key) === monthOf(ui.cursor);
      const cell = el('div', 'm-cell'
        + (inMonth ? '' : ' outside')
        + (key === today ? ' today' : '')
        + (dow === 0 ? ' sun' : dow === 6 ? ' sat' : ''));
      cell.appendChild(el('div', 'm-num', String(+key.slice(8))));

      // Spanning events are drawn once, by the week, not once per day.
      const list = (byDay[key] || []).filter((o) => !o.multiDay);

      const evs = el('div', 'm-evs');
      // If it doesn't all fit, give up one slot so the "+N" line has a home.
      const cap = capFor(lanes);
      const shown = list.length > cap ? list.slice(0, Math.max(0, cap - 1)) : list;
      for (const o of shown) {
        const c = railColor(o);
        const chip = el('button', 'm-ev ' + (o.allDay || o.holiday ? 'chip' : 'dotted'));
        if (o.allDay || o.holiday) {
          fill(chip, o);
        } else {
          const dot = el('span', 'm-dot');
          dot.style.background = c;
          chip.appendChild(dot);
          chip.appendChild(el('span', 'm-t', clock(o.startTime)));
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
      week.appendChild(cell);
      }

      // The bars go over the cells, so a span reads as one object rather than
      // as a chip that happens to be repeated seven times.
      if (bars.length) {
        const layer = el('div', 'm-bars');
        for (const { o, lane, col, span, openStart, openEnd } of bars) {
          const b = el('button', 'm-bar'
            + (openStart ? ' open-s' : '') + (openEnd ? ' open-e' : ''));
          b.style.gridColumn = `${col + 1} / span ${span}`;
          b.style.gridRow = String(lane + 1);
          fill(b, o);
          const t = el('span', 'm-ti', o.title);
          b.appendChild(t);
          b.title = o.days.length > 1 ? `${o.title}（${o.days.length}日間）` : o.title;
          b.onclick = (e) => { e.stopPropagation(); openDetail(o, b); };
          layer.appendChild(b);
        }
        week.appendChild(layer);
      }
      grid.appendChild(week);
    }
    wrap.appendChild(grid);
    ui.status = `${count}件の予定`;
    return swipeNav(wrap);
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
          const c = el('button', 'w-ad', o.title);
          fill(c, o);
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
      // The rail followed nothing — it wrote 24-hour whatever the account said.
      if (h) l.textContent = TTX.tz.hourLabel(h, TTX.store.state.setting?.military_time !== false);
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
        const box = el('button', 'w-ev');
        box.style.top = (startMin / 60) * HOUR_H + 'px';
        box.style.height = ((endMin - startMin) / 60) * HOUR_H - 2 + 'px';
        box.style.left = `calc(${(o._col / o._cols) * 100}% + 1px)`;
        box.style.width = `calc(${(1 / o._cols) * 100}% - 3px)`;
        fill(box, o);
        box.append(el('div', 'w-ev-t', clock(o.startTime)), el('div', 'w-ev-n', o.title));
        box.title = `${clock(o.startTime)}〜${clock(o.endTime)} ${o.title}`;
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

    ui.status = `${list.length}件の予定`;
    requestAnimationFrame(() => {
      // Open on the working day rather than at midnight.
      scroll.scrollTop = 7 * HOUR_H;

      /* The header does not scroll and the body does, so the body loses the
       * scrollbar's width and their seven columns stop lining up: measured, 1px
       * out at 月曜 and 10px by 日曜 — enough that the day you are reading is
       * over the wrong column of the grid.
       *
       * Measured, not assumed: it is 11px here and 0 wherever the platform
       * draws scrollbars as an overlay, so hardcoding either number is wrong
       * somewhere. .w-allday reserves the same width via scrollbar-gutter, so
       * all three grids agree whether or not it has anything in it. */
      wrap.style.setProperty('--sbw', (scroll.offsetWidth - scroll.clientWidth) + 'px');
    });
    return swipeNav(wrap);
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
    const chip = $('.m-ev');
    const week = $('.m-week');
    const evs = week?.querySelector('.m-evs');
    if (!chip || !evs) return;

    const rowH = chip.getBoundingClientRect().height + 1;    // + flex gap
    const bar = $('.m-bar');
    // Measured, not assumed — same reason as rowH. A guessed lane height is
    // the same class of mistake as the guessed row height that let cells
    // overflow in the first place.
    const laneH = bar ? bar.getBoundingClientRect().height + 1 : (ui.laneH || 16);
    // The height a cell would give chips if its week spent nothing on bars.
    // Any week can answer that, since we know what it IS spending.
    const lanes = +week.style.getPropertyValue('--lanes') || 0;
    const cellH = evs.clientHeight + lanes * laneH;
    if (rowH < 4 || cellH < 4) return;

    if (rowH === ui.rowH && cellH === ui.cellH && laneH === ui.laneH) return;
    ui.rowH = rowH;
    ui.cellH = cellH;
    ui.laneH = laneH;
    render();
  }

  /**
   * How many chips fit in a cell of a week that spends `lanes` rows on bars.
   *
   * There used to be one cap for the whole grid, measured off whichever cell
   * was first in the DOM. That was fine while every cell was the same height.
   * Multi-day bars made the height depend on the WEEK — a week with four lanes
   * has 22px for chips where an empty one has 90px — so the single cap
   * overfilled the busy weeks and pushed their "+N" line 62px below the cell,
   * which is exactly the silent clipping the measuring exists to prevent.
   */
  const capFor = (lanes) => Math.max(0, Math.floor(
    ((ui.cellH || 90) - lanes * (ui.laneH || 16) + 1) / (ui.rowH || 16)
  ));

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
    // Who wrote it. On a shared calendar this is the difference between "a
    // dentist appointment exists" and "my wife booked me a dentist
    // appointment" — and the second one is why the calendar is shared.
    if (o.authorName) {
      const by = el('div', 'd-by');
      const av = el('span', 'acct-av sm');
      av.textContent = o.authorName.slice(0, 1);
      av.style.background = acctColor(String(o.authorId));
      by.append(av, el('span', null, `${o.authorName} が追加`));
      head.appendChild(by);
    }
    card.appendChild(head);

    const rows = [];
    const jp = (k) => `${+k.slice(5, 7)}月${+k.slice(8)}日(${WEEKDAY_JA[weekdayOf(k)]})`;
    let when;
    if (o.holiday) {
      when = `${jp(o.startKey)} ・ ${o.workday ? '暦・行事' : '祝日'}`;
    } else if (o.multiDay) {
      when = o.allDay
        ? `${jp(o.startKey)} 〜 ${jp(o.endKey)} ・ 終日 (${o.days.length}日間)`
        : `${jp(o.startKey)} ${clock(o.startTime)} 〜 ${jp(o.endKey)} ${clock(o.endTime)}`;
    } else {
      when = o.allDay
        ? `${jp(o.startKey)} ・ 終日`
        : `${jp(o.startKey)} ${clock(o.startTime)} 〜 ${clock(o.endTime)}`;
    }
    // Icon AND value, no key column. "🕐 日時 7月21日 10:30" says "日時" twice:
    // once in the glyph and once in the word, to an audience that can read the
    // date. TimeTree's own detail panel does icon+value for the same reason.
    rows.push(['clock', when]);

    if (o.location) rows.push(['pin', o.location]);
    // A pin the phone app dropped, which TimeTree's own web app never shows.
    // Opening it needs no map switch and no tiles: it's a click, and the URL
    // is built host-side.
    if (Number.isFinite(o.lat) && Number.isFinite(o.lon)) {
      rows.push(['map', {
        text: '地図で開く',
        act: () => window.host.map.open(o.lat, o.lon),
      }]);
    }
    if (o.url) rows.push(['link', o.url]);
    const lb = TTX.store.labelOf(o.calendarId, o.labelId);
    if (lb) rows.push(['tag', TTX.api.labelName(lb)]);
    // Naming the calendar is only information when there's more than one.
    if (o.calendarName && TTX.store.state.enabled.size > 1) {
      rows.push(['calendar', o.calendarName]);
    }

    const members = TTX.store.state.members.get(o.calendarId);
    if (members && o.attendees?.length) {
      const names = o.attendees.map((id) => members.get(id)?.name).filter(Boolean);
      if (names.length) rows.push(['users', names.join('、')]);
    }
    const alerts = TTX.store.rawEvent(o.calendarId, o.uuid)?.alerts;
    if (alerts?.length) {
      rows.push(['bell', alerts.slice().sort((a, b) => a - b)
        .map((m) => TTX.api.alertLabel(m, o.allDay)).join('、')]);
    }
    if (o.recurring) rows.push(['repeat', repeatText(o)]);
    if (o.isException) rows.push(['pencil', 'この回だけ変更されています']);
    if (o.birthday) rows.push(['cake', '誕生日']);

    for (const [ic, v] of rows) {
      const act = typeof v === 'object';
      const r = el(act ? 'button' : 'div', 'd-row' + (act ? ' act' : ''));
      const box = el('span', 'd-ic');
      box.appendChild(TTX.icon(ic, 14));
      r.append(box, el('span', 'd-v', act ? v.text : v));
      if (act) r.onclick = v.act;
      card.appendChild(r);
    }
    if (o.checklist?.length) {
      const done = o.checklist.filter((i) => i.checked).length;
      card.appendChild(el('div', 'd-k', `リスト ${done}/${o.checklist.length}`));
      const list = el('div', 'd-cl');
      for (const i of o.checklist) {
        const r = el('div', 'd-cl-i' + (i.checked ? ' on' : ''));
        const b = el('span', 'd-cl-b');
        b.appendChild(TTX.icon(i.checked ? 'square-check' : 'square', 13));
        r.append(b, el('span', null, i.title));
        list.appendChild(r);
      }
      card.appendChild(list);
    }
    if (o.note) {
      const n = el('div', 'd-note', o.note);
      card.appendChild(n);
    }

    // The comments. This is the half of TimeTree that isn't a calendar: an
    // event says 「10:30 歯医者」, and the thread under it says 「予約変えた」
    // 「ありがとう」. A client that shows only the first half is a viewer.
    //
    // Holidays and birthdays are derived rows, not events on a calendar —
    // there is nothing on the server to hang a comment on.
    if (canEdit(o)) card.appendChild(commentFeed(o));

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
    //
    // A function, not a straight line of code, because the comment feed lands
    // AFTER this runs — an async fetch can't be measured before it answers.
    // Placing once against the pre-feed height put a card that later grew by
    // 200px straight through the bottom of the window.
    const w = 320;
    const place = () => {
      const a = anchor.getBoundingClientRect();
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
    };
    place();
    ui.detailPlace = place;

    requestAnimationFrame(() => card.classList.add('in'));
    scrim.onclick = (e) => { if (e.target === scrim) closeDetail(); };
    ui.detail = scrim;
    ui.detailRelease = dialog(card, { label: o.title });
    // Focus has to ENTER the card, or its 編集/削除 are unreachable by keyboard
    // even though they are real buttons. It lands on the card ITSELF, not on
    // the first control: since the card grew a comment box, "first control" is
    // the textarea, and opening an event would announce 「コメントを書く」 to a
    // screen reader and plant a cursor as if you'd come here to type. The card
    // is the dialog and its label is the title — announce that, and let Tab go
    // looking.
    card.tabIndex = -1;
    card.focus();
  }

  function closeDetail() {
    ui.detailRelease?.();
    ui.detailRelease = null;
    ui.detail?.remove();
    ui.detail = null;
    ui.detailPlace = null;
  }

  /**
   * When a comment was written. A thread is read newest-last and mostly in one
   * sitting, so the useful precision is "today at 10:30" — the year is noise
   * and 「3日前」 is worse than a date you can compare to the event's own.
   */
  function stampText(ms) {
    // Through TTX.tz, like every other clock in this app — never
    // `new Date(ms).getHours()`, which reads the MACHINE's timezone. The app
    // pins everything to Asia/Tokyo, so on a machine set to anything else the
    // comment clock would disagree with the event times right above it, and
    // 「今日」 (resolved in JST) could contradict the hour printed beside it.
    // Getting this exact confusion wrong by 9 hours is the oldest bug in this
    // codebase; see HANDOFF §3 alerts.
    const key = TTX.tz.ymd(ms, TZ);
    const time = TTX.tz.hm(ms, TZ);
    if (TTX.tz.ymd(Date.now(), TZ) === key) return time;
    return `${+key.slice(5, 7)}/${+key.slice(8)} ${time}`;
  }

  /**
   * An event's comment thread, loaded lazily.
   *
   * Lazily because it has to be: a comment doesn't touch the event object (not
   * even `updated_at`) and there is no calendar-wide activity feed, so nothing
   * in the synced data can tell us a thread exists. Asking per event, when the
   * card opens, is the only way — and it's what the real app does too.
   */
  function commentFeed(o) {
    const wrap = el('div', 'd-cmt');
    const feed = el('div', 'd-feed');
    const status = el('div', 'd-fmsg', 'コメントを読み込んでいます…');
    feed.appendChild(status);
    wrap.appendChild(feed);

    const me = TTX.store.state.me?.id ?? null;
    const members = TTX.store.state.members.get(o.calendarId);

    const row = (a) => {
      if (!a.comment) {
        // The system entries: 「日時を変更しました」. Quieter than what people
        // said, because nobody opened this card to read them — but they're the
        // difference between "the time is wrong" and "someone moved it".
        const r = el('div', 'd-fi sys');
        r.append(
          el('span', null, a.authorName ? `${a.authorName}が${a.text}` : a.text),
          el('span', 'd-ft', stampText(a.at))
        );
        return r;
      }
      const r = el('div', 'd-fi');
      // paint() throws every row away and builds new ones, so "focus the thing
      // you were just on" needs a name that survives that.
      r.dataset.id = a.id;
      const av = el('span', 'acct-av sm');
      av.textContent = (a.authorName || '?').slice(0, 1);
      av.style.background = acctColor(String(a.authorId));
      const b = el('div', 'd-fb');
      const who = el('div', 'd-fw');
      who.append(el('span', 'd-fn', a.authorName || '(名前なし)'), el('span', 'd-ft', stampText(a.at)));
      // Chat apps all say this, and for the same reason: without it the text
      // silently stops matching what somebody replied to.
      if (a.edited) who.appendChild(el('span', 'd-ft', '編集済み'));
      b.append(who, el('div', 'd-fx', a.text));
      r.append(av, b);
      // Your own comments can be fixed or taken back. The server decides this
      // too — these only appear where it would say yes.
      if (a.mine) r.appendChild(ownActions(a, r, b));
      return r;
    };

    /**
     * 編集 / 削除 for a comment you wrote.
     *
     * Revealed on hover AND focus-within, never hover alone: they stay in the
     * DOM and stay focusable, so Tab reaches them and they show up when it
     * does. Hover-only would hide them from the keyboard entirely.
     */
    function ownActions(a, rowNode, body) {
      const acts = el('div', 'd-fa');
      const edit = iconBtn('pencil', 'このコメントを編集', () => beginEdit(a, rowNode, body), 'd-fab');
      const del = iconBtn('trash', 'このコメントを削除', () => askDelete(a, rowNode), 'd-fab');
      acts.append(edit, del);
      return acts;
    }

    function beginEdit(a, rowNode, body) {
      const fx = body.querySelector('.d-fx');
      if (!fx || rowNode.querySelector('.d-fe')) return;
      const box = el('div', 'd-fe');
      const ta = el('textarea', 'd-cin');
      ta.value = a.text;
      ta.rows = 1;
      ta.setAttribute('aria-label', 'コメントを編集');
      const acts = el('div', 'd-fe-acts');
      const save = el('button', 'btn primary', '保存');
      const cancel = el('button', 'btn', 'キャンセル');
      acts.append(cancel, save);
      box.append(ta, acts);
      fx.replaceWith(box);
      const grow = () => { ta.style.height = 'auto'; ta.style.height = Math.min(ta.scrollHeight, 88) + 'px'; };
      grow();
      ta.focus();
      ta.setSelectionRange(ta.value.length, ta.value.length);
      ui.detailPlace?.();

      const stop = () => { box.replaceWith(fx); ui.detailPlace?.(); };
      cancel.onclick = stop;
      const commit = async () => {
        const text = ta.value.trim();
        // Empty is not an edit. Deleting is a different button, on purpose —
        // clearing the box and saving should not silently destroy the comment.
        if (!text) { toast('コメントを空にはできません（消すなら削除）'); ta.focus(); return; }
        if (text === a.text) return stop();
        save.disabled = true; cancel.disabled = true; ta.disabled = true;
        try {
          const updated = await TTX.api.editComment(o.calendarId, o.uuid, a.id, text);
          replaceRaw(a.id, updated);
        } catch (e) {
          save.disabled = false; cancel.disabled = false; ta.disabled = false;
          toast('コメントを編集できませんでした');
          console.error(e);
        }
      };
      save.onclick = commit;
      ta.oninput = grow;
      ta.onkeydown = (e) => {
        if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); commit(); }
        // Escape backs out of the edit, not out of the whole card.
        if (e.key === 'Escape') { e.stopPropagation(); stop(); }
      };
    }

    /**
     * Deleting asks first, inline. A second dialog stacked on this one would be
     * a modal inside a modal for a one-line comment; and the card would have to
     * close to make room, which is exactly where you don't want to be sent.
     */
    function askDelete(a, rowNode) {
      if (rowNode.querySelector('.d-fd')) return;
      const bar = el('div', 'd-fd');
      const yes = el('button', 'btn danger', '削除');
      const no = el('button', 'btn', 'やめる');
      bar.append(el('span', 'd-fd-q', 'このコメントを削除しますか？'), no, yes);
      rowNode.appendChild(bar);
      ui.detailPlace?.();
      no.focus();
      const close = () => { bar.remove(); ui.detailPlace?.(); };
      no.onclick = close;
      bar.onkeydown = (e) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } };
      yes.onclick = async () => {
        yes.disabled = true; no.disabled = true;
        try {
          await TTX.api.deleteComment(o.calendarId, o.uuid, a.id);
          dropRaw(a.id);
        } catch (e) {
          yes.disabled = false; no.disabled = false;
          toast('コメントを削除できませんでした');
          console.error(e);
        }
      };
    }

    /* The feed is rebuilt from `raw`, so an edit or a delete has to land there
     * and not just in the DOM — otherwise the next paint puts it back. */
    const replaceRaw = (id, updated) => {
      raw = raw.map((x) => (x.id === id ? (updated?.id ? updated : x) : x));
      // Back to the comment you just fixed, on its 編集 button — where you were.
      paint(raw, id);
    };
    const dropRaw = (id) => {
      raw = raw.filter((x) => x.id !== id);
      // The row is gone, so this deliberately misses and lands on the compose
      // box: the one place that still makes sense once your comment isn't there.
      paint(raw, id);
    };

    /**
     * `focusId` is where to put focus once the rows are rebuilt. Every row the
     * user was holding is destroyed here, so without it focus lands on <body>:
     * outside the dialog, with nothing announced, and the next Tab restarts
     * from the top of the card instead of where you were. Measured — it's not
     * a theory.
     */
    const paint = (list, focusId) => {
      feed.textContent = '';
      const items = TTX.model.normalizeActivities(list, { membersById: members }, me);
      if (!items.some((i) => i.comment)) {
        feed.appendChild(el('div', 'd-fmsg', 'まだコメントはありません'));
      }
      for (const a of items) feed.appendChild(row(a));
      // The newest comment is the one you opened this for.
      feed.scrollTop = feed.scrollHeight;
      // The card was placed against its pre-feed height; it just grew.
      ui.detailPlace?.();
      if (focusId) {
        const back = feed.querySelector(`.d-fi[data-id="${focusId}"] .d-fab`);
        // The row may be gone (deleted, or someone else's edit landed first).
        // The box you'd type in next is the honest fallback — never <body>.
        // Read from the DOM rather than closing over the textarea: that is
        // declared further down, and a future load() that painted synchronously
        // would turn this line into a ReferenceError.
        (back || wrap.querySelector('.d-cbox .d-cin'))?.focus();
      }
    };

    let raw = [];
    const load = async () => {
      try {
        raw = await TTX.api.activities(o.calendarId, o.uuid);
        paint(raw);
      } catch {
        feed.textContent = '';
        const err = el('div', 'd-fmsg', 'コメントを読み込めませんでした');
        const again = el('button', 'lnk', '再試行');
        again.onclick = () => { feed.textContent = ''; feed.appendChild(status); load(); };
        err.appendChild(again);
        feed.appendChild(err);
        ui.detailPlace?.();
      }
    };
    load();

    // --- compose ---
    const box = el('div', 'd-cbox');
    const ta = el('textarea', 'd-cin');
    ta.placeholder = 'コメントを書く';
    ta.rows = 1;
    ta.setAttribute('aria-label', 'コメントを書く');
    const send = el('button', 'd-csend');
    send.appendChild(TTX.icon('send', 14));
    send.title = '送信';
    send.setAttribute('aria-label', '送信');
    send.disabled = true;

    const grow = () => {
      ta.style.height = 'auto';
      ta.style.height = Math.min(ta.scrollHeight, 88) + 'px';
    };
    ta.oninput = () => { send.disabled = !ta.value.trim(); grow(); };

    let sending = false;
    const post = async () => {
      const text = ta.value.trim();
      if (!text || sending) return;
      sending = true;
      send.disabled = true;
      ta.disabled = true;
      try {
        const a = await TTX.api.postComment(o.calendarId, o.uuid, text);
        // Trust the server's record over the text we typed — it carries the id
        // and the timestamp, and it's what a reload will show.
        raw = raw.concat(a ? [a] : []);
        paint(raw);
        ta.value = '';
        grow();
      } catch (e) {
        toast('コメントを送信できませんでした');
        console.error(e);
      } finally {
        sending = false;
        ta.disabled = false;
        send.disabled = !ta.value.trim();
        ta.focus();
      }
    };
    send.onclick = post;
    // Enter sends, Shift+Enter breaks the line — what the real app does, and
    // what every other box shaped like this one does.
    ta.onkeydown = (e) => {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); post(); }
      // The card is a modal: without this, Escape in the box closes the whole
      // thing and throws away what you were typing.
      if (e.key === 'Escape' && ta.value.trim()) { e.stopPropagation(); ta.value = ''; grow(); send.disabled = true; }
    };

    box.append(ta, send);
    wrap.appendChild(box);
    return wrap;
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
      const release = dialog(card, { label: title });

      const done = (v) => {
        document.removeEventListener('keydown', onKey, true);
        release();
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
    const heading = `繰り返しの予定を${verb}`;
    return new Promise((resolve) => {
      const scrim = el('div', 'scrim cf-scrim');
      const card = el('div', 'confirm');
      card.append(
        el('div', 'cf-t', heading),
        el('div', 'cf-b', 'どの範囲に適用しますか。')
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
      const release = dialog(card, { label: heading });

      const done = (v) => {
        document.removeEventListener('keydown', onKey, true);
        release();
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
      lat: null,
      lon: null,
      note: '',
      labelId: labels[0]?.id ?? 1,
      repeat: { freq: '', byday: [], until: '', rest: {} },
      url: '',
      checklist: [],
      // TimeTree's own form puts a reminder a day ahead on EVERY new event —
      // measured by watching what its web app actually POSTs: [1440] for a
      // timed one and [900] for an all-day one (its own ladder, HANDOFF §3).
      // We sent [], so an event made here never reminded anybody, and the
      // person who made it had no way to find that out until they missed it.
      //
      // Worth saying how this got missed for so long: our form's default was
      // compared against our form. Only opening TimeTree's own web app and
      // reading the request settled it.
      alerts: [allDay ? TTX.api.alldayAlert(1) : 1440],
      // Same reasoning — TimeTree's form assigns the event to you by default,
      // and the user's phone renders that avatar. Match it rather than quietly
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
      lat: raw.location_lat != null ? Number(raw.location_lat) : null,
      lon: raw.location_lon != null ? Number(raw.location_lon) : null,
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

  // `tf edit` reads and writes an event through these two, the same as the form.
  // They carry the all-day dance — stored at UTC midnight, with latent
  // wall-clock times so toggling has somewhere to land — and the rule that PUT
  // is a merge, not a replace. A second copy of that in cli-host.js would
  // drift, and this particular drift moves a family event to the wrong time
  // without telling anybody.
  TTX.cli._fields = fieldsFromRaw;
  TTX.cli._patch = diffPatch;
  // `tf edit --at "7/21 10:00"` on an all-day event makes it timed, and its
  // reminders were sitting on the all-day ladder. Same problem the form's
  // all-day toggle has, so: same answer.
  TTX.cli._remapAlerts = remapAlerts;

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
    ui.formRelease?.();
    ui.formRelease = null;
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
    const headId = 'f-h-' + Math.random().toString(36).slice(2, 8);
    const headEl = el('div', 'f-h-t', editing ? '予定を編集' : '新しい予定');
    headEl.id = headId;
    head.appendChild(headEl);
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
    const labelNameEl = el('span', 'f-lb-n');
    labelRow.append(swatches, labelNameEl);
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
        b.title = TTX.api.labelName(lb) || `ラベル ${lb.id}`;
        b.onclick = () => { f.labelId = lb.id; paintLabels(); };
        swatches.appendChild(b);
      }
      const cur = labels.find((l) => l.id === f.labelId);
      labelNameEl.textContent = TTX.api.labelName(cur);
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
        const x = el('button', 'f-chip-x');
        x.appendChild(TTX.icon('x', 11));
        x.title = '削除';
        x.setAttribute('aria-label', TTX.api.alertLabel(m, f.allDay) + ' を削除');
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
    // Typing a new place by hand means the old pin is no longer where this is.
    loc.oninput = () => {
      if (loc.value !== f.location) { f.lat = null; f.lon = null; paintPin(); }
      f.location = loc.value;
    };
    locRow.appendChild(loc);
    const pinBtn = el('button', 'f-pin');
    pinBtn.appendChild(TTX.icon('pin', 13));
    pinBtn.append(el('span', 'f-pin-t', ''));
    pinBtn.title = '地図で場所を選ぶ';
    pinBtn.onclick = () => openMapPicker(f, ({ location, lat, lon }) => {
      f.location = location;
      f.lat = lat;
      f.lon = lon;
      loc.value = location;
      paintPin();
    });
    locRow.appendChild(pinBtn);
    body.appendChild(locRow);

    function paintPin() {
      const pinned = Number.isFinite(f.lat) && Number.isFinite(f.lon);
      pinBtn.classList.toggle('on', pinned);
      pinBtn.querySelector('.f-pin-t').textContent = pinned ? 'ピン済み' : '地図';
      pinBtn.setAttribute('aria-label', pinned ? '地図のピンを変更' : '地図で場所を選ぶ');
    }
    paintPin();

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
        const cb = el('button', 'f-cl-c' + (it.checked ? ' on' : ''));
        if (it.checked) cb.appendChild(TTX.icon('check', 11));
        cb.setAttribute('role', 'checkbox');
        cb.setAttribute('aria-checked', String(!!it.checked));
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
        const x = el('button', 'f-cl-x');
        x.appendChild(TTX.icon('x', 11));
        x.title = '削除';
        x.setAttribute('aria-label', '項目を削除');
        x.onclick = () => { f.checklist.splice(i, 1); paintChecklist(); };
        row.append(cb, inp, x);
        clBox.appendChild(row);
      });
      const add = el('button', 'f-cl-add');
      add.append(TTX.icon('plus', 12), el('span', null, '項目を追加'));
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
    ui.formRelease = dialog(card, { labelledBy: headId });

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
      lat: f.lat,
      lon: f.lon,
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

  // --- reminders --------------------------------------------------------
  //
  // TimeTree's servers already push these to the user's phone. This client can
  // only fire while it's open, so the honest promise is "while I'm running",
  // not "always" — but a calendar you leave open on a desktop is exactly where
  // you want to be told about the next thing.
  //
  // A ticker rather than a timer per alert: setTimeout doesn't survive the
  // machine sleeping (it fires late, all at once, on wake), and re-arming a
  // pile of timers after every sync is more moving parts than a scan of an
  // in-memory list that already costs nothing.

  const TICK = 30000;
  /** Missed while closed is missed. Don't open the laptop to yesterday's alarms. */
  const GRACE = 5 * 60 * 1000;
  const FIRED_KEY = 'ttc.fired';

  function loadFired() {
    try {
      const j = JSON.parse(localStorage.getItem(FIRED_KEY) || '{}');
      // Drop anything older than the grace window — it can never fire again.
      const cutoff = Date.now() - DAY;
      return new Map(Object.entries(j).filter(([, at]) => at > cutoff));
    } catch {
      return new Map();
    }
  }

  function saveFired(map) {
    try {
      localStorage.setItem(FIRED_KEY, JSON.stringify(Object.fromEntries(map)));
    } catch { /* non-fatal */ }
  }

  /**
   * Reminders that came due since the last look. A recurring master's uuid is
   * the same for every occurrence, so the key has to name the instant too.
   */
  function dueAlerts(now) {
    const out = [];
    if (!TTX.store.state.ready) return out;
    const from = ymd(now - 2 * DAY, TZ);
    const to = ymd(now + 2 * DAY, TZ);
    // Muted labels are the only signal we have that the user doesn't want to
    // hear about a kind of event, so respect it. Their phone still notifies —
    // this only silences the client they muted it in.
    const occs = TTX.store.occurrences(from, to, { mutedLabels: ui.mutedLabels });
    for (const o of occs) {
      if (o.holiday || !o.calendarId) continue;
      const raw = TTX.store.rawEvent(o.calendarId, o.uuid);
      for (const m of raw?.alerts || []) {
        const at = TTX.model.alertAt(o, m, TZ);
        if (at <= now && at > now - GRACE) out.push({ o, m, at });
      }
    }
    return out;
  }

  async function checkAlerts() {
    if (!ui.notify || !window.host?.notify) return;
    const now = Date.now();
    let dirty = false;
    for (const { o, m, at } of dueAlerts(now)) {
      const key = `${o.uuid}@${o.start}#${m}`;
      if (ui.fired.has(key)) continue;
      ui.fired.set(key, at);
      dirty = true;
      const when = o.allDay ? '終日' : `${clock(o.startTime)}〜${clock(o.endTime)}`;
      const body = [TTX.api.alertLabel(m, o.allDay), when, o.location]
        .filter(Boolean).join(' · ');
      await window.host.notify.show({ title: o.title, body, key: o.startKey })
        .catch(() => {});
    }
    if (dirty) saveFired(ui.fired);
  }

  function startAlerts() {
    ui.fired = loadFired();
    window.host.notify.onClicked((key) => { if (key) jumpTo(key, 'agenda'); });
    checkAlerts();
    setInterval(checkAlerts, TICK);
  }

  /**
   * Auto-start isn't a preference we store — the OS owns it, and it can be
   * turned off from Windows' own settings behind our back. Read it back from
   * the source rather than remembering what we last asked for.
   */
  async function setAutoStart(on) {
    ui.autoStart = await window.host.autoStart.set(on);
    toast(ui.autoStart ? 'Windows 起動時に開始します' : '自動起動をやめました');
  }

  // --- map --------------------------------------------------------------
  //
  // TimeTree's phone app can pin a place; its web app can't — the location
  // there is a text box, and location_lat/location_lon just sit in the API
  // unread. So this is a thing a third-party client can actually add.
  //
  // No map library. A slippy map is a grid of 256px images at
  // z/x/y plus some arithmetic, and the whole of that arithmetic is the two
  // functions below. Pulling in Leaflet would mean either widening the CSP to
  // a CDN or vendoring 140KB to draw nine <img>s.

  const TILE = 256;

  /** WGS84 -> Web Mercator tile space, in fractional tiles at zoom z. */
  function toTile(lat, lon, z) {
    const n = 2 ** z;
    const rad = (lat * Math.PI) / 180;
    return {
      x: ((lon + 180) / 360) * n,
      y: ((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * n,
    };
  }

  /** And back. */
  function fromTile(x, y, z) {
    const n = 2 ** z;
    const k = Math.PI - (2 * Math.PI * y) / n;
    return {
      lat: (180 / Math.PI) * Math.atan(0.5 * (Math.exp(k) - Math.exp(-k))),
      lon: (x / n) * 360 - 180,
    };
  }

  /**
   * A pannable map centred on `state`, drawn into `box`.
   *
   * Tiles come from the host as data: URIs — the renderer has no route to
   * OpenStreetMap, by design (see client/main.js).
   */
  function mapView(box, state, onMove) {
    let dragging = null;

    async function paintTiles() {
      const w = box.clientWidth;
      const h = box.clientHeight;
      if (!w || !h) return;
      const c = toTile(state.lat, state.lon, state.z);
      // Which tile sits under the top-left corner, and by how much is it off.
      const left = c.x - w / 2 / TILE;
      const top = c.y - h / 2 / TILE;
      const x0 = Math.floor(left);
      const y0 = Math.floor(top);
      const cols = Math.ceil(w / TILE) + 1;
      const rows = Math.ceil(h / TILE) + 1;
      const n = 2 ** state.z;

      const grid = el('div', 'mp-tiles');
      grid.style.transform =
        `translate(${Math.round((x0 - left) * TILE)}px, ${Math.round((y0 - top) * TILE)}px)`;
      grid.style.gridTemplateColumns = `repeat(${cols}, ${TILE}px)`;

      const want = [];
      for (let dy = 0; dy < rows; dy++) {
        for (let dx = 0; dx < cols; dx++) {
          const img = el('img', 'mp-t');
          img.width = TILE;
          img.height = TILE;
          img.alt = '';
          grid.appendChild(img);
          const tx = ((x0 + dx) % n + n) % n;   // wrap round the dateline
          const ty = y0 + dy;
          if (ty < 0 || ty >= n) continue;      // no tiles past the poles
          want.push([img, state.z, tx, ty]);
        }
      }
      box.querySelector('.mp-tiles')?.remove();
      box.prepend(grid);
      await Promise.all(want.map(async ([img, z, x, y]) => {
        try { img.src = await window.host.map.tile(z, x, y); } catch { /* blank */ }
      }));
    }

    box.onpointerdown = (e) => {
      if (e.button !== 0) return;
      dragging = { x: e.clientX, y: e.clientY, moved: 0 };
      box.setPointerCapture(e.pointerId);
      box.classList.add('grabbing');
    };
    box.onpointermove = (e) => {
      if (!dragging) return;
      const dx = e.clientX - dragging.x;
      const dy = e.clientY - dragging.y;
      dragging.moved += Math.abs(dx) + Math.abs(dy);
      dragging.x = e.clientX;
      dragging.y = e.clientY;
      const c = toTile(state.lat, state.lon, state.z);
      const p = fromTile(c.x - dx / TILE, c.y - dy / TILE, state.z);
      state.lat = Math.max(-85, Math.min(85, p.lat));
      state.lon = ((p.lon + 540) % 360) - 180;
      paintTiles();
      onMove?.();
    };
    const end = (e) => {
      if (!dragging) return;
      box.releasePointerCapture(e.pointerId);
      box.classList.remove('grabbing');
      dragging = null;
    };
    box.onpointerup = end;
    box.onpointercancel = end;
    box.onwheel = (e) => {
      e.preventDefault();
      const z = Math.max(2, Math.min(18, state.z + (e.deltaY < 0 ? 1 : -1)));
      if (z === state.z) return;
      state.z = z;
      paintTiles();
      onMove?.();
    };

    return paintTiles;
  }

  /**
   * Ask before the first request. Until the user says yes, this app has spoken
   * to exactly one host in its life, and that's a property worth not spending
   * silently on their behalf.
   */
  async function ensureMaps() {
    if (ui.maps) return true;
    const yes = await confirmDialog({
      title: '地図を有効にしますか',
      body: 'このアプリはこれまで TimeTree としか通信していません。地図を使うと、'
        + '表示する範囲を OpenStreetMap に問い合わせます（予定の内容は送りません）。'
        + 'あとから設定で切り替えられます。',
      ok: '有効にする',
    });
    if (!yes) return false;
    ui.maps = true;
    await window.host.map.setEnabled(true);
    savePrefs();
    return true;
  }

  /** Pick a place: search for it, or drag the map under the pin. */
  async function openMapPicker(f, onPick) {
    if (!(await ensureMaps())) return;

    const scrim = el('div', 'scrim mp-scrim');
    const card = el('div', 'mp-card');
    const head = el('div', 'f-head');
    const hid = 'mp-h';
    const h = el('div', 'f-h-t', '場所を選ぶ');
    h.id = hid;
    head.appendChild(h);
    card.appendChild(head);

    const bar = el('div', 'mp-bar');
    const q = el('input', 'f-text');
    q.placeholder = '駅名・住所・店名で検索';
    q.value = f.location || '';
    bar.appendChild(q);
    card.appendChild(bar);

    const results = el('div', 'mp-results');
    card.appendChild(results);

    const box = el('div', 'mp-box');
    // The pin is fixed at the centre and the map moves under it — you're
    // always pinning the middle, so there's no "did I click precisely" step.
    const pin = el('div', 'mp-pin');
    pin.appendChild(TTX.icon('pin', 28));
    box.appendChild(pin);
    card.appendChild(box);

    const foot = el('div', 'f-foot');
    const coord = el('div', 'mp-coord');
    foot.appendChild(coord);
    foot.appendChild(el('div', 'tb-spacer'));
    const cancel = el('button', 'btn', 'キャンセル');
    const use = el('button', 'btn primary', 'この場所にする');
    foot.append(cancel, use);
    card.appendChild(foot);

    scrim.appendChild(card);
    document.body.appendChild(scrim);
    const release = dialog(card, { labelledBy: hid });
    ui.mapPicker = scrim;

    // Start where the event already is, else Tokyo — a world view would make
    // the first drag meaningless.
    const state = {
      lat: Number.isFinite(f.lat) ? f.lat : 35.681236,
      lon: Number.isFinite(f.lon) ? f.lon : 139.767125,
      z: Number.isFinite(f.lat) ? 16 : 12,
    };
    let name = f.location || '';
    const showCoord = () => { coord.textContent = `${state.lat.toFixed(5)}, ${state.lon.toFixed(5)}`; };
    const repaint = mapView(box, state, showCoord);
    showCoord();
    requestAnimationFrame(repaint);

    let timer;
    q.oninput = () => {
      name = q.value;
      clearTimeout(timer);
      timer = setTimeout(async () => {
        const term = q.value.trim();
        if (term.length < 2) { results.textContent = ''; return; }
        let list = [];
        try { list = await window.host.map.search(term); } catch { /* offline */ }
        results.textContent = '';
        for (const r of list) {
          const b = el('button', 'mp-r');
          b.append(el('span', 'mp-r-n', r.name), el('span', 'mp-r-a', r.address));
          b.onclick = () => {
            state.lat = r.lat;
            state.lon = r.lon;
            state.z = 17;
            name = r.name;
            q.value = r.name;
            results.textContent = '';
            showCoord();
            repaint();
          };
          results.appendChild(b);
        }
      }, 350);
    };
    q.onkeydown = (e) => {
      if (e.key === 'Enter') { e.preventDefault(); results.querySelector('.mp-r')?.click(); }
    };

    const close = () => {
      clearTimeout(timer);
      release();
      scrim.remove();
      ui.mapPicker = null;
    };
    cancel.onclick = close;
    use.onclick = () => {
      onPick({ location: name.trim(), lat: state.lat, lon: state.lon });
      close();
    };
    scrim.onclick = (e) => { if (e.target === scrim) close(); };
    card.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { e.preventDefault(); close(); }
    });
    q.focus();
  }

  // --- settings ---------------------------------------------------------
  //
  // TimeTree's web app technically has settings: click your avatar, then the
  // gear inside the popover that opens, and you get links to the privacy
  // policy. Everything that's actually a setting lives in the phone app. So
  // there's nothing to copy here, and a low bar to clear.
  //
  // One sheet, sections, no tabs. There are eleven things to set; a nav rail
  // for eleven things is furniture.

  function closeSettings() {
    ui.settingsRelease?.();
    ui.settingsRelease = null;
    ui.settings?.remove();
    ui.settings = null;
  }

  /** A labelled row. `control` is whatever does the work. */
  function setRow(label, sub, control) {
    const r = el('div', 'st-row');
    const box = el('div', 'st-box');
    box.appendChild(el('div', 'st-l', label));
    if (sub) box.appendChild(el('div', 'st-s', sub));
    r.append(box, control);
    return r;
  }

  function toggleBtn(on, onChange) {
    const b = el('button', 'sw' + (on ? ' on' : ''));
    b.appendChild(el('span', 'sw-k'));
    b.setAttribute('role', 'switch');
    b.setAttribute('aria-checked', String(on));
    b.onclick = () => onChange(!on);
    return b;
  }

  function openSettings() {
    if (ui.settings) return;
    closeDetail();
    closeMenus();

    const scrim = el('div', 'scrim st-scrim');
    const card = el('div', 'settings');
    ui.settings = scrim;

    const head = el('div', 'f-head');
    const hid = 'st-h';
    const h = el('div', 'f-h-t', '設定');
    h.id = hid;
    head.appendChild(h);
    card.appendChild(head);

    const body = el('div', 'st-body');
    card.appendChild(body);

    const section = (t) => { body.appendChild(el('div', 'st-sec', t)); };

    // --- appearance
    section('表示');
    const themeSel = el('select', 'f-sel');
    for (const m of ['system', 'light', 'dark']) {
      const o = el('option', null, THEME_LABEL[m]);
      o.value = m;
      if (m === ui.theme) o.selected = true;
      themeSel.appendChild(o);
    }
    themeSel.onchange = () => applyTheme(themeSel.value);
    body.appendChild(setRow('テーマ', null, themeSel));

    // This row edits TimeTree's OWN setting (`start_weekday`), so changing it
    // here changes it on the phone too. That is the point: it used to be a
    // local preference, which meant this window could — and did — draw a
    // Monday grid for someone whose TimeTree said Sunday.
    const wsSel = el('select', 'f-sel');
    for (const [v, label] of [[1, '月曜'], [0, '日曜']]) {
      const o = el('option', null, label);
      o.value = String(v);
      if (v === weekStartDow()) o.selected = true;
      wsSel.appendChild(o);
    }
    wsSel.onchange = async () => {
      // select.value is a STRING and start_weekday is compared numerically all
      // over the grid — this project has already lost an afternoon to exactly
      // that mismatch (see HANDOFF: select.value / Map のキー).
      const want = Number(wsSel.value) === 0 ? 0 : 1;
      const was = TTX.store.state.setting;
      wsSel.disabled = true;
      try {
        // A merge, so this touches nothing else on their account (measured).
        // Draw from the server's answer, not from what we sent: if it did
        // something other than what we asked, that is what everyone else sees.
        TTX.store.state.setting = await TTX.api.putSetting({ start_weekday: want });
        refresh('fade');
        toast(`週の始まりを${want === 0 ? '日曜' : '月曜'}にしました`);
      } catch (e) {
        TTX.store.state.setting = was;
        wsSel.value = String(weekStartDow());
        toast('週の始まりを変更できませんでした: ' + e.message);
      } finally {
        wsSel.disabled = false;
      }
    };
    body.appendChild(setRow('週の始まり', 'TimeTree の設定。スマホにも反映されます', wsSel));

    // Also TimeTree's (`military_time`). Its 12-hour form is 午後 0:30 at half
    // past noon, not 午後 12:30 — see tz.clock(). This window was 24h-only, so
    // it read differently from the phone every hour of the day.
    const mtSw = el('button', 'sw' + (TTX.store.state.setting?.military_time !== false ? ' on' : ''));
    mtSw.setAttribute('role', 'switch');
    mtSw.setAttribute('aria-checked', String(TTX.store.state.setting?.military_time !== false));
    mtSw.onclick = async () => {
      const want = !(TTX.store.state.setting?.military_time !== false);
      const was = TTX.store.state.setting;
      mtSw.disabled = true;
      try {
        TTX.store.state.setting = await TTX.api.putSetting({ military_time: want });
        mtSw.classList.toggle('on', want);
        mtSw.setAttribute('aria-checked', String(want));
        refresh('fade');
        toast(want ? '24時間表示にしました' : '12時間表示にしました');
      } catch (e) {
        TTX.store.state.setting = was;
        toast('表記を変更できませんでした: ' + e.message);
      } finally {
        mtSw.disabled = false;
      }
    };
    body.appendChild(setRow('24時間表示', 'TimeTree の設定。オフだと 午後 2:30 のように出ます', mtSw));

    body.appendChild(setRow('空いている日を隠す', '予定のない日を詰めて表示します',
      toggleBtn(ui.hideEmpty, (v) => {
        ui.hideEmpty = v;
        savePrefs();
        openSettings.refresh();
        refresh('fade');
      })));

    body.appendChild(setRow('地図',
      ui.maps
        ? '場所のピンを地図から選べます。表示する範囲を OpenStreetMap に問い合わせます'
        : 'オフの間、このアプリは TimeTree としか通信しません',
      toggleBtn(ui.maps, async (v) => {
        ui.maps = v;
        await window.host.map.setEnabled(v);
        savePrefs();
        openSettings.refresh();
      })));

    // --- notifications
    section('通知');
    body.appendChild(setRow('予定の通知', 'このアプリが起動している間だけ鳴ります',
      toggleBtn(ui.notify, (v) => {
        ui.notify = v;
        savePrefs();
        openSettings.refresh();
        if (v) checkAlerts();
      })));
    body.appendChild(setRow('Windows 起動時に開始', 'トレイに常駐して通知を受け取ります',
      toggleBtn(ui.autoStart, async (v) => {
        await setAutoStart(v);
        openSettings.refresh();
      })));

    // --- export
    section('書き出し');
    const exp = el('div', 'st-exports');
    for (const [kind, label, sub] of [
      ['md', 'Markdown', 'クリップボードへ'],
      ['ics', 'ICS', 'カレンダーアプリへ取り込む'],
      ['csv', 'CSV', '表計算ソフトへ'],
      ['json', 'JSON', '生データ'],
    ]) {
      const b = el('button', 'st-exp');
      b.append(TTX.icon('download', 14), el('span', 'st-exp-t', label), el('span', 'st-exp-s', sub));
      b.onclick = () => doExport(kind);
      exp.appendChild(b);
    }
    body.appendChild(exp);
    const { from, to } = range();
    const jp = (k) => `${+k.slice(5, 7)}月${+k.slice(8)}日`;
    body.appendChild(el('div', 'st-note',
      `いま表示している範囲（${from.slice(0, 4)}年${jp(from)} 〜 ${jp(to)}）を書き出します。`));

    // --- about
    section('このアプリについて');
    const about = el('div', 'st-about');
    about.appendChild(el('div', null, 'TimeForest — TimeTree 非公式クライアント'));
    about.appendChild(el('div', 'st-s',
      'TimeTree の公開 API はありません。Web アプリと同じ内部 API を、あなたのログイン'
      + 'セッションで呼んでいます。パスワードはこのアプリを通りません。'));
    body.appendChild(about);

    const foot = el('div', 'f-foot');
    foot.appendChild(el('div', 'tb-spacer'));
    const close = el('button', 'btn primary', '閉じる');
    close.onclick = () => closeSettings();
    foot.appendChild(close);
    card.appendChild(foot);

    scrim.appendChild(card);
    document.body.appendChild(scrim);
    ui.settingsRelease = dialog(card, { labelledBy: hid });

    scrim.onclick = (e) => { if (e.target === scrim) closeSettings(); };
    card.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { e.preventDefault(); closeSettings(); }
    });
    (card.querySelector(FOCUSABLE) || card).focus();
  }

  /** Toggles change labels elsewhere in the sheet, so redraw it in place. */
  openSettings.refresh = () => {
    if (!ui.settings) return;
    closeSettings();
    openSettings();
  };

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
        icon: 'arrow-right',
        main: `${dateKey} へ移動`,
        sub: WEEKDAY_JA[weekdayOf(dateKey)] + '曜日',
        run: () => jumpTo(dateKey),
      });
    }

    if (q.trim()) {
      // The palette searches what the window is showing, so no `only` — an
      // unticked calendar stays out of the view you are looking at. `tf find`
      // passes one, because a terminal has no sidebar to read.
      for (const o of TTX.store.searchAll(q, 40).events) {
        out.push({
          sec: '予定',
          rail: railColor(o),
          main: o.title,
          when: `${o.startKey.replace(/-/g, '/')} ${o.allDay ? '終日' : clock(o.startTime)}`,
          sub: o.location || '',
          run: () => jumpTo(o.startKey, 'agenda'),
        });
      }
    }

    const cmds = [
      { icon: 'plus', main: '新しい予定', run: () => openForm() },
      { icon: 'home', main: '今日へ', run: () => jumpTo(todayKey()) },
      { icon: 'list', main: 'アジェンダ表示', run: () => setView('agenda') },
      { icon: 'columns', main: '週表示', run: () => setView('week') },
      { icon: 'calendar-days', main: '月表示', run: () => setView('month') },
      { icon: 'moon', main: 'テーマ: ダーク', run: () => applyTheme('dark') },
      { icon: 'sun', main: 'テーマ: ライト', run: () => applyTheme('light') },
      { icon: 'monitor', main: 'テーマ: システムに従う', run: () => applyTheme('system') },
      { icon: 'refresh', main: '再同期', run: () => resync() },
      { icon: 'sliders', main: '設定', run: () => openSettings() },
      {
        icon: ui.notify ? 'bell-off' : 'bell',
        main: ui.notify ? '通知をオフにする' : '通知をオンにする',
        sub: ui.notify ? '起動中は予定の通知を出します' : '通知は止まっています',
        run: () => {
          ui.notify = !ui.notify;
          savePrefs();
          toast(ui.notify ? '通知をオンにしました' : '通知をオフにしました');
          if (ui.notify) checkAlerts();
        },
      },
      {
        icon: 'power',
        main: ui.autoStart ? 'Windows 起動時に開始しない' : 'Windows 起動時に開始する',
        sub: ui.autoStart ? '今は自動で起動します' : '通知を受け取るにはアプリが起動している必要があります',
        run: () => setAutoStart(!ui.autoStart),
      },
      { icon: 'download', main: 'Markdown をコピー', run: () => doExport('md') },
      { icon: 'download', main: 'CSV を書き出し', run: () => doExport('csv') },
      { icon: 'download', main: 'ICS を書き出し', run: () => doExport('ics') },
      { icon: 'download', main: 'JSON を書き出し', run: () => doExport('json') },
      { icon: 'user-plus', main: 'アカウントを追加', run: () => addAccount() },
      ...ui.accounts.filter((a) => a.id !== ui.activeId).map((a) => ({
        icon: 'arrow-left-right', main: `アカウント切替: ${a.name}`, run: () => switchAccount(a.id),
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
    ui.palette = { scrim, input, sel: 0, items: [],
      release: dialog(box, { label: '検索・移動・コマンド' }) };

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
          const r = el('span', 'p-dot');
          r.style.background = it.rail;
          b.appendChild(r);
        } else {
          const ic = el('span', 'p-ic');
          if (it.icon) ic.appendChild(TTX.icon(it.icon, 14));
          b.appendChild(ic);
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
    ui.palette?.release?.();
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
    // `ready` rejects too when a transition is skipped — another one started,
    // or the window isn't visible. Nothing was listening to it, so a normal
    // thing we already handle surfaced as an unhandled rejection:
    // "Transition was skipped" in the console, looking like a fault. Swiping
    // makes overlapping navigations ordinary rather than rare.
    t.ready.catch(() => {});
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
    if (ui.view === 'agenda') ui.lastTop = $('.agenda')?.scrollTop ?? 0;
    if (ui.view === 'month') requestAnimationFrame(measureCells);
    if (ui.view === 'agenda') requestAnimationFrame(fillAgenda);
  }

  /**
   * Three months of a quiet calendar can be SHORTER than the window — empty
   * runs collapse to one 「予定なし」 line each — and a list that doesn't
   * overflow never fires a scroll event. Growing on scroll then means the
   * agenda can't reach another month at all: the feature is simply absent,
   * silently, for exactly the people with the least on.
   *
   * So give it something to scroll. growAgenda works out how many months that
   * takes from the density on screen, so this is one paint, not one per month,
   * and it stops itself: once the list overflows there's nothing to do, and at
   * the span limit growAgenda returns without painting, so the rAF chain ends.
   */
  function fillAgenda() {
    const w = $('.agenda');
    if (w && w.scrollHeight <= w.clientHeight + 2) growAgenda(1);
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

  /**
   * Grow the agenda at whichever edge you scrolled to, so the calendar reads as
   * one continuous year instead of three months with walls at both ends.
   *
   * Two things make this harder than "append more rows":
   *
   * 1. Growing BACKWARDS inserts content above you. The browser keeps scrollTop
   *    where it was, which means the page jumps by exactly the height that was
   *    added. So measure before, measure after, and put the difference back —
   *    the whole point is that nothing appears to move.
   * 2. This must not go through render(). That runs a View Transition, which
   *    crossfades the old and new DOM: correct for 「次の月へ」, absurd for
   *    "there is more of the list below you".
   */
  async function growAgenda(dir) {
    // busy() matters here for a reason that isn't obvious: paint() opens with
    // closeDetail(), because it is about to destroy the row the popover is
    // anchored to. So a growth while someone has an event open doesn't just
    // repaint — it takes the card off the screen mid-read.
    if (ui.growing || ui.view !== 'agenda' || busy()) return;
    const wrap = $('.agenda');
    if (!wrap) return;
    const before = wrap.scrollHeight;
    const at = wrap.scrollTop;

    // How much is already loaded past the edge you're heading for, and how much
    // short of the runway that leaves us.
    const have = dir < 0 ? at : before - at - wrap.clientHeight;
    const need = wrap.clientHeight * AGENDA_RUNWAY - have;
    if (need <= 0) return;

    // What a month is worth in pixels, on THIS calendar, right now. The whole
    // reason this isn't a constant: it's ~40px for an empty month and several
    // hundred for a busy one, and guessing either way is what made this either
    // stutter or run away.
    const months = ui.spanBack + ui.spanFwd + 1;
    const perMonth = Math.max(1, before / months);
    const add = Math.min(Math.max(1, Math.ceil(need / perMonth)), AGENDA_MAX_STEP);

    // Give the same back at the far end — but ONLY when we're over the pixel
    // budget, and measured in pixels. spanBack going NEGATIVE is the point: the
    // window travels past the month the cursor sits in, which is what lets you
    // keep going without the list — and the scrollbar — growing forever.
    //
    // Deciding this in MONTHS is what stranded it. perMonth is measured on the
    // window you're leaving, so sliding out of a busy year into an empty one
    // keeps answering "a month is 400px" while the new ones are 40px. It then
    // trimmed away everything it had just added, the list never grew tall
    // enough to scroll, and with no scroll there was no way to ask for more:
    // stuck, intermittently, wherever the calendar ran out.
    const budget = wrap.clientHeight * AGENDA_WINDOW;
    const projected = before + add * perMonth;
    const cut = Math.max(0, Math.min(
      projected > budget ? Math.floor((projected - budget) / perMonth) : 0,
      months - 1,
    ));

    // At the month ceiling the far end has to give way, or the window can never
    // move again in EITHER direction — which is its own kind of stuck.
    const trade = Math.max(cut, Math.max(0, months + add - AGENDA_MAX_MONTHS));

    // Hold a DAY, not a month header: headers are sticky and measure as ~0.
    // Both ends are about to move, so scrollHeight arithmetic can't say where
    // you were any more — only a thing with a name can.
    const wrapTop = wrap.getBoundingClientRect().top;
    let anchor = null;
    let into = 0;
    for (const d of wrap.querySelectorAll('[data-key]')) {
      const t = d.getBoundingClientRect().top - wrapTop;
      // The last day at or above the top edge — or, if you're already at the
      // very top, the first one below it. There has to be an anchor either way:
      // sitting at scrollTop 0 and adding months ABOVE without pushing the
      // content down leaves you still at 0, looking at different rows, with no
      // scroll left to make and therefore no way to ask for more. Measured: 15
      // scrolls down travelled 15 months, 30 scrolls up travelled 2.
      if (t <= 0) { anchor = d.dataset.key; into = -t; continue; }
      if (!anchor) { anchor = d.dataset.key; into = -t; }
      break;
    }

    const was = { back: ui.spanBack, fwd: ui.spanFwd };
    const couldScroll = before > wrap.clientHeight + 2;

    ui.growing = true;
    try {
      if (dir < 0) { ui.spanBack += add; ui.spanFwd -= trade; }
      else { ui.spanFwd += add; ui.spanBack -= trade; }

      // Cached by year, so this is free within a year and one fetch across a
      // boundary. Painting first would flash a month with no holidays in it.
      await ensureHolidays();
      // Ask again. That await can last a network round-trip on a year we
      // haven't seen, and a card opened during it would be destroyed by the
      // paint below — checking only on the way in is checking the wrong moment.
      if (busy() || ui.view !== 'agenda') return;
      paint();
      const after = $('.agenda');
      if (!after) return;

      // Whether that trade was worth making can only be known afterwards, so
      // check afterwards. Empty days collapse to a single 「予定なし」 line, so
      // a year with nothing in it is ~60px: swapping dense months at the near
      // end for empty ones at the far end can leave the list SHORTER than the
      // window — and with no scroll there is no way to ask for anything back.
      // Measured, before this: 3678 → 803px over six growths, ending on one
      // month, unscrollable, permanently.
      //
      // Being stuck is worse than not moving. Put it back.
      if (couldScroll && after.scrollHeight <= after.clientHeight + 2) {
        ui.spanBack = was.back;
        ui.spanFwd = was.fwd;
        paint();
        const undone = $('.agenda');
        if (undone) { undone.scrollTop = at; ui.lastTop = at; }
        return;
      }

      const back = anchor && after.querySelector(`[data-key="${anchor}"]`);
      if (back) {
        // Put that day back exactly `into` px above the top edge, wherever it
        // has landed. paint() restored the old scrollTop, so measure from there.
        const now = back.getBoundingClientRect().top - after.getBoundingClientRect().top;
        after.scrollTop += now + into;
      } else {
        // No day above you — you're at the very top, so nothing was trimmed on
        // this side and the height difference IS what appeared above.
        after.scrollTop = dir < 0 ? at + (after.scrollHeight - before) : at;
      }
      // The handler reads direction by comparing against this. Leaving it at
      // the pre-jump value makes the next scroll look like a huge move upward.
      ui.lastTop = after.scrollTop;
    } finally {
      // Writing scrollTop above FIRES A SCROLL EVENT, and the handler that
      // catches it would see "still near the edge" and grow again — each growth
      // paying for the next one. Measured: 14 deliberate scrolls became 27+
      // growths. Scroll events are dispatched before requestAnimationFrame
      // callbacks run, so releasing here lets our own scrolls land while the
      // guard is still up.
      requestAnimationFrame(() => { ui.growing = false; });
    }
  }

  /**
   * The title names the month you are LOOKING at, which after a scroll is not
   * the month the cursor sits in. Written straight into the node — re-rendering
   * the app on every scroll frame to change six characters would be absurd.
   */
  function titleFromScroll(wrap) {
    const heads = [...wrap.querySelectorAll('.ag-month')];
    if (!heads.length) return;
    const top = wrap.getBoundingClientRect().top;
    // The last header at or above the top edge: the month whose rows you're in.
    let seen = heads[0].textContent;
    for (const h of heads) {
      if (h.getBoundingClientRect().top - top <= 1) seen = h.textContent;
      else break;
    }
    if (seen === ui.seenMonth) return;
    ui.seenMonth = seen;
    const t = $('.tb-title');
    if (t) t.textContent = seen;
  }

  /**
   * Swipe or drag sideways to go to the next/previous month or week.
   *
   * Both views already move with direction — go(±1) hands render() a 'next' or
   * 'prev' and the View Transition pushes the old view out the way you came
   * from. This just gives that a second way in, the one your hand reaches for
   * on a trackpad.
   *
   * The three things that make it feel wrong if you skip them:
   *
   *  - A trackpad fires deltaX every frame for the whole flick, so one gesture
   *    would travel five months. So it LATCHES: once it fires, it ignores the
   *    rest of that gesture until the wheel goes quiet.
   *  - The week view scrolls VERTICALLY, and a real swipe is never perfectly
   *    horizontal. Only take the gesture when it is clearly sideways, and never
   *    call preventDefault on one that isn't — stealing the odd diagonal frame
   *    from the time grid makes it stutter.
   *  - A drag that starts on an event is reaching for the event.
   */
  const SWIPE_WHEEL = 90;    // px of sideways wheel before it counts
  const SWIPE_DRAG = 70;     // px of drag before it counts
  const SWIPE_QUIET = 140;   // ms of no wheel = gesture over, unlatch

  function swipeNav(wrap) {
    let acc = 0;
    let latched = false;
    let quiet = null;

    wrap.addEventListener('wheel', (e) => {
      /* A trackpad sends deltaX. A MOUSE HAS NO SECOND AXIS — it can only send
       * deltaY, so Shift+wheel is how it asks for sideways, on Windows and
       * everywhere else. Reading deltaX alone meant that on a mouse this
       * gesture could not be performed at all: no amount of scrolling, in any
       * direction, with or without Shift, would move the week. Dragging still
       * worked, but nothing tells you that, so it reads as 「横スクロール
       * できなくね」 — which is exactly how it was reported. */
      const across = e.shiftKey && !e.deltaX ? e.deltaY : e.deltaX;
      const along = e.shiftKey && !e.deltaX ? 0 : e.deltaY;
      // Diagonal or vertical: not ours. Leave it alone entirely — the week grid
      // is scrolling on it.
      if (Math.abs(across) <= Math.abs(along)) return;
      e.preventDefault();
      clearTimeout(quiet);
      quiet = setTimeout(() => { latched = false; acc = 0; }, SWIPE_QUIET);
      if (latched) return;
      acc += across;
      if (Math.abs(acc) < SWIPE_WHEEL) return;
      latched = true;
      acc = 0;
      go(across > 0 ? 1 : -1);   // push content left = go forward
    }, { passive: false });

    let from = null;
    wrap.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || e.target.closest('button, a, input, select, textarea')) return;
      from = { x: e.clientX, y: e.clientY };
    });
    wrap.addEventListener('pointerup', (e) => {
      if (!from) return;
      const dx = e.clientX - from.x;
      const dy = e.clientY - from.y;
      from = null;
      if (Math.abs(dx) < SWIPE_DRAG || Math.abs(dx) <= Math.abs(dy)) return;
      go(dx < 0 ? 1 : -1);         // drag content left = go forward
    });
    wrap.addEventListener('pointercancel', () => { from = null; });
    return wrap;
  }

  /** Put the cursor's month at the top of the agenda instead of guessing. */
  function scrollToCursor() {
    const wrap = $('.agenda');
    if (!wrap) return;
    const want = `${ui.cursor.slice(0, 4)}年${Number(ui.cursor.slice(5, 7))}月`;
    const target = [...wrap.querySelectorAll('.ag-month')].find((h) => h.textContent === want);
    if (target) wrap.scrollTop = target.offsetTop;
  }

  /**
   * A cheap "did anything change" stamp. Count plus the newest updated_at
   * covers creates, edits and deletes alike — a delete bumps updated_at and
   * sets deactivated_at, and the row itself stays, so the count holds.
   */
  function fingerprint() {
    let n = 0;
    let newest = 0;
    for (const list of TTX.store.state.events.values()) {
      n += list.length;
      for (const e of list) if (e.updated_at > newest) newest = e.updated_at;
    }
    return n + ':' + newest;
  }

  async function resync(quiet = false) {
    if (ui.syncing) return;
    ui.syncing = true;
    if (!quiet) { ui.status = '同期中…'; render(); }
    const was = quiet ? fingerprint() : null;
    // Don't empty the store first. syncAll replaces each calendar's list as it
    // lands, so the old data stays readable the whole time, and a failure
    // leaves it untouched. Clearing opened a window — the length of a full
    // pull, seconds — where anything that painted saw an empty calendar. The
    // error path already knew stale beats blank; the happy path had the same
    // hole, and it only shows if you happen to render mid-fetch, which a
    // background sync every five minutes makes a matter of when, not if.
    try {
      await TTX.store.syncAll((cal, n) => {
        if (quiet) return;
        ui.status = `${cal.name}: ${n}件…`;
        const s = $('.side-status');
        if (s) s.textContent = ui.status;
      });
      // A background sync that found nothing new should be invisible. Most of
      // them find nothing, and refresh() ends in a cross-fade of the whole
      // grid — five minutely, to show you what you were already looking at.
      if (quiet && fingerprint() === was) {
        const s = $('.side-sync');
        if (s) s.textContent = syncedText();
        return;
      }
      await refresh();
      if (!quiet) toast(`同期完了 — ${TTX.store.totalEvents()} 件`);
    } catch (e) {
      // The store still holds whatever last landed — stale is bad, blank is
      // worse, and the footer says which one you're looking at.
      ui.syncFailed = true;
      render();
      if (!quiet) toast('同期エラー: ' + e.message);
    } finally {
      ui.syncing = false;
    }
  }

  /**
   * Keep the screen honest without being asked.
   *
   * A calendar that only refreshes when you press a button starts lying the
   * moment you forget to press it — and a calendar that lies quietly is worse
   * than no calendar, because you act on it. You plan around a free Thursday
   * that your partner filled in this morning.
   *
   * Poll rather than push: TimeTree's web app holds a socket, but riding that
   * is a much bigger surface to reverse and to keep working. Every event ever
   * is ~2400 rows over 8 chunks, so a full pull is cheap and, more to the
   * point, correct — there is no delta to get wrong.
   */
  const SYNC_EVERY = 5 * 60 * 1000;

  /**
   * Never while the user is mid-thought.
   *
   * A sync ends in refresh() -> paint(), and paint() rebuilds #app and closes
   * the detail popover and the menus, because their anchors are about to be
   * destroyed. So an auto-sync landing while you read an event would shut the
   * popover; landing while you fill in the form would re-render the grid
   * underneath it. Fixing "the calendar lies quietly" by making it interrupt
   * you is not a trade worth making — the data is minutes old at worst, and
   * the tick comes round again.
   */
  const busy = () => !!(ui.form || ui.confirm || ui.palette || ui.detail || ui.menu);

  function startAutoSync() {
    setInterval(() => {
      if (document.hidden || !TTX.store.state.ready || busy()) return;
      if (Date.now() - TTX.store.state.syncedAt < SYNC_EVERY) return;
      resync(true);
    }, 60000);
    // Coming back to the window is exactly when you're about to trust what it
    // says, so that's when it's worth re-checking.
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden && TTX.store.state.ready && !busy()
          && Date.now() - TTX.store.state.syncedAt > SYNC_EVERY) resync(true);
    });
  }

  /** "3分前に同期" — how much to trust what's on screen. */
  function syncedText() {
    if (ui.syncing) return '同期中…';
    const at = TTX.store.state.syncedAt;
    if (!at) return '';
    const min = Math.floor((Date.now() - at) / 60000);
    if (ui.syncFailed) return '更新できていません';
    if (min < 1) return '最新です';
    return min < 60 ? `${min}分前に同期` : `${Math.floor(min / 60)}時間前に同期`;
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
    if (ui.settings) {
      if (e.key === 'Escape') { e.preventDefault(); closeSettings(); }
      return;
    }
    if (ui.form || ui.confirm) {
      if (e.key === 'Escape' && ui.form && !ui.confirm) { e.preventDefault(); ui.formClose?.(); }
      return;
    }
    if (e.key === 'Escape' && ui.detail) { e.preventDefault(); return closeDetail(); }
    // Escape has to be handled HERE, not only on the palette's input. It used
    // to live on input.onkeydown, and `if (ui.palette) return` sat above it —
    // so one Tab moved focus to a result and the only way out of the palette
    // was the mouse. That's a keyboard trap: Ctrl+K, Tab, and you're stuck.
    if (ui.palette) {
      if (e.key === 'Escape') { e.preventDefault(); closePalette(); }
      return;
    }
    const typing = /^(INPUT|TEXTAREA)$/.test(e.target.tagName);
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); return openPalette(); }
    if (typing) return;
    if (e.key === '/') { e.preventDefault(); return openPalette(); }
    if (e.key.toLowerCase() === 'n') { e.preventDefault(); return openForm(); }
    if (e.key === ',') { e.preventDefault(); return openSettings(); }
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
    startAlerts();
    startAutoSync();
    ui.autoStart = await window.host.autoStart.get().catch(() => false);
    // The switch lives in prefs, which only the renderer can read; the host
    // starts every run refusing to fetch anything until told otherwise. Say so
    // once, here, rather than checking a flag at each call site.
    await window.host.map.setEnabled(ui.maps).catch(() => {});

    await refreshAccounts();
    await bootUI();
  }

  main().catch((e) => {
    console.error(e);
    document.getElementById('app').textContent = 'ERROR: ' + e.message;
  });
})();
