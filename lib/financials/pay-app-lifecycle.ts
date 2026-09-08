import type { PayApplicationDeferral } from "@/lib/financials/pay-app-certification"
/**
 * Where a pay application stands, from the facts the row and its invoice carry.
 *
 * The stored `status` column only knows draft → invoiced → approved → paid →
 * void. The people reading the register need more than that: was it sent to
 * the owner, is it waiting on the owner's certificate, did the owner send it
 * back. Those facts live in `metadata` and on the invoice, and this is the one
 * place that turns them into a stage. Pure, so the register, the workbench and
 * the owner portal cannot disagree.
 */

export type PayApplicationStage =
  | "draft"
  | "returned"
  | "submitted"
  | "awaiting_certification"
  | "certified"
  | "billed"
  | "paid"
  | "void"

export interface PayApplicationStageFacts {
  status: string
  /** How many times the owner sent it back; a returned draft is a revision. */
  revision: number
  sentToOwnerAt: string | null
  certifiedAt: string | null
  /** The posture requires the owner's certificate before the invoice issues. */
  certificationRequired: boolean
  invoiceStatus: string | null
}

const ISSUED_INVOICE_STATUSES = new Set(["sent", "partial", "paid", "overdue"])

export function derivePayApplicationStage(facts: PayApplicationStageFacts): PayApplicationStage {
  if (facts.status === "void") return "void"
  if (facts.status === "paid") return "paid"
  if (facts.status === "draft") return facts.revision > 0 ? "returned" : "draft"
  if (facts.status === "approved" || facts.certifiedAt) return "certified"
  // status is invoiced or submitted: the application is posted and its invoice exists.
  if (facts.certificationRequired) return facts.sentToOwnerAt ? "awaiting_certification" : "submitted"
  return facts.invoiceStatus && ISSUED_INVOICE_STATUSES.has(facts.invoiceStatus) ? "billed" : "submitted"
}

export const PAY_APPLICATION_STAGE_LABELS: Record<PayApplicationStage, string> = {
  draft: "Draft",
  returned: "Returned",
  submitted: "Submitted",
  awaiting_certification: "Awaiting certification",
  certified: "Certified",
  billed: "Billed",
  paid: "Paid",
  void: "Void",
}

/** The stages where the owner has not yet acted and the builder is waiting. */
export function stageIsWaitingOnOwner(stage: PayApplicationStage) {
  return stage === "awaiting_certification"
}

/** The stages where an application is posted and cannot be edited. */
export function stageIsPosted(stage: PayApplicationStage) {
  return stage !== "draft" && stage !== "returned" && stage !== "void"
}

/**
 * The certificate the owner (or their architect) signs. A reduced certificate
 * identifies each net-payment deferral by SOV line while preserving the
 * original request. Contract retainage remains a separate calculation.
 */
export interface PayApplicationCertification {
  certified_at: string
  signer_name: string
  signature_text: string
  certified_amount_cents: number
  requested_amount_cents?: number
  deferred_amount_cents?: number
  deferrals?: PayApplicationDeferral[]
  source: "portal" | "internal"
  note: string | null
  /** The portal link the owner signed from, when it was the portal. */
  portal_token_id: string | null
  contact_id: string | null
  /** The org member who recorded it, when it was recorded internally. */
  recorded_by: string | null
}

export interface PayApplicationReturn {
  reason: string
  returned_at: string
  source: "portal" | "internal"
  actor_name: string | null
  /** The revision that was returned; the next draft is revision + 1. */
  revision: number
}

export function readCertification(metadata: Record<string, unknown> | null | undefined): PayApplicationCertification | null {
  const raw = metadata?.certification
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null
  const record = raw as Record<string, unknown>
  if (typeof record.certified_at !== "string" || typeof record.signer_name !== "string") return null
  return {
    certified_at: record.certified_at,
    signer_name: record.signer_name,
    signature_text: typeof record.signature_text === "string" ? record.signature_text : record.signer_name,
    certified_amount_cents: Number(record.certified_amount_cents ?? 0),
    requested_amount_cents: Number(record.requested_amount_cents ?? record.certified_amount_cents ?? 0),
    deferred_amount_cents: Number(record.deferred_amount_cents ?? 0),
    deferrals: Array.isArray(record.deferrals) ? record.deferrals as PayApplicationDeferral[] : [],
    source: record.source === "internal" ? "internal" : "portal",
    note: typeof record.note === "string" && record.note.trim() ? record.note : null,
    portal_token_id: typeof record.portal_token_id === "string" ? record.portal_token_id : null,
    contact_id: typeof record.contact_id === "string" ? record.contact_id : null,
    recorded_by: typeof record.recorded_by === "string" ? record.recorded_by : null,
  }
}

export function readReturns(metadata: Record<string, unknown> | null | undefined): PayApplicationReturn[] {
  const raw = metadata?.returns
  if (!Array.isArray(raw)) return []
  return raw.flatMap((entry) => {
    if (!entry || typeof entry !== "object") return []
    const record = entry as Record<string, unknown>
    if (typeof record.reason !== "string" || typeof record.returned_at !== "string") return []
    return [
      {
        reason: record.reason,
        returned_at: record.returned_at,
        source: record.source === "internal" ? "internal" : "portal",
        actor_name: typeof record.actor_name === "string" ? record.actor_name : null,
        revision: Number(record.revision ?? 0),
      },
    ]
  })
}

export function readRevision(metadata: Record<string, unknown> | null | undefined): number {
  const value = Number(metadata?.revision ?? 0)
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0
}

export function readSentToOwner(metadata: Record<string, unknown> | null | undefined): { at: string; recipients: string[] } | null {
  const raw = metadata?.sent_to_owner
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null
  const record = raw as Record<string, unknown>
  if (typeof record.at !== "string") return null
  const recipients = Array.isArray(record.recipients) ? record.recipients.filter((value): value is string => typeof value === "string") : []
  return { at: record.at, recipients }
}
