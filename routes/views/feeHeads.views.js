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
      schoolName: res.locals.schoolName,
    });
  } catch (err) {
    res.render("fees/heads", {
      page: "fee-heads",
      user: req.user,
      feeHeads: [],
      loadError: err.message,
      ok: false,
      schoolName: res.locals.schoolName,
    });
  }
});

router.post("/fee-heads/create", requireRole("admin"), async (req, res) => {
  try {
    await createFeeHeadService(
      { name: req.body.name, description: req.body.description || "", defaultAmount: Number(req.body.defaultAmount) || 0 },
      req.user._id,
      { status: () => ({ json: () => {} }) }
    );
  } catch (err) {
    // ignore
  }
  res.redirect("/fee-heads?ok=1");
});

router.post("/fee-heads/:feeHeadId/update", requireRole("admin"), async (req, res) => {
  try {
    await updateFeeHeadService(req.params.feeHeadId, req.body, { status: () => ({ json: () => {} }) });
  } catch (err) {
    // ignore
  }
  res.redirect("/fee-heads?ok=1");
});

router.post("/fee-heads/:feeHeadId/toggle", requireRole("admin"), async (req, res) => {
  try {
    await updateFeeHeadService(req.params.feeHeadId, { isActive: req.body.isActive === "true" }, { status: () => ({ json: () => {} }) });
  } catch (err) {
    // ignore
  }
  res.redirect("/fee-heads?ok=1");
});

router.post("/fee-heads/:feeHeadId/delete", requireRole("admin"), async (req, res) => {
  try {
    await deleteFeeHeadService(req.params.feeHeadId, { status: () => ({ json: () => {} }) });
  } catch (err) {
    // ignore
  }
  res.redirect("/fee-heads?ok=1");
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
      schoolName: res.locals.schoolName,
    });
  }
});

module.exports = router;
