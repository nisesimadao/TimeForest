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
      // Record whoever is signed in right now, so the account switcher knows this
      // account (and picks up one you just logged into). Fire-and-forget — the
      // menu re-reads on open, and a failure here must not hold up boot.
      chrome.runtime.sendMessage({ ttx: 'session', op: 'capture' }).catch(() => {});
    }
    // Everything is added INTO TimeTree's own UI — each watches the DOM and adds
    // a sibling that survives React's re-renders. This replaced a full-screen
    // drawer: the map pin, export, agenda and theme controls now live in
    // TimeTree's own toolbar and view toggle instead of a panel over the top.
    TTX.mapform?.start();     // map pin on TimeTree's own event form
    TTX.exportform?.start();  // export control on TimeTree's own toolbar
    TTX.agendaview?.start();  // agenda (list) view in TimeTree's マンスリー/ウィークリー toggle
    TTX.darktoggle?.start();  // theme toggle in TimeTree's toolbar (dark.js has no UI)
    TTX.accounts?.start();    // account switcher in TimeTree's toolbar (extension-only)
    TTX.notifytoggle?.start(); // reminders on/off in TimeTree's toolbar (extension-only)
    await TTX.dark.init();
  }

  // The app renders asynchronously; poll briefly rather than racing it.
  const tick = setInterval(() => {
    if (booted) return clearInterval(tick);
    boot();
  }, 600);
  setTimeout(() => clearInterval(tick), 30000);
  boot();

  // Toolbar button / Alt+T -> open the agenda; Alt+D -> cycle the theme.
  chrome.runtime?.onMessage?.addListener((msg) => {
    if (msg === 'ttx:agenda' && booted) TTX.agendaview?.toggle();
    if (msg === 'ttx:dark' && booted) TTX.dark.cycle();
  });
})();
