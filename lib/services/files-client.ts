"use client"

import {
  finalizeUploadedFileAction,
} from "@/app/(app)/documents/actions"
import type {
  FileWithUrls,
  FinalizeUploadedFileInput,
} from "@/app/(app)/documents/types"

import { unwrapAction } from "@/lib/action-result"
import {
  MULTIPART_THRESHOLD,
  runMultipartUpload,
  uploadBlobWithProgress,
  type UploadProgress,
  type UploadStage,
} from "@/lib/services/multipart-upload-client"

type UploadUrlResponse = {
  storagePath: string
  uploadUrl?: string
  provider: "r2"
}

export type DirectDocumentUploadOptions = Omit<
  FinalizeUploadedFileInput,
  "fileName" | "fileSize" | "mimeType" | "storagePath"
> & {
  projectId: string
  onProgress?: (progress: UploadProgress) => void
  onStage?: (stage: UploadStage) => void
}

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
      ? await runMultipartUpload({
          file,
          contentType,
          endpoints: {
            create: "/api/documents/multipart/create",
            partUrl: "/api/documents/multipart/part-url",
            complete: "/api/documents/multipart/complete",
            abort: "/api/documents/multipart/abort",
          },
          createBody: {
            projectId: options.projectId,
            fileName: file.name,
            contentType,
          },
          resumeKey: `arc-doc-upload:${options.projectId}:${file.name}:${file.size}:${file.lastModified}`,
          onProgress: options.onProgress,
          onStage: options.onStage,
        })
      : await uploadSinglePart(file, options, contentType)

  options.onStage?.("finalizing")
  const { onProgress: _onProgress, onStage: _onStage, ...finalizeOptions } = options
  return unwrapAction(await finalizeUploadedFileAction({
    ...finalizeOptions,
    fileName: file.name,
    fileSize: file.size,
    mimeType: contentType,
    checksum,
    storagePath,
  }))
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
