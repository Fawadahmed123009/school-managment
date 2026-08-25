const path = require("path");
const express = require("express");
const morgan = require("morgan");
const cookieParser = require("cookie-parser");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const mongoSanitize = require("express-mongo-sanitize");
const cors = require("cors");
const routeSync = require("../handlers/routeSync.handler");
const { authView } = require("../middlewares/authView");
const errorHandler = require("../middlewares/errorHandler");
const logger = require("../config/logger");

const app = express();

// ── Trust proxy (needed for rate-limit behind reverse proxy) ──
app.set("trust proxy", 1);

// ── Security headers ──────────────────────────────────────────
app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", "https://fonts.googleapis.com", "https://cdn.jsdelivr.net", "'unsafe-inline'"],
        styleSrc: ["'self'", "https://fonts.googleapis.com", "'unsafe-inline'"],
        imgSrc: ["'self'", "data:", "blob:"],
        fontSrc: ["'self'", "https://fonts.gstatic.com"],
        connectSrc: ["'self'"],
        frameSrc: ["'none'"],
        objectSrc: ["'none'"],
      },
    },
    crossOriginEmbedderPolicy: false,
  })
);

// ── CORS — restrict API access to same-origin + localhost dev ─
// APP_URL should be set in production (e.g. https://your-app.onrender.com).
// Comma-separate multiple values in EXTRA_ALLOWED_ORIGINS if needed (e.g. a
// custom domain alongside the platform-assigned one).
const allowedOrigins = [
  "http://localhost:5130",
  "http://127.0.0.1:5130",
  process.env.APP_URL,
  ...(process.env.EXTRA_ALLOWED_ORIGINS ? process.env.EXTRA_ALLOWED_ORIGINS.split(",").map((o) => o.trim()) : []),
].filter(Boolean);
const corsMiddleware = cors({
  origin: function (origin, callback) {
    // Allow requests with no origin (server-side, curl, mobile apps)
    if (!origin) return callback(null, true);
    if (allowedOrigins.includes(origin)) return callback(null, true);
    callback(new Error("Not allowed by CORS"));
  },
  credentials: true,
});
// Apply CORS only to API routes, not to browser form submissions
app.use("/api", corsMiddleware);

// ── Rate limiting (global) ────────────────────────────────────
const globalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 300,                  // limit each IP to 300 requests per window
  standardHeaders: true,
  legacyHeaders: false,
  message: { status: "failed", message: "Too many requests, please try again later." },
});
app.use(globalLimiter);

// ── Stricter rate limit on login routes ───────────────────────
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 20,                   // 20 login attempts per window
  standardHeaders: true,
  legacyHeaders: false,
  message: { status: "failed", message: "Too many login attempts, please try again after 15 minutes." },
});

// ── Body parsing ──────────────────────────────────────────────
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true, limit: "1mb" }));

// ── Cookie parser ─────────────────────────────────────────────
app.use(cookieParser());

// ── NoSQL injection protection ────────────────────────────────
app.use(mongoSanitize());

// ── Request logging ───────────────────────────────────────────
app.use(morgan("dev"));

// ---------- JSON API (rate-limited for login endpoints) -------
// Apply login rate limit to auth API routes before general route loading
const authApiRoutes = [
  "/api/v1/admin/login",
  "/api/v1/teacher/login",
  "/api/v1/students/login",
  "/api/v1/parents/login",
];
app.use(authApiRoutes, loginLimiter);

routeSync(app, "staff");
routeSync(app, "academic");
routeSync(app, "students");
routeSync(app, "fees");
routeSync(app, "parents");

// ---------- Server-rendered portal ───────────────────────────
const { publicRouter: pdfPublicRouter, generateRouter: pdfGenerateRouter } = require("../routes/views/pdfReport.views");

app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "../views"));
app.use(express.static(path.join(__dirname, "../public")));
// Serve uploaded files only to authenticated users (session cookie check)
app.use("/uploads", (req, res, next) => {
  const raw = req.cookies && req.cookies.session;
  if (!raw) return res.status(401).send("Unauthorized");
  try {
    const session = JSON.parse(raw);
    const verifyToken = require("../utils/verifyToken");
    if (!verifyToken(session.token)) return res.status(401).send("Unauthorized");
    next();
  } catch {
    return res.status(401).send("Unauthorized");
  }
}, express.static(path.join(__dirname, "../uploads")));

app.use((req, res, next) => {
  res.locals.schoolName = process.env.SCHOOL_NAME || "School Portal";
  next();
});

app.use(require("../routes/views/landing.views"));
app.use(require("../routes/views/auth.views"));
// PDF serving (public, UUID-gated) — must be before authView
app.use(pdfPublicRouter);
app.use(authView);
app.use(require("../routes/views/dashboard.views"));
app.use(require("../routes/views/students.views"));
app.use(require("../routes/views/studentImport.views"));
app.use(require("../routes/views/studentAnalysis.views"));
app.use(require("../routes/views/studentPhoto.views"));
app.use(require("../routes/views/staff.views"));
app.use(require("../routes/views/fees.views"));
app.use(require("../routes/views/feeHeads.views"));
app.use(require("../routes/views/feesOcr.views"));
app.use(require("../routes/views/marks.views"));
app.use(require("../routes/views/marksOcr.views"));
app.use(require("../routes/views/assignments.views"));
app.use(require("../routes/views/classAdmin.views"));
app.use(require("../routes/views/testAdmin.views"));
app.use(require("../routes/views/testTeacher.views"));
app.use(require("../routes/views/testResultSheet.views"));
app.use(require("../routes/views/testAnalytics.views"));
app.use(require("../routes/views/sessionReport.views"));
app.use(pdfGenerateRouter);
app.use(require("../routes/views/attendance.views"));
app.use(require("../routes/views/attendanceRollup.views"));
app.use(require("../routes/views/parentPortal.views"));

// ── 404 handler ──────────────────────────────────────────────
app.use((req, res) => {
  if (req.path.startsWith("/api")) {
    return res.status(404).json({ status: "failed", message: `Route not found: ${req.originalUrl}` });
  }
  res.status(404).render("error", {
    title: "404 — Page not found",
    message: `The page "${req.originalUrl}" does not exist.`,
    schoolName: res.locals.schoolName || process.env.SCHOOL_NAME || "School Portal",
  });
});

// ── Global error handler (must be last) ──────────────────────
app.use(errorHandler);

module.exports = app;
