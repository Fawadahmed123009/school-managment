// One-off bootstrap: create the first admin account on a LOCAL database.
//
// Deliberately awkward to use against anything but localhost, because this is
// the only credential-writing script that is versioned and tracked:
//   • the password is never hardcoded — it comes from ADMIN_PASSWORD or is
//     prompted twice with masked input;
//   • it hard-stops unless the DB from .env resolves to localhost/127.0.0.1.
//     Production (Atlas) admin credentials are rotated by hand, not by script.
//
// Usage:
//   node scripts/createFirstAdmin.js
//   ADMIN_EMAIL=some.addr@example.com ADMIN_PASSWORD='...' node scripts/createFirstAdmin.js

const readline = require("readline");
require("dotenv").config();
const mongoose = require("mongoose");
const { hashPassword, validatePassword } = require("../handlers/passHash.handler");

const DEFAULT_EMAIL = "admin@local.test"; // fine on a throwaway local DB only

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "0.0.0.0", "::1"]);

// Refuse to touch anything that is not the local machine. Checked on the
// connection string itself, so an unreachable host still fails closed.
function assertLocalDatabase(uri) {
  let hosts;
  try {
    hosts = new URL(uri).hostname;
  } catch {
    // mongodb+srv:// and other non-standard forms are parsed by hand.
    hosts = uri.replace(/^mongodb(\+srv)?:\/\//, "").split("@").pop().split(/[/?]/)[0];
  }
  const isLocal = hosts
    .split(",")
    .map((h) => h.trim().split(":")[0])
    .every((h) => LOCAL_HOSTS.has(h));

  if (!isLocal) {
    console.error(
      `\nREFUSED: this bootstrap only supports a local database.\n` +
        `  Connected target host(s): ${hosts}\n` +
        `  Admin credentials for a shared/production database are rotated by\n` +
        `  hand — see the password policy in handlers/passHash.handler.js.\n`
    );
    process.exit(1);
  }
}

// Masked single-line prompt (no echo, backspace supported).
function promptHidden(question) {
  return new Promise((resolve, reject) => {
    if (!process.stdin.isTTY) {
      reject(new Error("No TTY for interactive input — set ADMIN_PASSWORD instead."));
      return;
    }
    process.stdout.write(question);
    let value = "";
    process.stdin.setRawMode(true);
    process.stdin.resume();
    const onData = (chunk) => {
      const key = chunk.toString();
      if (key === "\r" || key === "\n" || key === "\u0004") {
        process.stdin.setRawMode(false);
        process.stdin.pause();
        process.stdin.removeListener("data", onData);
        process.stdout.write("\n");
        resolve(value);
      } else if (key === "\u0003") {
        process.stdin.setRawMode(false);
        process.stdout.write("\nAborted.\n");
        process.exit(130);
      } else if (key === "\u007f" || key === "\b") {
        value = value.slice(0, -1);
      } else {
        value += key;
      }
    };
    process.stdin.on("data", onData);
  });
}

async function readPassword() {
  if (process.env.ADMIN_PASSWORD) return process.env.ADMIN_PASSWORD;

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const name = await new Promise((res) => rl.question("Admin name [Admin]: ", res));
  const emailAnswer = await new Promise((res) => rl.question("Admin email: ", res));
  rl.close();

  const password = await promptHidden("Admin password (min 6 chars, letter + number; input hidden): ");
  const repeat = await promptHidden("Repeat password: ");

  if (password !== repeat) throw new Error("Passwords do not match — nothing was written.");
  return { password, name: name.trim(), email: emailAnswer.trim() };
}

async function main() {
  const uri = process.env.DB;
  if (!uri) {
    console.error("No DB connection string found in .env — set DB= first.");
    process.exit(1);
  }
  assertLocalDatabase(uri);

  const interactive = await readPassword();
  const ADMIN_PASSWORD = typeof interactive === "string" ? interactive : interactive.password;
  const ADMIN_NAME = (typeof interactive === "string" ? "Admin" : interactive.name) || "Admin";
  const ADMIN_EMAIL =
    (typeof interactive === "string" ? null : interactive.email) ||
    process.env.ADMIN_EMAIL ||
    DEFAULT_EMAIL;

  // Same policy the running app enforces, so a bootstrap can never plant an
  // account the app itself would reject.
  const passwordError = validatePassword(ADMIN_PASSWORD);
  if (passwordError) {
    console.error(`REFUSED: ${passwordError}.`);
    process.exit(1);
  }

  // Fail fast when no local mongod is listening, instead of hanging for 30s.
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 5000 });
  console.log("Connected to local database:", mongoose.connection.name);

  const Admin = require("../models/Staff/admin.model");
  const existing = await Admin.findOne({ email: ADMIN_EMAIL });

  const admin = await Admin.findOneAndUpdate(
    { email: ADMIN_EMAIL },
    { name: ADMIN_NAME, email: ADMIN_EMAIL, password: await hashPassword(ADMIN_PASSWORD), role: "admin" },
    { upsert: true, new: true, runValidators: true }
  );

  console.log(existing ? "Existing admin reset:" : "Admin created:");
  console.log("  email:   ", admin.email);
  console.log("  password: not printed — the value you just entered");
  console.log(`  target:   ${mongoose.connection.name} (local only)`);

  await mongoose.disconnect();
}

main().catch((err) => {
  console.error("Failed:", err.message);
  process.exit(1);
});
