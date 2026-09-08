/** Small session-local cache. Invalidations also fence off older in-flight reads. */
export class DailyLogDayCache<T> {
  private entries = new Map<string, { value: T; at: number }>()
  private versions = new Map<string, number>()
  private pending = new Map<string, Promise<T>>()
  constructor(
    date?: string,
    value?: T,
    private ttl = 60_000,
    private capacity = 7,
  ) {
    if (date && value !== undefined) this.set(date, value)
  }
  set(date: string, value: T) {
    this.entries.delete(date)
    this.entries.set(date, { value, at: Date.now() })
    if (this.entries.size > this.capacity) {
      const oldest = this.entries.keys().next().value
      if (oldest) this.entries.delete(oldest)
    }
  }
  invalidate(date: string) {
    this.versions.set(date, (this.versions.get(date) ?? 0) + 1)
    this.entries.delete(date)
  }
  clear() {
    for (const date of new Set([...this.entries.keys(), ...this.pending.keys()])) this.invalidate(date)
  }
  load(date: string, loader: () => Promise<T>, force = false): Promise<T> {
    const hit = this.entries.get(date)
    if (!force && hit && Date.now() - hit.at < this.ttl) return Promise.resolve(hit.value)
    const pending = this.pending.get(date)
    if (pending) return pending
    const request = (async () => {
      for (;;) {
        const version = this.versions.get(date) ?? 0
        const value = await loader()
        if (version !== (this.versions.get(date) ?? 0)) continue
        this.set(date, value)
        return value
      }
    })().finally(() => this.pending.delete(date))
    this.pending.set(date, request)
    return request
  }
}
