const mongoose = require("mongoose");
const { ObjectId } = mongoose.Schema;

/**
 * General audit trail (foundation) — NEW collection `audit_logs`, additive
 * only: no existing schema is touched. One append-only document per audited
 * finance/attendance action, carrying:
 *   • who   – `userId` + `userRole` (role resolved from the DB at write time,
 *             never from a token/cookie claim)
 *   • what  – `actionType`, `entityType`, `entityId` and a human-readable
 *             `summary`; optional `beforeSnapshot` / `afterSnapshot` hold ONLY
 *             the changed fields (never full documents) to stay lightweight
 *   • where – `ipAddress` (optional, captured from the request context)
 *   • when  – `timestamp`
 *
 * Unlike the fees/test deletion audits (fail-CLOSED), this trail is
 * fail-OPEN by design: services/audit/auditLog.service.js writes it
 * fire-and-forget, so an audit hiccup can never block or fail the original
 * action — failures go to the server error log instead. Nothing in the app
 * updates or deletes these rows.
 */
const auditLogSchema = new mongoose.Schema(
  {
    userId: {
      type: ObjectId,
      required: true,
      index: true,
    },
    userRole: {
      type: String,
      required: true,
    },
    actionType: {
      type: String,
      enum: ["create", "update", "deactivate", "activate", "generate", "finalize"],
      required: true,
      index: true,
    },
    entityType: {
      type: String,
      enum: [
        "expense_head",
        "expense_entry",
        "income_head",
        "income_entry",
        "pay_config",
        "salary_run",
        "teacher_attendance",
        "teacher_expected_times",
      ],
      required: true,
      index: true,
    },
    entityId: {
      type: ObjectId,
    },
    summary: {
      type: String,
      required: true,
    },
    // { field: value } of ONLY the changed fields — null when not applicable
    // (creates have no before; some actions carry no snapshot at all).
    beforeSnapshot: {
      type: mongoose.Schema.Types.Mixed,
      default: null,
    },
    afterSnapshot: {
      type: mongoose.Schema.Types.Mixed,
      default: null,
    },
    ipAddress: {
      type: String,
      default: "",
    },
    timestamp: {
      type: Date,
      default: Date.now,
      index: true,
    },
  },
  {
    // The trail is append-only — no updatedAt, and the app never writes twice.
    timestamps: false,
    collection: "audit_logs",
  }
);

// Viewer queries: newest-first overall, and per entity / per user filters.
auditLogSchema.index({ timestamp: -1 });
auditLogSchema.index({ entityType: 1, timestamp: -1 });
auditLogSchema.index({ userId: 1, timestamp: -1 });

module.exports = mongoose.model("AuditLog", auditLogSchema);