import "server-only"

import { AsyncLocalStorage } from "node:async_hooks"

type WorkerDatabaseScope = {
  deadline: () => number
  finalDeadline: number
  signal?: AbortSignal
}
const worker = new AsyncLocalStorage<WorkerDatabaseScope>()
const persistence = new AsyncLocalStorage<{
  scope: WorkerDatabaseScope
  deadline: number
}>()

export class WorkerDatabaseDeadlineError extends Error {
  constructor() {
    super("Worker database request deadline reached")
  }
}

export function runWithWorkerDatabaseScope<T>(
  scope: WorkerDatabaseScope,
  work: () => Promise<T>,
): Promise<T> {
  return worker.run(scope, work)
}
export function hasWorkerDatabaseScope(): boolean {
  return Boolean(worker.getStore())
}
export function withWorkerDatabaseNormal<T>(
  work: () => Promise<T>,
): Promise<T> {
  return persistence.exit(work)
}
export function workerDatabaseFinalDeadline(): number | undefined {
  return worker.getStore()?.finalDeadline
}

/** SQL-only allowance for already-owned state; never extends a provider deadline. */
export function workerPersistenceDeadline(): number {
  return Math.min(Date.now() + 5_000, workerDatabaseFinalDeadline() ?? Infinity)
}
export function withWorkerDatabasePersistence<T>(
  deadline: number,
  work: () => PromiseLike<T>,
): Promise<T> {
  const scope = worker.getStore()
  if (!scope) return Promise.resolve(work())
  const inherited = persistence.getStore()
  return persistence.run(
    {
      scope,
      deadline: Math.min(
        deadline,
        scope.finalDeadline,
        inherited?.scope === scope ? inherited.deadline : Infinity,
      ),
    },
    () => Promise.resolve(work()),
  )
}

/** Capture this worker, so a retained client cannot borrow another worker's allowance. */
export function createWorkerDatabaseFetch(
  fetchRequest: typeof fetch = globalThis.fetch,
): typeof fetch {
  const scope = worker.getStore()
  if (!scope) throw new Error("Worker database client requires a worker scope")
  let abortedAuthRefresh = false
  return async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input))
    const method =
      init?.method ?? (input instanceof Request ? input.method : "GET")
    const authRefresh =
      method.toUpperCase() === "POST" &&
      url.pathname === "/auth/v1/token" &&
      url.searchParams.get("grant_type") === "refresh_token"
    // Auth-js internally retries fetch failures. An ambiguous aborted refresh
    // must not be replayed; retain its retryable local error/session semantics.
    if (authRefresh && abortedAuthRefresh)
      throw new WorkerDatabaseDeadlineError()
    if (worker.getStore() !== scope)
      throw new Error("Worker database client used outside its owning scope")
    const allowance = persistence.getStore()
    const deadline = Math.min(
      Date.now() + 10_000,
      scope.finalDeadline,
      allowance?.scope === scope ? allowance.deadline : scope.deadline(),
    )
    const remaining = deadline - Date.now()
    if (remaining <= 0) throw new WorkerDatabaseDeadlineError()
    const controller = new AbortController()
    const caller =
      init?.signal ?? (input instanceof Request ? input.signal : undefined)
    const abortWorker = () => controller.abort(scope.signal?.reason)
    if (scope.signal?.aborted) abortWorker()
    else scope.signal?.addEventListener("abort", abortWorker, { once: true })
    const abort = () => controller.abort(caller?.reason)
    if (caller?.aborted) abort()
    else caller?.addEventListener("abort", abort, { once: true })
    const timer = setTimeout(
      () => controller.abort(new WorkerDatabaseDeadlineError()),
      remaining,
    )
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
    const cancelBody = () => {
      void reader?.cancel(controller.signal.reason).catch(() => {})
    }
    controller.signal.addEventListener("abort", cancelBody, { once: true })
    try {
      controller.signal.throwIfAborted()
      const response = await fetchRequest(input, {
        ...init,
        signal: controller.signal,
      })
      // PostgREST consumes text/JSON internally. Buffer under the same signal so
      // the deadline covers the body too, and a stalled body is cancelled.
      if (!response.body) {
        controller.signal.throwIfAborted()
        return response
      }
      reader = response.body.getReader()
      if (controller.signal.aborted) cancelBody()
      const chunks: Uint8Array[] = []
      let length = 0
      for (;;) {
        controller.signal.throwIfAborted()
        const result = await reader.read()
        controller.signal.throwIfAborted()
        if (result.done) break
        chunks.push(result.value)
        length += result.value.length
      }
      const bytes = new Uint8Array(length)
      let offset = 0
      for (const chunk of chunks) {
        bytes.set(chunk, offset)
        offset += chunk.length
      }
      return new Response(bytes, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      })
    } catch (error) {
      if (authRefresh && controller.signal.aborted) abortedAuthRefresh = true
      throw error
    } finally {
      clearTimeout(timer)
      scope.signal?.removeEventListener("abort", abortWorker)
      caller?.removeEventListener("abort", abort)
      controller.signal.removeEventListener("abort", cancelBody)
      reader?.releaseLock()
    }
  }
}
