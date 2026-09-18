const express = require("express");
const router = express.Router();
const { requireAdminOrManager } = require("../../middlewares/authView");
const { verifyCsrf } = require("../../middlewares/csrf");
const { getExportOptions, generateExcel, generatePDF, generateDOCX } = require("../../services/students/studentExport.service");

// GET /students/export — render the export form
router.get("/students/export", requireAdminOrManager(), async (req, res) => {
  try {
    const options = await getExportOptions();
    res.render("students/export", {
      page: "students-export",
      user: req.user,
      classes: options.classes,
      fields: options.fields,
      exportError: req.query.error || null,
      schoolName: res.locals.schoolName,
    });
  } catch (err) {
    res.render("students/export", {
      page: "students-export",
      user: req.user,
      classes: [],
      fields: [],
      exportError: err.message,
      schoolName: res.locals.schoolName,
    });
  }
});

// POST /students/export — generate and download the file
router.post("/students/export", requireAdminOrManager(), verifyCsrf, async (req, res) => {
  try {
    const { format, scope, classes, fields, blankCount } = req.body;

    // Validate format
    if (!["xlsx", "pdf", "docx"].includes(format)) {
      return res.redirect("/students/export?error=" + encodeURIComponent("Invalid export format"));
    }

    // Resolve scope values
    let scopeValues = [];
    if (scope === "class") {
      scopeValues = Array.isArray(classes) ? classes : classes ? [classes] : [];
      if (scopeValues.length === 0) {
        return res.redirect("/students/export?error=" + encodeURIComponent("Please select at least one class"));
      }
    }

    // Validate fields
    const selectedFields = Array.isArray(fields) ? fields : fields ? [fields] : [];
    if (selectedFields.length === 0) {
      return res.redirect("/students/export?error=" + encodeURIComponent("Please select at least one field"));
    }

    const blankCols = parseInt(blankCount, 10) || 0;
    const schoolName = res.locals.schoolName || process.env.SCHOOL_NAME || "School Portal";

    if (format === "xlsx") {
      const buffer = await generateExcel(scope, scopeValues, selectedFields, blankCols);
      res.setHeader("Content-Disposition", "attachment; filename=students-export.xlsx");
      res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
      return res.send(buffer);
    }

    if (format === "docx") {
      const buffer = await generateDOCX(scope, scopeValues, selectedFields, blankCols);
      res.setHeader("Content-Disposition", "attachment; filename=students-export.docx");
      res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
      return res.send(buffer);
    }

    // PDF
    const buffer = await generatePDF(scope, scopeValues, selectedFields, blankCols, schoolName);
    res.setHeader("Content-Disposition", "attachment; filename=students-export.pdf");
    res.setHeader("Content-Type", "application/pdf");
    return res.send(buffer);
  } catch (err) {
    return res.redirect("/students/export?error=" + encodeURIComponent(err.message || "Export failed"));
  }
});

module.exports = router;
