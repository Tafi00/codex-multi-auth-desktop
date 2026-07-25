import assert from "node:assert/strict";
import test from "node:test";

import { startOAuthCallbackServer } from "./oauth-callback.js";

test("releases the callback port before a consecutive login", async () => {
  const first = await startOAuthCallbackServer("state-one", { port: 0 });
  const firstResponse = await fetch(
    `http://127.0.0.1:${first.port}/auth/callback?state=state-one&code=code-one`,
  );
  assert.equal(firstResponse.status, 200);
  assert.equal(await first.wait(), "code-one");
  await first.close();

  const second = await startOAuthCallbackServer("state-two", { port: first.port });
  const secondResponse = await fetch(
    `http://127.0.0.1:${second.port}/auth/callback?state=state-two&code=code-two`,
  );
  assert.equal(secondResponse.status, 200);
  assert.equal(await second.wait(), "code-two");
  await second.close();
});

test("rejects a callback with the wrong state", async () => {
  const callback = await startOAuthCallbackServer("expected", { port: 0 });
  const response = await fetch(
    `http://127.0.0.1:${callback.port}/auth/callback?state=wrong&code=code`,
  );
  assert.equal(response.status, 400);
  await callback.close();
  assert.equal(await callback.wait(), null);
});
