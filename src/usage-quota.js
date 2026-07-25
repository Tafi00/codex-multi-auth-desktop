function finiteNumber(value, fallback = 0) {
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function timestampMs(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value < 1e12 ? value * 1000 : value;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function normalizeUsageWindow(window, now) {
  const seconds = finiteNumber(window?.limit_window_seconds ?? window?.window_seconds, NaN);
  const minutes = finiteNumber(
    window?.window_minutes ?? window?.windowMinutes ?? window?.limit_window_minutes,
    Number.isFinite(seconds) ? seconds / 60 : 0,
  );
  const resetAfterSeconds = finiteNumber(
    window?.reset_after_seconds ?? window?.resetAfterSeconds,
    NaN,
  );
  const absoluteReset = timestampMs(window?.reset_at ?? window?.resets_at ?? window?.resetAt);
  return {
    usedPercent: Math.max(0, Math.min(100, finiteNumber(window?.used_percent ?? window?.percent_used))),
    windowMinutes: minutes,
    resetAtMs: absoluteReset
      ?? (Number.isFinite(resetAfterSeconds) && resetAfterSeconds >= 0
        ? now + resetAfterSeconds * 1000
        : undefined),
  };
}

function hasUsageWindows(value) {
  return Boolean(value && typeof value === "object" && (
    value.primary_window || value.secondary_window || value.primary || value.secondary
  ));
}

function findRateLimit(data) {
  const candidates = [data?.rate_limit, data?.rate_limits_by_limit_id?.codex, data?.rate_limits?.codex, data];
  if (Array.isArray(data?.rate_limits)) {
    candidates.splice(1, 0, data.rate_limits.find((item) => item?.limit_id === "codex"), ...data.rate_limits);
  } else {
    candidates.splice(1, 0, data?.rate_limits);
  }
  return candidates.find(hasUsageWindows) ?? null;
}

function classifyUsageWindows(rateLimit, now) {
  const rawPrimary = rateLimit?.primary_window ?? rateLimit?.primary;
  const rawSecondary = rateLimit?.secondary_window ?? rateLimit?.secondary;
  const windows = [
    rawPrimary ? { source: "primary", value: normalizeUsageWindow(rawPrimary, now) } : null,
    rawSecondary ? { source: "secondary", value: normalizeUsageWindow(rawSecondary, now) } : null,
  ].filter(Boolean);

  if (windows.length === 0) return { primary: null, secondary: null };
  if (windows.length === 2) {
    const [first, second] = windows;
    if (first.value.windowMinutes > 0 && second.value.windowMinutes > 0) {
      return first.value.windowMinutes <= second.value.windowMinutes
        ? { primary: first.value, secondary: second.value }
        : { primary: second.value, secondary: first.value };
    }
    return { primary: first.value, secondary: second.value };
  }

  const only = windows[0];
  // Current Plus responses put the weekly window in `primary_window` and omit
  // `secondary_window`. Use the actual duration instead of the field name.
  if (only.value.windowMinutes >= 24 * 60) return { primary: null, secondary: only.value };
  if (only.value.windowMinutes > 0) return { primary: only.value, secondary: null };
  return only.source === "secondary"
    ? { primary: null, secondary: only.value }
    : { primary: only.value, secondary: null };
}

export function extractUsageQuota(data, now) {
  const rateLimit = findRateLimit(data);
  if (!rateLimit) throw new Error("Usage response did not include a supported quota window.");
  const { primary, secondary } = classifyUsageWindows(rateLimit, now);
  if (!primary && !secondary) throw new Error("Usage response did not include a supported quota window.");
  return {
    updatedAt: now,
    sourceAccountId: typeof data?.account_id === "string" ? data.account_id : null,
    sourceEmail: typeof data?.email === "string" ? data.email.trim().toLowerCase() : null,
    planType: typeof data?.plan_type === "string" ? data.plan_type : null,
    allowed: typeof rateLimit.allowed === "boolean" ? rateLimit.allowed : null,
    limitReached: typeof rateLimit.limit_reached === "boolean" ? rateLimit.limit_reached : null,
    primary,
    secondary,
  };
}

function windowDistance(first, second) {
  if (!first && !second) return 0;
  if (!first || !second) return 100;
  return Math.abs(first.usedPercent - second.usedPercent);
}

export function quotaDistance(first, second) {
  if (!first || !second) return Number.POSITIVE_INFINITY;
  return windowDistance(first.primary, second.primary) + windowDistance(first.secondary, second.secondary);
}
