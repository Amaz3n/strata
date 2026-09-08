/**
 * Who hears a decision on a payable.
 *
 * Pure, and separate from the fan-out, because this is the rule a bulk approval
 * broke: the RPC raised its own `vendor_bill_approved` with no submitter on the
 * payload, so every decision fell through to `eligibleRecipients` and fifty
 * approvals mailed the whole finance team fifty times instead of mailing each
 * submitter about their own invoice.
 */
export function resolvePayableDecisionAudience(input: {
  /** Everyone who both can see the payable and holds the permission. */
  eligibleRecipients: string[]
  /** `submitted_by_user_id` from the decision event, when the emitter carried it. */
  payloadSubmitterId?: string | null
  /** `actor_id` from the payable's original `vendor_bill_submitted` event. */
  submissionActorId?: string | null
}): string[] {
  const submitterId = input.payloadSubmitterId ?? input.submissionActorId ?? null
  // The permission-derived intersection is kept on purpose: an archived or
  // de-scoped submitter must not be handed a link to a bill they can no longer
  // open. When nobody can be identified as the submitter, the decision goes to
  // the people who could have made it — silence is the worse failure.
  if (!submitterId) return input.eligibleRecipients
  return input.eligibleRecipients.filter((userId) => userId === submitterId)
}
