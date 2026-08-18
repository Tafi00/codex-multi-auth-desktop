import { createCipheriv, createDecipheriv, createHash, randomBytes, scrypt } from "node:crypto";
import { promisify } from "node:util";

const deriveKey = promisify(scrypt);
const VAULT_AAD = Buffer.from("codex-multi-auth:github-sync:v1", "utf8");
const VAULT_VERSION = 1;
const PAYLOAD_VERSION = 1;
const SCRYPT_COST = 16_384;
const MAX_VAULT_BYTES = 8 * 1024 * 1024;

function requiredPassphrase(value) {
  if (typeof value !== "string" || value.length < 12) {
    throw new Error("Sync passphrase phải có ít nhất 12 ký tự.");
  }
  return value;
}

function encoded(buffer) {
  return buffer.toString("base64");
}

function decoded(value, label) {
  if (typeof value !== "string" || !value) throw new Error(`GitHub vault thiếu ${label}.`);
  return Buffer.from(value, "base64");
}

function comparableRecord(record) {
  return JSON.stringify(record);
}

function recordAliases(record) {
  const aliases = new Set([record.key]);
  const account = record.account;
  if (!account || typeof account !== "object") return aliases;
  if (typeof account.accountId === "string" && account.accountId) aliases.add(`account:${account.accountId}`);
  if (typeof account.email === "string" && account.email) aliases.add(`email:${account.email.trim().toLowerCase()}`);
  if (typeof account.refreshToken === "string" && account.refreshToken) {
    aliases.add(`refresh:${createHash("sha256").update(account.refreshToken).digest("hex")}`);
  }
  return aliases;
}

function recordsMatch(left, right) {
  const leftAliases = recordAliases(left);
  return [...recordAliases(right)].some((alias) => leftAliases.has(alias));
}

function winningRecord(left, right) {
  if (right.updatedAt > left.updatedAt) return right;
  if (right.updatedAt < left.updatedAt) return left;
  if (Boolean(right.deletedAt) !== Boolean(left.deletedAt)) return right.deletedAt ? right : left;
  return comparableRecord(right) > comparableRecord(left) ? right : left;
}

function normalizedRecord(record) {
  if (!record || typeof record !== "object") throw new Error("GitHub vault chứa sync record không hợp lệ.");
  if (typeof record.key !== "string" || !record.key || record.key.length > 512) {
    throw new Error("GitHub vault chứa account key không hợp lệ.");
  }
  if (!Number.isFinite(record.updatedAt) || record.updatedAt <= 0) {
    throw new Error("GitHub vault chứa timestamp không hợp lệ.");
  }
  if (record.deletedAt) {
    if (!Number.isFinite(record.deletedAt) || record.deletedAt <= 0) {
      throw new Error("GitHub vault chứa deletion marker không hợp lệ.");
    }
    return { key: record.key, updatedAt: record.updatedAt, deletedAt: record.deletedAt };
  }
  if (!record.account || typeof record.account !== "object") {
    throw new Error("GitHub vault chứa account record không hợp lệ.");
  }
  return { key: record.key, updatedAt: record.updatedAt, account: { ...record.account } };
}

export function accountSyncKey(account) {
  if (typeof account?.syncKey === "string" && account.syncKey) return account.syncKey;
  if (typeof account?.accountId === "string" && account.accountId) return `account:${account.accountId}`;
  if (typeof account?.email === "string" && account.email) return `email:${account.email.trim().toLowerCase()}`;
  if (typeof account?.refreshToken === "string" && account.refreshToken) {
    return `refresh:${createHash("sha256").update(account.refreshToken).digest("hex")}`;
  }
  throw new Error("Không thể tạo sync identity cho account.");
}

export function createSyncRecords(accounts, tombstones = {}, now = Date.now()) {
  const records = accounts.map((account) => {
    const key = accountSyncKey(account);
    const updatedAt = Number.isFinite(account.syncUpdatedAt)
      ? account.syncUpdatedAt
      : (Number.isFinite(account.addedAt) ? account.addedAt : now);
    return {
      key,
      updatedAt,
      account: { ...account, syncKey: key, syncUpdatedAt: updatedAt },
    };
  });
  for (const [key, deletedAt] of Object.entries(tombstones ?? {})) {
    if (typeof key === "string" && key && Number.isFinite(deletedAt) && deletedAt > 0) {
      records.push({ key, updatedAt: deletedAt, deletedAt });
    }
  }
  return mergeSyncRecords([], records);
}

export function mergeSyncRecords(leftRecords, rightRecords) {
  const merged = [];
  for (const rawRecord of [...leftRecords, ...rightRecords]) {
    const record = normalizedRecord(rawRecord);
    const index = merged.findIndex((existing) => recordsMatch(existing, record));
    if (index < 0) merged.push(record);
    else merged[index] = winningRecord(merged[index], record);
  }
  return merged.sort((left, right) => left.key.localeCompare(right.key));
}

export function normalizeSyncPayload(value) {
  if (!value || value.version !== PAYLOAD_VERSION || !Array.isArray(value.records) || value.records.length > 500) {
    throw new Error("GitHub vault không đúng định dạng được hỗ trợ.");
  }
  return {
    version: PAYLOAD_VERSION,
    updatedAt: Number.isFinite(value.updatedAt) ? value.updatedAt : 0,
    records: mergeSyncRecords([], value.records),
  };
}

export function syncRecordFingerprint(records) {
  return createHash("sha256").update(JSON.stringify(mergeSyncRecords([], records))).digest("hex");
}

export function tombstonesFromRecords(records) {
  return Object.fromEntries(records.filter((record) => record.deletedAt).map((record) => [record.key, record.deletedAt]));
}

// Kept only to read and test the vault format used before private-repository
// sync stopped using a user-managed passphrase. New vaults are plain payloads.
export async function encryptSyncVault(payload, passphrase) {
  const secret = requiredPassphrase(passphrase);
  const normalized = normalizeSyncPayload(payload);
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const key = await deriveKey(secret, salt, 32, { N: SCRYPT_COST, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(VAULT_AAD);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(normalized), "utf8"), cipher.final()]);
  return {
    version: VAULT_VERSION,
    cipher: "aes-256-gcm",
    kdf: { name: "scrypt", N: SCRYPT_COST, r: 8, p: 1, salt: encoded(salt) },
    iv: encoded(iv),
    tag: encoded(cipher.getAuthTag()),
    ciphertext: encoded(ciphertext),
  };
}

export function isLegacyEncryptedSyncVault(vault) {
  return Boolean(vault && vault.version === VAULT_VERSION && vault.cipher === "aes-256-gcm" && vault.kdf?.name === "scrypt");
}

export async function decryptSyncVault(vault, passphrase) {
  const secret = requiredPassphrase(passphrase);
  if (!vault || vault.version !== VAULT_VERSION || vault.cipher !== "aes-256-gcm" || vault.kdf?.name !== "scrypt") {
    throw new Error("GitHub vault dùng định dạng hoặc thuật toán chưa được hỗ trợ.");
  }
  if (vault.kdf.N !== SCRYPT_COST || vault.kdf.r !== 8 || vault.kdf.p !== 1) {
    throw new Error("GitHub vault có cấu hình mã hóa không hợp lệ.");
  }
  if (typeof vault.ciphertext !== "string" || Buffer.byteLength(vault.ciphertext, "utf8") > MAX_VAULT_BYTES) {
    throw new Error("GitHub vault quá lớn hoặc bị hỏng.");
  }
  try {
    const salt = decoded(vault.kdf.salt, "salt");
    const iv = decoded(vault.iv, "IV");
    const tag = decoded(vault.tag, "auth tag");
    const ciphertext = decoded(vault.ciphertext, "ciphertext");
    if (salt.length !== 16 || iv.length !== 12 || tag.length !== 16) throw new Error("invalid sizes");
    const key = await deriveKey(secret, salt, 32, { N: SCRYPT_COST, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
    const decipher = createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAAD(VAULT_AAD);
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
    return normalizeSyncPayload(JSON.parse(plaintext));
  } catch {
    throw new Error("Không thể giải mã GitHub vault. Hãy kiểm tra lại sync passphrase.");
  }
}
