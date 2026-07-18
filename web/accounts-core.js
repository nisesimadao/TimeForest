/* Multi-account logic for the browser client, pure so the dev server and the
 * Vercel functions share it. Accounts live in an httpOnly cookie (web/cookie.js)
 * as [{id, name, token}]; the ACTIVE account is whichever token is the live
 * tt_session. The tokens are logins — they never reach JS: listPublic() strips
 * them and the /api/accounts response only ever returns id + name. */

const MAX_ACCOUNTS = 12;   // a self-host user won't hit this; it just keeps the cookie < 4KB
const MAX_NAME = 60;
const sameId = (a, id) => String(a.id) === String(id);

/** Add or replace an account (keyed by id, IN PLACE so re-adding doesn't reorder
 *  the switcher). Name is bounded, and the store is capped so the cookie can't
 *  outgrow the browser's per-cookie limit. */
function upsert(accounts, acct) {
  const entry = { id: String(acct.id), name: String(acct.name || '').slice(0, MAX_NAME), token: acct.token };
  const i = accounts.findIndex((a) => sameId(a, entry.id));
  let next;
  if (i >= 0) { next = accounts.slice(); next[i] = entry; }
  else next = [...accounts, entry];
  return next.length > MAX_ACCOUNTS ? next.slice(next.length - MAX_ACCOUNTS) : next;
}

/** The stored token for an account id, or null. */
function tokenOf(accounts, id) {
  const a = accounts.find((x) => sameId(x, id));
  return a ? a.token : null;
}

function without(accounts, id) {
  return accounts.filter((a) => !sameId(a, id));
}

/** Remove an account. If it was the ACTIVE one, fall back to another stored
 *  account, or sign out (empty session) if none remain — same as removing the
 *  active account on the desktop. Returns the new store AND the new session. */
function forget(accounts, id, activeToken) {
  const removed = accounts.find((a) => sameId(a, id));
  const next = without(accounts, id);
  const wasActive = !!removed && removed.token === activeToken;
  const session = wasActive ? (next[0] ? next[0].token : '') : activeToken;
  return { accounts: next, session };
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

module.exports = { upsert, tokenOf, without, forget, listPublic };
