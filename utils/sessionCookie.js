// H2: build the minimal, non-sensitive payload that goes into the signed
// `session` cookie at login.
//
// The session cookie is client-held. Even though it is signed (tamper-evident),
// its contents are readable by the browser, so it must never carry the full
// user document — password hash, contact numbers, fee fields, every DB column
// would leak into something the client stores and every proxy/log may see.
//
// authView re-resolves the authoritative _id / role / isManager / isSuspended
// from the DATABASE on every request (keyed off the verified JWT id), so the
// cookie only ever needs a display name plus a non-privileged identity hint.
// This function is the single whitelist that decides what survives into the
// cookie; anything not listed here is dropped.

function buildSessionUser(user, fallbackRole) {
  const src = user || {};
  return {
    _id: src._id,
    name: src.name,
    role: src.role || fallbackRole,
  };
}

module.exports = { buildSessionUser };
