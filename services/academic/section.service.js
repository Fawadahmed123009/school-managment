const Section = require("../../models/Academic/section.model");
const ClassLevel = require("../../models/Academic/class.model");
const responseStatus = require("../../handlers/responseStatus.handler");

/**
 * Create a new section.
 */
exports.createSectionService = async (data, userId, res) => {
  const { name } = data;

  if (!name || !name.trim()) {
    return responseStatus(res, 400, "failed", "Section name is required");
  }

  const normalized = name.trim();
  const existing = await Section.findOne({ name: normalized });
  if (existing) {
    return responseStatus(res, 402, "failed", "Section already exists");
  }

  const created = await Section.create({
    name: normalized,
    createdBy: userId,
  });

  return responseStatus(res, 200, "success", created);
};

/**
 * Get all sections (sorted by name).
 */
exports.getAllSectionsService = async () => {
  return await Section.find().sort({ name: 1 }).lean();
};

/**
 * Get a single section by ID.
 */
exports.getSectionService = async (id) => {
  return await Section.findById(id);
};

/**
 * Update section name.
 */
exports.updateSectionService = async (data, id, userId, res) => {
  const { name } = data;

  if (name !== undefined) {
    const normalized = name.trim();
    if (!normalized) {
      return responseStatus(res, 400, "failed", "Section name cannot be empty");
    }
    const taken = await Section.findOne({ name: normalized, _id: { $ne: id } });
    if (taken) {
      return responseStatus(res, 402, "failed", "Another section already uses that name");
    }
  }

  const updated = await Section.findByIdAndUpdate(
    id,
    {
      ...(name !== undefined && { name: name.trim() }),
      createdBy: userId,
    },
    { new: true }
  );

  if (!updated) return responseStatus(res, 404, "failed", "Section not found");
  return responseStatus(res, 200, "success", updated);
};

/**
 * Toggle the isActive flag on a section.
 */
exports.toggleSectionActiveService = async (id, res) => {
  const section = await Section.findById(id);
  if (!section) return responseStatus(res, 404, "failed", "Section not found");

  section.isActive = !section.isActive;
  await section.save();

  return responseStatus(res, 200, "success", section);
};

/**
 * Delete a section — blocked if any ClassLevel still references it.
 */
exports.deleteSectionService = async (id, res) => {
  const section = await Section.findById(id);
  if (!section) return responseStatus(res, 404, "failed", "Section not found");

  // Block deletion when any ClassLevel references this section
  const classCount = await ClassLevel.countDocuments({ sectionRef: id });
  if (classCount > 0) {
    return responseStatus(
      res,
      403,
      "failed",
      `Cannot delete section: ${classCount} class(es) still reference it`
    );
  }

  await Section.findByIdAndDelete(id);
  return responseStatus(res, 200, "success", "Section deleted");
};
