const mongoose = require("mongoose");
const { ObjectId } = mongoose.Schema;

/**
 * Append-only audit trail for fee-record mutations (C2).
 *
 * Fee records are money: a deletion or an amount/status edit must always be
 * attributable. One document is written per audited action, carrying:
 *   • who      – `actor` (the admin resolved from the session/token id)
 *   • what     – `action`, the fee id, and a `changes` diff / `snapshot`
 *   • when     – `createdAt`
 *
 * Nothing in the app updates or deletes these rows; the only writer is
 * services/fees/fees.service.js. A mutation whose audit row cannot be written
 * is refused (fail-closed), so an untracked financial change is not possible.
 */
const feeAuditSchema = new mongoose.Schema(
  {
    action: {
      type: String,
      enum: [
        "create",
        "update",
        "delete",
        "bulk_assign",
        "bulk_create",
        "generate_monthly",
        "ocr_resolve",
      ],
      required: true,
      index: true,
    },
    // Fee document affected. Null for aggregate operations, which write a
    // single summary row instead of one per record.
    fee: {
      type: ObjectId,
      ref: "Fees",
    },
    student: {
      type: ObjectId,
      ref: "Student",
    },
    actor: {
      type: ObjectId,
      ref: "Admin",
      required: true,
      index: true,
    },
    // Amount / head / status at the time of the action, so a later edit of the
    // fee itself can never rewrite history.
    amount: {
      type: Number,
    },
    feeType: {
      type: String,
    },
    status: {
      type: String,
    },
    // { field: { from, to } } for updates; full field copy for deletes.
    changes: {
      type: mongoose.Schema.Types.Mixed,
    },
    note: {
      type: String,
    },
  },
  {
    timestamps: { createdAt: true, updatedAt: false },
  }
);

feeAuditSchema.index({ createdAt: -1 });

module.exports = mongoose.model("FeeAudit", feeAuditSchema);
