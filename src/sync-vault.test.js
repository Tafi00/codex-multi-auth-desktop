import assert from "node:assert/strict";
import test from "node:test";

import {
  accountSyncKey,
  createSyncRecords,
  decryptSyncVault,
  encryptSyncVault,
  isLegacyEncryptedSyncVault,
  mergeSyncRecords,
  syncRecordFingerprint,
  tombstonesFromRecords,
} from "./sync-vault.js";

test("reads the legacy encrypted sync payload before migrating it", async () => {
  const payload = {
    version: 1,
    updatedAt: 123,
    records: createSyncRecords([{
      accountId: "acct-1",
      email: "person@example.com",
      refreshToken: "refresh-super-secret",
      addedAt: 100,
    }]),
  };
  const vault = await encryptSyncVault(payload, "a strong sync passphrase");
  assert.equal(isLegacyEncryptedSyncVault(vault), true);
  assert.equal(JSON.stringify(vault).includes("refresh-super-secret"), false);
  assert.deepEqual(await decryptSyncVault(vault, "a strong sync passphrase"), payload);
  await assert.rejects(() => decryptSyncVault(vault, "the wrong passphrase"), /giải mã|passphrase/);
});

test("uses stable account identities without putting a raw refresh token in the key", () => {
  assert.equal(accountSyncKey({ accountId: "acct-1", email: "person@example.com" }), "account:acct-1");
  assert.equal(accountSyncKey({ email: "Person@Example.com" }), "email:person@example.com");
  const refreshKey = accountSyncKey({ refreshToken: "raw-secret" });
  assert.match(refreshKey, /^refresh:[a-f0-9]{64}$/);
  assert.equal(refreshKey.includes("raw-secret"), false);
});

test("merges records last-write-wins and lets a deletion win an exact tie", () => {
  const oldAccount = { key: "account:1", updatedAt: 100, account: { accountId: "1", refreshToken: "old" } };
  const newAccount = { key: "account:1", updatedAt: 200, account: { accountId: "1", refreshToken: "new" } };
  const deletion = { key: "account:1", updatedAt: 200, deletedAt: 200 };
  const merged = mergeSyncRecords([oldAccount], [newAccount, deletion]);
  assert.deepEqual(merged, [deletion]);
  assert.deepEqual(tombstonesFromRecords(merged), { "account:1": 200 });
});

test("matches the same account across legacy email and account-id keys", () => {
  const remote = [{
    key: "email:person@example.com",
    updatedAt: 100,
    account: { email: "person@example.com", refreshToken: "old" },
  }];
  const local = [{
    key: "account:acct-1",
    updatedAt: 200,
    account: { accountId: "acct-1", email: "person@example.com", refreshToken: "new" },
  }];
  const merged = mergeSyncRecords(remote, local);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].key, "account:acct-1");
  assert.equal(merged[0].account.refreshToken, "new");
  assert.equal(syncRecordFingerprint(merged), syncRecordFingerprint([...local]));
});
