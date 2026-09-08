export type PayApplicationDeferralDraft = Record<string, { amount: string; reason: string }>
export interface DeferrablePayApplicationLine { id: string; description: string; maxCents: number }

/** Parse money without accepting exponents, fractional cents, or negative deferrals. */
export function resolvePayApplicationDeferrals(
  lines: DeferrablePayApplicationLine[], value: PayApplicationDeferralDraft, appliedCents: number,
) {
  const deferrals: Array<{ prime_sov_line_id: string; deferred_cents: number; reason: string }> = []
  let error: string | null = null
  for (const line of lines) {
    const draft = value[line.id]
    if (!draft?.amount.trim()) continue
    const amount = draft.amount.trim()
    if (!/^\d+(?:\.\d{1,2})?$/.test(amount)) { error ??= `Enter a valid dollar amount for ${line.description}.`; continue }
    const [whole, fraction = ""] = amount.split(".")
    const cents = Number(whole) * 100 + Number(fraction.padEnd(2, "0"))
    if (!Number.isSafeInteger(cents) || cents > line.maxCents) { error ??= `The deferral exceeds the amount available on ${line.description}.`; continue }
    if (cents === 0) continue
    if (draft.reason.trim().length < 3) error ??= `Add a reason for deferring ${line.description}.`
    deferrals.push({ prime_sov_line_id: line.id, deferred_cents: cents, reason: draft.reason.trim() })
  }
  const deferredCents = deferrals.reduce((sum, line) => sum + line.deferred_cents, 0)
  const certifiedCents = appliedCents - deferredCents
  if (certifiedCents <= 0) error ??= "Return the application if no payment can be certified."
  return { deferrals, deferredCents, certifiedCents, error }
}
