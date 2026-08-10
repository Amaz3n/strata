import "server-only"

import { VendorBillDecisionEmail } from "@/lib/emails/vendor-bill-decision-email"
import { getOrgSenderEmail, renderEmailTemplate, sendEmail } from "@/lib/services/mailer"
import { ensurePortalLink } from "@/lib/services/portal-links"
import { recordEvent } from "@/lib/services/events"
import { createServiceSupabaseClient } from "@/lib/supabase/server"

/**
 * Telling a vendor what happened to the invoice they sent.
 *
 * A sub who submitted through the portal got no acknowledgement, no approval and
 * — the one that actually costs money on both sides — no rejection. They found
 * out by calling, or by resubmitting the same invoice unchanged because nobody
 * had told them what was wrong with it.
 *
 * Vendors are not org users, so this sends directly rather than through the
 * notification system, which resolves recipients from `memberships`.
 */

function firstRelation<T>(value: T | T[] | null | undefined): T | null {
  if (Array.isArray(value)) return value[0] ?? null
  return value ?? null
}

type BillNoticeKind = "approved" | "rejected"

/**
 * Best-effort by contract. The decision is already recorded and must not be
 * rolled back because a mail server was unreachable, so every failure path
 * returns a reason rather than throwing.
 */
export async function sendVendorBillDecisionNotice(input: {
  orgId: string
  billId: string
  kind: BillNoticeKind
  reason?: string | null
  eventId?: string | null
}) {
  const client = createServiceSupabaseClient()
  const { data: bill } = await client
    .from("vendor_bills")
    .select(
      "id,project_id,company_id,bill_number,total_cents,commitment:commitments(company_id),company:companies(name,email),project:projects(name),org:orgs(name,slug,logo_url)",
    )
    .eq("org_id", input.orgId)
    .eq("id", input.billId)
    .maybeSingle()
  if (!bill) return { sent: false as const, reason: "no_bill" as const }

  const commitment = firstRelation(bill.commitment)
  const companyId = bill.company_id ?? commitment?.company_id ?? null
  let company = firstRelation(bill.company)
  if (!company?.email && companyId) {
    const { data } = await client.from("companies").select("name,email").eq("org_id", input.orgId).eq("id", companyId).maybeSingle()
    company = data
  }
  if (!companyId || !company?.email) return { sent: false as const, reason: "no_recipient_email" as const }

  const org = firstRelation(bill.org)
  const project = firstRelation(bill.project)
  const invoiceLabel = bill.bill_number ? `invoice ${bill.bill_number}` : "your invoice"

  let buttonUrl: string | undefined
  try {
    const base = await ensurePortalLink({
      supabase: client,
      orgId: input.orgId,
      projectId: bill.project_id,
      portalType: "sub",
      companyId,
      capabilities: { can_view_bills: true },
      fallbackPath: `/projects/${bill.project_id}/financials/payables`,
    })
    buttonUrl = `${base}/bills`
  } catch {
    // A missing portal link is not a reason to withhold the decision itself.
    buttonUrl = undefined
  }

  const approved = input.kind === "approved"
  const html = await renderEmailTemplate(
    VendorBillDecisionEmail({
      orgName: org?.name,
      orgLogoUrl: org?.logo_url,
      kind: input.kind,
      invoiceLabel,
      projectName: project?.name ?? null,
      reason: input.reason,
      actionHref: buttonUrl,
    }),
  )

  const sent = await sendEmail({
    from: getOrgSenderEmail(org?.slug, org?.name),
    to: [company.email],
    subject: approved
      ? `Approved: ${bill.bill_number ?? "your invoice"}`
      : `Not accepted: ${bill.bill_number ?? "your invoice"}`,
    html,
    idempotencyKey: `vendor-bill-${input.kind}-${input.eventId ?? bill.id}`,
  })
  if (!sent) return { sent: false as const, reason: "send_failed" as const }

  await recordEvent({
    orgId: input.orgId,
    eventType: "vendor_bill_decision_notified",
    entityType: "vendor_bill",
    entityId: bill.id,
    payload: { project_id: bill.project_id, company_id: companyId, kind: input.kind },
  })
  return { sent: true as const }
}
