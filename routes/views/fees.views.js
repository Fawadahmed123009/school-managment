const express = require("express");
const router = express.Router();
const { requireRole } = require("../../middlewares/authView");
const Fees = require("../../models/Fees/fees.model");
const { createFeeService, updateFeeService, deleteFeeService, bulkAssignFeesService, bulkAssignPreviewService, generateMonthlyFeesService } = require("../../services/fees/fees.service");
const { getAllFeeHeadsService } = require("../../services/fees/feeHead.service");
const { paginate } = require("../../utils/paginate");
const { captureServiceResponse } = require("../../utils/viewServiceResponse");
const Student = require("../../models/Students/students.model");
const Parent = require("../../models/Parents/parents.model");
const ClassLevel = require("../../models/Academic/class.model");

router.get("/fees", requireRole("admin"), async (req, res) => {
  try {
    const { page, limit, roll, parent, student: studentNameRaw, class: classFilterRaw, feeHead: feeHeadFilterRaw, sortBy, ok, msg, genMsg, genErr, error: queryError, ...restFilters } = req.query;
    const okFlag = ok === "1";
    const genMessage = genMsg || null;
    const genError = genErr || null;
    const createError = queryError || null;
    const classFilter = (classFilterRaw || "").trim();
    const feeHeadFilter = (feeHeadFilterRaw || "").trim();
    const rollSearch = (roll || "").trim();
    const parentSearch = (parent || "").trim();
    const studentNameSearch = (studentNameRaw || "").trim();
    const sortByRoll = sortBy === "rollAsc" || sortBy === "rollDesc";

    // If a feeHead filter was provided, add it directly to the fee query
    if (feeHeadFilter) {
      restFilters.feeHead = feeHeadFilter;
    }

    // Build a Student-level filter to resolve matching student IDs.
    // Fee records reference students, so roll / class / parent searches
    // need a lookup step before we can filter the Fees collection.
    const studentFilter = {};
    const hasStudentFilter = classFilter || rollSearch || parentSearch || studentNameSearch;

    if (classFilter) studentFilter.classLevel = classFilter;
    if (rollSearch) {
      // rollNumber is a Number field — try exact match first, then regex on string cast
      const asNum = Number(rollSearch);
      if (!isNaN(asNum)) {
        studentFilter.rollNumber = asNum;
      } else {
        studentFilter.rollNumber = { $regex: rollSearch, $options: "i" };
      }
    }
    if (studentNameSearch) {
      studentFilter.name = { $regex: studentNameSearch, $options: "i" };
    }

    // We need classes for the dropdown regardless
    const [classes] = await Promise.all([
      ClassLevel.find({}).select("name gradeLevel section").sort("gradeLevel name").lean(),
    ]);

    let feeQuery = { ...restFilters };

    if (hasStudentFilter) {
      // Build the $or branches for parent name: fatherName on Student OR linked Parent name
      let studentQuery = studentFilter;

      if (parentSearch) {
        const parentClause = [];
        // Branch 1: fatherName directly on Student
        parentClause.push({ fatherName: { $regex: parentSearch, $options: "i" } });
        // Branch 2: linked Parent document's name
        const matchingParents = await Parent.find(
          { name: { $regex: parentSearch, $options: "i" } }
        ).select("_id");
        if (matchingParents.length > 0) {
          parentClause.push({ parent: { $in: matchingParents.map((p) => p._id) } });
        }
        const orClause = parentClause.length === 1 ? parentClause[0] : { $or: parentClause };

        // Combine with any existing studentFilter via $and
        if (Object.keys(studentFilter).length > 0) {
          studentQuery = { $and: [studentFilter, orClause] };
        } else {
          studentQuery = orClause;
        }
      }

      const matchingStudents = await Student.find(studentQuery).select("_id").lean();
      const studentIds = matchingStudents.map((s) => s._id);

      // If no students match, short-circuit to empty result
      if (studentIds.length === 0) {
        const [studentsResult, headsResult] = await Promise.all([
          Student.find({}).select("name rollNumber classLevel")
            .populate({ path: "classLevel", select: "name gradeLevel section" })
            .sort("name").lean(),
          getAllFeeHeadsService({ limit: 100 }),
        ]);
        return res.render("fees/list", {
          page: "fees",
          user: req.user,
          fees: [],
          pagination: { total: 0, page: 1, limit: 20, pages: 0, hasPrev: false, hasNext: false },
          filters: { class: classFilter, roll: rollSearch, parent: parentSearch, student: studentNameSearch, feeHead: feeHeadFilter, sortBy: sortBy || "", ...restFilters },
          students: studentsResult || [],
          feeHeads: headsResult.data || [],
          classes,
          loadError: null,
          ok: okFlag,
          msg: msg || null,
          genMsg: genMessage,
          genErr: genError,
          schoolName: res.locals.schoolName,
        });
      }

      feeQuery.student = { $in: studentIds };
    }

    const populateConfig = [
      {
        path: "student",
        select: "name rollNumber fatherName classLevel parent",
        populate: [
          { path: "classLevel", select: "name gradeLevel section" },
          { path: "parent", select: "name" },
        ],
      },
      { path: "academicTerm" },
      { path: "academicYear" },
      { path: "feeHead", select: "name" },
    ];

    let feesResult;
    if (sortByRoll) {
      // Roll-number sort requires JS-level sorting on a populated field,
      // so we fetch all matching fees, sort in memory, then paginate manually.
      const allFees = await Fees.find(feeQuery)
        .populate(populateConfig)
        .lean();
      allFees.sort((a, b) => {
        const ra = String((a.student && a.student.rollNumber) || "");
        const rb = String((b.student && b.student.rollNumber) || "");
        const cmp = ra.localeCompare(rb, undefined, { numeric: true });
        return sortBy === "rollAsc" ? cmp : -cmp;
      });
      const pg = Math.max(1, parseInt(page, 10) || 1);
      const lm = Math.min(100, Math.max(1, parseInt(limit, 10) || 20));
      const skip = (pg - 1) * lm;
      feesResult = {
        data: allFees.slice(skip, skip + lm),
        pagination: {
          total: allFees.length, page: pg, limit: lm,
          pages: Math.ceil(allFees.length / lm),
          hasPrev: pg > 1, hasNext: pg < Math.ceil(allFees.length / lm),
        },
      };
    } else {
      feesResult = await paginate(Fees, feeQuery, {
        page, limit, sort: "-createdAt",
        populate: populateConfig,
      });
    }

    // Direct find (not paginate — the fee-entry search box needs every
    // student in memory for client-side filtering; paginate() caps at 100
    // which was silently truncating the old dropdown for larger schools).
    const [studentsResult, headsResult] = await Promise.all([
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
      pagination: feesResult.pagination || null,
      filters: { class: classFilter, roll: rollSearch, parent: parentSearch, student: studentNameSearch, feeHead: feeHeadFilter, sortBy: sortBy || "", ...restFilters },
      students: studentsResult || [],
      feeHeads: headsResult.data || [],
      classes,
      loadError: null,
      ok: okFlag,
      msg: msg || null,
      genMsg: genMessage,
      genErr: genError,
      createError,
      schoolName: res.locals.schoolName,
    });
  } catch (err) {
    res.render("fees/list", {
      page: "fees",
      user: req.user,
      fees: [],
      students: [],
      feeHeads: [],
      classes: [],
      loadError: err.message,
      ok: false,
      genMsg: null,
      genErr: null,
      createError: null,
      schoolName: res.locals.schoolName,
    });
  }
});

router.post("/fees/create", requireRole("admin"), async (req, res) => {
  const { student, feeHead, feeType, amount } = req.body;
  const body = { student, amount: Number(amount) };
  if (feeHead) {
    // Selected from the dropdown — pass the ObjectId and resolve the name
    // for the legacy feeType field (kept for backward-compatible display).
    body.feeHead = feeHead;
    const headsResult = await getAllFeeHeadsService({ limit: 100 });
    const head = (headsResult.data || []).find((h) => h._id.toString() === feeHead);
    if (head) body.feeType = head.name;
  } else if (feeType && feeType.trim()) {
    // Admin typed a custom head inline — createFeeService will promote it to
    // a reusable FeeHead catalog entry (dedupe by name, case-insensitive).
    body.feeType = feeType.trim();
  } else {
    body.feeType = "tuition";
  }
  const { res: cap, result } = captureServiceResponse();
  try {
    await createFeeService(body, req.user._id, cap);
  } catch (err) {
    return res.redirect(`/fees?error=${encodeURIComponent(err.message || "Failed to create fee record")}`);
  }
  if (result.ok) return res.redirect("/fees?ok=1");
  return res.redirect(`/fees?error=${encodeURIComponent(result.message || "Failed to create fee record")}`);
});

router.post("/fees/:feeId/update", requireRole("admin"), async (req, res) => {
  const { res: cap, result } = captureServiceResponse();
  try {
    await updateFeeService(req.params.feeId, { status: "paid", datePaid: new Date().toISOString() }, cap);
  } catch (err) {
    return res.redirect(`/fees?error=${encodeURIComponent(err.message || "Failed to update fee record")}`);
  }
  if (result.ok) return res.redirect("/fees?ok=1");
  return res.redirect(`/fees?error=${encodeURIComponent(result.message || "Failed to update fee record")}`);
});

// ---- Delete an individual fee record ----
router.post("/fees/:feeId/delete", requireRole("admin"), async (req, res) => {
  const { res: cap, result } = captureServiceResponse();
  try {
    await deleteFeeService(req.params.feeId, cap);
  } catch (err) {
    return res.redirect(`/fees?error=${encodeURIComponent(err.message || "Failed to delete fee record")}`);
  }
  if (result.ok) return res.redirect("/fees?ok=1&msg=" + encodeURIComponent("Fee record deleted."));
  return res.redirect(`/fees?error=${encodeURIComponent(result.message || "Failed to delete fee record")}`);
});

// ---- Bulk fee assignment page ----
router.get("/fees/bulk-assign", requireRole("admin"), async (req, res) => {
  try {
    const [headsResult, classes] = await Promise.all([
      getAllFeeHeadsService({ limit: 100 }),
      ClassLevel.find({}).select("name gradeLevel section").sort("gradeLevel name").lean(),
    ]);
    res.render("fees/bulk-assign", {
      page: "fees-bulk-assign",
      user: req.user,
      feeHeads: headsResult.data || [],
      classes,
      successMsg: req.query.ok === "1" ? req.query.msg || "Fee records created successfully." : null,
      errorMsg: req.query.err || null,
      schoolName: res.locals.schoolName,
    });
  } catch (err) {
    res.render("fees/bulk-assign", {
      page: "fees-bulk-assign",
      user: req.user,
      feeHeads: [],
      classes: [],
      successMsg: null,
      errorMsg: err.message,
      schoolName: res.locals.schoolName,
    });
  }
});

router.post("/fees/bulk-assign", requireRole("admin"), async (req, res) => {
  try {
    const dummyRes = { status: (code) => ({ json: (body) => { dummyRes._statusCode = code; dummyRes._body = body; } }) };
    await bulkAssignFeesService(req.body, req.user._id, dummyRes);
    const body = dummyRes._body || {};
    const data = body.data || body;
    if (dummyRes._statusCode >= 400) {
      const msg = typeof data === "string" ? data : (data.message || "Something went wrong");
      return res.redirect("/fees/bulk-assign?err=" + encodeURIComponent(msg));
    }
    const msg = data.message || "Fee records created successfully.";
    return res.redirect("/fees/bulk-assign?ok=1&msg=" + encodeURIComponent(msg));
  } catch (err) {
    return res.redirect("/fees/bulk-assign?err=" + encodeURIComponent(err.message));
  }
});

// ---- Bulk-assign preview (AJAX) ----
router.post("/fees/bulk-assign/preview", requireRole("admin"), async (req, res) => {
  try {
    const data = await bulkAssignPreviewService(req.body);
    return res.json({ ok: true, data });
  } catch (err) {
    return res.status(400).json({ ok: false, error: err.message });
  }
});

// ---- Generate this month's Tuition fees ----
router.post("/fees/generate-monthly", requireRole("admin"), async (req, res) => {
  try {
    const dummyRes = { status: (code) => ({ json: (body) => { dummyRes._statusCode = code; dummyRes._body = body; } }) };
    await generateMonthlyFeesService(req.user._id, dummyRes);
    const body = dummyRes._body || {};
    const data = body.data || body;
    if (dummyRes._statusCode >= 400) {
      const msg = typeof data === "string" ? data : (data.message || "Something went wrong");
      return res.redirect("/fees?genErr=" + encodeURIComponent(msg));
    }
    const msg = data.message || "Monthly fees generated.";
    return res.redirect("/fees?ok=1&genMsg=" + encodeURIComponent(msg));
  } catch (err) {
    return res.redirect("/fees?genErr=" + encodeURIComponent(err.message));
  }
});

module.exports = router;
