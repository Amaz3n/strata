"use client"

import {
  finalizeUploadedFileAction,
} from "@/app/(app)/documents/actions"
import type {
  FileWithUrls,
  FinalizeUploadedFileInput,
} from "@/app/(app)/documents/types"

type UploadStage = "preparing" | "uploading" | "finalizing"
type UploadProgress = { loaded: number; total: number; percent: number }

type UploadUrlResponse = {
  storagePath: string
  uploadUrl?: string
  provider: "r2"
}

type MultipartCreateResponse = {
  storagePath: string
  uploadId: string
  provider: "r2"
  partSize: number
}

type MultipartResumeState = {
  storagePath: string
  uploadId: string
  partSize: number
  completedParts: Array<{ partNumber: number; etag: string; size: number }>
}

export type DirectDocumentUploadOptions = Omit<
  FinalizeUploadedFileInput,
  "fileName" | "fileSize" | "mimeType" | "storagePath"
> & {
  projectId: string
  onProgress?: (progress: UploadProgress) => void
  onStage?: (stage: UploadStage) => void
}

const MULTIPART_THRESHOLD = 32 * 1024 * 1024
const MULTIPART_CONCURRENCY = 6
const PART_UPLOAD_ATTEMPTS = 3
const MAX_BROWSER_CHECKSUM_BYTES = 512 * 1024 * 1024

async function calculateFileChecksum(file: File): Promise<string | undefined> {
  if (!globalThis.crypto?.subtle || file.size > MAX_BROWSER_CHECKSUM_BYTES) {
    return undefined
  }
  const digest = await crypto.subtle.digest("SHA-256", await file.arrayBuffer())
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")
}

function detectContentType(file: File): string {
  if (file.type) return file.type

  const extension = file.name.toLowerCase().split(".").pop()
  switch (extension) {
    case "heic":
      return "image/heic"
    case "heif":
      return "image/heif"
    case "mov":
      return "video/quicktime"
    case "mp4":
      return "video/mp4"
    case "m4v":
      return "video/x-m4v"
    case "webm":
      return "video/webm"
    // Office documents: some browsers/OSes report an empty File.type for these,
    // which would otherwise persist as application/octet-stream and break preview detection.
    case "doc":
      return "application/msword"
    case "docx":
      return "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
    case "xls":
      return "application/vnd.ms-excel"
    case "xlsx":
      return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    case "ppt":
      return "application/vnd.ms-powerpoint"
    case "pptx":
      return "application/vnd.openxmlformats-officedocument.presentationml.presentation"
    default:
      return "application/octet-stream"
  }
}

export async function uploadDocumentFileDirect(
  file: File,
  options: DirectDocumentUploadOptions
): Promise<FileWithUrls> {
  const contentType = detectContentType(file)
  const checksum = await calculateFileChecksum(file).catch((error) => {
    console.warn("[documents] Failed to checksum file before upload", error)
    return undefined
  })
  const storagePath =
    file.size >= MULTIPART_THRESHOLD
      ? await uploadMultipart(file, options, contentType)
      : await uploadSinglePart(file, options, contentType)

  options.onStage?.("finalizing")
  const { onProgress: _onProgress, onStage: _onStage, ...finalizeOptions } = options
  return finalizeUploadedFileAction({
    ...finalizeOptions,
    fileName: file.name,
    fileSize: file.size,
    mimeType: contentType,
    checksum,
    storagePath,
  })
}

async function uploadSinglePart(
  file: File,
  options: DirectDocumentUploadOptions,
  contentType: string
): Promise<string> {
  options.onStage?.("preparing")
  const response = await fetch("/api/documents/upload-url", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      projectId: options.projectId,
      fileName: file.name,
      contentType,
    }),
  })

  if (!response.ok) {
    throw new Error("Failed to prepare upload.")
  }

  const payload = (await response.json()) as UploadUrlResponse
  if (!payload.storagePath || !payload.uploadUrl || payload.provider !== "r2") {
    throw new Error("Invalid upload response.")
  }

  options.onStage?.("uploading")
  await uploadBlobWithProgress(
    payload.uploadUrl,
    file,
    contentType,
    (loaded) => {
      options.onProgress?.({
        loaded,
        total: file.size,
        percent: file.size > 0 ? Math.round((loaded / file.size) * 100) : 100,
      })
    }
  )

  return payload.storagePath
}

async function uploadMultipart(
  file: File,
  options: DirectDocumentUploadOptions,
  contentType: string
): Promise<string> {
  options.onStage?.("preparing")
  const resumeKey = getMultipartResumeKey(file, options.projectId)
  const resumedState = loadMultipartResumeState(resumeKey)
  const createPayload = resumedState
    ? {
        storagePath: resumedState.storagePath,
        uploadId: resumedState.uploadId,
        provider: "r2" as const,
        partSize: resumedState.partSize,
      }
    : await createMultipartUpload(file, options, contentType)

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
    options.onProgress?.({
      loaded,
      total: file.size,
      percent: file.size > 0 ? Math.min(99, Math.round((loaded / file.size) * 100)) : 99,
    })
  }

  options.onStage?.("uploading")

  try {
    const uploadPart = async (partNumber: number) => {
      if (completedParts.some((part) => part.partNumber === partNumber && part.etag)) {
        return
      }
      const start = (partNumber - 1) * partSize
      const end = Math.min(start + partSize, file.size)
      const blob = file.slice(start, end)
      const partUrlResponse = await fetch("/api/documents/multipart/part-url", {
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
          etag = await uploadBlobWithProgress(
            uploadUrl,
            blob,
            contentType,
            (loaded) => {
              loadedByPart.set(partNumber, loaded)
              reportProgress()
            }
          )
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
        for (let partNumber = workerIndex + 1; partNumber <= partCount; partNumber += MULTIPART_CONCURRENCY) {
          await uploadPart(partNumber)
        }
      }
    )
    await Promise.all(workers)

    options.onStage?.("finalizing")
    const completeResponse = await fetch("/api/documents/multipart/complete", {
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
    await fetch("/api/documents/multipart/abort", {
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
  file: File,
  options: DirectDocumentUploadOptions,
  contentType: string
): Promise<MultipartCreateResponse> {
  const createResponse = await fetch("/api/documents/multipart/create", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      projectId: options.projectId,
      fileName: file.name,
      contentType,
    }),
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

function getMultipartResumeKey(file: File, projectId: string) {
  return `arc-doc-upload:${projectId}:${file.name}:${file.size}:${file.lastModified}`
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

function uploadBlobWithProgress(
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
