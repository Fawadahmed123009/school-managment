/**
 * Test suite for manager (isAttendanceManager) access control
 * Verifies that managers have admin-like access to most routes EXCEPT fee/financial routes
 */

const isAdminOrManager = require("../middlewares/isAdminOrManager");
const Admin = require("../models/Staff/admin.model");
const Teacher = require("../models/Staff/teachers.model");

// Mock models
jest.mock("../models/Staff/admin.model");
jest.mock("../models/Staff/teachers.model");

describe("Manager Access Control — isAdminOrManager middleware", () => {
  let mockReq, mockRes, mockNext;

  beforeEach(() => {
    jest.clearAllMocks();
    mockReq = {
      userAuth: { id: "test-user-id" },
    };
    mockRes = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn(),
    };
    mockNext = jest.fn();
  });

  describe("Admin access (unchanged)", () => {
    it("ALLOWS admin user to proceed", async () => {
      const adminUser = { _id: "admin-id", role: "admin" };
      Admin.findById.mockResolvedValue(adminUser);
      Teacher.findById.mockResolvedValue(null);

      await isAdminOrManager(mockReq, mockRes, mockNext);

      expect(Admin.findById).toHaveBeenCalledWith("test-user-id");
      expect(Teacher.findById).toHaveBeenCalledWith("test-user-id");
      expect(mockNext).toHaveBeenCalled();
      expect(mockRes.status).not.toHaveBeenCalled();
    });

    it("ALLOWS admin even if teacher record also exists", async () => {
      const adminUser = { _id: "admin-id", role: "admin" };
      const teacherUser = { _id: "admin-id", isAttendanceManager: false };
      Admin.findById.mockResolvedValue(adminUser);
      Teacher.findById.mockResolvedValue(teacherUser);

      await isAdminOrManager(mockReq, mockRes, mockNext);

      expect(mockNext).toHaveBeenCalled();
      expect(mockRes.status).not.toHaveBeenCalled();
    });
  });

  describe("Manager access (teacher with isAttendanceManager=true)", () => {
    it("ALLOWS manager (teacher with isAttendanceManager=true) to proceed", async () => {
      const managerUser = { _id: "teacher-id", isAttendanceManager: true };
      Admin.findById.mockResolvedValue(null);
      Teacher.findById.mockResolvedValue(managerUser);

      await isAdminOrManager(mockReq, mockRes, mockNext);

      expect(Admin.findById).toHaveBeenCalledWith("test-user-id");
      expect(Teacher.findById).toHaveBeenCalledWith("test-user-id");
      expect(mockNext).toHaveBeenCalled();
      expect(mockRes.status).not.toHaveBeenCalled();
    });

    it("ALLOWS manager even if admin record also exists (edge case)", async () => {
      const adminUser = { _id: "teacher-id", role: "teacher" }; // Not "admin" role
      const managerUser = { _id: "teacher-id", isAttendanceManager: true };
      Admin.findById.mockResolvedValue(adminUser);
      Teacher.findById.mockResolvedValue(managerUser);

      await isAdminOrManager(mockReq, mockRes, mockNext);

      expect(mockNext).toHaveBeenCalled();
    });
  });

  describe("Regular teacher access (isAttendanceManager=false)", () => {
    it("REJECTS regular teacher (isAttendanceManager=false) with 403", async () => {
      const regularTeacher = { _id: "teacher-id", isAttendanceManager: false };
      Admin.findById.mockResolvedValue(null);
      Teacher.findById.mockResolvedValue(regularTeacher);

      await isAdminOrManager(mockReq, mockRes, mockNext);

      expect(mockNext).not.toHaveBeenCalled();
      expect(mockRes.status).toHaveBeenCalledWith(403);
      expect(mockRes.json).toHaveBeenCalledWith(
        expect.objectContaining({
          status: "failed",
          message: expect.stringContaining("Access Denied"),
        })
      );
    });

    it("REJECTS teacher with no isAttendanceManager field (defaults to false)", async () => {
      const teacherNoFlag = { _id: "teacher-id" }; // isAttendanceManager undefined
      Admin.findById.mockResolvedValue(null);
      Teacher.findById.mockResolvedValue(teacherNoFlag);

      await isAdminOrManager(mockReq, mockRes, mockNext);

      expect(mockNext).not.toHaveBeenCalled();
      expect(mockRes.status).toHaveBeenCalledWith(403);
    });
  });

  describe("Non-admin, non-teacher users", () => {
    it("REJECTS student user with 403", async () => {
      Admin.findById.mockResolvedValue(null);
      Teacher.findById.mockResolvedValue(null);

      await isAdminOrManager(mockReq, mockRes, mockNext);

      expect(mockNext).not.toHaveBeenCalled();
      expect(mockRes.status).toHaveBeenCalledWith(403);
    });

    it("REJECTS parent user with 403", async () => {
      Admin.findById.mockResolvedValue(null);
      Teacher.findById.mockResolvedValue(null);

      await isAdminOrManager(mockReq, mockRes, mockNext);

      expect(mockNext).not.toHaveBeenCalled();
      expect(mockRes.status).toHaveBeenCalledWith(403);
    });

    it("REJECTS unauthenticated request (no userAuth) with error", async () => {
      mockReq.userAuth = undefined;

      await isAdminOrManager(mockReq, mockRes, mockNext);

      expect(mockNext).not.toHaveBeenCalled();
      expect(mockRes.status).toHaveBeenCalledWith(500);
    });
  });

  describe("Error handling", () => {
    it("returns 500 on database error", async () => {
      Admin.findById.mockRejectedValue(new Error("DB error"));
      Teacher.findById.mockResolvedValue(null);

      await isAdminOrManager(mockReq, mockRes, mockNext);

      expect(mockNext).not.toHaveBeenCalled();
      expect(mockRes.status).toHaveBeenCalledWith(500);
      expect(mockRes.json).toHaveBeenCalledWith(
        expect.objectContaining({
          status: "failed",
          message: expect.stringContaining("Server error"),
        })
      );
    });
  });
});

describe("Fee Routes — Manager Access Denied", () => {
  // Fee routes use isAdmin middleware, NOT isAdminOrManager
  // This test verifies the middleware is correctly configured
  const isAdmin = require("../middlewares/isAdmin");

  let mockReq, mockRes, mockNext;

  beforeEach(() => {
    jest.clearAllMocks();
    mockReq = {
      userAuth: { id: "test-user-id" },
    };
    mockRes = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn(),
    };
    mockNext = jest.fn();
  });

  it("isAdmin middleware REJECTS manager (isAttendanceManager=true) with 403", async () => {
    const managerUser = { _id: "teacher-id", isAttendanceManager: true };
    Admin.findById.mockResolvedValue(null);
    Teacher.findById.mockResolvedValue(managerUser);

    await isAdmin(mockReq, mockRes, mockNext);

    expect(mockNext).not.toHaveBeenCalled();
    expect(mockRes.status).toHaveBeenCalledWith(403);
  });

  it("isAdmin middleware ALLOWS admin user", async () => {
    const adminUser = { _id: "admin-id", role: "admin" };
    Admin.findById.mockResolvedValue(adminUser);
    Teacher.findById.mockResolvedValue(null);

    await isAdmin(mockReq, mockRes, mockNext);

    expect(mockNext).toHaveBeenCalled();
    expect(mockRes.status).not.toHaveBeenCalled();
  });

  it("isAdmin middleware REJECTS regular teacher with 403", async () => {
    const regularTeacher = { _id: "teacher-id", isAttendanceManager: false };
    Admin.findById.mockResolvedValue(null);
    Teacher.findById.mockResolvedValue(regularTeacher);

    await isAdmin(mockReq, mockRes, mockNext);

    expect(mockNext).not.toHaveBeenCalled();
    expect(mockRes.status).toHaveBeenCalledWith(403);
  });
});

describe("Route-level integration — Manager can access admin routes", () => {
  // These tests verify the middleware logic directly
  // Route configuration is verified by checking which middleware is used in route files

  describe("Middleware configuration verification", () => {
    it("isAdminOrManager middleware is used in student routes", () => {
      const fs = require("fs");
      const routeContent = fs.readFileSync(
        "./routes/v1/students/students.router.js",
        "utf8"
      );
      expect(routeContent).toContain("isAdminOrManager");
    });

    it("isAdminOrManager middleware is used in teacher routes", () => {
      const fs = require("fs");
      const routeContent = fs.readFileSync(
        "./routes/v1/staff/teachers.router.js",
        "utf8"
      );
      expect(routeContent).toContain("isAdminOrManager");
    });

    it("isAdminOrManager middleware is used in parent routes", () => {
      const fs = require("fs");
      const routeContent = fs.readFileSync(
        "./routes/v1/parents/parents.router.js",
        "utf8"
      );
      expect(routeContent).toContain("isAdminOrManager");
    });

    it("isAdminOrManager middleware is used in class routes", () => {
      const fs = require("fs");
      const routeContent = fs.readFileSync(
        "./routes/v1/academic/class.router.js",
        "utf8"
      );
      expect(routeContent).toContain("isAdminOrManager");
    });

    it("isAdminOrManager middleware is used in program routes", () => {
      const fs = require("fs");
      const routeContent = fs.readFileSync(
        "./routes/v1/academic/program.router.js",
        "utf8"
      );
      expect(routeContent).toContain("isAdminOrManager");
    });

    it("isAdminOrManager middleware is used in subject routes", () => {
      const fs = require("fs");
      const routeContent = fs.readFileSync(
        "./routes/v1/academic/subject.router.js",
        "utf8"
      );
      expect(routeContent).toContain("isAdminOrManager");
    });

    it("isAdminOrManager middleware is used in assignment routes", () => {
      const fs = require("fs");
      const routeContent = fs.readFileSync(
        "./routes/v1/academic/assignment.router.js",
        "utf8"
      );
      expect(routeContent).toContain("isAdminOrManager");
    });

    it("isAdminOrManager middleware is used in test routes", () => {
      const fs = require("fs");
      const routeContent = fs.readFileSync(
        "./routes/v1/academic/test.router.js",
        "utf8"
      );
      expect(routeContent).toContain("isAdminOrManager");
    });

    it("isAdmin (NOT isAdminOrManager) middleware is used in fee routes", () => {
      const fs = require("fs");
      const routeContent = fs.readFileSync(
        "./routes/v1/fees/fees.router.js",
        "utf8"
      );
      expect(routeContent).toContain("isAdmin");
      expect(routeContent).not.toMatch(/isAdminOrManager(?!\s*\()/);
    });
  });
});
