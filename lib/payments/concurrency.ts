/**
 * Bounded-concurrency map for provider calls.
 *
 * Payment code fans out over provider APIs in two places — resolving the charges
 * behind a payout, and retrieving settlement for every disbursement in a
 * reconciliation period. Both were serial, which is slow, and both are tempting
 * to write as `Promise.all`, which is worse: a few hundred simultaneous requests
 * hits provider rate limits and turns a recoverable page into a failed one.
 *
 * Results keep input order so callers can zip them back against their source.
 * Rejections propagate — a provider call that fails must fail the sweep, never
 * silently drop the item it was resolving.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  map: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (!Number.isInteger(limit) || limit < 1) throw new Error("Concurrency limit must be a positive integer")
  const results = new Array<R>(items.length)
  let cursor = 0
  const worker = async () => {
    for (;;) {
      const index = cursor
      cursor += 1
      if (index >= items.length) return
      results[index] = await map(items[index], index)
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return results
}
