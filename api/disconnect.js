/* POST /api/disconnect — full logout: clear the active session AND every stored
 * account. Same cross-site guard as connect, so a bare <img>/<form> can't do it. */
const { serializeSession, serializeAccounts, isTrustedWrite } = require('../web/cookie');

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  if (!isTrustedWrite(req)) return res.status(403).json({ error: 'bad request' });
  res.setHeader('Set-Cookie', [serializeSession('', { secure: true }), serializeAccounts([], { secure: true })]);
  res.status(200).json({ ok: true });
};
