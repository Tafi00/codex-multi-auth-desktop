import assert from "node:assert/strict";
import test from "node:test";

import { settleWithin } from "./login-lifecycle.js";

test("login cleanup does not wait forever for a stuck browser", async () => {
  const startedAt = Date.now();
  const settled = await settleWithin(new Promise(() => {}), 20);
  assert.equal(settled, false);
  assert.ok(Date.now() - startedAt < 500);
});

test("login cleanup reports a task that finishes in time", async () => {
  assert.equal(await settleWithin(Promise.resolve(), 100), true);
});
