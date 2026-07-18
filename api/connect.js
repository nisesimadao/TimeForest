/* POST /api/connect { session } — verify a pasted _session_id and, if it signs
 * in, add it to the connected-accounts store AND make it active. Guarded against
 * cross-site forgery (isTrustedWrite): only a same-origin application/json
 * request is accepted, so an attacker can't pin the victim's cookie to a token. */
const { whoami } = require('../web/proxy-core');
const { serializeSession, serializeAccounts, readAccounts, isTrustedWrite } = require('../web/cookie');
const accountsCore = require('../web/accounts-core');

const accountLabel = (me) => (me.name && me.name.trim()) || ('アカウント ' + String(me.id).slice(-4));
function tokenOf(req) {
  if (req.body && typeof req.body === 'object') return req.body.session;
  try { return JSON.parse(req.body || '{}').session; } catch { return null; }
}

module.exports = async (req, res) => {
  try {
    if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
    if (!isTrustedWrite(req)) return res.status(403).json({ error: 'bad request' });
    const tok = (tokenOf(req) || '').toString().trim();
    if (!tok) return res.status(400).json({ error: 'トークンが空です' });
    const me = await whoami(tok);
    if (!me) return res.status(401).json({ error: 'そのトークンではログインできませんでした' });
    const accts = accountsCore.upsert(readAccounts(req), { id: me.id, name: accountLabel(me), token: tok });
    res.setHeader('Set-Cookie', [serializeSession(tok, { secure: true }), serializeAccounts(accts, { secure: true })]);
    res.status(200).json({ user: { id: me.id, name: me.name } });
  } catch (e) {
    res.status(502).json({ error: 'connect failed' });
  }
};
