/* POST /api/accounts/forget { id } — drop a stored account, but never the active
 * one (switch away first — mirrors the extension's rule). */
const { readAccounts, readSession, serializeAccounts, isTrustedWrite } = require('../../web/cookie');
const accountsCore = require('../../web/accounts-core');

function idOf(req) {
  if (req.body && typeof req.body === 'object') return req.body.id;
  try { return JSON.parse(req.body || '{}').id; } catch { return null; }
}

module.exports = async (req, res) => {
  try {
    if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
    if (!isTrustedWrite(req)) return res.status(403).json({ error: 'bad request' });
    const id = idOf(req);
    const cur = readSession(req);
    const accts = readAccounts(req);
    const target = accts.find((a) => String(a.id) === String(id));
    if (target && target.token === cur) return res.status(409).json({ error: 'active account' });
    const next = accountsCore.without(accts, id);
    res.setHeader('Set-Cookie', serializeAccounts(next, { secure: true }));
    res.status(200).json(accountsCore.listPublic(next, cur));
  } catch (e) {
    res.status(502).json({ error: 'forget failed' });
  }
};
