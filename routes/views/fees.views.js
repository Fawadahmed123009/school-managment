const express = require("express");
const router = express.Router();
const { requireRole } = require("../../middlewares/authView");
const Fees = require("../../models/Fees/fees.model");
const { createFeeService, updateFeeService } = require("../../services/fees/fees.service");
const { getAllFeeHeadsService } = require("../../services/fees/feeHead.service");
const { paginate } = require("../../utils/paginate");
const Student = require("../../models/Students/students.model");

router.get("/fees", requireRole("admin"), async (req, res) => {
  try {
    const { page, limit, ...filters } = req.query;
    const [feesResult, studentsResult, headsResult] = await Promise.all([
      paginate(Fees, filters, {
        page, limit, sort: "-createdAt",
        populate: [
          { path: "student", select: "name rollNumber" },
          { path: "academicTerm" },
          { path: "academicYear" },
          { path: "feeHead", select: "name" },
        ],
      }),
      // Direct find (not paginate — the fee-entry search box needs every
      // student in memory for client-side filtering; paginate() caps at 100
      // which was silently truncating the old dropdown for larger schools).
      Student.find({})
        .select("name rollNumber classLevel")
        .populate({ path: "classLevel", select: "name gradeLevel section" })
        .sort("name")
        .lean(),
      getAllFeeHeadsService({ limit: 100 }),
    ]);
    res.render("fees/list", {
      page: "fees",
      user: req.user,
      fees: feesResult.data || [],
      students: studentsResult || [],
      feeHeads: headsResult.data || [],
      loadError: null,
      ok: req.query.ok === "1",
      schoolName: res.locals.schoolName,
    });
  } catch (err) {
    res.render("fees/list", {
      page: "fees",
      user: req.user,
      fees: [],
      students: [],
      feeHeads: [],
      loadError: err.message,
      ok: false,
      schoolName: res.locals.schoolName,
    });
  }
});

router.post("/fees/create", requireRole("admin"), async (req, res) => {
  const { student, feeHead, feeType, amount } = req.body;
  const body = { student, amount: Number(amount) };
  if (feeHead) {
    body.feeHead = feeHead;
    const headsResult = await getAllFeeHeadsService({ limit: 100 });
    const head = (headsResult.data || []).find((h) => h._id.toString() === feeHead);
    if (head) body.feeType = head.name;
  } else {
    body.feeType = feeType || "tuition";
  }
  try {
    await createFeeService(body, req.user._id, { status: () => ({ json: () => {} }) });
  } catch (err) {
    // ignore
  }
  res.redirect("/fees?ok=1");
});

router.post("/fees/:feeId/update", requireRole("admin"), async (req, res) => {
  try {
    await updateFeeService(req.params.feeId, { status: "paid", datePaid: new Date().toISOString() }, { status: () => ({ json: () => {} }) });
  } catch (err) {
    // ignore
  }
  res.redirect("/fees?ok=1");
});

module.exports = router;
