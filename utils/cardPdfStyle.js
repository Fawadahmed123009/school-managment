const fs = require("fs");
const path = require("path");

/**
 * Shared black-on-white "report card" PDF drawing primitives.
 *
 * These were originally private to the Session Report Card renderer in
 * services/academic/pdfReport.service.js. They are extracted here so every
 * generated PDF in the system (result sheets, analytics, session report
 * cards, student exports) draws the identical page chrome, info grid, and
 * bordered tables. Layout/rendering only — no data or query logic lives here.
 *
 * Visual language (all hairline strokes, pure black on white):
 *   • A thin outer frame inset 24pt from the page edges, repeated on every page.
 *   • Centered logo + school name + report title + optional subtitle, with a
 *     short horizontal rule beneath.
 *   • A small centered footer above the bottom frame edge.
 *   • Label/value info cells and bordered data tables using the same 0.5–0.75pt
 *     black rule weight; no fills, no colored headers or rows.
 */

const LOGO_PATH = path.join(__dirname, "../public/images/logo.jpg");

const CARD_BLACK = "#000000";
const CARD_DASH = "\u2014"; // —
const CARD_TABLE_X = 50;
const CARD_TABLE_W = 495;

/**
 * Paint the repeating page chrome (frame, centered logo/title block, divider,
 * footer) and re-paint it on every added page.
 *
 * Returns a mutable `chrome` object: `chrome.y` is the Y where body content
 * should start on the CURRENT page and is refreshed on each `pageAdded`, so
 * callers that paginate must read it after `doc.addPage()`.
 */
function createCardChrome(doc, { schoolName, title, subtitle }) {
  const hasLogo = fs.existsSync(LOGO_PATH);
  const chrome = { y: 0 };

  const paint = () => {
    const pw = doc.page.width;
    const ph = doc.page.height;
    doc.rect(24, 24, pw - 48, ph - 48).lineWidth(1).strokeColor(CARD_BLACK).stroke();

    let yy = 46;
    if (hasLogo) {
      try {
        doc.image(LOGO_PATH, (pw - 38) / 2, yy, { width: 38, height: 38 });
        yy += 44;
      } catch {
        // logo corrupt or unsupported — render without it
      }
    }
    doc.fillColor(CARD_BLACK).font("Helvetica-Bold").fontSize(15)
      .text(schoolName || "School Portal", 40, yy, { width: pw - 80, align: "center" });
    yy += 21;
    doc.fontSize(12).text(title, 40, yy, { width: pw - 80, align: "center" });
    yy += 18;
    if (subtitle) {
      doc.font("Helvetica").fontSize(9.5).text(subtitle, 60, yy, { width: pw - 120, align: "center" });
      yy += 14;
    }
    doc.moveTo(70, yy).lineTo(pw - 70, yy).lineWidth(0.75).strokeColor(CARD_BLACK).stroke();

    // Footer must stay above doc.page.maxY() — text drawn past the bottom
    // margin makes pdfkit silently open a new page and shift the whole body.
    doc.font("Helvetica").fontSize(7).fillColor(CARD_BLACK).text(
      `Generated ${new Date().toLocaleString()} \u2014 School Management System`,
      40,
      ph - 62,
      { width: pw - 80, align: "center", lineBreak: false }
    );

    chrome.y = yy + 14;
  };

  paint();
  doc.on("pageAdded", paint);
  return chrome;
}

/** Stroke one table/info cell with a black hairline rule. */
function strokeCardCell(doc, x, w, y, h, lw = 0.5) {
  doc.rect(x, y, w, h).lineWidth(lw).strokeColor(CARD_BLACK).stroke();
}

/** Center `lines` (already wrapped) vertically inside a cell. */
function drawCenteredLines(doc, lines, x, w, y, h, { font, size }) {
  doc.font(font).fontSize(size).fillColor(CARD_BLACK);
  const lh = size * 1.2;
  let ty = y + (h - lines.length * lh) / 2;
  lines.forEach((ln) => {
    doc.text(ln, x, ty, { width: w, align: "center" });
    ty += lh;
  });
}

/**
 * Wrap a header label to at most `maxLines` lines, ellipsising if longer,
 * so merged headers never bleed across cell borders.
 */
function wrapCardLabel(doc, text, width, size, maxLines = 2) {
  doc.font("Helvetica-Bold").fontSize(size);
  const words = String(text).split(/\s+/);
  const lines = [];
  let cur = "";
  for (const w of words) {
    const cand = cur ? `${cur} ${w}` : w;
    if (cur && doc.widthOfString(cand) > width) {
      lines.push(cur);
      cur = w;
    } else {
      cur = cand;
    }
  }
  if (cur) lines.push(cur);
  if (lines.length > maxLines) {
    const kept = lines.slice(0, maxLines);
    let last = kept[maxLines - 1] + "\u2026";
    while (last.length > 2 && doc.widthOfString(last) > width) last = last.slice(0, -2) + "\u2026";
    kept[maxLines - 1] = last;
    return kept;
  }
  return lines;
}

/** Clip a single line of text to `width`, adding an ellipsis if it overflows. */
function clipCardLine(doc, text, width, font, size) {
  doc.font(font).fontSize(size);
  let s = String(text);
  if (doc.widthOfString(s) <= width) return s;
  while (s.length > 1 && doc.widthOfString(`${s}\u2026`) > width) s = s.slice(0, -1);
  return `${s}\u2026`;
}

/**
 * Draw the photo cell (real photo or blank silhouette placeholder) exactly
 * as the Session Report Card does. `photoResult` is { buffer } or null.
 */
function drawPhotoCell(doc, x, y, h, photoResult) {
  const phX = x + 9;
  const phY = y + 6;
  const phW = 86 - 18;
  const phH = h - 12;
  let photoDrawn = false;
  if (photoResult && photoResult.buffer) {
    try {
      doc.image(photoResult.buffer, phX, phY, { width: phW, height: phH, fit: [phW, phH] });
      photoDrawn = true;
    } catch {
      // corrupt/unsupported photo bytes — fall through to the placeholder
    }
  }
  if (!photoDrawn) {
    const cx = phX + phW / 2;
    doc.save();
    doc.rect(phX, phY, phW, phH);
    doc.clip();
    doc.lineWidth(0.75).strokeColor(CARD_BLACK);
    doc.circle(cx, phY + phH * 0.34, phW * 0.16).stroke();
    doc.ellipse(cx, phY + phH * 0.88, phW * 0.3, phH * 0.3).stroke();
    doc.restore();
  }
  strokeCardCell(doc, phX - 2, phW + 4, phY - 2, phH + 4, 0.5);
  strokeCardCell(doc, x, 86, y, h, 0.75);
}

/**
 * Draw the labeled info grid: uppercase micro-label on top, bold value below,
 * every cell outlined with a black hairline.
 *
 * Options:
 *   x, w, y        grid placement (defaults to the card table column)
 *   rowH           cell height (27, matching the session card)
 *   withPhoto      reserve the 86pt photo column on the left (placeholder drawn
 *                  when `photoResult` is null, just like the session card)
 *   photoResult    { buffer } or null
 *   rows           array of rows; each row is an array of
 *                  { label, value, weight?, size? } — `weight` is the relative
 *                  cell width within the row (default 1; 2 = full width when
 *                  the other cells are 1), `size` the value font size.
 *
 * Returns the Y just below the grid (no extra gap).
 */
function drawInfoGrid(doc, { x = CARD_TABLE_X, w = CARD_TABLE_W, y, rows, withPhoto = false, photoResult = null, rowH = 27 }) {
  const h = rowH * rows.length;
  let gx = x;
  let gw = w;
  if (withPhoto) {
    drawPhotoCell(doc, x, y, h, photoResult);
    gx = x + 86;
    gw = w - 86;
  }

  rows.forEach((cells, r) => {
    const ry = y + r * rowH;
    const totalWeight = cells.reduce((s, c) => s + (c.weight || 1), 0);
    let cx = gx;
    cells.forEach((c) => {
      const cw = (gw * (c.weight || 1)) / totalWeight;
      strokeCardCell(doc, cx, cw, ry, rowH, 0.75);
      doc.font("Helvetica").fontSize(6.5).fillColor(CARD_BLACK)
        .text(String(c.label).toUpperCase(), cx + 7, ry + 5, { width: cw - 14 });
      const size = c.size || 9.5;
      const v = clipCardLine(doc, c.value || CARD_DASH, cw - 14, "Helvetica-Bold", size);
      doc.font("Helvetica-Bold").fontSize(size).fillColor(CARD_BLACK).text(v, cx + 7, ry + 13);
      cx += cw;
    });
  });

  return y + h;
}

/**
 * Draw a simple bordered data table in the card style: bold centered header
 * row (0.75pt rules), plain rows (0.5pt rules), no fills. Paginates: when a
 * row would cross the bottom limit a new page is added, the chrome is redrawn
 * (via createCardChrome's pageAdded hook) and the header row repeats.
 *
 * Options:
 *   headers    string[]
 *   rows       string[][] (already formatted; missing values pass as "—")
 *   colWidths  must sum to `w`
 *   aligns     per-column "left" | "center" | "right" (default center, col 0 left)
 *   fontSize / rowH
 *   chrome     from createCardChrome — required for pagination positioning
 *
 * Returns the Y just below the last row.
 */
function drawCardTable(doc, y, { headers, rows, colWidths, aligns, fontSize = 9, rowH = 20, chrome, x = CARD_TABLE_X, w = CARD_TABLE_W }) {
  const bottomLimit = () => doc.page.height - 92;
  const headerLines = headers.map((h, i) => wrapCardLabel(doc, h, colWidths[i] - 8, fontSize, 2));
  const hdrH = Math.max(...headerLines.map((l) => l.length)) * (fontSize + 3) + 6;

  const colX = (i) => x + colWidths.slice(0, i).reduce((a, b) => a + b, 0);
  const alignOf = (i) => aligns ? aligns[i] : (i === 0 ? "left" : "center");

  const paintHeader = () => {
    headers.forEach((h, i) => {
      drawCenteredLines(doc, headerLines[i], colX(i) + 2, colWidths[i] - 4, y, hdrH, { font: "Helvetica-Bold", size: fontSize });
      strokeCardCell(doc, colX(i), colWidths[i], y, hdrH, 0.75);
    });
    y += hdrH;
  };
  paintHeader();

  rows.forEach((row) => {
    if (y + rowH > bottomLimit()) {
      doc.addPage();
      y = chrome.y;
      paintHeader();
    }
    const ry = y;
    doc.font("Helvetica").fontSize(fontSize).fillColor(CARD_BLACK);
    row.forEach((cell, i) => {
      const t = clipCardLine(doc, String(cell), colWidths[i] - 8, "Helvetica", fontSize);
      doc.text(t, colX(i) + 4, ry + (rowH - fontSize * 1.2) / 2, { width: colWidths[i] - 8, align: alignOf(i) });
      strokeCardCell(doc, colX(i), colWidths[i], ry, rowH, 0.5);
    });
    y = ry + rowH;
  });

  return y;
}

module.exports = {
  LOGO_PATH,
  CARD_BLACK,
  CARD_DASH,
  CARD_TABLE_X,
  CARD_TABLE_W,
  createCardChrome,
  strokeCardCell,
  drawCenteredLines,
  wrapCardLabel,
  clipCardLine,
  drawPhotoCell,
  drawInfoGrid,
  drawCardTable,
};
