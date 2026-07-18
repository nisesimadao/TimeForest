/* GET /api/whoami — the connected account, or 401. Doubles as the auth check the
 * renderer runs on boot. A cookie whose session has expired is cleared. */
const { whoami } = require('../web/proxy-core');
const { readSession, serializeSession } = require('../web/cookie');

module.exports = async (req, res) => {
  try {
    const session = readSession(req);
    if (!session) return res.status(401).json({ error: 'not connected' });
    const me = await whoami(session);
    if (!me) {
      res.setHeader('Set-Cookie', serializeSession('', { secure: true }));
      return res.status(401).json({ error: 'session expired' });
    }
    res.status(200).json({ user: { id: me.id, name: me.name } });
  } catch (e) {
    res.status(502).json({ error: 'whoami failed' });
  }
};
