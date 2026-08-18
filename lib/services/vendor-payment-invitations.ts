import "server-only"

import { z } from "zod"

import { recordAudit } from "@/lib/services/audit"
import { requireOrgContext } from "@/lib/services/context"
import { recordEvent } from "@/lib/services/events"
import { sendVendorPaymentInviteEmail } from "@/lib/services/mailer"
import { requireAnyPermission, requirePermission } from "@/lib/services/permissions"
import { requireRecentPaymentStepUp } from "@/lib/services/payment-step-up"
import { isVendorPayoutSetupOpen } from "@/lib/services/payment-rail-setup"
import { decryptPortalToken, encryptPortalToken, generatePortalToken, hashPortalToken } from "@/lib/services/portal-credentials"
import { createServiceSupabaseClient } from "@/lib/supabase/server"

/**
 * Where a builder's vendor stands on Arc Pay, as a company-level
 * fact. The payout account belongs to the vendor's legal entity, but whether
 * *this* builder can pay them is the `(org_id, company_id)` relationship — which
 * is why readiness lives on the company record and not on any project.
 */
export type CompanyPaymentReadinessStatus =
  | "ready"
  | "verifying"
  | "invited"
  | "not_started"
  /** Access was deliberately paused or withdrawn — NOT the same as never
   *  started. Reporting these as `not_started` offered an Invite button the
   *  service then refused; they surface honestly instead. */
  | "suspended"
  | "revoked"

export interface CompanyPaymentReadiness {
  companyId: string
  status: CompanyPaymentReadinessStatus
  invitedAt: string | null
}

const paymentAccessStatusSchema = z.enum(["active", "suspended", "revoked"])

/**
 * Builder-owned control over whether this vendor may receive this org's money.
 *
 * **Step-up applies to all three directions.** This decides whether an ACH run
 * can pay a destination, which is the same class of decision as approving a
 * funding-source change — and that one has required a recent second factor
 * since `decidePaymentControlChange` shipped. A session hijacked without the
 * second factor could otherwise stop a legitimate vendor's payments or, worse,
 * reopen one an AP clerk had deliberately cut off.
 *
 * **Restore is held to a higher bar than suspend**, because suspend stops money
 * and restore starts it:
 *
 *  - it needs `payment.manage_rail`, not merely `payment.release`;
 *  - it re-arms `accepted_at`, which puts the relationship back inside the org's
 *    `new_vendor_hold_hours` window. The first run after a restore then trips
 *    `recently_claimed_vendor_relationship` and blocks, exactly as it does for a
 *    vendor claimed for the first time. That is the cooling period: a restore
 *    cannot be followed by an immediate payment to a destination nobody
 *    re-checked.
 *
 * Withdrawal is not a one-layer change. `vendor_company_claims` is the mapping
 * that authorises payouts for this builder, and a revoke tears it down with the
 * relationship; the vendor-facing payment surface reads the same relationship
 * status, so it closes at the same moment.
 */
export async function setCompanyPaymentAccessStatus(
  input: { companyId: string; status: z.infer<typeof paymentAccessStatusSchema> },
  orgId?: string,
) {
  const parsed = z.object({ companyId: z.string().uuid(), status: paymentAccessStatusSchema }).parse(input)
  const context = await requireOrgContext(orgId)
  if (parsed.status === "active") {
    await requirePermission("payment.manage_rail", context)
  } else {
    await requireAnyPermission(["payment.release", "payment.manage_rail"], context)
  }
  await requireRecentPaymentStepUp()
  const supabase = createServiceSupabaseClient()
  const { data: relationship, error } = await supabase
    .from("vendor_payment_relationships")
    .select("id,status,vendor_company_claim_id,recipient_account_id,recipient:payment_recipient_accounts(status,payouts_enabled)")
    .eq("org_id", context.orgId)
    .eq("company_id", parsed.companyId)
    .maybeSingle()
  if (error || !relationship) throw new Error("Vendor payment relationship was not found")
  const beforeStatus = relationship.status
  let nextStatus: string = parsed.status
  if (parsed.status === "active") {
    const recipient = Array.isArray(relationship.recipient) ? relationship.recipient[0] : relationship.recipient
    nextStatus = recipient?.status === "ready" && recipient.payouts_enabled ? "active" : "onboarding"
  }
  if (beforeStatus === nextStatus) return { status: nextStatus }

  const now = new Date().toISOString()
  const { data: updatedRelationship, error: updateError } = await supabase
    .from("vendor_payment_relationships")
    .update({
      status: nextStatus,
      suspended_at: nextStatus === "suspended" ? now : null,
      revoked_at: nextStatus === "revoked" ? now : null,
      // See the doc comment: a restore re-enters the new-vendor hold window.
      ...(parsed.status === "active" ? { accepted_at: now } : {}),
    })
    .eq("org_id", context.orgId)
    .eq("id", relationship.id)
    .eq("status", beforeStatus)
    .select("id")
    .maybeSingle()
  if (updateError) throw new Error(`Unable to update vendor payment access: ${updateError.message}`)
  if (!updatedRelationship) {
    throw new Error("Vendor payment access changed while you were reviewing it. Refresh and try again.")
  }

  // Revoking is terminal, so the claim behind it goes too. Suspension is meant
  // to be reversible, so it deliberately leaves the claim standing — otherwise
  // "restore" would have to rebuild a mapping the vendor is the only one who
  // can re-establish.
  if (nextStatus === "revoked" && relationship.vendor_company_claim_id) {
    const { error: claimError } = await supabase
      .from("vendor_company_claims")
      .update({ status: "revoked", revoked_at: now })
      .eq("org_id", context.orgId)
      .eq("id", relationship.vendor_company_claim_id)
      .neq("status", "revoked")
    if (claimError) throw new Error(`Unable to withdraw the vendor claim: ${claimError.message}`)
  }

  await Promise.all([
    recordEvent({
      orgId: context.orgId,
      actorId: context.userId,
      eventType: `vendor_payment_relationship_${nextStatus}`,
      entityType: "vendor_payment_relationship",
      entityId: relationship.id,
      payload: { company_id: parsed.companyId, before_status: beforeStatus, status: nextStatus },
    }),
    recordAudit({
      orgId: context.orgId,
      actorId: context.userId,
      action: "update",
      entityType: "vendor_payment_relationship",
      entityId: relationship.id,
      before: { status: beforeStatus },
      after: {
        status: nextStatus,
        ...(nextStatus === "revoked" ? { claim_status: "revoked" } : {}),
        ...(parsed.status === "active" ? { accepted_at: now, new_vendor_hold_rearmed: true } : {}),
      },
    }),
  ])
  return { status: nextStatus }
}

/** Relationship states a token-lifecycle change may still act on. */
const LIVE_RELATIONSHIP_STATUSES = ["invited", "claim_pending", "onboarding", "active"]

/**
 * Carries a portal access record's lifecycle through to payment authority.
 *
 * The link a vendor followed to claim payout setup is not decoration: it is
 * recorded on the claim as `source_portal_token_id`, and it is the credential
 * that established this builder's mapping onto the vendor's global payout
 * account. Revoking it while leaving `vendor_payment_relationships` active left
 * the builder paying a destination whose only provenance they had just torn up
 * — the mirror image of the bug `cascadeGrantStatusForPortalToken` fixed for
 * account grants. One status, every layer it authorised.
 *
 * Deliberately narrow: only the token that CLAIMED the vendor company cascades.
 * A second contact's sub link is that person's access to a project, and losing
 * it must not stop the company being paid — the person is the unit.
 *
 * Deliberately one-way: resuming a paused token does NOT restore payment
 * access. Re-opening money movement is `setCompanyPaymentAccessStatus`, which
 * costs a second factor and re-arms the new-vendor hold.
 */
export async function cascadeVendorPaymentAccessForPortalToken({
  orgId,
  tokenId,
  status,
}: {
  orgId: string
  tokenId: string
  status: "paused" | "revoked" | "active"
}) {
  if (status === "active") return
  const supabase = createServiceSupabaseClient()
  const { data: claims, error } = await supabase
    .from("vendor_company_claims")
    .select("id,company_id,status")
    .eq("org_id", orgId)
    .eq("source_portal_token_id", tokenId)
    .neq("status", "revoked")
  if (error) throw new Error(`Unable to read vendor claims for this access record: ${error.message}`)
  if ((claims ?? []).length === 0) return

  const nowIso = new Date().toISOString()
  const nextRelationshipStatus = status === "revoked" ? "revoked" : "suspended"

  for (const claim of claims ?? []) {
    const { data: relationship, error: relationshipError } = await supabase
      .from("vendor_payment_relationships")
      .update({
        status: nextRelationshipStatus,
        suspended_at: nextRelationshipStatus === "suspended" ? nowIso : null,
        revoked_at: nextRelationshipStatus === "revoked" ? nowIso : null,
      })
      .eq("org_id", orgId)
      .eq("company_id", claim.company_id)
      .in("status", LIVE_RELATIONSHIP_STATUSES)
      .select("id,status")
      .maybeSingle()
    if (relationshipError) {
      throw new Error(`Unable to withdraw vendor payment access: ${relationshipError.message}`)
    }
    if (status === "revoked") {
      const { error: claimError } = await supabase
        .from("vendor_company_claims")
        .update({ status: "revoked", revoked_at: nowIso })
        .eq("org_id", orgId)
        .eq("id", claim.id)
        .neq("status", "revoked")
      if (claimError) throw new Error(`Unable to withdraw the vendor claim: ${claimError.message}`)
    }
    if (!relationship) continue
    await Promise.all([
      recordEvent({
        orgId,
        eventType: `vendor_payment_relationship_${nextRelationshipStatus}`,
        entityType: "vendor_payment_relationship",
        entityId: relationship.id,
        payload: { company_id: claim.company_id, status: nextRelationshipStatus, source: "portal_access_lifecycle" },
      }),
      recordAudit({
        orgId,
        action: "update",
        entityType: "vendor_payment_relationship",
        entityId: relationship.id,
        after: { status: nextRelationshipStatus, portal_access_token_id: tokenId },
        source: "portal_access_lifecycle",
      }),
    ])
  }
}

const RELATIONSHIP_STATUS_TO_READINESS: Record<string, CompanyPaymentReadinessStatus> = {
  active: "ready",
  onboarding: "verifying",
  claim_pending: "verifying",
  invited: "invited",
  suspended: "suspended",
  revoked: "revoked",
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

/**
 * The sub portal link one named contact follows to set up payout.
 *
 * Deliberately per-person, never per-company. A payment invitation used to mint
 * a single contact-less token and mail the same bearer URL to up to five people:
 * whoever opened it — including anyone it was forwarded to — could register an
 * arbitrary email against it, claim the vendor company and point every future
 * ACH run at their own bank. `portal_access_tokens.contact_id` is what binds a
 * link to a person, and payout setup is only ever authorized on a bound row
 * (`requireVendorPayoutPortalAccess`). This is CLAUDE.md's doctrine applied to
 * money: the person is the unit, the link is a field.
 *
 * Reusing this contact's existing sub link is still right — the row IS their
 * access, and the token string is only how it is delivered — but it is now
 * matched on `contact_id`, so a company-wide link can never be handed back.
 *
 * `portal_access_tokens.project_id` is NOT NULL, so a company-level ask still
 * has to ride a project-scoped credential; a newly minted one is scoped to the
 * project the builder most recently did business with this vendor on.
 */
async function resolveContactPayoutLink(input: {
  orgId: string
  companyId: string
  contactId: string
  userId: string
}) {
  const supabase = createServiceSupabaseClient()
  const { data: existing } = await supabase
    .from("portal_access_tokens")
    .select("token_encrypted")
    .eq("org_id", input.orgId)
    .eq("company_id", input.companyId)
    .eq("contact_id", input.contactId)
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
    .eq("org_id", input.orgId)
    .eq("company_id", input.companyId)
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
    org_id: input.orgId,
    project_id: bill.project_id,
    company_id: input.companyId,
    contact_id: input.contactId,
    portal_type: "sub",
    created_by: input.userId,
  })
  if (error) throw new Error(`Unable to create the vendor portal link: ${error.message}`)
  return plaintextToken
}

/**
 * Ask a vendor to set up Arc Pay. Idempotent by design: re-inviting a
 * vendor who is already verifying or ready never downgrades their relationship,
 * it just re-sends the link.
 */
export async function inviteCompanyToPaymentSetup(input: { companyId: string }, orgId?: string) {
  const parsed = z.object({ companyId: z.string().uuid() }).parse(input)
  const context = await requireOrgContext(orgId)
  await requireAnyPermission(["payment.release", "payment.manage_rail"], context)
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
  if (relationship?.status === "active") throw new Error(`${company.name} is already set up for Arc Pay`)
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

  // One link per person, each bound to that contact's own token row. Mailing a
  // single shared URL to five people is exactly what made the payout-setup link
  // a bearer credential; a per-contact link cannot be claimed by whoever it was
  // forwarded to, because the claim path enforces the bound contact's email.
  const baseUrl = (process.env.NEXT_PUBLIC_APP_URL ?? "https://arcnaples.com").replace(/\/$/, "")
  const deliveries = await Promise.all(recipients.map(async (contact) => {
    const token = await resolveContactPayoutLink({
      orgId: context.orgId,
      companyId: company.id,
      contactId: contact.id,
      userId: context.userId,
    })
    return sendVendorPaymentInviteEmail({
      to: [contact.email],
      recipientName: contact.full_name,
      companyName: company.name,
      orgName: org?.name ?? "Your builder",
      orgSlug: org?.slug ?? null,
      orgLogoUrl: org?.logo_url ?? null,
      setupUrl: `${baseUrl}/s/${token}/payments`,
    })
  }))
  const sent = deliveries.some(Boolean)

  await Promise.all([
    recordEvent({
      orgId: context.orgId,
      actorId: context.userId,
      eventType: "vendor_payment_invitation_sent",
      entityType: "company",
      entityId: company.id,
      payload: { recipients: recipients.length, delivered: deliveries.filter(Boolean).length },
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
