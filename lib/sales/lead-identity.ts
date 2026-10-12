/**
 * The keys a lead is recognised by. Twins of `arc_normalize_email` and
 * `arc_normalize_phone` in the lead intake migration: the database matches on
 * the stored generated columns, and these say in TypeScript what it will match,
 * so a delivery with no usable key is refused before it is filed.
 *
 * A name is deliberately not a key. Two buyers called Dana Rivers are two
 * buyers; merging them is worse than a duplicate a consultant can see.
 */

export function normalizeEmail(value: string | null | undefined): string | null {
  const normalized = (value ?? "").trim().toLowerCase()
  return normalized ? normalized : null
}

/** Digits only; a leading 1 on eleven digits is the country code; under ten digits is no key. */
export function normalizePhone(value: string | null | undefined): string | null {
  const digits = (value ?? "").replace(/[^0-9]/g, "")
  if (digits.length === 11 && digits.startsWith("1")) return digits.slice(1)
  return digits.length >= 10 ? digits : null
}

export interface LeadContactKeys {
  email: string | null
  phone: string | null
}

/** The lead's match keys, or null when it carries neither. */
export function leadContactKeys(input: { email?: string | null; phone?: string | null }): LeadContactKeys | null {
  const keys = { email: normalizeEmail(input.email), phone: normalizePhone(input.phone) }
  return keys.email || keys.phone ? keys : null
}

/** "Dana" + "Rivers", or the single name a form sent. */
export function leadDisplayName(input: { name?: string | null; firstName?: string | null; lastName?: string | null }): string | null {
  const joined = [input.firstName, input.lastName].map((part) => part?.trim() ?? "").filter(Boolean).join(" ")
  const name = joined || input.name?.trim() || ""
  return name ? name : null
}
