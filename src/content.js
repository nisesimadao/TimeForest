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
    await TTX.dark.init();
    await TTX.panel.init();
    // Add a map pin to TimeTree's own event form. Watches for the form rather
    // than needing it open now — the SPA opens and closes it without a reload.
    TTX.mapform?.start();
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
