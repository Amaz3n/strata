"use client"

import { startDrawingLifecycleStage } from "@/lib/drawings/lifecycle-metrics"

export type UploadStage = "preparing" | "uploading" | "finalizing"
export type UploadProgress = { loaded: number; total: number; percent: number }
export type TransferState = "idle" | "transferring" | "paused" | "reconciling" | "completion-unknown" | "completed" | "cancelled"
export interface MultipartEndpoints { create: string; partUrl: string; partUrls?: string; status?: string; complete: string; abort: string }
type Part = { partNumber: number; etag: string; size: number }
interface ResumeState { version: 2; identity: string; transferId: string; storagePath: string; uploadId: string; partSize: number; completedParts: Part[]; state: TransferState }
export interface UploadControlOptions {
  /** Abort with reason "cancel" for destructive cancellation; other reasons pause. */
  signal?: AbortSignal
  onState?: (state: TransferState) => void
  controlTimeoutMs?: number
  stallTimeoutMs?: number
  initialTransferId?: string
  initialSession?: { transferId: string; storagePath: string; uploadId: string; partSize: number }
  fingerprint?: string
  retainCompleted?: boolean
  partConcurrency?: number
}
export const MULTIPART_THRESHOLD = 32 * 1024 * 1024
const active = new Set<string>()
class UploadHttpError extends Error { constructor(readonly status: number, message?: string) { super(message || `Upload control request failed (${status})`) } }
const retryable = (error: unknown) => !(error instanceof UploadHttpError) || error.status === 408 || error.status === 429 || error.status >= 500
const abortError = () => new DOMException("Upload paused or cancelled", "AbortError")
const check = (signal?: AbortSignal) => { if (signal?.aborted) throw abortError() }

/** Bounded-memory, order-sensitive SHA-256 chain; deliberately versioned, not a file SHA-256. */
export async function fingerprintUpload(file: Blob, signal?: AbortSignal): Promise<string> {
  let digest = new Uint8Array(32)
  for (let offset = 0; offset < file.size; offset += 4 * 1024 * 1024) {
    check(signal)
    const chunk = new Uint8Array(await file.slice(offset, offset + 4 * 1024 * 1024).arrayBuffer())
    const input = new Uint8Array(digest.length + chunk.length)
    input.set(digest); input.set(chunk, digest.length)
    digest = new Uint8Array(await crypto.subtle.digest("SHA-256", input))
  }
  check(signal)
  return `sha256-chain-v1:${file.size}:${Array.from(digest, b => b.toString(16).padStart(2, "0")).join("")}`
}

export async function uploadControlRequest<T>(url: string, body: unknown, signal?: AbortSignal, timeoutMs = 30_000): Promise<T> {
  check(signal)
  const controller = new AbortController()
  const abort = () => controller.abort()
  signal?.addEventListener("abort", abort, { once: true })
  const timer = setTimeout(abort, timeoutMs)
  try {
    const response = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal: controller.signal })
    if (!response.ok) {
      const failure = await response.json().catch(() => null)
      throw new UploadHttpError(response.status, typeof failure?.error === "string" ? failure.error.slice(0, 300) : undefined)
    }
    return await response.json() as T
  } finally { clearTimeout(timer); signal?.removeEventListener("abort", abort) }
}
function load(key: string): ResumeState | null {
  try {
    const value = JSON.parse(localStorage.getItem(key) || "null")
    return value?.version === 2 && typeof value.identity === "string" && typeof value.transferId === "string" && typeof value.storagePath === "string" && typeof value.uploadId === "string" && Number.isSafeInteger(value.partSize) && value.partSize > 0 && Array.isArray(value.completedParts) ? value : null
  } catch { return null }
}
function save(key: string, value: ResumeState) { try { localStorage.setItem(key, JSON.stringify(value)) } catch { /* Server reconciliation remains authoritative. */ } }
export function clearMultipartResumeState(key: string) { try { localStorage.removeItem(key) } catch { /* Best effort. */ } }
function delay(ms: number, signal?: AbortSignal): Promise<void> {
  check(signal)
  return new Promise((resolve, reject) => {
    const abort = () => { clearTimeout(timer); reject(abortError()) }
    const timer = setTimeout(() => { signal?.removeEventListener("abort", abort); resolve() }, ms)
    signal?.addEventListener("abort", abort, { once: true })
  })
}
export async function runMultipartUpload(options: UploadControlOptions & {
  file: File; contentType: string; endpoints: MultipartEndpoints; createBody: Record<string, unknown>; resumeKey: string
  onProgress?: (progress: UploadProgress) => void; onStage?: (stage: UploadStage) => void
}): Promise<string> {
  const { file, endpoints, resumeKey, signal } = options
  if (active.has(resumeKey)) throw new Error("This upload already has an active owner")
  active.add(resumeKey)
  let transferredBytes = 0
  let transferAttempts = 0
  const finish = startDrawingLifecycleStage("transfer", { operationId: typeof options.createBody.operationId === "string" ? options.createBody.operationId : undefined })
  const owner = new AbortController()
  const abort = () => owner.abort()
  signal?.addEventListener("abort", abort, { once: true })
  let state: ResumeState | null = null
  const transition = (next: TransferState) => { if (state) { state.state = next; save(resumeKey, state) }; options.onState?.(next) }
  const request = async <T>(url: string, body: unknown): Promise<T> => {
    for (let attempt = 0; ; attempt++) {
      try { return await uploadControlRequest<T>(url, body, owner.signal, options.controlTimeoutMs) }
      catch (error) {
        if (owner.signal.aborted || !retryable(error) || attempt >= 2) throw error
        await delay(250 * 2 ** attempt + Math.random() * 200, owner.signal)
      }
    }
  }
  const completed = () => {
    finish("success", { bytesTransferred: transferredBytes, attempts: transferAttempts })
    transition("completed")
    options.onProgress?.({ loaded: file.size, total: file.size, percent: 100 })
    if (!options.retainCompleted) clearMultipartResumeState(resumeKey)
  }
  const sessionBody = () => ({ storagePath: state!.storagePath, uploadId: state!.uploadId, transferId: state!.transferId, identity: state!.identity, fileSize: file.size })
  const reconcile = async () => {
    if (!endpoints.status) return false
    transition("reconciling")
    const remote = await request<{ state: "uploading" | "completed" | "unknown"; parts?: Part[] }>(endpoints.status, sessionBody())
    if (remote.state === "completed") { completed(); return true }
    if (remote.state !== "uploading") throw new Error("Upload completion is unknown; retain this session for reconciliation")
    state!.completedParts = (remote.parts ?? []).filter(p => Number.isInteger(p.partNumber) && p.partNumber > 0 && p.partNumber <= Math.ceil(file.size / state!.partSize) && typeof p.etag === "string" && !!p.etag.trim() && p.size === Math.min(state!.partSize, file.size - (p.partNumber - 1) * state!.partSize))
    return false
  }
  try {
    check(signal)
    options.onStage?.("preparing")
    const identity = options.fingerprint ?? await fingerprintUpload(file, owner.signal)
    state = load(resumeKey)
    if (!state && options.initialSession) state = { ...options.initialSession, version: 2, identity, completedParts: [], state: "paused" }
    if (state && state.identity !== identity) throw new Error("The selected file does not match the saved upload")
    if (!state) {
      state = { version: 2, identity, transferId: options.initialTransferId ?? crypto.randomUUID(), storagePath: "", uploadId: "", partSize: 1, completedParts: [], state: "idle" }
      save(resumeKey, state)
    }
    if (!state.uploadId) {
      const transferId = state.transferId
      const created = await request<{ storagePath: string; uploadId: string; partSize: number; provider: string }>(endpoints.create, { ...options.createBody, transferId, identity, fileSize: file.size })
      if (created.provider !== "r2" || !created.storagePath || !created.uploadId || !Number.isSafeInteger(created.partSize) || created.partSize < 1 || Math.ceil(file.size / created.partSize) > 10000) throw new Error("Invalid multipart upload response")
      state = { ...created, version: 2, identity, transferId, completedParts: [], state: "idle" }
      save(resumeKey, state)
    } else if (await reconcile()) return state.storagePath
    else if (!endpoints.status) {
      // Legacy document endpoints have no reconciliation: retransmit instead of trusting local hints.
      state.completedParts = []
    }
    const partCount = Math.ceil(file.size / state.partSize)
    const loaded = new Map(state.completedParts.map(p => [p.partNumber, p.size]))
    const report = () => { const bytes = [...loaded.values()].reduce((a, b) => a + b, 0); options.onProgress?.({ loaded: bytes, total: file.size, percent: Math.min(99, Math.round(bytes / Math.max(1, file.size) * 100)) }) }
    transition("transferring"); options.onStage?.("uploading"); report()
    const pending = Array.from({ length: partCount }, (_, i) => i + 1).filter(n => !state!.completedParts.some(p => p.partNumber === n))
    // Sign at most sixteen parts at a time, and execute at most six PUTs.
    for (let offset = 0; offset < pending.length; offset += 16) {
      check(owner.signal)
      const batch = pending.slice(offset, offset + 16)
      const urls = new Map<number, string>()
      if (endpoints.partUrls) {
        const result = await request<{ parts: { partNumber: number; uploadUrl: string }[] }>(endpoints.partUrls, { ...sessionBody(), partNumbers: batch })
        for (const part of result.parts) urls.set(part.partNumber, part.uploadUrl)
      }
      let index = 0
      let failure: unknown
      const workers = Array.from({ length: Math.min(Math.max(1, Math.min(6, options.partConcurrency ?? 6)), batch.length) }, async () => {
        try {
          while (index < batch.length) {
            check(owner.signal)
            const partNumber = batch[index++]
            const blob = file.slice((partNumber - 1) * state!.partSize, Math.min(partNumber * state!.partSize, file.size))
            for (let attempt = 0; attempt < 3; attempt++) {
              try {
                check(owner.signal)
                const uploadUrl = attempt === 0 && urls.get(partNumber) || (await request<{ uploadUrl: string }>(endpoints.partUrl, { ...sessionBody(), partNumber })).uploadUrl
                if (!uploadUrl) throw new Error("Missing part URL")
                let attemptLoaded = 0
                transferAttempts++
                const etag = await uploadBlobWithProgress(uploadUrl, blob, options.contentType, bytes => { transferredBytes += Math.max(0, bytes - attemptLoaded); attemptLoaded = bytes; loaded.set(partNumber, bytes); report() }, { signal: owner.signal, stallTimeoutMs: options.stallTimeoutMs })
                if (!etag.trim()) throw new Error("Storage did not return an ETag")
                check(owner.signal)
                transferredBytes += Math.max(0, blob.size - attemptLoaded)
                state!.completedParts.push({ partNumber, etag, size: blob.size }); loaded.set(partNumber, blob.size)
                save(resumeKey, state!); report(); break
              } catch (error) {
                loaded.set(partNumber, 0); report()
                if (owner.signal.aborted || !retryable(error) || attempt === 2) throw error
                await delay(250 * 2 ** attempt + Math.random() * 200, owner.signal)
              }
            }
          }
        } catch (error) { failure ??= error; owner.abort() }
      })
      await Promise.allSettled(workers)
      if (failure) throw failure
    }
    check(owner.signal)
    options.onStage?.("finalizing"); transition("completion-unknown")
    try {
      await request(endpoints.complete, { ...sessionBody(), parts: state.completedParts.sort((a, b) => a.partNumber - b.partNumber).map(({ partNumber, etag }) => ({ partNumber, etag })) })
    } catch (error) {
      if (!owner.signal.aborted && await reconcile()) return state.storagePath
      transition("completion-unknown"); throw error
    }
    completed()
    return state.storagePath
  } catch (error) {
    finish(signal?.reason === "cancel" ? "cancelled" : "failure", { bytesTransferred: transferredBytes, attempts: transferAttempts })
    if (state?.uploadId && signal?.aborted && signal.reason === "cancel" && state.state !== "completion-unknown" && state.state !== "completed") {
      // Workers are already settled before reaching this branch. Keep the receipt if abort fails.
      await uploadControlRequest(endpoints.abort, sessionBody(), undefined, options.controlTimeoutMs)
      transition("cancelled"); clearMultipartResumeState(resumeKey)
    } else if (state && state.state !== "completion-unknown" && state.state !== "completed") transition("paused")
    throw error
  } finally { owner.abort(); signal?.removeEventListener("abort", abort); active.delete(resumeKey) }
}

export function uploadBlobWithProgress(url: string, blob: Blob, contentType: string, onProgress?: (loaded: number) => void, options: Pick<UploadControlOptions, "signal" | "stallTimeoutMs"> & { headers?: Record<string, string> } = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    if (options.signal?.aborted) { reject(abortError()); return }
    const xhr = new XMLHttpRequest()
    let settled = false
    let timer: ReturnType<typeof setTimeout>
    const finish = (error?: Error, etag = "") => { if (settled) return; settled = true; clearTimeout(timer); options.signal?.removeEventListener("abort", abort); error ? reject(error) : resolve(etag) }
    const abort = () => { finish(abortError()); xhr.abort() }
    const arm = () => { clearTimeout(timer); timer = setTimeout(() => { finish(new Error("Upload stalled")); xhr.abort() }, options.stallTimeoutMs ?? 60_000) }
    xhr.open("PUT", url); xhr.setRequestHeader("Content-Type", contentType)
    for (const [name, value] of Object.entries(options.headers ?? {})) xhr.setRequestHeader(name, value)
    let lastLoaded = 0
    xhr.upload.onprogress = event => { if (settled) return; if (event.loaded > lastLoaded) { lastLoaded = event.loaded; arm() }; if (event.lengthComputable) onProgress?.(Math.min(event.loaded, Math.max(blob.size - 1, 0))) }
    xhr.onload = () => xhr.status >= 200 && xhr.status < 300 ? finish(undefined, xhr.getResponseHeader("ETag") ?? xhr.getResponseHeader("etag") ?? "") : finish(new Error(`Upload failed with status ${xhr.status}`))
    xhr.onerror = () => finish(new Error("Upload failed")); xhr.onabort = () => finish(abortError())
    options.signal?.addEventListener("abort", abort, { once: true }); arm(); xhr.send(blob)
  })
}
