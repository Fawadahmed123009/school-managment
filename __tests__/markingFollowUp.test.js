/**
 * Tests for the marking follow-up service that powers the admin dashboard's
 * "Tests awaiting marking — All teachers" panel.
 *
 *   • Every teacher with past-dated, not-fully-marked work appears, and the
 *     admin row for a teacher matches what that teacher sees themselves.
 *   • A teacher who has finished marking never appears.
 *   • Expected counts use only the classes the teacher is assigned to, so two
 *     colleagues splitting a multi-class test each get their own subtotal.
 *   • Withdrawn students are excluded from the expected pool.
 *   • Future-dated tests and tests of unassigned subjects are ignored.
 *   • Rows are ordered most-overdue first.
 *
 * Models are mocked at the data layer so the real service logic executes.
 */

const rowsByModel = {
  Assignment: [],
  Test: [],
  Student: [],
  TestResult: [],
  Teacher: [],
};

const seenQueries = {};

function mockModel(name) {
  return {
    find: (query) => {
      seenQueries[name] = query;
      const rows = () => {
        let r = rowsByModel[name];
        // Honour the two filters the service relies on in the DB query itself.
        if (query && query.isWithdrawn) r = r.filter((x) => x.isWithdrawn !== true);
        if (query && query.date && query.date.$lt) r = r.filter((x) => x.date < query.date.$lt);
        return r;
      };
      const chain = {
        populate: () => chain,
        select: () => chain,
        sort: () => chain,
        lean: () => Promise.resolve(rows()),
        then: (res) => Promise.resolve(rows()).then(res),
      };
      return chain;
    },
  };
}

jest.mock("../models/Academic/assignment.model", () => mockModel("Assignment"));
jest.mock("../models/Staff/teachers.model", () => mockModel("Teacher"));
jest.mock("../models/Students/students.model", () => mockModel("Student"));
jest.mock("../models/Academic/test.model", () => mockModel("Test"));
jest.mock("../models/Academic/testResult.model", () => mockModel("TestResult"));

const { getPendingMarkingAllTeachers } = require("../services/academic/markingFollowUp.service");

// ── Fixture helpers ──────────────────────────────────────────────────────────
const daysAgo = (n) => new Date(Date.now() - n * 86400000);
const oid = (s) => ({ _id: `oid-${s}`, toString: () => `oid-${s}` });

const teacher = (id, name) => ({ _id: oid(id), name });
const assignment = (teacherId, subjectId, subjectName, classId, className) => ({
  teacher: oid(teacherId),
  subject: { _id: oid(subjectId), name: subjectName },
  classLevel: { _id: oid(classId), name: className },
});
const student = (id, classId) => ({ _id: oid(id), classLevel: oid(classId) });
const test = (id, subjectId, classIds, date, name = `Test ${id}`) => ({
  _id: oid(id),
  name,
  subject: { _id: oid(subjectId), name: subjectId },
  classLevels: classIds.map((c) => ({ _id: oid(c), name: c })),
  date,
});
const result = (testId, studentId) => ({ test: oid(testId), student: oid(studentId) });

beforeEach(() => {
  Object.keys(rowsByModel).forEach((k) => (rowsByModel[k] = []));
});

describe("getPendingMarkingAllTeachers", () => {
  it("lists every teacher's overdue unmarked test with a Mark link id", async () => {
    rowsByModel.Teacher = [teacher("t1", "Ali"), teacher("t2", "Bela")];
    rowsByModel.Assignment = [
      assignment("t1", "math", "Math", "c1", "Class 1"),
      assignment("t2", "eng", "English", "c2", "Class 2"),
    ];
    rowsByModel.Student = [student("s1", "c1"), student("s2", "c1"), student("s3", "c2")];
    rowsByModel.Test = [test("k1", "math", ["c1"], daysAgo(3)), test("k2", "eng", ["c2"], daysAgo(1))];
    rowsByModel.TestResult = [result("k1", "s1")]; // Ali: 1 of 2 done, Bela: none

    const rows = await getPendingMarkingAllTeachers();

    expect(rows.map((r) => `${r.teacher}:${r._id._id}`)).toEqual(["Ali:oid-k1", "Bela:oid-k2"]);
    expect(rows[0]._id._id).toBe("oid-k1");
    expect(rows[0]).toMatchObject({ subject: "Math", classes: "Class 1", marked: 1, expected: 2 });
    expect(rows[1]._id._id).toBe("oid-k2");
    expect(rows[1]).toMatchObject({ subject: "English", classes: "Class 2", marked: 0, expected: 1 });
  });

  it("omits teachers whose past-dated tests are fully marked", async () => {
    rowsByModel.Teacher = [teacher("t1", "Ali"), teacher("t2", "Bela")];
    rowsByModel.Assignment = [
      assignment("t1", "math", "Math", "c1", "Class 1"),
      assignment("t2", "eng", "English", "c2", "Class 2"),
    ];
    rowsByModel.Student = [student("s1", "c1"), student("s2", "c2")];
    rowsByModel.Test = [test("k1", "math", ["c1"], daysAgo(2)), test("k2", "eng", ["c2"], daysAgo(2))];
    rowsByModel.TestResult = [result("k1", "s1")]; // only Ali is up to date

    const rows = await getPendingMarkingAllTeachers();

    expect(rows.map((r) => r.teacher)).toEqual(["Bela"]);
  });

  it("counts only the classes each teacher owns on a shared multi-class test", async () => {
    rowsByModel.Teacher = [teacher("t1", "Ali"), teacher("t2", "Bela")];
    rowsByModel.Assignment = [
      assignment("t1", "math", "Math", "c1", "Class 1A"),
      assignment("t2", "math", "Math", "c2", "Class 1B"),
    ];
    rowsByModel.Student = [student("s1", "c1"), student("s2", "c1"), student("s3", "c2"), student("s4", "c2"), student("s5", "c2")];
    rowsByModel.Test = [test("k1", "math", ["c1", "c2"], daysAgo(4))];
    rowsByModel.TestResult = [result("k1", "s1"), result("k1", "s3")];

    const rows = await getPendingMarkingAllTeachers();

    expect(rows).toHaveLength(2);
    const ali = rows.find((r) => r.teacher === "Ali");
    const bela = rows.find((r) => r.teacher === "Bela");
    expect(ali).toMatchObject({ marked: 1, expected: 2, classes: "Class 1A" });
    expect(bela).toMatchObject({ marked: 1, expected: 3, classes: "Class 1B" });
  });

  it("excludes withdrawn students from the expected pool", async () => {
    rowsByModel.Teacher = [teacher("t1", "Ali")];
    rowsByModel.Assignment = [assignment("t1", "math", "Math", "c1", "Class 1")];
    rowsByModel.Student = [
      student("s1", "c1"),
      Object.assign(student("s2", "c1"), { isWithdrawn: true }),
    ];
    rowsByModel.Test = [test("k1", "math", ["c1"], daysAgo(1))];
    rowsByModel.TestResult = [];

    const rows = await getPendingMarkingAllTeachers();

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ marked: 0, expected: 1 });
    expect(seenQueries.Student).toEqual({ isWithdrawn: { $ne: true } });
  });

  it("ignores future-dated tests and subjects the teacher is not assigned", async () => {
    rowsByModel.Teacher = [teacher("t1", "Ali")];
    rowsByModel.Assignment = [assignment("t1", "math", "Math", "c1", "Class 1")];
    rowsByModel.Student = [student("s1", "c1")];
    rowsByModel.Test = [
      test("future", "math", ["c1"], new Date(Date.now() + 5 * 86400000)),
      test("other-subject", "eng", ["c1"], daysAgo(2)),
      test("mine", "math", ["c1"], daysAgo(2)),
    ];
    rowsByModel.TestResult = [];

    const rows = await getPendingMarkingAllTeachers();

    expect(rows.map((r) => r._id._id)).toEqual(["oid-mine"]);
    expect(seenQueries.Test).toEqual({ date: { $lt: expect.any(Date) } });
  });

  it("orders rows most-overdue first", async () => {
    rowsByModel.Teacher = [teacher("t1", "Ali"), teacher("t2", "Bela")];
    rowsByModel.Assignment = [
      assignment("t1", "math", "Math", "c1", "Class 1"),
      assignment("t2", "eng", "English", "c2", "Class 2"),
    ];
    rowsByModel.Student = [student("s1", "c1"), student("s2", "c2")];
    rowsByModel.Test = [test("recent", "math", ["c1"], daysAgo(1)), test("stale", "eng", ["c2"], daysAgo(9))];
    rowsByModel.TestResult = [];

    const rows = await getPendingMarkingAllTeachers();

    expect(rows.map((r) => r._id._id)).toEqual(["oid-stale", "oid-recent"]);
  });

  it("returns nothing when no teacher has any assignment", async () => {
    rowsByModel.Teacher = [teacher("t1", "Ali")];
    rowsByModel.Test = [test("k1", "math", ["c1"], daysAgo(1))];
    rowsByModel.Student = [student("s1", "c1")];

    await expect(getPendingMarkingAllTeachers()).resolves.toEqual([]);
  });
});
