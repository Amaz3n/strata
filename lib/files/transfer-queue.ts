export type TransferStatus = "queued" | "uploading" | "paused" | "failed" | "completed" | "cancelled"

export interface TransferEntry<Options, Result> {
  id: string
  file: File
  options: Options
  status: TransferStatus
  progress: number
  stage: "preparing" | "uploading" | "finalizing"
  error?: string
  result?: Result
}

type Entry<O, R> = TransferEntry<O, R>
export interface TransferQueueDependencies<O, R> {
  load: () => Promise<Entry<O, R>[]>
  save: (entry: Entry<O, R>) => Promise<void>
  remove: (id: string) => Promise<void>
  run: (entry: Entry<O, R>, signal: AbortSignal, update: (patch: Partial<Entry<O, R>>) => void,
    checkpoint: (result: R) => Promise<void>) => Promise<R>
  cancel?: (entry: Entry<O, R>) => Promise<void>
  completed?: (entry: Entry<O, R>) => void
}

/** The queue owns work, not the initiating page. Journals survive reloads;
 * restored entries start paused so a new session never silently uploads files. */
export class TransferQueue<O, R> {
  private entries: Entry<O, R>[] = []
  private listeners = new Set<() => void>()
  private controllers = new Map<string, AbortController>()
  private writes = new Map<string, Promise<void>>()
  private enabled = false
  private initialized?: Promise<void>
  private waiters = new Map<string, { resolve: (result: R) => void; reject: (error: Error) => void }>()

  constructor(private readonly deps: TransferQueueDependencies<O, R>, private readonly concurrency = 2) {}
  getSnapshot = () => this.entries
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  private publish() { for (const listener of this.listeners) listener() }
  private patch(id: string, patch: Partial<Entry<O, R>>) {
    this.entries = this.entries.map(entry => entry.id === id ? { ...entry, ...patch } : entry)
    this.publish()
  }
  private write(id: string, operation: () => Promise<void>) {
    const pending = (this.writes.get(id) ?? Promise.resolve()).catch(() => {}).then(operation)
    this.writes.set(id, pending)
    return pending
  }
  async start() {
    this.enabled = true
    this.initialized ??= this.deps.load().then(entries => {
      this.entries = entries.filter(entry => entry.status !== "completed" && entry.status !== "cancelled")
        .map(entry => ({ ...entry, status: "paused" as const }))
      this.publish()
    }).catch(() => { /* New uploads still work; enqueue reports storage errors. */ })
    await this.initialized
    this.pump()
  }
  stop() {
    this.enabled = false
    for (const entry of this.entries) if (entry.status === "uploading") this.pause(entry.id)
  }
  async enqueue(file: File, options: O): Promise<R> {
    return (await this.submit(file, options)).completion
  }
  async submit(file: File, options: O): Promise<{ id: string; completion: Promise<R> }> {
    await this.initialized
    if (!this.enabled) throw new Error("The upload queue is unavailable. Refresh and try again.")
    const entry: Entry<O, R> = { id: crypto.randomUUID(), file, options, status: "queued", progress: 0, stage: "preparing" }
    await this.write(entry.id, () => this.deps.save(entry))
    this.entries = [...this.entries, entry]
    const completion = new Promise<R>((resolve, reject) => this.waiters.set(entry.id, { resolve, reject }))
    // Submission and completion are separate: pages may close after journaling.
    void completion.catch(() => {})
    this.publish()
    this.pump()
    return { id: entry.id, completion }
  }
  pause(id: string) {
    const entry = this.entries.find(item => item.id === id)
    if (!entry || entry.stage === "finalizing" || !["queued", "uploading"].includes(entry.status)) return
    this.patch(id, { status: "paused" })
    this.controllers.get(id)?.abort("pause")
    void this.write(id, () => this.deps.save({ ...entry, status: "paused" })).catch(error => this.storageError(id, error))
  }
  async retry(id: string) {
    const entry = this.entries.find(item => item.id === id)
    if (!entry || !["failed", "paused"].includes(entry.status) || this.controllers.has(id)) return
    await this.write(id, () => this.deps.save({ ...entry, status: "queued", error: undefined }))
    this.patch(id, { status: "queued", error: undefined })
    this.pump()
  }
  async cancel(id: string) {
    const entry = this.entries.find(item => item.id === id)
    if (!entry || (entry.stage === "finalizing" && entry.status === "uploading") || ["completed", "cancelled"].includes(entry.status)) return
    this.patch(id, { status: "cancelled" })
    this.controllers.get(id)?.abort("cancel")
    try {
      if (!entry.result) await this.deps.cancel?.(entry)
      await this.write(id, () => this.deps.remove(id))
    } catch (error) {
      this.patch(id, { status: "failed", error: "Cancellation could not be confirmed. Retry when connected." })
      throw error
    }
    this.patch(id, { file: new File([], entry.file.name, { type: entry.file.type }) })
    this.waiters.get(id)?.reject(new Error("Upload cancelled"))
    this.waiters.delete(id)
  }
  dismissFinished() {
    this.entries = this.entries.filter(entry => !["completed", "cancelled"].includes(entry.status))
    this.publish()
  }
  private storageError(id: string, error: unknown) {
    this.patch(id, { error: error instanceof Error ? error.message : "Could not save upload progress on this device." })
  }
  private pump() {
    if (!this.enabled) return
    while (this.controllers.size < this.concurrency) {
      const entry = this.entries.find(item => item.status === "queued" && !this.controllers.has(item.id))
      if (!entry) break
      const controller = new AbortController()
      this.controllers.set(entry.id, controller)
      this.patch(entry.id, { status: "uploading", error: undefined })
      void this.run(entry, controller)
    }
  }
  private async run(entry: Entry<O, R>, controller: AbortController) {
    try {
      const result = await this.deps.run(entry, controller.signal,
        patch => this.patch(entry.id, patch), async result => {
          this.patch(entry.id, { result })
          const current = this.entries.find(item => item.id === entry.id)
          if (!current) return
          await this.write(entry.id, () => this.deps.save(current))
        })
      this.patch(entry.id, { result, status: "completed", progress: 100 })
      // A committed upload remains successful even if local journal cleanup fails.
      await this.write(entry.id, () => this.deps.remove(entry.id)).catch(error => this.storageError(entry.id, error))
      this.waiters.get(entry.id)?.resolve(result)
      this.waiters.delete(entry.id)
      this.deps.completed?.({ ...entry, result, status: "completed", progress: 100 })
      this.patch(entry.id, { file: new File([], entry.file.name, { type: entry.file.type }) })
    } catch (error) {
      const current = this.entries.find(item => item.id === entry.id)
      if (!current) return
      if (current.status !== "cancelled") {
        const status = controller.signal.aborted ? "paused" : "failed"
        const message = status === "paused" ? undefined : error instanceof Error ? error.message : "Upload failed"
        this.patch(entry.id, { status, error: message })
        await this.write(entry.id, () => this.deps.save({ ...current, status, error: message })).catch(error => this.storageError(entry.id, error))
        if (status === "failed") {
          this.waiters.get(entry.id)?.reject(error instanceof Error ? error : new Error(message))
          this.waiters.delete(entry.id)
        }
      }
    } finally {
      this.controllers.delete(entry.id)
      this.pump()
    }
  }
}
