import assert from "node:assert/strict";
import test from "node:test";
import { extractUsageQuota, quotaDistance } from "./usage-quota.js";

test("extracts legacy 5-hour and weekly windows", () => {
  const quota = extractUsageQuota({ rate_limit: {
    primary_window: { used_percent: 20, limit_window_seconds: 18_000, reset_at: 1_800_000_000 },
    secondary_window: { used_percent: 40, limit_window_seconds: 604_800, reset_at: 1_800_500_000 },
  } }, 123);
  assert.equal(quota.primary.usedPercent, 20);
  assert.equal(quota.primary.windowMinutes, 300);
  assert.equal(quota.secondary.usedPercent, 40);
  assert.equal(quota.secondary.windowMinutes, 10_080);
});

test("maps a Plus weekly-only primary_window into the weekly slot", () => {
  const quota = extractUsageQuota({ plan_type: "plus", rate_limit: {
    allowed: true,
    limit_reached: false,
    primary_window: { used_percent: 31, limit_window_seconds: 604_800, reset_at: 1_800_500_000 },
    secondary_window: null,
  } }, 456);
  assert.equal(quota.primary, null);
  assert.equal(quota.secondary.usedPercent, 31);
  assert.equal(quota.planType, "plus");
  assert.equal(quota.allowed, true);
});

test("keeps a short single window in the 5-hour slot", () => {
  const quota = extractUsageQuota({ rate_limit: {
    primary_window: { used_percent: 12, limit_window_seconds: 18_000 },
    secondary_window: null,
  } }, 789);
  assert.equal(quota.primary.usedPercent, 12);
  assert.equal(quota.secondary, null);
});

test("derives reset time from reset_after_seconds", () => {
  const quota = extractUsageQuota({ rate_limit: {
    primary_window: {
      used_percent: 12,
      limit_window_seconds: 18_000,
      reset_after_seconds: 90,
    },
  } }, 10_000);
  assert.equal(quota.primary.resetAtMs, 100_000);
});

test("supports rate_limits arrays and optional windows", () => {
  const quota = extractUsageQuota({ rate_limits: [{
    limit_id: "codex",
    primary: null,
    secondary: { percent_used: 9, window_minutes: 10_080, resets_at: 1_800_500_000 },
  }] }, 321);
  assert.equal(quota.primary, null);
  assert.equal(quota.secondary.usedPercent, 9);
});

test("rejects responses without any quota window", () => {
  assert.throws(() => extractUsageQuota({ rate_limit: { allowed: true } }, 1), /supported quota window/);
});

test("quota distance handles missing windows", () => {
  const first = { primary: null, secondary: { usedPercent: 10 } };
  const second = { primary: null, secondary: { usedPercent: 14 } };
  assert.equal(quotaDistance(first, second), 4);
  assert.equal(quotaDistance(first, { primary: { usedPercent: 1 }, secondary: second.secondary }), 104);
});
