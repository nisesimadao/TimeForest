/* Add a theme (light / dark / system) toggle to TimeTree's own toolbar.
 *
 * TimeTree already ships a complete dark theme but exposes no way to turn it on
 * (see dark.js). dark.js flips it via the data-theme attribute; this puts a
 * visible control for it into TimeTree's toolbar, beside 設定, so it reads like
 * a setting that was always there. The button is cloned from 設定 itself, so it
 * inherits TimeTree's exact icon-button shape and hover, and only its glyph
 * (🌗/☀️/🌙 for the current mode) and label change.
 *
 * A sibling that React re-renders away is put back by a MutationObserver, the
 * same as the other injectors. The icon also follows the theme when it's changed
 * from elsewhere (the Alt+D shortcut) via the ttx:dark event dark.js dispatches.
 */
(() => {
  const TTX = (window.TTX = window.TTX || {});
  const MARK = 'data-ttx-theme-btn';

  function paint(btn) {
    const d = TTX.dark;
    if (!d) return;
    btn.replaceChildren(TTX.ui.glyph(d.ICON[d.mode] || 'monitor', 20));   // monochrome icon, not an emoji
    btn.title = 'テーマ：' + (d.LABEL[d.mode] || d.mode);
    btn.setAttribute('aria-label', btn.title);
  }

  function ensureButton() {
    if (!TTX.dark) return;
    const settings = document.querySelector('button[aria-label="設定"]');
    if (!settings) return;
    const bar = settings.parentElement;
    if (!bar || bar.querySelector(`[${MARK}]`)) return;
    const btn = settings.cloneNode(true);        // inherit TimeTree's icon-button styling
    btn.setAttribute(MARK, '1');
    btn.onclick = (e) => { e.preventDefault(); TTX.dark.cycle(); paint(btn); };
    paint(btn);
    settings.before(btn);                        // just left of 設定
  }

  let observer = null;
  function onThemeChange() {
    const b = document.querySelector(`[${MARK}]`);
    if (b) paint(b);
  }

  function start() {
    if (observer) return;
    window.addEventListener('ttx:dark', onThemeChange);
    observer = TTX.ui.observeBody(ensureButton);   // rAF-coalesced (see ui-util.js)
  }
  function stop() {
    observer?.disconnect(); observer = null;
    window.removeEventListener('ttx:dark', onThemeChange);
  }

  TTX.darktoggle = { start, stop };
})();
