/* The backend of the browser client, framework-free so the Vercel function and
 * the local dev server share ONE implementation.
 *
 * A browser page on another origin can't call timetreeapp.com — CORS blocks
 * reading the response. A server has no such limit (CORS is a browser rule), so
 * this forwards the page's /api/tt/* calls to timetreeapp.com/api/* server-side,
 * attaching the user's session. Measured with a local spike: the only things
 * TimeTree needs are the `_session_id` cookie, the csrf-token scraped from its
 * HTML shell, and the x-timetreea client tag — no other cookie, no password.
 *
 * The session token never lives on the server: it rides in the caller's own
 * httpOnly cookie on THIS origin, is read per request, forwarded, and forgotten.
 * That keeps a public deploy from becoming a pile of other people's logins. */
const ORIGIN = 'https://timetreeapp.com';
const CLIENT_TAG = 'web/2.1.0/ja';
const UA = 'Mozilla/5.0 (TimeForest web client)';

// csrf-token per session, cached in the (short-lived) instance; self-heals on 401.
const csrfCache = new Map();

async function scrapeCsrf(session) {
  const r = await fetch(`${ORIGIN}/calendars`, { redirect: 'manual', headers: { cookie: `_session_id=${session}`, 'user-agent': UA } });
  const html = await r.text();
  const m = html.match(/<meta[^>]+name=["']csrf-token["'][^>]+content=["']([^"']+)["']/i)
         || html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+name=["']csrf-token["']/i);
  return m ? m[1] : null;
}

async function csrfFor(session, force) {
  if (!force && csrfCache.has(session)) return csrfCache.get(session);
  const token = await scrapeCsrf(session);
  if (token) csrfCache.set(session, token);
  return token;
}

/** Verify a freshly-pasted token before we store it: a scrape that finds a csrf
 *  means the session is signed in. Returns the account, or null. */
async function whoami(session) {
  const csrf = await csrfFor(session, true);
  if (!csrf) return null;
  const r = await fetch(`${ORIGIN}/api/v1/user`, {
    redirect: 'manual',
    headers: { cookie: `_session_id=${session}`, 'x-csrf-token': csrf, 'x-timetreea': CLIENT_TAG, 'user-agent': UA },
  });
  if (!r.ok) return null;
  const j = await r.json().catch(() => null);
  return j?.user || null;
}

/**
 * Forward one API call. `path` is everything after /api/tt (leading slash kept),
 * and already carries the site's own /api prefix because that's what the renderer
 * asks for (api.js requests "/api/v1/calendars"), so /api/tt/api/v1/calendars ->
 * https://timetreeapp.com/api/v1/calendars — a plain pass-through, no extra /api.
 * Returns { status, contentType, text }.
 */
async function proxy({ method = 'GET', path, search = '', body, session }) {
  if (!session) return { status: 401, contentType: 'application/json', text: JSON.stringify({ error: 'not connected' }) };
  // Relay ONLY the JSON API, never arbitrary pages. This keeps the proxy from
  // reflecting authenticated TimeTree HTML (its csrf-token meta) under our own
  // origin, and bounds what a top-level GET navigation could reach.
  if (!/^\/api\/v[0-9]+\//.test(path)) {
    return { status: 404, contentType: 'application/json', text: JSON.stringify({ error: 'not an API path' }) };
  }
  const url = `${ORIGIN}${path}${search}`;
  const send = async (csrf) => fetch(url, {
    method,
    // Never follow a redirect: TimeTree API calls don't legitimately 3xx, and
    // following one would forward our headers to (and reflect the body of) the
    // redirect target. A 3xx is surfaced to the caller as-is instead.
    redirect: 'manual',
    headers: {
      cookie: `_session_id=${session}`,
      'x-csrf-token': csrf || '',
      'x-timetreea': CLIENT_TAG,
      'content-type': 'application/json',
      'user-agent': UA,
      // WRITE endpoints reject a foreign Origin with 422; set the site's own.
      origin: ORIGIN,
      referer: ORIGIN + '/',
    },
    body: body === undefined || body === '' ? undefined : body,
  });

  let r = await send(await csrfFor(session));
  if (r.status === 400 || r.status === 401 || r.status === 403) {
    r = await send(await csrfFor(session, true));   // stale csrf — refetch once
  }
  const text = await r.text();
  return { status: r.status, contentType: r.headers.get('content-type') || 'application/json', text };
}

module.exports = { proxy, whoami, csrfFor, ORIGIN, CLIENT_TAG };
