const express = require("express");
const router = express.Router();
const { requireRole } = require("../../middlewares/authView");

// Old marks entry page — superseded by the Test system (/tests/manage).
// Redirect teachers to the new flow instead of showing a broken page.
router.get("/marks", requireRole("teacher"), (req, res) => {
  res.redirect("/tests/manage");
});

// RETIRED: POST /marks/create was removed — no UI form/JS posted to it, and it
// called the already-retired POST /api/v1/marks write endpoint (marking now goes
// through TestResult via POST /api/v1/tests/:testId/results and the OCR flow).

module.exports = router;
