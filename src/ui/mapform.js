/* Add a map pin to TimeTree's OWN event form.
 *
 * TimeTree's web form has a plain text location field and no map — you can type
 * an address but not drop a pin, and the coordinates a pin would give
 * (location_lat/lon) never get sent. The desktop client added exactly this; the
 * extension adds it to TimeTree's own form instead of a panel of our own, so it
 * looks like it was always there.
 *
 * The form is React's, so:
 *   - hooks are the hand-written ones (data-test-id, input[name]); the class
 *     names are build hashes and change on every deploy.
 *   - our injected node has to be a SIBLING, not a child of anything React
 *     re-renders — measured: a sibling survives React's re-renders, a child gets
 *     blown away.
 *   - the form appears and disappears without a page load (SPA), so we watch for
 *     it rather than run once.
 */
(() => {
  const TTX = (window.TTX = window.TTX || {});
  const MARK = 'data-ttx-mapform';

  /** Ask the background worker for a tile / a search — the content script can't
   *  reach OSM itself (page CSP, no host access). Mirrors window.host.map on
   *  desktop. */
  const bg = (msg) => new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(msg, (r) => {
      if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
      if (r?.err) return reject(new Error(r.err));
      resolve(r);
    });
  });
  const tile = (z, x, y) => bg({ ttx: 'tile', z, x, y }).then((r) => r.uri);
  const search = (q) => bg({ ttx: 'search', q }).then((r) => r.list);

  const mapsOn = () => chrome.storage.local.get('maps').then((s) => s.maps !== false);
  const setMapsOn = (on) => chrome.storage.local.set({ maps: !!on });

  /** The location field of the currently open form, or null. */
  const locationField = () =>
    document.querySelector('[data-test-id="event-form"] input[name="location"]')
    || document.querySelector('input[name="location"]');

  /** Inject once per form. The button sits right after the location row. */
  function ensureButton() {
    const loc = locationField();
    if (!loc) return;
    const row = loc.closest('div');
    if (!row || row.parentElement.querySelector(`[${MARK}]`)) return;   // already there

    const btn = document.createElement('button');
    btn.type = 'button';                 // never submit the form
    btn.setAttribute(MARK, '1');
    btn.textContent = '🗺 地図で選ぶ';
    btn.className = 'ttx-mapform-btn';
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      openPicker(loc);
    });
    row.parentElement.insertBefore(btn, row.nextSibling);
  }

  const elem = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  };

  /* Our own styles, injected once. We're a guest in TimeTree's page, so
   * everything is scoped under .ttx-mf and uses fixed positioning above their
   * z-index. Kept deliberately plain — this is a utility panel, not a place to
   * reinvent their design. */
  const CSS = `
.ttx-mapform-btn {
  display: inline-flex; align-items: center; gap: 6px;
  margin: 6px 0 2px; padding: 7px 12px;
  font: inherit; font-size: 13px; cursor: pointer;
  background: #f2f2f7; color: #1c1c1e;
  border: 1px solid rgba(60,60,67,0.29); border-radius: 8px;
}
.ttx-mapform-btn:hover { background: #e7e7ec; }
:root.ttx-dark .ttx-mapform-btn { background: #2c2c2e; color: #f2f2f7; border-color: rgba(84,84,88,0.6); }
:root.ttx-dark .ttx-mapform-btn:hover { background: #3a3a3c; }
.ttx-mf-scrim {
  position: fixed; inset: 0; z-index: 2147483000;
  background: rgba(0,0,0,0.4); display: grid; place-items: center;
  font-family: -apple-system, "Hiragino Sans", "Noto Sans JP", "Segoe UI", sans-serif;
}
.ttx-mf-card {
  width: min(560px, 94vw); max-height: 90vh; display: flex; flex-direction: column;
  background: #fff; color: #1c1c1e; border-radius: 14px; overflow: hidden;
  box-shadow: 0 12px 48px rgba(0,0,0,0.35);
}
.ttx-mf-head { padding: 13px 16px; font-size: 15px; font-weight: 600; border-bottom: 0.5px solid rgba(60,60,67,0.29); }
.ttx-mf-bar { padding: 10px 16px 8px; }
.ttx-mf-q {
  width: 100%; box-sizing: border-box; padding: 8px 11px; font: inherit; font-size: 14px;
  border: 1px solid rgba(60,60,67,0.29); border-radius: 9px; background: #f2f2f7; color: inherit;
}
.ttx-mf-results { max-height: 176px; overflow-y: auto; }
.ttx-mf-r {
  display: flex; flex-direction: column; gap: 1px; width: 100%; text-align: left;
  padding: 8px 16px; background: none; border: none; border-top: 0.5px solid rgba(60,60,67,0.16);
  cursor: pointer; font: inherit; color: inherit;
}
.ttx-mf-r:hover { background: #f2f2f7; }
.ttx-mf-r-n { font-size: 14px; }
.ttx-mf-r-a { font-size: 12px; color: rgba(60,60,67,0.6); }
.ttx-mf-box {
  position: relative; height: 300px; margin: 4px 16px; border-radius: 10px; overflow: hidden;
  background: #e8e8ec; cursor: grab; touch-action: none;
}
.ttx-mf-box.grabbing { cursor: grabbing; }
/* These two class names come from the shared src/lib/map.js, not from us — it
 * builds the tile grid as .mp-tiles with .mp-t images. Style them here so the
 * shared code needs no styling of its own. */
.mp-tiles { position: absolute; top: 0; left: 0; display: grid; }
.mp-t { display: block; width: 256px; height: 256px; }
.ttx-mf-pin {
  position: absolute; left: 50%; top: 50%; transform: translate(-50%, -100%);
  pointer-events: none; font-size: 30px; line-height: 1; z-index: 2;
  filter: drop-shadow(0 1px 2px rgba(0,0,0,0.4));
}
.ttx-mf-foot { display: flex; align-items: center; gap: 8px; padding: 11px 16px; border-top: 0.5px solid rgba(60,60,67,0.29); }
.ttx-mf-coord { font-size: 12px; color: rgba(60,60,67,0.6); font-variant-numeric: tabular-nums; }
.ttx-mf-sp { flex: 1; }
.ttx-mf-btn { padding: 7px 15px; font: inherit; font-size: 14px; cursor: pointer;
  border: 1px solid rgba(60,60,67,0.29); border-radius: 8px; background: #fff; color: inherit; }
.ttx-mf-btn.pri { background: #12a45f; color: #fff; border-color: transparent; font-weight: 600; }
:root.ttx-dark .ttx-mf-card { background: #1c1c1e; color: #f2f2f7; }
:root.ttx-dark .ttx-mf-q, :root.ttx-dark .ttx-mf-r:hover { background: #2c2c2e; }
:root.ttx-dark .ttx-mf-btn { background: #2c2c2e; border-color: rgba(84,84,88,0.6); }
:root.ttx-dark .ttx-mf-btn.pri { background: #30d158; color: #06210f; }
:root.ttx-dark .ttx-mf-r-a, :root.ttx-dark .ttx-mf-coord { color: rgba(235,235,245,0.6); }`;

  function ensureCss() {
    if (document.getElementById('ttx-mf-css')) return;
    const s = elem('style');
    s.id = 'ttx-mf-css';
    s.textContent = CSS;
    document.head.appendChild(s);
  }

  /**
   * Maps are on by default (requested). This stays as the gate so that if maps
   * are ever explicitly turned off (setMapsOn(false)), the next request re-asks
   * before talking to OSM — telling OSM roughly where the family's events are is
   * worth a confirm when it isn't already allowed.
   */
  async function ensureMaps() {
    if (await mapsOn()) return true;
    // eslint-disable-next-line no-alert
    const yes = window.confirm(
      '地図を使うと、表示する範囲を OpenStreetMap に問い合わせます'
      + '（予定の内容は送りません）。有効にしますか？',
    );
    if (yes) await setMapsOn(true);
    return yes;
  }

  /**
   * Open the picker over TimeTree's own form. Reads the location the form
   * already has; on 決定, writes the chosen text back into their <input> (so
   * their form saves it) and remembers lat/lon for the save hook to PUT — since
   * TimeTree's own POST never carries coordinates.
   */
  async function openPicker(loc) {
    if (!(await ensureMaps())) return;
    ensureCss();

    const scrim = elem('div', 'ttx-mf-scrim');
    const card = elem('div', 'ttx-mf-card');
    card.appendChild(elem('div', 'ttx-mf-head', '場所を選ぶ'));

    const bar = elem('div', 'ttx-mf-bar');
    const q = elem('input', 'ttx-mf-q');
    q.placeholder = '駅名・住所・店名で検索';
    q.value = loc.value || '';
    bar.appendChild(q);
    card.appendChild(bar);

    const results = elem('div', 'ttx-mf-results');
    card.appendChild(results);

    const box = elem('div', 'ttx-mf-box');
    const pin = elem('div', 'ttx-mf-pin', '📍');   // centre-fixed; the map moves under it
    box.appendChild(pin);
    card.appendChild(box);

    const foot = elem('div', 'ttx-mf-foot');
    const coord = elem('div', 'ttx-mf-coord');
    const cancel = elem('button', 'ttx-mf-btn', 'キャンセル');
    const use = elem('button', 'ttx-mf-btn pri', 'この場所にする');
    foot.append(coord, elem('div', 'ttx-mf-sp'), cancel, use);
    card.appendChild(foot);

    scrim.appendChild(card);
    document.body.appendChild(scrim);

    // Start on Tokyo — a world view would make the first drag meaningless.
    // (Desktop starts on the event's own lat/lon, but TimeTree's form has none.)
    const state = { lat: 35.681236, lon: 139.767125, z: 12 };
    const showCoord = () => { coord.textContent = `${state.lat.toFixed(5)}, ${state.lon.toFixed(5)}`; };
    const repaint = TTX.map.mapView(box, state, tile, showCoord);
    showCoord();
    requestAnimationFrame(repaint);

    let timer;
    q.oninput = () => {
      clearTimeout(timer);
      timer = setTimeout(async () => {
        const term = q.value.trim();
        if (term.length < 2) { results.textContent = ''; return; }
        let list = [];
        try { list = await search(term); } catch { /* offline */ }
        results.textContent = '';
        for (const r of list) {
          const b = elem('button', 'ttx-mf-r');
          b.append(elem('span', 'ttx-mf-r-n', r.name), elem('span', 'ttx-mf-r-a', r.address));
          b.onclick = () => {
            state.lat = r.lat; state.lon = r.lon; state.z = 17;
            q.value = r.name; results.textContent = '';
            showCoord(); repaint();
          };
          results.appendChild(b);
        }
      }, 350);
    };
    q.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); results.querySelector('.ttx-mf-r')?.click(); } };

    // Escape closes it — and close() removes THIS listener, whichever way the
    // picker was dismissed. The obvious version (remove the listener inside the
    // Escape branch) leaks: cancel, the scrim, and 決定 all close without ever
    // pressing Escape, so their handler stays on document, fires on the next
    // Escape anywhere on TimeTree, and calls scrim.remove() on a gone node.
    const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } };
    const close = () => {
      clearTimeout(timer);
      document.removeEventListener('keydown', onKey, true);
      scrim.remove();
    };
    cancel.onclick = close;
    use.onclick = () => {
      const text = q.value.trim();
      // Write into TimeTree's own input the way React notices — set .value then
      // dispatch input, or the field keeps its old value on save.
      setNativeValue(loc, text);
      // Remember the pin for the save hook (TimeTree's POST omits lat/lon).
      TTX.mapform._pending = { location: text, lat: state.lat, lon: state.lon };
      close();
    };
    scrim.onclick = (e) => { if (e.target === scrim) close(); };
    // Capture phase + stopPropagation so Escape closes the picker without also
    // reaching TimeTree's form (which would discard what they were typing).
    document.addEventListener('keydown', onKey, true);
    q.focus();
  }

  /* React tracks an input's value on the element's own value setter; assigning
   * input.value directly bypasses it and React overwrites us on its next
   * render. Set through the prototype setter, then dispatch input — the way a
   * user's keystroke reaches React. */
  function setNativeValue(input, value) {
    const proto = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value');
    proto?.set?.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }

  /**
   * TimeTree just created an event (inject-main.js saw the POST and sent us its
   * uuid). If the user picked a place on the map for this save, PUT the pin's
   * coordinates onto it — TimeTree's own POST carries the location text but never
   * the lat/lon. Consume the pending pin so a later save without the map doesn't
   * inherit it.
   */
  async function onCreated(e) {
    if (e.source !== window || e.data?.ttx !== 'event-created') return;
    const pending = TTX.mapform._pending;
    TTX.mapform._pending = null;
    if (!pending || !e.data.uuid || !e.data.calendarId) return;
    try {
      await TTX.api.updateEvent(e.data.calendarId, e.data.uuid, {
        location_lat: pending.lat,
        location_lon: pending.lon,
      });
    } catch { /* the event still saved with its text location; the pin is best-effort */ }
  }

  let observer = null;
  function start() {
    if (observer) return;
    // Extension only. The map needs a background service worker to reach OSM
    // (User-Agent, one-host isolation, tiles as data: URIs), and the userscript
    // build has no worker — its chrome shim stubs storage and onMessage but not
    // sendMessage. A button that hangs when pressed is worse than no button, so
    // on the phone don't offer it. (Desktop needed Electron's main for the same
    // reason.) globalThis.chrome, so a test can set it before calling start().
    if (typeof globalThis.chrome === 'undefined'
      || typeof globalThis.chrome.runtime?.sendMessage !== 'function') return;
    observer = new MutationObserver(() => ensureButton());
    observer.observe(document.body, { childList: true, subtree: true });
    window.addEventListener('message', onCreated);
    ensureButton();   // in case the form is already open
  }

  function stop() {
    observer?.disconnect();
    observer = null;
    window.removeEventListener('message', onCreated);
  }

  TTX.mapform = { start, stop, _pending: null, _internals: { tile, search, mapsOn, setMapsOn, locationField, onCreated } };
})();
