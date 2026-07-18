/* Multi-account logic for the browser client, pure so the dev server and the
 * Vercel functions share it. Accounts live in an httpOnly cookie (web/cookie.js)
 * as [{id, name, token}]; the ACTIVE account is whichever token is the live
 * tt_session. The tokens are logins — they never reach JS: listPublic() strips
 * them and the /api/accounts response only ever returns id + name. */

const sameId = (a, id) => String(a.id) === String(id);

/** Add or replace an account (keyed by id). Returns the new array. */
function upsert(accounts, acct) {
  return [...accounts.filter((a) => !sameId(a, acct.id)), { id: String(acct.id), name: acct.name, token: acct.token }];
}

/** The stored token for an account id, or null. */
function tokenOf(accounts, id) {
  const a = accounts.find((x) => sameId(x, id));
  return a ? a.token : null;
}

/** Remove an account. */
function without(accounts, id) {
  return accounts.filter((a) => !sameId(a, id));
}

/** The UI shape the renderer expects (host.accounts.list) — never any token.
 *  active account = the one whose token is the live session cookie. */
function listPublic(accounts, activeToken) {
  const active = accounts.find((a) => a.token === activeToken);
  return {
    accounts: accounts.map((a) => ({ id: String(a.id), name: a.name, email: '' })),
    activeId: active ? String(active.id) : null,
  };
}

module.exports = { upsert, tokenOf, without, listPublic };
