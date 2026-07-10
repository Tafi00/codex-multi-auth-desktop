import { createHmac } from "node:crypto";

const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

function decodeBase32(secret) {
  const normalized = String(secret ?? "").replaceAll(/\s+/g, "").replaceAll("=", "").toUpperCase();
  if (!normalized || /[^A-Z2-7]/.test(normalized)) throw new Error("2FA secret must be a Base32 value.");

  let bits = 0;
  let value = 0;
  const bytes = [];
  for (const character of normalized) {
    value = (value << 5) | BASE32.indexOf(character);
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

export function generateTotpCode(secret, { now = Date.now(), period = 30, digits = 6 } = {}) {
  if (!Number.isInteger(period) || period <= 0 || !Number.isInteger(digits) || digits < 6 || digits > 10) {
    throw new Error("Invalid TOTP configuration.");
  }

  const counter = Math.floor(now / (period * 1000));
  const counterBuffer = Buffer.alloc(8);
  counterBuffer.writeBigUInt64BE(BigInt(counter));
  const digest = createHmac("sha1", decodeBase32(secret)).update(counterBuffer).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const value = (((digest[offset] & 0x7f) << 24) |
    (digest[offset + 1] << 16) |
    (digest[offset + 2] << 8) |
    digest[offset + 3]) >>> 0;
  return String(value % (10 ** digits)).padStart(digits, "0");
}
