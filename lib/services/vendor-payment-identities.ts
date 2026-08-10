import "server-only"

import { recordAudit } from "@/lib/services/audit"
import { recordEvent } from "@/lib/services/events"
import {
  externalIdentityHasOrgAccess,
  getCurrentExternalPortalSession,
  hasExternalPortalGrantForToken,
} from "@/lib/services/external-portal-auth"
import { getPaymentRailProvider } from "@/lib/integrations/payments/payment-rail-registry"
import { estimateSettlement } from "@/lib/payments/settlement-estimate"
import { hashPortalToken } from "@/lib/services/portal-credentials"
import { createServiceSupabaseClient } from "@/lib/supabase/server"
import { vendorClaimSchema, type VendorClaimInput } from "@/lib/validation/fintech-payments"

interface VendorPortalIdentityRow {
  id: string
  email: string
  full_name: string | null
  status: "pending_verification" | "active" | "locked" | "revoked"
  email_verified_at: string | null
}

export interface VendorPaymentPortalContext {
  identity: { id: string; email: string; fullName: string | null; status: string } | null
  entities: Array<{
    id: string
    legalName: string
    dbaName: string | null
    role: string
    status: string
    recipient: {
      id: string
      provider: string
      status: string
      payoutsEnabled: boolean
      bankName: string | null
      bankLast4: string | null
    } | null
  }>
  relationships: Array<{
    id: string
    orgId: string
    orgName: string
    companyId: string
    companyName: string
    vendorEntityId: string
    status: string
  }>
  recentPayments: Array<{
    id: string
    orgName: string
    billNumber: string
    status: string
    amountCents: number
    currency: string
    /** How the money was sent — ACH through Arc, or a check the builder wrote. */
    method: string
    reference: string | null
    retainageHeldCents: number
    paidAt: string
  }>
  /**
   * Payments the builder has released that have not landed yet. Arc holds
   * cleared funds before transferring them, so there is a real window where the
   * vendor has been paid and cannot see it — which is exactly when they call to
   * ask. Dates are estimates from the provider's normal window, never promises.
   */
  inFlightPayments: Array<{
    id: string
    orgName: string
    billNumber: string
    amountCents: number
    currency: string
    status: string
    initiatedOn: string
    expectedEarliest: string
    expectedLatest: string
  }>
}

/** The portal context plus the builder and vendor record this token points at. */
export interface VendorPaymentSetupContext extends VendorPaymentPortalContext {
  builder: {
    orgId: string
    orgName: string
    companyId: string
    companyName: string
    /** Whether this builder already holds a W-9 for this vendor. */
    w9OnFile: boolean
  }
}

function firstRelation<T>(value: T | T[] | null | undefined): T | null {
  if (Array.isArray(value)) return value[0] ?? null
  return value ?? null
}

/** Relationship states in which this builder has a live payment invitation open. */
const PAYOUT_INVITED_RELATIONSHIP_STATUSES = ["invited", "claim_pending", "onboarding", "active"]

export interface VendorPayoutPortalAccess {
  tokenId: string
  orgId: string
  companyId: string
  /** The one person this link belongs to. Payout setup is never company-wide. */
  contactId: string
  contactEmail: string
}

/**
 * The payout-setup gate: this exact token, this exact person, this capability.
 *
 * Token validity alone is not authorization. Three things have to hold before a
 * portal session may touch a payout destination, and each closes a distinct way
 * the previous version could be turned into a payout-destination takeover:
 *
 *  1. **The link is bound to a person.** A contact-less, company-wide row is a
 *     bearer credential — anyone forwarded the URL could register their own
 *     email against it and receive every future ACH run for that vendor. Payout
 *     setup now requires `contact_id`, and the contact must belong to the same
 *     company the token is scoped to.
 *  2. **The capability is explicit.** A `sub` token minted for RFIs is not a
 *     payout-authorization credential. The builder must have actually invited
 *     this company to payment setup, which is what a live
 *     `vendor_payment_relationships` row records.
 *  3. **The signed-in identity holds a live grant on this token** — unchanged,
 *     and now meaningful, because the grant path enforces the bound contact's
 *     email for contact-bound tokens.
 */
export async function requireVendorPayoutPortalAccess(portalToken: string): Promise<VendorPayoutPortalAccess> {
  const supabase = createServiceSupabaseClient()
  const { data: access, error } = await supabase
    .from("portal_access_tokens")
    .select("id,org_id,company_id,contact_id,portal_type,paused_at,revoked_at,expires_at,contact:contacts(id,email,primary_company_id)")
    .eq("token_hash", hashPortalToken(portalToken))
    .maybeSingle()
  if (error || !access || access.portal_type !== "sub" || !access.company_id || access.paused_at || access.revoked_at) {
    throw new Error("This vendor invitation is invalid or no longer active")
  }
  if (access.expires_at && new Date(access.expires_at) <= new Date()) {
    throw new Error("This vendor invitation has expired")
  }
  const contact = firstRelation(
    access.contact as { id?: string; email?: string | null; primary_company_id?: string | null } | Array<{ id?: string; email?: string | null; primary_company_id?: string | null }> | null,
  )
  const contactEmail = contact?.email?.trim().toLowerCase()
  if (!access.contact_id || !contact?.id || !contactEmail) {
    throw new Error("This link is not addressed to a named contact, so it cannot be used to set up payouts. Ask the builder to re-send the payment invitation.")
  }
  if (contact.primary_company_id !== access.company_id) {
    throw new Error("This link's contact does not belong to the vendor company it points at")
  }
  const { data: relationship, error: relationshipError } = await supabase
    .from("vendor_payment_relationships")
    .select("status")
    .eq("org_id", access.org_id)
    .eq("company_id", access.company_id)
    .maybeSingle()
  if (relationshipError) throw new Error(`Unable to verify the payment invitation: ${relationshipError.message}`)
  if (!relationship || !PAYOUT_INVITED_RELATIONSHIP_STATUSES.includes(relationship.status)) {
    throw new Error("This builder has not invited your company to set up payouts")
  }
  const hasGrant = await hasExternalPortalGrantForToken({
    orgId: access.org_id,
    tokenId: access.id,
    tokenType: "portal",
  })
  if (!hasGrant) throw new Error("Sign in and claim this vendor invitation before continuing")
  return {
    tokenId: access.id,
    orgId: access.org_id,
    companyId: access.company_id,
    contactId: access.contact_id,
    contactEmail,
  }
}

async function resolveOrCreateIdentity(input: {
  accountId: string
  accountEmail: string
  accountFullName: string | null
  /** The bound contact's address. Never null — a payout link is always addressed. */
  invitationEmail: string
}) {
  const supabase = createServiceSupabaseClient()
  const { data: account, error: accountError } = await supabase
    .from("external_identities")
    .select("id,email,full_name,password_hash,vendor_identity_id")
    .eq("id", input.accountId)
    .maybeSingle()
  if (accountError || !account) throw new Error("Vendor portal account was not found")

  if (account.vendor_identity_id) {
    const { data: linked, error } = await supabase
      .from("vendor_portal_identities")
      .select("id,email,full_name,status,email_verified_at")
      .eq("id", account.vendor_identity_id)
      .maybeSingle()
    if (error || !linked) throw new Error("Linked vendor identity was not found")
    if (linked.status !== "active") throw new Error("This vendor identity is not active")
    return linked as VendorPortalIdentityRow
  }

  const normalizedEmail = input.accountEmail.trim().toLowerCase()
  // Fail closed on the binding, before anything is resolved or created. The
  // previous `!input.invitationEmail || …` escape meant a link with no bound
  // contact skipped this check entirely, so any address that could reach the
  // token became the vendor's payout administrator. There is no unbound link
  // any more, and a mismatch is refused rather than waved through.
  if (input.invitationEmail.trim().toLowerCase() !== normalizedEmail) {
    throw new Error("Sign in with the email address that received this vendor invitation before setting up payments")
  }
  // `.eq`, never `.ilike`: PostgREST passes `ilike` through as a LIKE pattern,
  // and `_` is both a legal email character and a single-character wildcard —
  // registering `bob_smith@acme.com` matched and ADOPTED the existing identity
  // `bob.smith@acme.com`, inheriting its vendor entities, payout accounts and
  // cross-builder payment history.
  const { data: existing, error: identityError } = await supabase
    .from("vendor_portal_identities")
    .select("id,email,full_name,status,email_verified_at")
    .eq("email", normalizedEmail)
    .maybeSingle()
  if (identityError) throw new Error(`Unable to resolve vendor identity: ${identityError.message}`)

  let identity: VendorPortalIdentityRow
  if (existing) {
    // `external_identities.email` is unique and carries a 1:1 `vendor_identity_id`,
    // so an unlinked global identity on this address can only be a half-finished
    // link from this same account. Re-link it rather than prompting for a second
    // password: the portal session already proved control of the address, and the
    // hash this row was seeded with is a stale copy that never rotates.
    if (existing.status !== "active") throw new Error("This vendor identity is not active")
    identity = existing as VendorPortalIdentityRow
  } else {
    const now = new Date().toISOString()
    const { data: created, error } = await supabase
      .from("vendor_portal_identities")
      .insert({
        email: normalizedEmail,
        full_name: input.accountFullName,
        password_hash: account.password_hash,
        status: "active",
        email_verified_at: now,
        last_authenticated_at: now,
      })
      .select("id,email,full_name,status,email_verified_at")
      .single()
    if (error || !created) throw new Error(`Unable to create vendor identity: ${error?.message}`)
    identity = created as VendorPortalIdentityRow
  }

  const { error: linkError } = await supabase
    .from("external_identities")
    .update({ vendor_identity_id: identity.id })
    .eq("id", input.accountId)
    .is("vendor_identity_id", null)
  if (linkError) throw new Error(`Unable to link vendor portal account: ${linkError.message}`)
  return identity
}

export async function claimVendorCompany(input: VendorClaimInput) {
  const parsed = vendorClaimSchema.parse(input)
  const session = await getCurrentExternalPortalSession()
  if (!session) throw new Error("Sign in to the vendor portal to claim this company")
  const access = await requireVendorPayoutPortalAccess(parsed.portal_token)
  if (!(await externalIdentityHasOrgAccess(access.orgId))) {
    throw new Error("This invitation belongs to a different builder workspace")
  }

  const identity = await resolveOrCreateIdentity({
    accountId: session.identity.id,
    accountEmail: session.identity.email,
    accountFullName: session.identity.full_name ?? null,
    invitationEmail: access.contactEmail,
  })

  const supabase = createServiceSupabaseClient()
  const { data: existingClaim, error: existingClaimError } = await supabase
    .from("vendor_company_claims")
    .select("id,vendor_entity_id,status")
    .eq("org_id", access.orgId)
    .eq("company_id", access.companyId)
    .maybeSingle()
  if (existingClaimError) throw new Error(`Unable to inspect vendor claim: ${existingClaimError.message}`)
  // A withdrawn claim is terminal on this path. Overwriting a `rejected` or
  // `revoked` row with `status: "verified", revoked_at: null` let withdrawn
  // access resurrect itself simply by re-following the link — the same
  // never-resurrect rule `upsertGrant` holds for portal grants.
  if (existingClaim?.status === "rejected" || existingClaim?.status === "revoked") {
    throw new Error(`This vendor claim was ${existingClaim.status}. Ask the builder to re-invite you before setting up payouts.`)
  }
  if (existingClaim?.status === "verified" && existingClaim.vendor_entity_id !== parsed.vendor_entity_id) {
    throw new Error("This builder vendor is already claimed. Contact the builder or Arc support to change ownership.")
  }
  const { data: existingRelationship, error: existingRelationshipError } = await supabase
    .from("vendor_payment_relationships")
    .select("id,status")
    .eq("org_id", access.orgId)
    .eq("company_id", access.companyId)
    .maybeSingle()
  if (existingRelationshipError) throw new Error(`Unable to inspect the payment relationship: ${existingRelationshipError.message}`)
  if (existingRelationship?.status === "suspended" || existingRelationship?.status === "revoked") {
    throw new Error(`This builder has ${existingRelationship.status} your payment access. They have to restore it before you can set up payouts again.`)
  }

  let vendorEntityId = parsed.vendor_entity_id
  if (vendorEntityId) {
    const { data: membership } = await supabase
      .from("vendor_entity_memberships")
      .select("id")
      .eq("vendor_entity_id", vendorEntityId)
      .eq("identity_id", identity.id)
      .eq("status", "active")
      .maybeSingle()
    if (!membership) throw new Error("You are not an active administrator of that vendor entity")

    // Setup is now one action that resumes where the vendor left off, so this
    // runs again every time they return to finish provider verification.
    // Re-stamping the claim would re-notify the builder and reset the
    // relationship age that the risk signals read.
    if (existingClaim?.status === "verified" && existingClaim.vendor_entity_id === vendorEntityId && existingRelationship) {
      return { identityId: identity.id, vendorEntityId, relationshipId: existingRelationship.id, status: existingRelationship.status, claimed: false }
    }
  } else {
    const { data: entity, error: entityError } = await supabase
      .from("vendor_entities")
      .insert({
        legal_name: parsed.legal_name,
        dba_name: parsed.dba_name || null,
        status: "active",
        created_by_identity_id: identity.id,
      })
      .select("id")
      .single()
    if (entityError || !entity) throw new Error(`Unable to create vendor entity: ${entityError?.message}`)
    vendorEntityId = entity.id
    const { error: membershipError } = await supabase.from("vendor_entity_memberships").insert({
      vendor_entity_id: vendorEntityId,
      identity_id: identity.id,
      role: "owner",
      status: "active",
      accepted_at: new Date().toISOString(),
    })
    if (membershipError) throw new Error(`Unable to create vendor membership: ${membershipError.message}`)
  }

  if (!vendorEntityId) throw new Error("Unable to resolve vendor entity")
  const claimPayload = {
    org_id: access.orgId,
    company_id: access.companyId,
    vendor_entity_id: vendorEntityId,
    claimed_by_identity_id: identity.id,
    external_identity_id: session.identity.id,
    source_portal_token_id: access.tokenId,
    status: "verified",
    verification_method: "portal_invitation",
    verified_at: new Date().toISOString(),
    rejected_at: null,
    revoked_at: null,
  }
  const claimMutation = existingClaim
    ? supabase.from("vendor_company_claims").update(claimPayload).eq("id", existingClaim.id).select("id").single()
    : supabase.from("vendor_company_claims").insert(claimPayload).select("id").single()
  const { data: claim, error: claimError } = await claimMutation
  if (claimError || !claim) throw new Error(`Unable to claim vendor company: ${claimError?.message}`)

  // Never downgrade a live relationship and never resurrect a withdrawn one.
  // The blanket `status: "onboarding"` clobbered `active` back to onboarding and
  // would have revived `suspended`/`revoked` — the very states
  // `inviteCompanyToPaymentSetup` refuses to re-invite. Withdrawn states already
  // threw above; an `active` relationship keeps its status here.
  const nextRelationshipStatus = existingRelationship?.status === "active" ? "active" : "onboarding"
  const { data: relationship, error: relationshipError } = await supabase
    .from("vendor_payment_relationships")
    .upsert({
      org_id: access.orgId,
      company_id: access.companyId,
      vendor_company_claim_id: claim.id,
      vendor_entity_id: vendorEntityId,
      status: nextRelationshipStatus,
      accepted_by_identity_id: identity.id,
      accepted_at: new Date().toISOString(),
    }, { onConflict: "org_id,company_id" })
    .select("id,status")
    .single()
  if (relationshipError || !relationship) throw new Error(`Unable to create payment relationship: ${relationshipError?.message}`)

  const { data: company } = await supabase.from("companies").select("name").eq("id", access.companyId).maybeSingle()
  const { data: entityRow } = await supabase.from("vendor_entities").select("legal_name").eq("id", vendorEntityId).maybeSingle()
  await Promise.all([
    recordEvent({
      orgId: access.orgId,
      eventType: "vendor_payment_relationship_claimed",
      entityType: "company",
      entityId: access.companyId,
      payload: {
        vendor_entity_id: vendorEntityId,
        relationship_id: relationship.id,
        message: `${identity.email} linked ${company?.name ?? "a vendor"} to ${entityRow?.legal_name ?? "their company"} and started payout verification.`,
      },
    }),
    recordAudit({
      orgId: access.orgId,
      action: existingClaim ? "update" : "insert",
      entityType: "vendor_company_claim",
      entityId: claim.id,
      after: { vendor_entity_id: vendorEntityId, company_id: access.companyId, status: "verified" },
      source: "vendor_portal",
    }),
  ])
  return { identityId: identity.id, vendorEntityId, relationshipId: relationship.id, status: relationship.status, claimed: true }
}

export async function getVendorPaymentPortalContext(): Promise<VendorPaymentPortalContext> {
  const session = await getCurrentExternalPortalSession()
  if (!session) return { identity: null, entities: [], relationships: [], recentPayments: [], inFlightPayments: [] }
  const supabase = createServiceSupabaseClient()
  const { data: account } = await supabase
    .from("external_identities")
    .select("vendor_identity_id")
    .eq("id", session.identity.id)
    .maybeSingle()
  if (!account?.vendor_identity_id) return { identity: null, entities: [], relationships: [], recentPayments: [], inFlightPayments: [] }

  const [{ data: identity }, { data: membershipRows }, { data: relationshipRows }] = await Promise.all([
    supabase
      .from("vendor_portal_identities")
      .select("id,email,full_name,status")
      .eq("id", account.vendor_identity_id)
      .maybeSingle(),
    supabase
      .from("vendor_entity_memberships")
      .select("vendor_entity_id,role,status")
      .eq("identity_id", account.vendor_identity_id)
      .eq("status", "active"),
    supabase
      .from("vendor_payment_relationships")
      .select("id,org_id,company_id,vendor_entity_id,status")
      .eq("accepted_by_identity_id", account.vendor_identity_id)
      .order("created_at", { ascending: false }),
  ])

  const entityIds = [...new Set((membershipRows ?? []).map((row) => row.vendor_entity_id))]
  const orgIds = [...new Set((relationshipRows ?? []).map((row) => row.org_id))]
  const companyIds = [...new Set((relationshipRows ?? []).map((row) => row.company_id))]
  const [{ data: entityRows }, { data: recipientRows }, { data: orgRows }, { data: companyRows }] = await Promise.all([
    entityIds.length > 0
      ? supabase.from("vendor_entities").select("id,legal_name,dba_name,status").in("id", entityIds)
      : Promise.resolve({ data: [] }),
    entityIds.length > 0
      ? supabase.from("payment_recipient_accounts").select("id,vendor_entity_id,provider,status,payouts_enabled,payout_bank_name,payout_bank_last4").in("vendor_entity_id", entityIds)
      : Promise.resolve({ data: [] }),
    orgIds.length > 0
      ? supabase.from("orgs").select("id,name").in("id", orgIds)
      : Promise.resolve({ data: [] }),
    companyIds.length > 0
      ? supabase.from("companies").select("id,name").in("id", companyIds)
      : Promise.resolve({ data: [] }),
  ])
  const entityById = new Map((entityRows ?? []).map((entity) => [entity.id, entity]))
  const recipientByEntityId = new Map((recipientRows ?? []).map((recipient) => [recipient.vendor_entity_id, recipient]))
  const orgNameById = new Map((orgRows ?? []).map((org) => [org.id, org.name]))
  const companyNameById = new Map((companyRows ?? []).map((company) => [company.id, company.name]))
  // Sourced from `payments` rather than `disbursements` so a check appears
  // beside an ACH. Both rails write here — `record_ap_payment_atomic` inserts a
  // payment for every settled disbursement — so this is the one place that sees
  // every dollar the vendor was actually sent, which is the whole question the
  // vendor came to this page to answer. Filtering by the bill's company is safe
  // without an org filter: a company row belongs to exactly one org.
  const { data: paymentRows } = companyIds.length > 0
    ? await supabase.from("payments")
      .select("id,org_id,amount_cents,currency,method,status,received_at,reference,bill:vendor_bills!inner(id,bill_number,company_id,retainage_cents)")
      .in("bill.company_id", companyIds)
      .in("status", ["succeeded", "completed"])
      .order("received_at", { ascending: false })
      .limit(100)
    : { data: [] }

  // Same company scoping as the settled query above: a company row belongs to
  // exactly one org, so filtering the joined bill's company is the vendor's own
  // data and nobody else's. `paid` is excluded because it is already settled and
  // appears in `recentPayments`; the unpaid-terminal states are not in flight.
  const { data: inFlightRows } = companyIds.length > 0
    ? await supabase.from("disbursements")
      .select("id,org_id,amount_cents,currency,status,created_at,bill:vendor_bills!inner(id,bill_number,company_id)")
      .in("bill.company_id", companyIds)
      .in("status", ["submitted", "debit_pending", "funds_available", "transfer_pending", "payout_pending"])
      .order("created_at", { ascending: false })
      .limit(50)
    : { data: [] }

  const settlementWindow = getPaymentRailProvider().settlementWindow

  const entities = (membershipRows ?? []).flatMap((row) => {
    const entity = entityById.get(row.vendor_entity_id)
    if (!entity) return []
    const recipient = recipientByEntityId.get(entity.id)
    return [{
      id: entity.id,
      legalName: entity.legal_name,
      dbaName: entity.dba_name ?? null,
      role: row.role,
      status: entity.status,
      recipient: recipient ? {
        id: recipient.id,
        provider: recipient.provider,
        status: recipient.status,
        payoutsEnabled: Boolean(recipient.payouts_enabled),
        bankName: recipient.payout_bank_name ?? null,
        bankLast4: recipient.payout_bank_last4 ?? null,
      } : null,
    }]
  })

  const relationships = (relationshipRows ?? []).map((row) => {
    return {
      id: row.id,
      orgId: row.org_id,
      orgName: orgNameById.get(row.org_id) ?? "Builder",
      companyId: row.company_id,
      companyName: companyNameById.get(row.company_id) ?? "Vendor",
      vendorEntityId: row.vendor_entity_id,
      status: row.status,
    }
  })

  return {
    identity: identity ? { id: identity.id, email: identity.email, fullName: identity.full_name, status: identity.status } : null,
    entities,
    relationships,
    recentPayments: (paymentRows ?? []).map((payment) => {
      const bill = firstRelation(payment.bill)
      return {
        id: payment.id,
        orgName: orgNameById.get(payment.org_id) ?? "Builder",
        billNumber: bill?.bill_number ?? "Vendor bill",
        status: payment.status,
        amountCents: Number(payment.amount_cents),
        currency: payment.currency,
        method: payment.method ?? "ach",
        reference: payment.reference ?? null,
        retainageHeldCents: Number(bill?.retainage_cents ?? 0),
        paidAt: payment.received_at,
      }
    }),
    inFlightPayments: (inFlightRows ?? []).map((disbursement) => {
      const bill = firstRelation(disbursement.bill)
      const initiatedOn = String(disbursement.created_at).slice(0, 10)
      const estimate = estimateSettlement({ initiatedOn, window: settlementWindow })
      return {
        id: disbursement.id,
        orgName: orgNameById.get(disbursement.org_id) ?? "Builder",
        billNumber: bill?.bill_number ?? "Vendor bill",
        amountCents: Number(disbursement.amount_cents),
        currency: disbursement.currency,
        status: disbursement.status,
        initiatedOn,
        expectedEarliest: estimate.vendorReceivesEarliest,
        expectedLatest: estimate.vendorReceivesLatest,
      }
    }),
  }
}

/**
 * Everything the payout-setup surface renders, in one call: who this vendor is
 * across Arc, and which builder record this particular invitation points at.
 * The builder half is what lets the page ask "is this you?" instead of making
 * the vendor retype a company name Arc already knows.
 */
export async function getVendorPaymentSetupContext(portalToken: string): Promise<VendorPaymentSetupContext> {
  const access = await requireVendorPayoutPortalAccess(portalToken)
  const supabase = createServiceSupabaseClient()
  const [portal, { data: org }, { data: company }] = await Promise.all([
    getVendorPaymentPortalContext(),
    supabase.from("orgs").select("name").eq("id", access.orgId).maybeSingle(),
    supabase.from("companies").select("name,w9_file_id").eq("id", access.companyId).maybeSingle(),
  ])
  return {
    ...portal,
    builder: {
      orgId: access.orgId,
      orgName: org?.name ?? "This builder",
      companyId: access.companyId,
      companyName: company?.name ?? "Your company",
      // Payout setup is the one moment a vendor will reliably do paperwork, so
      // the page can ask for a missing W-9 here instead of chasing it at
      // year-end. A nudge only — it never gates onboarding.
      w9OnFile: Boolean(company?.w9_file_id),
    },
  }
}
