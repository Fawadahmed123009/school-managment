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
// "photo" is first so it lands as the leftmost column when selected.
const ALL_FIELDS = [
  { key: "photo",        label: "Photo" },
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
async function queryStudents(scope, scopeValues, includeInactive) {
  const filter = {};

  if (scope === "class" && scopeValues && scopeValues.length > 0) {
    filter.classLevel = { $in: scopeValues };
  }

  // Finding 4.5: default "all" scope to active students only unless explicitly opted in
  if (!includeInactive) {
    filter.status = { $ne: "inactive" };
    filter.isWithdrawn = { $ne: true };
  }

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
        case "photo":
          // Raw URL only — used directly by the Excel hyperlink step.
          // PDF/docx ignore this value and fetch the actual image bytes
          // separately (see fetchPhotosForStudents), correlated by the
          // same array order as `students`.
          val = s.photoUrl || "";
          break;
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

// ── Photo fetching (PDF/docx need real bytes, not a URL) ───────────────────────
// Detects the real image type from the downloaded bytes themselves — NOT from
// the URL's file extension or any header we're told to trust. This is
// deliberate: trusting an untrusted extension/label caused the earlier docx
// ".undefined" embedded-image corruption bug. Sniffing the actual magic bytes
// means a wrong/missing extension can never produce a broken embed again.
function detectImageType(buffer) {
  if (!buffer || buffer.length < 4) return null;
  if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) return "png";
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return "jpg";
  if (buffer.slice(0, 3).toString("ascii") === "GIF") return "gif";
  return null; // unknown/unsupported — caller must skip embedding, never guess
}

async function fetchImageBuffer(url) {
  if (!url) return null;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return null;
    const arrayBuffer = await res.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    const type = detectImageType(buffer);
    if (!type) return null; // couldn't verify it's a real, supported image
    return { buffer, type };
  } catch {
    return null; // network failure, timeout, bad URL — never crash the export
  }
}

// Fetches photos for a list of students with limited concurrency, so a
// large "all classes" export doesn't fire hundreds of simultaneous requests
// at once. Returns a Map keyed by array index (same order as `students`).
async function fetchPhotosForStudents(students, concurrency = 8) {
  const photoMap = new Map();
  let idx = 0;
  async function worker() {
    while (idx < students.length) {
      const i = idx++;
      const result = await fetchImageBuffer(students[i].photoUrl);
      photoMap.set(i, result); // result is { buffer, type } or null
    }
  }
  const workerCount = Math.min(concurrency, students.length) || 0;
  const workers = Array.from({ length: workerCount }, worker);
  await Promise.all(workers);
  return photoMap;
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

  // Photo column → convert each cell's raw URL into a clickable hyperlink
  // ("View Photo" text). SheetJS/xlsx cannot embed actual images into cells
  // in its free version — a hyperlink is the correct approach here, not an
  // embedded thumbnail.
  if (selectedFields.includes("photo")) {
    const range = XLSX.utils.decode_range(worksheet["!ref"] || "A1");
    let photoCol = -1;
    for (let c = range.s.c; c <= range.e.c; c++) {
      const headerCell = worksheet[XLSX.utils.encode_cell({ r: 0, c })];
      if (headerCell && headerCell.v === "Photo") { photoCol = c; break; }
    }
    if (photoCol !== -1) {
      for (let r = 1; r <= range.e.r; r++) {
        const ref = XLSX.utils.encode_cell({ r, c: photoCol });
        const cell = worksheet[ref];
        if (cell && cell.v) {
          const url = cell.v;
          worksheet[ref] = {
            t: "s",
            v: "View Photo",
            l: { Target: url, Tooltip: "Open student photo" },
          };
        }
      }
    }
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

  const includesPhoto = selectedFields.includes("photo");
  // Only pay the network cost of fetching images when Photo is actually selected.
  const photoMap = includesPhoto ? await fetchPhotosForStudents(students) : new Map();

  const fieldDefs = ALL_FIELDS.filter((f) => selectedFields.includes(f.key));
  const headers = fieldDefs.map((f) => f.label);
  for (let i = 1; i <= (blankCount || 0); i++) headers.push("");

  const photoColIndex = includesPhoto ? fieldDefs.findIndex((f) => f.key === "photo") : -1;

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
      .text(schoolName || "School Portal", textX, curY + 2, { width: usableW - (textX - MARGIN), align: "center" });
    const lineY = curY + HEADER_RESERVE - 6;
    doc.moveTo(MARGIN, lineY).lineTo(pageW - MARGIN, lineY).strokeColor("#ddd").lineWidth(0.5).stroke();
  }

  drawPageHeader();
  doc.on("pageAdded", () => { drawPageHeader(); });

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

  const THUMB = 72; // passport-photo size in points (72pt = 1 inch)
  const rowH = includesPhoto ? THUMB + 8 : 16;
  const hdrH = 18;
  const fontSize = 7;

  // Helper: draw a bordered row. `photoResult` is { buffer, type } or null/undefined.
  function drawRow(cells, rowY, rh, isHeader, photoResult) {
    doc.font(isHeader ? "Helvetica-Bold" : "Helvetica").fontSize(fontSize).fillColor("#000");
    let x = MARGIN;
    cells.forEach((cell, i) => {
      if (!isHeader && i === photoColIndex) {
        if (photoResult && photoResult.buffer) {
          try {
            const size = Math.min(THUMB, colWidths[i] - 4);
            doc.image(photoResult.buffer, x + 2, rowY + 2, { width: size, height: size, fit: [size, size] });
          } catch { /* corrupt/unsupported image data — leave cell blank rather than crash */ }
        }
      } else {
        doc.text(String(cell || ""), x + 3, rowY + 3, { width: colWidths[i] - 6, align: "left", lineBreak: false });
      }
      x += colWidths[i];
    });
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
  rows.forEach((row, i) => {
    if (y + rowH > pageH - MARGIN) {
      doc.addPage();
      y = MARGIN + HEADER_RESERVE;
      drawRow(headers, y, hdrH, true);
      y += hdrH;
    }
    const vals = resolvedKeys.map((k) => (row[k] != null ? String(row[k]) : ""));
    const photoResult = includesPhoto ? photoMap.get(i) : null;
    drawRow(vals, y, rowH, false, photoResult);
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
exports.generateDOCX = async (scope, scopeValues, selectedFields, blankCount, schoolName) => {
  const students = await queryStudents(scope, scopeValues);
  let rows = buildRows(students, selectedFields);
  rows = addBlankColumns(rows, blankCount);

  const includesPhoto = selectedFields.includes("photo");
  const photoMap = includesPhoto ? await fetchPhotosForStudents(students) : new Map();

  const fieldDefs = ALL_FIELDS.filter((f) => selectedFields.includes(f.key));
  const headers = fieldDefs.map((f) => f.label);
  for (let i = 1; i <= (blankCount || 0); i++) headers.push("");

  const photoColIndex = includesPhoto ? fieldDefs.findIndex((f) => f.key === "photo") : -1;

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
            new ImageRun({ data: logoData, type: "jpg", transformation: { width: 48, height: 48 } }),
          ],
        })
      );
    } catch { /* skip logo */ }
  }

  const headerTable = new Table({
    rows: [
      new TableRow({
        children: [
          new TableCell({
            children: logoCellChildren.length > 0 ? logoCellChildren : [new Paragraph({ children: [] })],
            borders: noBorders,
            width: { size: 1500, type: WidthType.DXA },
            verticalAlign: "center",
          }),
          new TableCell({
            children: [
              new Paragraph({
                alignment: AlignmentType.CENTER,
                children: [new TextRun({ text: schoolName || "School Portal", bold: true, size: 36 })],
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

  const docxHeader = new Header({ children: [headerTable] });

  const cellBorder = {
    top: { style: BorderStyle.SINGLE, size: 1, color: "999999" },
    bottom: { style: BorderStyle.SINGLE, size: 1, color: "999999" },
    left: { style: BorderStyle.SINGLE, size: 1, color: "999999" },
    right: { style: BorderStyle.SINGLE, size: 1, color: "999999" },
  };

  const colCount = headers.length;
  const colWidth = Math.floor(9000 / Math.max(colCount, 1));

  const headerRow = new TableRow({
    children: headers.map((h) =>
      new TableCell({
        children: [new Paragraph({ children: [new TextRun({ text: h, bold: true, size: 16 })] })],
        borders: cellBorder,
        width: { size: colWidth, type: WidthType.DXA },
      })
    ),
  });

  const resolvedKeys = fieldDefs.map((f) => f.label);
  for (let i = 1; i <= (blankCount || 0); i++) resolvedKeys.push(`___blank_${i}`);

  const THUMB_DXA = 1440; // 1440 DXA = 1 inch, passport-photo size
  // Finding 4.4: shrink photo thumbnail when many columns to avoid table overflow
  const effectiveThumb = colCount > 8 ? Math.min(THUMB_DXA, Math.max(colWidth, 720)) : THUMB_DXA;
  const photoPx = Math.round(effectiveThumb / 15); // DXA to px (approx 96px per inch)

  const dataRows = rows.map((row, rowIdx) => {
    const vals = resolvedKeys.map((k) => (row[k] != null ? String(row[k]) : ""));
    const photoResult = includesPhoto ? photoMap.get(rowIdx) : null;

    return new TableRow({
      children: vals.map((v, colIdx) => {
        let children;
        if (colIdx === photoColIndex) {
          if (photoResult && photoResult.buffer) {
            try {
              children = [
                new Paragraph({
                  children: [
                    new ImageRun({
                      data: photoResult.buffer,
                      type: photoResult.type, // detected from real bytes — never guessed
                      transformation: { width: photoPx, height: photoPx },
                    }),
                  ],
                }),
              ];
            } catch {
              children = [new Paragraph({ children: [] })];
            }
          } else {
            children = [new Paragraph({ children: [] })];
          }
        } else {
          children = [new Paragraph({ children: [new TextRun({ text: v, size: 16 })] })];
        }
        return new TableCell({
          children,
          borders: cellBorder,
          width: { size: colIdx === photoColIndex ? Math.max(colWidth, effectiveThumb) : colWidth, type: WidthType.DXA },
        });
      }),
    });
  });

  const columnWidths = headers.map((h, i) => (i === photoColIndex ? Math.max(colWidth, effectiveThumb) : colWidth));

  const doc = new Document({
    sections: [
      {
        headers: { default: docxHeader },
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