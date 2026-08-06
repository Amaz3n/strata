import "server-only"

import { getOrgSenderEmail, renderStandardEmailLayout, sendEmail } from "@/lib/services/mailer"
import { recordEvent } from "@/lib/services/events"
import { createServiceSupabaseClient } from "@/lib/supabase/server"

/**
 * Remittance advice.
 *
 * A subcontractor saw an unexplained deposit and called the PM to ask what it
 * covered. That call is the highest-volume support burden in AP, and it is the
 * thing subs judge a builder on — `vendor_payment_paid` was emitted as an event
 * and routed only to org members, so the one person who needed to know was the
 * one person who was never told.
 *
 * It applies to a check exactly as much as to an ACH. Sending it only for rail
 * payments meant the vendors most likely to be paid by check — the ones who
 * never onboarded, which is most of them at launch — were the ones who never got
 * an explanation.
 */

function money(cents: number) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(cents / 100)
}

function escapeHtml(value: string) {
  return value.replace(/[&<>"']/g, (character) =>
    character === "&" ? "&amp;"
      : character === "<" ? "&lt;"
      : character === ">" ? "&gt;"
      : character === '"' ? "&quot;"
      : "&#39;",
  )
}

function firstRelation<T>(value: T | T[] | null | undefined): T | null {
  if (Array.isArray(value)) return value[0] ?? null
  return value ?? null
}

const METHOD_LABELS: Record<string, string> = {
  ach: "Direct deposit",
  check: "Check",
  wire: "Wire",
  card: "Card",
  cash: "Cash",
  other: "Other",
}

/**
 * Who to tell. The people who administer the payout account are preferred — the
 * person who owns the bank account is the person reconciling the deposit — and
 * the builder's own contact record is the fallback for a vendor who never
 * onboarded.
 */
async function resolveRemittanceRecipients(input: {
  orgId: string
  companyId: string | null
  recipientAccountId: string | null
  companyEmail: string | null
}) {
  const supabase = createServiceSupabaseClient()
  let recipientAccountId = input.recipientAccountId
  if (!recipientAccountId && input.companyId) {
    const { data: relationship } = await supabase
      .from("vendor_payment_relationships")
      .select("recipient_account_id")
      .eq("org_id", input.orgId)
      .eq("company_id", input.companyId)
      .maybeSingle()
    recipientAccountId = relationship?.recipient_account_id ?? null
  }

  const { data: recipient } = recipientAccountId
    ? await supabase.from("payment_recipient_accounts").select("vendor_entity_id").eq("id", recipientAccountId).maybeSingle()
    : { data: null }
  const { data: administrators } = recipient?.vendor_entity_id
    ? await supabase
        .from("vendor_entity_memberships")
        .select("identity:vendor_portal_identities(email)")
        .eq("vendor_entity_id", recipient.vendor_entity_id)
        .eq("status", "active")
        .is("revoked_at", null)
        .limit(5)
    : { data: [] }
  const administratorEmails = (administrators ?? [])
    .map((row) => firstRelation(row.identity)?.email ?? null)
    .filter((email): email is string => Boolean(email))
  if (administratorEmails.length > 0) return administratorEmails
  return input.companyEmail ? [input.companyEmail] : []
}

async function deliverRemittance(input: {
  orgId: string
  billId: string
  amountCents: number
  retainageHeldCents: number
  recipientAccountId: string | null
  method: string
  reference: string | null
  entityType: "disbursement" | "payment"
  entityId: string
}) {
  const supabase = createServiceSupabaseClient()
  const [{ data: bill }, { data: org }] = await Promise.all([
    supabase
      .from("vendor_bills")
      .select("id,bill_number,total_cents,retainage_cents,company_id,project_id,company:companies(name,email),project:projects(name)")
      .eq("org_id", input.orgId)
      .eq("id", input.billId)
      .maybeSingle(),
    supabase.from("orgs").select("name,slug,logo_url").eq("id", input.orgId).maybeSingle(),
  ])
  if (!bill) return { sent: false as const, reason: "no_bill" as const }

  const company = firstRelation(bill.company)
  const project = firstRelation(bill.project)
  const to = await resolveRemittanceRecipients({
    orgId: input.orgId,
    companyId: bill.company_id,
    recipientAccountId: input.recipientAccountId,
    companyEmail: company?.email ?? null,
  })
  if (to.length === 0) return { sent: false as const, reason: "no_recipient_email" as const }

  const methodLabel = METHOD_LABELS[input.method] ?? input.method
  const rows: Array<[string, string]> = [
    ["Invoice", bill.bill_number ?? "—"],
    ["Project", project?.name ?? "—"],
    ["Invoice total", money(Number(bill.total_cents ?? 0))],
  ]
  if (input.retainageHeldCents > 0) rows.push(["Retainage held", `− ${money(input.retainageHeldCents)}`])
  rows.push(["Amount paid", money(input.amountCents)])
  rows.push(["Sent by", methodLabel])
  if (input.reference) rows.push(["Reference", input.reference])

  const detail = rows
    .map(([label, value]) => `<tr><td style="padding:4px 16px 4px 0;color:#666">${escapeHtml(label)}</td><td style="padding:4px 0;text-align:right;font-family:monospace">${escapeHtml(value)}</td></tr>`)
    .join("")

  // An ACH lands in an account and a check has to arrive in the post; promising
  // "a few business days" for a posted check would be the builder's problem the
  // moment it was not true.
  const arrivalHtml = input.method === "check"
    ? "has sent you a check. Allow normal mail time for it to arrive."
    : "has sent a payment to your bank account. It should appear within a few business days."

  const sent = await sendEmail({
    from: getOrgSenderEmail(org?.slug, org?.name),
    to,
    subject: `Payment sent: ${money(input.amountCents)}${bill.bill_number ? ` for invoice ${bill.bill_number}` : ""}`,
    html: renderStandardEmailLayout({
      title: "Payment sent",
      messageHtml: `<p>${escapeHtml(org?.name ?? "Your customer")} ${arrivalHtml}</p><table style="margin-top:12px;border-collapse:collapse">${detail}</table>`,
      orgName: org?.name,
      orgLogoUrl: org?.logo_url,
      showManageSettings: false,
    }),
  })
  if (!sent) return { sent: false as const, reason: "send_failed" as const }

  await recordEvent({
    orgId: input.orgId,
    eventType: "vendor_remittance_sent",
    entityType: input.entityType,
    entityId: input.entityId,
    payload: { bill_id: bill.id, amount_cents: input.amountCents, method: input.method },
  })
  return { sent: true as const }
}

/**
 * Send the vendor the detail behind one electronic deposit.
 *
 * Retainage held is named explicitly. A sub who was expecting the full invoice
 * and receives less will otherwise assume a short payment and call about it, and
 * "we held 10% retainage" is the answer — so it belongs in the email rather than
 * in the phone call.
 */
export async function sendVendorRemittanceAdvice(input: { orgId: string; disbursementId: string }) {
  const supabase = createServiceSupabaseClient()
  const { data: disbursement } = await supabase
    .from("disbursements")
    .select("id,org_id,bill_id,amount_cents,currency,run_id,recipient_account_id")
    .eq("org_id", input.orgId)
    .eq("id", input.disbursementId)
    .maybeSingle()
  if (!disbursement?.bill_id) return { sent: false as const, reason: "no_bill" as const }

  const { data: runItem } = await supabase
    .from("payment_run_items")
    .select("retainage_held_cents")
    .eq("org_id", input.orgId)
    .eq("run_id", disbursement.run_id)
    .eq("bill_id", disbursement.bill_id)
    .maybeSingle()

  const { data: bill } = await supabase
    .from("vendor_bills")
    .select("retainage_cents")
    .eq("org_id", input.orgId)
    .eq("id", disbursement.bill_id)
    .maybeSingle()

  return deliverRemittance({
    orgId: input.orgId,
    billId: disbursement.bill_id,
    amountCents: Number(disbursement.amount_cents),
    retainageHeldCents: Number(runItem?.retainage_held_cents ?? bill?.retainage_cents ?? 0),
    recipientAccountId: disbursement.recipient_account_id ?? null,
    method: "ach",
    reference: null,
    entityType: "disbursement",
    entityId: disbursement.id,
  })
}

/**
 * The same advice for a payment the builder recorded themselves — a check, a
 * wire, an ACH sent from their own bank. Best-effort at the call site: a
 * remittance that fails to send must never roll back a payment that was made.
 */
export async function sendManualPaymentRemittanceAdvice(input: { orgId: string; paymentId: string }) {
  const supabase = createServiceSupabaseClient()
  const { data: payment } = await supabase
    .from("payments")
    .select("id,bill_id,amount_cents,method,reference,check_number,status")
    .eq("org_id", input.orgId)
    .eq("id", input.paymentId)
    .maybeSingle()
  if (!payment?.bill_id) return { sent: false as const, reason: "no_bill" as const }
  if (!["succeeded", "completed"].includes(String(payment.status))) {
    return { sent: false as const, reason: "not_settled" as const }
  }

  const { data: bill } = await supabase
    .from("vendor_bills")
    .select("retainage_cents")
    .eq("org_id", input.orgId)
    .eq("id", payment.bill_id)
    .maybeSingle()

  return deliverRemittance({
    orgId: input.orgId,
    billId: payment.bill_id,
    amountCents: Number(payment.amount_cents),
    retainageHeldCents: Number(bill?.retainage_cents ?? 0),
    recipientAccountId: null,
    method: String(payment.method ?? "check"),
    // A check number is the thing the vendor will match against their deposit,
    // so it is worth more here than the free-text reference.
    reference: payment.check_number ?? payment.reference ?? null,
    entityType: "payment",
    entityId: payment.id,
  })
}
