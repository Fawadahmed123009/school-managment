const TestSession = require("../models/Academic/testSession.model");

// Sort sentinels: a test missing a session/phase/week sinks to the bottom of
// its own group instead of mixing in with the categorised ones.
const SESSIONS_UNRANKED = 1e9;
const PHASES_UNRANKED = 1e9;
const WEEKS_UNRANKED = 8.64e15; // epoch-ms far in the future

const idOf = (value) => (value ? String(value._id || value) : null);

/**
 * Index the sessions behind the given tests, so a Session → Phase → Week
 * cascade can be built for them.
 *
 * A Test stores only a bare phase ObjectId (no ref), so phase names and order
 * have to be resolved from the owning session's `phases` subdocs. Admins and
 * managers can list every session; a plain teacher cannot, because
 * GET /test-sessions is admin/manager only — so any session referenced by the
 * teacher's own tests but missing from `sessions` is looked up here. That
 * exposes nothing beyond the phase labels of sessions those tests belong to.
 */
exports.buildSessionIndex = async (tests, sessions) => {
  const sessionRank = {};
  const phaseNames = {};
  const phaseOrder = {};

  const index = (s, i) => {
    sessionRank[String(s._id)] = i;
    (s.phases || []).forEach((p) => {
      phaseNames[String(p._id)] = p.name;
      phaseOrder[String(p._id)] = Number.isFinite(p.order) ? p.order : 0;
    });
  };
  sessions.forEach(index);

  const missing = [...new Set(tests.map((t) => idOf(t.session)).filter(Boolean))].filter(
    (id) => sessionRank[id] === undefined
  );

  if (missing.length > 0) {
    const extra = await TestSession.find({ _id: { $in: missing } }).select("name phases").sort("name").lean();
    extra.forEach((s, i) => index(s, sessions.length + i));
  }

  return { sessionRank, phaseNames, phaseOrder };
};

// Order tests categorically — Session → Phase → Week → newest — instead of as
// a flat date-sorted dump.
exports.sortTestsByCategory = (tests, sessionRank, phaseOrder) => {
  const rankSession = (t) => {
    const id = idOf(t.session);
    return id && sessionRank[id] !== undefined ? sessionRank[id] : SESSIONS_UNRANKED;
  };
  const rankPhase = (t) => (t.phase && phaseOrder[String(t.phase)] !== undefined ? phaseOrder[String(t.phase)] : PHASES_UNRANKED);
  const rankWeek = (t) => (t.week && t.week.startDate ? new Date(t.week.startDate).getTime() : WEEKS_UNRANKED);

  tests.sort((a, b) => {
    if (rankSession(a) !== rankSession(b)) return rankSession(a) - rankSession(b);
    if (rankPhase(a) !== rankPhase(b)) return rankPhase(a) - rankPhase(b);
    if (rankWeek(a) !== rankWeek(b)) return rankWeek(a) - rankWeek(b);
    return new Date(b.date) - new Date(a.date);
  });

  return tests;
};
