const mongoose = require("mongoose");
require("dotenv").config();
require("colors");

// ── A-1 — connection pool configuration ─────────────────────────────────────
// Until now connect() passed NO pool options. The measured effect of that — not
// what the docs say, but what the live pool objects report
// (tmp/_verify_a1_pool.js) — is that mongoose 7.8.11 supplies no maxPoolSize of
// its own, so the DRIVER defaults applied: maxPoolSize 100 PER REPLICA-SET
// MEMBER, minPoolSize 0, and — the one that actually hurt — waitQueueTimeoutMS
// 0, which means UNBOUNDED.
//
// The unbounded queue is the bug. Overflow requests did not fail, they queued,
// and a request that could no longer succeed kept its socket open until the
// proxy gave up. The client got no status, no error and no record: the "silent
// timeout under load" class (A-1 and A-4 are the same bug seen from the server
// and from the browser).
//
// The 100-per-member part matters more than it looks. This replica set has 3
// members, so one Node process could in principle open 300 of the cluster's 500
// connections by itself — 60% of the ceiling consumed by an app whose real
// demand is far smaller, leaving little for backup scripts and ad-hoc tooling.
//
// These values are measured, not guessed. Evidence: tmp/_probe_atlas_limits.js,
// tmp/_probe_traffic_a1.js, tmp/_probe_pool_size_sweep.js, tmp/_verify_a1_pool.js.
//
//   • Cluster ceiling: 500 connections (serverStatus: 15 in use + 485 available)
//     on a 3-member replica set, MongoDB 8.0.37, single Node process.
//   • maxPoolSize is PER replica-set member, not per client — verified by
//     reading the live pool objects (all 3 members report the configured value).
//   • Measured latency of the endpoints the report calls slow, p50 / p95:
//       admin overview      104 / 122 ms      audit log viewer  411 / 431 ms
//       teacher attendance  259 / 563 ms      rollup (month)    482 / 540 ms
//       finance yearly     1077 / 1098 ms     rollup (year)     465 / 480 ms
//       finance monthly    1436 / 1601 ms     dashboard        1439 / 2030 ms
//       finance daily       317 / 2292 ms  (the tail is one cold connection)
//   • THE SWEEP THAT SETTLED maxPoolSize — the same real workload (a sorted
//     400-document attendance read) fired at 40-way concurrency, three pool sizes:
//         maxPoolSize 10  ->  1390 ms, 40/40 ok, 0 rejections
//         maxPoolSize 25  ->  1429 ms, 40/40 ok, 0 rejections
//         maxPoolSize 100 ->  1397 ms, 40/40 ok, 0 rejections
//     Indistinguishable. Throughput here is bound by Atlas round-trip latency and
//     server-side execution, NOT by pool size, so a big pool buys no speed — it
//     only spends connection budget. Raising maxPoolSize was never the fix;
//     bounding the wait queue was.
//
// maxPoolSize 25 — measured healthy at 40-way concurrency (10 was enough), so
//   25 is ~2.5x the demonstrated requirement, and 3 members x 25 = 75 worst-case
//   = 15% of the cluster ceiling instead of 60%. Deliberately modest: on a
//   shared-tier instance extra concurrent connections mostly move contention
//   into the database rather than relieving it, and a smaller pool makes
//   overload visible sooner instead of silently absorbing it.
//
// minPoolSize 5 — keeps five connections per member warm. The justification is
//   the 2292 ms cold tail above: a single Atlas TLS + SRV + auth handshake was
//   measured at 838 ms, and that cost is paid by the first request after an idle
//   gap. This app is quiet overnight and spikes when school starts, so without
//   warm connections every morning burst pays a handshake on the public path.
//   5 x 3 members = 15 warm connections, ~3% of the ceiling. Atlas may still
//   reap idle sockets, so this is warmth, not a guarantee.
//
// waitQueueTimeoutMS 5000 — the actual fix. Bounded from both directions:
//   lower bound: must exceed a full connection handshake (measured 838 ms). A
//     300 ms value was tried and made mongoose.connect() itself fail with
//     MongoWaitQueueTimeoutError, so "fail fast" cannot mean "fail immediately".
//   upper bound: worst legitimate queue wait measured was ~2.2 s end-to-end for
//     a 465 ms page, so 5 s is >2x real headroom and an ordinary spike never
//     trips it; and 5 s stays well inside a typical 30-60 s cPanel/Apache proxy
//     timeout, so the app — not the proxy — decides the outcome. That is what
//     lets errorHandler answer 503 with something the UI can show instead of the
//     request dying silently at the proxy.
//
// Not set here, on purpose: socketTimeoutMS (default 360 s) and
// serverSelectionTimeoutMS (default 30 s). Lowering socketTimeoutMS would kill
// legitimately long aggregates and the 60 s maxCommitTimeMS in
// services/fees/fees.service.js#withTransaction; lowering
// serverSelectionTimeoutMS would shorten the window in which a normal Atlas
// failover can be ridden out during boot. Both are separate risk decisions from
// A-1 and are left for a round that can measure them.
const POOL_OPTIONS = {
  maxPoolSize: 25,
  minPoolSize: 5,
  waitQueueTimeoutMS: 5000,
};

const dbConnect = async () => {
  if (!process.env.DB) {
    console.error("FATAL: DB environment variable is not set. Cannot connect to MongoDB.".red.bold);
    process.exit(1);
  }

  try {
    await mongoose.connect(process.env.DB, POOL_OPTIONS);
    console.log("Database connected! ".yellow.bold);
    // Echo the effective pool so a deploy can confirm A-1 actually took effect
    // (this is the value ops would otherwise have to introspect by hand).
    console.log(
      `MongoDB pool: maxPoolSize=${POOL_OPTIONS.maxPoolSize} per member ` +
        `(minPoolSize=${POOL_OPTIONS.minPoolSize}, waitQueueTimeoutMS=${POOL_OPTIONS.waitQueueTimeoutMS})`.grey
    );
  } catch (err) {
    console.error(`Failed to connect database: ${err}`.red.bold);
  }
};

// Log connection drops / errors after initial connect (Atlas free tier
// can close idle connections — Mongoose auto-reconnects, but logging
// helps diagnose transient issues).
mongoose.connection.on("error", (err) => {
  console.error(`MongoDB connection error: ${err}`.red.bold);
});

mongoose.connection.on("disconnected", () => {
  console.warn("MongoDB disconnected — Mongoose will attempt to reconnect automatically.".yellow.bold);
});

dbConnect();
