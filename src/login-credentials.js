export function parseLoginCredentials(value) {
  const parts = String(value ?? "").split("|");
  if (parts.length < 2 || parts.length > 3) {
    throw new Error("Use email|password or email|password|2FA secret.");
  }

  const [email, password, totpSecret = ""] = parts.map((part) => part.trim());
  if (!email || !password) throw new Error("Email and password are required.");
  return { email, password, totpSecret };
}
