import "server-only"

import { z } from "zod"

import { payableOutstandingCents } from "@/lib/financials/payables-rules"
import { recordAudit } from "@/lib/services/audit"
import { requireOrgContext } from "@/lib/services/context"
import { recordEvent } from "@/lib/services/events"
import { sendVendorPaymentInviteEmail } from "@/lib/services/mailer"
import { requireAnyPermission } from "@/lib/services/permissions"
import { isVendorPayoutSetupOpen } from "@/lib/services/payment-rail-setup"
import { decryptPortalToken, encryptPortalToken, generatePortalToken, hashPortalToken } from "@/lib/services/portal-credentials"
import { createServiceSupabaseClient } from "@/lib/supabase/server"

/**
 * Where a builder's vendor stands on electronic payment, as a company-level
 * fact. The payout account belongs to the vendor's legal entity, but whether
 * *this* builder can pay them is the `(org_id, company_id)` relationship — which
 * is why readiness lives on the company record and not on any project.
 */
export type CompanyPaymentReadinessStatus = "ready" | "verifying" | "invited" | "not_started"

export interface CompanyPaymentReadiness {
  companyId: string
  status: CompanyPaymentReadinessStatus
  invitedAt: string | null
}

const RELATIONSHIP_STATUS_TO_READINESS: Record<string, CompanyPaymentReadinessStatus> = {
  active: "ready",
  onboarding: "verifying",
  claim_pending: "verifying",
  invited: "invited",
}

export async function listCompanyPaymentReadiness(
  companyIds: string[],
  orgId?: string,
): Promise<Map<string, CompanyPaymentReadiness>> {
  const readiness = new Map<string, CompanyPaymentReadiness>()
  if (companyIds.length === 0) return readiness
  const context = await requireOrgContext(orgId)
  const supabase = createServiceSupabaseClient()
  const { data, error } = await supabase
    .from("vendor_payment_relationships")
    .select("company_id,status,invited_at")
    .eq("org_id", context.orgId)
    .in("company_id", companyIds)
  if (error) throw new Error(`Unable to load vendor payment readiness: ${error.message}`)
  for (const row of data ?? []) {
    const status = RELATIONSHIP_STATUS_TO_READINESS[row.status]
    if (!status) continue
    readiness.set(row.company_id, { companyId: row.company_id, status, invitedAt: row.invited_at ?? null })
  }
  for (const companyId of companyIds) {
    if (!readiness.has(companyId)) {
      readiness.set(companyId, { companyId, status: "not_started", invitedAt: null })
    }
  }
  return readiness
}

export interface UnpayableVendor {
  companyId: string
  companyName: string
  status: CompanyPaymentReadinessStatus
  openBillCount: number
  outstandingCents: number
}

/**
 * Vendors this builder owes money to right now but cannot pay electronically.
 *
 * This is the highest-intent moment to ask a vendor to set up direct deposit —
 * there is a real amount waiting — so the payables desk, not the directory, is
 * where activation actually comes from.
 */
export async function listUnpayableVendorsWithOpenBills(
  projectIds: string[] | null = null,
  orgId?: string,
): Promise<UnpayableVendor[]> {
  const context = await requireOrgContext(orgId)
  if (projectIds && projectIds.length === 0) return []
  const supabase = createServiceSupabaseClient()
  let query = supabase
    .from("vendor_bills")
    .select("company_id,total_cents,paid_cents,retainage_cents")
    .eq("org_id", context.orgId)
    .in("status", ["approved", "partial"])
    .not("company_id", "is", null)
    .limit(1000)
  if (projectIds) query = query.in("project_id", projectIds)
  const { data: bills, error } = await query
  if (error) throw new Error(`Unable to load open payables: ${error.message}`)

  const byCompany = new Map<string, { openBillCount: number; outstandingCents: number }>()
  for (const bill of bills ?? []) {
    if (!bill.company_id) continue
    const outstanding = payableOutstandingCents({
      total_cents: Number(bill.total_cents ?? 0),
      paid_cents: Number(bill.paid_cents ?? 0),
      retainage_cents: Number(bill.retainage_cents ?? 0),
    })
    if (outstanding <= 0) continue
    const entry = byCompany.get(bill.company_id) ?? { openBillCount: 0, outstandingCents: 0 }
    entry.openBillCount += 1
    entry.outstandingCents += outstanding
    byCompany.set(bill.company_id, entry)
  }
  const companyIds = [...byCompany.keys()]
  if (companyIds.length === 0) return []

  const [readiness, { data: companies, error: companyError }] = await Promise.all([
    listCompanyPaymentReadiness(companyIds, context.orgId),
    supabase.from("companies").select("id,name").eq("org_id", context.orgId).in("id", companyIds),
  ])
  if (companyError) throw new Error(`Unable to load vendor names: ${companyError.message}`)
  const nameById = new Map((companies ?? []).map((company) => [company.id, company.name]))

  return companyIds
    .flatMap((companyId) => {
      const status = readiness.get(companyId)?.status ?? "not_started"
      if (status === "ready") return []
      const totals = byCompany.get(companyId)
      if (!totals) return []
      return [{
        companyId,
        companyName: nameById.get(companyId) ?? "Vendor",
        status,
        openBillCount: totals.openBillCount,
        outstandingCents: totals.outstandingCents,
      }]
    })
    .sort((left, right) => right.outstandingCents - left.outstandingCents)
}

/**
 * The sub portal link the invitation points at.
 *
 * `portal_access_tokens.project_id` is NOT NULL, so a payment invitation — a
 * company-level ask — still has to ride a project-scoped credential. Reusing the
 * vendor's existing sub link keeps that invisible to them; only a vendor who has
 * never been given portal access needs a new one minted, and it is scoped to the
 * project the builder most recently did business with them on.
 */
async function resolveVendorPortalLink(orgId: string, companyId: string, userId: string) {
  const supabase = createServiceSupabaseClient()
  const { data: existing } = await supabase
    .from("portal_access_tokens")
    .select("token_encrypted")
    .eq("org_id", orgId)
    .eq("company_id", companyId)
    .eq("portal_type", "sub")
    .is("revoked_at", null)
    .is("paused_at", null)
    .or(`expires_at.is.null,expires_at.gt.${new Date().toISOString()}`)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle()
  const reusable = decryptPortalToken(existing?.token_encrypted ?? null)
  if (reusable) return reusable

  const { data: bill } = await supabase
    .from("vendor_bills")
    .select("project_id")
    .eq("org_id", orgId)
    .eq("company_id", companyId)
    .not("project_id", "is", null)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle()
  if (!bill?.project_id) {
    throw new Error("This vendor has no portal access and no project history yet. Share a sub portal link from a project first.")
  }

  const plaintextToken = generatePortalToken()
  const { error } = await supabase.from("portal_access_tokens").insert({
    token_hash: hashPortalToken(plaintextToken),
    token_encrypted: encryptPortalToken(plaintextToken),
    org_id: orgId,
    project_id: bill.project_id,
    company_id: companyId,
    portal_type: "sub",
    created_by: userId,
  })
  if (error) throw new Error(`Unable to create the vendor portal link: ${error.message}`)
  return plaintextToken
}

/**
 * Ask a vendor to set up electronic payment. Idempotent by design: re-inviting a
 * vendor who is already verifying or ready never downgrades their relationship,
 * it just re-sends the link.
 */
export async function inviteCompanyToPaymentSetup(input: { companyId: string }, orgId?: string) {
  const parsed = z.object({ companyId: z.string().uuid() }).parse(input)
  const context = await requireOrgContext(orgId)
  await requireAnyPermission(["payment.release", "payments.manage_rail"], context)
  if (!(await isVendorPayoutSetupOpen(context.orgId))) {
    throw new Error("Set up vendor payments in Settings before inviting vendors")
  }
  const supabase = createServiceSupabaseClient()
  const { data: company } = await supabase
    .from("companies")
    .select("id,name")
    .eq("org_id", context.orgId)
    .eq("id", parsed.companyId)
    .maybeSingle()
  if (!company) throw new Error("Vendor company was not found")

  const { data: relationship } = await supabase
    .from("vendor_payment_relationships")
    .select("id,status")
    .eq("org_id", context.orgId)
    .eq("company_id", company.id)
    .maybeSingle()
  if (relationship?.status === "active") throw new Error(`${company.name} is already set up for electronic payment`)
  if (relationship?.status === "revoked" || relationship?.status === "suspended") {
    throw new Error(`${company.name}'s payment access is ${relationship.status}. Restore it before re-inviting.`)
  }

  const [{ data: contacts }, { data: org }] = await Promise.all([
    supabase
      .from("contacts")
      .select("id,email,full_name")
      .eq("org_id", context.orgId)
      .eq("primary_company_id", company.id)
      .not("email", "is", null)
      .limit(5),
    supabase.from("orgs").select("name,slug,logo_url").eq("id", context.orgId).maybeSingle(),
  ])
  const recipients = (contacts ?? []).filter((contact): contact is { id: string; email: string; full_name: string | null } => Boolean(contact.email))
  if (recipients.length === 0) {
    throw new Error(`${company.name} has no contact with an email address. Add one in the directory first.`)
  }

  const token = await resolveVendorPortalLink(context.orgId, company.id, context.userId)
  const nowIso = new Date().toISOString()

  // Only claim the relationship when the vendor has not already started. An
  // in-flight `onboarding` row must keep its status and recipient link.
  if (!relationship) {
    const { error } = await supabase.from("vendor_payment_relationships").insert({
      org_id: context.orgId,
      company_id: company.id,
      status: "invited",
      invited_at: nowIso,
      invited_by: context.userId,
    })
    if (error) throw new Error(`Unable to record the payment invitation: ${error.message}`)
  } else {
    await supabase
      .from("vendor_payment_relationships")
      .update({ invited_at: nowIso, invited_by: context.userId })
      .eq("org_id", context.orgId)
      .eq("id", relationship.id)
  }

  const sent = await sendVendorPaymentInviteEmail({
    to: recipients.map((contact) => contact.email),
    recipientName: recipients.length === 1 ? recipients[0].full_name : null,
    companyName: company.name,
    orgName: org?.name ?? "Your builder",
    orgSlug: org?.slug ?? null,
    orgLogoUrl: org?.logo_url ?? null,
    setupUrl: `${(process.env.NEXT_PUBLIC_APP_URL ?? "https://arcnaples.com").replace(/\/$/, "")}/s/${token}/payments`,
  })

  await Promise.all([
    recordEvent({
      orgId: context.orgId,
      actorId: context.userId,
      eventType: "vendor_payment_invitation_sent",
      entityType: "company",
      entityId: company.id,
      payload: { recipients: recipients.length, delivered: sent },
    }),
    recordAudit({
      orgId: context.orgId,
      actorId: context.userId,
      action: relationship ? "update" : "insert",
      entityType: "vendor_payment_relationship",
      entityId: relationship?.id ?? company.id,
      after: { status: relationship?.status ?? "invited", invited_at: nowIso },
    }),
  ])

  return { companyName: company.name, recipients: recipients.length, delivered: sent }
}
