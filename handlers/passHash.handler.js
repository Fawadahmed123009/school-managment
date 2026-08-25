const bcrypt = require("bcryptjs");

// ── Password complexity validation ────────
const PASSWORD_MIN_LENGTH = 6;
const PASSWORD_REGEX = /^(?=.*[a-zA-Z])(?=.*\d).+$/;

exports.validatePassword = (password) => {
  if (!password || typeof password !== "string") {
    return "Password is required";
  }
  if (password.length < PASSWORD_MIN_LENGTH) {
    return `Password must be at least ${PASSWORD_MIN_LENGTH} characters`;
  }
  if (!PASSWORD_REGEX.test(password)) {
    return "Password must contain at least one letter and one number";
  }
  return null; // valid
};

// ── Hash password ─────────────────────────
exports.hashPassword = async (password) => {
  const salt = await bcrypt.genSalt(10);
  const hash = await bcrypt.hash(password, salt);
  return hash;
};

// ── Check if password matches hash ────────
exports.isPassMatched = async (password, hash) => {
  return await bcrypt.compare(password, hash);
};
