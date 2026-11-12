const express = require("express");
const router = express.Router();
const { requireRole } = require("../../middlewares/authView");
const { captureServiceResponse } = require("../../utils/viewServiceResponse");
const { localDateKey } = require("../../utils/localDateKey");
const {
  createIncomeHeadService,
  getAllIncomeHeadsService,
  toggleIncomeHeadService,
} = require("../../services/income/incomeHead.service");
const {
  createIncomeEntryService,
  getIncomeEntriesService,
} = require("../../services/income/incomeEntry.service");
const {
  normalizeExportFormat,
  fetchHistoryForExport,
  buildHistoryExport,
  historyFilename,
} = require("../../services/finance/financeExport.service");
const { sendExport } = require("../../utils/exportFile");

// Income — flexible ad-hoc income (parallel to Phase 3 Expenses). ADMIN ONLY on
// every route (requireRole resolves the role from the DB via authView): managers
// never see income heads, entries or totals anywhere in their UI, mirroring the
// Expenses/Salary restriction.

// ── helpers ─────────────────────────────────────────────────────────────────

function toISODate(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

// Money display follows the fees/salary/expense views ("Rs", 2 decimals).
const fmtRs = (n) => "Rs " + Number(n || 0).toLocaleString(undefined, { maximumFractionDigits: 2 });

const EMPTY_PAGINATION = { total: 0, page: 1, limit: 20, pages: 0, hasPrev: false, hasNext: false };

// ── Income entry form + history ─────────────────────────────────────────────

router.get("/income", requireRole("admin"), async (req, res) => {
  const filters = {
    incomeHead: req.query.incomeHead || "",
    from: req.query.from || "",
    to: req.query.to || "",
    page: req.query.page,
    limit: "20",
  };

  let allHeads = [];
  let history = { entries: [], pagination: EMPTY_PAGINATION, runningTotal: 0, count: 0 };
  let loadError = null;

  try {
    const headsResult = await getAllIncomeHeadsService({ limit: 100 });
    allHeads = headsResult.data || [];
  } catch (err) {
    loadError = err.message;
  }

  try {
    const { res: cap, result } = captureServiceResponse();
    await getIncomeEntriesService(filters, cap);
    if (result.ok) history = result.body.data;
    else loadError = result.message;
  } catch (err) {
    loadError = err.message;
  }

  // The new-entry dropdown offers ACTIVE heads only; the history filter lists
  // every head so a deactivated head's past entries stay reachable.
  const activeHeads = allHeads.filter((h) => h.isActive);

  const entries = (history.entries || []).map((e) => {
    const quantityBased = e.quantity !== undefined && e.quantity !== null;
    return {
      ...e,
      dateKey: localDateKey(e.date),
      headName: e.incomeHead ? e.incomeHead.name : "—",
      headActive: e.incomeHead ? !!e.incomeHead.isActive : false,
      createdByName: e.createdBy ? e.createdBy.name : "—",
      quantityBased,
      qtyDisplay: quantityBased ? e.quantity : "—",
      rateFmt: quantityBased && e.unitRate !== undefined && e.unitRate !== null ? fmtRs(e.unitRate) : "—",
      totalFmt: fmtRs(e.totalAmount),
    };
  });

  res.render("income/entries", {
    page: "income",
    user: req.user,
    activeHeads,
    allHeads,
    entries,
    pagination: history.pagination || EMPTY_PAGINATION,
    runningTotal: history.runningTotal || 0,
    count: history.count || 0,
    filters,
    defaultDate: toISODate(new Date()),
    ok: req.query.ok === "1",
    error: req.query.error || "",
    loadError,
    fmtRs,
    schoolName: res.locals.schoolName,
  });
});

// CSV/Excel export of the FILTERED history — same filters and same service
// as the page (admin-only, read-only GET). Walks every page of the filtered
// set because the on-screen running total spans all filtered entries; the
// total row is included in the file.
router.get("/income/export", requireRole("admin"), async (req, res) => {
  const format = normalizeExportFormat(req.query.format);
  if (!format) return res.status(400).send("Invalid export format — expected csv or xlsx");

  const filters = {
    incomeHead: req.query.incomeHead || "",
    from: req.query.from || "",
    to: req.query.to || "",
  };

  const loaded = await fetchHistoryForExport("income", filters);
  if (!loaded.ok) {
    const qs = Object.entries(filters)
      .filter(([, v]) => v)
      .map(([k, v]) => `&${k}=${encodeURIComponent(v)}`)
      .join("");
    return res.redirect(`/income?error=${encodeURIComponent(loaded.message)}${qs}`);
  }

  return sendExport(res, {
    filename: historyFilename("income", filters.from, filters.to, format),
    format,
    ...buildHistoryExport("income", loaded),
  });
});

router.post("/income/create", requireRole("admin"), async (req, res) => {
  const { res: cap, result } = captureServiceResponse();
  try {
    // The service derives the mode (quantity × rate vs direct total) from the
    // submitted fields and validates/normalises totalAmount server-side.
    await createIncomeEntryService(req.body, req.user._id, cap);
  } catch (err) {
    return res.redirect(`/income?error=${encodeURIComponent(err.message || "Failed to record income")}`);
  }
  if (result.ok) return res.redirect("/income?ok=1");
  return res.redirect(`/income?error=${encodeURIComponent(result.message || "Failed to record income")}`);
});

// ── Income head management ──────────────────────────────────────────────────

router.get("/income-heads", requireRole("admin"), async (req, res) => {
  try {
    const result = await getAllIncomeHeadsService({ limit: 100 });
    res.render("income/heads", {
      page: "income-heads",
      user: req.user,
      heads: result.data || [],
      loadError: null,
      ok: req.query.ok === "1",
      createError: req.query.error || null,
      schoolName: res.locals.schoolName,
    });
  } catch (err) {
    res.render("income/heads", {
      page: "income-heads",
      user: req.user,
      heads: [],
      loadError: err.message,
      ok: false,
      createError: null,
      schoolName: res.locals.schoolName,
    });
  }
});

router.post("/income-heads/create", requireRole("admin"), async (req, res) => {
  const { res: cap, result } = captureServiceResponse();
  try {
    await createIncomeHeadService({ name: req.body.name }, req.user._id, cap);
  } catch (err) {
    return res.redirect(`/income-heads?error=${encodeURIComponent(err.message || "Failed to create income head")}`);
  }
  if (result.ok) return res.redirect("/income-heads?ok=1");
  return res.redirect(`/income-heads?error=${encodeURIComponent(result.message || "Failed to create income head")}`);
});

// Deactivate / reactivate — never a hard delete (history is preserved).
router.post("/income-heads/:id/toggle", requireRole("admin"), async (req, res) => {
  const { res: cap, result } = captureServiceResponse();
  try {
    await toggleIncomeHeadService(req.params.id, req.body.isActive === "true", cap, req.user._id);
  } catch (err) {
    return res.redirect(`/income-heads?error=${encodeURIComponent(err.message || "Failed to update income head")}`);
  }
  if (result.ok) return res.redirect("/income-heads?ok=1");
  return res.redirect(`/income-heads?error=${encodeURIComponent(result.message || "Failed to update income head")}`);
});

module.exports = router;