/**
 * Separation of duties for payable approval, as pure rules.
 *
 * The person who entered a bill must not be the one who approves it - but only
 * when someone else could. A one-person AP department (an owner who keys in and
 * approves every bill) is a supported way to run, and a two-person rule there is
 * a wall, not a control; the same reasoning as `orgHasAnotherPaymentReleaser`
 * for payment release.
 */

export const BILL_SELF_APPROVAL_MESSAGE =
  "You entered this payable, so someone else has to approve it."

/** Who keyed the bill in. Bills from a vendor, email or rule have no internal enterer. */
export function billEnteredByUserId(metadata: unknown): string | null {
  if (!metadata || typeof metadata !== "object") return null
  const value = Reflect.get(metadata, "submitted_by_user_id")
  return typeof value === "string" && value.length > 0 ? value : null
}

export function billApprovalViolatesSeparation(input: {
  metadata: unknown
  approverUserId: string
  anotherApproverExists: boolean
}) {
  return input.anotherApproverExists && billEnteredByUserId(input.metadata) === input.approverUserId
}
