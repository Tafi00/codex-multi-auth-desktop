import assert from "node:assert/strict";
import test from "node:test";

import { parseLoginCredentials } from "./login-credentials.js";

test("parses an email, password, and optional 2FA secret", () => {
  assert.deepEqual(
    parseLoginCredentials("person@example.com|secret|BASE32SECRET"),
    { email: "person@example.com", password: "secret", totpSecret: "BASE32SECRET" },
  );
  assert.deepEqual(
    parseLoginCredentials("person@example.com|secret"),
    { email: "person@example.com", password: "secret", totpSecret: "" },
  );
});

test("rejects incomplete or ambiguous login strings", () => {
  assert.throws(() => parseLoginCredentials("person@example.com"), /email\|password/);
  assert.throws(() => parseLoginCredentials("person@example.com||BASE32"), /required/);
  assert.throws(() => parseLoginCredentials("a|b|c|d"), /email\|password/);
});
