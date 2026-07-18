/* Add an Export control to TimeTree's own toolbar.
 *
 * TimeTree's web app has no export at all (measured — no download/CSV/ICS
 * anywhere in its UI). The desktop client exports to Markdown / CSV / JSON /
 * ICS; this puts the same four onto 本家's toolbar, next to its search and
 * 予定作成, so it reads as a button that was always there.
 *
 * Same shape as the map pin (src/ui/mapform.js): hook a hand-written anchor
 * (data-test-id="search-field") rather than a build-hashed class, inject a
 * sibling that React won't re-render away, watch for the toolbar via a
 * MutationObserver, and never inject twice.
 *
 * Unlike the map, this opens no worker channel of its own: it just calls
 * TTX.api and downloads via a Blob. How TTX.api reaches the network is decided
 * once in content.js — api.js's direct fetch in the userscript build (no worker
 * there), the background worker in the extension — so this works in both and
 * needs no sendMessage guard here.
 */
(() => {
  const TTX = (window.TTX = window.TTX || {});
  const MARK = 'data-ttx-export';

  const elem = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  };

  const CSS = `
.ttx-exp-wrap { position: relative; display: inline-flex; }
.ttx-exp-btn {
  display: inline-flex; align-items: center; gap: 5px;
  margin-left: 8px; padding: 7px 12px; font: inherit; font-size: 13px; cursor: pointer;
  background: #f2f2f7; color: #1c1c1e; border: 1px solid rgba(60,60,67,0.29); border-radius: 8px;
}
.ttx-exp-btn:hover { background: #e7e7ec; }
.ttx-exp-menu {
  position: absolute; top: calc(100% + 4px); right: 0; z-index: 2147483000;
  min-width: 150px; padding: 4px; background: #fff; border: 0.5px solid rgba(60,60,67,0.29);
  border-radius: 10px; box-shadow: 0 8px 30px rgba(0,0,0,0.2);
  font-family: -apple-system, "Hiragino Sans", "Noto Sans JP", "Segoe UI", sans-serif;
}
.ttx-exp-menu[hidden] { display: none; }
.ttx-exp-item {
  display: flex; justify-content: space-between; gap: 12px; width: 100%; text-align: left;
  padding: 8px 10px; background: none; border: none; border-radius: 7px; cursor: pointer;
  font: inherit; font-size: 13px; color: #1c1c1e;
}
.ttx-exp-item:hover { background: #f2f2f7; }
.ttx-exp-item .k { color: rgba(60,60,67,0.5); font-size: 11px; }
.ttx-exp-note { padding: 6px 10px 4px; font-size: 11px; color: rgba(60,60,67,0.5); }
@media (prefers-color-scheme: dark) {
  .ttx-exp-btn { background: #2c2c2e; color: #f2f2f7; border-color: rgba(84,84,88,0.6); }
  .ttx-exp-btn:hover { background: #3a3a3c; }
  .ttx-exp-menu { background: #1c1c1e; border-color: rgba(84,84,88,0.6); }
  .ttx-exp-item { color: #f2f2f7; }
  .ttx-exp-item:hover { background: #2c2c2e; }
  .ttx-exp-item .k, .ttx-exp-note { color: rgba(235,235,245,0.5); }
}`;

  function ensureCss() {
    if (document.getElementById('ttx-exp-css')) return;
    const s = elem('style'); s.id = 'ttx-exp-css'; s.textContent = CSS;
    document.head.appendChild(s);
  }

  const download = (name, text, mime) => {
    const url = URL.createObjectURL(new Blob([text], { type: mime + ';charset=utf-8' }));
    const a = elem('a'); a.href = url; a.download = name;
    document.documentElement.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  };

  /** This month, in Asia/Tokyo, as YYYY-MM-DD bounds. */
  function monthRange() {
    const from = TTX.tz.ymd(Date.now(), 'Asia/Tokyo').slice(0, 8) + '01';
    const [y, m] = from.split('-').map(Number);
    const to = TTX.tz.ymd(Date.UTC(y, m, 0), 'UTC');   // last day of month
    return { from, to };
  }

  /** The calendar the URL is showing, resolved to its id via the API. */
  async function currentCalendar() {
    const alias = location.pathname.match(/\/calendars\/([^/]+)/)?.[1];
    const cals = await TTX.api.calendars();
    return cals.find((c) => c.alias_code === alias) || cals[0] || null;
  }

  async function runExport(kind) {
    const cal = await currentCalendar();
    if (!cal) throw new Error('カレンダーが見つかりません');
    const { from, to } = monthRange();
    const [raw, labels, members] = await Promise.all([
      TTX.api.allEvents(cal.id),
      TTX.api.labels(cal.id),
      TTX.api.members(cal.id),
    ]);
    const membersById = new Map((members || []).map((u) => [u.user_id ?? u.id, u]));
    // occurrences() compares against event epochs, so from/to must be instants,
    // not YYYY-MM-DD. parseYmd gives midnight; +DAY-1 makes `to` inclusive of
    // its whole last day.
    const fromMs = TTX.tz.parseYmd(from);
    const toMs = TTX.tz.parseYmd(to) + TTX.tz.DAY - 1;
    const occs = TTX.model.occurrences(raw, fromMs, toMs, { id: cal.id, name: cal.name, calendar_labels: labels }, { membersById });
    const byDay = TTX.model.groupByDay(occs, from, to);
    const title = `${cal.name} ${from}〜${to}`;
    const stem = `timetree_${from}_${to}`;

    if (kind === 'md') download(`${stem}.md`, TTX.exporters.toMarkdown(byDay, { title, skipEmpty: false }), 'text/markdown');
    else if (kind === 'csv') download(`${stem}.csv`, TTX.exporters.toCSV(occs), 'text/csv');
    else if (kind === 'json') download(`${stem}.json`, TTX.exporters.toJSON(byDay), 'application/json');
    else if (kind === 'ics') download(`${stem}.ics`, TTX.exporters.toICS(occs, { title }), 'text/calendar');
  }

  function ensureButton() {
    const search = document.querySelector('[data-test-id="search-field"]');
    if (!search) return;
    const bar = search.parentElement;
    if (!bar || bar.querySelector(`[${MARK}]`)) return;

    ensureCss();
    const wrap = elem('div', 'ttx-exp-wrap');
    wrap.setAttribute(MARK, '1');
    const btn = elem('button', 'ttx-exp-btn', '⬇ エクスポート');
    btn.type = 'button';
    const menu = elem('div', 'ttx-exp-menu');
    menu.hidden = true;
    menu.appendChild(elem('div', 'ttx-exp-note', '今月の予定を書き出し'));
    for (const [kind, label] of [['md', 'Markdown'], ['csv', 'CSV'], ['json', 'JSON'], ['ics', 'ICS (カレンダー)']]) {
      const item = elem('button', 'ttx-exp-item');
      item.type = 'button';
      item.append(elem('span', null, label), elem('span', 'k', kind.toUpperCase()));
      item.onclick = async () => {
        menu.hidden = true;
        try { await runExport(kind); } catch (e) { console.warn('[TTX] export failed', e); }
      };
      menu.appendChild(item);
    }
    btn.onclick = (e) => { e.stopPropagation(); menu.hidden = !menu.hidden; };
    document.addEventListener('click', (e) => { if (!wrap.contains(e.target)) menu.hidden = true; });
    wrap.append(btn, menu);
    bar.appendChild(wrap);
  }

  let observer = null;
  function start() {
    if (observer) return;
    observer = new MutationObserver(() => ensureButton());
    observer.observe(document.body, { childList: true, subtree: true });
    ensureButton();
  }
  function stop() { observer?.disconnect(); observer = null; }

  TTX.exportform = { start, stop, _internals: { runExport, monthRange, currentCalendar } };
})();
