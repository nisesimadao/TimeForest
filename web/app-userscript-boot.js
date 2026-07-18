/* Take over a logged-in timetreeapp.com page and mount the desktop UI in its
 * place. Runs after the host shim (window.host) is defined and only when signed
 * in (the build guards on the csrf meta). The renderer that follows builds into
 * #app and fetches same-origin — no proxy, no login handoff.
 *
 * TimeTree is a React SPA with global CSS, so we can't just overlay: its :root
 * variables and body rules would fight app.css. Instead we strip TimeTree's own
 * styles, clear the body to a single #app, and keep a MutationObserver on the
 * body so any node React re-mounts is removed. The csrf <meta> is preserved —
 * host.api.request reads it. */
(() => {
  // drop TimeTree's stylesheets (app.css must be the only design system)
  document.querySelectorAll('link[rel="stylesheet"], style').forEach((e) => e.remove());
  const css = document.createElement('style');
  css.id = 'ttx-app-css';
  css.textContent = typeof __TTX_APP_CSS__ === 'string' ? __TTX_APP_CSS__ : '';
  document.head.appendChild(css);

  // clear the page to just our root
  document.body.innerHTML = '<div id="app"></div>';

  // React may try to re-mount its tree; strip anything at body level that isn't
  // ours. "Ours" is #app AND the renderer's own overlays — the form, settings, the
  // detail popover, menus, confirm dialogs and toasts all append to document.body
  // (as .scrim/.d-scrim/.toast), NOT into #app. A blanket "remove everything but
  // #app" deleted them the instant they opened, which made create/edit/delete and
  // every dialog silently impossible — the userscript looked read-only. Keep them.
  const keepOurs = () => {
    for (const c of [...document.body.children]) {
      if (c.id === 'app') continue;
      if (c.matches && c.matches('.scrim, .d-scrim, .toast')) continue;
      c.remove();
    }
  };
  new MutationObserver(keepOurs).observe(document.body, { childList: true });

  // a sensible mobile viewport (TimeTree's own meta was just removed)
  if (!document.querySelector('meta[name="viewport"]')) {
    const vp = document.createElement('meta');
    vp.name = 'viewport';
    vp.content = 'width=device-width, initial-scale=1, viewport-fit=cover';
    document.head.appendChild(vp);
  }
})();
