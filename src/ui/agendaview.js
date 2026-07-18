/* Add an agenda (list) view to TimeTree's own calendar.
 *
 * TimeTree's web app shows a month grid (data-test-id="monthly-calendar") and
 * nothing else — no chronological list of what's coming up, which is the view
 * the desktop client leads with. An agenda IS a view, so「アジェンダ」joins
 * TimeTree's own マンスリー/ウィークリー segmented toggle as a third option
 * (cloned from the live buttons so a redeploy that rehashes their classes keeps
 * matching), and the list renders as an overlay INSIDE `calendar-main` (which is
 * position:relative), covering the month grid without fighting React for it: the
 * overlay is our own node, monthly-calendar stays React's. A MutationObserver
 * re-attaches both if a re-render drops them.
 *
 * Events come from TTX.api (allEvents + labels + memorialdays), the same seam
 * export uses — so this works in both the extension (worker transport) and the
 * userscript (direct fetch). No sendMessage of its own, no worker gate.
 */
(() => {
  const TTX = (window.TTX = window.TTX || {});
  const BTN = 'data-ttx-agenda-btn';
  const OVL = 'ttx-agenda-overlay';

  const el = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  };

  const CSS = `
/* Colours are TimeTree's own (its themed CSS tokens, light → dark), not Apple
   approximations, so the agenda matches the month grid it covers. */
.${OVL} {
  position: absolute; inset: 0; z-index: 20; overflow-y: auto;
  background: #fff; padding: 8px 0 40px;
  font-family: -apple-system, "Hiragino Sans", "Noto Sans JP", "Segoe UI", sans-serif;
}
.ttx-ag-load, .ttx-ag-empty { padding: 40px; text-align: center; color: #8f8f8f; font-size: 14px; }
.ttx-ag-day { display: flex; gap: 14px; padding: 9px 22px; border-top: 0.5px solid #ededed; }
.ttx-ag-day:first-child { border-top: none; }
.ttx-ag-day.today { background: #fff9ec; }
.ttx-ag-date { flex: 0 0 88px; padding-top: 2px; }
.ttx-ag-dnum { font-size: 17px; font-weight: 700; color: #212121; letter-spacing: -0.01em; }
.ttx-ag-dnum .wd { font-size: 12px; font-weight: 600; margin-left: 5px; color: #8f8f8f; }
.ttx-ag-day.sat .ttx-ag-dnum .wd { color: #2f6fed; }
.ttx-ag-day.sun .ttx-ag-dnum .wd, .ttx-ag-day.hol .ttx-ag-dnum .wd { color: #e0335b; }
.ttx-ag-evs { flex: 1; display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.ttx-ag-ev { display: flex; align-items: baseline; gap: 9px; padding: 4px 6px; border-radius: 7px; }
.ttx-ag-ev:hover { background: #f4f4f4; }
.ttx-ag-time { flex: 0 0 90px; font-size: 12px; color: #8f8f8f; font-variant-numeric: tabular-nums; }
.ttx-ag-bar { flex: 0 0 4px; align-self: stretch; border-radius: 2px; background: #909090; }
.ttx-ag-title { flex: 1; font-size: 14px; color: #212121; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
:root.ttx-dark .${OVL} { background: #0f0f0f; }
:root.ttx-dark .ttx-ag-day { border-color: #363636; }
:root.ttx-dark .ttx-ag-day.today { background: #2a2616; }
:root.ttx-dark .ttx-ag-dnum, :root.ttx-dark .ttx-ag-title { color: #fff; }
:root.ttx-dark .ttx-ag-load, :root.ttx-dark .ttx-ag-empty, :root.ttx-dark .ttx-ag-time { color: #606060; }
:root.ttx-dark .ttx-ag-ev:hover { background: #2c2c2c; }`;

  function ensureCss() {
    if (document.getElementById('ttx-ag-css')) return;
    const s = el('style'); s.id = 'ttx-ag-css'; s.textContent = CSS;
    document.head.appendChild(s);
  }

  const WD = ['日', '月', '火', '水', '木', '金', '土'];

  /** The calendar alias in the URL. TimeTree switches calendars by changing it
   *  with no reload, so it's how we tell whether the cache belongs to the
   *  calendar currently on screen. */
  const currentAlias = () => location.pathname.match(/\/calendars\/([^/]+)/)?.[1] || '';

  /** That alias resolved to its id via the API. */
  async function currentCalendar() {
    const alias = currentAlias();
    const cals = await TTX.api.calendars();
    return cals.find((c) => c.alias_code === alias) || cals[0] || null;
  }

  let visible = false;
  let cache = null;       // { alias, calId, name, raw, labels, mem } — last fetch, tagged with its calendar
  let rendering = false;  // true while the newest render is in flight (the observer's re-render defers to it)
  let renderSeq = 0;      // generation counter — only the newest render writes cache / paints

  // ---- overlay ----
  function overlay() {
    const main = document.querySelector('[data-test-id="calendar-main"]');
    if (!main) return null;
    let ovl = document.querySelector('.' + OVL);
    if (ovl && ovl.parentElement !== main) main.appendChild(ovl);   // React detached it — re-attach same node
    if (!ovl) { ovl = el('div', OVL); ovl.hidden = !visible; main.appendChild(ovl); }
    return ovl;
  }

  /** today .. today+60d as day keys, plus an epoch window widened ±1 day so
   *  occurrences()'s epoch filter doesn't drop a JST-early/late boundary event
   *  whose day IS in range (groupByDay clips back to the day keys). */
  function range() {
    const from = TTX.tz.ymd(Date.now(), 'Asia/Tokyo');
    const to = TTX.tz.ymd(Date.now() + 60 * TTX.tz.DAY, 'Asia/Tokyo');
    return { from, to, lo: TTX.tz.parseYmd(from) - TTX.tz.DAY, hi: TTX.tz.parseYmd(to) + TTX.tz.DAY };
  }

  /** The slow part — allEvents is 5000+ events over ~18 chunks — so callers show
   *  the cache first and await this in the background. */
  async function fetchData() {
    const alias = currentAlias();
    const cal = await currentCalendar();
    if (!cal) throw new Error('カレンダーが見つかりません');
    const { lo, hi } = range();
    const [raw, labels, mem] = await Promise.all([
      TTX.api.allEvents(cal.id),
      TTX.api.labels(cal.id),
      TTX.api.memorialdays(lo, hi).catch(() => []),   // public holidays, like the month grid shows
    ]);
    return { alias, calId: cal.id, name: cal.name, raw, labels, mem };
  }

  /** Compute occurrences and paint the list from a data object — pure DOM, no
   *  network, so it's instant on a cached re-open. */
  function buildDOM(ovl, data) {
    const { from, to, lo, hi } = range();
    const occs = TTX.model
      .occurrences(data.raw, lo, hi, { id: data.calId, name: data.name, calendar_labels: data.labels }, {})
      .concat(TTX.model.holidayOccurrences(data.mem));
    const byDay = TTX.model.groupByDay(occs, from, to);
    const labelById = new Map((data.labels || []).map((l) => [l.id, l]));
    const today = from;

    const frag = document.createDocumentFragment();
    let shown = 0;
    for (const key of Object.keys(byDay)) {
      const evs = byDay[key];
      if (!evs.length) continue;                        // agenda skips empty days
      shown++;
      const wd = new Date(key + 'T00:00:00Z').getUTCDay();
      const holiday = evs.some((o) => o.holiday);
      const row = el('div', 'ttx-ag-day' + (key === today ? ' today' : '')
        + (holiday ? ' hol' : wd === 0 ? ' sun' : wd === 6 ? ' sat' : ''));
      const date = el('div', 'ttx-ag-date');
      const dnum = el('div', 'ttx-ag-dnum');
      dnum.append(el('span', null, `${+key.slice(5, 7)}/${+key.slice(8)}`), el('span', 'wd', `(${WD[wd]})`));
      date.appendChild(dnum);
      const list = el('div', 'ttx-ag-evs');
      for (const o of evs) {
        const ev = el('div', 'ttx-ag-ev');
        let time;
        if (o.allDay || o.holiday) time = '終日';
        else if (o.multiDay) {
          // a multi-day timed event: it only starts once and ends once
          if (key === o.startKey) time = o.startTime + '〜';
          else if (key === o.endKey) time = '〜' + o.endTime;
          else time = '終日';
        } else time = o.startTime;
        ev.appendChild(el('div', 'ttx-ag-time', time));
        const bar = el('div', 'ttx-ag-bar');
        const lb = labelById.get(o.labelId);
        if (lb) bar.style.background = TTX.api.colorHex(lb.color);
        else if (o.holiday) bar.style.background = '#e0335b';
        ev.appendChild(bar);
        ev.appendChild(el('div', 'ttx-ag-title', o.title || '(無題)'));
        list.appendChild(ev);
      }
      row.append(date, list);
      frag.appendChild(row);
    }
    ovl.textContent = '';
    if (!shown) ovl.appendChild(el('div', 'ttx-ag-empty', 'この先60日に予定はありません'));
    else ovl.appendChild(frag);
    ovl.dataset.rendered = '1';
  }

  /** Show the cached list instantly, then refresh in the background — so a
   *  re-open is immediate and only the first open of a session waits on the full
   *  events fetch (allEvents is 5000+ events over ~18 chunks). A generation
   *  counter plus the calendar alias keep a fast open/close/open or a calendar
   *  switch from painting — or caching — the wrong calendar's events. */
  async function render(ovl) {
    const seq = ++renderSeq;
    rendering = true;
    try {
      const alias = currentAlias();
      const hit = !!cache && cache.alias === alias;   // cache is for the calendar on screen
      if (hit) buildDOM(ovl, cache);
      else { ovl.dataset.rendered = ''; ovl.textContent = ''; ovl.appendChild(el('div', 'ttx-ag-load', '読み込み中…')); }
      let fresh = null;
      try {
        fresh = await fetchData();
      } catch (e) {
        if (!hit && seq === renderSeq) { ovl.textContent = ''; ovl.appendChild(el('div', 'ttx-ag-empty', '読み込めませんでした：' + (e.message || e))); ovl.dataset.rendered = '1'; }
        return;
      }
      if (seq !== renderSeq) return;                   // a newer render superseded this one
      cache = fresh;
      // Paint the CURRENT overlay — React may have re-attached or replaced it mid
      // fetch — and only while it's still the calendar we fetched.
      if (visible && fresh.alias === currentAlias()) {
        const cur = overlay();
        if (cur) buildDOM(cur, fresh);
      }
    } finally { if (seq === renderSeq) rendering = false; }
  }

  /** Observer path: React fully removed the overlay while it was open. Re-populate
   *  from cache instantly (no refetch — the data is seconds old); only load if we
   *  have nothing cached yet. */
  async function ensureShown() {
    const ovl = overlay();
    if (!ovl) return;
    ovl.hidden = false;
    if (ovl.dataset.rendered || rendering) return;
    if (cache && cache.alias === currentAlias()) buildDOM(ovl, cache);
    else render(ovl);
  }

  // ---- the toggle button, cloned from TimeTree's own マンスリー/ウィークリー ----
  const VIEW_LABELS = ['マンスリー', 'ウィークリー', 'Monthly', 'Weekly'];
  const NAV_TEXT = ['今日', 'Today'];
  const NAV_ARIA = ['前月', '翌月', 'Previous month', 'Next month'];
  let clsCache = null;     // { base:[], activeMods:[], inactiveMods:[] } learned ONCE
  let underlying = null;   // the native button that was lit when the agenda opened

  const nativeViewBtns = () =>
    [...document.querySelectorAll('button')].filter((b) => VIEW_LABELS.includes((b.textContent || '').trim()));

  /** Learn base / active / inactive classes off the live pair, ONCE and while
   *  they are still in their natural state — hardcoding the build-hash classes
   *  would break on a redeploy, and re-learning after we've painted both natives
   *  the same would latch onto empty mods. */
  function learnClasses(btns) {
    if (clsCache) return;
    const [a, b] = btns;
    if (!a || !b) return;
    const A = [...a.classList], B = [...b.classList];
    const base = A.filter((c) => B.includes(c));
    const aMods = A.filter((c) => !B.includes(c));
    const bMods = B.filter((c) => !A.includes(c));
    const aActive = getComputedStyle(a).backgroundColor !== 'rgba(0, 0, 0, 0)';
    clsCache = { base, activeMods: aActive ? aMods : bMods, inactiveMods: aActive ? bMods : aMods };
  }

  function paint(node, active) {
    if (!clsCache) return;
    node.className = [...clsCache.base, ...(active ? clsCache.activeMods : clsCache.inactiveMods)].join(' ');
    node.setAttribute('aria-selected', String(active));   // in case the toggle styles by aria, not class
  }

  /** The native button currently lit — read BEFORE we paint over anything. */
  function activeNative() {
    if (!clsCache || !clsCache.activeMods.length) return null;
    return nativeViewBtns().find((b) => clsCache.activeMods.every((c) => b.classList.contains(c))) || null;
  }

  /** Only ever called on a real state change (open / re-inject / close), never
   *  per mutation — repainting the natives every tick would flicker against React. */
  function applyState() {
    const mine = document.querySelector(`[${BTN}]`);
    if (!mine || !clsCache) return;
    paint(mine, visible);
    if (visible) {
      // Capture the lit native the FIRST time we're about to grey them out —
      // here, not in toggle(), because a keyboard/toolbar open can fire before
      // the button (and its native pair) exist, and applyState no-ops until they
      // do. Doing it here means underlying is always the tab that was really lit,
      // so hide() can relight it and never leaves the segment blank.
      if (!underlying) underlying = activeNative();
      nativeViewBtns().forEach((b) => paint(b, false));
    }
  }

  function hide(clickedNative) {
    if (!visible) return;
    visible = false;
    const ovl = document.querySelector('.' + OVL);
    if (ovl) ovl.hidden = true;
    const mine = document.querySelector(`[${BTN}]`);
    if (mine) paint(mine, false);
    // Restore the segment. If the user clicked a real view, that one wins; else
    // (closed via the アジェンダ button) relight whatever was lit when we opened.
    // React won't relight it for us — clicking our foreign node fires no React
    // state change — so the segment would otherwise be left with no active tab.
    const relight = clickedNative || (underlying && underlying.isConnected ? underlying : null);
    if (relight) nativeViewBtns().forEach((b) => paint(b, b === relight));
    underlying = null;
  }

  async function toggle() {
    if (visible) return hide(null);
    visible = true;
    applyState();                    // captures `underlying` before greying the natives out
    const ovl = overlay();
    if (!ovl) { visible = false; applyState(); return; }
    ovl.hidden = false;
    await render(ovl);               // cache shows instantly; a background refresh follows
  }

  function ensureButton() {
    if (document.querySelector(`[${BTN}]`)) return;   // fast path: no button scan, no repaint
    const btns = nativeViewBtns();
    if (btns.length < 2) return;
    ensureCss();
    learnClasses(btns);
    const jp = btns.some((b) => ['マンスリー', 'ウィークリー'].includes((b.textContent || '').trim()));
    const btn = btns[1].cloneNode(true);   // clone a native button — inherit TimeTree's exact styling
    btn.textContent = jp ? 'アジェンダ' : 'Agenda';
    btn.setAttribute(BTN, '1');
    btn.onclick = (e) => { e.preventDefault(); toggle(); };
    btns[1].after(btn);
    applyState();                    // reflect the current open/closed state on the fresh clone
  }

  // A click on a real TimeTree nav asks for a real view: let React do it and step
  // the agenda aside. Delegated on the document so it survives the toggle's own
  // re-renders. View buttons relight the one clicked; 前月/翌月/今日 just navigate,
  // so the agenda closes back to whatever view was underneath it.
  function onNativeViewClick(e) {
    if (!visible) return;
    const b = e.target.closest?.('button');
    if (!b || b.hasAttribute(BTN)) return;
    const txt = (b.textContent || '').trim();
    const aria = b.getAttribute('aria-label') || '';
    if (VIEW_LABELS.includes(txt)) hide(b);
    else if (NAV_TEXT.includes(txt) || NAV_ARIA.includes(aria)) hide(null);
  }

  let observer = null;
  function start() {
    if (observer) return;
    document.addEventListener('click', onNativeViewClick, true);
    // rAF-coalesced: the agenda overlay lives inside React-owned calendar-main, and
    // on a busy calendar reacting to every subtree mutation synchronously let the
    // re-attach fight React fast enough to hang the tab (the weekly→agenda freeze).
    observer = TTX.ui.observeBody(() => { ensureButton(); if (visible) ensureShown(); });
  }
  function stop() {
    observer?.disconnect(); observer = null;
    document.removeEventListener('click', onNativeViewClick, true);
  }

  TTX.agendaview = { start, stop, toggle, _internals: { render, currentCalendar } };
})();
