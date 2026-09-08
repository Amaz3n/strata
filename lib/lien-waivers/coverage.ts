import { payableOutstandingCents } from "@/lib/financials/payables-rules"
/** Shared incoming-waiver facts. A signature, review, and payment coverage are separate. */
export const WAIVER_KINDS = [
  "conditional_progress",
  "unconditional_progress",
  "conditional_final",
  "unconditional_final",
] as const
export type WaiverKind = (typeof WAIVER_KINDS)[number]
export const WAIVER_KIND_LABELS: Record<WaiverKind, string> = {
  conditional_progress: "Conditional progress",
  unconditional_progress: "Unconditional progress",
  conditional_final: "Conditional final",
  unconditional_final: "Unconditional final",
}
export interface WaiverEvidence {
  id: string
  waiver_type: string
  status: string
  amount_cents: number
  through_date: string | null
  signed_file_id?: string | null
  document_file_id?: string | null
  signed_at?: string | null
  metadata?: Record<string, unknown> | null
}
export interface CoverageBill {
  id: string
  project_id?: string | null
  company_id?: string | null
  commitment_id?: string | null
  total_cents: number
  paid_cents?: number | null
  retainage_cents?: number | null
  retainage_released_cents?: number | null
  status?: string
  metadata?: Record<string, unknown> | null
}
export function coveredWorkDate(
  bill: Pick<CoverageBill, "metadata">,
): string | null {
  const date = bill.metadata?.billing_period_end ?? bill.metadata?.through_date
  return typeof date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(date)
    ? date
    : null
}
export function normalizeWaiverKind(
  kind: string,
  metadata?: Record<string, unknown> | null,
): WaiverKind | null {
  if (WAIVER_KINDS.some((k) => k === kind)) return kind as WaiverKind
  if (kind === "conditional") return "conditional_progress"
  if (kind === "unconditional") return "unconditional_progress"
  // Historical final documents are ambiguous. Only explicit captured kind is reliable.
  const explicit = metadata?.waiver_kind
  return typeof explicit === "string" &&
    WAIVER_KINDS.some((k) => k === explicit)
    ? (explicit as WaiverKind)
    : null
}
export function evidenceAccepted(waiver: WaiverEvidence): boolean {
  const review = waiver.metadata?.review
  return (
    waiver.status === "signed" &&
    Boolean(waiver.signed_file_id ?? waiver.document_file_id) &&
    Boolean(waiver.signed_at) &&
    typeof review === "object" &&
    review !== null &&
    "status" in review &&
    review.status === "accepted"
  )
}
export function waiverCoverage(
  bill: CoverageBill,
  waivers: WaiverEvidence[],
  required: boolean,
  missingSubtiers = 0,
  missingCommitment = false,
  paymentAmountCents?: number,
) {
  const through = coveredWorkDate(bill)
  const outstandingCents = payableOutstandingCents(bill)
  const paymentCents = paymentAmountCents ?? outstandingCents
  if (
    !Number.isSafeInteger(paymentCents) ||
    paymentCents < 0 ||
    paymentCents > outstandingCents
  )
    throw new Error("Payment amount exceeds the payable balance")
  const accepted = waivers.filter(
    (w) => evidenceAccepted(w) && coverageBasisMatches(bill, w),
  )
  const covered = accepted.filter(
    (w) =>
      through &&
      w.through_date &&
      w.through_date >= through &&
      normalizeWaiverKind(w.waiver_type, w.metadata),
  )
  // A waiver covers an identified payment, not an arbitrary sum of overlapping documents.
  const conditional = covered.find(
    (w) =>
      normalizeWaiverKind(w.waiver_type, w.metadata)?.startsWith(
        "conditional",
      ) && w.amount_cents >= paymentCents,
  )
  const unconditional = covered.find(
    (w) =>
      normalizeWaiverKind(w.waiver_type, w.metadata)?.startsWith(
        "unconditional",
      ) && w.amount_cents >= (bill.paid_cents ?? 0),
  )
  const needsReview = waivers.some(
    (w) => w.status === "signed" && !evidenceAccepted(w),
  )
  const paid = outstandingCents === 0
  const reasons: string[] = []
  if (required && !paid) {
    if (!through) reasons.push("Set the work through date")
    if (!conditional)
      reasons.push(
        needsReview
          ? "Review the signed waiver"
          : "Accepted conditional waiver covering this payment required",
      )
    if (missingCommitment)
      reasons.push("Link a commitment to validate lower-tier waivers")
    if (missingSubtiers)
      reasons.push(
        `${missingSubtiers} lower-tier waiver${missingSubtiers === 1 ? "" : "s"} outstanding`,
      )
  }
  const postPaymentOutstanding =
    required && (bill.paid_cents ?? 0) > 0 && !unconditional
  const finalReceived =
    paid &&
    Math.max(
      0,
      (bill.retainage_cents ?? 0) - (bill.retainage_released_cents ?? 0),
    ) === 0 &&
    covered.some(
      (w) =>
        normalizeWaiverKind(w.waiver_type, w.metadata) ===
          "unconditional_final" && w.amount_cents >= (bill.paid_cents ?? 0),
    )
  return {
    through,
    outstandingCents,
    heldCents: reasons.length ? paymentCents : 0,
    reasons,
    needsReview,
    conditionalId: conditional?.id ?? null,
    unconditionalId: unconditional?.id ?? null,
    postPaymentOutstanding,
    finalReceived,
    satisfied:
      !required || ((paid || Boolean(conditional)) && !missingSubtiers),
    status: reasons.length
      ? needsReview
        ? "Needs review"
        : "Missing"
      : postPaymentOutstanding
        ? "Unconditional outstanding"
        : needsReview
          ? "Needs review"
          : required
            ? "Accepted"
            : "Not required",
  }
}
export function requirementCovered(
  requirement: {
    waiver_type: string
    amount_cents: number
    period_end: string
    claimant_company_name: string
    metadata?: Record<string, unknown>
  },
  waiver: WaiverEvidence & { claimant_name?: string | null },
) {
  return (
    requirement.metadata?.amount_needs_review !== true &&
    evidenceAccepted(waiver) &&
    normalizeWaiverKind(requirement.waiver_type, requirement.metadata) !==
      null &&
    normalizeWaiverKind(waiver.waiver_type, waiver.metadata) ===
      normalizeWaiverKind(requirement.waiver_type, requirement.metadata) &&
    waiver.amount_cents >= requirement.amount_cents &&
    Boolean(
      waiver.through_date && waiver.through_date >= requirement.period_end,
    ) &&
    waiver.claimant_name?.trim().toLocaleLowerCase() ===
      requirement.claimant_company_name.trim().toLocaleLowerCase()
  )
}

/** Freeze economic facts while allowing approval/delivery timestamps to change. */
export function waiverCoverageBasis(bill: CoverageBill) {
  return {
    total_cents: bill.total_cents,
    project_id: bill.project_id ?? null,
    company_id: bill.company_id ?? null,
    commitment_id: bill.commitment_id ?? null,
    retainage_cents: bill.retainage_cents ?? 0,
    through_date: coveredWorkDate(bill),
    paid_cents: bill.paid_cents ?? 0,
  }
}
export function coverageBasisMatches(
  bill: CoverageBill,
  waiver: WaiverEvidence,
) {
  const basis = waiver.metadata?.coverage_basis as
    | ReturnType<typeof waiverCoverageBasis>
    | undefined
  // Existing signed PDFs require explicit human review; do not infer a basis retroactively.
  if (!basis) return true
  if (
    basis.project_id !== (bill.project_id ?? null) ||
    basis.company_id !== (bill.company_id ?? null) ||
    basis.commitment_id !== (bill.commitment_id ?? null)
  )
    return false
  if (
    basis.total_cents !== bill.total_cents ||
    basis.retainage_cents !== (bill.retainage_cents ?? 0) ||
    basis.through_date !== coveredWorkDate(bill)
  )
    return false
  const paid = bill.paid_cents ?? 0
  return normalizeWaiverKind(waiver.waiver_type, waiver.metadata)?.startsWith(
    "conditional",
  )
    ? paid === basis.paid_cents
    : paid >= basis.paid_cents
}
