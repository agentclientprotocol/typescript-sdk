/**
 * Resolves once `condition` holds, checking every few milliseconds, and
 * rejects if it still does not after `timeoutMs`.
 */
export async function until(
  condition: () => boolean,
  timeoutMs = 1_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;

  while (!condition()) {
    if (Date.now() > deadline) {
      throw new Error("Timed out waiting for condition");
    }

    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
