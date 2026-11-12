/**
 * Shared CSV / Excel (.xlsx) file helpers for the finance export layer
 * (daily/monthly/yearly reports + expense/income history).
 *
 * Pure formatting + delivery — no data access lives here. Rows arrive as
 * arrays of arrays (row 0 = header) so CSV and XLSX always carry the SAME
 * data in the same order.
 *
 * Excel styling uses xlsx-js-style (API-compatible SheetJS fork): the plain
 * xlsx package already in the repo cannot write fonts/styles. Bold headers +
 * a "Rs #,##0.00" number format on money columns are the whole styling budget.
 */

const XLSX = require("xlsx-js-style");

// Money columns display as Rs with thousands separators and 2 decimals.
const MONEY_FMT = '"Rs "#,##0.00';

// ── CSV ─────────────────────────────────────────────────────────────────────

// RFC-4180 escaping: quote anything containing a comma, quote or line break;
// double embedded quotes. Numbers pass through unquoted.
function csvCell(value) {
  if (value === null || value === undefined) return "";
  const s = String(value);
  return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

// UTF-8 BOM so Excel opens head names with non-ASCII characters correctly.
function buildCsv(rows) {
  const body = rows.map((r) => r.map(csvCell).join(",")).join("\r\n");
  return "\uFEFF" + body + "\r\n";
}

// ── XLSX ────────────────────────────────────────────────────────────────────

/**
 * One styled worksheet from { name, rows, moneyCols?, boldRows? }.
 * Row 0 (the header) is always bold; boldRows adds emphasis (e.g. totals).
 * moneyCols get the Rs number format on every NUMERIC cell in the column.
 */
function buildWorksheet(sheet) {
  const rows = sheet.rows || [];
  const moneyCols = sheet.moneyCols || [];
  const boldRows = new Set([0, ...(sheet.boldRows || [])]);
  const ws = XLSX.utils.aoa_to_sheet(rows);

  const range = ws["!ref"] ? XLSX.utils.decode_range(ws["!ref"]) : null;
  if (range) {
    for (let r = range.s.r; r <= range.e.r; r++) {
      for (let c = range.s.c; c <= range.e.c; c++) {
        const cell = ws[XLSX.utils.encode_cell({ r, c })];
        if (!cell) continue;
        const style = {};
        if (boldRows.has(r)) style.font = { bold: true };
        if (moneyCols.includes(c) && cell.t === "n") style.numFmt = MONEY_FMT;
        if (Object.keys(style).length > 0) cell.s = style;
      }
    }

    // Readable column widths from content length (clamped — long notes
    // must not blow the sheet out to an unusable width).
    const widths = [];
    for (let c = range.s.c; c <= range.e.c; c++) {
      let max = 10;
      for (let r = range.s.r; r <= range.e.r; r++) {
        const cell = ws[XLSX.utils.encode_cell({ r, c })];
        if (cell && cell.v !== undefined && cell.v !== null) {
          max = Math.max(max, String(cell.v).length + 2);
        }
      }
      widths.push({ wch: Math.min(max, 42) });
    }
    ws["!cols"] = widths;
  }

  return ws;
}

// sheets: [{ name, rows, moneyCols?, boldRows? }]
function buildXlsxBuffer(sheets) {
  const workbook = XLSX.utils.book_new();
  for (const sheet of sheets) {
    XLSX.utils.book_append_sheet(workbook, buildWorksheet(sheet), sheet.name);
  }
  return XLSX.write(workbook, { type: "buffer", bookType: "xlsx" });
}

// ── Delivery ────────────────────────────────────────────────────────────────

/**
 * Send a single-sheet export as a download.
 * { filename, format: "csv"|"xlsx", rows, sheetName, moneyCols, boldRows }
 * Filename is sanitised to ASCII for the Content-Disposition header (Node
 * rejects non-ASCII header bytes — same convention as the PDF downloads).
 */
function sendExport(res, { filename, format, rows, sheetName = "Export", moneyCols = [], boldRows = [] }) {
  const asciiName = String(filename).replace(/[^\x20-\x7E]/g, "-").replace(/"/g, "");
  res.setHeader("Content-Disposition", `attachment; filename="${asciiName}"`);

  if (format === "csv") {
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    return res.send(buildCsv(rows));
  }

  res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  return res.send(buildXlsxBuffer([{ name: sheetName, rows, moneyCols, boldRows }]));
}

module.exports = { MONEY_FMT, csvCell, buildCsv, buildWorksheet, buildXlsxBuffer, sendExport };