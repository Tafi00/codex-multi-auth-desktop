import assert from "node:assert/strict";
import test from "node:test";

import { generateTotpCode } from "./totp.js";

test("generates the RFC 6238 SHA-1 test vector", () => {
  assert.equal(
    generateTotpCode("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ", { now: 59_000, digits: 8 }),
    "94287082",
  );
});

test("rejects invalid 2FA secrets", () => {
  assert.throws(() => generateTotpCode("not a seed!"), /Base32/);
});
