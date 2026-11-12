const express = require("express");
const router = express.Router();
const { requireRole } = require("../../middlewares/authView");
const { captureServiceResponse } = require("../../utils/viewServiceResponse");
const {
  getAuditLogsService,
  getAuditLogMetaService,
  ENTITY_TYPES,
  formatDay,
  formatMoney,
} = require("../../services/audit/auditLog.service");

// Audit trail viewer — ADMIN ONLY (requireRole resolves the role from the DB
// via authView). The trail spans finance + attendance, so managers never see
// it. Read-only: rows are written exclusively by the fail-open service hooks.

// ── display helpers (human-readable, never raw JSON) ────────────────────────

const ENTITY_LABELS = {
  expense_head: "Expense head",
  expense_entry: "Expense entry",
  income_head: "Income head",
  income_entry: "Income entry",
  pay_config: "Pay config",
  salary_run: "Salary run",
  teacher_attendance: "Teacher attendance",
  teacher_expected_times: "Expected times",
};

const ACTION_LABELS = {
  create: "Create",
  update: "Update",
  deactivate: "Deactivate",
  activate: "Activate",
  generate: "Generate",
  finalize: "Finalize",
};

// Reuses the existing pill palette from the admin panels.
const ACTION_PILL = {
  create: "paid",
  update: "pending",
  deactivate: "error",
  activate: "paid",
  generate: "partial",
  finalize: "ocr",
};

const FIELD_LABELS = {
  name: "Name",
  isActive: "Active",
  expenseHead: "Expense head",
  incomeHead: "Income head",
  date: "Date",
  itemName: "Item",
  description: "Description",
  quantity: "Quantity",
  unitRate: "Unit rate",
  totalAmount: "Total",
  teacher: "Teacher",
  payType: "Pay type",
  rateAmount: "Rate",
  effectiveFrom: "Effective from",
  periodStart: "Period start",
  periodEnd: "Period end",
  status: "Status",
  grossAmount: "Gross amount",
  lateDeductionAmount: "Late deduction",
  netAmount: "Net amount",
  totalWorkingDays: "Working days",
  totalWorkingHours: "Working hours",
  lateDays: "Late days",
  lectureCount: "Lectures",
  finalizedAt: "Finalized at",
  arrivalTime: "Arrival",
  departureTime: "Departure",
  arrivalSource: "Arrival source",
  departureSource: "Departure source",
  expectedArrivalTime: "Expected arrival",
  expectedDepartureTime: "Expected departure",
};

const MONEY_FIELDS = new Set(["unitRate", "totalAmount", "rateAmount", "grossAmount", "lateDeductionAmount", "netAmount"]);
const DAY_FIELDS = new Set(["date", "effectiveFrom", "periodStart", "periodEnd"]);

const pad2 = (n) => String(n).padStart(2, "0");

// Server-local "12 Nov 2026, 14:05" (never toISOString — UTC shift).
function fmtTimestamp(d) {
  const date = d instanceof Date ? d : new Date(d);
  if (Number.isNaN(date.getTime())) return "—";
  return `${formatDay(date)}, ${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
}

function fmtValue(key, value) {
  if (value === undefined || value === null || value === "") return "—";
  if (MONEY_FIELDS.has(key)) return formatMoney(value);
  if (DAY_FIELDS.has(key)) return formatDay(value);
  if (key === "finalizedAt") return fmtTimestamp(value);
  if (key === "isActive") return value ? "Yes" : "No";
  if (value instanceof Date) return fmtTimestamp(value);
  return String(value);
}

// Expandable detail rows: ONLY the changed fields, formatted for humans.
// Creates (no before) render as Field/Value; updates as Field/Before/After.
function buildDetailRows(before, after) {
  const hasBefore = !!before && Object.keys(before).length > 0;
  const hasAfter = !!after && Object.keys(after).length > 0;
  if (!hasBefore && !hasAfter) return { hasBefore: false, rows: [] };
  const keys = [...new Set([...Object.keys(after || {}), ...Object.keys(before || {})])];
  const rows = keys.map((key) => ({
    label: FIELD_LABELS[key] || key,
    before: hasBefore ? fmtValue(key, (before || {})[key]) : null,
    after: fmtValue(key, (after || {})[key]),
  }));
  return { hasBefore, rows };
}

const EMPTY_PAGINATION = { total: 0, page: 1, limit: 25, pages: 0, hasPrev: false, hasNext: false };

// ── Audit log page ──────────────────────────────────────────────────────────

router.get("/audit-logs", requireRole("admin"), async (req, res) => {
  const filters = {
    from: req.query.from || "",
    to: req.query.to || "",
    entityType: req.query.entityType || "",
    userId: req.query.userId || "",
    page: req.query.page,
    limit: "25",
  };

  let logs = [];
  let pagination = EMPTY_PAGINATION;
  let users = [];
  let loadError = null;

  try {
    const { res: cap, result } = captureServiceResponse();
    await getAuditLogsService(filters, cap);
    if (result.ok) {
      logs = result.body.data.logs || [];
      pagination = result.body.data.pagination || EMPTY_PAGINATION;
    } else {
      loadError = result.message;
    }
  } catch (err) {
    loadError = err.message;
  }

  try {
    const { res: cap, result } = captureServiceResponse();
    await getAuditLogMetaService(cap);
    if (result.ok) users = result.body.data.users || [];
  } catch {
    // The user filter is a convenience — its failure must not hide the trail.
  }

  const rows = logs.map((r) => {
    const detail = buildDetailRows(r.beforeSnapshot, r.afterSnapshot);
    return {
      _id: r._id,
      timeFmt: fmtTimestamp(r.timestamp),
      userName: r.userName || "Unknown",
      userRole: r.userRole || "unknown",
      actionLabel: ACTION_LABELS[r.actionType] || r.actionType,
      actionPill: ACTION_PILL[r.actionType] || "manual",
      entityLabel: ENTITY_LABELS[r.entityType] || r.entityType,
      summary: r.summary,
      ipAddress: r.ipAddress || "",
      hasBefore: detail.hasBefore,
      detailRows: detail.rows,
    };
  });

  res.render("audit/logs", {
    page: "audit-logs",
    user: req.user,
    rows,
    pagination,
    filters,
    entityTypes: ENTITY_TYPES.map((t) => ({ value: t, label: ENTITY_LABELS[t] || t })),
    users,
    loadError,
    schoolName: res.locals.schoolName,
  });
});

module.exports = router;