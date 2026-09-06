const {
  hashPassword,
  isPassMatched,
} = require("../../handlers/passHash.handler");
const Admin = require("../../models/Staff/admin.model");
const Student = require("../../models/Students/students.model");
const Parent = require("../../models/Parents/parents.model");
const ClassLevel = require("../../models/Academic/class.model");
const Attendance = require("../../models/Academic/attendance.model");
const TestResult = require("../../models/Academic/testResult.model");
const Fees = require("../../models/Fees/fees.model");
const generateToken = require("../../utils/tokenGenerator");
const responseStatus = require("../../handlers/responseStatus.handler");
const { paginate } = require("../../utils/paginate");

// Generate next family number: FAM-1001, FAM-1002, ...
const generateFamilyNumber = async () => {
  const lastParent = await Parent.findOne({ familyNumber: /^FAM-/ })
    .sort({ familyNumber: -1 })
    .select("familyNumber");
  if (!lastParent) return "FAM-1001";
  const lastNum = parseInt(lastParent.familyNumber.replace("FAM-", ""), 10);
  return `FAM-${String(lastNum + 1).padStart(4, "0")}`;
};

exports.adminRegisterStudentService = async (data, adminId, res) => {
  const { name, email, password, classLevel, rollNumber, fatherName, address, whatsappNumber, feeAgreed, gender, parentName, parentEmail, parentPhone, relationship, familyAction } = data;

  const admin = await Admin.findById(adminId);
  if (!admin) {
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

  const rollTaken = await Student.findOne({ classLevel, rollNumber: Number(rollNumber) });
  if (rollTaken) {
    return responseStatus(res, 400, "failed", `Roll number ${rollNumber} is already used in this class`);
  }

  if (!fatherName) return responseStatus(res, 400, "failed", "Father's name is required");
  if (!address) return responseStatus(res, 400, "failed", "Address is required");
  if (!whatsappNumber) return responseStatus(res, 400, "failed", "WhatsApp contact number is required");
  if (feeAgreed === undefined || feeAgreed === null || feeAgreed === "") {
    return responseStatus(res, 400, "failed", "Fee agreed is required");
  }
  if (!gender) return responseStatus(res, 400, "failed", "Gender is required");

  // ---- Family system: match or create parent ----
  let familyNumber = null;
  let parentId = null;

  // Only engage family system if explicit parent details were provided
  const hasParentDetails = parentName || parentPhone || parentEmail;

  if (hasParentDetails) {
    const contactPhone = parentPhone || whatsappNumber;
    const contactEmail = parentEmail || null;

    // Try to find existing parent by phone or email
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
      // MATCH FOUND — require admin confirmation before linking
      return res.status(200).json({
        status: "confirm",
        data: {
          matchedParent: {
            _id: existingParent._id,
            name: existingParent.name,
            phone: existingParent.phone,
            familyNumber: existingParent.familyNumber,
            children: existingParent.children,
          },
        },
      });
    }

    if (existingParent && familyAction === "link") {
      // Admin confirmed: link to existing parent's family
      familyNumber = existingParent.familyNumber;
      parentId = existingParent._id;
    } else if (familyAction === "new" || !existingParent) {
      // Admin chose "create new" OR no match found — create new parent
      familyNumber = await generateFamilyNumber();
      const parentPassword = await hashPassword(contactPhone || "default123");
      // Ensure unique email — if phone-based email is taken, add timestamp
      let parentEmail = contactEmail || `${contactPhone}@family.local`;
      const emailTaken = await Parent.findOne({ email: parentEmail });
      if (emailTaken) {
        parentEmail = contactEmail || `${contactPhone}_${Date.now()}@family.local`;
      }
      const newParent = await Parent.create({
        name: parentName || fatherName,
        email: parentEmail,
        password: parentPassword,
        phone: contactPhone,
        relationship: relationship || "father",
        familyNumber,
        children: [],
      });
      parentId = newParent._id;
    }
  }

  const hashedPassword = await hashPassword(password);
  const studentRegistered = await Student.create({
    name,
    email,
    password: hashedPassword,
    classLevel,
    rollNumber: Number(rollNumber),
    fatherName,
    address,
    whatsappNumber,
    feeAgreed: Number(feeAgreed),
    gender,
    familyNumber,
    parent: parentId,
  });

  // Link student to parent's children array
  if (parentId) {
    await Parent.findByIdAndUpdate(parentId, { $push: { children: studentRegistered._id } });
  }

  await Admin.findByIdAndUpdate(adminId, { $push: { students: studentRegistered._id } });
  return responseStatus(res, 200, "success", { ...studentRegistered.toObject(), familyNumber, parent: parentId });
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
  const student = await Student.findById(studentID).select("-password").populate("classLevel", "name gradeLevel group section");
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
    "isGraduated", "isWithdrawn", "isSuspended",
  ];
  const $set = {};
  for (const key of allowedFields) {
    if (data[key] !== undefined) {
      // Coerce boolean-like fields
      if (key === "isGraduated" || key === "isWithdrawn" || key === "isSuspended") {
        $set[key] = data[key] === true || data[key] === "true" || data[key] === "on";
      } else if (key === "feeAgreed" || key === "rollNumber") {
        const num = Number(data[key]);
        if (!isNaN(num)) $set[key] = num;
      } else {
        $set[key] = data[key];
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
