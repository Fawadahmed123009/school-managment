const responseStatus = require("../../handlers/responseStatus.handler");
const IncomeHead = require("../../models/Income/incomeHead.model");
const { paginate } = require("../../utils/paginate");

// Escape free-text before building a RegExp so metacharacters can't throw or
// match unintended heads (same rule as findOrCreateFeeHeadByName / ExpenseHead).
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// ---- Income head management (admin only) ----

// Create a head. Names are unique case-insensitively (mirrors FeeHead /
// ExpenseHead) so the catalog stays clean; there is no fixed/hardcoded list —
// admins add any ad-hoc income category (Notes Sale, Donation Received, …).
exports.createIncomeHeadService = async (data, adminId, res) => {
  const name = (data && data.name ? String(data.name) : "").trim();
  if (!name) return responseStatus(res, 400, "failed", "Name is required");

  const exists = await IncomeHead.findOne({
    name: { $regex: new RegExp(`^${escapeRe(name)}$`, "i") },
  });
  if (exists) return responseStatus(res, 409, "failed", "Income head already exists");

  const head = await IncomeHead.create({ name, createdBy: adminId });
  return responseStatus(res, 201, "success", head);
};

// List heads (paginated, sorted by name). `activeOnly` restricts to active heads
// — the new-entry dropdown uses it so a deactivated head can't be selected for a
// new income entry, while the history filter still lists every head.
exports.getAllIncomeHeadsService = async (query = {}) => {
  const filter = {};
  const activeOnly = query.activeOnly;
  if (activeOnly === true || activeOnly === "true" || activeOnly === "1") {
    filter.isActive = true;
  }
  return await paginate(IncomeHead, filter, {
    page: query.page,
    limit: query.limit,
    sort: "name",
  });
};

// Deactivate / reactivate a head. NEVER hard-deletes: past income entries keep
// their reference and stay reportable even while the head is hidden from new
// entries (preserves history — same rule as ExpenseHead).
exports.toggleIncomeHeadService = async (id, isActive, res) => {
  const head = await IncomeHead.findByIdAndUpdate(id, { isActive: !!isActive }, { new: true });
  if (!head) return responseStatus(res, 404, "failed", "Income head not found");
  return responseStatus(res, 200, "success", head);
};