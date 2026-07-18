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

  const mapsOn = () => chrome.storage.local.get('maps').then((s) => !!s.maps);
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

  // Placeholder — the picker itself lands in the next step.
  function openPicker(loc) {
    console.debug('[TTX] map picker for', loc?.value);
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
    ensureButton();   // in case the form is already open
  }

  function stop() {
    observer?.disconnect();
    observer = null;
  }

  TTX.mapform = { start, stop, _internals: { tile, search, mapsOn, setMapsOn, locationField } };
})();
