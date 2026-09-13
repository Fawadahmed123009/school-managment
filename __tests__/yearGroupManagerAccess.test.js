/**
 * Regression tests for yearGroup.service.js — manager (isAttendanceManager) access.
 *
 * Bug: createYearGroupService did Admin.findById(userId) and rejected with 401
 * "Admin does not exist" when the caller was a manager (Teacher ID), even though
 * the route-level isAdminOrManager guard correctly allowed them through.
 *
 * Fix: the service now checks both Admin and Teacher collections, accepting
 * either an admin or a manager. Admin tracking pushes are conditional on the
 * caller actually being an admin.
 */

// ── Model mocks ──────────────────────────────────────────────────────────────
const mockYearGroupFindOne = jest.fn();
const mockYearGroupCreate = jest.fn();
const mockAdminFindById = jest.fn();
const mockAdminFindByIdAndUpdate = jest.fn();
const mockTeacherFindById = jest.fn();

jest.mock("../models/Academic/yearGroup.model", () => ({
  findOne: (...a) => mockYearGroupFindOne(...a),
  create: (...a) => mockYearGroupCreate(...a),
}));

jest.mock("../models/Staff/admin.model", () => ({
  findById: (...a) => mockAdminFindById(...a),
  findByIdAndUpdate: (...a) => mockAdminFindByIdAndUpdate(...a),
}));

jest.mock("../models/Staff/teachers.model", () => ({
  findById: (...a) => {
    const chain = mockTeacherFindById(...a);
    return chain;
  },
}));

const { createYearGroupService } = require("../services/academic/yearGroup.service");

const ADMIN_ID = "admin-001";
const MANAGER_ID = "teacher-mgr-001";
const REGULAR_TEACHER_ID = "teacher-regular-001";

let fakeRes;

beforeEach(() => {
  jest.clearAllMocks();

  fakeRes = {
    status: jest.fn().mockReturnThis(),
    json: jest.fn().mockReturnThis(),
  };
  fakeRes.status.mockImplementation((code) => {
    fakeRes._statusCode = code;
    return fakeRes;
  });
  fakeRes.json.mockImplementation((body) => {
    fakeRes._body = body;
    return fakeRes;
  });

  // YearGroup doesn't already exist
  mockYearGroupFindOne.mockResolvedValue(null);

  // YearGroup.create returns a fake created document
  mockYearGroupCreate.mockImplementation(async (doc) => ({
    _id: "yg-" + Math.random().toString(36).slice(2, 8),
    ...doc,
  }));

  // Admin.findByIdAndUpdate no-op
  mockAdminFindByIdAndUpdate.mockResolvedValue({});

  // Teacher.findById returns a chainable mock (.select().lean())
  mockTeacherFindById.mockImplementation(() => ({
    select: () => ({
      lean: () => Promise.resolve(null),
    }),
  }));
});

describe("createYearGroupService — manager access", () => {
  test("ALLOWS admin to create a year group and tracks on Admin document", async () => {
    mockAdminFindById.mockResolvedValue({ _id: ADMIN_ID, role: "admin" });

    const result = await createYearGroupService(
      { name: "Year 7", academicYear: "2025-2026" },
      ADMIN_ID,
      fakeRes,
    );

    expect(fakeRes._statusCode).toBe(200);
    expect(fakeRes._body.status).toBe("success");
    // Admin tracking push should happen for admins
    expect(mockAdminFindByIdAndUpdate).toHaveBeenCalledWith(ADMIN_ID, {
      $push: { yearGroups: expect.anything() },
    });
  });

  test("ALLOWS manager (teacher with isAttendanceManager=true) to create a year group", async () => {
    // Not an admin
    mockAdminFindById.mockResolvedValue(null);
    // But is a manager
    mockTeacherFindById.mockImplementation(() => ({
      select: () => ({
        lean: () => Promise.resolve({ _id: MANAGER_ID, isAttendanceManager: true }),
      }),
    }));

    const result = await createYearGroupService(
      { name: "Year 8", academicYear: "2025-2026" },
      MANAGER_ID,
      fakeRes,
    );

    expect(fakeRes._statusCode).toBe(200);
    expect(fakeRes._body.status).toBe("success");
    // Admin tracking push should NOT happen for managers
    expect(mockAdminFindByIdAndUpdate).not.toHaveBeenCalled();
  });

  test("REJECTS regular teacher (isAttendanceManager=false) with 401", async () => {
    mockAdminFindById.mockResolvedValue(null);
    mockTeacherFindById.mockImplementation(() => ({
      select: () => ({
        lean: () => Promise.resolve({ _id: REGULAR_TEACHER_ID, isAttendanceManager: false }),
      }),
    }));

    await createYearGroupService(
      { name: "Year 9", academicYear: "2025-2026" },
      REGULAR_TEACHER_ID,
      fakeRes,
    );

    expect(fakeRes._statusCode).toBe(401);
    expect(fakeRes._body.status).toBe("failed");
  });

  test("REJECTS unknown user (no admin or teacher record) with 401", async () => {
    mockAdminFindById.mockResolvedValue(null);
    mockTeacherFindById.mockImplementation(() => ({
      select: () => ({
        lean: () => Promise.resolve(null),
      }),
    }));

    await createYearGroupService(
      { name: "Year 10", academicYear: "2025-2026" },
      "unknown-id",
      fakeRes,
    );

    expect(fakeRes._statusCode).toBe(401);
    expect(fakeRes._body.status).toBe("failed");
  });

  test("does NOT push to Admin tracking array when caller is a manager", async () => {
    mockAdminFindById.mockResolvedValue(null);
    mockTeacherFindById.mockImplementation(() => ({
      select: () => ({
        lean: () => Promise.resolve({ _id: MANAGER_ID, isAttendanceManager: true }),
      }),
    }));

    await createYearGroupService(
      { name: "Year 11", academicYear: "2025-2026" },
      MANAGER_ID,
      fakeRes,
    );

    // The year group should be created successfully
    expect(mockYearGroupCreate).toHaveBeenCalledTimes(1);
    // But Admin.findByIdAndUpdate should NOT be called (manager has no tracking array)
    expect(mockAdminFindByIdAndUpdate).not.toHaveBeenCalled();
  });
});
