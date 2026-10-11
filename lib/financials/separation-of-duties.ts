/**
 * Separation of duties, as pure rules.
 *
 * The person who starts a money movement — enters a bill, prepares a payment
 * run, requests a budget transfer or a variance order — is not the one who
 * approves it. For bills the rule binds only when someone else could approve:
 * a one-person AP department (an owner who keys in and approves every bill) is
 * a supported way to run, and a two-person rule there is a wall, not a control;
 * the same reasoning as `orgHasAnotherPaymentReleaser` for payment release.
 */

/** The `reason_code` every separation refusal carries in `authorization_audit_log`. */
export const SEPARATION_OF_DUTIES_REASON_CODE = "deny_separation_of_duties"

/** Which rule refused the attempt; written to the denial row's `context.rule`. */
export type SeparationRule =
  | "bill.enterer_cannot_approve"
  | "commitment.creator_cannot_approve"
  | "payment_run.preparer_cannot_approve"
  | "budget_transfer.requester_cannot_approve"
  | "variance_order.requester_cannot_approve"

export const BILL_SELF_APPROVAL_MESSAGE =
  "You entered this payable, so someone else has to approve it."

/**
 * Who keyed the bill in: the person who entered it, or who uploaded the invoice
 * it was scanned from. Bills from a vendor, email or rule have no internal enterer.
 */
export function billEnteredByUserId(metadata: unknown): string | null {
  if (!metadata || typeof metadata !== "object") return null
  const submitted = Reflect.get(metadata, "submitted_by_user_id")
  if (typeof submitted === "string" && submitted.length > 0) return submitted
  if (Reflect.get(metadata, "internal_upload") !== true) return null
  const intake = Reflect.get(metadata, "intake")
  if (!intake || typeof intake !== "object") return null
  const uploader = Reflect.get(intake, "actor_id")
  return typeof uploader === "string" && uploader.length > 0 ? uploader : null
}

export function billApprovalViolatesSeparation(input: {
  metadata: unknown
  approverUserId: string
  anotherApproverExists: boolean
}) {
  return input.anotherApproverExists && billEnteredByUserId(input.metadata) === input.approverUserId
}

export const COMMITMENT_SELF_APPROVAL_MESSAGE =
  "You created this commitment, so someone else has to approve it."

/**
 * Who created the commitment, as recorded in its metadata at creation.
 * Generated, imported and older commitments have none and are never refused.
 */
export function commitmentCreatedByUserId(metadata: unknown): string | null {
  if (!metadata || typeof metadata !== "object") return null
  const creator = Reflect.get(metadata, "created_by_user_id")
  return typeof creator === "string" && creator.length > 0 ? creator : null
}

export function commitmentApprovalViolatesSeparation(input: {
  creatorUserId: string | null
  approverUserId: string
  anotherApproverExists: boolean
}) {
  return input.anotherApproverExists && input.creatorUserId === input.approverUserId
}
