const { validatePassword, hashPassword, isPassMatched } = require("../handlers/passHash.handler");

describe("Password Handler", () => {
  describe("validatePassword", () => {
    test("rejects empty password", () => {
      expect(validatePassword("")).toBe("Password is required");
      expect(validatePassword(null)).toBe("Password is required");
      expect(validatePassword(undefined)).toBe("Password is required");
    });

    test("rejects password shorter than 6 characters", () => {
      expect(validatePassword("ab1")).toContain("at least 6 characters");
    });

    test("rejects password without a number", () => {
      expect(validatePassword("abcdef")).toContain("letter and one number");
    });

    test("rejects password without a letter", () => {
      expect(validatePassword("123456")).toContain("letter and one number");
    });

    test("accepts valid password", () => {
      expect(validatePassword("abc123")).toBeNull();
      expect(validatePassword("Password1")).toBeNull();
    });
  });

  describe("hashPassword and isPassMatched", () => {
    test("hashes password and verifies match", async () => {
      const password = "TestPass123";
      const hash = await hashPassword(password);

      expect(hash).not.toBe(password);
      expect(hash.length).toBeGreaterThan(20);

      const isMatch = await isPassMatched(password, hash);
      expect(isMatch).toBe(true);
    });

    test("rejects wrong password", async () => {
      const hash = await hashPassword("CorrectPass1");
      const isMatch = await isPassMatched("WrongPass1", hash);
      expect(isMatch).toBe(false);
    });
  });
});
