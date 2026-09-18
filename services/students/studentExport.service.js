const XLSX = require("xlsx");
const PDFDocument = require("pdfkit");
const {
  Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell,
  ImageRun, WidthType, BorderStyle, AlignmentType, Header,
} = require("docx");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const Student = require("../../models/Students/students.model");
const ClassLevel = require("../../models/Academic/class.model");

const PDF_DIR = path.join(__dirname, "../../tmp/pdfs");
if (!fs.existsSync(PDF_DIR)) fs.mkdirSync(PDF_DIR, { recursive: true });

// ── Field definitions ──────────────────────────────────────────────────────────
// Each entry: { key, label, populate? }
// "populate" means we need to resolve a ref before displaying.
const ALL_FIELDS = [
  { key: "studentId",    label: "Student ID" },
  { key: "rollNumber",   label: "Roll Number" },
  { key: "name",         label: "Name" },
  { key: "fatherName",   label: "Father's Name" },
  { key: "email",        label: "Email" },
  { key: "className",    label: "Class",       populate: "classLevel" },
  { key: "programName",  label: "Program",     populate: "program" },
  { key: "gender",       label: "Gender" },
  { key: "address",      label: "Address" },
  { key: "whatsappNumber", label: "WhatsApp" },
  { key: "feeAgreed",    label: "Fee Agreed" },
  { key: "religion",     label: "Religion" },
  { key: "familyNumber", label: "Family Number" },
  { key: "status",       label: "Status" },
  { key: "dateAdmitted", label: "Date Admitted" },
];

exports.ALL_FIELDS = ALL_FIELDS;

// ── Query students based on scope ──────────────────────────────────────────────
async function queryStudents(scope, scopeValues) {
  const filter = {};

  if (scope === "class" && scopeValues && scopeValues.length > 0) {
    filter.classLevel = { $in: scopeValues };
  }
  // scope === "all" → no filter

  return Student.find(filter)
    .populate("classLevel", "name")
    .populate("program", "name")
    .sort({ rollNumber: 1 })
    .lean();
}

// ── Build row data for selected fields ─────────────────────────────────────────
function buildRows(students, selectedFieldKeys) {
  const fieldDefs = ALL_FIELDS.filter((f) => selectedFieldKeys.includes(f.key));

  return students.map((s) => {
    const row = {};
    fieldDefs.forEach((f) => {
      let val;
      switch (f.key) {
        case "className":
          val = s.classLevel ? s.classLevel.name : "";
          break;
        case "programName":
          val = s.program ? s.program.name : "";
          break;
        case "status":
          val = s.status === "inactive" ? "Inactive"
            : s.isWithdrawn ? "Withdrawn"
            : s.isGraduated ? "Graduated"
            : s.isSuspended ? "Suspended"
            : "Active";
          break;
        case "dateAdmitted":
          val = s.dateAdmitted ? new Date(s.dateAdmitted).toLocaleDateString() : "";
          break;
        default:
          val = s[f.key] != null ? String(s[f.key]) : "";
      }
      row[f.label] = val;
    });
    return row;
  });
}

// ── Add blank columns ──────────────────────────────────────────────────────────
function addBlankColumns(rows, count) {
  if (!count || count < 1) return rows;
  return rows.map((row) => {
    for (let i = 1; i <= count; i++) {
      row[`___blank_${i}`] = "";
    }
    return row;
  });
}

// ── Excel export ───────────────────────────────────────────────────────────────
exports.generateExcel = async (scope, scopeValues, selectedFields, blankCount) => {
  const students = await queryStudents(scope, scopeValues);
  let rows = buildRows(students, selectedFields);
  rows = addBlankColumns(rows, blankCount);

  const worksheet = XLSX.utils.json_to_sheet(rows);

  // Rename blank columns to empty headers
  const blankHeaders = [];
  for (let i = 1; i <= (blankCount || 0); i++) blankHeaders.push(`___blank_${i}`);
  if (blankHeaders.length > 0) {
    const range = XLSX.utils.decode_range(worksheet["!ref"] || "A1");
    // Find the columns that correspond to blank headers and clear them
    const headerRow = 0; // 0-indexed
    Object.keys(worksheet).forEach((cellRef) => {
      if (cellRef[0] !== "!") {
        const cell = worksheet[cellRef];
        if (cell && blankHeaders.includes(String(cell.v))) {
          cell.v = "";
          cell.w = "";
        }
      }
    });
  }

  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, worksheet, "Students");
  return XLSX.write(workbook, { type: "buffer", bookType: "xlsx" });
};

// ── PDF export ─────────────────────────────────────────────────────────────────
exports.generatePDF = async (scope, scopeValues, selectedFields, blankCount, schoolName) => {
  const students = await queryStudents(scope, scopeValues);
  let rows = buildRows(students, selectedFields);
  rows = addBlankColumns(rows, blankCount);

  const fieldDefs = ALL_FIELDS.filter((f) => selectedFields.includes(f.key));
  const headers = fieldDefs.map((f) => f.label);
  for (let i = 1; i <= (blankCount || 0); i++) headers.push("");

  const MARGIN = 28;
  const HEADER_RESERVE = 44; // space for repeating logo + title + divider
  const doc = new PDFDocument({ size: "A4", margin: MARGIN });
  const buffers = [];
  doc.on("data", (b) => buffers.push(b));

  const pageW = doc.page.width;   // 595.28
  const pageH = doc.page.height;  // 841.89
  const usableW = pageW - MARGIN * 2;

  // ── Reusable page header (logo + centered title + divider) ────────────────
  const LOGO_PATH = path.join(__dirname, "../../public/images/logo.jpg");
  const hasLogo = fs.existsSync(LOGO_PATH);

  function drawPageHeader() {
    const curY = MARGIN;
    if (hasLogo) {
      try { doc.image(LOGO_PATH, MARGIN, curY, { width: 30, height: 30 }); } catch { /* skip */ }
    }
    const textX = hasLogo ? MARGIN + 36 : MARGIN;
    doc.fontSize(16).font("Helvetica-Bold").fillColor("#000")
      .text("Avenir Academy", textX, curY + 2, { width: usableW - (textX - MARGIN), align: "center" });
    // Divider line
    const lineY = curY + HEADER_RESERVE - 6;
    doc.moveTo(MARGIN, lineY).lineTo(pageW - MARGIN, lineY).strokeColor("#ddd").lineWidth(0.5).stroke();
  }

  // Draw header on first page
  drawPageHeader();

  // Re-draw header on every subsequent page
  doc.on("pageAdded", () => {
    drawPageHeader();
  });

  let y = MARGIN + HEADER_RESERVE;

  // ── Build explicit key list matching headers (prevents stray columns) ───
  const resolvedKeys = fieldDefs.map((f) => f.label);
  for (let i = 1; i <= (blankCount || 0); i++) resolvedKeys.push(`___blank_${i}`);

  // ── Table dimensions ──────────────────────────────────────────────────────
  const colCount = headers.length;
  const tableWidth = usableW;
  const colWidth = Math.max(36, Math.floor(tableWidth / Math.max(colCount, 1)));
  const colWidths = headers.map(() => colWidth);
  const usedWidth = colWidths.reduce((a, b) => a + b, 0);
  colWidths[colWidths.length - 1] += tableWidth - usedWidth;

  const rowH = 16;
  const hdrH = 18;
  const fontSize = 7;

  // Helper: draw a bordered row
  function drawRow(cells, rowY, rh, isHeader) {
    doc.font(isHeader ? "Helvetica-Bold" : "Helvetica").fontSize(fontSize).fillColor("#000");
    let x = MARGIN;
    cells.forEach((cell, i) => {
      doc.text(String(cell || ""), x + 3, rowY + 3, { width: colWidths[i] - 6, align: "left", lineBreak: false });
      x += colWidths[i];
    });
    // Draw cell borders
    x = MARGIN;
    for (let i = 0; i < cells.length; i++) {
      doc.rect(x, rowY, colWidths[i], rh).stroke("#999");
      x += colWidths[i];
    }
  }

  // ── Header row ────────────────────────────────────────────────────────────
  drawRow(headers, y, hdrH, true);
  y += hdrH;

  // ── Data rows ─────────────────────────────────────────────────────────────
  rows.forEach((row) => {
    if (y + rowH > pageH - MARGIN) {
      doc.addPage();
      y = MARGIN + HEADER_RESERVE; // start below the repeating header
      // Re-draw table header row on new page
      drawRow(headers, y, hdrH, true);
      y += hdrH;
    }
    const vals = resolvedKeys.map((k) => (row[k] != null ? String(row[k]) : ""));
    drawRow(vals, y, rowH, false);
    y += rowH;
  });

  doc.end();

  return new Promise((resolve) => {
    doc.on("end", () => {
      resolve(Buffer.concat(buffers));
    });
  });
};

// ── DOCX export ────────────────────────────────────────────────────────────────
exports.generateDOCX = async (scope, scopeValues, selectedFields, blankCount) => {
  const students = await queryStudents(scope, scopeValues);
  let rows = buildRows(students, selectedFields);
  rows = addBlankColumns(rows, blankCount);

  const fieldDefs = ALL_FIELDS.filter((f) => selectedFields.includes(f.key));
  const headers = fieldDefs.map((f) => f.label);
  for (let i = 1; i <= (blankCount || 0); i++) headers.push("");

  // ── Word header section (repeats on every page via header1.xml) ─────────
  const LOGO_PATH = path.join(__dirname, "../../public/images/logo.jpg");
  const hasLogo = fs.existsSync(LOGO_PATH);

  const noBorder = { style: BorderStyle.NONE, size: 0 };
  const noBorders = { top: noBorder, bottom: noBorder, left: noBorder, right: noBorder };

  const logoCellChildren = [];
  if (hasLogo) {
    try {
      const logoData = fs.readFileSync(LOGO_PATH);
      logoCellChildren.push(
        new Paragraph({
          children: [
            new ImageRun({
              data: logoData,
              type: "jpg",
              transformation: { width: 48, height: 48 },
            }),
          ],
        })
      );
    } catch { /* skip logo */ }
  }

  // Borderless table: logo left, title centered, spacer right
  const headerTable = new Table({
    rows: [
      new TableRow({
        children: [
          new TableCell({
            children: logoCellChildren.length > 0
              ? logoCellChildren
              : [new Paragraph({ children: [] })],
            borders: noBorders,
            width: { size: 1500, type: WidthType.DXA },
            verticalAlign: "center",
          }),
          new TableCell({
            children: [
              new Paragraph({
                alignment: AlignmentType.CENTER,
                children: [
                  new TextRun({ text: "Avenir Academy", bold: true, size: 36 }),
                ],
              }),
            ],
            borders: noBorders,
            width: { size: 6000, type: WidthType.DXA },
            verticalAlign: "center",
          }),
          new TableCell({
            children: [new Paragraph({ children: [] })],
            borders: noBorders,
            width: { size: 1500, type: WidthType.DXA },
          }),
        ],
      }),
    ],
    width: { size: 9000, type: WidthType.DXA },
  });

  const docxHeader = new Header({
    children: [headerTable],
  });

  // ── Table border style ────────────────────────────────────────────────────
  const cellBorder = {
    top: { style: BorderStyle.SINGLE, size: 1, color: "999999" },
    bottom: { style: BorderStyle.SINGLE, size: 1, color: "999999" },
    left: { style: BorderStyle.SINGLE, size: 1, color: "999999" },
    right: { style: BorderStyle.SINGLE, size: 1, color: "999999" },
  };

  const colCount = headers.length;
  const colWidth = Math.floor(9000 / Math.max(colCount, 1));

  // ── Header row ────────────────────────────────────────────────────────────
  const headerRow = new TableRow({
    children: headers.map((h) =>
      new TableCell({
        children: [new Paragraph({ children: [new TextRun({ text: h, bold: true, size: 16 })] })],
        borders: cellBorder,
        width: { size: colWidth, type: WidthType.DXA },
      })
    ),
  });

  // ── Build explicit key list matching headers (prevents stray columns) ───
  const resolvedKeys = fieldDefs.map((f) => f.label);
  for (let i = 1; i <= (blankCount || 0); i++) resolvedKeys.push(`___blank_${i}`);

  // ── Data rows ─────────────────────────────────────────────────────────────
  const dataRows = rows.map((row) => {
    const vals = resolvedKeys.map((k) => (row[k] != null ? String(row[k]) : ""));
    return new TableRow({
      children: vals.map((v) =>
        new TableCell({
          children: [new Paragraph({ children: [new TextRun({ text: v, size: 16 })] })],
          borders: cellBorder,
          width: { size: colWidth, type: WidthType.DXA },
        })
      ),
    });
  });

  // Column widths array must match per-cell widths so tblGrid and tcW are consistent
  const columnWidths = headers.map(() => colWidth);

  const doc = new Document({
    sections: [
      {
        headers: {
          default: docxHeader,
        },
        children: [
          new Table({
            rows: [headerRow, ...dataRows],
            width: { size: 9000, type: WidthType.DXA },
            columnWidths,
          }),
        ],
      },
    ],
  });

  return Packer.toBuffer(doc);
};

// ── Fetch filter options for the form ──────────────────────────────────────────
exports.getExportOptions = async () => {
  const classes = await ClassLevel.find().sort({ gradeLevel: 1, name: 1 }).lean();
  return { classes, fields: ALL_FIELDS };
};
