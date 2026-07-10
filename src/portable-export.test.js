import test from "node:test";
import assert from "node:assert/strict";
import { decryptPortableExport, encryptPortableExport } from "./portable-export.js";

test("encrypts and decrypts a portable export", () => {
  const payload = { version: 1, accounts: [{ email: "person@example.com", savedLogin: { password: "secret" } }] };
  const encrypted = encryptPortableExport(payload, "correct horse battery staple");
  assert.equal(encrypted.version, 2);
  assert.equal(encrypted.encrypted, true);
  assert.doesNotMatch(JSON.stringify(encrypted), /person@example\.com|"secret"/);
  assert.deepEqual(decryptPortableExport(encrypted, "correct horse battery staple"), payload);
});

test("rejects a wrong portable export password", () => {
  const encrypted = encryptPortableExport({ accounts: [] }, "correct horse battery staple");
  assert.throws(() => decryptPortableExport(encrypted, "wrong password"), /wrong or the file is corrupt/i);
});
