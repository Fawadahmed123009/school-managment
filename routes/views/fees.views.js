const express = require("express");
const router = express.Router();
const { requireRole } = require("../../middlewares/authView");
const Fees = require("../../models/Fees/fees.model");
const { createFeeService, updateFeeService, bulkAssignFeesService, generateMonthlyFeesService } = require("../../services/fees/fees.service");
const { getAllFeeHeadsService, findOrCreateFeeHeadByName } = require("../../services/fees/feeHead.service");
const { paginate } = require("../../utils/paginate");
const Student = require("../../models/Students/students.model");
const Parent = require("../../models/Parents/parents.model");
const ClassLevel = require("../../models/Academic/class.model");

router.get("/fees", requireRole("admin"), async (req, res) => {
  try {
    const { page, limit, roll, parent, student: studentNameRaw, class: classFilterRaw, ok, genMsg, genErr, ...restFilters } = req.query;
    const okFlag = ok === "1";
    const genMessage = genMsg || null;
    const genError = genErr || null;
    const classFilter = (classFilterRaw || "").trim();
    const rollSearch = (roll || "").trim();
    const parentSearch = (parent || "").trim();
    const studentNameSearch = (studentNameRaw || "").trim();

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
          filters: { class: classFilter, roll: rollSearch, parent: parentSearch, student: studentNameSearch, ...restFilters },
          students: studentsResult || [],
          feeHeads: headsResult.data || [],
          classes,
          loadError: null,
          ok: okFlag,
          genMsg: genMessage,
          genErr: genError,
          schoolName: res.locals.schoolName,
        });
      }

      feeQuery.student = { $in: studentIds };
    }

    const [feesResult, studentsResult, headsResult] = await Promise.all([
      paginate(Fees, feeQuery, {
        page, limit, sort: "-createdAt",
        populate: [
          { path: "student", select: "name rollNumber fatherName" },
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
      pagination: feesResult.pagination || null,
      filters: { class: classFilter, roll: rollSearch, parent: parentSearch, student: studentNameSearch, ...restFilters },
      students: studentsResult || [],
      feeHeads: headsResult.data || [],
      classes,
      loadError: null,
      ok: okFlag,
      genMsg: genMessage,
      genErr: genError,
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
    // Admin typed a head inline instead of picking one. Promote it to a real,
    // reusable FeeHead (dedupe by name) and reference it — same catalog as the
    // Fee Heads page — so it appears in the dropdown next time. Fall back to a
    // plain feeType string only if creation fails or nothing was typed.
    const typed = (feeType || "").trim();
    if (typed) {
      try {
        const head = await findOrCreateFeeHeadByName(typed, req.user._id);
        if (head) {
          body.feeHead = head._id;
          body.feeType = head.name;
        } else {
          body.feeType = typed;
        }
      } catch (err) {
        body.feeType = typed;
      }
    } else {
      body.feeType = "tuition";
    }
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
