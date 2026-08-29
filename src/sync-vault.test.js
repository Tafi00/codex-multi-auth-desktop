import assert from "node:assert/strict";
import test from "node:test";

import {
  accountSyncKey,
  applySyncRecordsToLocalAccounts,
  createSyncRecords,
  decryptSyncVault,
  encryptSyncVault,
  isLegacyEncryptedSyncVault,
  mergeSyncRecords,
  syncRecordFingerprint,
  syncableAccount,
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
  assert.deepEqual(await decryptSyncVault(vault, "a strong sync passphrase"), {
    version: 3,
    updatedAt: 123,
    records: [{
      key: "account:acct-1",
      updatedAt: 100,
      account: { email: "person@example.com", accountId: "acct-1", addedAt: 100, refreshToken: "refresh-super-secret" },
    }],
  });
  await assert.rejects(() => decryptSyncVault(vault, "the wrong passphrase"), /giải mã|passphrase/);
});

test("uses stable account identities without accepting a session token as identity", () => {
  assert.equal(accountSyncKey({ accountId: "acct-1", email: "person@example.com" }), "account:acct-1");
  assert.equal(accountSyncKey({ email: "Person@Example.com" }), "email:person@example.com");
  assert.equal(accountSyncKey({ id: "local-id", refreshToken: "raw-secret" }), "device:local-id");
  assert.throws(() => accountSyncKey({ refreshToken: "raw-secret" }), /sync identity/);
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

test("GitHub records carry OAuth session fields for cross-device account merge", () => {
  const account = {
    email: "person@example.com",
    accountId: "acct-1",
    accessToken: "access-secret",
    refreshToken: "refresh-secret",
    idToken: "id-secret",
    expiresAt: 999,
    savedLogin: { email: "person@example.com", password: "password", totpSecret: "totp" },
  };
  const synced = syncableAccount(account);
  assert.deepEqual(synced, {
    email: "person@example.com",
    accountId: "acct-1",
    accessToken: "access-secret",
    refreshToken: "refresh-secret",
    idToken: "id-secret",
    expiresAt: 999,
    savedLogin: { email: "person@example.com", password: "password", totpSecret: "totp" },
  });
});

test("sync metadata cannot overwrite a local device session", () => {
  const local = [{
    id: "local-id",
    email: "person@example.com",
    accountId: "acct-1",
    accessToken: "local-access",
    refreshToken: "local-refresh",
    idToken: "local-id-token",
    expiresAt: 999,
    syncUpdatedAt: 100,
  }];
  const legacyRemote = [{
    key: "account:acct-1",
    updatedAt: 200,
    account: {
      email: "person@example.com",
      accountId: "acct-1",
      accessToken: "remote-access",
      refreshToken: "remote-refresh",
      idToken: "remote-id-token",
      expiresAt: 1,
      savedLogin: { email: "person@example.com", password: "saved-password" },
    },
  }];
  const [merged] = applySyncRecordsToLocalAccounts(local, legacyRemote);
  assert.equal(merged.accessToken, "local-access");
  assert.equal(merged.refreshToken, "local-refresh");
  assert.equal(merged.idToken, "local-id-token");
  assert.equal(merged.expiresAt, 999);
  assert.equal(merged.savedLogin.password, "saved-password");
});

test("sync adds a remote account that is missing locally", () => {
  const [merged] = applySyncRecordsToLocalAccounts([], [{
    key: "account:acct-new",
    updatedAt: 200,
    account: {
      email: "new@example.com",
      accountId: "acct-new",
      refreshToken: "remote-refresh",
    },
  }]);
  assert.equal(merged.email, "new@example.com");
  assert.equal(merged.refreshToken, "remote-refresh");
  assert.equal(merged.syncKey, "account:acct-new");
});
