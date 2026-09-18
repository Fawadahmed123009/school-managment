const Student = require("../../models/Students/students.model");
const ClassLevel = require("../../models/Academic/class.model");
const mongoose = require("mongoose");

/**
 * Build the step-1 preview: all active students in the source class
 * plus the list of all classes (for target dropdowns).
 */
exports.buildPromotionPreview = async (sourceClassId) => {
  const [students, allClasses] = await Promise.all([
    Student.find({
      classLevel: sourceClassId,
      status: { $ne: "inactive" },
      isGraduated: { $ne: true },
      isWithdrawn: { $ne: true },
    })
      .populate("classLevel", "name gradeLevel")
      .sort({ rollNumber: 1, name: 1 })
      .select("-password")
      .lean(),
    ClassLevel.find()
      .sort({ gradeLevel: 1, name: 1 })
      .select("name gradeLevel")
      .lean(),
  ]);

  return { students, allClasses };
};

/**
 * Execute the promotion batch.
 *
 * @param {Array<{studentId: string, action: string}>} promotions
 *   action is either a ClassLevel _id string or the literal "graduate".
 * @param {string} adminId
 * @returns {{successCount: number, failCount: number, failures: Array<{studentId: string, name: string, error: string}>}}
 */
exports.executePromotion = async (promotions, adminId) => {
  const failures = [];
  let successCount = 0;

  // Try to use a MongoDB transaction for atomicity.
  // If the deployment doesn't support transactions (standalone mongod),
  // fall back to sequential per-student updates.
  let session = null;
  let useTransaction = false;

  try {
    session = await mongoose.startSession();
    // Test whether this deployment supports transactions by checking
    // if the connection is a replica set or sharded cluster.
    const client = session.client;
    if (client && client.topology && client.topology.description) {
      const type = client.topology.description.type;
      useTransaction = type === "ReplicaSetNoPrimary" || type === "ReplicaSetWithPrimary" || type === "Sharded";
    }
  } catch (_err) {
    // Sessions not supported — fall back to non-transactional mode.
    useTransaction = false;
  }

  if (useTransaction && session) {
    try {
      session.startTransaction();

      for (const promo of promotions) {
        try {
          const student = await Student.findById(promo.studentId).session(session);
          if (!student) {
            failures.push({ studentId: promo.studentId, name: "Unknown", error: "Student not found" });
            continue;
          }

          if (promo.action === "graduate") {
            await Student.updateOne(
              { _id: promo.studentId },
              {
                isGraduated: true,
                status: "inactive",
                yearGraduated: String(new Date().getFullYear()),
              },
              { session }
            );
          } else {
            await Student.updateOne(
              { _id: promo.studentId },
              { classLevel: promo.action },
              { session }
            );
          }
          successCount++;
        } catch (err) {
          failures.push({
            studentId: promo.studentId,
            name: "Unknown",
            error: err.message,
          });
        }
      }

      if (failures.length > 0) {
        // If any student failed, abort the entire transaction so we don't
        // leave the batch in a partially-applied state.
        await session.abortTransaction();
        await session.endSession();
        // Re-run without transaction to get per-student results.
        return exports.executePromotion(promotions, adminId);
      }

      await session.commitTransaction();
      await session.endSession();
    } catch (err) {
      if (session.inTransaction) {
        await session.abortTransaction();
      }
      await session.endSession();
      // Fall back to non-transactional mode.
      return executeWithoutTransaction(promotions);
    }
  } else {
    if (session) await session.endSession();
    return executeWithoutTransaction(promotions);
  }

  return {
    successCount,
    failCount: failures.length,
    failures,
  };
};

/**
 * Fallback: sequential per-student updates without a transaction.
 */
async function executeWithoutTransaction(promotions) {
  const failures = [];
  let successCount = 0;

  for (const promo of promotions) {
    try {
      const student = await Student.findById(promo.studentId).select("name");
      if (!student) {
        failures.push({ studentId: promo.studentId, name: "Unknown", error: "Student not found" });
        continue;
      }

      if (promo.action === "graduate") {
        await Student.updateOne(
          { _id: promo.studentId },
          {
            isGraduated: true,
            status: "inactive",
            yearGraduated: String(new Date().getFullYear()),
          }
        );
      } else {
        await Student.updateOne(
          { _id: promo.studentId },
          { classLevel: promo.action }
        );
      }
      successCount++;
    } catch (err) {
      failures.push({
        studentId: promo.studentId,
        name: "Unknown",
        error: err.message,
      });
    }
  }

  return { successCount, failCount: failures.length, failures };
}
