/* GET /api/accounts — the connected accounts (id + name + which is active).
 * Never returns a token; those stay in the httpOnly store cookie. Lives at
 * accounts/index.js (not accounts.js) so it doesn't collide with the sibling
 * accounts/switch.js and accounts/forget.js on Vercel. */
const { readSession, readAccounts } = require('../../web/cookie');
const accountsCore = require('../../web/accounts-core');

module.exports = async (req, res) => {
  res.status(200).json(accountsCore.listPublic(readAccounts(req), readSession(req)));
};
