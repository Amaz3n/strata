import "server-only"

import { z } from "zod"

const MAX_DOCUMENT_RENAME_SIZE = 10 * 1024 * 1024
const SUPPORTED_MIME_TYPES = new Set([
  "application/pdf",
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/heic",
  "image/heif",
])

const confidenceSchema = z.preprocess((value) => {
  if (typeof value !== "string") return "low"
  const normalized = value.trim().toLowerCase()
  if (normalized === "high" || normalized === "medium" || normalized === "low") return normalized
  return "low"
}, z.enum(["high", "medium", "low"]))

const notesSchema = z.preprocess((value) => {
  if (Array.isArray(value)) return value
  if (typeof value === "string" && value.trim()) return [value]
  return []
}, z.array(z.string()))

const nullableStringSchema = z.preprocess((value) => {
  if (typeof value !== "string") return null
  const trimmed = value.trim()
  return trimmed ? trimmed : null
}, z.string().nullable())

const filenameSuggestionSchema = z.object({
  suggested_file_name: z.string().min(1).max(180),
  title: nullableStringSchema.default(null),
  document_type: nullableStringSchema.default(null),
  date: nullableStringSchema.default(null),
  confidence: confidenceSchema.default("low"),
  notes: notesSchema.default([]),
})

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
}: {
  bytes: Buffer
  fileName: string
  mimeType?: string | null
}): Promise<DocumentFileNameSuggestion> {
  if (bytes.length === 0) throw new Error("File is empty")
  if (bytes.length > MAX_DOCUMENT_RENAME_SIZE) {
    throw new Error("AI rename supports PDFs and images up to 10MB")
  }

  const normalizedMimeType = normalizeMimeType(mimeType, fileName, bytes)
  if (!SUPPORTED_MIME_TYPES.has(normalizedMimeType)) {
    throw new Error("AI rename supports PDF and image files")
  }

  const apiKey = getGeminiApiKey()
  if (!apiKey) {
    throw new Error("AI rename is not configured")
  }

  const model = getVisionModel()
  const rawText = await generateGeminiFilenameSuggestion({
    apiKey,
    model,
    mimeType: normalizedMimeType,
    base64: bytes.toString("base64"),
    originalFileName: fileName,
  })
  const parsed = parseFilenameSuggestionJson(rawText)
  const extension = getFileExtension(fileName)

  return {
    suggestedFileName: normalizeSuggestedFileName(parsed.suggested_file_name, extension),
    title: cleanString(parsed.title),
    documentType: cleanString(parsed.document_type),
    date: cleanString(parsed.date),
    confidence: parsed.confidence,
    notes: parsed.notes.map((note) => note.trim()).filter(Boolean).slice(0, 4),
    model,
  }
}

async function generateGeminiFilenameSuggestion({
  apiKey,
  model,
  mimeType,
  base64,
  originalFileName,
}: {
  apiKey: string
  model: string
  mimeType: string
  base64: string
  originalFileName: string
}) {
  const normalizedModel = model.startsWith("models/") ? model : `models/${model}`
  const endpoint =
    process.env.GEMINI_BASE_URL?.replace(/\/$/, "") ||
    "https://generativelanguage.googleapis.com/v1beta"
  const response = await fetch(
    `${endpoint}/${normalizedModel}:generateContent?key=${encodeURIComponent(apiKey)}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [
          {
            role: "user",
            parts: [
              {
                text: [
                  "Read this construction project document and suggest a concise, human-readable file name based on the purpose of the file.",
                  "Return only JSON with these keys:",
                  "suggested_file_name, title, document_type, date, confidence, notes.",
                  `Original file name: ${originalFileName}`,
                  "First identify what the document is for: invoice, agreement, contract, proposal, change order, RFI, submittal, permit, spec sheet, warranty, closeout document, drawing, report, receipt, or other construction record.",
                  "Then compose suggested_file_name as: Document Purpose + the most useful identifier + the party/trade/scope. Keep it short and scannable.",
                  "Use invoice numbers, RFI numbers, submittal numbers, permit numbers, agreement titles, spec section names, vendor/subcontractor names, trade, or scope when visible.",
                  "The suggested_file_name should be title case, under 80 characters before the extension, and useful in a construction document library.",
                  "Prefer names like: 'Invoice 3233 - Plumbing XYZ.pdf', 'Agreement - ABC Electric - Service Work.pdf', 'Spec Sheet - Door Hardware.pdf', 'Submittal 08 7100 - Door Hardware.pdf', 'Permit - Electrical Rough-In.pdf', or 'RFI 014 - Structural Beam Conflict.pdf'.",
                  "Do not include slashes, backslashes, control characters, emojis, or duplicate extensions.",
                  "If a date is visible, use YYYY-MM-DD in the date field and include it only when it improves the filename.",
                  "If the content is unclear, keep the original meaning and set confidence to low.",
                ].join("\n"),
              },
              {
                inline_data: {
                  mime_type: mimeType,
                  data: base64,
                },
              },
            ],
          },
        ],
        generationConfig: {
          temperature: 0,
          responseMimeType: "application/json",
        },
      }),
    },
  )

  if (!response.ok) {
    const body = await response.text()
    console.warn(`[DocumentRename] Gemini request failed: ${response.status} ${body}`)
    throw new Error("Could not suggest a file name")
  }

  const payload = await response.json()
  const text = extractGeminiResponseText(payload)
  if (!text) throw new Error("AI rename returned no suggestion")
  return text
}

function parseFilenameSuggestionJson(rawText: string) {
  const direct = tryParseJson(rawText)
  const directParsed = parseFilenameSuggestionShape(direct)
  if (directParsed) return directParsed

  const fenced = rawText.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1]
  const fencedJson = fenced ? tryParseJson(fenced) : null
  const fencedParsed = parseFilenameSuggestionShape(fencedJson)
  if (fencedParsed) return fencedParsed

  const firstBrace = rawText.indexOf("{")
  const lastBrace = rawText.lastIndexOf("}")
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    const sliced = tryParseJson(rawText.slice(firstBrace, lastBrace + 1))
    const slicedParsed = parseFilenameSuggestionShape(sliced)
    if (slicedParsed) return slicedParsed
  }

  throw new Error("Could not read AI file name suggestion")
}

function parseFilenameSuggestionShape(value: unknown) {
  if (!value) return null
  const record = Array.isArray(value) ? value[0] : value
  if (!record || typeof record !== "object") return null
  const source = record as Record<string, unknown>
  const parsed = filenameSuggestionSchema.safeParse({
    suggested_file_name: pickFirst(source, ["suggested_file_name", "suggestedFileName", "file_name", "fileName", "name", "title"]),
    title: pickFirst(source, ["title", "document_title", "documentTitle"]),
    document_type: pickFirst(source, ["document_type", "documentType", "type", "category"]),
    date: pickFirst(source, ["date", "document_date", "documentDate", "issued_date", "issuedDate"]),
    confidence: pickFirst(source, ["confidence", "confidence_level", "confidenceLevel"]),
    notes: pickFirst(source, ["notes", "warnings", "uncertainties", "explanation"]),
  })
  if (parsed.success) return parsed.data
  return null
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

function normalizeSuggestedFileName(value: string, extension: string) {
  const withoutExtension = value
    .replace(/[\\/:*?"<>|\r\n\t]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\.[A-Za-z0-9]{1,8}$/i, "")
    .slice(0, 80)
    .trim()
  const base = withoutExtension || "Renamed document"
  return extension ? `${base}${extension}` : base
}

function getFileExtension(fileName: string) {
  const match = fileName.match(/(\.[A-Za-z0-9]{1,8})$/)
  return match?.[1] ?? ""
}

function extractGeminiResponseText(payload: any) {
  const parts = payload?.candidates?.[0]?.content?.parts
  if (!Array.isArray(parts)) return ""
  return parts.map((part) => part?.text).filter((text): text is string => typeof text === "string").join("\n").trim()
}

function tryParseJson(value: string | null | undefined) {
  if (!value || typeof value !== "string") return null
  try {
    return JSON.parse(value)
  } catch {
    return null
  }
}

function pickFirst(source: Record<string, unknown>, keys: string[]) {
  for (const key of keys) {
    const value = source[key]
    if (value !== undefined && value !== "") return value
  }
  return null
}

function cleanString(value?: string | null) {
  const trimmed = value?.trim()
  return trimmed ? trimmed : null
}

function getGeminiApiKey() {
  return process.env.GOOGLE_GENERATIVE_AI_API_KEY?.trim() || process.env.GEMINI_API_KEY?.trim() || null
}

function getVisionModel() {
  return (
    process.env.RECEIPT_VISION_MODEL ||
    process.env.GEMINI_RECEIPT_MODEL ||
    process.env.DRAWINGS_VISION_MODEL ||
    process.env.AI_DRAWINGS_VISION_MODEL ||
    process.env.GEMINI_VISION_MODEL ||
    process.env.GOOGLE_VISION_MODEL ||
    "gemini-2.5-flash-lite"
  ).trim()
}
