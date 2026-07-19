import { createHash } from "node:crypto"

import { COST_TYPES, type CostType } from "@/lib/cost-types"

export type ImportIssueLevel = "warning" | "error"

export interface ImportIssue {
  level: ImportIssueLevel
  code: string
  message: string
  column?: string
}

export type ImportRawRow = Record<string, string>
export type ImportParsedRow = Record<string, string | number | boolean | null>

export function normalizeWhitespace(value: unknown) {
  return String(value ?? "").trim().replace(/\s+/g, " ")
}

export function normalizeKey(value: unknown) {
  return normalizeWhitespace(value).toLowerCase()
}

export function slugKey(value: unknown) {
  return normalizeKey(value).replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")
}

export function parseCsv(text: string): { headers: string[]; rows: ImportRawRow[] } {
  const matrix: string[][] = []
  let row: string[] = []
  let cell = ""
  let quoted = false

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]
    const next = text[index + 1]
    if (char === '"') {
      if (quoted && next === '"') {
        cell += '"'
        index += 1
      } else {
        quoted = !quoted
      }
    } else if (char === "," && !quoted) {
      row.push(cell)
      cell = ""
    } else if ((char === "\n" || char === "\r") && !quoted) {
      if (char === "\r" && next === "\n") index += 1
      row.push(cell)
      if (row.some((value) => value.trim().length > 0)) matrix.push(row)
      row = []
      cell = ""
    } else {
      cell += char
    }
  }

  row.push(cell)
  if (row.some((value) => value.trim().length > 0)) matrix.push(row)
  if (quoted) throw new Error("CSV contains an unterminated quoted field")
  if (matrix.length === 0) return { headers: [], rows: [] }

  const headers = matrix[0].map((value, index) => normalizeWhitespace(value) || `column_${index + 1}`)
  const duplicate = headers.find((header, index) => headers.indexOf(header) !== index)
  if (duplicate) throw new Error(`CSV contains duplicate header “${duplicate}”`)

  return {
    headers,
    rows: matrix.slice(1).map((values) =>
      Object.fromEntries(headers.map((header, index) => [header, normalizeWhitespace(values[index] ?? "")])),
    ),
  }
}

export function sourceSignature(headers: readonly string[]) {
  const normalized = [...headers].map(normalizeKey).sort().join("\u001f")
  return createHash("sha256").update(normalized).digest("hex")
}

export function parseCents(value: unknown): number | null {
  const text = normalizeWhitespace(value)
  if (!text) return null
  const negative = /^\(.*\)$/.test(text)
  const cleaned = text.replace(/[,$%()\s]/g, "")
  if (!/^[-+]?\d+(?:\.\d{1,2})?$/.test(cleaned)) return null
  const amount = Number(cleaned)
  if (!Number.isFinite(amount)) return null
  return Math.round(Math.abs(amount) * 100) * (negative || amount < 0 ? -1 : 1)
}

export function parseInteger(value: unknown): number | null {
  const text = normalizeWhitespace(value)
  if (!text) return null
  const parsed = Number(text.replace(/,/g, ""))
  return Number.isInteger(parsed) ? parsed : null
}

export function parseNumber(value: unknown): number | null {
  const text = normalizeWhitespace(value)
  if (!text) return null
  const parsed = Number(text.replace(/,/g, ""))
  return Number.isFinite(parsed) ? parsed : null
}

export function parseBoolean(value: unknown): boolean | null {
  const normalized = normalizeKey(value)
  if (!normalized) return null
  if (["1", "true", "yes", "y", "on"].includes(normalized)) return true
  if (["0", "false", "no", "n", "off"].includes(normalized)) return false
  return null
}

export function parseDate(value: unknown): string | null {
  const text = normalizeWhitespace(value)
  if (!text) return null
  const isoMatch = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(text)
  const usMatch = /^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/.exec(text)
  let year: number
  let month: number
  let day: number
  if (isoMatch) {
    year = Number(isoMatch[1]); month = Number(isoMatch[2]); day = Number(isoMatch[3])
  } else if (usMatch) {
    year = Number(usMatch[3]); month = Number(usMatch[1]); day = Number(usMatch[2])
    if (year < 100) year += year >= 70 ? 1900 : 2000
  } else {
    return null
  }
  const date = new Date(Date.UTC(year, month - 1, day))
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`
}

const UOM_ALIASES: Record<string, string> = {
  each: "ea", unit: "ea", units: "ea", squarefeet: "sf", "sq ft": "sf", sqft: "sf",
  linearfeet: "lf", "lin ft": "lf", lft: "lf", squares: "sq", lumpsum: "ls", lot: "ls",
  hours: "hr", hour: "hr", days: "day", months: "mo", yard: "cy", yards: "cy",
}

export function normalizeUom(value: unknown) {
  const normalized = normalizeKey(value).replace(/\./g, "")
  return UOM_ALIASES[normalized] ?? (normalized || null)
}

export function normalizeCostType(value: unknown): CostType | null {
  const normalized = normalizeKey(value)
  return COST_TYPES.find((type) => type === normalized) ?? null
}

export function mappedValue(raw: ImportRawRow, mapping: Record<string, string | null>, key: string) {
  const source = mapping[key] ?? key
  return source ? raw[source] ?? "" : ""
}

export function requiredIssue(key: string, label: string, value: unknown): ImportIssue[] {
  return normalizeWhitespace(value)
    ? []
    : [{ level: "error", code: "required", message: `${label} is required`, column: key }]
}

export function stableNaturalKey(parts: readonly unknown[]) {
  return parts.map(slugKey).filter(Boolean).join(":")
}

export function topologicalOrder<T extends { code: string; parent_code?: string | null }>(rows: T[]) {
  const byCode = new Map(rows.map((row) => [normalizeKey(row.code), row]))
  const visiting = new Set<string>()
  const visited = new Set<string>()
  const result: T[] = []

  const visit = (row: T) => {
    const key = normalizeKey(row.code)
    if (visiting.has(key)) throw new Error(`Cost-code hierarchy contains a cycle at ${row.code}`)
    if (visited.has(key)) return
    visiting.add(key)
    const parent = row.parent_code ? byCode.get(normalizeKey(row.parent_code)) : null
    if (parent) visit(parent)
    visiting.delete(key)
    visited.add(key)
    result.push(row)
  }

  rows.forEach(visit)
  return result
}

export function normalizeVendorName(value: unknown) {
  return normalizeKey(value)
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\b(incorporated|corporation|company|limited|llc|inc|corp|co|ltd)\b/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .sort()
    .join(" ")
}

export function similarity(left: string, right: string) {
  const a = `  ${normalizeVendorName(left)} `
  const b = `  ${normalizeVendorName(right)} `
  if (a === b) return 1
  const grams = (value: string) => {
    const counts = new Map<string, number>()
    for (let index = 0; index <= value.length - 3; index += 1) {
      const gram = value.slice(index, index + 3)
      counts.set(gram, (counts.get(gram) ?? 0) + 1)
    }
    return counts
  }
  const aGrams = grams(a)
  const bGrams = grams(b)
  let overlap = 0
  for (const [gram, count] of aGrams) overlap += Math.min(count, bGrams.get(gram) ?? 0)
  const total = [...aGrams.values()].reduce((sum, count) => sum + count, 0)
    + [...bGrams.values()].reduce((sum, count) => sum + count, 0)
  return total === 0 ? 0 : (2 * overlap) / total
}
