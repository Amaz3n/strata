const MEBIBYTE = 1024 * 1024

export const MAX_DOCUMENT_UPLOAD_BYTES = 100 * MEBIBYTE

const ACTIVE_CONTENT_MIME_TYPES = new Set([
  "application/xhtml+xml",
  "application/xml",
  "image/svg+xml",
  "text/html",
  "text/xml",
])

const ACTIVE_CONTENT_EXTENSIONS = new Set([".htm", ".html", ".svg", ".xhtml", ".xml"])

const INLINE_SAFE_MIME_TYPES = new Set([
  "application/pdf",
  "image/avif",
  "image/gif",
  "image/jpeg",
  "image/png",
  "image/webp",
])

function extensionOf(fileName: string) {
  const lower = fileName.trim().toLowerCase()
  const dot = lower.lastIndexOf(".")
  return dot >= 0 ? lower.slice(dot) : ""
}

export function normalizeDocumentContentType(value: unknown) {
  if (typeof value !== "string") return "application/octet-stream"
  const normalized = value.split(";", 1)[0]?.trim().toLowerCase() ?? ""
  return /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/.test(normalized)
    ? normalized
    : "application/octet-stream"
}

export function isActiveDocumentContent(fileName: string, contentType: string) {
  return (
    ACTIVE_CONTENT_MIME_TYPES.has(normalizeDocumentContentType(contentType)) ||
    ACTIVE_CONTENT_EXTENSIONS.has(extensionOf(fileName))
  )
}

export function validateDocumentUpload(input: {
  fileName: string
  contentType: unknown
  sizeBytes: unknown
}): { contentType: string; sizeBytes: number } {
  const fileName = input.fileName.trim()
  const sizeBytes = Number(input.sizeBytes)
  const contentType = normalizeDocumentContentType(input.contentType)

  if (!fileName || fileName.length > 255 || /[\r\n]/.test(fileName)) {
    throw new Error("Choose a file with a valid name.")
  }
  if (!Number.isSafeInteger(sizeBytes) || sizeBytes <= 0) {
    throw new Error("The file is empty or its size is invalid.")
  }
  if (sizeBytes > MAX_DOCUMENT_UPLOAD_BYTES) {
    throw new Error("Files must be 100 MB or smaller.")
  }
  if (isActiveDocumentContent(fileName, contentType)) {
    throw new Error("Active web documents are not accepted. Upload a PDF or another non-executable file format.")
  }

  return { contentType, sizeBytes }
}

export function shouldServeDocumentInline(fileName: string, contentType: string) {
  return (
    !isActiveDocumentContent(fileName, contentType) &&
    INLINE_SAFE_MIME_TYPES.has(normalizeDocumentContentType(contentType))
  )
}

export function projectIdFromDocumentStoragePath(orgId: string, storagePath: string) {
  const [pathOrgId, projectId, documentsSegment] = storagePath.split("/")
  if (pathOrgId !== orgId || !projectId || documentsSegment !== "documents") return null
  return projectId
}
