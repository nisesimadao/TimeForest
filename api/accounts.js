/* GET /api/accounts — the connected accounts (id + name + which is active).
 * Never returns a token; those stay in the httpOnly store cookie. */
const { readSession, readAccounts } = require('../web/cookie');
const accountsCore = require('../web/accounts-core');

module.exports = async (req, res) => {
  res.status(200).json(accountsCore.listPublic(readAccounts(req), readSession(req)));
};
