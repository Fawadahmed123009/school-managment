const express = require("express");
const router = express.Router();
const { body, validationResult } = require("express-validator");
const { apiFetch } = require("../../utils/apiClient");

// ── Cookie security options ───────────────
// NOTE: `secure` follows NODE_ENV — production MUST set NODE_ENV=production for
// the Secure flag (cookie sent over HTTPS only). There is intentionally no
// in-code default so http://localhost dev keeps working. .env.example ships
// NODE_ENV=development.
const isProduction = process.env.NODE_ENV === "production";
const cookieOptions = {
  httpOnly: true,
  sameSite: "lax",
  secure: isProduction,
  maxAge: 24 * 60 * 60 * 1000, // 1 day (matches JWT expiry)
};

// ── Role-specific login pages ─────────────
router.get("/admin/login", (req, res) => {
  res.render("login", { role: "admin", error: null, schoolName: res.locals.schoolName });
});
router.get("/teacher/login", (req, res) => {
  res.render("login", { role: "teacher", error: null, schoolName: res.locals.schoolName });
});
router.get("/student/login", (req, res) => {
  res.render("login", { role: "student", error: null, schoolName: res.locals.schoolName });
});
router.get("/parent/login", (req, res) => {
  res.render("login", { role: "parent", error: null, schoolName: res.locals.schoolName });
});

// ── Generic /login → redirect to admin ────
router.get("/login", (req, res) => {
  res.redirect("/admin/login");
});

// ── Login form submission (all roles) ─────
router.post(
  "/login",
  [
    body("email")
      .trim()
      .isEmail()
      .withMessage("Please enter a valid email address")
      .normalizeEmail(),
    body("password")
      .trim()
      .notEmpty()
      .withMessage("Password is required"),
    body("role")
      .trim()
      .isIn(["admin", "teacher", "student", "parent"])
      .withMessage("Invalid role"),
  ],
  async (req, res) => {
    // Check validation errors
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      const role = req.body.role || "admin";
      return res.render("login", {
        role: ["admin", "teacher", "student", "parent"].includes(role) ? role : "admin",
        error: errors.array()[0].msg,
        schoolName: res.locals.schoolName,
      });
    }

    const { role, email, password } = req.body;
    const loginPaths = {
      teacher: "/teacher/login",
      student: "/students/login",
      parent: "/parents/login",
      admin: "/admin/login",
    };
    const path = loginPaths[role] || loginPaths.admin;

    try {
      const result = await fetch(`${require("../../utils/apiClient").BASE_URL}${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password }),
      });
      const data = await result.json();

      if (data.status !== "success") {
        return res.render("login", {
          role,
          error: data.message || "Invalid email or password",
          schoolName: res.locals.schoolName,
        });
      }

      const user = data.data.user || data.data.admin || data.data.teacher || data.data.student || data.data.parent;
      const token = data.data.token;

      res.cookie(
        "session",
        JSON.stringify({ token, user: { ...user, role: user.role || role } }),
        cookieOptions
      );

      // Redirect parents to their own portal
      const resolvedRole = user.role || role;
      if (resolvedRole === "parent") {
        return res.redirect("/parent-portal");
      }
      res.redirect("/dashboard");
    } catch (err) {
      res.render("login", { role, error: "Server error, please try again.", schoolName: res.locals.schoolName });
    }
  }
);

// ── Logout ────────────────────────────────
router.get("/logout", (req, res) => {
  // Clear with attributes matching how the cookie was set, so the browser
  // reliably removes it (and it carries Secure/SameSite in production).
  res.clearCookie("session", { httpOnly: true, sameSite: "lax", secure: isProduction, path: "/" });
  res.redirect("/admin/login");
});

module.exports = router;
