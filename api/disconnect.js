/* POST /api/disconnect — forget the session cookie. Same cross-site guard as
 * connect, so a bare <img>/<form> can't force-logout the user. */
const { serializeSession, isTrustedWrite } = require('../web/cookie');

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  if (!isTrustedWrite(req)) return res.status(403).json({ error: 'bad request' });
  res.setHeader('Set-Cookie', serializeSession('', { secure: true }));
  res.status(200).json({ ok: true });
};
