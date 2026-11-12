const responseStatus = require("../../handlers/responseStatus.handler");
const {
  getAuditLogsService,
  getAuditLogMetaService,
} = require("../../services/audit/auditLog.service");

// Read-only audit trail viewer (isLoggedIn + isAdmin at the router). The
// trail is written exclusively by the fail-open service hooks — there is no
// create/update/delete surface here by design.

exports.getAuditLogsController = async (req, res) => {
  try {
    const filters = {
      from: req.query.from || "",
      to: req.query.to || "",
      entityType: req.query.entityType || "",
      userId: req.query.userId || "",
      page: req.query.page,
      limit: req.query.limit,
    };
    await getAuditLogsService(filters, res);
  } catch (error) {
    responseStatus(res, 400, "failed", error.message);
  }
};

exports.getAuditLogMetaController = async (req, res) => {
  try {
    await getAuditLogMetaService(res);
  } catch (error) {
    responseStatus(res, 400, "failed", error.message);
  }
};