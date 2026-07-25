import assert from "node:assert/strict";
import test from "node:test";

import { buildInitialDelayMs, stableHash } from "./auto-refresh-scheduler.js";

test("uses a deterministic initial delay spread like Cockpit", () => {
  const task = { key: "current:codex", intervalMs: 60_000 };
  const first = buildInitialDelayMs(task, 5_000);
  const second = buildInitialDelayMs(task, 5_000);
  assert.equal(first, second);
  assert.ok(first >= 5_000);
  assert.ok(first <= 48_000);
  assert.equal(stableHash("current:codex"), stableHash("current:codex"));
});

test("honors an explicit initial delay without going below one tick", () => {
  assert.equal(
    buildInitialDelayMs({ key: "full:codex", intervalMs: 600_000, initialDelayMs: 100 }, 5_000),
    5_000,
  );
});
