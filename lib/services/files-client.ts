"use client"

import { finalizeUploadedFileAction, finalizeUploadedFileVersionAction } from "@/app/(app)/documents/actions"
import type { FileWithUrls, FinalizeUploadedFileInput } from "@/app/(app)/documents/types"
import type { FileVersion } from "@/lib/services/file-versions"
import { unwrapAction } from "@/lib/action-result"
import { hashDocumentUpload } from "@/lib/files/upload-fingerprint"
import { validateDocumentUpload } from "@/lib/files/content-policy"
import {
  MULTIPART_THRESHOLD, runMultipartUpload, uploadBlobWithProgress, uploadControlRequest, clearMultipartResumeState,
  type UploadProgress, type UploadStage, type UploadControlOptions,
} from "@/lib/services/multipart-upload-client"

type TransferOptions = Pick<UploadControlOptions, "signal" | "onState"> & {
  /** Omitted for the organization document library. */
  projectId?: string
  transferId?: string
  onProgress?: (progress: UploadProgress) => void
  onStage?: (stage: UploadStage) => void
}
export type DirectDocumentUploadOptions = Omit<FinalizeUploadedFileInput, "fileName" | "fileSize" | "mimeType" | "storagePath"> & TransferOptions
export type DirectDocumentVersionOptions = TransferOptions & { fileId: string; label?: string; notes?: string }

type Receipt = { transferId: string; fingerprint: string; storagePath?: string }
const active = new Set<string>()
function readReceipt(key: string): Receipt | null {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(key) ?? "null")
    if (typeof value !== "object" || value === null || !("transferId" in value) || typeof value.transferId !== "string" ||
        !("fingerprint" in value) || typeof value.fingerprint !== "string") return null
    return { transferId: value.transferId, fingerprint: value.fingerprint,
      storagePath: "storagePath" in value && typeof value.storagePath === "string" ? value.storagePath : undefined }
  } catch { return null }
}
function saveReceipt(key: string, value: Receipt) {
  try { localStorage.setItem(key, JSON.stringify(value)) } catch { /* Server reservation remains authoritative when the caller keeps transferId. */ }
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


async function transferDocument<T>(file: File, options: TransferOptions, scope: string, finalize: (input: {
  storagePath: string; checksum: string; mimeType: string;
}) => Promise<T>): Promise<T> {
  const contentType = detectContentType(file)
  validateDocumentUpload({ fileName: file.name, contentType, sizeBytes: file.size })
  const receiptKey = `arc-doc-transfer:${options.projectId ?? "org"}:${scope}:${options.transferId ?? `${file.name}:${file.size}:${file.lastModified}`}`
  if (active.has(receiptKey)) throw new Error("This upload already has an active owner")
  active.add(receiptKey)
  let receipt: Receipt | null = null
  const multipartKey = `${receiptKey}:parts`
  try {
    options.signal?.throwIfAborted()
    options.onStage?.("preparing")
    const { checksum, fingerprint } = await hashDocumentUpload(file, options.signal, loaded => {
      options.onProgress?.({ loaded, total: file.size, percent: Math.round(loaded / file.size * 100) })
    })
    receipt = readReceipt(receiptKey)
    if (receipt && receipt.fingerprint !== fingerprint) throw new Error("The selected file does not match the saved upload")
    receipt ??= { transferId: options.transferId ?? crypto.randomUUID(), fingerprint }
    saveReceipt(receiptKey, receipt)
    const createBody = { projectId: options.projectId, fileName: file.name, contentType, fileSize: file.size,
      transferId: receipt.transferId, identity: fingerprint }
    if (file.size >= MULTIPART_THRESHOLD) {
      receipt.storagePath = await runMultipartUpload({
        file, contentType, createBody, resumeKey: multipartKey, fingerprint, initialTransferId: receipt.transferId,
        endpoints: {
          create: "/api/documents/multipart/create", partUrl: "/api/documents/multipart/part-url",
          partUrls: "/api/documents/multipart/part-urls", status: "/api/documents/multipart/status",
          complete: "/api/documents/multipart/complete", abort: "/api/documents/multipart/abort",
        },
        retainCompleted: true, partConcurrency: 2, signal: options.signal, onState: options.onState,
        onStage: options.onStage, onProgress: options.onProgress,
      })
    } else {
      // The server returns the same key for every retry and checks R2 before reissuing a PUT.
      const session = await uploadControlRequest<{
        storagePath: string; uploadUrl?: string; uploadHeaders?: Record<string, string>; completed: boolean
      }>(
        "/api/documents/upload-url", createBody, options.signal,
      )
      receipt.storagePath = session.storagePath
      saveReceipt(receiptKey, receipt)
      if (!session.completed) {
        if (!session.uploadUrl) throw new Error("Missing upload URL")
        options.onState?.("transferring")
        options.onStage?.("uploading")
        try {
          await uploadBlobWithProgress(session.uploadUrl, file, contentType, loaded => {
            options.onProgress?.({ loaded, total: file.size, percent: Math.round(loaded / file.size * 100) })
          }, { signal: options.signal, headers: { "If-None-Match": "*", ...session.uploadHeaders } })
        } catch (error) {
          if (options.signal?.aborted) throw error
          const reconciled = await uploadControlRequest<{ state: string }>("/api/documents/multipart/status", {
            ...createBody, storagePath: session.storagePath,
          }, options.signal)
          if (reconciled.state !== "completed") throw error
        }
      }
      const status = await uploadControlRequest<{ state: string }>("/api/documents/multipart/status", {
        ...createBody, storagePath: session.storagePath,
      }, options.signal)
      if (status.state !== "completed") throw new Error("Upload completion is unknown. Retry to reconcile it.")
    }
    saveReceipt(receiptKey, receipt)
    options.signal?.throwIfAborted()
    options.onStage?.("finalizing")
    const result = await finalize({ storagePath: receipt.storagePath, checksum, mimeType: contentType })
    clearMultipartResumeState(multipartKey)
    clearMultipartResumeState(receiptKey)
    options.onState?.("completed")
    options.onProgress?.({ loaded: file.size, total: file.size, percent: 100 })
    return result
  } catch (error) {
    if (options.signal?.aborted && options.signal.reason === "cancel") {
      // Multipart owns its abort. A single PUT can be paused/aborted locally; the
      // server keeps any completed object because metadata finalization may have committed.
      if (file.size < MULTIPART_THRESHOLD && receipt?.storagePath) {
        await uploadControlRequest("/api/documents/multipart/abort", {
          transferId: receipt.transferId, identity: receipt.fingerprint, fileSize: file.size, storagePath: receipt.storagePath,
        })
      }
      clearMultipartResumeState(receiptKey)
      options.onState?.("cancelled")
    } else options.onState?.("paused")
    throw error
  } finally { active.delete(receiptKey) }
}

export function uploadDocumentFileDirect(file: File, options: DirectDocumentUploadOptions): Promise<FileWithUrls> {
  return transferDocument(file, options, "file", async ({ storagePath, checksum, mimeType }) => {
    const { onProgress: _progress, onStage: _stage, onState: _state, signal: _signal, transferId: _transfer, ...input } = options
    return unwrapAction(await finalizeUploadedFileAction({ ...input, fileName: file.name, fileSize: file.size, storagePath, checksum, mimeType }))
  })
}

export function uploadDocumentVersionDirect(file: File, options: DirectDocumentVersionOptions): Promise<FileVersion> {
  return transferDocument(file, options, `version:${options.fileId}`, async ({ storagePath, mimeType }) =>
    unwrapAction(await finalizeUploadedFileVersionAction({ fileId: options.fileId, storagePath,
      fileName: file.name, mimeType, sizeBytes: file.size, label: options.label, notes: options.notes })))
}

export async function cancelDocumentTransfer(transferId: string, projectId: string | undefined): Promise<void> {
  await uploadControlRequest("/api/documents/multipart/cancel", { transferId, projectId })
}
