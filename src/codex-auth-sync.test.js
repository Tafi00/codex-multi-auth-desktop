import assert from "node:assert/strict";
import test from "node:test";

import { captureCodexAuth } from "./codex-auth-sync.js";

function jwt(payload) {
  return [
    Buffer.from("{}").toString("base64url"),
    Buffer.from(JSON.stringify(payload)).toString("base64url"),
    "signature",
  ].join(".");
}

test("captures Codex's rotated credentials for the matching account", () => {
  const oldAccess = jwt({ iat: 100, exp: 200, "https://api.openai.com/auth": { chatgpt_account_id: "acct-1" } });
  const newAccess = jwt({ iat: 300, exp: 400, "https://api.openai.com/auth": { chatgpt_account_id: "acct-1" } });
  const storage = {
    accounts: [{ accountId: "acct-1", email: "person@example.com", accessToken: oldAccess, idToken: "old-id", refreshToken: "old-refresh" }],
  };

  const result = captureCodexAuth(storage, {
    tokens: { access_token: newAccess, id_token: "new-id", refresh_token: "new-refresh", account_id: "acct-1" },
  }, 12345);

  assert.deepEqual(result, { matchedIndex: 0, updated: true });
  assert.equal(storage.accounts[0].accessToken, newAccess);
  assert.equal(storage.accounts[0].expiresAt, 400_000);
  assert.equal(storage.accounts[0].idToken, "new-id");
  assert.equal(storage.accounts[0].refreshToken, "new-refresh");
  assert.equal(storage.accounts[0].syncUpdatedAt, 12345);
});

test("does not overwrite a newer managed token with a stale auth file", () => {
  const managedAccess = jwt({ iat: 300, exp: 400, "https://api.openai.com/auth": { chatgpt_account_id: "acct-1" } });
  const staleAccess = jwt({ iat: 100, exp: 200, "https://api.openai.com/auth": { chatgpt_account_id: "acct-1" } });
  const storage = {
    accounts: [{ accountId: "acct-1", accessToken: managedAccess, refreshToken: "managed-refresh" }],
  };

  const result = captureCodexAuth(storage, {
    tokens: { access_token: staleAccess, refresh_token: "stale-refresh", account_id: "acct-1" },
  });

  assert.deepEqual(result, { matchedIndex: 0, updated: false });
  assert.equal(storage.accounts[0].accessToken, managedAccess);
  assert.equal(storage.accounts[0].refreshToken, "managed-refresh");
});

test("ignores auth files that cannot be mapped to a managed account", () => {
  const storage = { accounts: [{ accountId: "acct-1", refreshToken: "managed-refresh" }] };
  assert.deepEqual(captureCodexAuth(storage, { tokens: { refresh_token: "unknown-refresh", account_id: "acct-2" } }), {
    matchedIndex: -1,
    updated: false,
  });
});
