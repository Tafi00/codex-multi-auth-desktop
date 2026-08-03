import assert from "node:assert/strict";
import test from "node:test";

import {
  findMatchingAccountIndex,
  mergeImportedAccounts,
  serializeJson,
  verifySerializedJson,
} from "./session-transfer.js";

test("matches duplicate accounts by any stable identity", () => {
  const accounts = [{ accountId: "acct-1", email: "person@example.com", refreshToken: "refresh-old" }];
  assert.equal(findMatchingAccountIndex(accounts, { accountId: "acct-1" }), 0);
  assert.equal(findMatchingAccountIndex(accounts, { email: "person@example.com" }), 0);
  assert.equal(findMatchingAccountIndex(accounts, { refreshToken: "refresh-old" }), 0);
  assert.equal(findMatchingAccountIndex(accounts, { email: "other@example.com" }), -1);
});

test("overwrites duplicate account data while preserving local identity", () => {
  const existing = [{
    id: "local-id",
    addedAt: 100,
    accountId: "acct-1",
    email: "old@example.com",
    refreshToken: "refresh-old",
    accessToken: "access-old",
  }];
  const incoming = [{
    id: "exported-id",
    addedAt: 200,
    accountId: "acct-1",
    email: "new@example.com",
    refreshToken: "refresh-new",
    accessToken: "access-new",
  }];

  const result = mergeImportedAccounts(existing, incoming);
  assert.equal(result.added, 0);
  assert.equal(result.updated, 1);
  assert.deepEqual(result.accounts[0], {
    id: "local-id",
    addedAt: 100,
    accountId: "acct-1",
    email: "new@example.com",
    refreshToken: "refresh-new",
    accessToken: "access-new",
  });
});

test("adds new accounts and can update an account added earlier in the same import", () => {
  const result = mergeImportedAccounts([], [
    { id: "first", accountId: "acct-1", refreshToken: "refresh-1" },
    { id: "second", accountId: "acct-1", refreshToken: "refresh-2" },
    { id: "third", accountId: "acct-2", refreshToken: "refresh-3" },
  ]);
  assert.equal(result.added, 2);
  assert.equal(result.updated, 1);
  assert.equal(result.accounts.length, 2);
  assert.equal(result.accounts[0].id, "first");
  assert.equal(result.accounts[0].refreshToken, "refresh-2");
});

test("serializes complete JSON with a trailing newline", () => {
  const value = { version: 3, accounts: [{ refreshToken: "refresh" }] };
  const serialized = serializeJson(value);
  assert.equal(serialized.endsWith("\n"), true);
  assert.deepEqual(JSON.parse(serialized), value);
});

test("rejects a truncated export instead of reporting success", () => {
  const expected = serializeJson({ version: 3, accounts: [{ refreshToken: "refresh" }] });
  assert.doesNotThrow(() => verifySerializedJson(expected, expected));
  assert.throws(() => verifySerializedJson(expected.slice(0, 20), expected), /bị thiếu|không phải JSON/);
  assert.throws(() => verifySerializedJson('{"version":3}\n', expected), /chưa đầy đủ/);
});
