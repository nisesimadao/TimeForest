/* Add an account switcher to TimeTree's own toolbar.
 *
 * TimeTree's web app has no account switching — one browser session, one
 * account (measured: its top-right holds only search / 予定作成 / 設定 / メモ).
 * The desktop client gives each account its own Electron partition; an extension
 * shares the browser's single cookie jar, so it switches by swapping the
 * `_session_id` cookie instead. All of that lives in the service worker
 * (src/bg.js) — only it can touch cookies — and this file is just the control:
 * an icon button cloned from 設定 (so it inherits TimeTree's exact icon-button
 * shape, like the theme toggle) opening a themed popover of the known accounts.
 *
 * Clicking an account tells the worker to swap the cookie and reload; the store
 * fills itself in as you log into accounts (content.js asks for a `capture` on
 * every boot), so the menu needs no "add account" of its own — logging in with
 * another account IS adding it. Extension-only: with no worker (the userscript
 * build) there is no cookies API, so start() quietly no-ops.
 */
(() => {
  const TTX = (window.TTX = window.TTX || {});
  const MARK = 'data-ttx-acct';

  const hasWorker = () => typeof chrome !== 'undefined' && !!chrome.runtime?.sendMessage;

  const elem = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  };

  const CSS = `
.ttx-acct-wrap { position: relative; display: inline-flex; align-items: center; }
.ttx-acct-menu {
  position: absolute; top: calc(100% + 6px); right: 0; z-index: 2147483000;
  min-width: 208px; max-width: 280px; padding: 5px; background: #fff;
  border: 0.5px solid rgba(60,60,67,0.29); border-radius: 12px; box-shadow: 0 10px 34px rgba(0,0,0,0.22);
  font-family: -apple-system, "Hiragino Sans", "Noto Sans JP", "Segoe UI", sans-serif;
}
.ttx-acct-menu[hidden] { display: none; }
.ttx-acct-note { padding: 6px 10px 4px; font-size: 11px; font-weight: 600; color: rgba(60,60,67,0.5); }
.ttx-acct-row { display: flex; align-items: center; gap: 2px; border-radius: 8px; }
.ttx-acct-row:hover { background: #f2f2f7; }
.ttx-acct-pick {
  display: flex; align-items: center; gap: 8px; flex: 1 1 auto; min-width: 0;
  padding: 9px 8px 9px 10px; background: none; border: none; border-radius: 8px; cursor: pointer;
  font: inherit; font-size: 13px; color: #1c1c1e; text-align: left;
}
.ttx-acct-pick:disabled { cursor: default; }
.ttx-acct-pick .ck { flex: 0 0 14px; width: 14px; height: 14px; display: grid; place-items: center; color: var(--ttx-accent); }
.ttx-acct-pick .nm { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ttx-acct-forget {
  flex: 0 0 auto; margin-right: 5px; width: 22px; height: 22px; display: grid; place-items: center; padding: 0;
  background: none; border: none; border-radius: 6px; cursor: pointer; color: rgba(60,60,67,0.5);
  opacity: 0; transition: opacity .12s;
}
.ttx-acct-row:hover .ttx-acct-forget { opacity: 1; }
.ttx-acct-forget:hover { background: rgba(60,60,67,0.12); color: #1c1c1e; }
.ttx-acct-hint { padding: 6px 10px 4px; font-size: 11px; line-height: 1.4; color: rgba(60,60,67,0.5); }
.ttx-acct-empty { padding: 8px 10px; font-size: 12px; color: rgba(60,60,67,0.5); }
.ttx-acct-err { padding: 7px 10px; margin-top: 2px; font-size: 11px; line-height: 1.5; color: #e0335b; border-top: 0.5px solid rgba(60,60,67,0.12); }
:root.ttx-dark .ttx-acct-menu { background: #1c1c1e; border-color: rgba(84,84,88,0.6); }
:root.ttx-dark .ttx-acct-row:hover { background: #2c2c2e; }
:root.ttx-dark .ttx-acct-pick { color: #f2f2f7; }
:root.ttx-dark .ttx-acct-forget { color: rgba(235,235,245,0.5); }
:root.ttx-dark .ttx-acct-forget:hover { background: rgba(235,235,245,0.16); color: #f2f2f7; }
:root.ttx-dark .ttx-acct-note, :root.ttx-dark .ttx-acct-hint, :root.ttx-dark .ttx-acct-empty { color: rgba(235,235,245,0.5); }`;

  function ensureCss() {
    if (document.getElementById('ttx-acct-css')) return;
    const s = elem('style'); s.id = 'ttx-acct-css'; s.textContent = CSS;
    document.head.appendChild(s);
  }

  async function sessionOp(payload) {
    const r = await chrome.runtime.sendMessage({ ttx: 'session', ...payload });
    if (!r) throw new Error('background worker did not respond');
    if (r.err) throw new Error(r.err);
    return r.ok;
  }

  function accountRow(a, menu) {
    const row = elem('div', 'ttx-acct-row');
    const pick = elem('button', 'ttx-acct-pick');
    pick.type = 'button';
    const ck = elem('span', 'ck');
    if (a.active) ck.appendChild(TTX.ui.glyph('check', 13));   // monochrome, not a font ✓
    pick.append(ck, elem('span', 'nm', a.name));
    pick.disabled = !!a.active;
    pick.onclick = async () => {
      if (a.active) return;
      const nm = pick.querySelector('.nm');
      nm.textContent = '切り替え中…';
      try { await sessionOp({ op: 'switch', id: a.id }); } // worker verifies + swaps the cookie + reloads
      catch (e) {
        // Most likely the stored session expired (switching accounts means logging
        // out of one, which the server invalidates). Say so, rather than fail mute.
        nm.textContent = a.name;
        showError(menu, e.message || '切り替えできませんでした');
        console.warn('[TTX] account switch failed', e);
      }
    };
    row.appendChild(pick);
    // You can't remove the account you're currently using — switch away first.
    if (!a.active) {
      const forget = elem('button', 'ttx-acct-forget');
      forget.appendChild(TTX.ui.glyph('x', 15));   // monochrome, not a font ×
      forget.type = 'button';
      forget.title = 'このアカウントを一覧から削除';
      forget.setAttribute('aria-label', a.name + ' を一覧から削除');
      forget.onclick = async (e) => {
        e.stopPropagation();
        try { await sessionOp({ op: 'forget', id: a.id }); } catch (err) { console.warn('[TTX] forget failed', err); }
        await populate(menu);
      };
      row.appendChild(forget);
    }
    return row;
  }

  function showError(menu, msg) {
    let err = menu.querySelector('.ttx-acct-err');
    if (!err) { err = elem('div', 'ttx-acct-err'); menu.appendChild(err); }
    err.textContent = msg;   // cleared next time the menu opens (populate wipes it)
  }

  // A generation counter: rapid open→close→open (or forget→populate landing on
  // an in-flight open) starts two populate()s on the same menu, and each does a
  // clear-then-append around a sendMessage await. Without this the slower one
  // paints over the newer, or the two interleave into a doubled/stale list.
  let populateSeq = 0;
  async function populate(menu) {
    const seq = ++populateSeq;
    menu.textContent = '';
    menu.appendChild(elem('div', 'ttx-acct-note', 'アカウント'));
    let list = [], failed = false;
    try { list = (await sessionOp({ op: 'list' })) || []; } catch (e) { failed = true; }
    if (seq !== populateSeq) return;   // a newer populate now owns the menu
    menu.textContent = '';
    menu.appendChild(elem('div', 'ttx-acct-note', 'アカウント'));
    if (failed) { menu.appendChild(elem('div', 'ttx-acct-empty', '読み込めませんでした')); return; }
    if (!list.length) menu.appendChild(elem('div', 'ttx-acct-empty', 'ログイン情報を取得中…'));
    else for (const a of list) menu.appendChild(accountRow(a, menu));
    menu.appendChild(elem('div', 'ttx-acct-hint',
      '別のアカウントでログインすると自動でここに追加され、次からはパスワードなしで切り替えられます。'));
  }

  async function toggleMenu(menu) {
    if (!menu.hidden) { menu.hidden = true; return; }
    // Show first, THEN fill: populate() does a sendMessage round-trip (which can
    // wake a spun-down worker), and setting hidden=false only after that await
    // would re-open the menu even if an outside click closed it meanwhile.
    menu.hidden = false;
    await populate(menu);
  }

  function ensureButton() {
    const settings = document.querySelector('button[aria-label="設定"]');
    if (!settings) return;
    const bar = settings.parentElement;
    if (!bar || bar.querySelector(`[${MARK}]`)) return;

    ensureCss();
    const wrap = elem('div', 'ttx-acct-wrap');
    wrap.setAttribute(MARK, '1');
    const btn = settings.cloneNode(true);     // inherit TimeTree's icon-button styling
    btn.removeAttribute('data-test-id');
    btn.replaceChildren(TTX.ui.glyph('user', 20));   // monochrome icon, not an emoji
    btn.title = 'アカウント';
    btn.setAttribute('aria-label', 'アカウント');
    const menu = elem('div', 'ttx-acct-menu');
    menu.hidden = true;
    btn.onclick = (e) => { e.preventDefault(); e.stopPropagation(); toggleMenu(menu); };
    wrap.append(btn, menu);
    // left of the theme toggle if it's there, else left of 設定 — same cluster.
    (bar.querySelector('[data-ttx-theme-btn]') || settings).before(wrap);
  }

  // One document-level outside-click handler for the life of the page, resolved
  // against the LIVE menu each time. Binding it per injection (as the button is
  // re-added after every React re-render) would stack a new listener — each
  // pinning a detached wrap — for the tab's lifetime.
  let outsideBound = false;
  function bindOutside() {
    if (outsideBound) return;
    outsideBound = true;
    document.addEventListener('click', (e) => {
      const wrap = document.querySelector(`[${MARK}]`);
      const menu = wrap?.querySelector('.ttx-acct-menu');
      if (menu && !menu.hidden && !wrap.contains(e.target)) menu.hidden = true;
    });
  }

  let observer = null;
  function start() {
    if (observer || !hasWorker()) return;   // extension-only: needs the cookies-capable worker
    bindOutside();
    observer = TTX.ui.observeBody(ensureButton);   // rAF-coalesced (see ui-util.js)
  }
  function stop() { observer?.disconnect(); observer = null; }

  TTX.accounts = { start, stop };
})();
