import "server-only"

import type { SupabaseClient } from "@supabase/supabase-js"

import type { AiFilePart } from "@/lib/services/ai/gateway"
import { downloadFilesObject } from "@/lib/storage/files-storage"

/**
 * Turning a stored `files` row into something a vision model can read.
 *
 * Every background reader of an uploaded document needs the same four things:
 * the bytes, a media type the provider will actually accept, a size ceiling so
 * one 300MB scan cannot take out a worker, and a way to say "this file is not
 * readable" without throwing. Before this existed each caller re-derived them,
 * which is how a job ends up passing `application/octet-stream` to a model and
 * getting a shrug back.
 *
 * FAILURE IS DATA. A file that is too large, or is a .docx, is not an error —
 * it is a document the model cannot read, and the caller must be able to record
 * that as an outcome rather than retry it forever.
 */

/**
 * Deliberately tighter than the interactive 20MB scan ceiling. This path runs
 * unattended in the outbox worker, where nobody is waiting to retry by hand and
 * a single oversized certificate should not eat the batch's budget.
 */
export const MAX_STORED_FILE_INPUT_BYTES = 10 * 1024 * 1024

export const AI_READABLE_MIME_TYPES: ReadonlySet<string> = new Set([
  "application/pdf",
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/heic",
  "image/heif",
])

export interface StoredFileRef {
  file_name: string | null
  storage_path: string
  mime_type: string | null
  size_bytes: number | null
}

export type StoredFileInputFailure = "too_large" | "unsupported_type" | "unreadable"

export type StoredFileInput =
  | { ok: true; part: AiFilePart; byteLength: number }
  | { ok: false; reason: StoredFileInputFailure; message: string }

/** Magic bytes beat the stored mime_type, which uploaders routinely get wrong. */
function sniffMediaType(bytes: Buffer): string | null {
  if (bytes.length < 12) return null
  if (bytes.subarray(0, 4).toString("ascii") === "%PDF") return "application/pdf"
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg"
  if (
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return "image/png"
  }
  if (bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP") {
    return "image/webp"
  }
  const brand = bytes.subarray(4, 12).toString("ascii")
  if (brand.startsWith("ftyp") && /heic|heix|hevc|hevx|mif1|msf1/i.test(brand)) return "image/heic"
  return null
}

export function resolveStoredFileMediaType(
  declared: string | null | undefined,
  fileName: string | null | undefined,
  bytes: Buffer,
): string {
  const sniffed = sniffMediaType(bytes)
  if (sniffed) return sniffed

  const normalized = declared?.trim().toLowerCase()
  if (normalized === "image/jpg" || normalized === "image/pjpeg") return "image/jpeg"
  if (normalized && AI_READABLE_MIME_TYPES.has(normalized)) return normalized

  const lower = (fileName ?? "").toLowerCase()
  if (lower.endsWith(".pdf")) return "application/pdf"
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg"
  if (lower.endsWith(".png")) return "image/png"
  if (lower.endsWith(".webp")) return "image/webp"
  if (lower.endsWith(".heic")) return "image/heic"
  if (lower.endsWith(".heif")) return "image/heif"
  return "application/octet-stream"
}

/**
 * Fetch a stored file as model input. The recorded `size_bytes` is checked
 * before the download so an oversized file costs nothing, and the real byte
 * length is checked again after, because that column is caller-supplied.
 */
export async function loadStoredFileForModel(params: {
  supabase: SupabaseClient
  orgId: string
  file: StoredFileRef
}): Promise<StoredFileInput> {
  const { file } = params
  const declaredSize = file.size_bytes === null ? null : Number(file.size_bytes)
  if (declaredSize !== null && declaredSize > MAX_STORED_FILE_INPUT_BYTES) {
    return { ok: false, reason: "too_large", message: "The document is larger than 10MB" }
  }

  let bytes: Buffer
  try {
    bytes = await downloadFilesObject({ supabase: params.supabase, orgId: params.orgId, path: file.storage_path })
  } catch (error) {
    return {
      ok: false,
      reason: "unreadable",
      message: error instanceof Error ? error.message : "The document could not be downloaded",
    }
  }

  if (bytes.byteLength === 0) {
    return { ok: false, reason: "unreadable", message: "The document is empty" }
  }
  if (bytes.byteLength > MAX_STORED_FILE_INPUT_BYTES) {
    return { ok: false, reason: "too_large", message: "The document is larger than 10MB" }
  }

  const mediaType = resolveStoredFileMediaType(file.mime_type, file.file_name, bytes)
  if (!AI_READABLE_MIME_TYPES.has(mediaType)) {
    return { ok: false, reason: "unsupported_type", message: `${mediaType} is not a readable document format` }
  }

  return {
    ok: true,
    byteLength: bytes.byteLength,
    part: { data: bytes, mediaType, filename: file.file_name || "document" },
  }
}
