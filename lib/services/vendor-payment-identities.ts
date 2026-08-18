import "server-only"

import { z } from "zod"

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

type VendorIdentityStatus = "pending_verification" | "active" | "locked" | "revoked"

interface VendorPortalIdentityRow {
  id: string
  email: string
  full_name: string | null
  status: VendorIdentityStatus
  email_verified_at: string | null
}

export type VendorEntityRole = "owner" | "administrator" | "member"
export type VendorEntityMembershipStatus = "invited" | "active" | "suspended" | "revoked"

/**
 * One person's standing on one vendor entity.
 *
 * `invitedByIdentityId` is what separates the two pending shapes the schema
 * expresses with a single `invited` status: set means an administrator invited
 * this person and they have to accept; null means the person asked to join and
 * an administrator has to approve. Both are "not yet a member", and neither can
 * do anything until the other side acts.
 */
export interface VendorEntityMember {
  membershipId: string
  identityId: string
  email: string
  fullName: string | null
  role: VendorEntityRole
  status: VendorEntityMembershipStatus
  invitedByIdentityId: string | null
  isSelf: boolean
}

export interface VendorEntityInvitation {
  membershipId: string
  vendorEntityId: string
  entityLegalName: string
  role: VendorEntityRole
}

/** How many settled payments the portal shows before it says it truncated. */
export const VENDOR_RECENT_PAYMENTS_CAP = 100
/** How many released-but-unlanded payments the portal shows. */
export const VENDOR_IN_FLIGHT_PAYMENTS_CAP = 50

export interface VendorPaymentPortalContext {
  identity: { id: string; email: string; fullName: string | null; status: VendorIdentityStatus } | null
  entities: Array<{
    id: string
    legalName: string
    dbaName: string | null
    role: VendorEntityRole
    status: string
    recipient: {
      id: string
      provider: string
      status: string
      payoutsEnabled: boolean
      bankName: string | null
      bankLast4: string | null
    } | null
    /**
     * Everyone who administers this entity, plus anyone waiting on a decision.
     * Only populated for entities the caller owns or administers — a plain
     * member has no business reading the roster.
     */
    members: VendorEntityMember[]
  }>
  /** Entity invitations addressed to the caller and waiting on their answer. */
  invitations: VendorEntityInvitation[]
  /** The caller's own join requests, waiting on an administrator. */
  pendingJoinRequests: VendorEntityInvitation[]
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
  /** True when the cap above hid older payments. Surfaced, never silent. */
  recentPaymentsTruncated: boolean
  inFlightPaymentsTruncated: boolean
  /**
   * Whether the signed-in account has confirmed its email address. Payout setup
   * is gated on it, so the page has to be able to say so instead of failing at
   * the button.
   */
  emailVerified: boolean
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

/**
 * Relationship states in which this builder has a live payment invitation open.
 *
 * `suspended` and `revoked` are deliberately absent, and this list is the one
 * place that decides it. A builder that withdrew payment access must lose the
 * vendor-facing payment surface with it: the same status governs whether money
 * can move and whether the vendor can see that builder's money at all.
 */
const PAYOUT_INVITED_RELATIONSHIP_STATUSES = ["invited", "claim_pending", "onboarding", "active"]

const WITHDRAWN_RELATIONSHIP_STATUSES = ["suspended", "revoked"] as const

export type VendorPortalPaymentAccess =
  | { state: "open" }
  /** The builder paused or withdrew payment access. Fail closed, and say so. */
  | { state: "withdrawn"; status: "suspended" | "revoked" }
  | { state: "not_invited" }

/**
 * Whether this builder's payment surface is open to this vendor company.
 *
 * Split out of `requireVendorPayoutPortalAccess` so a withdrawn vendor gets an
 * honest page instead of a thrown error, and so the portal nav can hide a
 * section that would only refuse them.
 */
export async function getVendorPaymentAccessForCompany(
  orgId: string,
  companyId: string,
): Promise<VendorPortalPaymentAccess> {
  const supabase = createServiceSupabaseClient()
  const { data: relationship, error } = await supabase
    .from("vendor_payment_relationships")
    .select("status")
    .eq("org_id", orgId)
    .eq("company_id", companyId)
    .maybeSingle()
  if (error) throw new Error(`Unable to read the payment relationship: ${error.message}`)
  if (!relationship) return { state: "not_invited" }
  if (relationship.status === "suspended" || relationship.status === "revoked") {
    return { state: "withdrawn", status: relationship.status }
  }
  if (!PAYOUT_INVITED_RELATIONSHIP_STATUSES.includes(relationship.status)) return { state: "not_invited" }
  return { state: "open" }
}

/** The same question, asked with a portal token the vendor is holding. */
export async function getVendorPortalPaymentAccess(portalToken: string): Promise<VendorPortalPaymentAccess> {
  const supabase = createServiceSupabaseClient()
  const { data: access } = await supabase
    .from("portal_access_tokens")
    .select("org_id,company_id,portal_type,paused_at,revoked_at,expires_at")
    .eq("token_hash", hashPortalToken(portalToken))
    .maybeSingle()
  if (!access || access.portal_type !== "sub" || !access.company_id || access.paused_at || access.revoked_at) {
    return { state: "not_invited" }
  }
  if (access.expires_at && new Date(access.expires_at) <= new Date()) return { state: "not_invited" }
  return getVendorPaymentAccessForCompany(access.org_id, access.company_id)
}

const VENDOR_IDENTITY_STATUS_MESSAGE: Record<Exclude<VendorIdentityStatus, "active">, string> = {
  pending_verification:
    "Confirm your email address before setting up payouts. Use the link in the confirmation email we sent you.",
  locked: "This Arc vendor login is locked. Contact Arc support to unlock it before setting up payouts.",
  revoked: "This Arc vendor login was closed. Contact Arc support before setting up payouts.",
}

/**
 * One place that turns every non-active identity state into an explanation.
 *
 * `pending_verification`, `locked` and `revoked` used to collapse into a single
 * "This vendor identity is not active", which told a vendor nothing about what
 * to do next and gave support nothing to act on.
 */
function assertVendorIdentityActive(status: VendorIdentityStatus) {
  if (status === "active") return
  throw new Error(VENDOR_IDENTITY_STATUS_MESSAGE[status])
}

const UNVERIFIED_EMAIL_MESSAGE =
  "Confirm your email address before setting up payouts. We sent a confirmation link when you created your Arc account — open it, or send yourself a new one from this page."

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
  if (relationship && WITHDRAWN_RELATIONSHIP_STATUSES.some((status) => status === relationship.status)) {
    throw new Error(
      relationship.status === "suspended"
        ? "This builder has paused electronic payment to your company. Contact them to restore it."
        : "This builder withdrew electronic payment to your company. Contact them if you think that is a mistake.",
    )
  }
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

/**
 * Resolves the global vendor identity behind a portal session, creating it the
 * first time.
 *
 * **A confirmed email address is the price of admission.** Everything a vendor
 * identity reaches — existing vendor entities, a verified payout account, the
 * payment history of every builder they work with — is keyed on an email
 * address, and this function will hand all of it to a session on an email
 * match. Until `external_identities.email_verified_at` is set, "this session
 * controls that mailbox" is an unproven claim, which made confirmation
 * decorative on the one path where it mattered most.
 */
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
    .select("id,email,full_name,status,email_verified_at,vendor_identity_id")
    .eq("id", input.accountId)
    .maybeSingle()
  if (accountError || !account) throw new Error("Vendor portal account was not found")
  if (account.status !== "active") throw new Error("This Arc account is paused or revoked. Contact the builder.")
  if (!account.email_verified_at) throw new Error(UNVERIFIED_EMAIL_MESSAGE)

  if (account.vendor_identity_id) {
    const { data: linked, error } = await supabase
      .from("vendor_portal_identities")
      .select("id,email,full_name,status,email_verified_at")
      .eq("id", account.vendor_identity_id)
      .maybeSingle()
    if (error || !linked) throw new Error("Linked vendor identity was not found")
    assertVendorIdentityActive(linked.status)
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
    // password: the portal session already proved control of the address — the
    // confirmed-email gate above is what makes that true — and the hash this row
    // was seeded with is a stale copy that never rotates.
    assertVendorIdentityActive(existing.status)
    identity = existing as VendorPortalIdentityRow
  } else {
    const { data: created, error } = await supabase
      .from("vendor_portal_identities")
      .insert({
        email: normalizedEmail,
        full_name: input.accountFullName,
        status: "active",
        // The account's real confirmation timestamp, not `now()`. Stamping the
        // moment of creation asserted a verification that had never happened;
        // the gate above is what makes this value true.
        email_verified_at: account.email_verified_at,
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

// ── Vendor entity membership ────────────────────────────────────────────────

const ADMINISTERING_ROLES: VendorEntityRole[] = ["owner", "administrator"]

interface VendorMembershipRow {
  id: string
  role: VendorEntityRole
  status: VendorEntityMembershipStatus
  invited_by_identity_id: string | null
}

async function findMembership(vendorEntityId: string, identityId: string): Promise<VendorMembershipRow | null> {
  const supabase = createServiceSupabaseClient()
  const { data, error } = await supabase
    .from("vendor_entity_memberships")
    .select("id,role,status,invited_by_identity_id")
    .eq("vendor_entity_id", vendorEntityId)
    .eq("identity_id", identityId)
    .maybeSingle()
  if (error) throw new Error(`Unable to read vendor entity membership: ${error.message}`)
  return (data as VendorMembershipRow | null) ?? null
}

async function entityLegalName(vendorEntityId: string) {
  const supabase = createServiceSupabaseClient()
  const { data } = await supabase.from("vendor_entities").select("legal_name").eq("id", vendorEntityId).maybeSingle()
  return data?.legal_name ?? "this company"
}

/**
 * Every builder currently mapped to this vendor entity.
 *
 * A membership change has no org of its own, so the audit trail belongs to the
 * builders it affects — a new administrator on a vendor's Arc company is
 * exactly the kind of thing an AP clerk should be able to find later.
 */
async function orgIdsForVendorEntity(vendorEntityId: string) {
  const supabase = createServiceSupabaseClient()
  const { data } = await supabase
    .from("vendor_payment_relationships")
    .select("org_id")
    .eq("vendor_entity_id", vendorEntityId)
    .in("status", PAYOUT_INVITED_RELATIONSHIP_STATUSES)
    .limit(500)
  return [...new Set((data ?? []).map((row) => row.org_id))]
}

async function recordMembershipChange(input: {
  vendorEntityId: string
  membershipId: string
  eventType: string
  before: Record<string, unknown> | null
  after: Record<string, unknown>
}) {
  const orgIds = await orgIdsForVendorEntity(input.vendorEntityId)
  await Promise.all(orgIds.flatMap((orgId) => [
    recordEvent({
      orgId,
      eventType: input.eventType,
      entityType: "vendor_entity_membership",
      entityId: input.membershipId,
      payload: { vendor_entity_id: input.vendorEntityId, ...input.after },
    }),
    recordAudit({
      orgId,
      action: input.before ? "update" : "insert",
      entityType: "vendor_entity_membership",
      entityId: input.membershipId,
      before: input.before,
      after: input.after,
      source: "vendor_portal",
    }),
  ]))
}

/**
 * The signed-in vendor identity, refused unless it is usable.
 *
 * Membership administration decides who may point a builder's payments at a
 * payout account, so it holds the same confirmed-email bar as payout setup.
 */
async function requireVendorIdentity(): Promise<VendorPortalIdentityRow> {
  const session = await getCurrentExternalPortalSession()
  if (!session) throw new Error("Sign in to the vendor portal to continue")
  const supabase = createServiceSupabaseClient()
  const { data: account } = await supabase
    .from("external_identities")
    .select("vendor_identity_id,email_verified_at,status")
    .eq("id", session.identity.id)
    .maybeSingle()
  if (!account?.vendor_identity_id) {
    throw new Error("Finish setting up payouts before managing who administers your company")
  }
  if (account.status !== "active") throw new Error("This Arc account is paused or revoked. Contact the builder.")
  if (!account.email_verified_at) throw new Error(UNVERIFIED_EMAIL_MESSAGE)
  const { data: identity, error } = await supabase
    .from("vendor_portal_identities")
    .select("id,email,full_name,status,email_verified_at")
    .eq("id", account.vendor_identity_id)
    .maybeSingle()
  if (error || !identity) throw new Error("Vendor identity was not found")
  assertVendorIdentityActive(identity.status)
  return identity as VendorPortalIdentityRow
}

async function requireVendorEntityAdministrator(vendorEntityId: string) {
  const identity = await requireVendorIdentity()
  const membership = await findMembership(vendorEntityId, identity.id)
  if (!membership || membership.status !== "active" || !ADMINISTERING_ROLES.includes(membership.role)) {
    throw new Error("You are not an active administrator of that company")
  }
  return { identity, membership }
}

/**
 * Records that someone wants onto an entity an administrator already owns.
 *
 * Raised from the claim path, where the requester has already proven three
 * things: they control the email address the builder bound to this vendor
 * contact, the builder invited that company to payment setup, and the company
 * is already claimed. That is a strong enough signal to put a request in front
 * of an administrator — and far better than the alternative the code used to
 * take, which was to mint a second Arc company for the same legal business.
 *
 * Never resurrects a membership an administrator removed.
 */
async function requestVendorEntityMembership(input: { vendorEntityId: string; identityId: string }) {
  const existing = await findMembership(input.vendorEntityId, input.identityId)
  if (existing?.status === "revoked" || existing?.status === "suspended") return "withdrawn" as const
  if (existing) return "pending" as const
  const supabase = createServiceSupabaseClient()
  const { data, error } = await supabase
    .from("vendor_entity_memberships")
    .insert({
      vendor_entity_id: input.vendorEntityId,
      identity_id: input.identityId,
      role: "administrator",
      status: "invited",
      // Null is the marker: nobody invited them, they asked.
      invited_by_identity_id: null,
    })
    .select("id")
    .maybeSingle()
  // A parallel request from the same person hit the unique index first.
  if (error && (error as { code?: string }).code === "23505") return "pending" as const
  if (error || !data) throw new Error(`Unable to record the request to join: ${error?.message}`)
  await recordMembershipChange({
    vendorEntityId: input.vendorEntityId,
    membershipId: data.id,
    eventType: "vendor_entity_membership_requested",
    before: null,
    after: { identity_id: input.identityId, role: "administrator", status: "invited", requested: true },
  })
  return "requested" as const
}

const vendorEntityInviteSchema = z.object({
  vendor_entity_id: z.string().uuid(),
  email: z.string().trim().toLowerCase().email().max(320),
})

/**
 * Invite a colleague to administer this vendor entity.
 *
 * Resolves an Arc vendor login that already exists and nothing else. Creating
 * one on someone else's behalf means minting them a credential and a way to
 * recover it, and the vendor authentication/recovery channel is the decision
 * the fintech gameplan explicitly holds. So the reply is identical whether or
 * not the address has an account: it never becomes an oracle for "does this
 * person have Arc", and it tells the inviter exactly what to do in the case
 * where it could not land.
 */
export async function inviteVendorEntityAdministrator(input: { vendor_entity_id: string; email: string }) {
  const parsed = vendorEntityInviteSchema.parse(input)
  const { identity } = await requireVendorEntityAdministrator(parsed.vendor_entity_id)
  if (parsed.email === identity.email.trim().toLowerCase()) {
    throw new Error("You already administer this company")
  }
  const supabase = createServiceSupabaseClient()
  // `.eq`, never `.ilike` — `_` is a legal email character and a LIKE wildcard,
  // and this lookup decides who gets handed a payout administrator seat.
  const { data: invitee, error } = await supabase
    .from("vendor_portal_identities")
    .select("id,status")
    .eq("email", parsed.email)
    .maybeSingle()
  if (error) throw new Error(`Unable to send the invitation: ${error.message}`)

  if (invitee && invitee.status === "active") {
    const existing = await findMembership(parsed.vendor_entity_id, invitee.id)
    if (existing?.status === "active") throw new Error("That person already administers this company")
    if (!existing) {
      const { data: created, error: insertError } = await supabase
        .from("vendor_entity_memberships")
        .insert({
          vendor_entity_id: parsed.vendor_entity_id,
          identity_id: invitee.id,
          role: "administrator",
          status: "invited",
          invited_by_identity_id: identity.id,
        })
        .select("id")
        .maybeSingle()
      if (insertError && (insertError as { code?: string }).code !== "23505") {
        throw new Error(`Unable to send the invitation: ${insertError.message}`)
      }
      if (created) {
        await recordMembershipChange({
          vendorEntityId: parsed.vendor_entity_id,
          membershipId: created.id,
          eventType: "vendor_entity_membership_invited",
          before: null,
          after: { identity_id: invitee.id, role: "administrator", status: "invited", invited_by_identity_id: identity.id },
        })
      }
    } else if (existing.status === "invited" && existing.invited_by_identity_id === null) {
      // They asked first; the invitation is the answer. Approve it rather than
      // leaving two pending records that mean the same thing.
      await approveMembership({ membershipId: existing.id, vendorEntityId: parsed.vendor_entity_id, approverIdentityId: identity.id })
    }
    // A `revoked` or `suspended` membership is deliberately left alone: an
    // administrator removed that person, and re-inviting must not undo it
    // silently. `removeVendorEntityMember` is reversible only by Arc support.
  }

  return {
    email: parsed.email,
    // Deliberately the same sentence in every branch.
    message: `If ${parsed.email} has an Arc vendor login, the invitation is waiting for them the next time they sign in. If they do not, ask your builder to send them a payment invitation first, then invite them again here.`,
  }
}

/**
 * Turns a pending membership into a real one, from either direction.
 *
 * `invited_by_identity_id` is stamped with whoever made it active, so an active
 * row always names the administrator who is accountable for it — including the
 * one who approved a request nobody had invited. The distinction between the two
 * routes survives in the event stream.
 */
async function approveMembership(input: { membershipId: string; vendorEntityId: string; approverIdentityId: string }) {
  const supabase = createServiceSupabaseClient()
  const { data, error } = await supabase
    .from("vendor_entity_memberships")
    .update({ status: "active", accepted_at: new Date().toISOString(), invited_by_identity_id: input.approverIdentityId })
    .eq("id", input.membershipId)
    .eq("vendor_entity_id", input.vendorEntityId)
    .eq("status", "invited")
    .select("id,identity_id")
    .maybeSingle()
  if (error) throw new Error(`Unable to approve the request: ${error.message}`)
  if (!data) throw new Error("That request was already decided. Refresh and try again.")
  await recordMembershipChange({
    vendorEntityId: input.vendorEntityId,
    membershipId: data.id,
    eventType: "vendor_entity_membership_activated",
    before: { status: "invited" },
    after: { status: "active", identity_id: data.identity_id, decided_by_identity_id: input.approverIdentityId },
  })
}

const membershipDecisionSchema = z.object({
  membership_id: z.string().uuid(),
  accept: z.boolean(),
})

/** The invitee's own answer to an invitation addressed to them. */
export async function respondToVendorEntityInvitation(input: { membership_id: string; accept: boolean }) {
  const parsed = membershipDecisionSchema.parse(input)
  const identity = await requireVendorIdentity()
  const supabase = createServiceSupabaseClient()
  const { data: membership, error } = await supabase
    .from("vendor_entity_memberships")
    .select("id,vendor_entity_id,status,invited_by_identity_id")
    .eq("id", parsed.membership_id)
    .eq("identity_id", identity.id)
    .maybeSingle()
  if (error) throw new Error(`Unable to read the invitation: ${error.message}`)
  if (!membership || membership.status !== "invited" || !membership.invited_by_identity_id) {
    throw new Error("That invitation is no longer open")
  }
  if (parsed.accept) {
    await approveMembership({
      membershipId: membership.id,
      vendorEntityId: membership.vendor_entity_id,
      approverIdentityId: membership.invited_by_identity_id,
    })
    return { accepted: true }
  }
  const nowIso = new Date().toISOString()
  const { error: declineError } = await supabase
    .from("vendor_entity_memberships")
    .update({ status: "revoked", revoked_at: nowIso })
    .eq("id", membership.id)
    .eq("status", "invited")
  if (declineError) throw new Error(`Unable to decline the invitation: ${declineError.message}`)
  await recordMembershipChange({
    vendorEntityId: membership.vendor_entity_id,
    membershipId: membership.id,
    eventType: "vendor_entity_membership_declined",
    before: { status: "invited" },
    after: { status: "revoked", identity_id: identity.id },
  })
  return { accepted: false }
}

const joinRequestDecisionSchema = z.object({
  membership_id: z.string().uuid(),
  approve: z.boolean(),
})

/** An administrator's answer to someone who asked to join their entity. */
export async function decideVendorEntityJoinRequest(input: { membership_id: string; approve: boolean }) {
  const parsed = joinRequestDecisionSchema.parse(input)
  const supabase = createServiceSupabaseClient()
  const { data: membership, error } = await supabase
    .from("vendor_entity_memberships")
    .select("id,vendor_entity_id,identity_id,status,invited_by_identity_id")
    .eq("id", parsed.membership_id)
    .maybeSingle()
  if (error) throw new Error(`Unable to read the request: ${error.message}`)
  if (!membership || membership.status !== "invited" || membership.invited_by_identity_id !== null) {
    throw new Error("That request is no longer open")
  }
  const { identity } = await requireVendorEntityAdministrator(membership.vendor_entity_id)
  if (parsed.approve) {
    await approveMembership({
      membershipId: membership.id,
      vendorEntityId: membership.vendor_entity_id,
      approverIdentityId: identity.id,
    })
    return { approved: true }
  }
  const { error: declineError } = await supabase
    .from("vendor_entity_memberships")
    .update({ status: "revoked", revoked_at: new Date().toISOString() })
    .eq("id", membership.id)
    .eq("status", "invited")
  if (declineError) throw new Error(`Unable to decline the request: ${declineError.message}`)
  await recordMembershipChange({
    vendorEntityId: membership.vendor_entity_id,
    membershipId: membership.id,
    eventType: "vendor_entity_membership_declined",
    before: { status: "invited" },
    after: { status: "revoked", identity_id: membership.identity_id, decided_by_identity_id: identity.id },
  })
  return { approved: false }
}

/**
 * Remove someone's authority over this vendor entity.
 *
 * Refuses to remove the last administrator: an entity with nobody who can
 * administer it is an orphaned payout account, and recovering one needs the
 * gated vendor recovery channel rather than a support ticket.
 */
export async function removeVendorEntityMember(input: { membership_id: string }) {
  const parsed = z.object({ membership_id: z.string().uuid() }).parse(input)
  const supabase = createServiceSupabaseClient()
  const { data: membership, error } = await supabase
    .from("vendor_entity_memberships")
    .select("id,vendor_entity_id,identity_id,role,status")
    .eq("id", parsed.membership_id)
    .maybeSingle()
  if (error) throw new Error(`Unable to read the membership: ${error.message}`)
  if (!membership || membership.status === "revoked") throw new Error("That person is no longer a member")
  const { identity } = await requireVendorEntityAdministrator(membership.vendor_entity_id)

  const { count } = await supabase
    .from("vendor_entity_memberships")
    .select("id", { count: "exact", head: true })
    .eq("vendor_entity_id", membership.vendor_entity_id)
    .eq("status", "active")
    .in("role", ADMINISTERING_ROLES)
  if (membership.status === "active" && ADMINISTERING_ROLES.includes(membership.role) && (count ?? 0) <= 1) {
    throw new Error("Add another administrator before removing the last one")
  }

  const { error: revokeError } = await supabase
    .from("vendor_entity_memberships")
    .update({ status: "revoked", revoked_at: new Date().toISOString() })
    .eq("id", membership.id)
    .neq("status", "revoked")
  if (revokeError) throw new Error(`Unable to remove that person: ${revokeError.message}`)
  await recordMembershipChange({
    vendorEntityId: membership.vendor_entity_id,
    membershipId: membership.id,
    eventType: "vendor_entity_membership_revoked",
    before: { status: membership.status, role: membership.role },
    after: { status: "revoked", identity_id: membership.identity_id, decided_by_identity_id: identity.id },
  })
  return { removed: true }
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

  let vendorEntityId: string | undefined
  if (existingClaim) {
    // An existing claim already binds this builder's vendor record to one global
    // company, and this is the branch where a duplicate used to be minted: a
    // second administrator arriving on their own payout link fell through to
    // "create a new entity", which would give one legal business two Arc
    // companies and two Stripe accounts, then split the builder's payments
    // between them. The only way onto an existing entity is a membership its
    // administrators granted — never a match on name, email or tax ID.
    const claimedEntityId: string = existingClaim.vendor_entity_id
    const membership = await findMembership(claimedEntityId, identity.id)
    if (!membership || membership.status !== "active") {
      const legalName = await entityLegalName(claimedEntityId)
      const outcome = membership
        ? (membership.status === "invited" ? "pending" : "withdrawn")
        : await requestVendorEntityMembership({ vendorEntityId: claimedEntityId, identityId: identity.id })
      throw new Error(
        outcome === "withdrawn"
          ? `${legalName} is already set up on Arc, and an administrator there removed your access. Ask them to invite you again.`
          : `${legalName} is already set up on Arc for this company. We have asked its administrators to add you — once one of them approves, come back here to finish.`,
      )
    }
    if (!ADMINISTERING_ROLES.includes(membership.role)) {
      throw new Error("You are not an administrator of that company. Ask an administrator to set up payouts.")
    }
    if (parsed.vendor_entity_id && parsed.vendor_entity_id !== claimedEntityId) {
      throw new Error("This builder's vendor record is already linked to a different one of your companies. Contact the builder or Arc support to change it.")
    }
    vendorEntityId = claimedEntityId

    // Setup is one action that resumes where the vendor left off, so this runs
    // again every time they return to finish provider verification. Re-stamping
    // the claim would re-notify the builder and reset the relationship age the
    // risk signals read.
    if (existingClaim.status === "verified" && existingRelationship) {
      return { identityId: identity.id, vendorEntityId, relationshipId: existingRelationship.id, status: existingRelationship.status, claimed: false }
    }
  } else if (parsed.vendor_entity_id) {
    const membership = await findMembership(parsed.vendor_entity_id, identity.id)
    if (!membership || membership.status !== "active" || !ADMINISTERING_ROLES.includes(membership.role)) {
      throw new Error("You are not an active administrator of that vendor entity")
    }
    vendorEntityId = parsed.vendor_entity_id
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
    // The only verification method Arc actually performs today: the builder
    // addressed a payout link to a named contact, and that contact proved they
    // control the address. `builder_review` and `platform_review` stay in the
    // column's check constraint as reserved values for the two operating models
    // the fintech gameplan is holding a decision on (a second vendor
    // administrator, or an Arc payments-operations reviewer). Neither has a
    // surface, so neither is written here.
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

const EMPTY_PORTAL_CONTEXT: VendorPaymentPortalContext = {
  identity: null,
  entities: [],
  invitations: [],
  pendingJoinRequests: [],
  relationships: [],
  recentPayments: [],
  inFlightPayments: [],
  recentPaymentsTruncated: false,
  inFlightPaymentsTruncated: false,
  emailVerified: false,
}

function asEntityRole(value: string): VendorEntityRole {
  return value === "owner" || value === "member" ? value : "administrator"
}

function asMembershipStatus(value: string): VendorEntityMembershipStatus {
  return value === "invited" || value === "suspended" || value === "revoked" ? value : "active"
}

function asIdentityStatus(value: string): VendorIdentityStatus {
  return value === "pending_verification" || value === "locked" || value === "revoked" ? value : "active"
}

export async function getVendorPaymentPortalContext(): Promise<VendorPaymentPortalContext> {
  const session = await getCurrentExternalPortalSession()
  if (!session) return EMPTY_PORTAL_CONTEXT
  const supabase = createServiceSupabaseClient()
  const { data: account } = await supabase
    .from("external_identities")
    .select("vendor_identity_id,email_verified_at")
    .eq("id", session.identity.id)
    .maybeSingle()
  const emailVerified = Boolean(account?.email_verified_at)
  if (!account?.vendor_identity_id) return { ...EMPTY_PORTAL_CONTEXT, emailVerified }

  const [{ data: identityRow }, { data: myMembershipRows }] = await Promise.all([
    supabase
      .from("vendor_portal_identities")
      .select("id,email,full_name,status")
      .eq("id", account.vendor_identity_id)
      .maybeSingle(),
    // Every standing, not just the active ones: an invitation waiting for this
    // person and a request they made are both things the portal has to show, and
    // both live in this table as `invited`.
    supabase
      .from("vendor_entity_memberships")
      .select("id,vendor_entity_id,role,status,invited_by_identity_id")
      .eq("identity_id", account.vendor_identity_id)
      .in("status", ["invited", "active"]),
  ])

  const identity = identityRow
    ? {
      id: identityRow.id,
      email: identityRow.email,
      fullName: identityRow.full_name,
      status: asIdentityStatus(identityRow.status),
    }
    : null
  // A locked or revoked global login reaches no entity, no builder and no money.
  // Returning the identity anyway is what lets the portal explain the state
  // instead of rendering an empty page with no reason.
  if (!identity || identity.status !== "active") {
    return { ...EMPTY_PORTAL_CONTEXT, identity, emailVerified }
  }

  const membershipRows = (myMembershipRows ?? []).filter((row) => row.status === "active")
  const pendingRows = (myMembershipRows ?? []).filter((row) => row.status === "invited")
  const entityIds = [...new Set(membershipRows.map((row) => row.vendor_entity_id))]
  const pendingEntityIds = [...new Set(pendingRows.map((row) => row.vendor_entity_id))]
  const administeredEntityIds = membershipRows
    .filter((row) => ADMINISTERING_ROLES.includes(asEntityRole(row.role)))
    .map((row) => row.vendor_entity_id)

  // Suspended and revoked relationships are excluded here, not filtered in the
  // UI. This query is what decides which builders exist for this vendor, and
  // every downstream read — payment history, retainage, in-flight amounts — is
  // scoped by the companies it returns. A builder that withdrew payment access
  // has to disappear from the vendor's payment surface with it.
  const { data: relationshipRows } = entityIds.length > 0
    ? await supabase
      .from("vendor_payment_relationships")
      .select("id,org_id,company_id,vendor_entity_id,status")
      .in("vendor_entity_id", entityIds)
      .in("status", PAYOUT_INVITED_RELATIONSHIP_STATUSES)
      .order("created_at", { ascending: false })
    : { data: [] }
  const orgIds = [...new Set((relationshipRows ?? []).map((row) => row.org_id))]
  const companyIds = [...new Set((relationshipRows ?? []).map((row) => row.company_id))]
  const namedEntityIds = [...new Set([...entityIds, ...pendingEntityIds])]
  const [{ data: entityRows }, { data: recipientRows }, { data: orgRows }, { data: companyRows }, { data: rosterRows }] = await Promise.all([
    namedEntityIds.length > 0
      ? supabase.from("vendor_entities").select("id,legal_name,dba_name,status").in("id", namedEntityIds)
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
    administeredEntityIds.length > 0
      ? supabase
        .from("vendor_entity_memberships")
        .select("id,vendor_entity_id,identity_id,role,status,invited_by_identity_id,identity:vendor_portal_identities(id,email,full_name)")
        .in("vendor_entity_id", administeredEntityIds)
        .in("status", ["invited", "active"])
        .limit(200)
      : Promise.resolve({ data: [] }),
  ])
  const entityById = new Map((entityRows ?? []).map((entity) => [entity.id, entity]))
  const recipientByEntityId = new Map((recipientRows ?? []).map((recipient) => [recipient.vendor_entity_id, recipient]))
  const orgNameById = new Map((orgRows ?? []).map((org) => [org.id, org.name]))
  const companyNameById = new Map((companyRows ?? []).map((company) => [company.id, company.name]))

  const membersByEntityId = new Map<string, VendorEntityMember[]>()
  for (const row of rosterRows ?? []) {
    const memberIdentity = firstRelation(
      row.identity as { id?: string; email?: string | null; full_name?: string | null } | Array<{ id?: string; email?: string | null; full_name?: string | null }> | null,
    )
    if (!memberIdentity?.email) continue
    const bucket = membersByEntityId.get(row.vendor_entity_id) ?? []
    bucket.push({
      membershipId: row.id,
      identityId: row.identity_id,
      email: memberIdentity.email,
      fullName: memberIdentity.full_name ?? null,
      role: asEntityRole(row.role),
      status: asMembershipStatus(row.status),
      invitedByIdentityId: row.invited_by_identity_id ?? null,
      isSelf: row.identity_id === identity.id,
    })
    membersByEntityId.set(row.vendor_entity_id, bucket)
  }

  // Sourced from `payments` rather than `disbursements` so a check appears
  // beside an ACH. Both rails write here — `record_ap_payment_atomic` inserts a
  // payment for every settled disbursement — so this is the one place that sees
  // every dollar the vendor was actually sent, which is the whole question the
  // vendor came to this page to answer. Filtering by the bill's company is safe
  // without an org filter: a company row belongs to exactly one org.
  //
  // One row past the cap is fetched purely so the page can say it truncated
  // rather than quietly dropping a busy vendor's older payments.
  const { data: paymentRows } = companyIds.length > 0
    ? await supabase.from("payments")
      .select("id,org_id,amount_cents,currency,method,status,received_at,reference,bill:vendor_bills!inner(id,bill_number,company_id,retainage_cents)")
      .in("bill.company_id", companyIds)
      .in("status", ["succeeded", "completed"])
      .order("received_at", { ascending: false })
      .limit(VENDOR_RECENT_PAYMENTS_CAP + 1)
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
      .limit(VENDOR_IN_FLIGHT_PAYMENTS_CAP + 1)
    : { data: [] }

  const settlementWindow = getPaymentRailProvider().settlementWindow
  const allPayments = paymentRows ?? []
  const recentPaymentsTruncated = allPayments.length > VENDOR_RECENT_PAYMENTS_CAP
  const allInFlight = inFlightRows ?? []
  const inFlightPaymentsTruncated = allInFlight.length > VENDOR_IN_FLIGHT_PAYMENTS_CAP

  const entities = membershipRows.flatMap((row) => {
    const entity = entityById.get(row.vendor_entity_id)
    if (!entity) return []
    const recipient = recipientByEntityId.get(entity.id)
    const role = asEntityRole(row.role)
    return [{
      id: entity.id,
      legalName: entity.legal_name,
      dbaName: entity.dba_name ?? null,
      role,
      status: entity.status,
      recipient: recipient ? {
        id: recipient.id,
        provider: recipient.provider,
        status: recipient.status,
        payoutsEnabled: Boolean(recipient.payouts_enabled),
        bankName: recipient.payout_bank_name ?? null,
        bankLast4: recipient.payout_bank_last4 ?? null,
      } : null,
      members: ADMINISTERING_ROLES.includes(role) ? membersByEntityId.get(entity.id) ?? [] : [],
    }]
  })

  const pendingEntry = (row: { id: string; vendor_entity_id: string; role: string }): VendorEntityInvitation => ({
    membershipId: row.id,
    vendorEntityId: row.vendor_entity_id,
    entityLegalName: entityById.get(row.vendor_entity_id)?.legal_name ?? "A company",
    role: asEntityRole(row.role),
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
    identity,
    entities,
    invitations: pendingRows.filter((row) => row.invited_by_identity_id !== null).map(pendingEntry),
    pendingJoinRequests: pendingRows.filter((row) => row.invited_by_identity_id === null).map(pendingEntry),
    relationships,
    recentPaymentsTruncated,
    inFlightPaymentsTruncated,
    emailVerified,
    recentPayments: allPayments.slice(0, VENDOR_RECENT_PAYMENTS_CAP).map((payment) => {
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
    inFlightPayments: allInFlight.slice(0, VENDOR_IN_FLIGHT_PAYMENTS_CAP).map((disbursement) => {
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
