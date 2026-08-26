/**
 * Tests findOrCreateFeeHeadByName — the helper that promotes a fee head typed
 * inline during fee collection into a real, reusable FeeHead catalog document.
 *
 *   • A brand-new name creates a FeeHead (trimmed) and returns the doc.
 *   • An existing name (case-insensitive) is REUSED, never duplicated.
 *   • Blank / whitespace-only input creates nothing and returns null.
 *   • Regex metacharacters in the typed name are escaped, so the dedupe lookup
 *     matches literally instead of throwing or matching unrelated heads.
 *
 * The FeeHead model is mocked at the data layer so the real find-or-create
 * logic executes without a database.
 */

// ── Model mock ───────────────────────────────────────────────────────────────
const mockFindOne = jest.fn();
const mockCreate = jest.fn();

jest.mock("../models/Fees/feeHead.model", () => ({
  findOne: (...a) => mockFindOne(...a),
  create: (...a) => mockCreate(...a),
}));

const { findOrCreateFeeHeadByName } = require("../services/fees/feeHead.service");

const ADMIN = "admin-1";

beforeEach(() => {
  jest.clearAllMocks();
  mockCreate.mockImplementation(async (doc) => ({ _id: "new-id", ...doc }));
});

describe("findOrCreateFeeHeadByName", () => {
  test("creates a new fee head when none matches, and returns the doc", async () => {
    mockFindOne.mockResolvedValue(null);

    const head = await findOrCreateFeeHeadByName("Sports Fee", ADMIN);

    expect(mockCreate).toHaveBeenCalledTimes(1);
    expect(mockCreate).toHaveBeenCalledWith({ name: "Sports Fee", createdBy: ADMIN });
    expect(head).toMatchObject({ name: "Sports Fee", createdBy: ADMIN });
  });

  test("reuses an existing head (case-insensitive) instead of creating a duplicate", async () => {
    const existing = { _id: "existing-id", name: "Sports Fee" };
    mockFindOne.mockResolvedValue(existing);

    const head = await findOrCreateFeeHeadByName("sports fee", ADMIN);

    expect(head).toBe(existing);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  test("trims surrounding whitespace before creating", async () => {
    mockFindOne.mockResolvedValue(null);

    await findOrCreateFeeHeadByName("  Lab Fee  ", ADMIN);

    expect(mockCreate).toHaveBeenCalledWith({ name: "Lab Fee", createdBy: ADMIN });
  });

  test("returns null and touches nothing for blank / whitespace-only input", async () => {
    expect(await findOrCreateFeeHeadByName("   ", ADMIN)).toBeNull();
    expect(await findOrCreateFeeHeadByName("", ADMIN)).toBeNull();
    expect(await findOrCreateFeeHeadByName(undefined, ADMIN)).toBeNull();

    expect(mockFindOne).not.toHaveBeenCalled();
    expect(mockCreate).not.toHaveBeenCalled();
  });

  test("escapes regex metacharacters so the dedupe lookup matches literally", async () => {
    mockFindOne.mockResolvedValue(null);

    await findOrCreateFeeHeadByName("Fee (2026) +tax", ADMIN);

    // The $regex built for the lookup must match the literal string, not treat
    // (, ), + as regex operators.
    const arg = mockFindOne.mock.calls[0][0];
    const re = arg.name.$regex;
    expect(re).toBeInstanceOf(RegExp);
    expect(re.test("Fee (2026) +tax")).toBe(true);
    expect(re.test("Fee 2026 tax")).toBe(false); // would match if + were an operator
  });
});
