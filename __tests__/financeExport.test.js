/**
 * Finance export layer tests (CSV + Excel for daily/monthly/yearly reports
 * and expense/income history):
 * - Pure export layer: the SAME services the pages use are called with the
 *   SAME filters — exported figures must equal the on-screen report payload.
 * - History exports walk EVERY page of the filtered set (the running total
 *   spans all filtered entries) and include the running-total row; a failing
 *   page aborts the whole export (never a partial file).
 * - CSV escaping (commas/quotes/newlines), XLSX bold headers + Rs number
 *   format, CSV↔XLSX data parity, ASCII-safe download filenames.
 * - ADMIN ONLY on every export route (managers/teachers/students/parents and
 *   suspended teachers rejected); invalid format fails closed before any query.
 *
 * Models are mocked at the data layer (mirrors financeReports.test.js /
 * expenseEntries.test.js); utils/dateRange and the real services run.
 */

const mockFeesAggregate = jest.fn();
const mockIncomeAggregate = jest.fn();
const mockExpenseAggregate = jest.fn();
const mockIncomeHeadFind = jest.fn();
const mockExpenseHeadFind = jest.fn();
const mockSalaryFind = jest.fn();
const mockPaginate = jest.fn();

jest.mock("../models/Fees/fees.model", () => ({
  aggregate: (...a) => mockFeesAggregate(...a),
}));
jest.mock("../models/Income/incomeEntry.model", () => ({
  aggregate: (...a) => mockIncomeAggregate(...a),
}));
jest.mock("../models/Expenses/expenseEntry.model", () => ({
  aggregate: (...a) => mockExpenseAggregate(...a),
}));
jest.mock("../models/Income/incomeHead.model", () => ({
  find: (...a) => mockIncomeHeadFind(...a),
}));
jest.mock("../models/Expenses/expenseHead.model", () => ({
  find: (...a) => mockExpenseHeadFind(...a),
}));
jest.mock("../models/Staff/teacherSalaryRun.model", () => ({
  find: (...a) => mockSalaryFind(...a),
}));
jest.mock("../utils/paginate", () => ({
  paginate: (...a) => mockPaginate(...a),
}));

const XLSX = require("xlsx");
const mongoose = require("mongoose");
const { csvCell, buildCsv, buildWorksheet, buildXlsxBuffer, sendExport, MONEY_FMT } = require("../utils/exportFile");
const {
  normalizeExportFormat,
  fetchReportForExport,
  buildFinanceReportExport,
  financeReportFilename,
  fetchHistoryForExport,
  buildHistoryExport,
  historyFilename,
} = require("../services/finance/financeExport.service");
const financeViewRouter = require("../routes/views/financeReport.views");
const expensesViewRouter = require("../routes/views/expenses.views");
const incomeViewRouter = require("../routes/views/income.views");

// ── report scenario (same dispatch pattern as financeReports.test.js) ──────

const HID1 = new mongoose.Types.ObjectId();
const HID2 = new mongoose.Types.ObjectId();
const EID1 = new mongoose.Types.ObjectId();
const TID1 = new mongoose.Types.ObjectId();

function entryMock(mock, { total = 0, count = 0, groups = [] } = {}) {
  mock.mockImplementation(async (pipeline) => {
    const group = pipeline.find((s) => s.$group).$group;
    if (group._id === null) return [{ _id: null, total, count }];
    return groups;
  });
}
const headFindMock = (mock, heads) =>
  mock.mockReturnValue({ select: () => ({ lean: async () => heads }) });
const salaryFindMock = (runs) =>
  mockSalaryFind.mockReturnValue({
    populate: () => ({ sort: () => ({ lean: async () => runs }) }),
  });

const RUNS = [
  {
    _id: new mongoose.Types.ObjectId(),
    teacher: { _id: TID1, name: "Ayesha Khan", teacherId: "T-07" },
    periodStart: new Date(2026, 9, 1),
    periodEnd: new Date(2026, 9, 31),
    netAmount: 30000,
    finalizedAt: new Date(2026, 10, 5),
  },
  {
    _id: new mongoose.Types.ObjectId(),
    teacher: { _id: TID1, name: "Ayesha Khan", teacherId: "T-07" },
    periodStart: new Date(2026, 10, 1),
    periodEnd: new Date(2026, 10, 30),
    netAmount: 20000,
    finalizedAt: new Date(2026, 10, 10),
  },
];

function setReportScenario({ fees = 150000, income = 25000, expenses = 40000 } = {}) {
  mockFeesAggregate.mockResolvedValue([{ _id: null, total: fees, count: 12 }]);
  entryMock(mockIncomeAggregate, {
    total: income,
    count: 3,
    groups: [
      { _id: HID1, total: 20000, count: 2 },
      { _id: HID2, total: 5000, count: 1 },
    ],
  });
  entryMock(mockExpenseAggregate, {
    total: expenses,
    count: 5,
    groups: [{ _id: EID1, total: expenses, count: 5 }],
  });
  headFindMock(mockIncomeHeadFind, [
    { _id: HID1, name: "Donations", isActive: true },
    { _id: HID2, name: "Old sales", isActive: false },
  ]);
  headFindMock(mockExpenseHeadFind, [{ _id: EID1, name: "Utilities", isActive: true }]);
  salaryFindMock(RUNS);
}

// ── history scenario: 250 filtered entries across 3 pages of 100 ───────────

const HISTORY_TOTAL = 123456.78;
const EXPENSE_SET = Array.from({ length: 250 }, (_, i) => ({
  _id: new mongoose.Types.ObjectId(),
  date: new Date(2026, 10, 1 + (i % 28)),
  expenseHead: { _id: EID1, name: "Utilities", isActive: true },
  itemName: `Item ${i}`,
  quantity: 2,
  unitRate: 100,
  totalAmount: 200,
  notes: i === 0 ? 'comma, "quote" and\nnewline' : "",
  createdBy: { name: "Admin" },
}));
const INCOME_SET = Array.from({ length: 3 }, (_, i) => ({
  _id: new mongoose.Types.ObjectId(),
  date: new Date(2026, 10, 2 + i),
  incomeHead: { _id: HID1, name: "Donations", isActive: true },
  description: `Donation ${i}`,
  // direct-mode entry: no quantity/unitRate at all
  totalAmount: 5000,
  notes: "",
  createdBy: { name: "Admin" },
}));

function setHistoryScenario(set = EXPENSE_SET, total = HISTORY_TOTAL) {
  mockPaginate.mockImplementation(async (model, match, opts) => {
    const page = Math.max(1, parseInt(opts.page, 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(opts.limit, 10) || 20));
    const pages = Math.ceil(set.length / limit);
    return {
      data: set.slice((page - 1) * limit, page * limit),
      pagination: {
        total: set.length,
        page,
        limit,
        pages,
        hasPrev: page > 1,
        hasNext: page < pages,
      },
    };
  });
  mockExpenseAggregate.mockResolvedValue([{ _id: null, total, count: set.length }]);
  mockIncomeAggregate.mockResolvedValue([{ _id: null, total, count: set.length }]);
}

function mockRes() {
  return {
    status: jest.fn().mockReturnThis(),
    json: jest.fn().mockReturnThis(),
    send: jest.fn().mockReturnThis(),
    setHeader: jest.fn().mockReturnThis(),
    redirect: jest.fn().mockReturnThis(),
    render: jest.fn().mockReturnThis(),
    locals: { schoolName: "Test School" },
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  setReportScenario();
});

// ── format validation ───────────────────────────────────────────────────────

describe("normalizeExportFormat — fail-closed", () => {
  it.each([["csv", "csv"], ["xlsx", "xlsx"], ["CSV", "csv"], [" XLSX ", "xlsx"]])(
    "%s → %s",
    (input, expected) => expect(normalizeExportFormat(input)).toBe(expected)
  );
  it.each([[undefined], [null], [""], ["pdf"], ["exe"], ["csv,xlsx"]])(
    "%s → null (rejected)",
    (input) => expect(normalizeExportFormat(input)).toBeNull()
  );
});

// ── CSV formatting ──────────────────────────────────────────────────────────

describe("CSV formatting", () => {
  it("escapes commas, quotes and line breaks; doubles embedded quotes", () => {
    expect(csvCell("plain")).toBe("plain");
    expect(csvCell("a,b")).toBe('"a,b"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell("line1\nline2")).toBe('"line1\nline2"');
    expect(csvCell("cr\r\nlf")).toBe('"cr\r\nlf"');
    expect(csvCell(1234.5)).toBe("1234.5");
    expect(csvCell(null)).toBe("");
    expect(csvCell(undefined)).toBe("");
  });

  it("builds a BOM + CRLF file with one header row", () => {
    const csv = buildCsv([["A", "B"], ["x,y", 2]]);
    expect(csv.startsWith("\uFEFF")).toBe(true);
    expect(csv).toBe('\uFEFFA,B\r\n"x,y",2\r\n');
  });
});

// ── XLSX formatting ─────────────────────────────────────────────────────────

describe("XLSX formatting", () => {
  const sheet = {
    name: "Test",
    rows: [["Head", "Amount (Rs)"], ["Fees", 1234.5], ["Total", 1234.5]],
    moneyCols: [1],
    boldRows: [2],
  };

  it("bolds the header row and any extra boldRows; money cells get the Rs format", () => {
    const ws = buildWorksheet(sheet);
    expect(ws.A1.s.font.bold).toBe(true);
    expect(ws.A2.s).toBeUndefined(); // plain data row, text col
    expect(ws.A3.s.font.bold).toBe(true); // total row
    expect(ws.B2.s.numFmt).toBe(MONEY_FMT);
    expect(ws.B3.s.numFmt).toBe(MONEY_FMT);
    expect(ws["!cols"].length).toBe(2);
  });

  it("round-trips values and the money number format through a real .xlsx buffer", () => {
    const buf = buildXlsxBuffer([sheet]);
    const wb = XLSX.read(buf, { type: "buffer", cellStyles: true });
    const ws = wb.Sheets.Test;
    expect(ws.A1.v).toBe("Head");
    expect(ws.B2.v).toBe(1234.5);
    expect(ws.B2.z).toBe(MONEY_FMT);
    expect(ws.B3.v).toBe(1234.5);
  });

  it("header-only sheet (zero data rows) still renders the header", () => {
    const buf = buildXlsxBuffer([{ name: "Empty", rows: [["Date", "Total"]], moneyCols: [1] }]);
    const ws = XLSX.read(buf, { type: "buffer" }).Sheets.Empty;
    expect(ws.A1.v).toBe("Date");
    expect(ws.B1.v).toBe("Total");
  });

  it("CSV and XLSX carry identical data (parity)", () => {
    const rows = [["Section", "Item", "Count", "Amount (Rs)"], ["Summary", 'Net "profit"', 2, 85000], ["Summary", "Loss", "", -100]];
    // Strip the UTF-8 BOM for the parser (Excel consumes it natively).
    const fromCsv = XLSX.utils.sheet_to_json(XLSX.read(buildCsv(rows).replace(/^\uFEFF/, ""), { type: "string" }).Sheets.Sheet1, { header: 1, defval: "", raw: true });
    const fromXlsx = XLSX.utils.sheet_to_json(XLSX.read(buildXlsxBuffer([{ name: "S", rows }]), { type: "buffer" }).Sheets.S, { header: 1, defval: "", raw: true });
    expect(fromCsv).toEqual(rows);
    expect(fromXlsx).toEqual(rows);
  });
});

// ── delivery ────────────────────────────────────────────────────────────────

describe("sendExport", () => {
  it("sends CSV with the right content type and attachment filename", () => {
    const res = mockRes();
    sendExport(res, { filename: "expense-history-all.csv", format: "csv", rows: [["A"], [1]] });
    expect(res.setHeader).toHaveBeenCalledWith("Content-Type", "text/csv; charset=utf-8");
    expect(res.setHeader).toHaveBeenCalledWith("Content-Disposition", 'attachment; filename="expense-history-all.csv"');
    expect(typeof res.send.mock.calls[0][0]).toBe("string");
  });

  it("sends XLSX with the spreadsheet content type", () => {
    const res = mockRes();
    sendExport(res, { filename: "finance-report-daily-2026-11-12.xlsx", format: "xlsx", rows: [["A"], [1]], sheetName: "Daily Report" });
    expect(res.setHeader).toHaveBeenCalledWith("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    expect(Buffer.isBuffer(res.send.mock.calls[0][0])).toBe(true);
  });

  it("sanitises non-ASCII filename bytes out of the header", () => {
    const res = mockRes();
    sendExport(res, { filename: "rapport—février.csv", format: "csv", rows: [["A"]] });
    const disposition = res.setHeader.mock.calls.find((c) => c[0] === "Content-Disposition")[1];
    expect(disposition).toBe('attachment; filename="rapport-f-vrier.csv"');
    expect(/[^\x20-\x7E]/.test(disposition)).toBe(false);
  });
});

// ── finance report export — parity with the on-screen report ───────────────

describe("finance report export — same figures as the report service", () => {
  it("exports every headline total, head breakdown and salary row", async () => {
    const loaded = await fetchReportForExport({ mode: "daily", date: "2026-11-12" });
    expect(loaded.ok).toBe(true);
    const report = loaded.report;

    // Parity anchor: the export must mirror the service payload exactly.
    expect(report.collections).toBe(150000);
    expect(report.netBeforeSalaries).toBe(135000);
    expect(report.net).toBe(85000);

    const { rows, moneyCols, boldRows, sheetName } = buildFinanceReportExport(report);
    expect(sheetName).toBe("Daily Report");
    expect(rows[0]).toEqual(["Section", "Item", "Detail", "Count", "Amount (Rs)"]);
    expect(rows[1]).toEqual(["Summary", "Collections (fees)", "2026-11-12", 12, 150000]);
    expect(rows[2]).toEqual(["Summary", "Ad-hoc income", "2026-11-12", 3, 25000]);
    expect(rows[3]).toEqual(["Summary", "Expenses", "2026-11-12", 5, 40000]);
    expect(rows[4]).toEqual(["Summary", "Salaries paid (finalized runs)", "2026-11-12", 2, 50000]);
    expect(rows[5]).toEqual(["Summary", "Net before salaries", "", "", 135000]);
    expect(rows[6]).toEqual(["Summary", "Net profit", "", "", 85000]);
    expect(rows[7]).toEqual(["Income by head", "Donations", "", 2, 20000]);
    expect(rows[8]).toEqual(["Income by head", "Old sales (inactive)", "", 1, 5000]);
    expect(rows[9]).toEqual(["Expenses by head", "Utilities", "", 5, 40000]);
    expect(rows[10]).toEqual(["Salaries by teacher", "Ayesha Khan (T-07)", "", 2, 50000]);
    expect(rows[11][0]).toBe("Salary run detail");
    expect(rows[11][1]).toBe("Ayesha Khan");
    expect(rows[11][4]).toBe(30000);
    expect(rows[12][4]).toBe(20000);
    expect(rows.length).toBe(13);
    expect(moneyCols).toEqual([4]);
    expect(boldRows).toEqual([5, 6]);
  });

  it("labels a negative net as a loss (same formula, no re-computation)", async () => {
    setReportScenario({ fees: 0 });
    const loaded = await fetchReportForExport({ mode: "daily", date: "2026-11-12" });
    const { rows } = buildFinanceReportExport(loaded.report);
    expect(loaded.report.net).toBe(-65000);
    expect(rows[6]).toEqual(["Summary", "Net loss", "", "", -65000]);
  });

  it("monthly range appears in the Detail column and the filename", async () => {
    const loaded = await fetchReportForExport({ mode: "monthly", month: "2026-11" });
    expect(loaded.ok).toBe(true);
    const { rows } = buildFinanceReportExport(loaded.report);
    expect(rows[1][2]).toBe("2026-11-01 to 2026-11-30");
    expect(financeReportFilename("monthly", "2026-11-01", "2026-11-30", "xlsx")).toBe("finance-report-monthly-2026-11-01-to-2026-11-30.xlsx");
  });

  it("fails closed on a bad picker value — no query runs", async () => {
    const loaded = await fetchReportForExport({ mode: "daily", date: "2026-02-30" });
    expect(loaded.ok).toBe(false);
    expect(loaded.message).toMatch(/Invalid date/);
    expect(mockFeesAggregate).not.toHaveBeenCalled();
    expect(mockIncomeAggregate).not.toHaveBeenCalled();
    expect(mockSalaryFind).not.toHaveBeenCalled();
  });

  it("filenames: daily single day, monthly/yearly ranges", () => {
    expect(financeReportFilename("daily", "2026-11-12", "2026-11-12", "csv")).toBe("finance-report-daily-2026-11-12.csv");
    expect(financeReportFilename("yearly", "2026-01-01", "2026-12-31", "xlsx")).toBe("finance-report-yearly-2026-01-01-to-2026-12-31.xlsx");
  });
});

// ── history export — full filtered set + running total ─────────────────────

describe("history export — filtered set, every page, running total row", () => {
  beforeEach(() => setHistoryScenario());

  it("collects ALL 250 filtered entries across 3 pages with the service's running total", async () => {
    const loaded = await fetchHistoryForExport("expense", { expenseHead: "", from: "2026-11-01", to: "2026-11-30" });
    expect(loaded.ok).toBe(true);
    expect(loaded.entries.length).toBe(250);
    expect(loaded.entries[0].itemName).toBe("Item 0");
    expect(loaded.entries[249].itemName).toBe("Item 249");
    expect(loaded.runningTotal).toBe(HISTORY_TOTAL);
    expect(mockPaginate).toHaveBeenCalledTimes(3);
    // Same query path as the page: identical filters + sort on every page.
    for (const [i, call] of mockPaginate.mock.calls.entries()) {
      const [model, match, opts] = call;
      expect(opts.page).toBe(i + 1);
      expect(opts.limit).toBe(100);
      expect(opts.sort).toBe("-date -createdAt");
      expect(match.date.$gte).toEqual(new Date(2026, 10, 1));
      expect(match.date.$lt).toEqual(new Date(2026, 11, 1));
    }
  });

  it("passes the head filter through to every page (ObjectId-cast match)", async () => {
    const loaded = await fetchHistoryForExport("expense", { expenseHead: String(EID1), from: "", to: "" });
    expect(loaded.ok).toBe(true);
    for (const [, match] of mockPaginate.mock.calls) {
      expect(match.expenseHead).toEqual(EID1);
      expect(match.date).toBeUndefined();
    }
  });

  it("builds the expense table with the running-total row last", () => {
    const { rows, sheetName, moneyCols, boldRows } = buildHistoryExport("expense", { entries: EXPENSE_SET.slice(0, 2), runningTotal: HISTORY_TOTAL });
    expect(sheetName).toBe("Expense History");
    expect(rows[0]).toEqual(["Date", "Head", "Item", "Quantity", "Unit rate (Rs)", "Total (Rs)", "Notes", "Recorded by"]);
    expect(rows[1][1]).toBe("Utilities");
    expect(rows[1][2]).toBe("Item 0");
    expect(rows[1][3]).toBe(2);
    expect(rows[1][4]).toBe(100);
    expect(rows[1][5]).toBe(200);
    expect(rows[1][7]).toBe("Admin");
    const last = rows[rows.length - 1];
    expect(last[2]).toBe("Running total (filtered)");
    expect(last[5]).toBe(HISTORY_TOTAL);
    expect(moneyCols).toEqual([4, 5]);
    expect(boldRows).toEqual([rows.length - 1]);
  });

  it("income table uses Description and blanks for direct-mode entries (no qty/rate)", () => {
    const { rows, sheetName } = buildHistoryExport("income", { entries: INCOME_SET, runningTotal: 15000 });
    expect(sheetName).toBe("Income History");
    expect(rows[0][2]).toBe("Description");
    expect(rows[1][2]).toBe("Donation 0");
    expect(rows[1][3]).toBe("");
    expect(rows[1][4]).toBe("");
    expect(rows[1][5]).toBe(5000);
    expect(rows[rows.length - 1][5]).toBe(15000);
  });

  it("empty filtered set still exports header + zero running total", async () => {
    setHistoryScenario([], 0);
    const loaded = await fetchHistoryForExport("expense", { expenseHead: "", from: "2026-11-01", to: "2026-11-30" });
    expect(loaded.ok).toBe(true);
    const { rows } = buildHistoryExport("expense", loaded);
    expect(rows.length).toBe(2);
    expect(rows[1][5]).toBe(0);
  });

  it("fails closed on invalid dates — no page query runs", async () => {
    const bad = await fetchHistoryForExport("expense", { expenseHead: "", from: "2026-02-30", to: "" });
    expect(bad.ok).toBe(false);
    expect(bad.message).toMatch(/Invalid from date/);
    const reversed = await fetchHistoryForExport("expense", { expenseHead: "", from: "2026-11-30", to: "2026-11-01" });
    expect(reversed.ok).toBe(false);
    expect(mockPaginate).not.toHaveBeenCalled();
  });

  it("a failing mid-walk page aborts the export — never a partial file", async () => {
    mockPaginate
      .mockImplementationOnce(async () => ({
        data: EXPENSE_SET.slice(0, 100),
        pagination: { total: 250, page: 1, limit: 100, pages: 3, hasPrev: false, hasNext: true },
      }))
      .mockRejectedValueOnce(new Error("db hiccup"));
    const loaded = await fetchHistoryForExport("expense", { expenseHead: "", from: "", to: "" });
    expect(loaded.ok).toBe(false);
    expect(loaded.entries).toBeUndefined();
  });

  it("refuses beyond the page ceiling instead of truncating silently", async () => {
    mockPaginate.mockImplementationOnce(async () => ({
      data: [],
      pagination: { total: 60000, page: 1, limit: 100, pages: 600, hasPrev: false, hasNext: true },
    }));
    const loaded = await fetchHistoryForExport("expense", { expenseHead: "", from: "", to: "" });
    expect(loaded.ok).toBe(false);
    expect(loaded.message).toMatch(/Too many entries/);
    expect(mockPaginate).toHaveBeenCalledTimes(1);
  });

  it("filenames cover closed, open-ended and unfiltered ranges", () => {
    expect(historyFilename("expense", "2026-11-01", "2026-11-30", "csv")).toBe("expense-history-2026-11-01-to-2026-11-30.csv");
    expect(historyFilename("income", "2026-11-01", "", "xlsx")).toBe("income-history-2026-11-01-onwards.xlsx");
    expect(historyFilename("expense", "", "2026-11-30", "csv")).toBe("expense-history-up-to-2026-11-30.csv");
    expect(historyFilename("income", "", "", "xlsx")).toBe("income-history-all.xlsx");
  });
});

// ── access control — ADMIN ONLY on every export route ──────────────────────

function viewLayer(router, path) {
  return router.stack.find((l) => l.route && l.route.path === path && l.route.methods.get);
}

describe("export routes — admin-only guards (DB-resolved role via requireRole)", () => {
  const routes = [
    ["daily report export", financeViewRouter, "/finance/daily-report/export"],
    ["monthly report export", financeViewRouter, "/finance/monthly-report/export"],
    ["yearly report export", financeViewRouter, "/finance/yearly-report/export"],
    ["expense history export", expensesViewRouter, "/expenses/export"],
    ["income history export", incomeViewRouter, "/income/export"],
  ];

  it.each(routes)("%s exists and is GET-only (read-only export)", (_label, router, path) => {
    const layer = viewLayer(router, path);
    expect(layer).toBeTruthy();
    expect(Object.keys(layer.route.methods)).toEqual(["get"]);
  });

  it.each(routes)("%s allows admin", async (_label, router, path) => {
    const guard = viewLayer(router, path).route.stack[0].handle;
    const res = mockRes();
    const next = jest.fn();
    await guard({ user: { role: "admin" } }, res, next);
    expect(next).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
  });

  it.each(routes)("%s rejects a manager (no financial visibility)", async (_label, router, path) => {
    const guard = viewLayer(router, path).route.stack[0].handle;
    const res = mockRes();
    const next = jest.fn();
    await guard({ user: { role: "teacher", isManager: true } }, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
  });

  it.each(routes)("%s rejects teacher / student / parent / suspended / anonymous", async (_label, router, path) => {
    const guard = viewLayer(router, path).route.stack[0].handle;
    for (const user of [
      { role: "teacher", isManager: false },
      { role: "student" },
      { role: "parent" },
      { role: "teacher", isSuspended: true },
      undefined,
    ]) {
      const res = mockRes();
      const next = jest.fn();
      await guard({ user }, res, next);
      expect(next).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(403);
    }
  });
});

// ── route handlers end-to-end (mocked data layer) ──────────────────────────

function handler(router, path) {
  return viewLayer(router, path).route.stack[1].handle;
}
const dispositionOf = (res) => res.setHeader.mock.calls.find((c) => c[0] === "Content-Disposition")[1];

describe("export handlers — grant path produces the right file", () => {
  it("daily report CSV mirrors the report and names the file by date", async () => {
    const res = mockRes();
    await handler(financeViewRouter, "/finance/daily-report/export")(
      { query: { date: "2026-11-12", format: "csv" }, user: { role: "admin" } }, res
    );
    expect(dispositionOf(res)).toBe('attachment; filename="finance-report-daily-2026-11-12.csv"');
    const body = res.send.mock.calls[0][0];
    expect(body).toContain("Net profit");
    expect(body).toContain("85000");
    expect(body).toContain("Old sales (inactive)");
  });

  it("monthly report XLSX is a readable workbook with the same figures", async () => {
    const res = mockRes();
    await handler(financeViewRouter, "/finance/monthly-report/export")(
      { query: { month: "2026-11", format: "xlsx" }, user: { role: "admin" } }, res
    );
    expect(dispositionOf(res)).toBe('attachment; filename="finance-report-monthly-2026-11-01-to-2026-11-30.xlsx"');
    const wb = XLSX.read(res.send.mock.calls[0][0], { type: "buffer" });
    const rows = XLSX.utils.sheet_to_json(wb.Sheets["Monthly Report"], { header: 1, defval: "" });
    expect(rows[1][4]).toBe(150000);
    expect(rows[6][4]).toBe(85000);
  });

  it("invalid format → 400 before any query runs", async () => {
    const res = mockRes();
    await handler(financeViewRouter, "/finance/daily-report/export")(
      { query: { date: "2026-11-12", format: "pdf" }, user: { role: "admin" } }, res
    );
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.send).toHaveBeenCalled();
    expect(mockFeesAggregate).not.toHaveBeenCalled();

    const res2 = mockRes();
    await handler(expensesViewRouter, "/expenses/export")(
      { query: { format: "" }, user: { role: "admin" } }, res2
    );
    expect(res2.status).toHaveBeenCalledWith(400);
    expect(mockPaginate).not.toHaveBeenCalled();
  });

  it("bad picker value redirects back to the report page (which shows the same error)", async () => {
    const res = mockRes();
    await handler(financeViewRouter, "/finance/daily-report/export")(
      { query: { date: "garbage", format: "csv" }, user: { role: "admin" } }, res
    );
    expect(res.redirect).toHaveBeenCalledWith("/finance/daily-report?date=garbage");
    expect(res.send).not.toHaveBeenCalled();
  });

  it("expense history export respects the applied filters and includes the total row", async () => {
    setHistoryScenario();
    const res = mockRes();
    await handler(expensesViewRouter, "/expenses/export")(
      { query: { format: "csv", expenseHead: String(EID1), from: "2026-11-01", to: "2026-11-30" }, user: { role: "admin" } }, res
    );
    expect(dispositionOf(res)).toBe('attachment; filename="expense-history-2026-11-01-to-2026-11-30.csv"');
    const body = res.send.mock.calls[0][0];
    expect(body).toContain("Running total (filtered)");
    expect(body).toContain("123456.78");
    // CSV escaping survived the trip (notes contain comma/quote/newline).
    expect(body).toContain('"comma, ""quote"" and');
    expect(mockPaginate).toHaveBeenCalledTimes(3);
  });

  it("income history export (xlsx) carries the filtered total row", async () => {
    setHistoryScenario(INCOME_SET, 15000);
    const res = mockRes();
    await handler(incomeViewRouter, "/income/export")(
      { query: { format: "xlsx", from: "2026-11-01", to: "2026-11-30" }, user: { role: "admin" } }, res
    );
    expect(dispositionOf(res)).toBe('attachment; filename="income-history-2026-11-01-to-2026-11-30.xlsx"');
    const wb = XLSX.read(res.send.mock.calls[0][0], { type: "buffer" });
    const rows = XLSX.utils.sheet_to_json(wb.Sheets["Income History"], { header: 1, defval: "" });
    expect(rows[0][2]).toBe("Description");
    expect(rows[rows.length - 1][2]).toBe("Running total (filtered)");
    expect(rows[rows.length - 1][5]).toBe(15000);
  });

  it("invalid history filter redirects back with the error and filters intact", async () => {
    const res = mockRes();
    await handler(expensesViewRouter, "/expenses/export")(
      { query: { format: "csv", from: "2026-02-30", to: "2026-11-30" }, user: { role: "admin" } }, res
    );
    expect(res.redirect).toHaveBeenCalledTimes(1);
    const url = res.redirect.mock.calls[0][0];
    expect(url).toContain("/expenses?error=");
    expect(url).toContain("from=2026-02-30");
    expect(url).toContain("to=2026-11-30");
    expect(res.send).not.toHaveBeenCalled();
  });
});