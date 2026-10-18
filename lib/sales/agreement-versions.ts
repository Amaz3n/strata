/**
 * A purchase agreement's authorized terms read as one chain: version 1 is the
 * signed agreement, every later version a buyer-signed change order. The
 * database writes the chain (`purchase_agreement_versions`); this checks it is
 * whole before anything prices off it, because a gap or a broken running total
 * is a price nobody signed.
 */

export type AgreementVersionRow = {
  id: string
  version_number: number
  kind: "original" | "amendment"
  change_order_id: string | null
  price_delta_cents: number
  authorized_total_cents: number
  executed_at: string
}

export type AuthorizedAgreementTerms<Row extends AgreementVersionRow = AgreementVersionRow> = {
  current: Row
  original: Row
  amendments: Row[]
  originalTotalCents: number
  amendmentsCents: number
  authorizedTotalCents: number
}

function cents(value: unknown, label: string): number {
  const parsed = typeof value === "string" && /^-?[0-9]+$/.test(value) ? Number(value) : value
  if (typeof parsed !== "number" || !Number.isSafeInteger(parsed)) throw new Error(`${label} is not integer cents`)
  return parsed
}

export function authorizedAgreementTerms<Row extends AgreementVersionRow>(rows: Row[]): AuthorizedAgreementTerms<Row> {
  if (rows.length === 0) throw new Error("The signed agreement has no recorded version")
  const versions = [...rows].sort((a, b) => a.version_number - b.version_number)
  let running = 0
  versions.forEach((row, index) => {
    const delta = cents(row.price_delta_cents, "A version's price change")
    const total = cents(row.authorized_total_cents, "A version's authorized total")
    const expectedKind = index === 0 ? "original" : "amendment"
    if (row.version_number !== index + 1 || row.kind !== expectedKind || (index === 0) !== (row.change_order_id === null)) {
      throw new Error("The agreement's version history is broken; reconcile it before pricing the sale")
    }
    running = index === 0 ? delta : running + delta
    if (total !== running || total < 0) {
      throw new Error("The agreement's authorized totals do not follow its signed changes; reconcile it before pricing the sale")
    }
  })
  const original = versions[0]
  const current = versions[versions.length - 1]
  const originalTotalCents = cents(original.authorized_total_cents, "The original total")
  const authorizedTotalCents = cents(current.authorized_total_cents, "The authorized total")
  return {
    current,
    original,
    amendments: versions.slice(1),
    originalTotalCents,
    amendmentsCents: authorizedTotalCents - originalTotalCents,
    authorizedTotalCents,
  }
}
