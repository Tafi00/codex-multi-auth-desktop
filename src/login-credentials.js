// Kept dependency-free so both the renderer and the main process can use it.
const BASE32_SECRET = /^[A-Z2-7]+$/;

export function normalizeTotpSecret(value) {
  const normalized = String(value ?? "").replace(/\s+/g, "").replace(/=+$/, "").toUpperCase();
  if (!normalized) return "";
  // Catching this here keeps a typo from silently stalling the login automation.
  if (!BASE32_SECRET.test(normalized)) throw new Error("2FA secret must be a Base32 value (A-Z and 2-7).");
  return normalized;
}

export function parseLoginCredentials(value) {
  const parts = String(value ?? "").split("|");
  if (parts.length < 2 || parts.length > 3) {
    throw new Error("Use email|password or email|password|2FA secret.");
  }

  const [email, password, rawTotpSecret = ""] = parts.map((part) => part.trim());
  if (!email || !password) throw new Error("Email and password are required.");
  return { email, password, totpSecret: normalizeTotpSecret(rawTotpSecret) };
}
