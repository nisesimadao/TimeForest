/* Dark mode.
 *
 * The interesting finding: TimeTree already ships a complete, hand-designed
 * dark theme. It's in theme-*.css as `[data-theme=dark]:root`, with its own
 * tuned palette — including dark variants of every event label colour
 * (#2ecc87 -> #06a374, #e73b3b -> #c5031a, and so on). It is simply never
 * switched on: the app never sets the attribute, so the default
 * `:root, [data-theme=light]:root` rule always wins.
 *
 * So this file does almost nothing — it sets one attribute. That is worth far
 * more than the CSS-filter inversion this replaced. Inverting the page turned
 * 海の日 from red into salmon and 七夕 from pink into grey, which is fatal on a
 * calendar where the label colour *is* the information. TimeTree's own theme
 * keeps every colour truthful because a designer picked each dark value.
 *
 * `system` is also supported natively (the stylesheet is built with
 * lightningcss and gates on prefers-color-scheme), so we expose all three.
 */
(() => {
  const TTX = (globalThis.TTX = globalThis.TTX || {});
  const KEY = 'ttx.theme';
  const ATTR = 'data-theme';
  const MODES = ['system', 'light', 'dark'];

  const LABEL = { system: 'システムに従う', light: 'ライト', dark: 'ダーク' };
  // Names into TTX.ui.glyph (a monochrome line icon), not emoji — so the toolbar
  // button matches TimeTree's own icons instead of an OS-coloured 🌗/☀️/🌙.
  const ICON = { system: 'monitor', light: 'sun', dark: 'moon' };

  let mode = 'system';
  let observer = null;

  const media = () => window.matchMedia('(prefers-color-scheme: dark)');
  const isDark = () => (mode === 'dark' ? true : mode === 'system' ? media().matches : false);

  function assert() {
    if (document.documentElement.getAttribute(ATTR) !== mode) {
      document.documentElement.setAttribute(ATTR, mode);
    }
    // Our own injected UI (agenda / export / map) can't read data-theme through
    // @media prefers-color-scheme — that only follows the OS, so a user who
    // picks dark on a light machine would get a dark TimeTree but light overlays.
    // Mirror the EFFECTIVE theme onto a class the injected CSS keys off instead.
    document.documentElement.classList.toggle('ttx-dark', isDark());
  }

  function announce() {
    window.dispatchEvent(new CustomEvent('ttx:dark', { detail: { on: isDark(), mode } }));
  }

  function set(next, persist = true) {
    mode = MODES.includes(next) ? next : 'system';
    assert();
    if (persist) {
      try { chrome.storage?.local.set({ [KEY]: mode }); } catch { /* session-only is fine */ }
    }
    announce();
  }

  /** Cycle system -> light -> dark -> system. Returns the new mode. */
  function cycle() {
    set(MODES[(MODES.indexOf(mode) + 1) % MODES.length]);
    return mode;
  }

  async function init() {
    try {
      const v = await chrome.storage?.local.get(KEY);
      if (v && v[KEY]) mode = v[KEY];
    } catch { /* ignore */ }

    set(mode, false);

    // The SPA re-renders constantly; if it ever clears the attribute, put it back.
    observer = new MutationObserver(assert);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: [ATTR] });

    // In `system` mode the effective theme can change without us doing anything.
    media().addEventListener('change', () => { if (mode === 'system') { assert(); announce(); } });

    // Sync across tabs: another timetreeapp.com tab changing the theme writes
    // chrome.storage, which fires here. Apply it via set(..., false) so the theme
    // AND the toolbar icon follow, without re-persisting (which would loop).
    try {
      chrome.storage?.onChanged.addListener((ch, area) => {
        if (area === 'local' && ch[KEY] && ch[KEY].newValue && ch[KEY].newValue !== mode) {
          set(ch[KEY].newValue, false);
        }
      });
    } catch { /* no chrome.storage (userscript build) — a single tab, nothing to sync */ }
  }

  TTX.dark = { init, set, cycle, isDark, get mode() { return mode; }, LABEL, ICON, MODES };
})();
