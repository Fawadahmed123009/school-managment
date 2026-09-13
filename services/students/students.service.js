const {
  hashPassword,
  isPassMatched,
} = require("../../handlers/passHash.handler");
const Admin = require("../../models/Staff/admin.model");
const Teacher = require("../../models/Staff/teachers.model");
const Student = require("../../models/Students/students.model");
const Parent = require("../../models/Parents/parents.model");
const ClassLevel = require("../../models/Academic/class.model");
const Attendance = require("../../models/Academic/attendance.model");
const TestResult = require("../../models/Academic/testResult.model");
const Fees = require("../../models/Fees/fees.model");
const generateToken = require("../../utils/tokenGenerator");
const responseStatus = require("../../handlers/responseStatus.handler");
const crypto = require("crypto");
const { paginate } = require("../../utils/paginate");

// Generate a cryptographically random password (10 chars, URL-safe base64)
const generateRandomPassword = () => crypto.randomBytes(8).toString("base64url").slice(0, 10);

// Generate next family number: FAM-1001, FAM-1002, ...
const generateFamilyNumber = async () => {
  const lastParent = await Parent.findOne({ familyNumber: /^FAM-/ })
    .sort({ familyNumber: -1 })
    .select("familyNumber");
  if (!lastParent) return "FAM-1001";
  const lastNum = parseInt(lastParent.familyNumber.replace("FAM-", ""), 10);
  return `FAM-${String(lastNum + 1).padStart(4, "0")}`;
};

// ---- Family-match helper (shared by registration and add-parent-to-student) ----
// Attempts to find an existing parent by phone or email.
// Returns { matchedParent, familyNumber, parentId, newParentCredentials } or
// { confirmMatch } when admin confirmation is needed.
const runFamilyMatch = async ({ parentName, parentPhone, parentEmail, whatsappNumber, fatherName, familyAction }) => {
  const contactPhone = parentPhone || whatsappNumber;
  const contactEmail = parentEmail || null;

  let existingParent = null;
  if (contactPhone) {
    existingParent = await Parent.findOne({ phone: contactPhone })
      .populate({ path: "children", select: "name rollNumber fatherName", populate: { path: "classLevel", select: "name" } });
  }
  if (!existingParent && contactEmail) {
    existingParent = await Parent.findOne({ email: contactEmail })
      .populate({ path: "children", select: "name rollNumber fatherName", populate: { path: "classLevel", select: "name" } });
  }

  if (existingParent && !familyAction) {
    return {
      confirmMatch: {
        _id: existingParent._id,
        name: existingParent.name,
        phone: existingParent.phone,
        familyNumber: existingParent.familyNumber,
        children: existingParent.children,
      },
    };
  }

  if (existingParent && familyAction === "link") {
    return { familyNumber: existingParent.familyNumber, parentId: existingParent._id };
  }

  // familyAction === "new" OR no match — create new parent
  const familyNumber = await generateFamilyNumber();
  const plainParentPassword = generateRandomPassword();
  const parentPassword = await hashPassword(plainParentPassword);
  let email = contactEmail || `${contactPhone}@family.local`;
  const emailTaken = await Parent.findOne({ email });
  if (emailTaken) {
    email = contactEmail || `${contactPhone}_${Date.now()}@family.local`;
  }
  const newParent = await Parent.create({
    name: parentName || fatherName,
    email,
    password: parentPassword,
    phone: contactPhone,
    relationship: "father",
    familyNumber,
    children: [],
  });
  return {
    familyNumber,
    parentId: newParent._id,
    newParentCredentials: {
      name: newParent.name,
      email: newParent.email,
      phone: newParent.phone,
      password: plainParentPassword,
      familyNumber: newParent.familyNumber,
    },
  };
};

exports.adminRegisterStudentService = async (data, adminId, res) => {
  const { name, email, password, classLevel, rollNumber, fatherName, address, whatsappNumber, feeAgreed, gender, parentName, parentEmail, parentPhone, relationship, familyAction } = data;

  // Accept both admins and managers (teachers with isAttendanceManager).
  const [admin, teacher] = await Promise.all([
    Admin.findById(adminId),
    Teacher.findById(adminId).select("isAttendanceManager").lean(),
  ]);
  const isManager = teacher && teacher.isAttendanceManager;
  if (!admin && !isManager) {
    return responseStatus(res, 403, "failed", "Unauthorized access!");
  }

  const student = await Student.findOne({ email });
  if (student)
    return responseStatus(res, 402, "failed", "Student already enrolled");

  if (!classLevel) {
    return responseStatus(res, 400, "failed", "A class is required");
  }
  const classFound = await ClassLevel.findById(classLevel);
  if (!classFound) return responseStatus(res, 404, "failed", "Class not found");

  if (rollNumber === undefined || rollNumber === null || rollNumber === "") {
    return responseStatus(res, 400, "failed", "Roll number is required");
  }

  const rollTaken = await Student.findOne({ classLevel, rollNumber: String(rollNumber).trim() });
  if (rollTaken) {
    return responseStatus(res, 400, "failed", `Roll number ${rollNumber} is already used in this class`);
  }

  if (!fatherName) return responseStatus(res, 400, "failed", "Father's name is required");
  if (!address) return responseStatus(res, 400, "failed", "Address is required");
  if (!whatsappNumber) return responseStatus(res, 400, "failed", "WhatsApp contact number is required");
  if (!gender) return responseStatus(res, 400, "failed", "Gender is required");

  // ---- Family system: match or create parent ----
  let familyNumber = null;
  let parentId = null;
  var _newParentCredentials;

  // Only engage family system if explicit parent details were provided
  const hasParentDetails = parentName || parentPhone || parentEmail;

  if (hasParentDetails) {
    const matchResult = await runFamilyMatch({
      parentName, parentPhone, parentEmail, whatsappNumber, fatherName, familyAction,
    });

    if (matchResult.confirmMatch) {
      return res.status(200).json({
        status: "confirm",
        data: { matchedParent: matchResult.confirmMatch },
      });
    }

    familyNumber = matchResult.familyNumber;
    parentId = matchResult.parentId;
    if (matchResult.newParentCredentials) {
      _newParentCredentials = matchResult.newParentCredentials;
    }
  }

  const hashedPassword = await hashPassword(password);
  const studentRegistered = await Student.create({
    name,
    email,
    password: hashedPassword,
    classLevel,
    rollNumber: String(rollNumber).trim(),
    fatherName,
    address,
    whatsappNumber,
    feeAgreed: (feeAgreed !== undefined && feeAgreed !== null && feeAgreed !== "" && !Number.isNaN(Number(feeAgreed))) ? Number(feeAgreed) : null,
    gender,
    familyNumber,
    parent: parentId,
  });

  // Link student to parent's children array
  if (parentId) {
    await Parent.findByIdAndUpdate(parentId, { $push: { children: studentRegistered._id } });
  }

  // Track the new student on the admin's record (managers don't have a
  // students array, so this only applies when the caller is an admin).
  if (admin) {
    await Admin.findByIdAndUpdate(adminId, { $push: { students: studentRegistered._id } });
  }
  const responseData = { ...studentRegistered.toObject(), familyNumber, parent: parentId };
  if (typeof _newParentCredentials !== "undefined") {
    responseData.newParentCredentials = _newParentCredentials;
  }
  return responseStatus(res, 200, "success", responseData);
};

exports.studentLoginService = async (data, res) => {
  const { email, password } = data;
  const student = await Student.findOne({ email });
  if (!student)
    return responseStatus(res, 402, "failed", "Invalid login credentials");

  const isMatched = await isPassMatched(password, student?.password);
  if (!isMatched)
    return responseStatus(res, 401, "failed", "Invalid login credentials");

  const responseStudent = student.toObject();
  delete responseStudent.password;

  const responseData = { student: responseStudent, token: generateToken(student._id) };
  return responseStatus(res, 200, "success", responseData);
};

exports.getStudentsProfileService = async (id, res) => {
  const student = await Student.findById(id).select(
    "-password -createdAt -updatedAt"
  );
  if (!student) return responseStatus(res, 402, "failed", "Student not found");
  return responseStatus(res, 200, "success", student);
};

exports.getAllStudentsByAdminService = async (adminId, query, res) => {
  const result = await paginate(Student, {}, {
    page: query.page,
    limit: query.limit,
    select: "-password",
    sort: "name",
    populate: { path: "classLevel", select: "name gradeLevel group section" },
  });
  return responseStatus(res, 200, "success", result);
};

exports.getStudentByAdminService = async (studentID, res) => {
  const student = await Student.findById(studentID)
    .select("-password")
    .populate("classLevel", "name gradeLevel group section")
    .populate("parent", "name email phone relationship");
  if (!student) return responseStatus(res, 402, "failed", "Student not found");
  return responseStatus(res, 200, "success", student);
};

exports.studentUpdateProfileService = async (data, userId, res) => {
  const { email, password } = data;

  // Only check uniqueness if email is being changed
  if (email) {
    const emailExist = await Student.findOne({ email, _id: { $ne: userId } });
    if (emailExist)
      return responseStatus(res, 402, "failed", "This email is taken by another student");
  }

  const updateData = {};
  if (email) updateData.email = email;
  if (password) updateData.password = await hashPassword(password);

  const student = await Student.findByIdAndUpdate(
    userId,
    updateData,
    { new: true, runValidators: true }
  ).select("-password");
  return responseStatus(res, 200, "success", student);
};

exports.adminUpdateStudentService = async (data, studentId, res) => {
  const studentFound = await Student.findById(studentId);
  if (!studentFound) {
    return responseStatus(res, 404, "failed", "Student not found");
  }

  // Build $set from whichever fields the caller provides
  const allowedFields = [
    "name", "email", "fatherName", "address", "whatsappNumber",
    "feeAgreed", "gender", "classLevel", "rollNumber", "religion",
    "prefectName", "academicYear", "program",
    "isGraduated", "isWithdrawn", "isSuspended", "status",
  ];
  const $set = {};
  for (const key of allowedFields) {
    if (data[key] !== undefined) {
      // Coerce boolean-like fields
      if (key === "isGraduated" || key === "isWithdrawn" || key === "isSuspended") {
        $set[key] = data[key] === true || data[key] === "true" || data[key] === "on";
      } else if (key === "status") {
        // Only allow valid enum values
        if (data[key] === "active" || data[key] === "inactive") {
          $set[key] = data[key];
        }
      } else if (key === "feeAgreed") {
        // Blank / empty string → null ("not set, use fee head default")
        // Any valid number including 0 → store as-is (0 = scholarship)
        if (data[key] === "" || data[key] === null || data[key] === undefined) {
          $set[key] = null;
        } else {
          const num = Number(data[key]);
          if (!isNaN(num)) $set[key] = num;
        }
      } else if (key === "rollNumber") {
        $set[key] = String(data[key]).trim();
      }
    }
  }

  // If password provided, hash it and add to update
  if (data.password) {
    $set.password = await hashPassword(data.password);
  }

  // If email changed, check uniqueness
  if ($set.email && $set.email !== studentFound.email) {
    const emailTaken = await Student.findOne({ email: $set.email, _id: { $ne: studentId } });
    if (emailTaken) {
      return responseStatus(res, 400, "failed", "That email is already taken by another student");
    }
  }

  // If roll number or class changed, check uniqueness within class
  const newRoll = $set.rollNumber ?? studentFound.rollNumber;
  const newClass = $set.classLevel ?? studentFound.classLevel;
  const rollCollision = await Student.findOne({
    classLevel: newClass,
    rollNumber: newRoll,
    _id: { $ne: studentId },
  });
  if (rollCollision) {
    return responseStatus(res, 400, "failed", "That roll number is already used by another student in this class");
  }

  const studentUpdated = await Student.findByIdAndUpdate(studentId, { $set }, { new: true }).select("-password");
  return responseStatus(res, 200, "success", studentUpdated);
};

// ---- Feature 1: Update linked parent's basic info ----

exports.updateLinkedParentService = async (studentId, data, res) => {
  const student = await Student.findById(studentId);
  if (!student) {
    return responseStatus(res, 404, "failed", "Student not found");
  }
  if (!student.parent) {
    return responseStatus(res, 400, "failed", "This student has no linked parent account");
  }

  const parent = await Parent.findById(student.parent);
  if (!parent) {
    return responseStatus(res, 404, "failed", "Linked parent account not found");
  }

  // Validate email format if provided
  if (data.parentEmail) {
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(data.parentEmail)) {
      return responseStatus(res, 400, "failed", "Invalid email format");
    }
  }

  // Check email uniqueness if changing
  if (data.parentEmail && data.parentEmail !== parent.email) {
    const emailTaken = await Parent.findOne({ email: data.parentEmail, _id: { $ne: parent._id } });
    if (emailTaken) {
      return responseStatus(res, 409, "failed", "That email is already used by another parent account");
    }
  }

  // Validate relationship enum if provided
  if (data.relationship && !["father", "mother", "guardian"].includes(data.relationship)) {
    return responseStatus(res, 400, "failed", "Relationship must be father, mother, or guardian");
  }

  const $set = {};
  if (data.parentName !== undefined) $set.name = data.parentName;
  if (data.parentEmail !== undefined) $set.email = data.parentEmail;
  if (data.parentPhone !== undefined) $set.phone = data.parentPhone;
  if (data.relationship !== undefined) $set.relationship = data.relationship;

  if (Object.keys($set).length === 0) {
    return responseStatus(res, 400, "failed", "No fields to update");
  }

  const updated = await Parent.findByIdAndUpdate(student.parent, { $set }, { new: true }).select("-password");
  return responseStatus(res, 200, "success", updated);
};

// ---- Feature 2: Add parent details to a student with no linked parent ----

exports.addParentToStudentService = async (studentId, data, res) => {
  const { parentName, parentEmail, parentPhone, relationship, familyAction } = data;

  const student = await Student.findById(studentId);
  if (!student) {
    return responseStatus(res, 404, "failed", "Student not found");
  }
  if (student.parent) {
    return responseStatus(res, 400, "failed", "This student already has a linked parent");
  }

  if (!parentName && !parentPhone && !parentEmail) {
    return responseStatus(res, 400, "failed", "At least one parent detail (name, phone, or email) is required");
  }

  // Validate email format if provided
  if (parentEmail) {
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(parentEmail)) {
      return responseStatus(res, 400, "failed", "Invalid email format");
    }
  }

  // Reuse the same family-match logic as student registration
  const matchResult = await runFamilyMatch({
    parentName,
    parentPhone,
    parentEmail,
    whatsappNumber: student.whatsappNumber,
    fatherName: student.fatherName,
    familyAction,
  });

  if (matchResult.confirmMatch) {
    return res.status(200).json({
      status: "confirm",
      data: { matchedParent: matchResult.confirmMatch },
    });
  }

  // Link student to the parent
  const { familyNumber, parentId, newParentCredentials } = matchResult;
  await Student.findByIdAndUpdate(studentId, {
    $set: { familyNumber, parent: parentId },
  });
  await Parent.findByIdAndUpdate(parentId, { $push: { children: studentId } });

  const responseData = { familyNumber, parent: parentId };
  if (newParentCredentials) {
    responseData.newParentCredentials = newParentCredentials;
  }
  return responseStatus(res, 200, "success", responseData);
};

exports.adminDeleteStudentService = async (studentId, res) => {
  const student = await Student.findById(studentId);
  if (!student) {
    return responseStatus(res, 404, "failed", "Student not found");
  }

  // Block deletion when any Paid fee records exist for this student
  const paidFees = await Fees.findOne({ student: studentId, status: "paid" });
  if (paidFees) {
    return responseStatus(
      res,
      403,
      "failed",
      "Cannot delete student with paid fee records"
    );
  }

  // Cascade cleanup: delete related Attendance records
  await Attendance.deleteMany({ student: studentId });

  // Cascade cleanup: delete related TestResult records
  await TestResult.deleteMany({ student: studentId });

  // Cascade cleanup: remove student ID from any Parent.children array
  await Parent.updateMany(
    { children: studentId },
    { $pull: { children: studentId } }
  );

  // Delete the student
  await Student.findByIdAndDelete(studentId);
  return responseStatus(res, 200, "success", "Student deleted");
};
