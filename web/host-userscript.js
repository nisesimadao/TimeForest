/* window.host for the userscript build of the desktop UI — the same renderer
 * (client/renderer/*), but running as a userscript ON timetreeapp.com instead of
 * on a separate hosted origin.
 *
 * Because it's same-origin, there is no CORS and no session to hand over: the
 * user is already logged into TimeTree in this very page (any method — email,
 * Google, Apple — it doesn't matter), so api.request is just a direct fetch that
 * rides the existing cookie. No proxy, no _session_id paste, no login flow. That
 * is the whole reason this exists: it's the only way a mobile user with no
 * devtools and a social login can get the desktop UI. */
(() => {
  const ORIGIN = location.origin;
  const csrf = () => (document.querySelector('meta[name="csrf-token"]') || {}).content || '';

  // Same-origin, so the token is the page's own <meta>. It can still rotate
  // server-side mid-session; on a 400/401/403 we re-scrape /calendars for a fresh
  // one — the self-heal the extension / desktop / proxy transports all do, which
  // this form was previously the only one to lack.
  let token = null;
  async function freshCsrf() {
    try {
      const r = await fetch(ORIGIN + '/calendars', { credentials: 'include' });
      const m = (await r.text()).match(/<meta[^>]+name=["']csrf-token["'][^>]+content=["']([^"']+)["']/i);
      if (m) token = m[1];
    } catch { /* keep whatever we had */ }
    return token || csrf();
  }

  const mq = window.matchMedia('(prefers-color-scheme: dark)');
  const isDark = (mode) => mode === 'dark' || (mode === 'system' && mq.matches);
  const themeCbs = [];
  mq.addEventListener('change', () => themeCbs.forEach((f) => f()));

  let notifyClickCb = null;
  async function ensureNotifyPerm() {
    if (!('Notification' in window)) return false;
    if (Notification.permission === 'granted') return true;
    if (Notification.permission === 'denied') return false;
    return (await Notification.requestPermission()) === 'granted';
  }

  async function me() {
    try {
      const r = await window.host.api.request('/api/v1/user', {});
      return r && r.user;
    } catch { return null; }
  }
  const acctList = (u) => (u
    ? { accounts: [{ id: String(u.id), name: (u.name && u.name.trim()) || ('アカウント ' + String(u.id).slice(-4)), email: '' }], activeId: String(u.id) }
    : { accounts: [], activeId: null });

  window.host = {
    api: {
      // Direct same-origin fetch — the login this page already has rides along.
      request: async (path, opts) => {
        const send = (tok) => fetch(ORIGIN + path, {
          method: (opts && opts.method) || 'GET',
          credentials: 'include',
          headers: { 'content-type': 'application/json', 'x-csrf-token': tok, 'x-timetreea': 'web/2.1.0/ja' },
          body: opts && opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
        });
        let res = await send(token || csrf());
        if (res.status === 400 || res.status === 401 || res.status === 403) res = await send(await freshCsrf());
        const text = await res.text();
        if (!res.ok) throw new Error(`API ${res.status} ${path} ${text.slice(0, 160)}`);
        return text ? JSON.parse(text) : null;
      },
    },
    // One account: whoever is logged into this timetreeapp.com session. Switching
    // means logging in/out of TimeTree itself, which is outside our reach here.
    accounts: {
      list: async () => acctList(await me()),
      add: async () => ({ accounts: [], activeId: null, added: false }),
      switch: async () => acctList(await me()),
      remove: async () => acctList(await me()),
      onChanged: () => {},
    },
    auth: { check: async () => !!(await me()) },
    notify: {
      show: async ({ title, body, key } = {}) => {
        if (!(await ensureNotifyPerm())) return false;
        const n = new Notification(String(title || ''), { body: String(body || ''), tag: key || undefined });
        n.onclick = () => { window.focus(); if (notifyClickCb && key) notifyClickCb(key); n.close(); };
        return true;
      },
      onClicked: (fn) => { notifyClickCb = fn; },
    },
    autoStart: { get: async () => false, set: async () => false },
    // Maps run through TimeTree's own page CSP here, which forbids a tile CDN, so
    // they're off in the userscript (they work in the extension / hosted client).
    map: {
      setEnabled: async () => false,
      tile: async () => { throw new Error('maps off'); },
      search: async () => [],
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
