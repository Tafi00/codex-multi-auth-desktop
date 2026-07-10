import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";

const AAD = Buffer.from("codex-multi-auth-portable-export-v2", "utf8");
const SALT_BYTES = 16;
const IV_BYTES = 12;

function assertPassword(password) {
  if (typeof password !== "string" || password.length < 8) {
    throw new Error("Export password must be at least 8 characters.");
  }
}

function decodeBase64(value, expectedBytes, name) {
  if (typeof value !== "string" || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) throw new Error(`Invalid ${name}.`);
  const decoded = Buffer.from(value, "base64");
  if (expectedBytes && decoded.length !== expectedBytes) throw new Error(`Invalid ${name}.`);
  return decoded;
}

function deriveKey(password, salt) {
  return scryptSync(password, salt, 32, { N: 16_384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
}

export function encryptPortableExport(payload, password) {
  assertPassword(password);
  const salt = randomBytes(SALT_BYTES);
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", deriveKey(password, salt), iv);
  cipher.setAAD(AAD);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(payload), "utf8"), cipher.final()]);
  return {
    version: 2,
    encrypted: true,
    encryption: {
      algorithm: "aes-256-gcm",
      kdf: "scrypt",
      salt: salt.toString("base64"),
      iv: iv.toString("base64"),
      authTag: cipher.getAuthTag().toString("base64"),
    },
    payload: ciphertext.toString("base64"),
  };
}

export function decryptPortableExport(value, password) {
  assertPassword(password);
  if (!value || value.version !== 2 || value.encrypted !== true || value.encryption?.algorithm !== "aes-256-gcm" || value.encryption?.kdf !== "scrypt") {
    throw new Error("This is not a password-protected export file.");
  }
  try {
    const salt = decodeBase64(value.encryption.salt, SALT_BYTES, "export salt");
    const iv = decodeBase64(value.encryption.iv, IV_BYTES, "export IV");
    const authTag = decodeBase64(value.encryption.authTag, 16, "export authentication tag");
    const ciphertext = decodeBase64(value.payload, 0, "export payload");
    const decipher = createDecipheriv("aes-256-gcm", deriveKey(password, salt), iv);
    decipher.setAAD(AAD);
    decipher.setAuthTag(authTag);
    return JSON.parse(Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8"));
  } catch (error) {
    if (error?.message === "Export password must be at least 8 characters.") throw error;
    throw new Error("The export password is wrong or the file is corrupt.");
  }
}
