/* POST /api/disconnect — forget the session cookie. */
const { serializeSession } = require('../web/cookie');

module.exports = async (req, res) => {
  res.setHeader('Set-Cookie', serializeSession('', { secure: true }));
  res.status(200).json({ ok: true });
};
