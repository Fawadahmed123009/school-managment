# API Documentation — School Management System

> Auto-generated from source code. Base URL: `/api/v1`  
> All API routes are mounted via `routeSync` → `app.use("/api/v1", require(routerFile))`

---

## Top-Level Summary: Can an External Client Call These APIs Today?

**Yes.** An external client (mobile app, SPA, third-party integration) can authenticate and call every `/api/v1/*` endpoint using only an `Authorization: Bearer <token>` header — no browser session or cookie required.

### Why this works

| Layer | What it does | Cookie-dependent? |
|-------|-------------|-------------------|
| `isLoggedIn` middleware | Reads `Authorization: Bearer <token>`, verifies JWT, sets `req.userAuth` | **No** — header only |
| Role middleware (`isAdmin`, `isTeacher`, etc.) | Reads `req.userAuth.id` to look up the user model | **No** — uses `req.userAuth` |
| `authView` middleware | Reads `req.cookies.session` for SSR pages | **Yes** — but only applies to view routes, not `/api/*` |
| CSRF middleware | Validates CSRF token on mutating view routes | **Yes** — but only applies after `authView`, not to `/api/*` |
| CORS | Applied only to `/api` prefix; allows `!origin` (server-side, curl, mobile) | **No** — explicitly allows no-origin requests |

### Login flow for external clients

1. `POST /api/v1/admin/login` (or `/teacher/login`, `/students/login`, `/parents/login`)
2. Response body contains `{ status: "success", data: { user, token } }`
3. Store the `token` (JWT, 1-day expiry)
4. Send `Authorization: Bearer <token>` on every subsequent request

**No changes needed.** The API is already fully usable by external clients today.

---

## Authentication Architecture

### JWT Token

- **Generation**: `utils/tokenGenerator.js` — `jwt.sign({ id }, JWT_SECRET_KEY, { expiresIn: "1d" })`
- **Verification**: `utils/verifyToken.js` — `jwt.verify(token, JWT_SECRET_KEY)`
- **Payload**: `{ id: <MongoDB _id of user>, iat, exp }`

### Two Parallel Auth Systems

| System | Used by | Token source | Populates |
|--------|---------|-------------|-----------|
| `isLoggedIn` (Bearer) | `/api/v1/*` routes | `Authorization: Bearer <token>` header | `req.userAuth = { id }` |
| `authView` (cookie) | SSR view routes | `req.cookies.session` → JSON `{ token, user }` | `req.user`, `req.token` |

### Response Envelope

All API responses use `handlers/responseStatus.handler.js`:

```json
// Success
{ "status": "success", "data": <any> }

// Error
{ "status": "failed", "message": "<error string>" }
```

### Rate Limiting

| Scope | Limit | Window |
|-------|-------|--------|
| Global (all routes) | 500 req/IP | 15 min |
| Login routes only | 20 req/IP | 15 min |

Login routes: `/api/v1/admin/login`, `/api/v1/teacher/login`, `/api/v1/students/login`, `/api/v1/parents/login`

---

## 1. Auth / Login Endpoints

### 1.1 Admin Login

| | |
|---|---|
| **Method** | `POST` |
| **Path** | `/api/v1/admin/login` |
| **Middleware** | None (public) + login rate limit (20/15min) |
| **Controller** | `loginAdminController` → `loginAdminService` |
| **Service** | `services/staff/admin.service.js` |

**Request Body:**
```json
{ "email": "string", "password": "string" }
```

**Success Response (200):**
```json
{
  "status": "success",
  "data": {
    "user": {
      "_id": "MongoDB ObjectId",
      "name": "string",
      "email": "string",
      "role": "admin"
    },
    "token": "JWT string (1d expiry)"
  }
}
```

**Error Responses:**
- `401` — `{ "status": "failed", "message": "Invalid login credentials" }`

---

### 1.2 Teacher Login

| | |
|---|---|
| **Method** | `POST` |
| **Path** | `/api/v1/teacher/login` |
| **Middleware** | None (public) + login rate limit |
| **Controller** | `teacherLoginController` → `teacherLoginService` |
| **Service** | `services/staff/teachers.service.js` |

**Request Body:**
```json
{ "email": "string", "password": "string" }
```

**Success Response (200):**
```json
{
  "status": "success",
  "data": {
    "teacher": {
      "_id": "ObjectId",
      "name": "string",
      "email": "string",
      "role": "teacher",
      "teacherId": "string",
      "isAttendanceManager": false,
      "isWithdrawn": false,
      "isSuspended": false,
      "subject": "ObjectId",
      "classLevel": "string",
      "program": "string",
      "academicYear": "string",
      "academicTerm": "string",
      "applicationStatus": "approved",
      "dateEmployed": "ISO date",
      "createdBy": "ObjectId",
      "examsCreated": []
    },
    "token": "JWT string"
  }
}
```

**Error Responses:**
- `402` — `{ "status": "failed", "message": "Invalid login credentials" }` (teacher not found)
- `401` — `{ "status": "failed", "message": "Invalid login credentials" }` (wrong password)

---

### 1.3 Student Login

| | |
|---|---|
| **Method** | `POST` |
| **Path** | `/api/v1/students/login` |
| **Middleware** | None (public) + login rate limit |
| **Controller** | `studentLoginController` → `studentLoginService` |
| **Service** | `services/students/students.service.js` |

**Request Body:**
```json
{ "email": "string", "password": "string" }
```

**Success Response (200):**
```json
{
  "status": "success",
  "data": {
    "student": {
      "_id": "ObjectId",
      "name": "string",
      "email": "string",
      "role": "student",
      "...": "(full student document minus password)"
    },
    "token": "JWT string"
  }
}
```

**Error Responses:**
- `402` — `{ "status": "failed", "message": "Invalid login credentials" }` (not found)
- `401` — `{ "status": "failed", "message": "Invalid login credentials" }` (wrong password)

---

### 1.4 Parent Login

| | |
|---|---|
| **Method** | `POST` |
| **Path** | `/api/v1/parents/login` |
| **Middleware** | None (public) + login rate limit |
| **Controller** | `parentLoginController` → `parentLoginService` |
| **Service** | `services/parents/parents.service.js` |

**Request Body:**
```json
{ "email": "string", "password": "string" }
```

**Success Response (200):**
```json
{
  "status": "success",
  "data": {
    "parent": {
      "_id": "ObjectId",
      "name": "string",
      "email": "string",
      "phone": "string",
      "role": "parent",
      "familyNumber": "FAM-XXXX",
      "relationship": "string",
      "children": ["ObjectId"],
      "isActive": true
    },
    "token": "JWT string"
  }
}
```

**Error Responses:**
- `402` — `{ "status": "failed", "message": "Invalid login credentials" }` (not found)
- `403` — `{ "status": "failed", "message": "Account is deactivated" }` (inactive)
- `401` — `{ "status": "failed", "message": "Invalid login credentials" }` (wrong password)

---

### Login Flow Summary (All Roles)

```
Client                          Server
  │                                │
  │  POST /api/v1/{role}/login     │
  │  { email, password }           │
  │ ─────────────────────────────► │
  │                                │  1. Find user in DB by email
  │                                │  2. Compare password (bcrypt)
  │                                │  3. Generate JWT: { id: user._id }
  │                                │
  │  200 { status, data:           │
  │    { user/teacher/.../parent,  │
  │      token } }                 │
  │ ◄───────────────────────────── │
  │                                │
  │  Store token                   │
  │  Send with every request:      │
  │  Authorization: Bearer <token> │
```

**Key point**: The login response returns the JWT **in the JSON body only**. No cookie is set by the API login endpoints. The `session` cookie is set only by the SSR view-layer login (`POST /login` in `auth.views.js`), which internally calls the same API and then sets the cookie for browser use.

---

## 2. Admin / Staff Management

### 2.1 Admin Registration

| | |
|---|---|
| **Method** | `POST` |
| **Path** | `/api/v1/admin/register` |
| **Middleware** | `isLoggedIn`, `isAdminOrManager` |
| **Controller** | `registerAdminController` |
| **Service** | `services/staff/admin.service.js` → `registerAdminService` |

**Request Body:**
```json
{ "name": "string", "email": "string", "password": "string" }
```

**Success (201):** `{ "status": "success", "data": "Registration Successful!" }`  
**Error (409):** `{ "status": "failed", "message": "Email Already in use" }`

---

### 2.2 Get All Admins

| | |
|---|---|
| **Method** | `GET` |
| **Path** | `/api/v1/admins` |
| **Middleware** | `isLoggedIn`, `isAdminOrManager` |
| **Controller** | `getAdminsController` |

**Success (200):** `{ "status": "success", "data": [Admin...] }` (password, createdAt, updatedAt excluded)

---

### 2.3 Get Current Admin Profile

| | |
|---|---|
| **Method** | `GET` |
| **Path** | `/api/v1/admin/profile` |
| **Middleware** | `isLoggedIn`, `isAdminOrManager` |
| **Controller** | `getAdminProfileController` |

**Success (200):** `{ "status": "success", "data": <Admin with populated refs> }`  
**Error (404):** `{ "status": "failed", "message": "Admin doesn't exist " }`

---

### 2.4 Update Admin

| | |
|---|---|
| **Method** | `PUT` |
| **Path** | `/api/v1/admin/:adminId` |
| **Middleware** | `isLoggedIn`, `isAdminOrManager` |
| **Controller** | `updateAdminController` |

**Request Body:**
```json
{ "name": "string?", "email": "string?", "password": "string?" }
```

**Success (200):** `{ "status": "success", "data": <updated Admin> }`  
**Error (409):** `{ "status": "failed", "message": "Email is already in use by another admin" }`

---

### 2.5 Delete Admin

| | |
|---|---|
| **Method** | `DELETE` |
| **Path** | `/api/v1/admin/:adminId` |
| **Middleware** | `isLoggedIn`, `isAdminOrManager` |
| **Controller** | `deleteAdminController` |

**Success (201):** `{ "status": "success", "data": "delete admin" }`

---

### 2.6 Admin Suspend / Unsuspend / Withdraw / Unwithdraw Teacher

| Method | Path | Middleware |
|--------|------|------------|
| `PUT` | `/api/v1/admins/suspend/teacher/:teacherId` | `isLoggedIn`, `isAdminOrManager` |
| `PUT` | `/api/v1/admins/unsuspend/teacher/:teacherId` | `isLoggedIn`, `isAdminOrManager` |
| `PUT` | `/api/v1/admins/withdraw/teacher/:teacherId` | `isLoggedIn`, `isAdminOrManager` |
| `PUT` | `/api/v1/admins/unwithdraw/teacher/:teacherId` | `isLoggedIn`, `isAdminOrManager` |

**Success (201):** `{ "status": "success", "data": "admin suspend teacher" }` (etc.)

---

### 2.7 Admin Publish / Unpublish Result

| Method | Path | Middleware |
|--------|------|------------|
| `PUT` | `/api/v1/admins/publish/result/:resultId` | `isLoggedIn`, `isAdminOrManager` |
| `PUT` | `/api/v1/admins/unpublish/result/:resultId` | `isLoggedIn`, `isAdminOrManager` |

**Success (201):** `{ "status": "success", "data": "admin publish exam" }` (etc.)

---

## 3. Teachers

### 3.1 Create Teacher (Admin/Manager)

| | |
|---|---|
| **Method** | `POST` |
| **Path** | `/api/v1/create-teacher` |
| **Middleware** | `isLoggedIn`, `isAdminOrManager` |
| **Controller** | `createTeacherController` |
| **Service** | `services/staff/teachers.service.js` → `createTeacherService` |

**Request Body:**
```json
{ "name": "string", "email": "string", "password": "string" }
```

**Success (200):** `{ "status": "success", "data": <Teacher> }`  
**Error (402):** `{ "status": "failed", "message": "Teacher already exists" }`  
**Error (401):** `{ "status": "fail", "message": "Unauthorized access" }`

---

### 3.2 Get All Teachers

| | |
|---|---|
| **Method** | `GET` |
| **Path** | `/api/v1/teachers` |
| **Middleware** | `isLoggedIn`, `isAdminOrManager` |
| **Controller** | `getAllTeachersController` |

**Query Params:** `?page=1&limit=10&search=string`

**Success (200):** `{ "status": "success", "data": <paginated result> }`

---

### 3.3 Get Teacher Profile

| | |
|---|---|
| **Method** | `GET` |
| **Path** | `/api/v1/teacher/:teacherId/profile` |
| **Middleware** | `isLoggedIn`, `isTeacher` |
| **Controller** | `getTeacherProfileController` |

**Success (200):** `{ "status": "success", "data": <Teacher (no password/createdAt/updatedAt)> }`

---

### 3.4 Teacher Update Own Profile

| | |
|---|---|
| **Method** | `PATCH` |
| **Path** | `/api/v1/teacher/update-profile` |
| **Middleware** | `isLoggedIn`, `isTeacher` |
| **Controller** | `updateTeacherProfileController` |

**Request Body:**
```json
{ "name": "string?", "email": "string?", "password": "string?" }
```

**Success (200):** `{ "status": "success", "data": { "teacher": <Teacher>, "token": "new JWT" } }`

---

### 3.5 Admin Update Teacher Profile

| | |
|---|---|
| **Method** | `PATCH` |
| **Path** | `/api/v1/teacher/:teacherId/update-profile` |
| **Middleware** | `isLoggedIn`, `isAdminOrManager` |
| **Controller** | `adminUpdateTeacherProfileController` |

**Request Body:**
```json
{ "program": "string?", "classLevel": "string?", "academicYear": "string?", "subject": "ObjectId?" }
```

**Success (200):** `{ "status": "success", "data": <Teacher (no password)> }`  
**Error (404):** `{ "status": "failed", "message": "No such teacher found" }`

---

### 3.6 Toggle Attendance Manager

| | |
|---|---|
| **Method** | `PATCH` |
| **Path** | `/api/v1/teacher/:teacherId/toggle-attendance-manager` |
| **Middleware** | `isLoggedIn`, `isAdminOrManager` |
| **Controller** | `toggleAttendanceManagerController` |

**Success (200):** `{ "status": "success", "data": <Teacher (no password)> }`  
**Error (404):** `{ "status": "failed", "message": "Teacher not found" }`

---

### 3.7 Admin Update Teacher Credentials

| | |
|---|---|
| **Method** | `PUT` |
| **Path** | `/api/v1/teacher/:teacherId/credentials` |
| **Middleware** | `isLoggedIn`, `isAdminOrManager` |
| **Controller** | `adminUpdateCredentialsController` |

**Request Body:**
```json
{ "name": "string?", "email": "string?", "password": "string?" }
```

**Success (200):** `{ "status": "success", "data": <Teacher (no password)> }`  
**Error (402):** `{ "status": "failed", "message": "Email already in use" }`

---

### 3.8 Admin Get Teacher by ID

| | |
|---|---|
| **Method** | `GET` |
| **Path** | `/api/v1/admin/teacher/:teacherId` |
| **Middleware** | `isLoggedIn`, `isAdminOrManager` |
| **Controller** | `adminGetTeacherController` |

**Success (200):** `{ "status": "success", "data": <Teacher> }`  
**Error (404):** `{ "status": "failed", "message": "Teacher not found" }`

---

### 3.9 Delete Teacher

| | |
|---|---|
| **Method** | `DELETE` |
| **Path** | `/api/v1/teacher/:teacherId` |
| **Middleware** | `isLoggedIn`, `isAdminOrManager` |
| **Controller** | `deleteTeacherController` |

**Success (200):** `{ "status": "success", "data": "Teacher deleted" }`  
**Error (404):** `{ "status": "failed", "message": "Teacher not found" }`

*Cascades: deletes Assignments, nulls out markedBy on TestResult/Attendance, removes from Admin.teachers*

---

## 4. Students

### 4.1 Admin Register Student

| | |
|---|---|
| **Method** | `POST` |
| **Path** | `/api/v1/students/admin/register` |
| **Middleware** | `isLoggedIn`, `isAdminOrManager` |
| **Controller** | `adminRegisterStudentController` |

**Request Body:** Student registration data (name, email, password, classLevel, rollNumber, fatherName, parent contact info, etc.)

**Success:** `{ "status": "success", "data": <Student + possible parent credentials> }`

---

### 4.2 Get Student Profile (Self)

| | |
|---|---|
| **Method** | `GET` |
| **Path** | `/api/v1/students/profile` |
| **Middleware** | `isLoggedIn`, `isStudent` |
| **Controller** | `getStudentProfileController` |

**Success (200):** `{ "status": "success", "data": <Student (no password/createdAt/updatedAt)> }`  
**Error (402):** `{ "status": "failed", "message": "Student not found" }`

---

### 4.3 Get All Students (Admin)

| | |
|---|---|
| **Method** | `GET` |
| **Path** | `/api/v1/admin/students` |
| **Middleware** | `isLoggedIn`, `isAdminOrManager` |
| **Controller** | `getAllStudentsByAdminController` |

**Query Params:** `?page=1&limit=10`

**Success (200):** `{ "status": "success", "data": <paginated students> }`

---

### 4.4 Get Single Student (Admin)

| | |
|---|---|
| **Method** | `GET` |
| **Path** | `/api/v1/:studentId/admin` |
| **Middleware** | `isLoggedIn`, `isAdminOrManager` |
| **Controller** | `getStudentByAdminController` |

---

### 4.5 Student Update Own Profile

| | |
|---|---|
| **Method** | `PATCH` |
| **Path** | `/api/v1/students/update` |
| **Middleware** | `isLoggedIn`, `isStudent` |
| **Controller** | `studentUpdateProfileController` |

---

### 4.6 Admin Update Student

| | |
|---|---|
| **Method** | `PATCH` |
| **Path** | `/api/v1/:studentId/update/admin` |
| **Middleware** | `isLoggedIn`, `isAdminOrManager` |
| **Controller** | `adminUpdateStudentController` |

---

### 4.7 Admin Delete Student

| | |
|---|---|
| **Method** | `DELETE` |
| **Path** | `/api/v1/:studentId/delete/admin` |
| **Middleware** | `isLoggedIn`, `isAdminOrManager` |
| **Controller** | `adminDeleteStudentController` |

---

### 4.8 Student Analysis (Attendance + Marks + Fees)

| | |
|---|---|
| **Method** | `GET` |
| **Path** | `/api/v1/students/:studentId/analysis` |
| **Middleware** | `isLoggedIn` + dynamic role check |
| **Controller** | `getStudentAnalysisController` |

**Access logic**: If `req.userAuth.id === req.params.studentId` → allowed (self). Otherwise requires `isAdminOrManager`.

**Also available as:** `GET /api/v1/students/my-analysis` (middleware: `isLoggedIn`, `isStudent` — auto-sets studentId to self)

---

### 4.9 Student Photo Upload

| | |
|---|---|
| **Method** | `POST` |
| **Path** | `/api/v1/students/:studentId/photo` |
| **Middleware** | `isLoggedIn`, `isAdminOrManager` |
| **Controller** | `setStudentPhotoController` |
| **Body** | `multipart/form-data` with field `photo` (image, max 8MB) |

---

### 4.10 Update Linked Parent / Add Parent to Student

| Method | Path | Middleware |
|--------|------|------------|
| `POST` | `/api/v1/students/:studentId/update-parent` | `isLoggedIn`, `isAdminOrManager` |
| `POST` | `/api/v1/students/:studentId/add-parent` | `isLoggedIn`, `isAdminOrManager` |

---

### 4.11 Bulk Import — Parse Excel

| | |
|---|---|
| **Method** | `POST` |
| **Path** | `/api/v1/students/import/parse` |
| **Middleware** | `isLoggedIn`, `isAdminOrManager` |
| **Body** | `multipart/form-data` with field `file` (Excel) |
| **Controller** | `parseStudentExcelController` |

---

### 4.12 Bulk Import — Confirm & Create

| | |
|---|---|
| **Method** | `POST` |
| **Path** | `/api/v1/students/import/confirm` |
| **Middleware** | `isLoggedIn`, `isAdminOrManager` |
| **Controller** | `bulkCreateStudentsFromImportController` |

**Request Body:**
```json
{ "students": [<reviewed row objects>] }
```

---

### 4.13 Export Students to Excel

| | |
|---|---|
| **Method** | `GET` |
| **Path** | `/api/v1/students/export` |
| **Middleware** | `isLoggedIn`, `isAdminOrManager` |
| **Controller** | `exportStudentsController` |

---

## 5. Attendance

### 5.1 Mark Class Attendance

| | |
|---|---|
| **Method** | `POST` |
| **Path** | `/api/v1/attendance` |
| **Middleware** | `isLoggedIn`, `isAttendanceManager` |
| **Controller** | `markClassAttendanceController` |

**Request Body:**
```json
{
  "classLevel": "ObjectId",
  "date": "YYYY-MM-DD",
  "records": [{ "student": "ObjectId", "status": "present|absent|late" }]
}
```

---

### 5.2 Get Class Roster for Date

| | |
|---|---|
| **Method** | `GET` |
| **Path** | `/api/v1/attendance/roster/:classLevelId` |
| **Middleware** | `isLoggedIn`, `isAttendanceManager` |
| **Controller** | `getClassRosterForDateController` |

**Query Params:** `?date=YYYY-MM-DD`

---

### 5.3 Get Class Attendance

| | |
|---|---|
| **Method** | `GET` |
| **Path** | `/api/v1/attendance/class/:classLevelId` |
| **Middleware** | `isLoggedIn`, `isAttendanceManager` |
| **Controller** | `getClassAttendanceController` |

---

### 5.4 Monthly Rollup (Per-Class)

| | |
|---|---|
| **Method** | `GET` |
| **Path** | `/api/v1/attendance/rollup` |
| **Middleware** | `isLoggedIn`, `isAdminOrManager` |
| **Controller** | `getMonthlyRollupController` |

**Query Params:** `?startDate=YYYY-MM-DD&endDate=YYYY-MM-DD`

---

### 5.5 Daily Rollup

| | |
|---|---|
| **Method** | `GET` |
| **Path** | `/api/v1/attendance/daily-rollup` |
| **Middleware** | `isLoggedIn`, `isAdminOrManager` |
| **Controller** | `getDailyRollupController` |

**Query Params:** `?startDate=YYYY-MM-DD&endDate=YYYY-MM-DD&classLevel=ObjectId?`

---

### 5.6 Student Attendance History

| | |
|---|---|
| **Method** | `GET` |
| **Path** | `/api/v1/attendance/student-history` |
| **Middleware** | `isLoggedIn`, `isAdminOrManager` |
| **Controller** | `getStudentAttendanceHistoryController` |

**Query Params:** `?startDate=&endDate=&classLevel=&rollNumber=&name=&sortBy=&studentId=`

---

### 5.7 Teacher Attendance View (Assignment-Gated)

| | |
|---|---|
| **Method** | `GET` |
| **Path** | `/api/v1/attendance/teacher-view` |
| **Middleware** | `isLoggedIn`, `isTeacher` |
| **Controller** | `getTeacherAttendanceController` |

**Query Params:** `?startDate=&endDate=&scope=myClasses|specificClass|specificStudent&classLevel=&sortBy=&studentId=`

---

## 6. Tests & Test Sessions

### 6.1 Test Sessions (Admin/Manager)

| Method | Path | Middleware | Controller |
|--------|------|------------|------------|
| `POST` | `/api/v1/test-sessions` | `isLoggedIn`, `isAdminOrManager` | `createTestSessionController` |
| `GET` | `/api/v1/test-sessions` | `isLoggedIn`, `isAdminOrManager` | `getAllTestSessionsController` |
| `GET` | `/api/v1/test-sessions/:sessionId` | `isLoggedIn`, `isAdminOrManager` | `getTestSessionByIdController` |
| `DELETE` | `/api/v1/test-sessions/:sessionId` | `isLoggedIn`, `isAdminOrManager` | `deleteTestSessionController` |
| `DELETE` | `/api/v1/test-sessions/:sessionId/phases/:phaseId` | `isLoggedIn`, `isAdminOrManager` | `deletePhaseController` |
| `GET` | `/api/v1/test-sessions/:sessionId/report/:studentId` | `isLoggedIn`, `isAdminOrManager` | `getSessionReportCardController` |

---

### 6.2 Weeks (Session-Scoped)

| Method | Path | Middleware | Controller |
|--------|------|------------|------------|
| `GET` | `/api/v1/sessions/:sessionId/weeks` | `isLoggedIn`, `isAdminOrManager` | `getWeeksForSessionController` |
| `POST` | `/api/v1/sessions/:sessionId/weeks` | `isLoggedIn`, `isAdminOrManager` | `createWeekController` |
| `GET` | `/api/v1/sessions/:sessionId/weeks/:phaseId` | `isLoggedIn`, `isAdminOrManager` | `getWeeksForPhaseController` |
| `GET` | `/api/v1/weeks/:weekId` | `isLoggedIn` (any role) | `getWeekByIdController` |
| `PATCH` | `/api/v1/weeks/:weekId` | `isLoggedIn`, `isAdminOrManager` | `updateWeekController` |
| `DELETE` | `/api/v1/weeks/:weekId` | `isLoggedIn`, `isAdminOrManager` | `deleteWeekController` |

---

### 6.3 Tests

| Method | Path | Middleware | Controller |
|--------|------|------------|------------|
| `POST` | `/api/v1/tests` | `isLoggedIn`, `isAdminOrManager` | `createTestController` |
| `GET` | `/api/v1/tests` | `isLoggedIn`, `isAdminOrTeacher` (inline) | `getTestsByRoleController` |
| `DELETE` | `/api/v1/tests/:testId` | `isLoggedIn`, `isAdminOrManager` | `deleteTestController` |

**GET /tests**: Admin sees all; teacher sees only their assigned subjects/classes.

---

### 6.4 Test Marking (Teacher Assignment-Gated)

| Method | Path | Middleware | Controller |
|--------|------|------------|------------|
| `GET` | `/api/v1/tests/:testId/roster` | `isLoggedIn`, `isTeacherAssignedOrManager` (inline) | `getTestRosterController` |
| `POST` | `/api/v1/tests/:testId/results` | `isLoggedIn`, `isTeacherAssignedOrManager` (inline) | `submitTestResultsController` |
| `GET` | `/api/v1/tests/:testId/result-sheet` | `isLoggedIn`, `isAdminOrManager` | `getTestResultSheetController` |

**`isTeacherAssignedOrManager`** (inline in test.router.js): Manager bypasses assignment check; regular teachers go through `isAssignedToSubject`.

**POST body for results:**
```json
{ "records": [{ "student": "ObjectId", "score": number, ... }] }
```

---

### 6.5 Test Analytics

| Method | Path | Middleware | Controller |
|--------|------|------------|------------|
| `GET` | `/api/v1/tests/analytics` | `isLoggedIn`, `isAdminOrManager` | `getTestAnalyticsController` |
| `GET` | `/api/v1/tests/analytics/enhanced` | `isLoggedIn`, `isAdminOrManager` | `getEnhancedTestAnalyticsController` |
| `GET` | `/api/v1/tests/analytics/trend` | `isLoggedIn`, `isAdminOrManager` | `getTestTrendController` |
| `GET` | `/api/v1/tests/teacher-analytics` | `isLoggedIn`, `isTeacher` | `getTeacherAnalyticsController` |

**Query Params (analytics):** varies by endpoint — typically `?testId=&sessionId=&fromDate=&toDate=&classLevel=&subject=`

**Query Params (teacher-analytics):** `?classLevel=&subject=&testId=&sessionId=&fromDate=&toDate=`

---

### 6.6 Teacher Cascade API

| Method | Path | Middleware | Controller |
|--------|------|------------|------------|
| `GET` | `/api/v1/tests/cascade/classes` | `isLoggedIn`, `isTeacher` | `getTeacherAssignedClassesController` |
| `GET` | `/api/v1/tests/cascade/subjects` | `isLoggedIn`, `isTeacher` | `getTeacherAssignedSubjectsController` |
| `GET` | `/api/v1/tests/cascade/sessions` | `isLoggedIn`, `isTeacher` | `getTeacherCascadeSessionsController` |
| `GET` | `/api/v1/tests/cascade/phases` | `isLoggedIn`, `isTeacher` | `getTeacherCascadePhasesController` |
| `GET` | `/api/v1/tests/cascade/weeks` | `isLoggedIn`, `isTeacher` | `getTeacherCascadeWeeksController` |
| `GET` | `/api/v1/tests/cascade/tests` | `isLoggedIn`, `isTeacher` | `getTeacherScopedTestsByClassSubjectController` |

**Query Params:** `?classLevel=ObjectId&subject=ObjectId&session=ObjectId&phase=ObjectId&week=ObjectId` (as applicable per level)

---

## 7. Marks (Legacy Exam System)

| Method | Path | Middleware | Controller |
|--------|------|------------|------------|
| `POST` | `/api/v1/marks` | `isLoggedIn`, `isTeacher`, `isAssignedToSubject` | `createMarkController` |
| `POST` | `/api/v1/marks/bulk` | `isLoggedIn`, `isTeacher`, `isAssignedToSubject` | `bulkCreateMarksController` |
| `GET` | `/api/v1/marks/student/:studentId/term/:academicTermId` | `isLoggedIn`, `isTeacher` | `getStudentTermReportController` |
| `POST` | `/api/v1/marks/ocr/extract` | `isLoggedIn`, `isTeacher` | `extractMarksFromImageController` |

**POST /marks body:** Mark data with exam reference  
**POST /marks/bulk body:** `{ "marks": [<mark objects>] }`  
**POST /marks/ocr/extract:** `multipart/form-data` with `image` field

---

## 8. Question Bank

| Method | Path | Middleware | Controller |
|--------|------|------------|------------|
| `GET` | `/api/v1/question` | `isLoggedIn`, `isTeacher` | `getAllQuestionsController` |
| `POST` | `/api/v1/questions/:examId/create` | `isLoggedIn`, `isTeacher`, `isAssignedToQuestionExam` | `createQuestionsController` |
| `GET` | `/api/v1/question/:questionId` | `isLoggedIn`, `isTeacher`, `isAssignedToQuestionExam` | `getQuestionByIdController` |
| `PATCH` | `/api/v1/question/:questionId` | `isLoggedIn`, `isTeacher`, `isAssignedToQuestionExam` | `updateQuestionController` |

---

## 9. Class Levels

| Method | Path | Middleware | Controller |
|--------|------|------------|------------|
| `GET` | `/api/v1/class-levels` | `isLoggedIn` | `getClassLevelsController` |
| `POST` | `/api/v1/class-levels` | `isLoggedIn`, `isAdminOrManager` | `createClassLevelController` |
| `GET` | `/api/v1/class-levels/:classLevelId` | `isLoggedIn` | `getClassLevelController` |
| `PATCH` | `/api/v1/class-levels/:classLevelId` | `isLoggedIn`, `isAdminOrManager` | `updateClassLevelController` |
| `DELETE` | `/api/v1/class-levels/:classLevelId` | `isLoggedIn`, `isAdminOrManager` | `deleteClassLevelController` |

---

## 10. Sections

| Method | Path | Middleware | Controller |
|--------|------|------------|------------|
| `GET` | `/api/v1/sections` | `isLoggedIn`, `isAdminOrManager` | `getSectionsController` |
| `POST` | `/api/v1/sections` | `isLoggedIn`, `isAdminOrManager` | `createSectionController` |
| `GET` | `/api/v1/sections/:sectionId` | `isLoggedIn`, `isAdminOrManager` | `getSectionController` |
| `PATCH` | `/api/v1/sections/:sectionId` | `isLoggedIn`, `isAdminOrManager` | `updateSectionController` |
| `DELETE` | `/api/v1/sections/:sectionId` | `isLoggedIn`, `isAdminOrManager` | `deleteSectionController` |
| `PATCH` | `/api/v1/sections/:sectionId/toggle-active` | `isLoggedIn`, `isAdminOrManager` | `toggleSectionActiveController` |

---

## 11. Programs

| Method | Path | Middleware | Controller |
|--------|------|------------|------------|
| `GET` | `/api/v1/programs` | `isLoggedIn`, `isAdminOrManager` | `getProgramsController` |
| `POST` | `/api/v1/programs` | `isLoggedIn`, `isAdminOrManager` | `createProgramController` |
| `GET` | `/api/v1/programs/:programId` | `isLoggedIn`, `isAdminOrManager` | `getProgramController` |
| `PATCH` | `/api/v1/programs/:programId` | `isLoggedIn`, `isAdminOrManager` | `updateProgramController` |
| `DELETE` | `/api/v1/programs/:programId` | `isLoggedIn`, `isAdminOrManager` | `deleteProgramController` |

---

## 12. Subjects

| Method | Path | Middleware | Controller |
|--------|------|------------|------------|
| `GET` | `/api/v1/subject` | `isLoggedIn`, `isAdminOrManager` | `getSubjectsController` |
| `POST` | `/api/v1/create-subject/:programId` | `isLoggedIn`, `isAdminOrManager` | `createSubjectController` |
| `GET` | `/api/v1/subject/:subjectId` | `isLoggedIn`, `isAdminOrManager` | `getSubjectController` |
| `PATCH` | `/api/v1/subject/:subjectId` | `isLoggedIn`, `isAdminOrManager` | `updateSubjectController` |
| `DELETE` | `/api/v1/subject/:subjectId` | `isLoggedIn`, `isAdminOrManager` | `deleteSubjectController` |

---

## 13. Year Groups

| Method | Path | Middleware | Controller |
|--------|------|------------|------------|
| `GET` | `/api/v1/year-group` | `isLoggedIn`, `isAdminOrManager` | `getYearGroupsController` |
| `POST` | `/api/v1/year-group` | `isLoggedIn`, `isAdminOrManager` | `createYearGroupController` |
| `GET` | `/api/v1/year-group/:yearGroupId` | `isLoggedIn`, `isAdminOrManager` | `getYearGroupController` |
| `PATCH` | `/api/v1/year-group/:yearGroupId` | `isLoggedIn`, `isAdminOrManager` | `updateYearGroupController` |
| `DELETE` | `/api/v1/year-group/:yearGroupId` | `isLoggedIn`, `isAdminOrManager` | `deleteYearGroupController` |

---

## 14. Academic Terms

| Method | Path | Middleware | Controller |
|--------|------|------------|------------|
| `GET` | `/api/v1/academic-term` | `isLoggedIn` | `getAcademicTermsController` |
| `POST` | `/api/v1/academic-term` | `isLoggedIn`, `isAdminOrManager` | `createAcademicTermController` |
| `GET` | `/api/v1/academic-term/:academicTermId` | `isLoggedIn` | `getAcademicTermController` |
| `PATCH` | `/api/v1/academic-term/:academicTermId` | `isLoggedIn`, `isAdminOrManager` | `updateAcademicTermController` |
| `DELETE` | `/api/v1/academic-term/:academicTermId` | `isLoggedIn`, `isAdminOrManager` | `deleteAcademicTermController` |

---

## 15. Academic Years

| Method | Path | Middleware | Controller |
|--------|------|------------|------------|
| `GET` | `/api/v1/academic-years` | `isLoggedIn`, `isAdminOrManager` | `getAcademicYearsController` |
| `POST` | `/api/v1/academic-years` | `isLoggedIn`, `isAdminOrManager` | `createAcademicYearController` |
| `GET` | `/api/v1/academic-years/:academicYearId` | `isLoggedIn`, `isAdminOrManager` | `getAcademicYearController` |
| `PATCH` | `/api/v1/academic-years/:academicYearId` | `isLoggedIn`, `isAdminOrManager` | `updateAcademicYearController` |
| `DELETE` | `/api/v1/academic-years/:academicYearId` | `isLoggedIn`, `isAdminOrManager` | `deleteAcademicYearController` |

---

## 16. Teacher Assignments (Subject → Class → Teacher)

| Method | Path | Middleware | Controller |
|--------|------|------------|------------|
| `POST` | `/api/v1/assignments` | `isLoggedIn`, `isAdminOrManager` | `createAssignmentController` |
| `GET` | `/api/v1/assignments` | `isLoggedIn`, `isAdminOrManager` | `getAllAssignmentsController` |
| `GET` | `/api/v1/assignments/my` | `isLoggedIn`, `isTeacher` | `getMyAssignmentsController` |
| `DELETE` | `/api/v1/assignments/:assignmentId` | `isLoggedIn`, `isAdminOrManager` | `deleteAssignmentController` |

**POST body:**
```json
{ "teacher": "ObjectId", "subject": "ObjectId", "classLevel": "ObjectId" }
// OR for batch:
{ "teacher": "ObjectId", "subject": "ObjectId", "classLevels": ["ObjectId", ...] }
```

---

## 17. Fees (Admin Only)

### 17.1 Fee Records

| Method | Path | Middleware | Controller |
|--------|------|------------|------------|
| `POST` | `/api/v1/fees` | `isLoggedIn`, `isAdmin` | `createFeeController` |
| `GET` | `/api/v1/fees` | `isLoggedIn`, `isAdmin` | `getAllFeesController` |
| `POST` | `/api/v1/fees/bulk` | `isLoggedIn`, `isAdmin` | `bulkCreateFeesController` |
| `POST` | `/api/v1/fees/bulk-assign` | `isLoggedIn`, `isAdmin` | `bulkAssignFeesController` |
| `POST` | `/api/v1/fees/generate-monthly` | `isLoggedIn`, `isAdmin` | `generateMonthlyFeesController` |
| `GET` | `/api/v1/fees/student/:studentId` | `isLoggedIn`, `isAdmin` | `getStudentFeesController` |
| `PUT` | `/api/v1/fees/:feeId` | `isLoggedIn`, `isAdmin` | `updateFeeController` |
| `DELETE` | `/api/v1/fees/:feeId` | `isLoggedIn`, `isAdmin` | `deleteFeeController` |
| `POST` | `/api/v1/fees/ocr/resolve/:feeId` | `isLoggedIn`, `isAdmin` | `resolveOcrReviewController` |
| `POST` | `/api/v1/fees/ocr/extract` | `isLoggedIn`, `isAdmin` | `extractFeesFromImageController` |

**GET /fees query:** `?page=&limit=&student=&academicTerm=&academicYear=&feeHead=&status=` (filters)  
**POST /fees/bulk body:** `{ "fees": [<fee objects>] }`  
**POST /fees/ocr/extract:** `multipart/form-data` with `image` field

### 17.2 Fee Heads

| Method | Path | Middleware | Controller |
|--------|------|------------|------------|
| `GET` | `/api/v1/fee-heads` | `isLoggedIn`, `isAdmin` | `getAllFeeHeadsController` |
| `POST` | `/api/v1/fee-heads` | `isLoggedIn`, `isAdmin` | `createFeeHeadController` |
| `PUT` | `/api/v1/fee-heads/:feeHeadId` | `isLoggedIn`, `isAdmin` | `updateFeeHeadController` |
| `DELETE` | `/api/v1/fee-heads/:feeHeadId` | `isLoggedIn`, `isAdmin` | `deleteFeeHeadController` |

### 17.3 Reports

| Method | Path | Middleware | Controller |
|--------|------|------------|------------|
| `GET` | `/api/v1/fees/collection/report` | `isLoggedIn`, `isAdmin` | `getDailyCollectionController` |
| `GET` | `/api/v1/fees/defaulters` | `isLoggedIn`, `isAdmin` | `getDefaulterListController` |

---

## 18. Parents

### 18.1 Parent Self-Service

| Method | Path | Middleware | Controller |
|--------|------|------------|------------|
| `GET` | `/api/v1/parents/profile` | `isLoggedIn`, `isParent` | `getParentProfileController` |
| `POST` | `/api/v1/parents/change-password` | `isLoggedIn`, `isParent` | `changeParentPasswordController` |
| `GET` | `/api/v1/parents/children/:childId/analysis` | `isLoggedIn`, `isParent` | `getChildrenAnalysisController` |
| `GET` | `/api/v1/parents/children/:childId/fees` | `isLoggedIn`, `isParent` | `getChildrenFeesController` |

**POST /parents/change-password body:**
```json
{ "currentPassword": "string", "newPassword": "string", "confirmPassword": "string" }
```

### 18.2 Admin Parent Management

| Method | Path | Middleware | Controller |
|--------|------|------------|------------|
| `GET` | `/api/v1/admin/parents` | `isLoggedIn`, `isAdminOrManager` | `getAllParentsController` |
| `POST` | `/api/v1/admin/parents` | `isLoggedIn`, `isAdminOrManager` | `createParentController` |
| `POST` | `/api/v1/admin/parents/:parentId/children/:childId` | `isLoggedIn`, `isAdminOrManager` | `addChildToParentController` |
| `POST` | `/api/v1/admin/students/:studentId/reset-parent-password` | `isLoggedIn`, `isAdminOrManager` | `adminResetParentPasswordController` |

**POST /admin/parents body:**
```json
{ "name": "string", "email": "string", "password": "string?", "phone": "string", "relationship": "string?", "children": ["ObjectId"]? }
```

**POST /admin/students/:studentId/reset-parent-password body:**
```json
{ "password": "string?" }
```
If no password provided, a random one is generated. Response includes the plain-text password (shown once).

**Success (200):**
```json
{ "status": "success", "data": { "parentName": "string", "parentEmail": "string", "password": "plain-text-password" } }
```

---

## 19. PDF Reports

| Method | Path | Middleware | Controller |
|--------|------|------------|------------|
| `POST` | `/api/v1/pdf-reports/result-sheet` | `isLoggedIn`, `isAdminOrTeacher` | `generateResultSheet` |
| `POST` | `/api/v1/pdf-reports/analytics` | `isLoggedIn`, `isAdminOrTeacher` | `generateAnalytics` |
| `POST` | `/api/v1/pdf-reports/session-report` | `isLoggedIn`, `isAdminOrTeacher` | `generateSessionReport` |
| `GET` | `/api/v1/pdf-reports/:uuid` | `isLoggedIn`, `isAdminOrTeacher` | `servePdf` |

**POST /pdf-reports/result-sheet body:** `{ "testId": "ObjectId" }`  
**POST /pdf-reports/analytics body:** `{ "studentId": "ObjectId?", "subjectId": "ObjectId?", "fromDate": "string?", "toDate": "string?" }`  
**POST /pdf-reports/session-report body:** `{ "sessionId": "ObjectId", "studentId": "ObjectId" }`

**Success (200):**
```json
{ "status": "success", "data": { "pdfUrl": "/reports/pdf/<uuid>", "singleStudent": boolean, "reportType": "string" } }
```

**GET /pdf-reports/:uuid** — Returns raw PDF binary (`Content-Type: application/pdf`)

---

## Middleware Reference

| Middleware | File | Purpose | Reads |
|-----------|------|---------|-------|
| `isLoggedIn` | `middlewares/isLoggedIn.js` | Verifies JWT from Bearer header | `Authorization: Bearer <token>` → `req.userAuth = { id }` |
| `isAdmin` | `middlewares/isAdmin.js` | Checks Admin model for `role === "admin"` | `req.userAuth.id` |
| `isTeacher` | `middlewares/isTeacher.js` | Checks Teacher model for `role === "teacher"` | `req.userAuth.id` |
| `isStudent` | `middlewares/isStudent.js` | Checks Student model for `role === "student"` | `req.userAuth.id` |
| `isParent` | `middlewares/isParent.js` | Checks Parent model for `role === "parent"` | `req.userAuth.id` |
| `isAdminOrManager` | `middlewares/isAdminOrManager.js` | Admin OR teacher with `isAttendanceManager` | `req.userAuth.id` |
| `isAdminOrTeacher` | `middlewares/isAdminOrTeacher.js` | Admin OR any teacher (for PDF routes) | `req.userAuth.id` |
| `isAttendanceManager` | `middlewares/isAttendanceManager.js` | Teacher with `isAttendanceManager === true` | `req.userAuth.id` |
| `isAssignedToSubject` | `middlewares/isAssignedToSubject.js` | Teacher assigned to test's subject+class | `req.userAuth.id` + `req.params.testId` / `req.body` |
| `isAssignedToQuestionExam` | `middlewares/isAssignedToQuestionExam.js` | Teacher assigned to question's exam subject+class | `req.userAuth.id` + `req.params.examId` / `req.params.questionId` |
| `authView` | `middlewares/authView.js` | Cookie-based auth for SSR views | `req.cookies.session` → `req.user`, `req.token` |
| `requireRole(...)` | `middlewares/authView.js` | Role gate for view routes | `req.user.role` |
| `requireAdminOrManager()` | `middlewares/authView.js` | Admin or manager gate for view routes | `req.user.role` + `req.user.isManager` |

---

## How `req.token` Gets Populated for SSR View Routes

### Full Trace

```
Browser → GET /attendance/rollup
  │
  ├─ cookie-parser → req.cookies.session = JSON string
  │
  ├─ authView middleware (middlewares/authView.js)
  │   ├─ Parse: session = JSON.parse(req.cookies.session)
  │   ├─ Verify: verified = verifyToken(session.token)
  │   ├─ Set: req.user = session.user
  │   ├─ Set: req.token = session.token     ← THIS is the JWT
  │   └─ Set: res.locals.authToken = req.token
  │
  ├─ attendanceRollup.views.js route handler
  │   ├─ Calls: apiFetch("/attendance/daily-rollup?...", req.token)
  │   │
  │   └─ apiFetch (utils/apiClient.js)
  │       ├─ URL: INTERNAL_API_URL or http://localhost:PORT/api/v1
  │       ├─ Headers: { Authorization: `Bearer ${token}`, Content-Type: application/json }
  │       └─ Makes HTTP request to the API route (same server, internal loopback)
  │
  └─ The API route's isLoggedIn middleware sees the Bearer token
      and authenticates the request normally.
```

### Where does the cookie's token come from?

The `POST /login` handler in `routes/views/auth.views.js`:
1. Calls the API login endpoint internally via `fetch()` (e.g., `/api/v1/admin/login`)
2. Gets back `{ status: "success", data: { user, token } }`
3. Sets `res.cookie("session", JSON.stringify({ token, user }), cookieOptions)`
4. The cookie is `httpOnly: true`, `sameSite: "lax"`, `secure` in production, `maxAge: 24h`

**The token in the cookie IS the same JWT returned by the API login.** It's the exact same token — just stored in a cookie for browser use instead of (or in addition to) being held by the client.

---

## Complete Endpoint Count Summary

| Resource | Endpoints |
|----------|-----------|
| Auth/Login | 4 |
| Admin Staff | 10 |
| Teachers | 9 |
| Students | 13 |
| Attendance | 7 |
| Tests & Sessions | 20 |
| Marks (Legacy) | 4 |
| Question Bank | 4 |
| Class Levels | 5 |
| Sections | 6 |
| Programs | 5 |
| Subjects | 5 |
| Year Groups | 5 |
| Academic Terms | 5 |
| Academic Years | 5 |
| Assignments | 4 |
| Fees | 14 |
| Parents | 8 |
| PDF Reports | 4 |
| **Total** | **~137** |
