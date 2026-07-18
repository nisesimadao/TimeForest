/* Vercel serverless proxy: /api/tt/<anything> -> timetreeapp.com/<anything>, with
 * the caller's session (from their httpOnly cookie on this origin) attached
 * server-side. The real work is in web/proxy-core.js, shared with the local dev
 * server, so this is only the Vercel request/response adapter. */
const { proxy } = require('../../web/proxy-core');
const { readSession } = require('../../web/cookie');

module.exports = async (req, res) => {
  const session = readSession(req);
  const segs = req.query && req.query.path;
  const path = '/' + (Array.isArray(segs) ? segs.join('/') : (segs || ''));
  const qi = req.url.indexOf('?');
  const search = qi >= 0 ? req.url.slice(qi) : '';
  const body = ['GET', 'HEAD'].includes(req.method) ? undefined
    : (req.body == null ? undefined : (typeof req.body === 'string' ? req.body : JSON.stringify(req.body)));
  const out = await proxy({ method: req.method, path, search, body, session });
  res.setHeader('content-type', out.contentType);
  res.status(out.status).send(out.text);
};
