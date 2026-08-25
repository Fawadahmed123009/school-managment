/**
 * Unit tests for the pagination utility.
 * These tests use a mock Mongoose model to avoid needing a real database.
 */

const { paginate } = require("../utils/paginate");

// Mock Mongoose model
const createMockModel = (data) => {
  const mockChain = {
    skip: jest.fn().mockReturnThis(),
    limit: jest.fn().mockReturnThis(),
    sort: jest.fn().mockReturnThis(),
    select: jest.fn().mockReturnThis(),
    populate: jest.fn().mockReturnThis(),
    lean: jest.fn().mockResolvedValue(data),
  };
  return {
    find: jest.fn().mockReturnValue(mockChain),
    countDocuments: jest.fn().mockResolvedValue(data.length),
    _chain: mockChain,
  };
};

describe("paginate utility", () => {
  test("returns data and pagination metadata", async () => {
    const items = [{ _id: "1" }, { _id: "2" }, { _id: "3" }];
    const model = createMockModel(items);

    const result = await paginate(model, {}, { page: 1, limit: 10 });

    expect(result.data).toEqual(items);
    expect(result.pagination).toEqual({
      total: 3,
      page: 1,
      limit: 10,
      pages: 1,
      hasPrev: false,
      hasNext: false,
    });
    expect(model.find).toHaveBeenCalledWith({});
  });

  test("calculates skip correctly for page 2", async () => {
    const model = createMockModel([{ _id: "1" }]);

    await paginate(model, {}, { page: 2, limit: 5 });

    expect(model._chain.skip).toHaveBeenCalledWith(5); // (2-1) * 5
    expect(model._chain.limit).toHaveBeenCalledWith(5);
  });

  test("defaults to page 1 and limit 20", async () => {
    const model = createMockModel([]);

    await paginate(model, {});

    expect(model._chain.skip).toHaveBeenCalledWith(0);
    expect(model._chain.limit).toHaveBeenCalledWith(20);
  });

  test("caps limit at 100", async () => {
    const model = createMockModel([]);

    await paginate(model, {}, { limit: 500 });

    expect(model._chain.limit).toHaveBeenCalledWith(100);
  });

  test("enforces minimum page of 1", async () => {
    const model = createMockModel([]);

    await paginate(model, {}, { page: -5 });

    expect(model._chain.skip).toHaveBeenCalledWith(0); // page 1 → skip 0
  });

  test("applies select and populate options", async () => {
    const model = createMockModel([]);

    await paginate(model, {}, { select: "-password", populate: { path: "classLevel" } });

    expect(model._chain.select).toHaveBeenCalledWith("-password");
    expect(model._chain.populate).toHaveBeenCalledWith({ path: "classLevel" });
  });

  test("handles array of populate configs", async () => {
    const model = createMockModel([]);
    const pops = [{ path: "a" }, { path: "b" }];

    await paginate(model, {}, { populate: pops });

    expect(model._chain.populate).toHaveBeenCalledTimes(2);
  });

  test("computes hasNext and hasPrev correctly", async () => {
    const model = createMockModel([]);
    model.countDocuments.mockResolvedValue(50);

    const result = await paginate(model, {}, { page: 3, limit: 10 });

    expect(result.pagination.pages).toBe(5);
    expect(result.pagination.hasPrev).toBe(true);
    expect(result.pagination.hasNext).toBe(true);
  });
});
