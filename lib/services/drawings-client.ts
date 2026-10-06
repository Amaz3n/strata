"use client"

/**
 * Client-side upload utilities for drawings. Uploads go directly to R2 with
 * byte-level progress; large plan sets use multipart with per-part retry and
 * localStorage resume, so a flaky job-site connection re-uploads one 16MB
 * part instead of the whole set.
 */

import {
  MULTIPART_THRESHOLD,
  uploadControlRequest,
  clearMultipartResumeState,
  type UploadControlOptions,
  runMultipartUpload,
  uploadBlobWithProgress,
  type UploadProgress,
  type UploadStage,
} from "@/lib/services/multipart-upload-client"

type UploadUrlResponse = {
  storagePath: string
  uploadUrl: string
  provider: "r2"
}

export type DrawingUploadOptions = UploadControlOptions & {
  operationId?: string
  generation?: string
  onProgress?: (progress: UploadProgress) => void
  onStage?: (stage: UploadStage) => void
}

export async function uploadDrawingFileToStorage(
  file: File,
  projectId: string,
  orgId?: string,
  options: DrawingUploadOptions = {}
): Promise<{ storagePath: string }> {
  const hostname =
    typeof window !== "undefined" ? window.location.hostname.toLowerCase() : ""
  const useAppProxy =
    hostname === "localhost" || hostname === "127.0.0.1" || hostname.endsWith(".local")

  if (useAppProxy && !options.operationId) {
    return uploadViaAppProxy(file, projectId, options)
  }

  if (options.operationId || file.size >= MULTIPART_THRESHOLD) {
    options.onStage?.("preparing")
    const storagePath = await runMultipartUpload({
      file,
      contentType: file.type || "application/pdf",
      endpoints: {
        create: "/api/drawings/multipart/create",
        partUrl: "/api/drawings/multipart/part-url",
        partUrls: "/api/drawings/multipart/part-urls",
        status: "/api/drawings/multipart/status",
        complete: "/api/drawings/multipart/complete",
        abort: "/api/drawings/multipart/abort",
      },
      createBody: {
        projectId,
        operationId: options.operationId,
        generation: options.generation,
        fileName: file.name,
        contentType: file.type || "application/pdf",
      },
      resumeKey: drawingUploadResumeKey(file, projectId, orgId, options.operationId, options.generation),
      initialTransferId: options.initialTransferId,
      initialSession: options.initialSession,
      fingerprint: options.fingerprint,
      signal: options.signal,
      onState: options.onState,
      controlTimeoutMs: options.controlTimeoutMs,
      stallTimeoutMs: options.stallTimeoutMs,
      retainCompleted: true,
      onProgress: options.onProgress,
      onStage: options.onStage,
    })
    return { storagePath }
  }

  options.onStage?.("preparing")
  const payload = await uploadControlRequest<UploadUrlResponse>("/api/drawings/upload-url", {
    projectId, operationId: options.operationId, fileSize: file.size,
    fileName: file.name, contentType: file.type || "application/pdf",
  }, options.signal, options.controlTimeoutMs)
  const storagePath = payload?.storagePath

  if (!storagePath || !payload?.provider) {
    throw new Error("Invalid upload response.")
  }

  if (payload.provider !== "r2") {
    throw new Error("R2 uploads are required for drawings.")
  }

  options.onStage?.("uploading")
  await uploadBlobWithProgress(payload.uploadUrl, file, file.type, (loaded) => {
    options.onProgress?.({
      loaded,
      total: file.size,
      percent: file.size > 0 ? Math.round((loaded / file.size) * 100) : 100,
    })
  }, options)
  options.onState?.("completed")

  return { storagePath }
}

/**
 * Localhost/dev path: presigned R2 URLs aren't CORS-reachable from local
 * hosts, so the file streams through the app route instead.
 */
function uploadViaAppProxy(
  file: File,
  projectId: string,
  options: DrawingUploadOptions
): Promise<{ storagePath: string }> {
  options.onStage?.("uploading")
  return new Promise((resolve, reject) => {
    if (options.signal?.aborted) { reject(new DOMException("Upload paused", "AbortError")); return }
    const formData = new FormData()
    formData.append("projectId", projectId)
    if (options.operationId) formData.append("operationId", options.operationId)
    formData.append("file", file)

    const xhr = new XMLHttpRequest()
    xhr.open("POST", "/api/drawings/upload-file")
    const abort = () => xhr.abort()
    const clear = () => { clearTimeout(timer); options.signal?.removeEventListener("abort", abort) }
    let lastLoaded = 0
    let timer: ReturnType<typeof setTimeout>
    const arm = () => { clearTimeout(timer); timer = setTimeout(() => xhr.abort(), options.stallTimeoutMs ?? 60_000) }
    options.signal?.addEventListener("abort", abort, { once: true })
    arm()
    xhr.upload.onprogress = (event) => {
      if (event.loaded > lastLoaded) { lastLoaded = event.loaded; arm() }
      if (event.lengthComputable) {
        options.onProgress?.({
          loaded: event.loaded,
          total: event.total,
          percent: event.total > 0 ? Math.min(99, Math.round((event.loaded / event.total) * 100)) : 100,
        })
      }
    }
    xhr.onload = () => {
      clear()
      if (xhr.status < 200 || xhr.status >= 300) {
        reject(new Error("Failed to upload file to storage."))
        return
      }
      try {
        const payload = JSON.parse(xhr.responseText) as { storagePath?: string }
        if (!payload?.storagePath) {
          reject(new Error("Invalid upload response."))
          return
        }
        resolve({ storagePath: payload.storagePath })
      } catch {
        reject(new Error("Invalid upload response."))
      }
    }
    xhr.onerror = () => { clear(); reject(new Error("Failed to upload file to storage.")) }
    xhr.onabort = () => { clear(); reject(new DOMException("Upload paused or cancelled", "AbortError")) }
    xhr.send(formData)
  })
}

export function drawingUploadResumeKey(file: File, projectId: string, orgId?: string, operationId?: string, generation?: string) {
  return `arc-drawing-upload:v2:${orgId ?? "current"}:${projectId}:${operationId ?? `${file.name}:${file.size}:${file.lastModified}`}:${generation ?? "legacy"}`
}
/** Call only after durable registration acknowledges the completed transfer. */
export function acknowledgeDrawingUpload(file: File, projectId: string, orgId?: string, operationId?: string, generation?: string) {
  clearMultipartResumeState(drawingUploadResumeKey(file, projectId, orgId, operationId, generation))
}
