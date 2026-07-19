/* Shared helpers for the toolbar/agenda injectors.
 *
 * Two things every ui/* file needs and kept re-implementing slightly differently:
 *
 *  - glyph(): a monochrome line icon, so the buttons we add match TimeTree's own
 *    minimalist toolbar instead of standing out as full-colour emoji (🔔/🌗/👤/⬇
 *    render in the OS emoji font — a different weight, colour and baseline from
 *    everything around them). Same Lucide set the desktop client uses, inlined
 *    because the content-script world has no module loader. Stroke is
 *    currentColor, so each icon takes the colour of the button it sits in.
 *
 *  - observeBody(): a body-subtree MutationObserver COALESCED to one call per
 *    animation frame. Each injector re-adds its node when React drops it, so it
 *    watches the whole document; reacting synchronously to every mutation lets a
 *    busy calendar (the weekly grid mutates constantly) drive an injector's
 *    re-append → React reconcile → re-append microtask loop that starves the main
 *    thread — the "weekly → agenda freezes" report. requestAnimationFrame caps it
 *    to ~60 calls/sec AND yields to the browser, so it can never hard-freeze. */
(() => {
  const TTX = (window.TTX = window.TTX || {});
  const NS = 'http://www.w3.org/2000/svg';

  // Lucide v1.24.0 (ISC) — the same glyphs client/renderer/icons.js bakes.
  const PATHS = {
    download: '<path d="M12 15V3"/><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m7 10 5 5 5-5"/>',
    bell: '<path d="M10.268 21a2 2 0 0 0 3.464 0"/><path d="M3.262 15.326A1 1 0 0 0 4 17h16a1 1 0 0 0 .74-1.673C19.41 13.956 18 12.499 18 8A6 6 0 0 0 6 8c0 4.499-1.411 5.956-2.738 7.326"/>',
    'bell-off': '<path d="M10.268 21a2 2 0 0 0 3.464 0"/><path d="M17 17H4a1 1 0 0 1-.74-1.673C4.59 13.956 6 12.499 6 8a6 6 0 0 1 .258-1.742"/><path d="m2 2 20 20"/><path d="M8.668 3.01A6 6 0 0 1 18 8c0 2.687.77 4.653 1.707 6.05"/>',
    sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2"/><path d="M12 20v2"/><path d="m4.93 4.93 1.41 1.41"/><path d="m17.66 17.66 1.41 1.41"/><path d="M2 12h2"/><path d="M20 12h2"/><path d="m6.34 17.66-1.41 1.41"/><path d="m19.07 4.93-1.41 1.41"/>',
    moon: '<path d="M20.985 12.486a9 9 0 1 1-9.473-9.472c.405-.022.617.46.402.803a6 6 0 0 0 8.268 8.268c.344-.215.825-.004.803.401"/>',
    monitor: '<rect width="20" height="14" x="2" y="3" rx="2"/><line x1="8" x2="16" y1="21" y2="21"/><line x1="12" x2="12" y1="17" y2="21"/>',
    user: '<path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>',
    map: '<path d="M20 10c0 4.993-5.539 10.193-7.399 11.799a1 1 0 0 1-1.202 0C9.539 20.193 4 14.993 4 10a8 8 0 0 1 16 0"/><circle cx="12" cy="10" r="3"/>',
    check: '<path d="M20 6 9 17l-5-5"/>',
    x: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
  };

  /** A 24-grid line icon at `size`px, stroke scaled to stay ~1.6px like Lucide. */
  function glyph(name, size = 20) {
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('width', size);
    svg.setAttribute('height', size);
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', (1.6 * 24 / size).toFixed(2));
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');
    svg.setAttribute('aria-hidden', 'true');
    svg.style.display = 'block';
    svg.innerHTML = PATHS[name] || '';
    return svg;
  }

  /** MutationObserver on document.body (childList+subtree), coalesced to one `fn`
   *  per frame. Runs `fn` once immediately, returns the observer (so callers keep
   *  their `stop()` = observer.disconnect()). */
  function observeBody(fn) {
    let scheduled = false;
    const run = () => { scheduled = false; try { fn(); } catch { /* keep observing */ } };
    const obs = new MutationObserver(() => {
      if (scheduled) return;
      scheduled = true;
      requestAnimationFrame(run);
    });
    obs.observe(document.body, { childList: true, subtree: true });
    fn();
    return obs;
  }

  /** A brief bottom-centre toast. Self-contained (injects its own style once) so
   *  any injector can report a failure the same way — the shared alternative to
   *  each feature swallowing errors to console or inventing its own banner. */
  let toastStyled = false;
  function toast(msg) {
    if (!toastStyled) {
      toastStyled = true;
      const s = document.createElement('style');
      s.id = 'ttx-toast-css';
      s.textContent = '.ttx-toast{position:fixed;left:50%;bottom:44px;transform:translateX(-50%);'
        + 'z-index:2147483020;background:rgba(28,28,30,0.95);color:#fff;padding:10px 18px;'
        + 'border-radius:10px;font-size:13px;box-shadow:0 10px 34px rgba(0,0,0,0.34);'
        + 'font-family:-apple-system,"Hiragino Sans","Noto Sans JP","Segoe UI",sans-serif;}';
      document.head.appendChild(s);
    }
    const t = document.createElement('div');
    t.className = 'ttx-toast';
    t.textContent = msg;
    document.body.appendChild(t);
    setTimeout(() => t.remove(), 3200);
  }

  // Shared accent tokens (light + dark) so every injected surface uses ONE green
  // instead of three slightly different hardcoded values. Injected once, up front.
  if (!document.getElementById('ttx-root-css')) {
    const s = document.createElement('style');
    s.id = 'ttx-root-css';
    s.textContent = ':root{--ttx-accent:#06a374;--ttx-accent-hover:#058863;}'
      + ':root.ttx-dark{--ttx-accent:#13b981;--ttx-accent-hover:#0f9e6e;}';
    (document.head || document.documentElement).appendChild(s);
  }

  TTX.ui = { glyph, observeBody, toast };
})();
