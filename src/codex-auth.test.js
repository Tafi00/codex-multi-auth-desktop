import assert from "node:assert/strict";
import test from "node:test";

import {
  applyTokenResponse,
  buildCodexAuthFile,
  buildUsageHeaders,
  extractIdentity,
} from "./codex-auth.js";

function jwt(payload) {
  return [
    Buffer.from("{}").toString("base64url"),
    Buffer.from(JSON.stringify(payload)).toString("base64url"),
    "signature",
  ].join(".");
}

test("extracts only the official ChatGPT identity claims", () => {
  const accessToken = jwt({
    email: "Person@Example.com",
    unrelated_account_id: "wrong",
    "https://api.openai.com/auth": {
      chatgpt_account_id: "acct-right",
      chatgpt_plan_type: "plus",
    },
  });
  assert.deepEqual(extractIdentity(accessToken, null), {
    email: "Person@Example.com",
    accountId: "acct-right",
    planType: "plus",
  });
});

test("token refresh keeps rotated credentials when fields are omitted", () => {
  const account = {
    email: "old@example.com",
    accountId: "acct-old",
    refreshToken: "refresh-old",
    idToken: "id-old",
  };
  const updated = applyTokenResponse(account, { access_token: "at-new", expires_in: 120 }, 1000);
  assert.equal(updated.accessToken, "at-new");
  assert.equal(updated.refreshToken, "refresh-old");
  assert.equal(updated.idToken, "id-old");
  assert.equal(updated.expiresAt, 121000);
});

test("usage headers include the verified account and Codex web headers", () => {
  const headers = buildUsageHeaders({ accountId: "acct-1" }, "at-token");
  assert.equal(headers["ChatGPT-Account-ID"], "acct-1");
  assert.equal(headers["OpenAI-Beta"], "codex-1");
  assert.equal(headers.originator, "Codex Desktop");
  assert.match(headers.Authorization, /^Bearer /);
});

test("projects an official OAuth auth.json without app-only metadata", () => {
  const value = buildCodexAuthFile({
    email: "person@example.com",
    accountId: "acct-1",
    accessToken: "access",
    idToken: "id",
    refreshToken: "refresh",
  }, new Date("2026-07-25T00:00:00.000Z"));
  assert.deepEqual(value, {
    OPENAI_API_KEY: null,
    tokens: {
      id_token: "id",
      access_token: "access",
      refresh_token: "refresh",
      account_id: "acct-1",
    },
    last_refresh: "2026-07-25T00:00:00.000Z",
  });
  assert.equal("email" in value, false);
});
