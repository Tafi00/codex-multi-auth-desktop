function sameNonEmptyValue(left, right) {
  return typeof left === "string" && left.length > 0 && left === right;
}

export function findMatchingAccountIndex(accounts, incoming) {
  return accounts.findIndex((existing) => (
    sameNonEmptyValue(existing.accountId, incoming.accountId)
    || sameNonEmptyValue(existing.email, incoming.email)
    || sameNonEmptyValue(existing.refreshToken, incoming.refreshToken)
  ));
}

export function mergeImportedAccounts(existingAccounts, incomingAccounts) {
  const accounts = existingAccounts.map((account) => ({ ...account }));
  let added = 0;
  let updated = 0;

  for (const incoming of incomingAccounts) {
    const index = findMatchingAccountIndex(accounts, incoming);
    if (index < 0) {
      accounts.push(incoming);
      added += 1;
      continue;
    }

    const existing = accounts[index];
    accounts[index] = {
      ...existing,
      ...incoming,
      // These are local stable identifiers. Keeping them avoids breaking the
      // active row and any quota cache associated with an imported account.
      id: existing.id || incoming.id,
      addedAt: existing.addedAt ?? incoming.addedAt,
    };
    updated += 1;
  }

  return { accounts, added, updated };
}

export function serializeJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

export function verifySerializedJson(written, expected) {
  try {
    JSON.parse(written);
  } catch {
    throw new Error("File export bị thiếu hoặc không phải JSON hợp lệ. Hãy chọn vị trí khác và thử lại.");
  }
  if (written !== expected) {
    throw new Error("File export ghi chưa đầy đủ. Hãy chọn vị trí khác và thử lại.");
  }
}
