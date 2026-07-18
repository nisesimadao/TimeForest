/* Entry point. Boots on /calendars/<alias> and survives the SPA's
 * client-side navigation (which never reloads the page). */
(() => {
  const TTX = window.TTX;
  const onCalendarPage = () => /^\/calendars\/[^/]+/.test(location.pathname);

  let booted = false;

  async function boot() {
    if (booted || !onCalendarPage()) return;
    if (!document.querySelector('meta[name="csrf-token"]')) return; // signed out
    booted = true;
    // Route every api.js call through the background worker. In this isolated
    // world a same-origin fetch to TimeTree intermittently hangs — the identical
    // request that answers 200 once never settles the next time, contending with
    // the page's own Service Worker. The worker has no such contention, so it
    // makes the request and hands back parsed JSON. Same seam the desktop client
    // uses for its Electron transport, a different backend behind it.
    //
    // ONLY in the extension, which has a worker. The userscript build ships this
    // same content.js with no service worker (its chrome shim's runtime has no
    // sendMessage), and it never had the isolated-world hang anyway — it runs in
    // the page, where api.js's own direct fetch is fine. Same guard mapform uses.
    if (typeof chrome !== 'undefined' && typeof chrome.runtime?.sendMessage === 'function') {
      TTX.api.setTransport((path, { method, body }) =>
        chrome.runtime.sendMessage({ ttx: 'api', method, path, body }).then((r) => {
          if (!r) throw new Error('background worker did not respond');
          if (r.err) throw new Error(r.err);
          return r.json;
        }));
    }
    // The toolbar/form injections must not wait on the panel's network. They
    // only watch the DOM and add a sibling; starting them first means a slow or
    // stalled panel.init() (which loads every event before it resolves) can't
    // keep the map pin and export button from appearing.
    TTX.mapform?.start();     // map pin on TimeTree's own event form
    TTX.exportform?.start();  // export control on TimeTree's own toolbar
    await TTX.dark.init();
    await TTX.panel.init();
  }

  // The app renders asynchronously; poll briefly rather than racing it.
  const tick = setInterval(() => {
    if (booted) return clearInterval(tick);
    boot();
  }, 600);
  setTimeout(() => clearInterval(tick), 30000);
  boot();

  // Toolbar button -> toggle drawer.
  chrome.runtime?.onMessage?.addListener((msg) => {
    if (msg === 'ttx:toggle' && booted) TTX.panel.toggle();
    if (msg === 'ttx:dark' && booted) TTX.dark.toggle();
  });
})();
