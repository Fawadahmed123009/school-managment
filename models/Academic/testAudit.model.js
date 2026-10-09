const mongoose = require("mongoose");
const { ObjectId } = mongoose.Schema;

/**
 * Append-only audit trail for test mutations.
 *
 * A test carries student scores (TestResult documents). Deleting one destroys
 * that data permanently, so every deletion must be attributable. One document
 * is written per audited action, carrying:
 *   • who    – `actor` (the admin/manager id resolved from the *verified* token
 *               id and looked up in the DB), plus a denormalized `actorName` /
 *               `actorRole` snapshot so the trail is readable without joins.
 *   • what   – `action`, the test id, and a full `snapshot` of the test's own
 *               fields (name, subject, classes, scale…) captured at delete time.
 *   • impact – `resultsRemoved`: how many submitted scores were destroyed.
 *   • when   – `createdAt`
 *
 * Nothing in the app updates or deletes these rows; the only writer is
 * services/academic/test.service.js. A mutation whose audit row cannot be
 * written is refused (fail-closed), so an untracked test deletion is not
 * possible — the same guarantee the fee audit gives for money records.
 */
const testAuditSchema = new mongoose.Schema(
  {
    action: {
      type: String,
      enum: ["delete"],
      required: true,
      index: true,
    },
    // Test document affected.
    test: {
      type: ObjectId,
      ref: "Test",
      required: true,
      index: true,
    },
    // The admin or manager (teacher with isAttendanceManager) who performed the
    // action, resolved from the DB. Stored without a single strict ref because
    // it may point at either an Admin or a Teacher document; the name/role
    // snapshot below makes the trail self-describing regardless.
    actor: {
      type: ObjectId,
      required: true,
      index: true,
    },
    actorName: {
      type: String,
    },
    actorRole: {
      type: String,
      enum: ["admin", "manager"],
    },
    // Full pre-image of the test's own fields at the moment of deletion, so a
    // later edit of any related document can never rewrite history.
    snapshot: {
      type: mongoose.Schema.Types.Mixed,
      required: true,
    },
    // How many submitted scores were destroyed with the test.
    resultsRemoved: {
      type: Number,
      default: 0,
    },
    note: {
      type: String,
    },
  },
  {
    timestamps: { createdAt: true, updatedAt: false },
  }
);

testAuditSchema.index({ createdAt: -1 });

module.exports = mongoose.model("TestAudit", testAuditSchema);
