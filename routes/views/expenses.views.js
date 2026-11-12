const express = require("express");
const router = express.Router();
const { requireRole } = require("../../middlewares/authView");
const { captureServiceResponse } = require("../../utils/viewServiceResponse");
const { localDateKey } = require("../../utils/localDateKey");
const {
  createExpenseHeadService,
  getAllExpenseHeadsService,
  toggleExpenseHeadService,
} = require("../../services/expenses/expenseHead.service");
const {
  createExpenseEntryService,
  getExpenseEntriesService,
} = require("../../services/expenses/expenseEntry.service");

// Expenses — Phase 3. ADMIN ONLY on every route (requireRole resolves the role
// from the DB via authView): managers never see expense heads, entries or totals
// anywhere in their UI, mirroring the Salary (Phase 2) restriction.

// ── helpers ─────────────────────────────────────────────────────────────────

function toISODate(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

// Money display follows the fees/salary views ("Rs", 2 decimals).
const fmtRs = (n) => "Rs " + Number(n || 0).toLocaleString(undefined, { maximumFractionDigits: 2 });

const EMPTY_PAGINATION = { total: 0, page: 1, limit: 20, pages: 0, hasPrev: false, hasNext: false };

// ── Expense entry form + history ────────────────────────────────────────────

router.get("/expenses", requireRole("admin"), async (req, res) => {
  const filters = {
    expenseHead: req.query.expenseHead || "",
    from: req.query.from || "",
    to: req.query.to || "",
    page: req.query.page,
    limit: "20",
  };

  let allHeads = [];
  let history = { entries: [], pagination: EMPTY_PAGINATION, runningTotal: 0, count: 0 };
  let loadError = null;

  try {
    const headsResult = await getAllExpenseHeadsService({ limit: 100 });
    allHeads = headsResult.data || [];
  } catch (err) {
    loadError = err.message;
  }

  try {
    const { res: cap, result } = captureServiceResponse();
    await getExpenseEntriesService(filters, cap);
    if (result.ok) history = result.body.data;
    else loadError = result.message;
  } catch (err) {
    loadError = err.message;
  }

  // The new-entry dropdown offers ACTIVE heads only; the history filter lists
  // every head so a deactivated head's past entries stay reachable.
  const activeHeads = allHeads.filter((h) => h.isActive);

  const entries = (history.entries || []).map((e) => ({
    ...e,
    dateKey: localDateKey(e.date),
    headName: e.expenseHead ? e.expenseHead.name : "—",
    headActive: e.expenseHead ? !!e.expenseHead.isActive : false,
    createdByName: e.createdBy ? e.createdBy.name : "—",
    rateFmt: fmtRs(e.unitRate),
    totalFmt: fmtRs(e.totalAmount),
  }));

  res.render("expenses/entries", {
    page: "expenses",
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

router.post("/expenses/create", requireRole("admin"), async (req, res) => {
  const { res: cap, result } = captureServiceResponse();
  try {
    // totalAmount is recomputed in the service — any client total is ignored.
    await createExpenseEntryService(req.body, req.user._id, cap);
  } catch (err) {
    return res.redirect(`/expenses?error=${encodeURIComponent(err.message || "Failed to record expense")}`);
  }
  if (result.ok) return res.redirect("/expenses?ok=1");
  return res.redirect(`/expenses?error=${encodeURIComponent(result.message || "Failed to record expense")}`);
});

// ── Expense head management ─────────────────────────────────────────────────

router.get("/expense-heads", requireRole("admin"), async (req, res) => {
  try {
    const result = await getAllExpenseHeadsService({ limit: 100 });
    res.render("expenses/heads", {
      page: "expense-heads",
      user: req.user,
      heads: result.data || [],
      loadError: null,
      ok: req.query.ok === "1",
      createError: req.query.error || null,
      schoolName: res.locals.schoolName,
    });
  } catch (err) {
    res.render("expenses/heads", {
      page: "expense-heads",
      user: req.user,
      heads: [],
      loadError: err.message,
      ok: false,
      createError: null,
      schoolName: res.locals.schoolName,
    });
  }
});

router.post("/expense-heads/create", requireRole("admin"), async (req, res) => {
  const { res: cap, result } = captureServiceResponse();
  try {
    await createExpenseHeadService({ name: req.body.name }, req.user._id, cap);
  } catch (err) {
    return res.redirect(`/expense-heads?error=${encodeURIComponent(err.message || "Failed to create expense head")}`);
  }
  if (result.ok) return res.redirect("/expense-heads?ok=1");
  return res.redirect(`/expense-heads?error=${encodeURIComponent(result.message || "Failed to create expense head")}`);
});

// Deactivate / reactivate — never a hard delete (history is preserved).
router.post("/expense-heads/:id/toggle", requireRole("admin"), async (req, res) => {
  const { res: cap, result } = captureServiceResponse();
  try {
    await toggleExpenseHeadService(req.params.id, req.body.isActive === "true", cap, req.user._id);
  } catch (err) {
    return res.redirect(`/expense-heads?error=${encodeURIComponent(err.message || "Failed to update expense head")}`);
  }
  if (result.ok) return res.redirect("/expense-heads?ok=1");
  return res.redirect(`/expense-heads?error=${encodeURIComponent(result.message || "Failed to update expense head")}`);
});

module.exports = router;
