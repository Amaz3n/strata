/** Keep each slot busy; one slow item never stalls unrelated work in its batch. */
export async function parallelWork<T>(items: readonly T[], limit: number, work: (item: T) => Promise<void>) {
  const capacity = Number.isFinite(limit) ? Math.max(1, Math.floor(limit)) : 1
  let next = 0
  let failed = false
  const results = await Promise.allSettled(Array.from({ length: Math.min(capacity, items.length) }, async () => {
    while (!failed && next < items.length) {
      const item = items[next++]
      try { await work(item) }
      catch (error) { failed = true; throw error }
    }
  }))
  const failure = results.find(result => result.status === "rejected")
  if (failure?.status === "rejected") throw failure.reason
}
