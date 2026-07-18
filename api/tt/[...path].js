/* Vercel serverless proxy: /api/tt/<api-path> -> timetreeapp.com/<api-path>, with
 * the caller's session (from their httpOnly cookie on this origin) attached
 * server-side. The real work — and the /api-only, no-redirect safety — is in
 * web/proxy-core.js, shared with the local dev server. */
const { proxy } = require('../../web/proxy-core');
const { readSession } = require('../../web/cookie');

module.exports = async (req, res) => {
  try {
    const session = readSession(req);
    const segs = req.query && req.query.path;
    const path = '/' + (Array.isArray(segs) ? segs.join('/') : (segs || ''));
    const qi = req.url.indexOf('?');
    const search = qi >= 0 ? req.url.slice(qi) : '';
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
