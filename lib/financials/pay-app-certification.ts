export interface PayApplicationDeferral {
  prime_sov_line_id: string
  deferred_cents: number
  reason: string
}

/** Net payment deferrals are separate from contractual retainage and gross work progress. */
export function computePayApplicationCertification(
  requestedCents: number,
  lines: Array<{ prime_sov_line_id: string; maximum_deferrable_cents: number }>,
  deferrals: PayApplicationDeferral[],
) {
  const limits = new Map(lines.map((line) => [line.prime_sov_line_id, line.maximum_deferrable_cents]))
  const seen = new Set<string>()
  let deferredCents = 0
  for (const entry of deferrals) {
    if (seen.has(entry.prime_sov_line_id)) throw new Error("Enter one deferral per SOV line")
    seen.add(entry.prime_sov_line_id)
    const maximum = limits.get(entry.prime_sov_line_id)
    if (maximum == null) throw new Error("Deferral does not belong to this application")
    if (!Number.isSafeInteger(entry.deferred_cents) || entry.deferred_cents <= 0 || entry.deferred_cents > maximum) {
      throw new Error("Deferred amount exceeds the net payment requested on this line")
    }
    if (entry.reason.trim().length < 3) throw new Error("Explain each deferred amount")
    deferredCents += entry.deferred_cents
  }
  const certifiedCents = requestedCents - deferredCents
  if (!Number.isSafeInteger(certifiedCents) || certifiedCents <= 0) throw new Error("Return the application if no payment can be certified")
  return { requestedCents, deferredCents, certifiedCents }
}
