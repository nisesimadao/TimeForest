/* Vercel serverless proxy: /api/tt/<api-path> -> timetreeapp.com/<api-path>, with
 * the caller's session (their httpOnly cookie on this origin) attached
 * server-side. The real work — and the /api-only, no-redirect safety — is in
 * web/proxy-core.js, shared with the local dev server.
 *
 * Routed by a vercel.json rewrite (/api/tt/(.*) -> /api/tt?__path=$1), NOT an
 * `[...path]` filesystem catch-all. Measured: under `framework: null` + a custom
 * outputDirectory, Vercel never created the catch-all route, so every /api/tt/*
 * call 404'd at the platform (the function was never reached) while the plain
 * functions (/api/connect, /api/whoami) worked. An explicit rewrite to a plain
 * function is framework-agnostic. This handler tolerates BOTH shapes — req.url
 * left as the original /api/tt/... path, OR rewritten to /api/tt?__path=... — so a
 * change in Vercel's rewrite behaviour can't silently break it again. */
const { proxy } = require('../web/proxy-core');
const { readSession } = require('../web/cookie');

/** Recover the TimeTree API path + query from whatever Vercel handed the function. */
function target(req) {
  const url = req.url || '';
  // (a) original URL preserved through the rewrite: /api/tt/api/v1/... [?query]
  if (url.startsWith('/api/tt/')) {
    const rest = url.slice('/api/tt'.length);          // "/api/v1/..." [?query] — keep the leading slash
    const qi = rest.indexOf('?');
    return { path: qi >= 0 ? rest.slice(0, qi) : rest, search: qi >= 0 ? rest.slice(qi) : '' };
  }
  // (b) rewritten to /api/tt?__path=<path>&<original query>: rebuild from params.
  const u = new URL(url, 'http://x');
  const raw = u.searchParams.get('__path')
    || (req.query && (Array.isArray(req.query.__path) ? req.query.__path.join('/') : req.query.__path))
    || '';
  u.searchParams.delete('__path');
  const qs = u.searchParams.toString();
  return { path: '/' + String(raw).replace(/^\/+/, ''), search: qs ? '?' + qs : '' };
}

module.exports = async (req, res) => {
  try {
    const session = readSession(req);
    const { path, search } = target(req);
    let body;
    if (!['GET', 'HEAD'].includes(req.method) && req.body != null) {
      // Vercel parses a JSON body into req.body; an empty body becomes {}. Treat
      // that as no body, so a body-less DELETE forwards nothing (matches dev).
      if (typeof req.body === 'string') body = req.body || undefined;
      else if (typeof req.body === 'object' && Object.keys(req.body).length === 0) body = undefined;
      else body = JSON.stringify(req.body);
    }
    const out = await proxy({ method: req.method, path, search, body, session });
    res.setHeader('content-type', out.contentType);
    res.status(out.status).send(out.text);
  } catch (e) {
    res.status(502).json({ error: 'proxy error' });   // never leak a stack
  }
};
