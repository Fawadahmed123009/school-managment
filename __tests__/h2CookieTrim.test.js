/**
 * Tests for H2: the signed `session` cookie must carry only a minimal,
 * non-sensitive identity hint — { _id, name, role } — never the full user
 * document.
 *
 * The cookie is client-held. Signing makes it tamper-evident but NOT secret:
 * its contents are readable by the browser and can appear in logs/proxies.
 * Before this fix, login serialized `{ ...user }` — every DB column, including
 * the password hash, contact numbers and fee fields — into the cookie.
 *
 * authView re-resolves role / isManager / isSuspended / _id from the DATABASE
 * off the verified JWT id on every request, so none of that needs to live in
 * the cookie. These tests pin both halves of that contract:
 *   1. buildSessionUser() is a strict whitelist (nothing non-whitelisted leaks).
 *   2. The login route actually writes the cookie through that whitelist, and
 *      the trimmed set still covers every `user.*` field the views consume.
 */

const fs = require("fs");
const path = require("path");
const { buildSessionUser } = require("../utils/sessionCookie");

// A representative full user document as it comes back from the login API —
// deliberately loaded with sensitive columns that must NOT reach the cookie.
const FULL_USER = {
  _id: "507f1f77bcf86cd799439011",
  name: "Aisha Rahman",
  email: "aisha@example.com",
  password: "$2a$10$NBqKJ3fakehashfakehashfakehashfakehashfakeha",
  role: "teacher",
  isAttendanceManager: true,
  isSuspended: false,
  whatsappNumber: "+923001234567",
  feeAgreed: 25000,
  address: "House 9, Street 4, Lahore",
  photo: "https://cdn.example/secret-path/aisha.jpg",
  __v: 3,
};

describe("H2: buildSessionUser whitelist", () => {
  test("keeps exactly { _id, name, role } and nothing else", () => {
    const out = buildSessionUser(FULL_USER, "teacher");
    expect(Object.keys(out).sort()).toEqual(["_id", "name", "role"]);
  });

  test("drops the password hash and every other sensitive column", () => {
    const json = JSON.stringify(buildSessionUser(FULL_USER, "teacher"));
    expect(json).not.toContain("$2a$"); // bcrypt hash
    expect(json).not.toContain(FULL_USER.password);
    expect(json).not.toContain("whatsappNumber");
    expect(json).not.toContain("+923001234567");
    expect(json).not.toContain("feeAgreed");
    expect(json).not.toContain("25000");
    expect(json).not.toContain(FULL_USER.email);
    expect(json).not.toContain("aisha@example.com");
    expect(json).not.toContain("address");
    expect(json).not.toContain("photo");
    expect(json).not.toContain("__v");
    expect(json).not.toContain("isAttendanceManager");
    expect(json).not.toContain("isSuspended");
  });

  test("preserves the three display/identity fields", () => {
    const out = buildSessionUser(FULL_USER, "teacher");
    expect(out._id).toBe(FULL_USER._id);
    expect(out.name).toBe(FULL_USER.name);
    expect(out.role).toBe("teacher");
  });

  test("falls back to the submitted role when the doc has none", () => {
    const noRole = { _id: "x1", name: "Guest" };
    expect(buildSessionUser(noRole, "student").role).toBe("student");
  });

  test("prefers the document role when present", () => {
    const withRole = { _id: "x1", name: "Y", role: "admin" };
    expect(buildSessionUser(withRole, "teacher").role).toBe("admin");
  });

  test("tolerates a missing user object without throwing", () => {
    expect(buildSessionUser(undefined, "admin")).toEqual({
      _id: undefined,
      name: undefined,
      role: "admin",
    });
  });
});

describe("H2: login route writes the cookie through the whitelist", () => {
  const routeSrc = fs.readFileSync(
    path.join(__dirname, "..", "routes", "views", "auth.views.js"),
    "utf8"
  );

  test("imports buildSessionUser", () => {
    expect(routeSrc).toMatch(
      /require\(["']\.\.\/\.\.\/utils\/sessionCookie["']\)/
    );
  });

  test("serializes the cookie via buildSessionUser(user, role)", () => {
    // The value passed to res.cookie must be the trimmed payload.
    expect(routeSrc).toMatch(/user:\s*buildSessionUser\(\s*user\s*,\s*role\s*\)/);
  });

  test("no longer spreads the full user document into the cookie", () => {
    // Regression guard: the old `{ token, user: { ...user, role: ... } }` form.
    expect(routeSrc).not.toMatch(/user:\s*\{\s*\.\.\.user/);
    expect(routeSrc).not.toMatch(/\.\.\.user\s*,\s*role:/);
  });
});

describe("H2: trimmed payload still covers every field the app reads off the cookie", () => {
  // authView rebuilds req.user from the DB for role/_id/isManager/isSuspended;
  // only `name` is display-only from the cookie. Scan the actual source of the
  // views/routes/middlewares for `user.<field>` reads and assert the cookie
  // supplies (or authView overrides) each one — so trimming can never blank a
  // field the UI depends on.
  const ROOT = path.join(__dirname, "..");
  const READ_DIRS = ["views", "routes/views", "middlewares", "handlers"];

  function walk(abs, out) {
    if (!fs.existsSync(abs)) return;
    fs.readdirSync(abs, { withFileTypes: true }).forEach((entry) => {
      const full = path.join(abs, entry.name);
      if (entry.isDirectory()) return walk(full, out);
      if (/\.(ejs|js)$/.test(entry.name)) out.push(full);
    });
  }

  function collectUserFieldReads() {
    const fields = new Set();
    const re = /\buser\.([a-zA-Z_][a-zA-Z0-9_]*)/g;
    const files = [];
    READ_DIRS.forEach((dir) => walk(path.join(ROOT, dir), files));
    files.forEach((full) => {
      const src = fs.readFileSync(full, "utf8");
      let m;
      while ((m = re.exec(src)) !== null) fields.add(m[1]);
      re.lastIndex = 0;
    });
    return [...fields];
  }

  // Fields authView always sets from DB-verified truth (independent of cookie).
  const OVERRIDDEN_BY_AUTHVIEW = new Set(["_id", "id", "role", "isManager", "isSuspended"]);
  const IN_COOKIE = new Set(Object.keys(buildSessionUser(FULL_USER, "admin")));

  test("only known fields are read off user.* anywhere", () => {
    const KNOWN = new Set([
      ...OVERRIDDEN_BY_AUTHVIEW,
      ...IN_COOKIE,
    ]);
    const reads = collectUserFieldReads();
    const unknown = reads.filter((f) => !KNOWN.has(f));
    expect(unknown).toEqual([]);
  });

  test("every read field is either in the trimmed cookie or DB-overridden", () => {
    collectUserFieldReads().forEach((field) => {
      const covered = IN_COOKIE.has(field) || OVERRIDDEN_BY_AUTHVIEW.has(field);
      expect(covered).toBe(true);
    });
  });
});
