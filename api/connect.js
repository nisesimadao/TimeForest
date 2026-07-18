/* POST /api/connect { session } — verify a pasted _session_id and, if it signs
 * in, store it as an httpOnly cookie on THIS origin. Guarded against cross-site
 * forgery (isTrustedWrite): only a same-origin application/json request is
 * accepted, so an attacker can't pin the victim's cookie to their own token. */
const { whoami } = require('../web/proxy-core');
const { serializeSession, isTrustedWrite } = require('../web/cookie');

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
    res.setHeader('Set-Cookie', serializeSession(tok, { secure: true }));
    res.status(200).json({ user: { id: me.id, name: me.name } });
  } catch (e) {
    res.status(502).json({ error: 'connect failed' });
  }
};
