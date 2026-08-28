import { decodeJwt, extractIdentity } from "./codex-auth.js";

function normalizedString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function tokenIssuedAt(token) {
  const issuedAt = Number(decodeJwt(token)?.iat);
  return Number.isFinite(issuedAt) && issuedAt > 0 ? issuedAt * 1000 : null;
}

function tokenExpiresAt(token) {
  const expiresAt = Number(decodeJwt(token)?.exp);
  return Number.isFinite(expiresAt) && expiresAt > 0 ? expiresAt * 1000 : null;
}

/**
 * Copies credentials written by Codex back into the matching managed account.
 * Codex refreshes tokens on its own, and refresh-token rotation means the file
 * on disk can be newer than the copy held by accounts.json.
 */
export function captureCodexAuth(storage, auth, now = Date.now()) {
  const tokens = auth?.tokens;
  const accessToken = normalizedString(tokens?.access_token);
  const idToken = normalizedString(tokens?.id_token);
  const refreshToken = normalizedString(tokens?.refresh_token);
  if (!accessToken && !idToken && !refreshToken) return { matchedIndex: -1, updated: false };

  const identity = extractIdentity(accessToken, idToken);
  const accountId = normalizedString(tokens?.account_id) ?? identity.accountId;
  const email = identity.email?.toLowerCase() ?? null;
  const index = storage.accounts.findIndex((account) => (
    (accountId && account.accountId === accountId)
      || (email && account.email === email)
      || (refreshToken && account.refreshToken === refreshToken)
  ));
  if (index < 0) return { matchedIndex: -1, updated: false };

  const account = storage.accounts[index];
  // Do not let a malformed or mixed auth.json entry retarget a managed row.
  // The explicit account_id and the JWT identity must agree when both exist.
  if (accountId && identity.accountId && accountId !== identity.accountId) {
    return { matchedIndex: index, updated: false };
  }
  if (identity.accountId && account.accountId && account.accountId !== identity.accountId) {
    return { matchedIndex: index, updated: false };
  }
  const existingIssuedAt = tokenIssuedAt(account.accessToken);
  const incomingIssuedAt = tokenIssuedAt(accessToken);
  // A stale auth file must not roll a managed account backwards. Tokens with
  // no iat claim are accepted because older Codex builds did not always emit
  // one in access tokens.
  if (existingIssuedAt && incomingIssuedAt && incomingIssuedAt < existingIssuedAt) {
    return { matchedIndex: index, updated: false };
  }

  let updated = false;
  if (accessToken && accessToken !== account.accessToken) {
    account.accessToken = accessToken;
    const expiresAt = tokenExpiresAt(accessToken);
    if (expiresAt) account.expiresAt = expiresAt;
    updated = true;
  }
  if (idToken && idToken !== account.idToken) {
    account.idToken = idToken;
    updated = true;
  }
  if (refreshToken && refreshToken !== account.refreshToken) {
    account.refreshToken = refreshToken;
    updated = true;
  }
  if (identity.email && identity.email.toLowerCase() !== account.email) {
    account.email = identity.email.toLowerCase();
    updated = true;
  }
  if (identity.accountId && identity.accountId !== account.accountId) {
    account.accountId = identity.accountId;
    updated = true;
  }
  if (updated) account.syncUpdatedAt = now;
  return { matchedIndex: index, updated };
}
