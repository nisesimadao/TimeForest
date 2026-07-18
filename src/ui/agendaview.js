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
 * Events come from TTX.api (allEvents + labels), the same seam export uses —
 * so this works in both the extension (worker transport) and the userscript
 * (direct fetch). No sendMessage of its own, no worker gate.
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
.${OVL} {
  position: absolute; inset: 0; z-index: 20; overflow-y: auto;
  background: #fff; padding: 8px 0 40px;
  font-family: -apple-system, "Hiragino Sans", "Noto Sans JP", "Segoe UI", sans-serif;
}
.ttx-ag-load, .ttx-ag-empty { padding: 40px; text-align: center; color: rgba(60,60,67,0.5); font-size: 14px; }
.ttx-ag-day { display: flex; gap: 14px; padding: 9px 22px; border-top: 0.5px solid rgba(60,60,67,0.16); }
.ttx-ag-day:first-child { border-top: none; }
.ttx-ag-day.today { background: #fff9ec; }
.ttx-ag-date { flex: 0 0 88px; padding-top: 2px; }
.ttx-ag-dnum { font-size: 17px; font-weight: 700; color: #1c1c1e; letter-spacing: -0.01em; }
.ttx-ag-dnum .wd { font-size: 12px; font-weight: 600; margin-left: 5px; color: rgba(60,60,67,0.5); }
.ttx-ag-day.sat .ttx-ag-dnum .wd { color: #2f6fed; }
.ttx-ag-day.sun .ttx-ag-dnum .wd, .ttx-ag-day.hol .ttx-ag-dnum .wd { color: #e0335b; }
.ttx-ag-evs { flex: 1; display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.ttx-ag-ev { display: flex; align-items: baseline; gap: 9px; padding: 4px 6px; border-radius: 7px; }
.ttx-ag-ev:hover { background: #f2f2f7; }
.ttx-ag-time { flex: 0 0 82px; font-size: 12px; color: rgba(60,60,67,0.6); font-variant-numeric: tabular-nums; }
.ttx-ag-bar { flex: 0 0 4px; align-self: stretch; border-radius: 2px; background: #909090; }
.ttx-ag-title { flex: 1; font-size: 14px; color: #1c1c1e; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ttx-ag-none { color: rgba(60,60,67,0.35); font-size: 13px; padding: 4px 6px; }
@media (prefers-color-scheme: dark) {
  .ttx-ag-btn { background: #2c2c2e; color: #f2f2f7; border-color: rgba(84,84,88,0.6); }
  .ttx-ag-btn:hover { background: #3a3a3c; }
  .ttx-ag-btn.on { background: #f2f2f7; color: #1c1c1e; border-color: #f2f2f7; }
  .${OVL} { background: #1c1c1e; }
  .ttx-ag-day { border-color: rgba(84,84,88,0.5); }
  .ttx-ag-day.today { background: #2a2616; }
  .ttx-ag-dnum { color: #f2f2f7; }
  .ttx-ag-title { color: #f2f2f7; }
  .ttx-ag-ev:hover { background: #2c2c2e; }
}`;

  function ensureCss() {
    if (document.getElementById('ttx-ag-css')) return;
    const s = el('style'); s.id = 'ttx-ag-css'; s.textContent = CSS;
    document.head.appendChild(s);
  }

  const WD = ['日', '月', '火', '水', '木', '金', '土'];

  /** The calendar the URL is showing, resolved to its id via the API. */
  async function currentCalendar() {
    const alias = location.pathname.match(/\/calendars\/([^/]+)/)?.[1];
    const cals = await TTX.api.calendars();
    return cals.find((c) => c.alias_code === alias) || cals[0] || null;
  }

  let visible = false;
  let cache = null;   // { calId, raw, labels } — allEvents is heavy, don't refetch every toggle

  function overlay() {
    const main = document.querySelector('[data-test-id="calendar-main"]');
    if (!main) return null;
    let ovl = document.querySelector('.' + OVL);
    if (ovl && ovl.parentElement !== main) main.appendChild(ovl);   // React detached it — re-attach the SAME node
    if (!ovl) { ovl = el('div', OVL); ovl.hidden = true; main.appendChild(ovl); }
    return ovl;
  }

  async function render(ovl) {
    ovl.textContent = '';
    ovl.appendChild(el('div', 'ttx-ag-load', '読み込み中…'));
    let data = cache;
    try {
      const cal = await currentCalendar();
      if (!cal) throw new Error('カレンダーが見つかりません');
      if (!data || data.calId !== cal.id) {
        const [raw, labels] = await Promise.all([TTX.api.allEvents(cal.id), TTX.api.labels(cal.id)]);
        data = cache = { calId: cal.id, name: cal.name, raw, labels };
      }
    } catch (e) {
      ovl.textContent = '';
      ovl.appendChild(el('div', 'ttx-ag-empty', '読み込めませんでした：' + (e.message || e)));
      return;
    }

    const DAY = TTX.tz.DAY;
    const from = TTX.tz.ymd(Date.now(), 'Asia/Tokyo');
    const to = TTX.tz.ymd(Date.now() + 60 * DAY, 'Asia/Tokyo');
    const occs = TTX.model.occurrences(
      data.raw, TTX.tz.parseYmd(from), TTX.tz.parseYmd(to) + DAY - 1,
      { id: data.calId, name: data.name, calendar_labels: data.labels }, {},
    );
    const byDay = TTX.model.groupByDay(occs, from, to);
    const labelById = new Map((data.labels || []).map((l) => [l.id, l]));
    const today = TTX.tz.ymd(Date.now(), 'Asia/Tokyo');

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
        ev.appendChild(el('div', 'ttx-ag-time', o.allDay || o.holiday ? '終日' : o.startTime));
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
  }

  // --- the toggle button, cloned from TimeTree's own マンスリー/ウィークリー ---
  const VIEW_LABELS = ['マンスリー', 'ウィークリー'];
  let clsCache = null;   // { base:[], activeMod, inactiveMod } learned off the live pair

  const nativeViewBtns = () =>
    [...document.querySelectorAll('button')].filter((b) => VIEW_LABELS.includes((b.textContent || '').trim()));

  /** Learn base / active / inactive class names off the live pair — hardcoding
   *  the build-hash classes would break on a TimeTree redeploy; this doesn't. */
  function learnClasses(btns) {
    const [a, b] = btns;
    if (!a || !b) return;
    const A = [...a.classList], B = [...b.classList];
    const base = A.filter((c) => B.includes(c));
    const aMod = A.find((c) => !B.includes(c)) || '';
    const bMod = B.find((c) => !A.includes(c)) || '';
    const aActive = getComputedStyle(a).backgroundColor !== 'rgba(0, 0, 0, 0)';
    clsCache = { base, activeMod: aActive ? aMod : bMod, inactiveMod: aActive ? bMod : aMod };
  }

  function paint(node, active) {
    if (clsCache) node.className = [...clsCache.base, active ? clsCache.activeMod : clsCache.inactiveMod].join(' ');
  }

  /** Reflect the current view in the segment: the agenda owns the "active" look
   *  while it's up; otherwise TimeTree's own lit button stays lit (React owns it). */
  function applyState() {
    const mine = document.querySelector(`[${BTN}]`);
    if (!mine || !clsCache) return;
    paint(mine, visible);
    if (visible) nativeViewBtns().forEach((b) => paint(b, false));
  }

  function hide() {
    if (!visible) return;
    visible = false;
    const ovl = document.querySelector('.' + OVL);
    if (ovl) ovl.hidden = true;
    applyState();
  }

  async function toggle() {
    if (visible) return hide();
    visible = true;
    applyState();
    const ovl = overlay();
    if (!ovl) { visible = false; applyState(); return; }
    ovl.hidden = false;
    await render(ovl);
  }

  function ensureButton() {
    const btns = nativeViewBtns();
    if (btns.length < 2) return;
    if (btns[0].parentElement.querySelector(`[${BTN}]`)) { applyState(); return; }
    ensureCss();
    learnClasses(btns);
    const btn = btns[1].cloneNode(true);   // clone ウィークリー — inherit TimeTree's exact button
    btn.textContent = 'アジェンダ';
    btn.setAttribute(BTN, '1');
    btn.removeAttribute('aria-selected');
    btn.onclick = (e) => { e.preventDefault(); toggle(); };
    btns[1].after(btn);
    applyState();
  }

  // Clicking マンスリー/ウィークリー asks for a REAL TimeTree view: let React
  // switch to it and step the agenda aside. Delegated on the document so it
  // survives the toggle's own re-renders.
  function onNativeViewClick(e) {
    if (!visible) return;
    const b = e.target.closest?.('button');
    if (b && !b.hasAttribute(BTN) && VIEW_LABELS.includes((b.textContent || '').trim())) hide();
  }

  let observer = null;
  function start() {
    if (observer) return;
    document.addEventListener('click', onNativeViewClick, true);
    observer = new MutationObserver(() => { ensureButton(); if (visible) overlay(); });
    observer.observe(document.body, { childList: true, subtree: true });
    ensureButton();
  }
  function stop() {
    observer?.disconnect(); observer = null;
    document.removeEventListener('click', onNativeViewClick, true);
  }

  TTX.agendaview = { start, stop, _internals: { render, currentCalendar } };
})();
