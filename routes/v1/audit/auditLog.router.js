const express = require("express");
const auditLogRouter = express.Router();

const isLoggedIn = require("../../../middlewares/isLoggedIn");
const isAdmin = require("../../../middlewares/isAdmin");

const {
  getAuditLogsController,
  getAuditLogMetaController,
} = require("../../../controllers/audit/auditLog.controller");

// Audit trail viewer — ADMIN ONLY on every route (isAdmin resolves the role
// from the DB): the trail spans finance + attendance, so managers (who can
// mark attendance) must never read it. Read-only surface — the trail itself
// is append-only and written exclusively by the service-layer hooks.
auditLogRouter.route("/audit-logs").get(isLoggedIn, isAdmin, getAuditLogsController);
auditLogRouter.route("/audit-logs/meta").get(isLoggedIn, isAdmin, getAuditLogMetaController);

module.exports = auditLogRouter;