/* The browser implementation of `window.host` — the same surface the Electron
 * preload exposes (client/preload.js), so the desktop renderer runs unchanged.
 *
 * The desktop's host talks to a Node MAIN process over IPC; this one talks to
 * the SAME-ORIGIN backend (web/dev-server.js locally, Vercel functions in
 * production) over fetch. The renderer never knows the difference: it still calls
 * host.api.request / host.accounts / host.theme and gets the shapes it expects.
 *
 * Auth model: one connected account per browser (its _session_id lives in an
 * httpOnly cookie on THIS origin, never in JS). "Add account" pastes a token;
 * "remove" disconnects. Multi-account switching is a later step — for now the
 * connected session IS the account.
 */
(() => {
  const jget = (url) => fetch(url, { headers: { accept: 'application/json' } });
  const jpost = (url, body) => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) });

  // --- connect dialog: collect a _session_id the user copies from their own
  //     logged-in timetreeapp.com (it's httpOnly, so only devtools can read it). --
  function askToken() {
    return new Promise((resolve) => {
      const bk = document.createElement('div');
      bk.style.cssText = 'position:fixed;inset:0;z-index:2147483000;background:rgba(0,0,0,.45);display:flex;align-items:center;justify-content:center;font-family:-apple-system,"Hiragino Sans","Noto Sans JP",sans-serif';
      const card = document.createElement('div');
      card.style.cssText = 'background:var(--ttx-card,#fff);color:var(--ttx-fg,#111);max-width:440px;width:calc(100% - 40px);padding:22px 24px;border-radius:16px;box-shadow:0 20px 60px rgba(0,0,0,.3)';
      card.innerHTML = `
        <h2 style="margin:0 0 6px;font-size:17px">TimeTree に接続</h2>
        <p style="margin:0 0 12px;font-size:13px;line-height:1.6;opacity:.8">
          別タブで <b>timetreeapp.com</b> にログイン → 開発者ツール →
          Application → Cookies → <code>_session_id</code> の値を貼り付けてください。
          （トークンはこの端末のブラウザにだけ保存され、外部に出ません）</p>
        <input type="password" placeholder="_session_id" autocomplete="off"
          style="width:100%;box-sizing:border-box;padding:9px 11px;font:inherit;font-size:13px;border:1px solid rgba(128,128,128,.4);border-radius:9px;background:transparent;color:inherit">
        <p class="ttx-err" style="margin:8px 0 0;font-size:12px;color:#e33;min-height:16px"></p>
        <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:12px">
          <button class="ttx-cancel" style="padding:8px 14px;font:inherit;font-size:13px;border:none;border-radius:9px;background:rgba(128,128,128,.16);color:inherit;cursor:pointer">キャンセル</button>
          <button class="ttx-ok" style="padding:8px 16px;font:inherit;font-size:13px;border:none;border-radius:9px;background:#2ecc87;color:#fff;cursor:pointer">接続</button>
        </div>`;
      bk.appendChild(card);
      document.body.appendChild(bk);
      const input = card.querySelector('input');
      const err = card.querySelector('.ttx-err');
      const done = (v) => { bk.remove(); resolve(v); };
      input.focus();
      card.querySelector('.ttx-cancel').onclick = () => done(null);
      const submit = async () => {
        const token = input.value.trim();
        if (!token) return;
        err.textContent = '確認中…';
        const r = await jpost('/api/connect', { session: token }).catch(() => null);
        if (r && r.ok) return done(token);
        const j = r ? await r.json().catch(() => ({})) : {};
        err.textContent = j.error || '接続できませんでした';
      };
      card.querySelector('.ttx-ok').onclick = submit;
      input.onkeydown = (e) => { if (e.key === 'Enter') submit(); if (e.key === 'Escape') done(null); };
    });
  }

  async function currentAccount() {
    const r = await jget('/api/whoami').catch(() => null);
    if (!r || !r.ok) return null;
    const j = await r.json().catch(() => null);
    return j?.user || null;
  }

  // The renderer treats an account id as a STRING (it hashes it char-by-char for
  // the avatar colour, and compares it by ===). TimeTree's user id is a number,
  // so stringify it here or renderAccountBar throws "id is not iterable".
  const listShape = (user) => (user
    ? { accounts: [{ id: String(user.id), name: user.name || 'アカウント', email: '' }], activeId: String(user.id) }
    : { accounts: [], activeId: null });

  // --- theme: purely client-side here (no native process to tell) -------------
  const mq = window.matchMedia('(prefers-color-scheme: dark)');
  const isDark = (mode) => mode === 'dark' || (mode === 'system' && mq.matches);
  const themeCbs = [];
  mq.addEventListener('change', () => themeCbs.forEach((f) => f()));

  // --- notifications ----------------------------------------------------------
  let notifyClickCb = null;
  async function ensureNotifyPerm() {
    if (!('Notification' in window)) return false;
    if (Notification.permission === 'granted') return true;
    if (Notification.permission === 'denied') return false;
    return (await Notification.requestPermission()) === 'granted';
  }

  window.host = {
    api: {
      // (path, {method, body}) -> parsed JSON, matching api.js's transport contract
      request: async (path, opts) => {
        const r = await fetch('/api/tt' + path, {
          method: opts?.method || 'GET',
          headers: { 'content-type': 'application/json' },
          body: opts?.body === undefined ? undefined : JSON.stringify(opts.body),
        });
        const text = await r.text();
        if (!r.ok) throw new Error(`API ${r.status} ${path} ${text.slice(0, 160)}`);
        return text ? JSON.parse(text) : null;
      },
    },
    accounts: {
      list: async () => listShape(await currentAccount()),
      add: async () => {
        const token = await askToken();               // dialog already verified the token + set the cookie
        // The connect succeeded if we got a token back; base `added` on THAT, not
        // on the follow-up whoami, or a transient hiccup there would bounce a
        // genuinely-connected user back to the sign-in card.
        const me = await currentAccount().catch(() => null);
        return { ...listShape(me || (token ? { id: 'me', name: 'アカウント' } : null)), added: !!token };
      },
      switch: async () => listShape(await currentAccount()),   // single account for now
      remove: async () => { await jpost('/api/disconnect'); return { accounts: [], activeId: null }; },
      onChanged: () => {},                             // nothing changes it out from under us
    },
    auth: { check: async () => !!(await currentAccount()) },
    notify: {
      show: async ({ title, body, key } = {}) => {
        if (!(await ensureNotifyPerm())) return false;
        const n = new Notification(String(title || ''), { body: String(body || ''), tag: key || undefined });
        n.onclick = () => { window.focus(); if (notifyClickCb && key) notifyClickCb(key); n.close(); };
        return true;
      },
      onClicked: (fn) => { notifyClickCb = fn; },
    },
    autoStart: { get: async () => false, set: async () => false },   // N/A in a browser tab
    map: {
      // Tiles/search go through the same-origin backend (api/map/*), so the page
      // never talks to a tile CDN and the CSP stays shut. Tiles come back as
      // bytes and become a data: URI here — exactly the shape the desktop's map
      // lib expects (img-src 'self' data:).
      setEnabled: async () => true,
      tile: async (z, x, y) => {
        const r = await fetch(`/api/map/tile?z=${z}&x=${x}&y=${y}`);
        if (!r.ok) throw new Error('tile ' + r.status);
        const blob = await r.blob();
        return await new Promise((res, rej) => {
          const fr = new FileReader();
          fr.onload = () => res(fr.result);
          fr.onerror = () => rej(new Error('tile decode'));
          fr.readAsDataURL(blob);
        });
      },
      search: async (q) => {
        const r = await fetch('/api/map/search?q=' + encodeURIComponent(q)).catch(() => null);
        if (!r || !r.ok) return [];
        return (await r.json().catch(() => ({}))).list || [];
      },
      open: (lat, lon) => window.open(`https://www.openstreetmap.org/?mlat=${lat}&mlon=${lon}#map=17/${lat}/${lon}`, '_blank'),
    },
    theme: {
      set: async (mode) => isDark(mode),
      shouldUseDark: async () => mq.matches,
      onChanged: (fn) => { themeCbs.push(fn); },
    },
    openExternal: (url) => window.open(url, '_blank', 'noopener'),
  };
})();
