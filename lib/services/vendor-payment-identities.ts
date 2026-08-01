import "server-only"

import { recordAudit } from "@/lib/services/audit"
import { recordEvent } from "@/lib/services/events"
import {
  externalIdentityHasOrgAccess,
  getCurrentExternalPortalSession,
  hasExternalPortalGrantForToken,
} from "@/lib/services/external-portal-auth"
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
    createdAt: string
    paidAt: string | null
  }>
}

/** The portal context plus the builder and vendor record this token points at. */
export interface VendorPaymentSetupContext extends VendorPaymentPortalContext {
  builder: { orgId: string; orgName: string; companyId: string; companyName: string }
}

function firstRelation<T>(value: T | T[] | null | undefined): T | null {
  if (Array.isArray(value)) return value[0] ?? null
  return value ?? null
}

async function requireVendorPortalToken(portalToken: string) {
  const supabase = createServiceSupabaseClient()
  const { data: access, error } = await supabase
    .from("portal_access_tokens")
    .select("id,org_id,company_id,portal_type,paused_at,revoked_at,expires_at,contact:contacts(email)")
    .eq("token_hash", hashPortalToken(portalToken))
    .maybeSingle()
  if (error || !access || access.portal_type !== "sub" || !access.company_id || access.paused_at || access.revoked_at) {
    throw new Error("This vendor invitation is invalid or no longer active")
  }
  if (access.expires_at && new Date(access.expires_at) <= new Date()) {
    throw new Error("This vendor invitation has expired")
  }
  const hasGrant = await hasExternalPortalGrantForToken({
    orgId: access.org_id,
    tokenId: access.id,
    tokenType: "portal",
  })
  if (!hasGrant) throw new Error("Sign in and claim this vendor invitation before continuing")
  return access
}

async function resolveOrCreateIdentity(input: {
  accountId: string
  accountEmail: string
  accountFullName: string | null
  invitationEmail: string | null
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
  const { data: existing, error: identityError } = await supabase
    .from("vendor_portal_identities")
    .select("id,email,full_name,status,email_verified_at")
    .ilike("email", normalizedEmail)
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
    // `requireVendorPortalToken` already proved this signed-in identity owns an
    // active grant for this exact token. When the builder addressed the token
    // to a contact, retain the stronger invited-email check. Company-only links
    // have no contact email, so the token grant is their identity binding.
    const invitationEmailMatches = !input.invitationEmail || input.invitationEmail.toLowerCase() === normalizedEmail
    if (!invitationEmailMatches) {
      throw new Error("Sign in with the email address that received this vendor invitation before setting up payments")
    }
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
  const access = await requireVendorPortalToken(parsed.portal_token)
  if (!(await externalIdentityHasOrgAccess(access.org_id))) {
    throw new Error("This invitation belongs to a different builder workspace")
  }

  const contact = firstRelation(access.contact as { email?: string | null } | Array<{ email?: string | null }> | null)
  const identity = await resolveOrCreateIdentity({
    accountId: session.identity.id,
    accountEmail: session.identity.email,
    accountFullName: session.identity.full_name ?? null,
    invitationEmail: contact?.email?.trim().toLowerCase() ?? null,
  })

  const supabase = createServiceSupabaseClient()
  const { data: existingClaim, error: existingClaimError } = await supabase
    .from("vendor_company_claims")
    .select("id,vendor_entity_id,status")
    .eq("org_id", access.org_id)
    .eq("company_id", access.company_id)
    .maybeSingle()
  if (existingClaimError) throw new Error(`Unable to inspect vendor claim: ${existingClaimError.message}`)
  if (existingClaim?.status === "verified" && existingClaim.vendor_entity_id !== parsed.vendor_entity_id) {
    throw new Error("This builder vendor is already claimed. Contact the builder or Arc support to change ownership.")
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
    if (existingClaim?.status === "verified" && existingClaim.vendor_entity_id === vendorEntityId) {
      const { data: relationship } = await supabase
        .from("vendor_payment_relationships")
        .select("id,status")
        .eq("org_id", access.org_id)
        .eq("company_id", access.company_id)
        .maybeSingle()
      if (relationship) {
        return { identityId: identity.id, vendorEntityId, relationshipId: relationship.id, status: relationship.status, claimed: false }
      }
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
    org_id: access.org_id,
    company_id: access.company_id,
    vendor_entity_id: vendorEntityId,
    claimed_by_identity_id: identity.id,
    external_identity_id: session.identity.id,
    source_portal_token_id: access.id,
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

  const { data: relationship, error: relationshipError } = await supabase
    .from("vendor_payment_relationships")
    .upsert({
      org_id: access.org_id,
      company_id: access.company_id,
      vendor_company_claim_id: claim.id,
      vendor_entity_id: vendorEntityId,
      status: "onboarding",
      accepted_by_identity_id: identity.id,
      accepted_at: new Date().toISOString(),
    }, { onConflict: "org_id,company_id" })
    .select("id,status")
    .single()
  if (relationshipError || !relationship) throw new Error(`Unable to create payment relationship: ${relationshipError?.message}`)

  const { data: company } = await supabase.from("companies").select("name").eq("id", access.company_id).maybeSingle()
  const { data: entityRow } = await supabase.from("vendor_entities").select("legal_name").eq("id", vendorEntityId).maybeSingle()
  await Promise.all([
    recordEvent({
      orgId: access.org_id,
      eventType: "vendor_payment_relationship_claimed",
      entityType: "company",
      entityId: access.company_id,
      payload: {
        vendor_entity_id: vendorEntityId,
        relationship_id: relationship.id,
        message: `${identity.email} linked ${company?.name ?? "a vendor"} to ${entityRow?.legal_name ?? "their company"} and started payout verification.`,
      },
    }),
    recordAudit({
      orgId: access.org_id,
      action: existingClaim ? "update" : "insert",
      entityType: "vendor_company_claim",
      entityId: claim.id,
      after: { vendor_entity_id: vendorEntityId, company_id: access.company_id, status: "verified" },
      source: "vendor_portal",
    }),
  ])
  return { identityId: identity.id, vendorEntityId, relationshipId: relationship.id, status: relationship.status, claimed: true }
}

export async function getVendorPaymentPortalContext(): Promise<VendorPaymentPortalContext> {
  const session = await getCurrentExternalPortalSession()
  if (!session) return { identity: null, entities: [], relationships: [], recentPayments: [] }
  const supabase = createServiceSupabaseClient()
  const { data: account } = await supabase
    .from("external_identities")
    .select("vendor_identity_id")
    .eq("id", session.identity.id)
    .maybeSingle()
  if (!account?.vendor_identity_id) return { identity: null, entities: [], relationships: [], recentPayments: [] }

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
  const recipientIds = (recipientRows ?? []).map((recipient) => recipient.id)
  const { data: disbursementRows } = recipientIds.length > 0
    ? await supabase.from("disbursements")
      .select("id,org_id,bill_id,status,amount_cents,currency,created_at,paid_at")
      .in("recipient_account_id", recipientIds)
      .order("created_at", { ascending: false })
      .limit(100)
    : { data: [] }
  const billIds = [...new Set((disbursementRows ?? []).map((disbursement) => disbursement.bill_id))]
  const { data: billRows } = billIds.length > 0
    ? await supabase.from("vendor_bills").select("id,org_id,bill_number").in("id", billIds)
    : { data: [] }
  const billById = new Map((billRows ?? []).map((bill) => [bill.id, bill]))

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
    recentPayments: (disbursementRows ?? []).map((disbursement) => ({
      id: disbursement.id,
      orgName: orgNameById.get(disbursement.org_id) ?? "Builder",
      billNumber: billById.get(disbursement.bill_id)?.bill_number ?? "Vendor bill",
      status: disbursement.status,
      amountCents: Number(disbursement.amount_cents),
      currency: disbursement.currency,
      createdAt: disbursement.created_at,
      paidAt: disbursement.paid_at ?? null,
    })),
  }
}

/**
 * Everything the payout-setup surface renders, in one call: who this vendor is
 * across Arc, and which builder record this particular invitation points at.
 * The builder half is what lets the page ask "is this you?" instead of making
 * the vendor retype a company name Arc already knows.
 */
export async function getVendorPaymentSetupContext(portalToken: string): Promise<VendorPaymentSetupContext> {
  const access = await requireVendorPortalToken(portalToken)
  const supabase = createServiceSupabaseClient()
  const [portal, { data: org }, { data: company }] = await Promise.all([
    getVendorPaymentPortalContext(),
    supabase.from("orgs").select("name").eq("id", access.org_id).maybeSingle(),
    supabase.from("companies").select("name").eq("id", access.company_id).maybeSingle(),
  ])
  return {
    ...portal,
    builder: {
      orgId: access.org_id,
      orgName: org?.name ?? "This builder",
      companyId: access.company_id,
      companyName: company?.name ?? "Your company",
    },
  }
}
