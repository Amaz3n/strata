import "server-only"

import { z } from "zod"

import { runAiObject } from "@/lib/services/ai/gateway"

const MAX_DOCUMENT_RENAME_SIZE = 10 * 1024 * 1024
const SUPPORTED_MIME_TYPES = new Set([
  "application/pdf",
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/heic",
  "image/heif",
])

const DOCUMENT_RENAME_SYSTEM = [
  "You name construction documents from their contents.",
  "Return a short, human-readable file name built from the document's own title, type and date.",
  "Never invent a project, party, or date the document does not show — use null and say so in notes.",
].join(" ")

const filenameSuggestionSchema = z.object({
  suggested_file_name: z.string().min(1).max(180),
  title: z.string().nullable(),
  document_type: z.string().nullable(),
  date: z.string().nullable(),
  confidence: z.enum(["high", "medium", "low"]),
  notes: z.array(z.string()),
})

/** Keep the caller's extension; the model names the document, not the format. */
function getFileExtension(fileName: string) {
  const match = fileName.match(/\.([A-Za-z0-9]{1,8})$/)
  return match ? `.${match[1].toLowerCase()}` : ""
}

function normalizeSuggestedFileName(value: string, extension: string) {
  const base = value
    .trim()
    .replace(/[/\\:*?"<>|]+/g, "-")
    .replace(/\s{2,}/g, " ")
    .replace(new RegExp(`${extension.replace(".", "\\.")}$`, "i"), "")
    .trim()
  const safe = (base || "Document").slice(0, 150)
  return `${safe}${extension}`
}

function cleanString(value: string | null | undefined) {
  const cleaned = value?.trim()
  return cleaned ? cleaned.slice(0, 300) : null
}

export interface DocumentFileNameSuggestion {
  suggestedFileName: string
  title: string | null
  documentType: string | null
  date: string | null
  confidence: "high" | "medium" | "low"
  notes: string[]
  model: string
}

export async function suggestDocumentFileNameFromBytes({
  bytes,
  fileName,
  mimeType,
  orgId,
}: {
  bytes: Buffer
  fileName: string
  mimeType?: string | null
  orgId?: string | null
}): Promise<DocumentFileNameSuggestion> {
  if (bytes.length === 0) throw new Error("File is empty")
  if (bytes.length > MAX_DOCUMENT_RENAME_SIZE) {
    throw new Error("AI rename supports PDFs and images up to 10MB")
  }

  const normalizedMimeType = normalizeMimeType(mimeType, fileName, bytes)
  if (!SUPPORTED_MIME_TYPES.has(normalizedMimeType)) {
    throw new Error("AI rename supports PDF and image files")
  }

  const result = await runAiObject({
    feature: "document_extraction",
    schema: filenameSuggestionSchema,
    system: DOCUMENT_RENAME_SYSTEM,
    prompt: `Original file name: ${fileName}`,
    files: [{ data: bytes, mediaType: normalizedMimeType, filename: fileName }],
    orgId: orgId ?? null,
    entityType: "file",
    timeoutMs: 60_000,
    // A filename suggestion a human confirms; not worth a stronger model.
    allowEscalation: false,
  })
  if (!result.ok) {
    throw new Error(result.reason === "not_configured" ? "AI rename is not configured" : "Could not read this document")
  }
  const parsed = result.object
  const extension = getFileExtension(fileName)

  return {
    suggestedFileName: normalizeSuggestedFileName(parsed.suggested_file_name, extension),
    title: cleanString(parsed.title),
    documentType: cleanString(parsed.document_type),
    date: cleanString(parsed.date),
    confidence: parsed.confidence,
    notes: parsed.notes.map((note) => note.trim()).filter(Boolean).slice(0, 4),
    model: result.meta.model,
  }
}
function normalizeMimeType(mimeType: string | null | undefined, fileName: string, bytes?: Buffer) {
  const normalized = mimeType?.trim().toLowerCase()
  if (normalized === "image/jpg" || normalized === "image/pjpeg") return "image/jpeg"
  if (normalized && SUPPORTED_MIME_TYPES.has(normalized)) return normalized

  const sniffed = sniffMimeType(bytes)
  if (sniffed) return sniffed

  const lowerName = fileName.toLowerCase()
  if (lowerName.endsWith(".pdf")) return "application/pdf"
  if (lowerName.endsWith(".jpg") || lowerName.endsWith(".jpeg")) return "image/jpeg"
  if (lowerName.endsWith(".png")) return "image/png"
  if (lowerName.endsWith(".webp")) return "image/webp"
  if (lowerName.endsWith(".heic")) return "image/heic"
  if (lowerName.endsWith(".heif")) return "image/heif"
  if (normalized?.startsWith("image/")) return normalized
  return "application/octet-stream"
}

function sniffMimeType(bytes: Buffer | undefined) {
  if (!bytes || bytes.length < 12) return null
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
  if (brand.startsWith("ftyp") && /heic|heix|hevc|hevx|mif1|msf1/i.test(brand)) {
    return "image/heic"
  }
  return null
}
