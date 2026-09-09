const responseStatus = require("../../handlers/responseStatus.handler");
const Parent = require("../../models/Parents/parents.model");
const Student = require("../../models/Students/students.model");
const { isPassMatched } = require("../../handlers/passHash.handler");
const generateToken = require("../../utils/tokenGenerator");
const { hashPassword } = require("../../handlers/passHash.handler");
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

// ---- Parent Authentication ----

exports.parentLoginService = async (data, res) => {
  const { email, password } = data;
  const parent = await Parent.findOne({ email });
  if (!parent)
    return responseStatus(res, 402, "failed", "Invalid login credentials");

  if (!parent.isActive)
    return responseStatus(res, 403, "failed", "Account is deactivated");

  const isMatched = await isPassMatched(password, parent.password);
  if (!isMatched)
    return responseStatus(res, 401, "failed", "Invalid login credentials");

  const responseParent = parent.toObject();
  delete responseParent.password;

  const responseData = { parent: responseParent, token: generateToken(parent._id) };
  return responseStatus(res, 200, "success", responseData);
};

// ---- Parent Profile ----

exports.getParentProfileService = async (parentId, res) => {
  const parent = await Parent.findById(parentId)
    .select("-password")
    .populate({
      path: "children",
      select: "-password",
      populate: { path: "classLevel", select: "name gradeLevel group section" },
    });
  if (!parent) return responseStatus(res, 404, "failed", "Parent not found");
  return responseStatus(res, 200, "success", parent);
};

// ---- Children Data ----

exports.getChildrenAnalysisService = async (parentId, childId, res) => {
  const parent = await Parent.findById(parentId);
  if (!parent) return responseStatus(res, 404, "failed", "Parent not found");

  // Verify this child belongs to this parent
  if (!parent.children.some((c) => c.toString() === childId)) {
    return responseStatus(res, 403, "failed", "Access denied: This student is not linked to your account");
  }

  // Reuse student analysis logic
  const { getStudentAnalysisService } = require("../students/studentAnalysis.service");
  return getStudentAnalysisService(childId, res);
};

exports.getChildrenFeesService = async (parentId, childId, res) => {
  const parent = await Parent.findById(parentId);
  if (!parent) return responseStatus(res, 404, "failed", "Parent not found");

  if (!parent.children.some((c) => c.toString() === childId)) {
    return responseStatus(res, 403, "failed", "Access denied: This student is not linked to your account");
  }

  const Fees = require("../../models/Fees/fees.model");
  const fees = await Fees.find({ student: childId })
    .populate("academicTerm")
    .populate("academicYear")
    .populate("feeHead", "name");
  return responseStatus(res, 200, "success", fees);
};

// ---- Admin: Create Parent ----

exports.createParentService = async (data, res) => {
  const { name, email, password, phone, relationship, children } = data;
  if (!name || !email || !phone) {
    return responseStatus(res, 400, "failed", "Name, email, and phone are required");
  }

  const exists = await Parent.findOne({ email });
  if (exists) return responseStatus(res, 409, "failed", "A parent with this email already exists");

  // If no password provided, generate a random one
  const plainPassword = password || generateRandomPassword();
  const hashedPassword = await hashPassword(plainPassword);
  const familyNumber = await generateFamilyNumber();
  const parent = await Parent.create({
    name,
    email,
    password: hashedPassword,
    phone,
    relationship: relationship || "father",
    familyNumber,
    children: children || [],
  });

  // If children were provided, link them to this family
  if (children && children.length > 0) {
    await Student.updateMany(
      { _id: { $in: children } },
      { $set: { familyNumber, parent: parent._id } }
    );
  }

  // Return parent data INCLUDING the plain-text password (shown once to admin)
  const responseParent = parent.toObject();
  responseParent.plainPassword = plainPassword;
  return responseStatus(res, 201, "success", responseParent);
};

exports.getAllParentsService = async (query) => {
  return await paginate(Parent, {}, {
    page: query.page,
    limit: query.limit,
    select: "-password",
    sort: "name",
    populate: {
      path: "children",
      select: "name rollNumber classLevel",
      populate: { path: "classLevel", select: "name gradeLevel" },
    },
  });
};

exports.addChildToParentService = async (parentId, childId, res) => {
  const parent = await Parent.findById(parentId);
  if (!parent) return responseStatus(res, 404, "failed", "Parent not found");

  const student = await Student.findById(childId);
  if (!student) return responseStatus(res, 404, "failed", "Student not found");

  if (parent.children.includes(childId)) {
    return responseStatus(res, 400, "failed", "Student already linked to this parent");
  }

  await Parent.findByIdAndUpdate(parentId, { $push: { children: childId } }, { new: true });
  // Propagate family number to student
  await Student.findByIdAndUpdate(childId, { $set: { familyNumber: parent.familyNumber, parent: parentId } });
  const updated = await Parent.findById(parentId).select("-password").populate("children", "name rollNumber");
  return responseStatus(res, 200, "success", updated);
};
