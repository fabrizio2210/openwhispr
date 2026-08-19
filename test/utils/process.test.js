const test = require("node:test");
const assert = require("node:assert/strict");

const { handleUncaughtException } = require("../../src/utils/process");

test("uncaught output errors are ignored before logging", async (t) => {
  for (const code of ["EIO", "EPIPE"]) {
    await t.test(code, () => {
      const calls = [];
      const error = Object.assign(new Error("output unavailable"), {
        code,
        syscall: "write",
      });

      handleUncaughtException(error, "uncaughtException", {
        error: (...args) => calls.push(args),
      });

      assert.deepEqual(calls, []);
    });
  }
});

test("non-output EIO errors retain existing logging", () => {
  const calls = [];
  const error = Object.assign(new Error("storage unavailable"), {
    code: "EIO",
    syscall: "read",
  });

  handleUncaughtException(error, "uncaughtException", {
    error: (...args) => calls.push(args),
  });

  assert.deepEqual(calls, [
    ["Uncaught Exception:", error],
    ["Error stack:", error.stack],
  ]);
});

test("other uncaught exceptions retain existing logging", () => {
  const calls = [];
  const error = Object.assign(new Error("boom"), { code: "EINVAL" });

  handleUncaughtException(error, "uncaughtException", {
    error: (...args) => calls.push(args),
  });

  assert.deepEqual(calls, [
    ["Uncaught Exception:", error],
    ["Error stack:", error.stack],
  ]);
});
