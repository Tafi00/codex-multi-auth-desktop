import assert from "node:assert/strict";
import test from "node:test";

import {
  createGitHubSyncClient,
  pollGitHubDeviceToken,
  refreshGitHubDeviceToken,
  requestGitHubDeviceCode,
} from "./github-sync.js";

function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

test("requests a GitHub device code without a client secret", async () => {
  let request;
  const result = await requestGitHubDeviceCode({
    clientId: "client-123",
    fetchFn: async (url, options) => {
      request = { url, options };
      return jsonResponse({
        device_code: "device-123",
        user_code: "ABCD-EFGH",
        verification_uri: "https://github.com/login/device",
        expires_in: 900,
        interval: 5,
      });
    },
  });
  assert.equal(request.url, "https://github.com/login/device/code");
  assert.equal(request.options.body.get("client_id"), "client-123");
  assert.equal(request.options.body.get("scope"), "repo");
  assert.equal(request.options.body.has("client_secret"), false);
  assert.equal(result.userCode, "ABCD-EFGH");
  assert.equal(result.intervalMs, 5_000);
});

test("polls at GitHub's interval, handles slow_down, and returns rotating tokens", async () => {
  const responses = [
    { status: 400, body: { error: "authorization_pending" } },
    { status: 400, body: { error: "slow_down" } },
    { status: 200, body: { access_token: "access", refresh_token: "refresh", expires_in: 60, refresh_token_expires_in: 600 } },
  ];
  const waits = [];
  const token = await pollGitHubDeviceToken({
    clientId: "client",
    deviceCode: "device",
    intervalMs: 5_000,
    expiresIn: 900,
    fetchFn: async () => {
      const response = responses.shift();
      return jsonResponse(response.body, response.status);
    },
    sleep: async (ms) => { waits.push(ms); },
    now: () => 1_000,
  });
  assert.deepEqual(waits, [5_000, 5_000, 10_000]);
  assert.equal(token.accessToken, "access");
  assert.equal(token.refreshToken, "refresh");
  assert.equal(token.accessTokenExpiresAt, 61_000);
});

test("refreshes a device-issued token without sending a client secret", async () => {
  let body;
  const token = await refreshGitHubDeviceToken({
    clientId: "client",
    refreshToken: "old-refresh",
    now: () => 2_000,
    fetchFn: async (_url, options) => {
      body = options.body;
      return jsonResponse({ access_token: "new-access", refresh_token: "new-refresh", expires_in: 60 });
    },
  });
  assert.equal(body.get("grant_type"), "refresh_token");
  assert.equal(body.get("client_secret"), null);
  assert.equal(token.accessToken, "new-access");
  assert.equal(token.refreshToken, "new-refresh");
});

test("creates a private repository when the sync repository is missing", async () => {
  const calls = [];
  const client = createGitHubSyncClient({
    accessToken: "secret-token",
    fetchFn: async (url, options) => {
      calls.push({ url, options });
      if (url.endsWith("/repos/octo/codex-multi-auth-sync")) return jsonResponse({ message: "Not Found" }, 404);
      return jsonResponse({ name: "codex-multi-auth-sync", private: true });
    },
  });
  const repo = await client.ensurePrivateRepository("octo");
  assert.equal(repo.private, true);
  assert.equal(calls[1].url.endsWith("/user/repos"), true);
  assert.deepEqual(JSON.parse(calls[1].options.body), {
    name: "codex-multi-auth-sync",
    description: "Private Codex Multi Auth session sync vault",
    private: true,
    auto_init: true,
  });
  assert.equal(calls[1].options.headers.Authorization, "Bearer secret-token");
});

test("refuses to write session data to a public repository", async () => {
  const client = createGitHubSyncClient({
    accessToken: "token",
    fetchFn: async () => jsonResponse({ name: "codex-multi-auth-sync", private: false }),
  });
  await assert.rejects(() => client.ensurePrivateRepository("octo"), /public/);
});

test("base64 encodes vault content in the GitHub API body", async () => {
  let request;
  const client = createGitHubSyncClient({
    accessToken: "token",
    fetchFn: async (url, options) => {
      request = { url, options };
      return jsonResponse({ content: { sha: "new-sha" } });
    },
  });
  await client.writeVault("octo", "encrypted-vault", { sha: "old-sha" });
  const body = JSON.parse(request.options.body);
  assert.equal(Buffer.from(body.content, "base64").toString("utf8"), "encrypted-vault");
  assert.equal(body.sha, "old-sha");
});
