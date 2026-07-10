"use client"

/**
 * Client-side upload utilities for drawings. Uploads go directly to R2 with
 * byte-level progress; large plan sets use multipart with per-part retry and
 * localStorage resume, so a flaky job-site connection re-uploads one 16MB
 * part instead of the whole set.
 */

import {
  MULTIPART_THRESHOLD,
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

export type DrawingUploadOptions = {
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

  if (useAppProxy) {
    return uploadViaAppProxy(file, projectId, options)
  }

  if (file.size >= MULTIPART_THRESHOLD) {
    options.onStage?.("preparing")
    const storagePath = await runMultipartUpload({
      file,
      contentType: file.type || "application/pdf",
      endpoints: {
        create: "/api/drawings/multipart/create",
        partUrl: "/api/drawings/multipart/part-url",
        complete: "/api/drawings/multipart/complete",
        abort: "/api/drawings/multipart/abort",
      },
      createBody: {
        projectId,
        fileName: file.name,
        contentType: file.type || "application/pdf",
      },
      resumeKey: `arc-drawing-upload:${projectId}:${file.name}:${file.size}:${file.lastModified}`,
      onProgress: options.onProgress,
      onStage: options.onStage,
    })
    return { storagePath }
  }

  options.onStage?.("preparing")
  const response = await fetch("/api/drawings/upload-url", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      projectId,
      fileName: file.name,
      contentType: file.type,
    }),
  })

  if (!response.ok) {
    throw new Error("Failed to prepare upload.")
  }

  const payload = (await response.json()) as UploadUrlResponse
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
  })

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
    const formData = new FormData()
    formData.append("projectId", projectId)
    formData.append("file", file)

    const xhr = new XMLHttpRequest()
    xhr.open("POST", "/api/drawings/upload-file")
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) {
        options.onProgress?.({
          loaded: event.loaded,
          total: event.total,
          percent: event.total > 0 ? Math.round((event.loaded / event.total) * 100) : 100,
        })
      }
    }
    xhr.onload = () => {
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
    xhr.onerror = () => reject(new Error("Failed to upload file to storage."))
    xhr.onabort = () => reject(new Error("Upload aborted"))
    xhr.send(formData)
  })
}
