const express = require("express");
const router = express.Router();
const { requireRole } = require("../../middlewares/authView");
const { apiFetch } = require("../../utils/apiClient");
const { captureServiceResponse } = require("../../utils/viewServiceResponse");
const { updateTeacherAccountSettingsService } = require("../../services/staff/teachers.service");
const { buildSessionUser } = require("../../utils/sessionCookie");
const logger = require("../../config/logger");

// ---- Teacher: Settings page (name / email / number / password) ----
router.get("/teacher/settings", requireRole("teacher"), async (req, res) => {
  // Prefill from the DB (email + WhatsApp number aren't in the session cookie).
  const profileResult = await apiFetch(`/teacher/${req.user._id}/profile`, req.token);
  const profile = profileResult.status === "success" ? profileResult.data : null;

  res.render("settings/teacher", {
    page: "settings",
    user: req.user,
    profile,
    settingsSuccess: req.query.settingsSuccess === "1",
    settingsError: req.query.settingsError || null,
    loadError: profileResult.status === "success" ? null : profileResult.message,
    schoolName: res.locals.schoolName,
  });
});

// ---- Teacher: submit settings (Post/Redirect/Get) ----
// CSRF-guarded globally. Handled straight through the shared service via a
// captured response, mirroring /parent-portal/change-password.
router.post("/teacher/settings", requireRole("teacher"), async (req, res) => {
  const { res: cap, result } = captureServiceResponse();
  try {
    await updateTeacherAccountSettingsService(req.body, req.user._id, cap);
  } catch (err) {
    return res.redirect("/teacher/settings?settingsError=" + encodeURIComponent(err.message || "Could not save settings"));
  }

  if (result.ok) {
    // Keep the signed session cookie's display name in sync with the DB, so the
    // greeting/topbar don't show a stale name until the teacher next logs in.
    try {
      const updated = result.body && result.body.data && result.body.data.teacher;
      if (updated && updated.name && updated.name !== req.user.name) {
        const isProduction = process.env.NODE_ENV === "production";
        res.cookie(
          "session",
          JSON.stringify({
            token: req.token,
            user: buildSessionUser({ _id: req.user._id, name: updated.name, role: "teacher" }, "teacher"),
          }),
          { httpOnly: true, sameSite: "lax", secure: isProduction, path: "/" }
        );
      }
    } catch (e) {
      logger.warn("Session cookie refresh after settings save failed", { error: e.message });
    }
    return res.redirect("/teacher/settings?settingsSuccess=1");
  }
  return res.redirect("/teacher/settings?settingsError=" + encodeURIComponent(result.message || "Could not save settings"));
});

module.exports = router;
