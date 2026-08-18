export const DEFAULT_GITHUB_SYNC_REPO = "codex-multi-auth-sync";
export const DEFAULT_GITHUB_SYNC_FILE = "vault.json";
export const GITHUB_API_VERSION = "2022-11-28";

const DEVICE_CODE_URL = "https://github.com/login/device/code";
const OAUTH_TOKEN_URL = "https://github.com/login/oauth/access_token";
const API_BASE_URL = "https://api.github.com";

export class GitHubApiError extends Error {
  constructor(message, { status = null, data = null } = {}) {
    super(message);
    this.name = "GitHubApiError";
    this.status = status;
    this.data = data;
  }
}

async function responseData(response) {
  const value = await response.text();
  if (!value) return {};
  try {
    return JSON.parse(value);
  } catch {
    throw new GitHubApiError("GitHub trả về dữ liệu không hợp lệ.", { status: response.status });
  }
}

function githubError(data, fallback) {
  return typeof data?.error_description === "string" ? data.error_description
    : typeof data?.message === "string" ? data.message
      : fallback;
}

async function oauthRequest(parameters, fetchFn, { allowOAuthError = false } = {}) {
  const response = await fetchFn(parameters.grant_type ? OAUTH_TOKEN_URL : DEVICE_CODE_URL, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams(parameters),
  });
  const data = await responseData(response);
  if (!response.ok && !(allowOAuthError && typeof data?.error === "string")) {
    throw new GitHubApiError(githubError(data, `GitHub OAuth trả về ${response.status}.`), {
      status: response.status,
      data,
    });
  }
  return data;
}

export async function requestGitHubDeviceCode({ clientId, scope = "repo", fetchFn = fetch }) {
  if (typeof clientId !== "string" || !clientId) throw new Error("GitHub OAuth client ID chưa được cấu hình.");
  const data = await oauthRequest({ client_id: clientId, scope }, fetchFn);
  if (
    typeof data.device_code !== "string"
    || typeof data.user_code !== "string"
    || typeof data.verification_uri !== "string"
  ) {
    throw new Error("GitHub không trả về device authorization hợp lệ.");
  }
  return {
    deviceCode: data.device_code,
    userCode: data.user_code,
    verificationUri: data.verification_uri,
    expiresIn: Number.isFinite(data.expires_in) ? data.expires_in : 900,
    intervalMs: Math.max(1, Number.isFinite(data.interval) ? data.interval : 5) * 1000,
  };
}

function wait(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("GitHub login đã bị hủy."));
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(new Error("GitHub login đã bị hủy."));
    }, { once: true });
  });
}

function normalizedTokenResponse(data, now = Date.now()) {
  if (typeof data.access_token !== "string" || !data.access_token) {
    throw new Error("GitHub không trả về access token hợp lệ.");
  }
  return {
    accessToken: data.access_token,
    refreshToken: typeof data.refresh_token === "string" ? data.refresh_token : null,
    accessTokenExpiresAt: Number.isFinite(data.expires_in) ? now + data.expires_in * 1000 : null,
    refreshTokenExpiresAt: Number.isFinite(data.refresh_token_expires_in)
      ? now + data.refresh_token_expires_in * 1000
      : null,
    scope: typeof data.scope === "string" ? data.scope : null,
    tokenType: typeof data.token_type === "string" ? data.token_type : "bearer",
  };
}

export async function pollGitHubDeviceToken({
  clientId,
  deviceCode,
  intervalMs = 5_000,
  expiresIn = 900,
  fetchFn = fetch,
  sleep = wait,
  signal,
  now = () => Date.now(),
}) {
  const expiresAt = now() + expiresIn * 1000;
  let pollingInterval = Math.max(1_000, intervalMs);
  while (now() < expiresAt) {
    await sleep(pollingInterval, signal);
    const data = await oauthRequest({
      client_id: clientId,
      device_code: deviceCode,
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    }, fetchFn, { allowOAuthError: true });
    if (data.access_token) return normalizedTokenResponse(data, now());
    if (data.error === "authorization_pending") continue;
    if (data.error === "slow_down") {
      pollingInterval += 5_000;
      continue;
    }
    if (data.error === "expired_token") throw new Error("GitHub login code đã hết hạn. Hãy thử lại.");
    if (data.error === "access_denied") throw new Error("GitHub login đã bị từ chối.");
    if (data.error === "device_flow_disabled") throw new Error("GitHub Device Flow chưa được bật cho ứng dụng.");
    throw new GitHubApiError(githubError(data, "GitHub login thất bại."), { data });
  }
  throw new Error("GitHub login code đã hết hạn. Hãy thử lại.");
}

export async function refreshGitHubDeviceToken({ clientId, refreshToken, fetchFn = fetch, now = Date.now }) {
  if (typeof refreshToken !== "string" || !refreshToken) throw new Error("GitHub refresh token không tồn tại.");
  const data = await oauthRequest({
    client_id: clientId,
    refresh_token: refreshToken,
    grant_type: "refresh_token",
  }, fetchFn);
  return normalizedTokenResponse(data, typeof now === "function" ? now() : now);
}

export function createGitHubSyncClient({ accessToken, fetchFn = fetch }) {
  if (typeof accessToken !== "string" || !accessToken) throw new Error("GitHub access token không tồn tại.");

  const request = async (path, { method = "GET", body, allowNotFound = false } = {}) => {
    const response = await fetchFn(`${API_BASE_URL}/${path}`, {
      method,
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${accessToken}`,
        "X-GitHub-Api-Version": GITHUB_API_VERSION,
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (allowNotFound && response.status === 404) return null;
    const data = await responseData(response);
    if (!response.ok) {
      throw new GitHubApiError(githubError(data, `GitHub API trả về ${response.status}.`), {
        status: response.status,
        data,
      });
    }
    return data;
  };

  return {
    async getAuthenticatedUser() {
      const user = await request("user");
      if (typeof user.login !== "string" || !user.login) throw new Error("Không đọc được GitHub username.");
      return { login: user.login, id: user.id ?? null };
    },

    async ensurePrivateRepository(owner, repo = DEFAULT_GITHUB_SYNC_REPO) {
      let repository = await request(`repos/${owner}/${repo}`, { allowNotFound: true });
      if (!repository) {
        repository = await request("user/repos", {
          method: "POST",
          body: {
            name: repo,
            description: "Private Codex Multi Auth session sync vault",
            private: true,
            auto_init: true,
          },
        });
      }
      if (repository.private !== true) {
        throw new Error(`Repository ${owner}/${repo} đang public. App sẽ không lưu session vào đó.`);
      }
      return repository;
    },

    async readVault(owner, repo = DEFAULT_GITHUB_SYNC_REPO, path = DEFAULT_GITHUB_SYNC_FILE) {
      const file = await request(`repos/${owner}/${repo}/contents/${path}`, { allowNotFound: true });
      if (!file) return null;
      if (file.type !== "file" || typeof file.content !== "string" || typeof file.sha !== "string") {
        throw new Error("GitHub vault file không hợp lệ.");
      }
      return {
        sha: file.sha,
        content: Buffer.from(file.content.replaceAll("\n", ""), "base64").toString("utf8"),
      };
    },

    async writeVault(owner, content, {
      repo = DEFAULT_GITHUB_SYNC_REPO,
      path = DEFAULT_GITHUB_SYNC_FILE,
      sha = null,
    } = {}) {
      return request(`repos/${owner}/${repo}/contents/${path}`, {
        method: "PUT",
        body: {
          message: sha ? "Update private Codex session vault" : "Create private Codex session vault",
          content: Buffer.from(content, "utf8").toString("base64"),
          ...(sha ? { sha } : {}),
        },
      });
    },
  };
}
