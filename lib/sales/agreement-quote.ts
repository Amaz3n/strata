import { createHash } from "node:crypto"

// Quote arrays are sets of priced choices/incentives. Database response order
// must not turn unchanged economics into a new quote; duplicate rows remain.
function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical).sort((a, b) => compareText(JSON.stringify(a), JSON.stringify(b)))
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).sort(([a], [b]) => compareText(a, b)).map(([key, item]) => [key, canonical(item)]))
  }
  return value
}

export function agreementQuoteFingerprint(quote: unknown): string {
  return createHash("sha256").update(JSON.stringify(canonical(quote))).digest("hex")
}

export class AgreementQuoteChangedError extends Error {
  readonly code = "AGREEMENT_QUOTE_CHANGED"
  constructor() { super("The agreement quote changed. Review the refreshed prices before creating the agreement") }
}
