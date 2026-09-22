const express = require("express");
const router = express.Router();
const { requireRole } = require("../../middlewares/authView");
const {
  getAllFeeHeadsService,
  createFeeHeadService,
  updateFeeHeadService,
  deleteFeeHeadService,
  getDailyCollectionData,
  getDefaulterListData,
  getInactiveStudentDuesData,
} = require("../../services/fees/feeHead.service");
const { captureServiceResponse } = require("../../utils/viewServiceResponse");
const ClassLevel = require("../../models/Academic/class.model");

// ---- Fee Heads management page ----
router.get("/fee-heads", requireRole("admin"), async (req, res) => {
  try {
    const result = await getAllFeeHeadsService(req.query);
    res.render("fees/heads", {
      page: "fee-heads",
      user: req.user,
      feeHeads: result.data || [],
      loadError: null,
      ok: req.query.ok === "1",
      createError: req.query.error || null,
      schoolName: res.locals.schoolName,
    });
  } catch (err) {
    res.render("fees/heads", {
      page: "fee-heads",
      user: req.user,
      feeHeads: [],
      loadError: err.message,
      ok: false,
      createError: null,
      schoolName: res.locals.schoolName,
    });
  }
});

router.post("/fee-heads/create", requireRole("admin"), async (req, res) => {
  const { res: cap, result } = captureServiceResponse();
  try {
    await createFeeHeadService(
      { name: req.body.name, description: req.body.description || "", defaultAmount: Number(req.body.defaultAmount) || 0 },
      req.user._id,
      cap
    );
  } catch (err) {
    return res.redirect(`/fee-heads?error=${encodeURIComponent(err.message || "Failed to create fee head")}`);
  }
  if (result.ok) return res.redirect("/fee-heads?ok=1");
  return res.redirect(`/fee-heads?error=${encodeURIComponent(result.message || "Failed to create fee head")}`);
});

router.post("/fee-heads/:feeHeadId/update", requireRole("admin"), async (req, res) => {
  const { res: cap, result } = captureServiceResponse();
  try {
    await updateFeeHeadService(req.params.feeHeadId, req.body, cap);
  } catch (err) {
    return res.redirect(`/fee-heads?error=${encodeURIComponent(err.message || "Failed to update fee head")}`);
  }
  if (result.ok) return res.redirect("/fee-heads?ok=1");
  return res.redirect(`/fee-heads?error=${encodeURIComponent(result.message || "Failed to update fee head")}`);
});

router.post("/fee-heads/:feeHeadId/toggle", requireRole("admin"), async (req, res) => {
  const { res: cap, result } = captureServiceResponse();
  try {
    await updateFeeHeadService(req.params.feeHeadId, { isActive: req.body.isActive === "true" }, cap);
  } catch (err) {
    return res.redirect(`/fee-heads?error=${encodeURIComponent(err.message || "Failed to update fee head")}`);
  }
  if (result.ok) return res.redirect("/fee-heads?ok=1");
  return res.redirect(`/fee-heads?error=${encodeURIComponent(result.message || "Failed to update fee head")}`);
});

router.post("/fee-heads/:feeHeadId/delete", requireRole("admin"), async (req, res) => {
  const { res: cap, result } = captureServiceResponse();
  try {
    await deleteFeeHeadService(req.params.feeHeadId, cap);
  } catch (err) {
    return res.redirect(`/fee-heads?error=${encodeURIComponent(err.message || "Failed to delete fee head")}`);
  }
  if (result.ok) return res.redirect("/fee-heads?ok=1");
  return res.redirect(`/fee-heads?error=${encodeURIComponent(result.message || "Failed to delete fee head")}`);
});

// ---- Daily Collection Report page ----
router.get("/fees/collection", requireRole("admin"), async (req, res) => {
  try {
    const report = await getDailyCollectionData(req.query);
    res.render("fees/collection", {
      page: "fees-collection",
      user: req.user,
      report,
      loadError: null,
      queryDate: req.query.date || "",
      queryFrom: req.query.from || "",
      queryTo: req.query.to || "",
      schoolName: res.locals.schoolName,
    });
  } catch (err) {
    res.render("fees/collection", {
      page: "fees-collection",
      user: req.user,
      report: null,
      loadError: err.message,
      queryDate: req.query.date || "",
      queryFrom: req.query.from || "",
      queryTo: req.query.to || "",
      schoolName: res.locals.schoolName,
    });
  }
});

// ---- Defaulter List page ----
router.get("/fees/defaulters", requireRole("admin"), async (req, res) => {
  try {
    const [defaulters, classLevels] = await Promise.all([
      getDefaulterListData(req.query),
      ClassLevel.find({}).select("name gradeLevel group section").sort("gradeLevel"),
    ]);
    res.render("fees/defaulters", {
      page: "fees-defaulters",
      user: req.user,
      defaulters,
      classLevels,
      loadError: null,
      queryClassLevel: req.query.classLevel || "",
      querySortBy: req.query.sortBy || "",
      schoolName: res.locals.schoolName,
    });
  } catch (err) {
    res.render("fees/defaulters", {
      page: "fees-defaulters",
      user: req.user,
      defaulters: null,
      classLevels: [],
      loadError: err.message,
      queryClassLevel: req.query.classLevel || "",
      querySortBy: req.query.sortBy || "",
      schoolName: res.locals.schoolName,
    });
  }
});

// ---- Inactive Student Dues page ----
router.get("/fees/inactive-dues", requireRole("admin"), async (req, res) => {
  try {
    const [dues, classLevels] = await Promise.all([
      getInactiveStudentDuesData(req.query),
      ClassLevel.find({}).select("name gradeLevel group section").sort("gradeLevel"),
    ]);
    res.render("fees/inactive-dues", {
      page: "fees-inactive-dues",
      user: req.user,
      dues,
      classLevels,
      loadError: null,
      queryClassLevel: req.query.classLevel || "",
      querySortBy: req.query.sortBy || "",
      schoolName: res.locals.schoolName,
    });
  } catch (err) {
    res.render("fees/inactive-dues", {
      page: "fees-inactive-dues",
      user: req.user,
      dues: null,
      classLevels: [],
      loadError: err.message,
      queryClassLevel: req.query.classLevel || "",
      querySortBy: req.query.sortBy || "",
      schoolName: res.locals.schoolName,
    });
  }
});

module.exports = router;
