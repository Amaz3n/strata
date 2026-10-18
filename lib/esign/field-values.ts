import sharp from "sharp"

export type ESignFieldValue = string | boolean
export interface SignerValueField {
  id: string
  field_type: "signature" | "initials" | "text" | "date" | "checkbox" | "name"
  signer_role?: string | null
  required?: boolean | null
  metadata?: Record<string, unknown> | null
}

const MAX_FIELDS = 500
const MAX_TEXT_LENGTH = 4000
const MAX_SIGNATURE_BYTES = 512 * 1024
const MAX_TOTAL_BYTES = 8 * 1024 * 1024

/** Decode and normalize once before recording acceptance. Never accept arbitrary image formats. */
export async function validateSignaturePng(value: unknown): Promise<string> {
  if (typeof value !== "string" || value.length > Math.ceil(MAX_SIGNATURE_BYTES / 3) * 4 + 32 ||
      !/^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/.test(value)) {
    throw new Error("Signature must be a PNG image no larger than 512 KB.")
  }
  const bytes = Buffer.from(value.slice("data:image/png;base64,".length), "base64")
  if (bytes.length > MAX_SIGNATURE_BYTES || bytes.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a") {
    throw new Error("Invalid signature PNG.")
  }
  try {
    const image = sharp(bytes, { limitInputPixels: 4_000_000, failOn: "warning" })
    const metadata = await image.metadata()
    if (metadata.format !== "png" || !metadata.width || !metadata.height ||
        metadata.width > 4096 || metadata.height > 4096 || (metadata.pages ?? 1) !== 1) {
      throw new Error("Unsupported signature image dimensions.")
    }
    // Force decoding before acceptance: metadata alone does not detect truncated pixels.
    const ink = await image.clone().flatten({ background: "#ffffff" }).greyscale().stats()
    if (ink.channels[0].min > 245) throw new Error("The signature image is blank.")
    const normalized = await image.png().toBuffer()
    if (normalized.length > MAX_SIGNATURE_BYTES) throw new Error("Signature image is too large.")
    return `data:image/png;base64,${normalized.toString("base64")}`
  } catch {
    throw new Error("Signature image cannot be decoded. Please draw or upload it again.")
  }
}

export async function parseSignerFieldValues(input: {
  fields: readonly SignerValueField[]
  signerRole: string
  values: unknown
}): Promise<Record<string, ESignFieldValue>> {
  if (!input.values || typeof input.values !== "object" || Array.isArray(input.values)) {
    throw new Error("Invalid signing field values.")
  }
  const entries = Object.entries(input.values)
  if (entries.length > MAX_FIELDS || input.fields.length > MAX_FIELDS) throw new Error("Too many signing fields.")
  const assigned = new Map(input.fields
    .filter(field => (field.signer_role ?? "client") === input.signerRole)
    .map(field => [field.id, field]))
  const result: Record<string, ESignFieldValue> = Object.create(null)
  let totalBytes = 0
  for (const [id, value] of entries) {
    const field = assigned.get(id)
    if (!field || ["__proto__", "constructor", "prototype"].includes(id)) {
      throw new Error("Submitted field is not assigned to this signer.")
    }
    if (field.field_type === "checkbox") {
      if (typeof value !== "boolean") throw new Error("Checkbox values must be true or false.")
      result[id] = value
    } else {
      if (typeof value !== "string") throw new Error("Signing field values must be text.")
      totalBytes += Buffer.byteLength(value)
      if (totalBytes > MAX_TOTAL_BYTES) throw new Error("Signing field values are too large.")
      if (field.field_type === "signature") {
        result[id] = value === "" && field.required === false ? "" : await validateSignaturePng(value)
      } else {
        if (value.length > MAX_TEXT_LENGTH || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) {
          throw new Error("Signing text contains unsupported content or is too long.")
        }
        if (value.trim() && field.metadata?.validation === "email" && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim())) {
          throw new Error("Please enter a valid email address.")
        }
        if (value.trim() && field.metadata?.validation === "number" && !/^[+-]?(?:\d+(?:\.\d+)?|\.\d+)$/.test(value.trim())) {
          throw new Error("Please enter a valid number without an exponent.")
        }
        if (field.field_type === "date" && value !== "") {
          if (!/^\d{4}-\d{2}-\d{2}$/.test(value) ||
              !Number.isFinite(Date.parse(`${value}T00:00:00Z`)) ||
              new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) !== value) {
            throw new Error("Date fields must contain a valid date in YYYY-MM-DD format.")
          }
        }
        result[id] = value
      }
    }
  }
  for (const field of assigned.values()) {
    if (field.required === false) continue
    const value = result[field.id]
    if (field.field_type === "checkbox" ? value !== true : typeof value !== "string" || !value.trim()) {
      throw new Error("Please complete all required fields.")
    }
  }
  return result
}
