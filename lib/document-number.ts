export const DOCUMENT_NUMBER_KINDS = [
  "rfi",
  "submittal",
  "change_order",
  "meeting",
  "transmittal",
] as const

export type DocumentNumberKind = (typeof DOCUMENT_NUMBER_KINDS)[number]

export type DocumentNumberRule = {
  prefix?: string
  pad?: number
}

export type DocumentNumberingSettings = Partial<Record<DocumentNumberKind, DocumentNumberRule>>

export function formatDocNumber(
  kind: DocumentNumberKind,
  number: number | string,
  settings?: DocumentNumberingSettings | null,
): string {
  const numeric = typeof number === "number" ? number : Number(number)
  if (!Number.isFinite(numeric)) return String(number)
  const rule = settings?.[kind]
  if (!rule) return String(numeric)
  const pad = Math.max(0, Math.min(12, Math.trunc(rule.pad ?? 0)))
  return `${rule.prefix ?? ""}${String(numeric).padStart(pad, "0")}`
}

