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

/**
 * Send the vendor the detail behind one deposit.
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

  const [{ data: bill }, { data: org }, { data: runItem }] = await Promise.all([
    supabase
      .from("vendor_bills")
      .select("id,bill_number,total_cents,retainage_cents,company_id,project_id,company:companies(name,email),project:projects(name)")
      .eq("org_id", input.orgId)
      .eq("id", disbursement.bill_id)
      .maybeSingle(),
    supabase.from("orgs").select("name,slug,logo_url").eq("id", input.orgId).maybeSingle(),
    supabase
      .from("payment_run_items")
      .select("retainage_held_cents,gross_payment_cents")
      .eq("org_id", input.orgId)
      .eq("run_id", disbursement.run_id)
      .eq("bill_id", disbursement.bill_id)
      .maybeSingle(),
  ])
  if (!bill) return { sent: false as const, reason: "no_bill" as const }

  const company = Array.isArray(bill.company) ? bill.company[0] : bill.company
  const project = Array.isArray(bill.project) ? bill.project[0] : bill.project

  // Prefer the identity that actually onboarded the bank account: the person who
  // owns it is the person who has to reconcile the deposit. Fall back to the
  // builder's own contact record, which is what the waiver chase already uses.
  const { data: recipient } = disbursement.recipient_account_id
    ? await supabase
        .from("payment_recipient_accounts")
        .select("vendor_entity_id")
        .eq("id", disbursement.recipient_account_id)
        .maybeSingle()
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
    .map((row) => {
      const identity = Array.isArray(row.identity) ? row.identity[0] : row.identity
      return identity?.email ?? null
    })
    .filter((email): email is string => Boolean(email))
  const to = administratorEmails.length > 0 ? administratorEmails : company?.email ? [company.email] : []
  if (to.length === 0) return { sent: false as const, reason: "no_recipient_email" as const }

  const retainageHeldCents = Number(runItem?.retainage_held_cents ?? bill.retainage_cents ?? 0)
  const rows: Array<[string, string]> = [
    ["Invoice", bill.bill_number ?? "—"],
    ["Project", project?.name ?? "—"],
    ["Invoice total", money(Number(bill.total_cents ?? 0))],
  ]
  if (retainageHeldCents > 0) rows.push(["Retainage held", `− ${money(retainageHeldCents)}`])
  rows.push(["Amount paid", money(Number(disbursement.amount_cents))])

  const detail = rows
    .map(([label, value]) => `<tr><td style="padding:4px 16px 4px 0;color:#666">${escapeHtml(label)}</td><td style="padding:4px 0;text-align:right;font-family:monospace">${escapeHtml(value)}</td></tr>`)
    .join("")

  const sent = await sendEmail({
    from: getOrgSenderEmail(org?.slug, org?.name),
    to,
    subject: `Payment sent: ${money(Number(disbursement.amount_cents))}${bill.bill_number ? ` for invoice ${bill.bill_number}` : ""}`,
    html: renderStandardEmailLayout({
      title: "Payment sent",
      messageHtml: `<p>${escapeHtml(org?.name ?? "Your customer")} has sent a payment to your bank account. It should appear within a few business days.</p><table style="margin-top:12px;border-collapse:collapse">${detail}</table>`,
      orgName: org?.name,
      orgLogoUrl: org?.logo_url,
      showManageSettings: false,
    }),
  })
  if (!sent) return { sent: false as const, reason: "send_failed" as const }

  await recordEvent({
    orgId: input.orgId,
    eventType: "vendor_remittance_sent",
    entityType: "disbursement",
    entityId: disbursement.id,
    payload: { bill_id: bill.id, amount_cents: disbursement.amount_cents },
  })
  return { sent: true as const }
}
