# Inactive Student Dues Exclusion

## Approach: Query-time filtering (Option A)

No changes to the Fees model or fee records. Every query that surfaces pending/unpaid fees will first resolve the set of inactive student IDs and exclude them. A new dedicated query + view surfaces exactly those excluded records.

Reactivation is automatic: since no data is mutated, flipping a student back to "active" immediately removes them from the inactive dues list and restores them to normal reports.

---

## 1. Defaulter List -- exclude inactive students

**File:** `services/fees/feeHead.service.js` -- `getDefaulterListData()`

- Before the fee query, resolve inactive student IDs:
  ```js
  const inactiveStudents = await Student.find({ status: "inactive" }).select("_id").lean();
  const inactiveIds = inactiveStudents.map(s => s._id);
  ```
- Add to the fee filter:
  ```js
  if (inactiveIds.length > 0) {
    feeFilter.student = { $nin: inactiveIds };
  }
  ```

---

## 2. Dashboard Stats -- exclude inactive students' unpaid fees

**File:** `routes/views/dashboard.views.js` -- lines 36-44

- Before the `Fees.find().lean()` call, resolve inactive IDs (same pattern).
- In the loop that sums `stats.outstanding`, skip fees belonging to inactive students:
  ```js
  const inactiveSet = new Set(inactiveIds.map(id => id.toString()));
  for (const f of results[2]) {
    if (f.status === "paid") stats.collected += f.amount;
    else if (!inactiveSet.has(f.student.toString())) stats.outstanding += f.amount;
  }
  ```
- Paid fees from inactive students still count in `stats.collected` (they were legitimately collected). Only unpaid/outstanding is filtered.

---

## 3. Dashboard Fee Collection Chart -- exclude inactive unpaid

**File:** `routes/views/dashboard.views.js` -- lines 77-91

- Add a `$lookup` + `$match` stage to the aggregation to exclude unpaid fees from inactive students:
  ```js
  const feeAgg = await Fees.aggregate([
    { $match: { createdAt: { $gte: sixMonthsAgo } } },
    { $lookup: { from: "students", localField: "student", foreignField: "_id", as: "_stu" } },
    { $addFields: { _stuStatus: { $arrayElemAt: ["$_stu.status", 0] } } },
    { $match: { $or: [
      { status: "paid" },
      { _stuStatus: { $ne: "inactive" } }
    ]}},
    { $project: { _stu: 0, _stuStatus: 0 } },
    { $group: { ... } },
    { $sort: { _id: 1 } },
  ]);
  ```
  This keeps paid fees (regardless of student status) but drops unpaid fees for inactive students.

---

## 4. Dashboard Fee Breakdown Chart -- exclude inactive unpaid

**File:** `routes/views/dashboard.views.js` -- lines 100-109

- Same `$lookup` pattern: keep paid fees, exclude unpaid fees where student is inactive.

---

## 5. New "Inactive Student Dues" service function

**File:** `services/fees/feeHead.service.js`

- Add `getInactiveStudentDuesData(query)`:
  - Resolve inactive student IDs.
  - Query `Fees.find({ status: { $in: ["pending", "partial"] }, student: { $in: inactiveIds } })`.
  - Populate student (name, rollNumber, classLevel, status, fatherName, whatsappNumber) and feeHead.
  - Group by class/section (same shape as defaulter list) for consistent display.
  - Return `{ byClass, grandOwed, studentCount }`.

---

## 6. New route for Inactive Dues view

**File:** `routes/views/feeHeads.views.js`

- Add `GET /fees/inactive-dues` (admin-only, same pattern as `/fees/defaulters`):
  ```js
  router.get("/fees/inactive-dues", requireRole("admin"), async (req, res) => {
    const [dues, classLevels] = await Promise.all([
      getInactiveStudentDuesData(req.query),
      ClassLevel.find({}).select("name gradeLevel group section").sort("gradeLevel"),
    ]);
    res.render("fees/inactive-dues", { page: "fees-inactive-dues", ... });
  });
  ```

---

## 7. New EJS view

**File:** `views/fees/inactive-dues.ejs` (new file)

- Modeled on `defaulters.ejs` but with:
  - Title: "Inactive Student Dues"
  - Empty state: "No inactive students have pending dues"
  - Same class/section grouping, showing student name, roll number, fee head, amount, and since when (createdAt)
  - A clear banner/note explaining these are excluded from the main collection/defaulter reports

---

## 8. Sidebar navigation

**File:** `views/partials/sidebar.ejs`

- Add a link after "Defaulters":
  ```html
  <a href="/fees/inactive-dues" class="<%= page === 'fees-inactive-dues' ? 'active' : '' %>">Inactive dues</a>
  ```

---

## Files changed (summary)

| File | Change |
|------|--------|
| `services/fees/feeHead.service.js` | Add inactive exclusion to `getDefaulterListData`; add new `getInactiveStudentDuesData` |
| `routes/views/dashboard.views.js` | Exclude inactive students' unpaid fees from stats, collection chart, breakdown chart |
| `routes/views/feeHeads.views.js` | Add `/fees/inactive-dues` route |
| `views/fees/inactive-dues.ejs` | New view file |
| `views/partials/sidebar.ejs` | Add sidebar link |

No changes to the Fees model, no changes to fee records, no changes to the collection report (it only shows paid fees).
