export interface AccountingNumberSettings {
  invoice_number_pattern?: "numeric" | "prefix" | "custom"
  invoice_number_prefix?: string | null
}

function extractInvoiceSequenceValue(current: string, settings?: AccountingNumberSettings | null): bigint {
  const normalized = String(current ?? "").trim()
  if (!normalized) return BigInt(0)

  const explicitPrefix = settings?.invoice_number_pattern === "prefix" ? settings.invoice_number_prefix ?? "" : ""
  if (explicitPrefix && normalized.startsWith(explicitPrefix)) {
    const numericPortion = normalized.slice(explicitPrefix.length)
    if (/^\d+$/.test(numericPortion)) return BigInt(numericPortion)
  }

  const yearMatch = normalized.match(/^(\d{4}-)(\d+)$/)
  if (yearMatch) {
    return BigInt(yearMatch[2])
  }

  const suffixMatch = normalized.match(/(\d+)(?!.*\d)/)
  if (suffixMatch) {
    return BigInt(suffixMatch[1])
  }

  return BigInt(0)
}

export function compareInvoiceNumbers(a: string, b: string, settings?: AccountingNumberSettings | null): number {
  const aSeq = extractInvoiceSequenceValue(a, settings)
  const bSeq = extractInvoiceSequenceValue(b, settings)
  if (aSeq !== bSeq) return aSeq > bSeq ? 1 : -1
  return String(a ?? "").localeCompare(String(b ?? ""))
}

export function pickLatestInvoiceNumber(candidates: Array<string | null | undefined>, settings?: AccountingNumberSettings | null) {
  return candidates
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    .reduce<string | null>((latest, candidate) => {
      if (!latest) return candidate.trim()
      return compareInvoiceNumbers(candidate, latest, settings) > 0 ? candidate.trim() : latest
    }, null)
}

export function incrementInvoiceNumber(
  current: string,
  settings?: AccountingNumberSettings | null,
): string {
  const pattern = settings?.invoice_number_pattern
  const prefix = settings?.invoice_number_prefix ?? ""

  const normalized = current.trim()
  const advance = (digits: string) => (BigInt(digits || "0") + BigInt(1)).toString().padStart(digits.length, "0")
  if (pattern === "prefix" && prefix) {
    const suffix = normalized.startsWith(prefix) ? normalized.slice(prefix.length) : (normalized.match(/(\d+)$/)?.[1] ?? "0").padStart(4, "0")
    return `${prefix}${advance(/^\d+$/.test(suffix) ? suffix : "0000")}`
  }
  // Preserve numeric padding and arbitrary project/year prefixes.
  const match = normalized.match(/^(.*?)(\d+)$/)
  if (match) return `${match[1]}${advance(match[2])}`

  return "1001"
}

