/* Cookie parse/serialize, shared by the dev server and the Vercel functions so
 * both handle the session cookie identically (and the dev-server E2E exercises
 * the same code the deployment runs). Zero-dep. */

/** "a=1; b=2" -> { a: '1', b: '2' } (values URL-decoded). */
function parse(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    if (!k) continue;
    try { out[k] = decodeURIComponent(part.slice(i + 1).trim()); } catch { out[k] = part.slice(i + 1).trim(); }
  }
  return out;
}

const SESSION = 'tt_session';
const ACCOUNTS = 'tt_accounts';   // httpOnly JSON [{id,name,token}] — the multi-account store

/** The Set-Cookie for the session token. `secure` off for http://localhost (dev),
 *  on for the https deployment. An empty value expires it (disconnect). */
function serializeSession(value, { secure = true } = {}) {
  const base = `${SESSION}=${value ? encodeURIComponent(value) : ''}; HttpOnly; SameSite=Lax; Path=/`;
  const life = value ? `; Max-Age=${60 * 60 * 24 * 30}` : '; Max-Age=0';
  return base + (secure ? '; Secure' : '') + life;
}

const readSession = (req) => parse(req.headers && req.headers.cookie)[SESSION] || null;

/** The connected-accounts store as an array (tokens included; never sent to JS —
 *  the /api/accounts response strips them). Empty on a malformed/absent cookie. */
function readAccounts(req) {
  const raw = parse(req.headers && req.headers.cookie)[ACCOUNTS];
  if (!raw) return [];
  try { const v = JSON.parse(raw); return Array.isArray(v) ? v : []; } catch { return []; }
}

/** Set-Cookie for the accounts store. httpOnly like the session — the tokens it
 *  holds are logins. An empty array expires it. */
function serializeAccounts(list, { secure = true } = {}) {
  const arr = Array.isArray(list) ? list : [];
  const base = `${ACCOUNTS}=${arr.length ? encodeURIComponent(JSON.stringify(arr)) : ''}; HttpOnly; SameSite=Lax; Path=/`;
  const life = arr.length ? `; Max-Age=${60 * 60 * 24 * 30}` : '; Max-Age=0';
  return base + (secure ? '; Secure' : '') + life;
}

/* CSRF guard for the state-changing endpoints (connect / disconnect / account
 * switch|forget). Our own client always sends them as a same-origin fetch with
 * content-type application/json — a cross-site page can set neither the JSON
 * content-type (it forces a CORS preflight we never grant) nor a matching Origin.
 * Require BOTH: a JSON content-type AND an Origin whose host equals the request's
 * Host. A browser POST always carries an Origin, so demanding it (rather than
 * only checking it when present) is what makes the guard real. */
function isTrustedWrite(req) {
  const h = req.headers || {};
  if (!/application\/json/i.test(h['content-type'] || '')) return false;
  if (!h.origin) return false;
  try { return new URL(h.origin).host === h.host; } catch { return false; }
}

module.exports = { parse, serializeSession, readSession, serializeAccounts, readAccounts, isTrustedWrite, SESSION, ACCOUNTS };
