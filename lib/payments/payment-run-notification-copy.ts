/**
 * What a payment run's notifications say.
 *
 * Pure, and separate from the fan-out, because the sentence "approved and on its
 * way to the vendor" was wrong three times out of four: an approval can schedule
 * the debit for a later business day, hand the release to the sweep because the
 * approver's role cannot move money, or be stopped outright by a gate — and the
 * builder was told the same thing in every case.
 */

/** How an approval resolved into money movement. Mirrors `PaymentRunRelease`. */
export type PaymentRunReleaseKind = "none" | "released" | "scheduled" | "queued" | "blocked"

export const PAYMENT_RUN_RELEASE_KINDS: readonly PaymentRunReleaseKind[] = [
  "none",
  "released",
  "scheduled",
  "queued",
  "blocked",
]

export function readReleaseKind(value: unknown): PaymentRunReleaseKind {
  return typeof value === "string" && (PAYMENT_RUN_RELEASE_KINDS as readonly string[]).includes(value)
    ? (value as PaymentRunReleaseKind)
    : "none"
}

export interface PaymentRunNotificationFacts {
  eventType: "payment_run_submitted" | "payment_run_approved" | "payment_run_approval_recorded" | "payment_run_rejected"
  vendorName?: string | null
  billNumber?: string | null
  projectName?: string | null
  billCount?: number | null
  totalDebitCents?: number | null
  /** Rejection reason, given by the approver. */
  reason?: string | null
  release?: PaymentRunReleaseKind
  /** Business date a scheduled release will debit on, as `YYYY-MM-DD`. */
  releaseScheduledFor?: string | null
  /** Why a release was queued or blocked. */
  releaseReason?: string | null
}

function formatCents(cents: number) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(cents / 100)
}

/** `2026-09-14` as `September 14, 2026`, in UTC — the reckoning `scheduled_for` uses. */
export function formatReleaseDate(value: string | null | undefined): string | null {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null
  const parsed = new Date(`${value}T00:00:00Z`)
  if (Number.isNaN(parsed.getTime())) return null
  return new Intl.DateTimeFormat("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "UTC" }).format(parsed)
}

/** "Acme Concrete · invoice 1042 · Westside", or "6 vendor bills" for a batch. */
export function paymentRunSubject(facts: PaymentRunNotificationFacts): string {
  const billCount = typeof facts.billCount === "number" ? facts.billCount : 1
  if (billCount > 1) return `${billCount} vendor bills`
  const vendor = facts.vendorName || "a vendor"
  const invoice = facts.billNumber ? ` · invoice ${facts.billNumber}` : ""
  const project = facts.projectName ? ` · ${facts.projectName}` : ""
  return `${vendor}${invoice}${project}`
}

/**
 * The one sentence an approved run gets. Every branch here is a state the rail
 * can actually be in the instant the approval commits.
 */
export function approvedReleaseSentence(facts: PaymentRunNotificationFacts): string {
  const release = facts.release ?? "none"
  const scheduledLabel = formatReleaseDate(facts.releaseScheduledFor)
  switch (release) {
    case "released":
      return "approved and funding started. Vendors are paid on the provider's normal ACH timing."
    case "scheduled":
      return scheduledLabel
        ? `approved and scheduled for ${scheduledLabel}. Nothing leaves the bank until then.`
        : "approved and scheduled for its release date. Nothing leaves the bank until then."
    case "queued":
      return `approved. ${facts.releaseReason || "Arc sends it on the next release pass."}`
    case "blocked":
      return `approved but held: ${facts.releaseReason || "the release could not be completed"}. The run stays approved and Arc retries it.`
    default:
      return "approved. Arc sends it on the next release pass."
  }
}

export function paymentRunNotificationCopy(facts: PaymentRunNotificationFacts): { title: string; message: string } {
  const subject = paymentRunSubject(facts)
  const amount = typeof facts.totalDebitCents === "number" ? formatCents(facts.totalDebitCents) : null

  switch (facts.eventType) {
    case "payment_run_submitted":
      return {
        title: `Payment needs your approval${amount ? `: ${amount}` : ""}`,
        message: `${subject}. Open it to review the bill and release the payment.`,
      }
    case "payment_run_approved": {
      const release = facts.release ?? "none"
      const title =
        release === "blocked"
          ? `Payment approved but held${amount ? `: ${amount}` : ""}`
          : release === "scheduled"
            ? `Payment approved and scheduled${amount ? `: ${amount}` : ""}`
            : `Payment approved${amount ? `: ${amount}` : ""}`
      return { title, message: `${subject} is ${approvedReleaseSentence(facts)}` }
    }
    case "payment_run_rejected":
      return {
        title: "Payment rejected",
        message: `${subject} was rejected${facts.reason ? `: ${facts.reason}` : "."}`,
      }
    default:
      return {
        title: "Payment approval recorded",
        message: `An approver recorded a decision on ${subject}. It still needs another approval before it can release.`,
      }
  }
}
