/* POST /api/accounts/forget { id } — drop a stored account. Removing the ACTIVE
 * one falls back to another stored account (or signs out) rather than refusing,
 * so the renderer's "remove" never reports a false success. */
const { readAccounts, readSession, serializeSession, serializeAccounts, isTrustedWrite } = require('../../web/cookie');
const accountsCore = require('../../web/accounts-core');

function idOf(req) {
  if (req.body && typeof req.body === 'object') return req.body.id;
  try { return JSON.parse(req.body || '{}').id; } catch { return null; }
}

module.exports = async (req, res) => {
  try {
    if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
    if (!isTrustedWrite(req)) return res.status(403).json({ error: 'bad request' });
    const { accounts, session } = accountsCore.forget(readAccounts(req), idOf(req), readSession(req));
    res.setHeader('Set-Cookie', [serializeAccounts(accounts, { secure: true }), serializeSession(session, { secure: true })]);
    res.status(200).json(accountsCore.listPublic(accounts, session));
  } catch (e) {
    res.status(502).json({ error: 'forget failed' });
  }
};
