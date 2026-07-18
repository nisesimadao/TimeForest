/* POST /api/accounts/switch { id } — re-point the session cookie to a stored
 * account's token. The renderer then re-syncs through the proxy with it. */
const { readAccounts, serializeSession, isTrustedWrite } = require('../../web/cookie');
const accountsCore = require('../../web/accounts-core');

function idOf(req) {
  if (req.body && typeof req.body === 'object') return req.body.id;
  try { return JSON.parse(req.body || '{}').id; } catch { return null; }
}

module.exports = async (req, res) => {
  try {
    if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
    if (!isTrustedWrite(req)) return res.status(403).json({ error: 'bad request' });
    const token = accountsCore.tokenOf(readAccounts(req), idOf(req));
    if (!token) return res.status(404).json({ error: 'unknown account' });
    res.setHeader('Set-Cookie', serializeSession(token, { secure: true }));
    res.status(200).json(accountsCore.listPublic(readAccounts(req), token));
  } catch (e) {
    res.status(502).json({ error: 'switch failed' });
  }
};
