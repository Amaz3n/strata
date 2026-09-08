export const INVOICE_MAX_BYTES = 20 * 1024 * 1024
export const INVOICE_TYPES = new Set(["application/pdf", "image/jpeg", "image/png", "image/webp", "image/heic", "image/heif"])
export type IntakeStage = "queued" | "uploading" | "reading" | "checking" | "ready" | "failed"
export interface IntakeRow {
  id: string
  name: string
  stage: IntakeStage
  billId?: string
  progress?: string
  billNumber?: string | null
  warning?: string | null
  error?: string
  vendor?: string | null
  amount?: number | null
}
export const intakeLabels: Record<IntakeStage, string> = {
  queued: "Waiting to upload", uploading: "Uploading invoice", reading: "Reading PDF",
  checking: "Checking amounts", ready: "Draft ready for review", failed: "Needs attention",
}
export function invoiceFileError(file: { size: number; type: string }): string | null {
  if (!file.size) return "This file is empty."
  if (file.size > INVOICE_MAX_BYTES) return "Invoices must be 20 MB or smaller."
  if (!INVOICE_TYPES.has(file.type)) return "Choose a PDF, JPEG, PNG, WebP, or HEIC invoice."
  return null
}

/** Show the actionable cause without surfacing credentials embedded in provider errors. */
export function payableIntakeError(error: unknown, fallback = "Could not process this invoice. Please retry."): string {
  const message = error && typeof error === "object" && "message" in error ? String(error.message) : typeof error === "string" ? error : ""
  return (message || fallback)
    .replace(/Bearer\s+[^\s"']+/gi, "Bearer [redacted]")
    .replace(/(?:sk-[\w-]+|AIza[\w-]+)/g, "[redacted]")
    .replace(/([?&](?:key|api_key|token)=)[^&\s]+/gi, "$1[redacted]")
    .split("\n")[0].slice(0, 500)
}
