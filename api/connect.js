/* POST /api/connect { session } — verify a pasted _session_id and, if it signs
 * in, store it as an httpOnly cookie on THIS origin. The token is checked before
 * it's ever set, and it lives only in the caller's own cookie — never on disk. */
const { whoami } = require('../web/proxy-core');
const { serializeSession } = require('../web/cookie');

function tokenOf(req) {
  if (req.body && typeof req.body === 'object') return req.body.session;
  try { return JSON.parse(req.body || '{}').session; } catch { return null; }
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  const tok = (tokenOf(req) || '').toString().trim();
  if (!tok) return res.status(400).json({ error: 'トークンが空です' });
  const me = await whoami(tok);
  if (!me) return res.status(401).json({ error: 'そのトークンではログインできませんでした' });
  res.setHeader('Set-Cookie', serializeSession(tok, { secure: true }));
  res.status(200).json({ user: { id: me.id, name: me.name } });
};
