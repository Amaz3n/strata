"use client"

/**
 * Shared browser-side upload engine for direct-to-R2 uploads: XHR PUTs with
 * byte progress, multipart uploads with bounded concurrency, per-part retry,
 * and localStorage resume state. Feature clients (documents, drawings) supply
 * their own endpoints and create-request body.
 */

export type UploadStage = "preparing" | "uploading" | "finalizing"
export type UploadProgress = { loaded: number; total: number; percent: number }

export interface MultipartEndpoints {
  create: string
  partUrl: string
  complete: string
  abort: string
}

interface MultipartCreateResponse {
  storagePath: string
  uploadId: string
  provider: "r2"
  partSize: number
}

interface MultipartResumeState {
  storagePath: string
  uploadId: string
  partSize: number
  completedParts: Array<{ partNumber: number; etag: string; size: number }>
}

export const MULTIPART_THRESHOLD = 32 * 1024 * 1024
const MULTIPART_CONCURRENCY = 6
const PART_UPLOAD_ATTEMPTS = 3

export async function runMultipartUpload(options: {
  file: File
  contentType: string
  endpoints: MultipartEndpoints
  createBody: Record<string, unknown>
  resumeKey: string
  onProgress?: (progress: UploadProgress) => void
  onStage?: (stage: UploadStage) => void
}): Promise<string> {
  const { file, contentType, endpoints, createBody, resumeKey, onProgress, onStage } = options

  onStage?.("preparing")
  const resumedState = loadMultipartResumeState(resumeKey)
  const createPayload: MultipartCreateResponse = resumedState
    ? {
        storagePath: resumedState.storagePath,
        uploadId: resumedState.uploadId,
        provider: "r2",
        partSize: resumedState.partSize,
      }
    : await createMultipartUpload(endpoints.create, createBody)

  const partSize = createPayload.partSize || 16 * 1024 * 1024
  const partCount = Math.ceil(file.size / partSize)
  const loadedByPart = new Map<number, number>()
  const completedParts: Array<{ partNumber: number; etag: string; size: number }> =
    resumedState?.completedParts ?? []
  for (const part of completedParts) {
    loadedByPart.set(part.partNumber, part.size)
  }

  const reportProgress = () => {
    const loaded = Array.from(loadedByPart.values()).reduce((sum, value) => sum + value, 0)
    onProgress?.({
      loaded,
      total: file.size,
      percent: file.size > 0 ? Math.min(99, Math.round((loaded / file.size) * 100)) : 99,
    })
  }

  onStage?.("uploading")

  try {
    const uploadPart = async (partNumber: number) => {
      if (completedParts.some((part) => part.partNumber === partNumber && part.etag)) {
        return
      }
      const start = (partNumber - 1) * partSize
      const end = Math.min(start + partSize, file.size)
      const blob = file.slice(start, end)
      const partUrlResponse = await fetch(endpoints.partUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          storagePath: createPayload.storagePath,
          uploadId: createPayload.uploadId,
          partNumber,
        }),
      })

      if (!partUrlResponse.ok) {
        throw new Error(`Failed to prepare part ${partNumber}.`)
      }

      const { uploadUrl } = (await partUrlResponse.json()) as { uploadUrl?: string }
      if (!uploadUrl) {
        throw new Error(`Invalid part ${partNumber} upload URL.`)
      }

      let etag = ""
      for (let attempt = 1; attempt <= PART_UPLOAD_ATTEMPTS; attempt += 1) {
        try {
          etag = await uploadBlobWithProgress(uploadUrl, blob, contentType, (loaded) => {
            loadedByPart.set(partNumber, loaded)
            reportProgress()
          })
          break
        } catch (error) {
          loadedByPart.set(partNumber, 0)
          reportProgress()
          if (attempt === PART_UPLOAD_ATTEMPTS) throw error
          await new Promise((resolve) => setTimeout(resolve, attempt * 500))
        }
      }
      loadedByPart.set(partNumber, blob.size)
      completedParts.push({ partNumber, etag, size: blob.size })
      saveMultipartResumeState(resumeKey, {
        storagePath: createPayload.storagePath,
        uploadId: createPayload.uploadId,
        partSize,
        completedParts,
      })
      reportProgress()
    }

    const workers = Array.from(
      { length: Math.min(MULTIPART_CONCURRENCY, partCount) },
      async (_, workerIndex) => {
        for (
          let partNumber = workerIndex + 1;
          partNumber <= partCount;
          partNumber += MULTIPART_CONCURRENCY
        ) {
          await uploadPart(partNumber)
        }
      }
    )
    await Promise.all(workers)

    onStage?.("finalizing")
    const completeResponse = await fetch(endpoints.complete, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        storagePath: createPayload.storagePath,
        uploadId: createPayload.uploadId,
        parts: completedParts.map(({ partNumber, etag }) => ({ partNumber, etag })),
      }),
    })

    if (!completeResponse.ok) {
      throw new Error("Failed to complete multipart upload.")
    }

    clearMultipartResumeState(resumeKey)
    return createPayload.storagePath
  } catch (error) {
    await fetch(endpoints.abort, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        storagePath: createPayload.storagePath,
        uploadId: createPayload.uploadId,
      }),
    }).catch(() => undefined)
    clearMultipartResumeState(resumeKey)
    throw error
  }
}

async function createMultipartUpload(
  createUrl: string,
  createBody: Record<string, unknown>
): Promise<MultipartCreateResponse> {
  const createResponse = await fetch(createUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(createBody),
  })

  if (!createResponse.ok) {
    throw new Error("Failed to prepare multipart upload.")
  }

  const createPayload = (await createResponse.json()) as MultipartCreateResponse
  if (!createPayload.storagePath || !createPayload.uploadId || createPayload.provider !== "r2") {
    throw new Error("Invalid multipart upload response.")
  }

  return createPayload
}

function loadMultipartResumeState(key: string): MultipartResumeState | null {
  try {
    const raw = localStorage.getItem(key)
    if (!raw) return null
    const parsed = JSON.parse(raw) as MultipartResumeState
    if (!parsed.storagePath || !parsed.uploadId || !parsed.partSize) return null
    return parsed
  } catch {
    return null
  }
}

function saveMultipartResumeState(key: string, state: MultipartResumeState) {
  try {
    localStorage.setItem(key, JSON.stringify(state))
  } catch {
    // Resume state is best effort.
  }
}

function clearMultipartResumeState(key: string) {
  try {
    localStorage.removeItem(key)
  } catch {
    // Resume state is best effort.
  }
}

export function uploadBlobWithProgress(
  url: string,
  blob: Blob,
  contentType: string,
  onProgress?: (loaded: number) => void
): Promise<string> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    xhr.open("PUT", url)
    xhr.setRequestHeader("Content-Type", contentType)
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) {
        onProgress?.(Math.min(event.loaded, Math.max(blob.size - 1, 0)))
      }
    }
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        const etag = xhr.getResponseHeader("ETag") ?? xhr.getResponseHeader("etag")
        resolve(etag ?? "")
      } else {
        reject(new Error(`Upload failed with status ${xhr.status}`))
      }
    }
    xhr.onerror = () => reject(new Error("Upload failed"))
    xhr.onabort = () => reject(new Error("Upload aborted"))
    xhr.send(blob)
  })
}
