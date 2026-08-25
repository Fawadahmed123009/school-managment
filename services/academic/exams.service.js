// Import necessary models
const Teacher = require("../../models/Staff/teachers.model");
const Exams = require("../../models/Academic/exams.model");
// Import responseStatus handler
const responseStatus = require("../../handlers/responseStatus.handler");

exports.createExamService = async (data, teacherId, res) => {
  const {
    name,
    description,
    subject,
    program,
    passMark,
    totalMark,
    academicTerm,
    academicYear,
    classLevel,
    duration,
    examDate,
    examTime,
  } = data;

  // Find the teacher
  const teacherExist = await Teacher.findById(teacherId);
  if (!teacherExist)
    return responseStatus(res, 401, "failed", "Teacher not found!");

  // Check if the exam already exists
  const examExist = await Exams.findOne({ name });
  if (examExist)
    return responseStatus(res, 402, "failed", "Exam already exists");

  // Create the exam
  const examCreate = await Exams.create({
    name,
    description,
    subject,
    program,
    passMark,
    totalMark,
    academicTerm,
    academicYear,
    classLevel,
    duration,
    examDate,
    examTime,
    createdBy: teacherExist._id,
  });

  // Save exam ID to the teacher collection
  await Teacher.findByIdAndUpdate(teacherId, { $push: { examsCreated: examCreate._id } });

  // Send the response
  return responseStatus(res, 200, "success", examCreate);
};

exports.getAllExamService = async () => {
  return await Exams.find();
};

exports.getExamByIdService = async (id) => {
  return await Exams.findById(id);
};

exports.updateExamService = async (data, examId, res) => {
  const {
    name,
    description,
    subject,
    program,
    academicTerm,
    duration,
    examDate,
    examTime,
    examType,
    createdBy,
    academicYear,
    classLevel,
  } = data;

  // Check if the updated name already exists
  const examFound = await Exams.findOne({ name });
  if (examFound) {
    return responseStatus(res, 402, "failed", "Exam already exists");
  }

  // Update the exam
  const examUpdated = await Exams.findByIdAndUpdate(
    examId,
    {
      name,
      description,
      subject,
      program,
      academicTerm,
      duration,
      examDate,
      examTime,
      examType,
      createdBy,
      academicYear,
      classLevel,
    },
    {
      new: true,
    }
  );

  // Send the response
  return responseStatus(res, 200, "success", examUpdated);
};
