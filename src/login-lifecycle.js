export async function settleWithin(task, timeoutMs) {
  let timeout;
  try {
    return await Promise.race([
      Promise.resolve(task).then(() => true, () => false),
      new Promise((resolve) => {
        timeout = setTimeout(() => resolve(false), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
}
