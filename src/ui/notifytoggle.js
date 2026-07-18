/* Add a reminders (notifications) toggle to TimeTree's own toolbar.
 *
 * TimeTree's servers already push reminders to the user's phone; the desktop
 * client also fires them on the PC while it's open, and this brings that to the
 * browser (bg.js runs the scheduler on a chrome.alarm). This is just the switch:
 * an icon button cloned from 設定 — same as the theme and account controls — whose
 * glyph shows whether reminders are armed (🔔) or off (🔕).
 *
 * Off by default and opt-in, because it's a SECOND stream on top of TimeTree's
 * own phone notifications and only fires while Chrome is running. Extension-only:
 * with no worker (the userscript build) there's no alarms/notifications API, so
 * start() quietly no-ops. A sibling re-added by React's re-render is put back by
 * the MutationObserver, like the other injectors.
 */
(() => {
  const TTX = (window.TTX = window.TTX || {});
  const MARK = 'data-ttx-notify-btn';
  const hasWorker = () => typeof chrome !== 'undefined' && !!chrome.runtime?.sendMessage;

  let on = false;

  async function ask(op, extra) {
    try {
      const r = await chrome.runtime.sendMessage({ ttx: 'notify', op, ...extra });
      return !!(r && r.ok);
    } catch { return false; }
  }

  function paint(btn) {
    btn.textContent = on ? '🔔' : '🔕';
    btn.title = on ? '通知：オン（この端末で Chrome 起動中に鳴らす）' : '通知：オフ';
    btn.setAttribute('aria-label', btn.title);
  }

  function ensureButton() {
    const settings = document.querySelector('button[aria-label="設定"]');
    if (!settings) return;
    const bar = settings.parentElement;
    if (!bar || bar.querySelector(`[${MARK}]`)) return;
    const btn = settings.cloneNode(true);       // inherit TimeTree's icon-button styling
    btn.removeAttribute('data-test-id');
    btn.setAttribute(MARK, '1');
    btn.style.fontSize = '16px';                 // the glyph replaces an SVG; give it a size
    btn.onclick = async (e) => {
      e.preventDefault(); e.stopPropagation();
      on = await ask('set', { on: !on });
      paint(btn);
    };
    paint(btn);
    // Deterministic slot in the 設定 cluster: left of the account / theme buttons
    // if they're in yet, else left of 設定 — so the order doesn't depend on which
    // injector's observer happened to fire first.
    (bar.querySelector('[data-ttx-acct]')
      || bar.querySelector('[data-ttx-theme-btn]')
      || settings).before(btn);
  }

  let observer = null;
  async function start() {
    if (observer || !hasWorker()) return;        // extension-only
    on = await ask('get');
    // Keep the glyph honest when the flag is flipped in another tab.
    chrome.storage.onChanged.addListener((ch, area) => {
      if (area === 'local' && ch.notify) {
        on = ch.notify.newValue === true;
        const b = document.querySelector(`[${MARK}]`);
        if (b) paint(b);
      }
    });
    observer = new MutationObserver(() => ensureButton());
    observer.observe(document.body, { childList: true, subtree: true });
    ensureButton();
  }
  function stop() { observer?.disconnect(); observer = null; }

  TTX.notifytoggle = { start, stop };
})();
