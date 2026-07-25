function normalizedString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export function decodeJwt(token) {
  try {
    const parts = String(token ?? "").split(".");
    if (parts.length !== 3 || !parts[1]) return {};
    return JSON.parse(Buffer.from(parts[1].replaceAll("-", "+").replaceAll("_", "/"), "base64").toString("utf8"));
  } catch {
    return {};
  }
}

export function extractIdentity(accessToken, idToken) {
  const accessClaims = decodeJwt(accessToken);
  const idClaims = decodeJwt(idToken);
  const accessAuth = accessClaims["https://api.openai.com/auth"];
  const idAuth = idClaims["https://api.openai.com/auth"];
  const auth = {
    ...(idAuth && typeof idAuth === "object" ? idAuth : {}),
    ...(accessAuth && typeof accessAuth === "object" ? accessAuth : {}),
  };
  const accessProfile = accessClaims["https://api.openai.com/profile"];
  const idProfile = idClaims["https://api.openai.com/profile"];

  return {
    email: normalizedString(accessClaims.email)
      ?? normalizedString(accessProfile?.email)
      ?? normalizedString(idClaims.email)
      ?? normalizedString(idProfile?.email),
    accountId: normalizedString(auth.chatgpt_account_id) ?? normalizedString(auth.account_id),
    planType: normalizedString(auth.chatgpt_plan_type),
  };
}

export function applyTokenResponse(account, data, now = Date.now()) {
  const accessToken = normalizedString(data?.access_token);
  if (!accessToken) throw new Error("OpenAI did not return a valid access token.");

  const refreshToken = normalizedString(data?.refresh_token) ?? normalizedString(account?.refreshToken);
  if (!refreshToken) throw new Error("Session has expired. Please login again.");

  const idToken = normalizedString(data?.id_token) ?? normalizedString(account?.idToken);
  const expiresIn = Number(data?.expires_in);
  const expiresAt = now + Math.max(60, Number.isFinite(expiresIn) ? expiresIn : 3600) * 1000;
  const identity = extractIdentity(accessToken, idToken);

  return {
    ...account,
    accessToken,
    refreshToken,
    idToken,
    expiresAt,
    email: identity.email?.toLowerCase() ?? account?.email ?? null,
    accountId: identity.accountId ?? account?.accountId ?? null,
    planType: identity.planType ?? account?.planType ?? null,
  };
}

export function buildUsageHeaders(account, accessToken) {
  const identity = extractIdentity(accessToken, account?.idToken);
  const accountId = normalizedString(account?.usageAccountId)
    ?? normalizedString(account?.accountId)
    ?? identity.accountId;
  return {
    Authorization: `Bearer ${accessToken}`,
    Accept: "application/json",
    "Content-Type": "application/json",
    Referer: "https://chatgpt.com/",
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36",
    "OpenAI-Beta": "codex-1",
    "oai-language": "en-US",
    originator: "Codex Desktop",
    "sec-fetch-site": "none",
    "sec-fetch-mode": "no-cors",
    "sec-fetch-dest": "empty",
    priority: "u=4, i",
    ...(accountId ? { "ChatGPT-Account-ID": accountId } : {}),
  };
}

export function buildCodexAuthFile(account, now = new Date()) {
  const accessToken = normalizedString(account?.accessToken);
  const idToken = normalizedString(account?.idToken);
  const refreshToken = normalizedString(account?.refreshToken);
  if (!accessToken || !idToken || !refreshToken) {
    throw new Error("This account is missing official OAuth credentials. Please sign in again.");
  }
  const identity = extractIdentity(accessToken, idToken);
  const accountId = normalizedString(account?.accountId) ?? identity.accountId;
  return {
    OPENAI_API_KEY: null,
    tokens: {
      id_token: idToken,
      access_token: accessToken,
      refresh_token: refreshToken,
      ...(accountId ? { account_id: accountId } : {}),
    },
    last_refresh: now.toISOString(),
  };
}
