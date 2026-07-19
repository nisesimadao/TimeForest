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
  position: fixed; z-index: 100; overflow-y: auto;   /* placed over the calendar box; see place() */
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
.ttx-ag-ev { display: flex; align-items: flex-start; gap: 9px; padding: 5px 6px; border-radius: 7px; }
.ttx-ag-ev.clickable { cursor: pointer; }
.ttx-ag-ev:hover { background: #f4f4f4; }
.ttx-ag-time { flex: 0 0 90px; font-size: 12px; color: #8f8f8f; font-variant-numeric: tabular-nums; padding-top: 1px; }
.ttx-ag-bar { flex: 0 0 4px; align-self: stretch; border-radius: 2px; background: #909090; }
.ttx-ag-main { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 1px; }
.ttx-ag-title { font-size: 14px; color: #212121; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ttx-ag-meta { font-size: 12px; color: #8f8f8f; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ttx-ag-av { display: inline-grid; place-items: center; border-radius: 50%; overflow: hidden; flex: none; align-self: center; color: #fff; font-weight: 600; line-height: 1; }
.ttx-ag-av img { width: 100%; height: 100%; object-fit: cover; display: block; }
.ttx-ag-d-author { display: flex; align-items: center; gap: 7px; }
/* detail card */
.ttx-ag-dscrim { position: fixed; inset: 0; z-index: 2147483001; background: rgba(0,0,0,0.28); display: flex; align-items: center; justify-content: center; }
.ttx-ag-detail { background: #fff; color: #212121; width: min(420px, calc(100vw - 40px)); max-height: 80vh; overflow-y: auto; border-radius: 14px; box-shadow: 0 18px 60px rgba(0,0,0,0.32); padding: 18px 20px; }
.ttx-ag-d-head { display: flex; align-items: center; gap: 8px; margin-bottom: 12px; }
.ttx-ag-d-dot { flex: 0 0 10px; width: 10px; height: 10px; border-radius: 3px; }
.ttx-ag-d-title { font-size: 17px; font-weight: 700; overflow-wrap: anywhere; }
.ttx-ag-d-row { display: flex; gap: 12px; padding: 5px 0; font-size: 13px; }
.ttx-ag-d-k { flex: 0 0 68px; color: #8f8f8f; }
.ttx-ag-d-v { flex: 1; min-width: 0; overflow-wrap: anywhere; }
.ttx-ag-d-note { white-space: pre-wrap; }
.ttx-ag-d-link { color: #06a374; text-decoration: none; }
.ttx-ag-d-hint { margin-top: 12px; font-size: 11px; color: #a0a0a0; }
.ttx-ag-d-edit { margin-top: 15px; width: 100%; padding: 10px 12px; border: none; border-radius: 10px; background: #06a374; color: #fff; font-size: 14px; font-weight: 600; cursor: pointer; font-family: inherit; }
.ttx-ag-d-edit:hover { background: #058863; }
:root.ttx-dark .${OVL} { background: #0f0f0f; }
:root.ttx-dark .ttx-ag-day { border-color: #363636; }
:root.ttx-dark .ttx-ag-day.today { background: #2a2616; }
:root.ttx-dark .ttx-ag-dnum, :root.ttx-dark .ttx-ag-title { color: #fff; }
:root.ttx-dark .ttx-ag-load, :root.ttx-dark .ttx-ag-empty, :root.ttx-dark .ttx-ag-time, :root.ttx-dark .ttx-ag-meta { color: #707070; }
:root.ttx-dark .ttx-ag-ev:hover { background: #2c2c2c; }
:root.ttx-dark .ttx-ag-detail { background: #1c1c1e; color: #f2f2f5; }
:root.ttx-dark .ttx-ag-d-title { color: #fff; }
:root.ttx-dark .ttx-ag-d-k, :root.ttx-dark .ttx-ag-d-hint { color: #8a8a8a; }`;

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
  let closeDetail = null; // closes the open event-detail card (and removes its keydown listener); null when none

  // ---- overlay ----
  // The calendar box the agenda covers. `calendarOutline-mainUi` is present in BOTH
  // monthly and weekly (monthly's `calendar-main` is NOT — keying on it left the
  // agenda unable to open from weekly), and it sits below the toolbar (top≈60 vs the
  // view tabs' bottom≈46), so covering it never hides the tabs.
  const calBox = () => document.querySelector('[data-test-id="calendarOutline-mainUi"]');

  /** Size/position the body-level, position:fixed overlay onto the calendar box.
   *  false when there's nothing to cover (a non-calendar page). */
  function place(ovl) {
    const box = calBox();
    if (!box) return false;
    const r = box.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return false;
    ovl.style.top = r.top + 'px';
    ovl.style.left = r.left + 'px';
    ovl.style.width = r.width + 'px';
    ovl.style.height = r.height + 'px';
    return true;
  }

  // Mount on document.body, NOT inside the calendar container. TimeTree re-renders
  // the calendar subtree constantly (the weekly grid especially), and a foreign
  // child there gets detached mid-render — which left the agenda stuck on
  // 「読み込み中」 in weekly (measured). A body-level node React never owns can't be
  // detached; place() keeps it aligned to the calendar box.
  function overlay() {
    let ovl = document.querySelector('.' + OVL);
    if (!ovl) { ovl = el('div', OVL); ovl.hidden = !visible; document.body.appendChild(ovl); }
    if (!place(ovl)) { ovl.hidden = true; return null; }
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
    const [raw, labels, mem, members] = await Promise.all([
      TTX.api.allEvents(cal.id),
      TTX.api.labels(cal.id),
      TTX.api.memorialdays(lo, hi).catch(() => []),   // public holidays, like the month grid shows
      TTX.api.members(cal.id).catch(() => []),         // to name the creator of each event
    ]);
    return { alias, calId: cal.id, name: cal.name, raw, labels, mem, members };
  }

  /** Compute occurrences and paint the list from a data object — pure DOM, no
   *  network, so it's instant on a cached re-open. */
  function buildDOM(ovl, data) {
    const { from, to, lo, hi } = range();
    // Key by user_id, NOT the membership-row id: author_id / attendees reference
    // user_id (matches client/renderer/store.js and exportform.js). Keying by id
    // silently misses every lookup — author/attendee names blank on shared calendars.
    const membersById = new Map((data.members || []).map((m) => [m.user_id ?? m.id, m]));
    const multiMember = membersById.size > 1;   // naming the creator only helps on a shared calendar
    const occs = TTX.model
      .occurrences(data.raw, lo, hi, { id: data.calId, name: data.name, calendar_labels: data.labels }, { membersById })
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
        const main = el('div', 'ttx-ag-main');
        main.appendChild(el('div', 'ttx-ag-title', o.title || '(無題)'));
        // The stuff the bare title never showed — what the month grid / a tap on the
        // event would tell you: where, who's going, who added it, whether it has a memo.
        if (!o.holiday) {
          const bits = [];
          if (o.location) bits.push(o.location);
          if (o.attendees && o.attendees.length) bits.push(o.attendees.length + '人');
          if (o.note) bits.push('メモ');
          if (multiMember && o.authorName) bits.push(o.authorName);
          if (bits.length) main.appendChild(el('div', 'ttx-ag-meta', bits.join('　·　')));
        }
        ev.appendChild(main);
        if (!o.holiday && multiMember && o.authorId != null) {
          ev.appendChild(avatar(membersById.get(o.authorId), 18));   // who added it, at a glance
        }
        if (!o.holiday) {                       // holidays aren't real events — nothing to open
          ev.classList.add('clickable');
          ev.onclick = () => openDetail(o, lb, data.name, membersById);
        }
        list.appendChild(ev);
      }
      row.append(date, list);
      frag.appendChild(row);
    }
    ovl.textContent = '';
    if (!shown) ovl.appendChild(el('div', 'ttx-ag-empty', 'この先60日に予定はありません'));
    else ovl.appendChild(frag);
    ovl.dataset.rendered = '1';
    ovl.dataset.alias = data.alias || '';   // which calendar this paint is for (see ensureShown)
  }

  const fmtDate = (key) => `${+key.slice(5, 7)}/${+key.slice(8)}(${WD[new Date(key + 'T00:00:00Z').getUTCDay()]})`;

  /** A member's avatar: their badge image, or their initial on a coloured disc.
   *  `badge` is TimeTree's own avatar URL (on its asset host, which the page CSP
   *  already allows); empty on a member who never set a photo. */
  const AV_COLORS = ['#2ecc87', '#47b2f7', '#f35f8c', '#fdc02d', '#b38bdc', '#3dc2c8'];
  function avatar(member, size) {
    const av = el('span', 'ttx-ag-av');
    av.style.width = av.style.height = size + 'px';
    if (member && member.badge) {
      const img = document.createElement('img');
      img.src = member.badge; img.alt = ''; img.loading = 'lazy';
      av.appendChild(img);
    } else {
      const nm = ((member && member.name) || '').trim();
      av.textContent = nm ? [...nm][0] : '?';
      av.classList.add('initials');
      av.style.fontSize = Math.round(size * 0.5) + 'px';
      let h = 0; for (const c of (nm || '?')) h = (h * 31 + c.charCodeAt(0)) >>> 0;
      av.style.background = AV_COLORS[h % AV_COLORS.length];
    }
    return av;
  }

  /** A read-only detail card for an agenda event — everything the bare row can't
   *  show (where / who / memo / url). Editing still happens in TimeTree itself, so
   *  the card names that rather than pretend to be an editor. */
  function openDetail(o, lb, calName, membersById) {
    if (closeDetail) closeDetail();   // close+unbind any card already open (never stack listeners)
    const scrim = el('div', 'ttx-ag-dscrim');
    const card = el('div', 'ttx-ag-detail');

    const head = el('div', 'ttx-ag-d-head');
    const dot = el('span', 'ttx-ag-d-dot');
    dot.style.background = lb ? TTX.api.colorHex(lb.color) : '#909090';
    head.append(dot, el('span', 'ttx-ag-d-title', o.title || '(無題)'));
    card.appendChild(head);

    const row = (k, v) => {
      if (v == null || v === '') return;
      const r = el('div', 'ttx-ag-d-row');
      const vv = typeof v === 'string' ? el('div', 'ttx-ag-d-v', v) : v;
      if (typeof v !== 'string') vv.classList.add('ttx-ag-d-v');
      r.append(el('div', 'ttx-ag-d-k', k), vv);
      card.appendChild(r);
    };

    const when = o.allDay
      ? (o.startKey === o.endKey ? `${fmtDate(o.startKey)} 終日` : `${fmtDate(o.startKey)} 〜 ${fmtDate(o.endKey)} 終日`)
      : (o.startKey === o.endKey ? `${fmtDate(o.startKey)} ${o.startTime}〜${o.endTime}` : `${fmtDate(o.startKey)} ${o.startTime} 〜 ${fmtDate(o.endKey)} ${o.endTime}`);
    row('日時', when);
    row('カレンダー', calName);
    if (lb && TTX.api.labelName) row('ラベル', TTX.api.labelName(lb));
    if (o.location) {
      const v = el('div', 'ttx-ag-d-v', o.location);
      if (Number.isFinite(o.lat) && Number.isFinite(o.lon)) {
        const a = el('a', 'ttx-ag-d-link', '　地図で開く');
        a.href = `https://www.openstreetmap.org/?mlat=${o.lat}&mlon=${o.lon}#map=17/${o.lat}/${o.lon}`;
        a.target = '_blank'; a.rel = 'noopener';
        v.appendChild(a);
      }
      row('場所', v);
    }
    if (o.attendees && o.attendees.length) {
      row('参加者', o.attendees.map((a) => membersById.get(a && a.id != null ? a.id : a)?.name || (a && a.name) || '？').join('、'));
    }
    if (o.authorName) {
      const who = el('div', 'ttx-ag-d-author');
      who.append(avatar(membersById.get(o.authorId), 22), el('span', null, o.authorName));
      row('作成者', who);
    }
    if (o.note) row('メモ', el('div', 'ttx-ag-d-note', o.note));
    if (o.url) {
      const a = el('a', 'ttx-ag-d-link', o.url);
      a.href = o.url; a.target = '_blank'; a.rel = 'noopener';
      row('URL', a);
    }
    // Editing stays 100% TimeTree: this drives the app's own UI rather than
    // reimplement its editor — opens the native event sidebar and its 編集 form.
    const editBtn = el('button', 'ttx-ag-d-edit', '本家で編集');
    editBtn.onclick = () => { if (closeDetail) closeDetail(); openInHonke(o, true); };
    card.appendChild(editBtn);

    scrim.appendChild(card);
    document.body.appendChild(scrim);
    const close = () => { scrim.remove(); document.removeEventListener('keydown', onKey); closeDetail = null; };
    const onKey = (e) => { if (e.key === 'Escape') close(); };
    scrim.onclick = (e) => { if (e.target === scrim) close(); };
    document.addEventListener('keydown', onKey);
    closeDetail = close;
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
    if (rendering) return;
    // Already showing the calendar that's on screen — nothing to do. But TimeTree
    // switches calendars by changing /calendars/<alias> with NO reload, and this
    // body-level overlay (React doesn't own it) survives that; without the alias
    // check a switch would leave A's events showing while the URL is B — and then
    // a row click would drive openInHonke against B's grid. So on a mismatch, fall
    // through and re-render for the calendar now on screen.
    if (ovl.dataset.rendered && ovl.dataset.alias === currentAlias()) return;
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
    // Which one is lit? Prefer the explicit aria-selected; else the tab with the
    // solid (non-transparent) background is active. Assuming "a" is lit whenever
    // its bg is merely non-transparent breaks if the INACTIVE tab has a subtle
    // fill, so compare the two and only decide when exactly one is solid.
    const solid = (c) => c && c !== 'rgba(0, 0, 0, 0)' && c !== 'transparent';
    const aAria = a.getAttribute('aria-selected'), bAria = b.getAttribute('aria-selected');
    let aActive;
    if (aAria === 'true' || bAria === 'true') aActive = aAria === 'true';
    else {
      const aS = solid(getComputedStyle(a).backgroundColor), bS = solid(getComputedStyle(b).backgroundColor);
      aActive = aS && !bS ? true : bS && !aS ? false : true;   // ambiguous → マンスリー (the default view)
    }
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
    if (closeDetail) closeDetail();   // don't leave a detail card floating once the agenda is gone
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
    // Couldn't mount (no container): RESTORE the view tabs we just greyed, or they
    // stay dead until the user clicks マンスリー. hide(null) re-lights `underlying`.
    if (!ovl) return hide(null);
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

  // Keep the body-level overlay aligned to the calendar box when the window resizes
  // (the observer catches DOM-driven layout shifts; resize fires no mutation).
  const onResize = () => { if (!visible) return; const o = document.querySelector('.' + OVL); if (o) place(o); };

  let observer = null;
  function start() {
    if (observer) return;
    document.addEventListener('click', onNativeViewClick, true);
    window.addEventListener('resize', onResize);
    // rAF-coalesced: each mutation would otherwise re-run ensureButton/ensureShown
    // synchronously, and on a busy calendar the weekly grid's constant re-renders
    // could drive that fast enough to jank the tab.
    observer = TTX.ui.observeBody(() => { ensureButton(); if (visible) ensureShown(); });
  }
  function stop() {
    observer?.disconnect(); observer = null;
    document.removeEventListener('click', onNativeViewClick, true);
    window.removeEventListener('resize', onResize);
  }

  // ---- open the event in TimeTree's own event sidebar ------------------------
  // Editing stays entirely in TimeTree: rather than reimplement its editor, drive
  // its UI. Clicking a month-grid chip opens data-test-id="event-detail" (a
  // right-hand sidebar); its メニュー → 編集 is the native edit form. So: switch to
  // monthly, page to the event's month (the calendar-pagination label + 前月/翌月),
  // match the chip by title within its date cell, click it, then advance to 編集.
  // Stable test-ids (event-detail, calendar-pagination) and structure carry this —
  // the chip's own class is a build hash and is never relied on.
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  async function waitFor(fn, timeout) {
    const t0 = Date.now();
    for (;;) { const v = fn(); if (v) return v; if (Date.now() - t0 > timeout) return null; await sleep(90); }
  }

  const toast = (msg) => TTX.ui.toast(msg);   // shared toast (ui-util.js)

  const EN_MONTH = { january: 1, february: 2, march: 3, april: 4, may: 5, june: 6, july: 7, august: 8, september: 9, october: 10, november: 11, december: 12 };
  /** The month currently on screen, read from the calendar-pagination label
   *  ("…2026年7月" or "July 2026"). null when it can't be parsed. */
  function shownMonth() {
    const p = document.querySelector('[data-test-id="calendar-pagination"]');
    const t = p ? (p.textContent || '') : '';
    let m = t.match(/(\d{4})\s*年\s*(\d{1,2})\s*月/);
    if (m) return { y: +m[1], m: +m[2] };
    m = t.match(/([A-Za-z]+)\s+(\d{4})/);
    if (m && EN_MONTH[m[1].toLowerCase()]) return { y: +m[2], m: EN_MONTH[m[1].toLowerCase()] };
    return null;
  }

  /** Make TimeTree show the month grid (needed for chips + month paging). Clicking
   *  マンスリー is a real React click, so it also switches the view when weekly. */
  function ensureMonthly() {
    if (document.querySelector('[data-test-id="monthly-calendar"]')) return true;
    const b = nativeViewBtns().find((x) => ['マンスリー', 'Monthly'].includes((x.textContent || '').trim()));
    if (b) { b.click(); return true; }
    return false;
  }

  /** Page the grid to (y, mo) by clicking 前月/翌月 the computed number of times,
   *  re-reading the label each step so it stops exactly on target. */
  async function navToMonth(y, mo) {
    for (let i = 0; i < 30; i++) {
      const cur = shownMonth();
      if (!cur) return false;
      const at = cur.y * 12 + cur.m;
      const target = y * 12 + mo;
      if (at === target) return true;
      const aria = at < target ? ['翌月', 'Next month'] : ['前月', 'Previous month'];
      const btn = [...document.querySelectorAll('button')].find((b) => aria.includes(b.getAttribute('aria-label') || ''));
      if (!btn) return false;
      btn.click();
      // Wait for the label to ACTUALLY change rather than race a fixed delay — a
      // slow re-render would otherwise be re-read as the old month and clicked
      // again, overshooting and oscillating. Give up the step if it never moves.
      if (!(await waitFor(() => { const s = shownMonth(); return s && (s.y * 12 + s.m) !== at; }, 1800))) return false;
    }
    const c = shownMonth();
    return !!c && (c.y * 12 + c.m) === (y * 12 + mo);
  }

  const ownText = (n) => [...n.childNodes].filter((c) => c.nodeType === 3).map((c) => c.textContent.trim()).join('');

  /** The grid's date-number cells: {d, x (left), y (top), dim}. `dim` marks an
   *  adjacent-month day — TimeTree renders the tail of the previous month and the
   *  head of the next, faded — so a repeated day-number can prefer the in-month one. */
  function dateCells(grid) {
    const out = [];
    for (const n of grid.querySelectorAll('*')) {
      const t = ownText(n);
      if (!/^\d{1,2}$/.test(t)) continue;
      const r = n.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) continue;
      out.push({ d: +t, x: r.left, y: r.top, dim: parseFloat(getComputedStyle(n).opacity) < 0.9 });
    }
    return out;
  }

  /** The date cell a chip sits in — the numeric label nearest above it in the same
   *  column — or null. Keys off the chip's LEFT edge (so a multi-day bar resolves to
   *  its START cell) with a column-relative tolerance (so zoom can't bleed into the
   *  neighbouring column). */
  function chipCell(chip, cells, colW) {
    const r = chip.getBoundingClientRect();
    const x = r.left + 6;
    const tol = Math.max(28, colW * 0.5);
    let best = null;
    for (const c of cells) {
      if (c.y > r.top + 2) continue;             // the date number sits above its events
      if (Math.abs(c.x - x) > tol) continue;      // same column
      if (!best || c.y > best.y) best = c;         // nearest one above
    }
    return best;
  }

  /** The month-grid chip for occurrence o. Matched by title AND the day-cell it
   *  sits in — title alone is ambiguous for daily/recurring events, and a lone
   *  title match on the WRONG day must not open a different event. Same-title,
   *  same-day collisions are split by start time, then by preferring the in-month
   *  cell. null when the event isn't on the grid (filtered calendar, overflow). */
  function findChip(o) {
    const grid = document.querySelector('[data-test-id="monthly-calendar"]');
    if (!grid || !o.title) return null;
    const day = +o.startKey.slice(8, 10);
    const cells = dateCells(grid);
    const colW = grid.getBoundingClientRect().width / 7;
    const chips = [...grid.querySelectorAll('button')].filter((b) => {
      const t = (b.textContent || '').trim(); const r = b.getBoundingClientRect();
      return t && !/^\d{1,2}$/.test(t) && r.height >= 8 && r.height <= 34 && r.width >= 20 && r.top >= 118;
    });
    let matches = chips
      .map((b) => ({ b, cell: chipCell(b, cells, colW) }))
      .filter((m) => m.cell && m.cell.d === day && (m.b.textContent || '').includes(o.title));
    if (!matches.length) return null;             // wrong day / not on grid — DON'T open a stray event
    if (matches.length > 1 && !o.allDay && o.startTime) {
      // chip shows "9:00" / "15:20"; o.startTime is zero-padded "09:00".
      const hm = o.startTime, hm2 = o.startTime.replace(/^0(?=\d:)/, '');
      const timed = matches.filter((m) => { const t = m.b.textContent || ''; return t.includes(hm) || t.includes(hm2); });
      if (timed.length) matches = timed;
    }
    if (matches.length > 1) {
      const inMonth = matches.filter((m) => !m.cell.dim);   // adjacent-month day carries the same number
      if (inMonth.length) matches = inMonth;
    }
    return matches[0].b;
  }

  /** From an open event-detail sidebar, advance to the native edit form via
   *  メニュー → 編集. false (leaving the sidebar open) on any miss. */
  async function openEditorInHonke() {
    const detail = document.querySelector('[data-test-id="event-detail"]');
    if (!detail) return false;
    const menu = [...detail.querySelectorAll('button')].find((b) => /メニュー|Menu/.test((b.textContent || '').trim() || b.getAttribute('aria-label') || ''));
    if (!menu) return false;
    menu.click();
    // The menu items (編集 / コピー / 削除) render in a portal; match by exact label
    // across the shapes TimeTree uses, then click the clickable ancestor-or-self.
    const edit = await waitFor(() => [...document.querySelectorAll('button, [role=menuitem], [role=button], a, li')].find((x) => /^(編集|Edit)$/.test((x.textContent || '').trim())), 1600);
    if (!edit) return false;
    (edit.closest('button, [role=menuitem], [role=button], a') || edit).click();
    return true;
  }

  /** Route an agenda event into TimeTree's own event UI. edit=true advances to the
   *  native editor; on any miss it leaves the detail sidebar open, so the user is
   *  always left inside TimeTree, never stranded. (A test seam skips the final 編集
   *  click so E2E never opens a real edit form.) */
  async function openInHonke(o, edit) {
    hide(null);                                   // drop the agenda overlay so the grid is clickable
    // Test seam: read-only E2E must never open a real edit form on a live family
    // calendar. Gated on our own data-ttx-* attribute, which TimeTree never sets,
    // so it is inert in production.
    if (document.documentElement.hasAttribute('data-ttx-test-noedit')) edit = false;
    if (!ensureMonthly()) { toast('本家のマンスリーを開けませんでした'); return; }
    if (!(await waitFor(() => document.querySelector('[data-test-id="monthly-calendar"]'), 3000))) { toast('本家のマンスリーを開けませんでした'); return; }
    if (!(await navToMonth(+o.startKey.slice(0, 4), +o.startKey.slice(5, 7)))) { toast('本家グリッドで対象月を開けませんでした'); return; }
    await sleep(220);
    const chip = await waitFor(() => findChip(o), 1600);
    if (!chip) { toast('該当の予定が本家グリッドに見つかりませんでした'); return; }
    chip.click();
    if (!(await waitFor(() => document.querySelector('[data-test-id="event-detail"]'), 3000))) { toast('本家の予定を開けませんでした'); return; }
    if (edit) await openEditorInHonke();
  }

  TTX.agendaview = { start, stop, toggle, _internals: { render, currentCalendar, findChip, openInHonke } };
})();
