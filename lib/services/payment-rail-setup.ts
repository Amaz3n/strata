import "server-only"

import { z } from "zod"

import { getAppBaseUrl } from "@/lib/integrations/payments/stripe"
import { getPaymentRailProvider } from "@/lib/integrations/payments/payment-rail-registry"
import { recordAudit } from "@/lib/services/audit"
import { requireOrgContext } from "@/lib/services/context"
import { recordEvent } from "@/lib/services/events"
import { assertPaymentLaunchReady } from "@/lib/services/payment-launch-readiness"
import { sendVendorPayoutDestinationChangedEmail } from "@/lib/services/mailer"
import { hasPermission, requirePermission } from "@/lib/services/permissions"
import { requireRecentPaymentStepUp } from "@/lib/services/payment-step-up"
import {
  getPaymentApprovalRouting,
  listPaymentApproverCandidates,
  type PaymentRunApprover,
} from "@/lib/services/payment-approvers"
import {
  claimVendorCompany,
  getVendorPaymentAccessForCompany,
  getVendorPaymentPortalContext,
  requireVendorPayoutPortalAccess,
} from "@/lib/services/vendor-payment-identities"
import { createServiceSupabaseClient } from "@/lib/supabase/server"
import {
  startVendorPayoutSetupSchema,
  updatePaymentRailPolicySchema,
  type StartVendorPayoutSetupInput,
  type UpdatePaymentRailPolicyInput,
} from "@/lib/validation/fintech-payments"

const DEFAULT_PROVIDER = "stripe"

/**
 * The payout-destination cooling period.
 *
 * A change of destination is the single highest-value event on this rail, and
 * `payment_recipient_accounts.destination_locked_until` / `destination_version`
 * existed to hold one — but nothing ever wrote them, so the control was read in
 * four places and enforced nowhere. The bounds mirror the funding-source cooling
 * window the policy already exposes (`control_change_cooling_hours`, 24–168h,
 * 72h default), because they answer the same question about the other end of the
 * same payment.
 */
const DEFAULT_DESTINATION_COOLING_HOURS = 72
const MIN_DESTINATION_COOLING_HOURS = 24
const MAX_DESTINATION_COOLING_HOURS = 168

function firstRelation<T>(value: T | T[] | null | undefined): T | null {
  if (Array.isArray(value)) return value[0] ?? null
  return value ?? null
}

function clampCoolingHours(value: unknown): number {
  const hours = Number(value)
  if (!Number.isFinite(hours)) return DEFAULT_DESTINATION_COOLING_HOURS
  return Math.min(MAX_DESTINATION_COOLING_HOURS, Math.max(MIN_DESTINATION_COOLING_HOURS, Math.round(hours)))
}

function jsonString(value: unknown, key: string) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  const candidate = Reflect.get(value, key)
  return typeof candidate === "string" ? candidate : null
}

async function listRecipientRelationships(recipientAccountId: string) {
  const supabase = createServiceSupabaseClient()
  const pageSize = 500
  const rows: Array<{ id: string; org_id: string; company_id: string; invited_by: string | null; status: string }> = []
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await supabase.from("vendor_payment_relationships")
      .select("id,org_id,company_id,invited_by,status")
      .eq("recipient_account_id", recipientAccountId)
      .in("status", ["invited", "claim_pending", "onboarding", "active"])
      .range(from, from + pageSize - 1)
    if (error) throw new Error(`Unable to load recipient relationships: ${error.message}`)
    rows.push(...(data ?? []))
    if ((data ?? []).length < pageSize) return rows
  }
}

export interface PaymentRailSettings {
  policy: {
    /**
     * Whether the org has ever saved payment settings. Distinct from `enabled`:
     * saving once is what opens the payout section in this builder's vendor
     * portals (see `isVendorPayoutSetupOpen`), long before money can move.
     */
    configured: boolean
    enabled: boolean
    approvalMode: "sole" | "dual"
    /** True only for explicitly owner-operated organizations. */
    requesterMayApprove: boolean
    coolingHours: number
    perPaymentLimitCents: number | null
    perRunLimitCents: number | null
    dailyLimitCents: number | null
    maxInflightCents: number | null
    returnLossCeilingCents: number | null
    payoutHoldHours: number
    newVendorHoldHours: number
    waiverJurisdiction: string
  }
  fundingSources: Array<{
    id: string
    provider: string
    bankName: string | null
    last4: string | null
    verificationStatus: string
    status: string
    isDefault: boolean
    usableAfter: string | null
  }>
  controlChanges: Array<{
    id: string
    fundingSourceId: string | null
    status: string
    requiredApprovals: number
    approvalCount: number
    applyAfter: string
    bankName: string | null
    last4: string | null
    canDecide: boolean
  }>
  /** Designated approvers, plus who could be designated (managers only). */
  approvals: {
    approvers: PaymentRunApprover[]
    candidates: Array<{ userId: string; name: string; email: string | null }>
    viewerUserId: string
  }
  canManage: boolean
  canApprove: boolean
}

export async function getPaymentRailSettings(orgId?: string): Promise<PaymentRailSettings> {
  const context = await requireOrgContext(orgId)
  await requirePermission("payment.release", context)
  const supabase = createServiceSupabaseClient()
  const [{ data: policy }, { data: fundingSources }, { data: changes }, canManage, canApprove] = await Promise.all([
    supabase.from("payment_rail_policies").select("enabled,approval_mode,requester_may_approve,control_change_cooling_hours,per_payment_limit_cents,per_run_limit_cents,daily_limit_cents,max_inflight_cents,return_loss_ceiling_cents,payout_hold_hours,new_vendor_hold_hours,waiver_jurisdiction").eq("org_id", context.orgId).maybeSingle(),
    supabase.from("org_funding_sources").select("id,provider,bank_name,last4,verification_status,status,is_default,usable_after").eq("org_id", context.orgId).order("created_at", { ascending: false }).limit(20),
    supabase.from("payment_control_change_requests").select("id,funding_source_id,requested_by_user_id,status,required_approvals,apply_after,proposed_masked_details").eq("org_id", context.orgId).eq("kind", "org_funding_source").in("status", ["pending_approval", "cooling_off"]).order("created_at", { ascending: false }).limit(20),
    hasPermission("payment.manage_rail", context),
    hasPermission("payment.approve_run", context),
  ])
  const changeIds = (changes ?? []).map((change) => change.id)
  const [{ data: approvals }, routing, candidates] = await Promise.all([
    changeIds.length > 0
      ? supabase.from("payment_control_change_approvals").select("change_request_id,decision").in("change_request_id", changeIds)
      : Promise.resolve({ data: [] }),
    getPaymentApprovalRouting(context.orgId),
    canManage ? listPaymentApproverCandidates(context.orgId) : Promise.resolve([]),
  ])
  return {
    policy: {
      configured: Boolean(policy),
      enabled: Boolean(policy?.enabled),
      approvalMode: policy?.approval_mode === "sole" ? "sole" : "dual",
      requesterMayApprove: policy?.requester_may_approve === true,
      coolingHours: Number(policy?.control_change_cooling_hours ?? 72),
      perPaymentLimitCents: policy?.per_payment_limit_cents == null ? null : Number(policy.per_payment_limit_cents),
      perRunLimitCents: policy?.per_run_limit_cents == null ? null : Number(policy.per_run_limit_cents),
      dailyLimitCents: policy?.daily_limit_cents == null ? null : Number(policy.daily_limit_cents),
      maxInflightCents: policy?.max_inflight_cents == null ? null : Number(policy.max_inflight_cents),
      returnLossCeilingCents: policy?.return_loss_ceiling_cents == null ? null : Number(policy.return_loss_ceiling_cents),
      payoutHoldHours: Number(policy?.payout_hold_hours ?? 48),
      newVendorHoldHours: Number(policy?.new_vendor_hold_hours ?? 72),
      waiverJurisdiction: policy?.waiver_jurisdiction ?? "FL",
    },
    fundingSources: (fundingSources ?? []).map((row) => ({
      id: row.id,
      provider: row.provider,
      bankName: row.bank_name ?? null,
      last4: row.last4 ?? null,
      verificationStatus: row.verification_status,
      status: row.status,
      isDefault: Boolean(row.is_default),
      usableAfter: row.usable_after ?? null,
    })),
    controlChanges: (changes ?? []).map((row) => {
      return {
        id: row.id,
        fundingSourceId: row.funding_source_id ?? null,
        status: row.status,
        requiredApprovals: Number(row.required_approvals),
        approvalCount: (approvals ?? []).filter((approval) => approval.change_request_id === row.id && approval.decision === "approved").length,
        applyAfter: row.apply_after,
        bankName: jsonString(row.proposed_masked_details, "bank_name"),
        last4: jsonString(row.proposed_masked_details, "last4"),
        canDecide: canApprove && row.requested_by_user_id !== context.userId,
      }
    }),
    approvals: {
      approvers: routing.approvers,
      candidates,
      viewerUserId: routing.viewerUserId,
    },
    canManage,
    canApprove,
  }
}

export async function updatePaymentRailPolicy(input: UpdatePaymentRailPolicyInput, orgId?: string) {
  const parsed = updatePaymentRailPolicySchema.parse(input)
  const context = await requireOrgContext(orgId)
  await requirePermission("payment.manage_rail", context)
  const supabase = createServiceSupabaseClient()
  const { data: existing } = await supabase.from("payment_rail_policies").select("id,enabled,approval_mode,requester_may_approve,reconciliation_monitoring_started_at,per_payment_limit_cents,per_run_limit_cents,daily_limit_cents,max_inflight_cents,return_loss_ceiling_cents,payout_hold_hours,new_vendor_hold_hours").eq("org_id", context.orgId).maybeSingle()
  const nextApprovalMode = parsed.approval_mode ?? existing?.approval_mode ?? "dual"
  const nextRequesterMayApprove = parsed.requester_may_approve ?? existing?.requester_may_approve ?? false
  if (nextRequesterMayApprove && nextApprovalMode !== "sole") {
    throw new Error("Owner approval can only be used with one required approval")
  }
  if (parsed.enabled) {
    await assertPaymentLaunchReady()
    const { count } = await supabase.from("org_funding_sources").select("id", { count: "exact", head: true }).eq("org_id", context.orgId).eq("status", "active")
    if (!count) throw new Error("Approve and activate a funding source before enabling Arc Pay")
    const requiredLimits = {
      per_payment_limit_cents: parsed.per_payment_limit_cents !== undefined ? parsed.per_payment_limit_cents : existing?.per_payment_limit_cents,
      per_run_limit_cents: parsed.per_run_limit_cents !== undefined ? parsed.per_run_limit_cents : existing?.per_run_limit_cents,
      daily_limit_cents: parsed.daily_limit_cents !== undefined ? parsed.daily_limit_cents : existing?.daily_limit_cents,
      max_inflight_cents: parsed.max_inflight_cents !== undefined ? parsed.max_inflight_cents : existing?.max_inflight_cents,
      return_loss_ceiling_cents: parsed.return_loss_ceiling_cents !== undefined ? parsed.return_loss_ceiling_cents : existing?.return_loss_ceiling_cents,
    }
    if (Object.values(requiredLimits).some((value) => value == null)) {
      throw new Error("Set payment, run, daily, in-flight, and return-loss limits before enabling Arc Pay")
    }
    const perPayment = Number(requiredLimits.per_payment_limit_cents)
    const perRun = Number(requiredLimits.per_run_limit_cents)
    const daily = Number(requiredLimits.daily_limit_cents)
    const maxInflight = Number(requiredLimits.max_inflight_cents)
    if (perRun < perPayment || daily < perRun || maxInflight < daily) {
      throw new Error("Risk limits must increase from payment to run to daily to in-flight exposure")
    }
    const payoutHoldHours = parsed.payout_hold_hours ?? existing?.payout_hold_hours ?? 48
    const newVendorHoldHours = parsed.new_vendor_hold_hours ?? existing?.new_vendor_hold_hours ?? 72
    if (payoutHoldHours < 48 || newVendorHoldHours < 24) throw new Error("Payment safety holds are below the production minimum")
  }
  const payload = {
    org_id: context.orgId,
    ...parsed,
    approval_mode: nextApprovalMode,
    requester_may_approve: nextRequesterMayApprove,
    require_dual_for_control_changes: true,
    waiver_jurisdiction: "FL",
    updated_by: context.userId,
    ...(!existing ? { created_by: context.userId } : {}),
    ...(parsed.enabled === true && existing?.enabled !== true
      ? { reconciliation_monitoring_started_at: new Date().toISOString() }
      : parsed.enabled === false && existing?.enabled === true
        ? { reconciliation_monitoring_started_at: null }
        : {}),
  }
  const { data, error } = await supabase.from("payment_rail_policies").upsert(payload, { onConflict: "org_id" }).select("id,enabled,approval_mode,requester_may_approve").single()
  if (error || !data) throw new Error(`Unable to save payment policy: ${error?.message}`)
  await Promise.all([
    recordEvent({ orgId: context.orgId, actorId: context.userId, eventType: "payment_rail_policy_updated", entityType: "payment_rail_policy", entityId: data.id, payload: { enabled: data.enabled, approval_mode: data.approval_mode, requester_may_approve: data.requester_may_approve } }),
    recordAudit({ orgId: context.orgId, actorId: context.userId, action: existing ? "update" : "insert", entityType: "payment_rail_policy", entityId: data.id, before: existing, after: payload }),
  ])
  return data
}

/**
 * Whether this builder's vendors may start payout onboarding.
 *
 * Deliberately keyed on the policy existing, not on `enabled`. `enabled` means
 * money movement is armed, and it cannot be set until a funding source is
 * active — which needs an independent approver and a cooling period of at least
 * 24 hours. Gating vendor onboarding on it would deadlock the intended order:
 * vendors are supposed to get verified while no money moves yet, so the first
 * payment run has payable vendors waiting for it. Saving payment settings once
 * is the builder's statement of intent, and is what opens the vendor surface.
 *
 * Fails closed: a vendor of a builder that has never configured payments should
 * not be shown a payout flow that can only dead-end.
 */
export async function isVendorPayoutSetupOpen(orgId: string) {
  const supabase = createServiceSupabaseClient()
  const { data, error } = await supabase.from("payment_rail_policies").select("id").eq("org_id", orgId).maybeSingle()
  if (error) return false
  return Boolean(data)
}

/**
 * Whether one vendor company should see this builder's payment section at all.
 *
 * `isVendorPayoutSetupOpen` answers "has this builder opened payments" and
 * nothing about the vendor asking, so a vendor whose payment access was
 * suspended or revoked kept a "Get paid" tab that could only refuse them. This
 * is the gate a per-company surface wants.
 */
export async function isVendorPaymentSectionOpen({ orgId, companyId }: { orgId: string; companyId: string }) {
  const [railOpen, access] = await Promise.all([
    isVendorPayoutSetupOpen(orgId),
    getVendorPaymentAccessForCompany(orgId, companyId),
  ])
  return railOpen && access.state !== "withdrawn"
}

/**
 * Adopt an already-verified payout account into a freshly claimed relationship.
 *
 * The payout account belongs to the vendor entity, not to any builder, so a
 * vendor who verified with one builder is already payable by the next one. That
 * makes joining a second builder a mapping, not an onboarding — there is no new
 * bank, nothing for the provider to verify, and nothing to send the vendor back
 * through Stripe for.
 *
 * Returns false when the entity has no usable recipient yet, which leaves the
 * caller to run the normal provider flow.
 *
 * Deliberately NOT a destination change, and so deliberately not held by
 * `applyDestinationChangeHold`. Nothing about the payout account moves here —
 * this builder is mapped onto a destination that already existed and that other
 * builders are already paying. `destination_locked_until` lives on the recipient
 * account, which the vendor entity owns globally, so freezing it for a mapping
 * would stop every other builder's payments to a bank that did not change. The
 * control that does cover this case is per-relationship and already blocks:
 * `recently_claimed_vendor_relationship` holds the first payment to a freshly
 * claimed relationship for the org's `new_vendor_hold_hours`.
 */
async function adoptVerifiedRecipient(input: { vendorEntityId: string; relationshipId: string }) {
  const supabase = createServiceSupabaseClient()
  const { data: recipient } = await supabase
    .from("payment_recipient_accounts")
    .select("id")
    .eq("vendor_entity_id", input.vendorEntityId)
    .eq("status", "ready")
    .eq("payouts_enabled", true)
    .limit(1)
    .maybeSingle()
  if (!recipient) return false
  const { data: relationship, error } = await supabase
    .from("vendor_payment_relationships")
    .update({ recipient_account_id: recipient.id, status: "active" })
    .eq("id", input.relationshipId)
    .neq("status", "active")
    .select("id,org_id,company_id,invited_by")
    .maybeSingle()
  if (error) throw new Error(`Unable to link the verified payout account: ${error.message}`)
  // Another return/webhook may have activated the same relationship first.
  // The ready account was still adopted successfully; only that first writer
  // owns the email notification.
  if (!relationship) return true
  await Promise.all([
    recordEvent({
      orgId: relationship.org_id,
      eventType: "vendor_recipient_status_updated",
      entityType: "payment_recipient_account",
      entityId: recipient.id,
      payload: { status: "ready", payouts_enabled: true, reused_existing_account: true },
    }),
    recordAudit({
      orgId: relationship.org_id,
      action: "update",
      entityType: "vendor_payment_relationship",
      entityId: relationship.id,
      after: { status: "active", recipient_account_id: recipient.id },
      source: "vendor_portal",
    }),
  ])
  return true
}

/**
 * The single vendor-facing payout action. Mapping the builder's vendor record
 * onto a global vendor entity carries no authorization the portal session has
 * not already established, so it is not a step the vendor confirms separately —
 * it is resolved here and handed straight to provider verification.
 *
 * A `null` url means there was nothing left to verify: the vendor's existing
 * account was adopted and this builder can pay them immediately.
 */
export async function startVendorPayoutSetup(input: StartVendorPayoutSetupInput) {
  const parsed = startVendorPayoutSetupSchema.parse(input)
  // `isVendorPayoutSetupOpen` gated the page and nothing else, so invoking this
  // action directly created claims, relationships and live Stripe Express
  // accounts for builders that never opened the rail. UI visibility is not
  // authorization; the server decides.
  const access = await requireVendorPayoutPortalAccess(parsed.portal_token)
  if (!(await isVendorPayoutSetupOpen(access.orgId))) {
    throw new Error("This builder has not opened vendor payments yet")
  }
  const claim = await claimVendorCompany({
    portal_token: parsed.portal_token,
    vendor_entity_id: parsed.vendor_entity_id,
    legal_name: parsed.legal_name,
    dba_name: parsed.dba_name,
  })
  if (await adoptVerifiedRecipient({ vendorEntityId: claim.vendorEntityId, relationshipId: claim.relationshipId })) {
    return { url: null, vendorEntityId: claim.vendorEntityId, status: "ready" }
  }
  const onboarding = await createVendorRecipientOnboarding({
    vendor_entity_id: claim.vendorEntityId,
    return_path: parsed.return_path,
  })
  return { url: onboarding.url, vendorEntityId: claim.vendorEntityId, status: onboarding.status }
}

async function createVendorRecipientOnboarding(parsed: { vendor_entity_id: string; return_path: string }) {
  const portal = await getVendorPaymentPortalContext()
  if (!portal.identity || portal.identity.status !== "active") throw new Error("An active vendor identity is required")
  const entity = portal.entities.find((candidate) => candidate.id === parsed.vendor_entity_id)
  if (!entity || !["owner", "administrator"].includes(entity.role)) throw new Error("Vendor administrator access is required")
  // A usable account never reaches this function — `adoptVerifiedRecipient`
  // takes that path first. Re-entering the provider flow with one can therefore
  // only mean a payout-bank change, which stays gated on the reviewer model.
  if (entity.recipient?.status === "ready" && entity.recipient.payoutsEnabled) {
    throw new Error("Payout-bank changes are temporarily disabled until the independent reviewer model is approved")
  }

  const supabase = createServiceSupabaseClient()
  const provider = getPaymentRailProvider(DEFAULT_PROVIDER)
  const affectedOrgIds = [...new Set(portal.relationships.filter((relationship) => relationship.vendorEntityId === entity.id).map((relationship) => relationship.orgId))]
  const { data: entityRow, error: entityError } = await supabase.from("vendor_entities").select("id,legal_name").eq("id", entity.id).maybeSingle()
  if (entityError || !entityRow) throw new Error("Vendor entity was not found")
  let recipient = entity.recipient
  if (!recipient) {
    const snapshot = await provider.createRecipient({ vendorEntityId: entity.id, legalName: entityRow.legal_name, email: portal.identity.email, country: "US" })
    const { data, error } = await supabase.from("payment_recipient_accounts").insert({
      vendor_entity_id: entity.id,
      provider: snapshot.provider,
      provider_account_id: snapshot.providerAccountId,
      account_model: "express",
      status: snapshot.status,
      details_submitted: snapshot.detailsSubmitted,
      payouts_enabled: snapshot.payoutsEnabled,
      requirements_currently_due: snapshot.requirementsCurrentlyDue,
      requirements_eventually_due: snapshot.requirementsEventuallyDue,
      disabled_reason: snapshot.disabledReason,
      payout_bank_name: snapshot.bankName,
      payout_bank_last4: snapshot.bankLast4,
      last_provider_sync_at: new Date().toISOString(),
    }).select("id,provider,provider_account_id,status,payouts_enabled").single()
    if (error || !data) throw new Error(`Unable to save recipient account: ${error?.message}`)
    recipient = { id: data.id, provider: data.provider, status: data.status, payoutsEnabled: data.payouts_enabled, bankName: null, bankLast4: null }
  }

  // Every relationship for this entity points at its one recipient account,
  // including builders claimed after that account already existed. Linking only
  // on first creation used to strand those later relationships with a null
  // recipient, which no provider webhook could heal — `syncVendorRecipient`
  // finds relationships *by* recipient_account_id.
  const linkedRecipientId = recipient.id
  await Promise.all(affectedOrgIds.map((affectedOrgId) => supabase.from("vendor_payment_relationships")
    .update({ recipient_account_id: linkedRecipientId, status: "onboarding" })
    .eq("org_id", affectedOrgId)
    .eq("vendor_entity_id", entity.id)
    .in("status", ["invited", "claim_pending", "onboarding"])))

  const { data: recipientRow } = await supabase.from("payment_recipient_accounts").select("provider_account_id").eq("id", recipient.id).maybeSingle()
  if (!recipientRow) throw new Error("Recipient provider account was not found")
  const baseUrl = getAppBaseUrl()
  const returnUrl = new URL(parsed.return_path, baseUrl)
  returnUrl.searchParams.set("payments", "return")
  returnUrl.searchParams.set("entity", entity.id)
  // Stripe sends the vendor here when the onboarding link expires before they
  // finish. Pointing it at `/access` stranded them: that route is a workspace
  // router and reads neither parameter, so an expired link dead-ended at a list
  // of builders with no way back into verification. It belongs on the same page
  // that started the flow, which still has the button.
  const refreshUrl = new URL(parsed.return_path, baseUrl)
  refreshUrl.searchParams.set("payments", "refresh")
  refreshUrl.searchParams.set("entity", entity.id)
  const url = await provider.createRecipientOnboardingLink({ providerAccountId: recipientRow.provider_account_id, refreshUrl: refreshUrl.toString(), returnUrl: returnUrl.toString() })
  await Promise.all(affectedOrgIds.flatMap((affectedOrgId) => [
    recordEvent({ orgId: affectedOrgId, eventType: "vendor_recipient_onboarding_started", entityType: "payment_recipient_account", entityId: recipient.id, payload: { vendor_entity_id: entity.id } }),
    recordAudit({ orgId: affectedOrgId, action: "update", entityType: "payment_recipient_account", entityId: recipient.id, after: { status: recipient.status, onboarding_link_created: true }, source: "vendor_portal" }),
  ]))
  return { url, recipientId: recipient.id, status: recipient.status }
}

/**
 * Freeze a payout destination that just changed, and tell everyone it affects.
 *
 * The vendor entity owns one payout account, so the hold is global to that
 * account by construction — which is correct for the case it exists for: the
 * bank behind it genuinely changed for every builder at once. The window is the
 * longest any affected builder configured, because the most cautious org on a
 * shared destination sets the floor for the rest.
 *
 * The version bump is a compare-and-swap on the value just read, so two webhooks
 * racing the same account cannot both think they applied the first change.
 *
 * Nothing here carries a full account or routing number. The masked last four is
 * the same thing the settings screen already shows, and it is the whole point of
 * the notification — the person who knows the vendor's bank did not change has
 * to be able to recognise that it did.
 */
async function applyDestinationChangeHold(input: {
  recipientId: string
  vendorEntityId: string
  previousVersion: number
  previous: { bankName: string | null; bankLast4: string | null }
  next: { bankName: string | null; bankLast4: string | null }
  source: string
}) {
  const supabase = createServiceSupabaseClient()
  const relationships = await listRecipientRelationships(input.recipientId)
  const affectedOrgIds = [...new Set(relationships.map((relationship) => relationship.org_id))]
  const { data: policies } = affectedOrgIds.length > 0
    ? await supabase.from("payment_rail_policies").select("org_id,control_change_cooling_hours").in("org_id", affectedOrgIds)
    : { data: [] }
  const coolingHours = (policies ?? []).reduce(
    (longest, policy) => Math.max(longest, clampCoolingHours(policy.control_change_cooling_hours)),
    DEFAULT_DESTINATION_COOLING_HOURS,
  )
  const lockedUntil = new Date(Date.now() + coolingHours * 60 * 60 * 1000).toISOString()
  const { data: locked, error } = await supabase
    .from("payment_recipient_accounts")
    .update({ destination_locked_until: lockedUntil, destination_version: input.previousVersion + 1 })
    .eq("id", input.recipientId)
    .eq("destination_version", input.previousVersion)
    .select("id,destination_version,destination_locked_until")
    .maybeSingle()
  if (error) throw new Error(`Unable to hold the changed payout destination: ${error.message}`)
  // Lost the race to a concurrent change. The other writer applied its own hold,
  // so the destination is frozen either way and re-stamping would only shorten
  // or lengthen someone else's window.
  if (!locked) return null

  await Promise.all(affectedOrgIds.flatMap((orgId) => [
    recordEvent({
      orgId,
      eventType: "vendor_payout_destination_changed",
      entityType: "payment_recipient_account",
      entityId: input.recipientId,
      payload: {
        vendor_entity_id: input.vendorEntityId,
        destination_version: locked.destination_version,
        locked_until: lockedUntil,
        cooling_hours: coolingHours,
        previous_bank_last4: input.previous.bankLast4,
        bank_last4: input.next.bankLast4,
        bank_name: input.next.bankName,
        source: input.source,
      },
    }),
    recordAudit({
      orgId,
      action: "update",
      entityType: "payment_recipient_account",
      entityId: input.recipientId,
      before: { payout_bank_name: input.previous.bankName, payout_bank_last4: input.previous.bankLast4, destination_version: input.previousVersion },
      after: { payout_bank_name: input.next.bankName, payout_bank_last4: input.next.bankLast4, destination_version: locked.destination_version, destination_locked_until: lockedUntil },
      source: input.source,
    }),
  ]))

  await notifyVendorOfDestinationChange({
    vendorEntityId: input.vendorEntityId,
    bankLast4: input.next.bankLast4,
    lockedUntil,
  })
  return { lockedUntil, destinationVersion: locked.destination_version, affectedOrgIds }
}

/**
 * Tell the vendor's own administrators, out of band, that their payout bank
 * changed. If the change was not theirs this email is the only thing that
 * reaches them before the hold expires.
 */
async function notifyVendorOfDestinationChange(input: {
  vendorEntityId: string
  bankLast4: string | null
  lockedUntil: string
}) {
  const supabase = createServiceSupabaseClient()
  const { data: memberships } = await supabase
    .from("vendor_entity_memberships")
    .select("identity:vendor_portal_identities(email)")
    .eq("vendor_entity_id", input.vendorEntityId)
    .eq("status", "active")
    .in("role", ["owner", "administrator"])
    .limit(20)
  const recipients = [...new Set((memberships ?? []).flatMap((row) => {
    const identity = firstRelation(row.identity as { email?: string | null } | Array<{ email?: string | null }> | null)
    return identity?.email ? [identity.email] : []
  }))]
  if (recipients.length === 0) return
  const { data: entity } = await supabase.from("vendor_entities").select("legal_name").eq("id", input.vendorEntityId).maybeSingle()
  await sendVendorPayoutDestinationChangedEmail({
    to: recipients,
    vendorName: entity?.legal_name ?? "your company",
    bankLast4: input.bankLast4,
    holdUntil: input.lockedUntil,
  })
}

export async function syncVendorRecipient(
  providerAccountId: string,
  providerKey = DEFAULT_PROVIDER,
  auditSource = "stripe_webhook",
) {
  const provider = getPaymentRailProvider(providerKey)
  const snapshot = await provider.retrieveRecipient(providerAccountId)
  const supabase = createServiceSupabaseClient()
  // The destination as Arc last knew it, read before the sync overwrites it. A
  // provider-side bank swap — a vendor's compromised Stripe login is the whole
  // threat — arrives here as an ordinary `account.updated` and used to be
  // absorbed silently, so the next run paid the new bank with no hold and no
  // notification.
  const { data: priorRecipient } = await supabase
    .from("payment_recipient_accounts")
    .select("id,payout_bank_name,payout_bank_last4,destination_version")
    .eq("provider", providerKey)
    .eq("provider_account_id", providerAccountId)
    .maybeSingle()
  const { data: recipient, error } = await supabase.from("payment_recipient_accounts").update({
    status: snapshot.status,
    details_submitted: snapshot.detailsSubmitted,
    payouts_enabled: snapshot.payoutsEnabled,
    requirements_currently_due: snapshot.requirementsCurrentlyDue,
    requirements_eventually_due: snapshot.requirementsEventuallyDue,
    disabled_reason: snapshot.disabledReason,
    payout_bank_name: snapshot.bankName,
    payout_bank_last4: snapshot.bankLast4,
    last_provider_sync_at: new Date().toISOString(),
  }).eq("provider", providerKey).eq("provider_account_id", providerAccountId).select("id,vendor_entity_id,status").maybeSingle()
  if (error) throw new Error(`Unable to sync vendor recipient: ${error.message}`)
  if (!recipient) return null

  // Only an actual change of a destination Arc already knew. Onboarding filling
  // the bank in for the first time is not a change — that relationship is held
  // by `recently_claimed_vendor_relationship` instead.
  const previousBankLast4 = priorRecipient?.payout_bank_last4 ?? null
  const previousBankName = priorRecipient?.payout_bank_name ?? null
  const destinationChanged = Boolean(previousBankLast4)
    && (previousBankLast4 !== (snapshot.bankLast4 ?? null) || previousBankName !== (snapshot.bankName ?? null))
  if (destinationChanged) {
    await applyDestinationChangeHold({
      recipientId: recipient.id,
      vendorEntityId: recipient.vendor_entity_id,
      previousVersion: Number(priorRecipient?.destination_version ?? 0),
      previous: { bankName: previousBankName, bankLast4: previousBankLast4 },
      next: { bankName: snapshot.bankName ?? null, bankLast4: snapshot.bankLast4 ?? null },
      source: auditSource,
    })
  }

  const relationships = await listRecipientRelationships(recipient.id)
  const relationshipStatus = snapshot.status === "ready" && snapshot.payoutsEnabled ? "active" : "onboarding"
  await Promise.all(relationships.map(async (relationship) => {
    // A provider readiness sync is not authority to undo a builder's fraud
    // response. Suspended and revoked relationships stay blocked until a
    // builder explicitly restores them through setCompanyPaymentAccessStatus.
    // Without this predicate, any later account.updated webhook silently
    // reactivated a vendor the builder had deliberately cut off.
    if (relationship.status === "suspended" || relationship.status === "revoked") return null
    let update = supabase.from("vendor_payment_relationships")
      .update({ status: relationshipStatus })
      .eq("org_id", relationship.org_id)
      .eq("id", relationship.id)
      .in("status", ["invited", "claim_pending", "onboarding", "active"])
    if (relationshipStatus === "active") update = update.neq("status", "active")
    const { data: changed, error: updateError } = await update.select("id").maybeSingle()
    if (updateError) throw new Error(`Unable to update vendor payment relationship: ${updateError.message}`)
    // The audit trail records every sync; the EVENT only fires on a real
    // transition. Stripe re-sends `account.updated` for changes Arc does not
    // care about, and this event now carries an email — emitting it on every
    // delivery would mail the same "vendor is ready" notice indefinitely.
    await Promise.all([
      changed
        ? recordEvent({ orgId: relationship.org_id, eventType: "vendor_recipient_status_updated", entityType: "payment_recipient_account", entityId: recipient.id, payload: { status: snapshot.status, payouts_enabled: snapshot.payoutsEnabled, relationship_status: relationshipStatus, company_id: relationship.company_id } })
        : Promise.resolve(null),
      recordAudit({ orgId: relationship.org_id, action: "update", entityType: "payment_recipient_account", entityId: recipient.id, after: { status: snapshot.status, payouts_enabled: snapshot.payoutsEnabled }, source: auditSource }),
    ])
  }))
  return recipient
}

/**
 * Stripe redirects are user-controlled navigation and cannot be trusted as
 * proof that onboarding completed. Reconcile only after the active portal
 * identity is authorized for the requested vendor entity, then retrieve the
 * authoritative status from Stripe. This is a fallback for delayed/missing
 * webhooks, not a replacement for account.updated processing.
 */
export async function reconcileVendorRecipientAfterOnboarding(vendorEntityId: string) {
  const parsedEntityId = z.string().uuid().safeParse(vendorEntityId)
  if (!parsedEntityId.success) return null
  const entityId = parsedEntityId.data
  const portal = await getVendorPaymentPortalContext()
  if (!portal.identity || portal.identity.status !== "active") throw new Error("An active vendor identity is required")
  const entity = portal.entities.find((candidate) => candidate.id === entityId)
  if (!entity || !["owner", "administrator"].includes(entity.role)) throw new Error("Vendor administrator access is required")
  if (!entity.recipient) return null

  const supabase = createServiceSupabaseClient()
  const { data: recipient, error } = await supabase
    .from("payment_recipient_accounts")
    .select("provider,provider_account_id")
    .eq("id", entity.recipient.id)
    .eq("vendor_entity_id", entity.id)
    .maybeSingle()
  if (error) throw new Error(`Unable to load recipient account: ${error.message}`)
  if (!recipient) return null
  return syncVendorRecipient(recipient.provider_account_id, recipient.provider, "stripe_return")
}

export async function createOrgFundingSetup(orgId?: string) {
  const context = await requireOrgContext(orgId)
  await requirePermission("payment.manage_rail", context)
  const supabase = createServiceSupabaseClient()
  const provider = getPaymentRailProvider(DEFAULT_PROVIDER)
  let { data: providerAccount } = await supabase.from("org_payment_provider_accounts").select("id,provider_customer_id").eq("org_id", context.orgId).eq("provider", provider.key).maybeSingle()
  if (!providerAccount) {
    const { data: org } = await supabase.from("orgs").select("name,billing_email").eq("id", context.orgId).maybeSingle()
    if (!org) throw new Error("Organization was not found")
    const customerId = await provider.createFundingCustomer({ orgId: context.orgId, name: org.name, email: org.billing_email })
    const { data, error } = await supabase.from("org_payment_provider_accounts").insert({ org_id: context.orgId, provider: provider.key, provider_customer_id: customerId }).select("id,provider_customer_id").single()
    if (error || !data) throw new Error(`Unable to save payment provider customer: ${error?.message}`)
    providerAccount = data
  }
  return provider.createFundingSetup({ orgId: context.orgId, providerCustomerId: providerAccount.provider_customer_id })
}

export async function completeOrgFundingSetup(input: { providerSetupId: string }, orgId?: string) {
  const parsed = z.object({ providerSetupId: z.string().trim().min(3).max(255) }).parse(input)
  const context = await requireOrgContext(orgId)
  await requirePermission("payment.manage_rail", context)
  const supabase = createServiceSupabaseClient()
  const provider = getPaymentRailProvider(DEFAULT_PROVIDER)
  const snapshot = await provider.retrieveFundingSource({ providerSetupId: parsed.providerSetupId })
  const { data: providerAccount } = await supabase.from("org_payment_provider_accounts").select("provider_customer_id").eq("org_id", context.orgId).eq("provider", provider.key).maybeSingle()
  if (!providerAccount || providerAccount.provider_customer_id !== snapshot.providerCustomerId) throw new Error("Funding setup does not belong to this organization")
  const { data: policy } = await supabase.from("payment_rail_policies").select("control_change_cooling_hours").eq("org_id", context.orgId).maybeSingle()
  const coolingHours = Number(policy?.control_change_cooling_hours ?? 72)
  const applyAfter = new Date(Date.now() + coolingHours * 60 * 60 * 1000).toISOString()
  const { data, error } = await supabase.rpc("create_funding_source_change_atomic", {
    p_org_id: context.orgId,
    p_requested_by: context.userId,
    p_provider: snapshot.provider,
    p_provider_customer_id: snapshot.providerCustomerId,
    p_provider_payment_method_id: snapshot.providerPaymentMethodId,
    p_provider_mandate_id: snapshot.providerMandateId,
    p_bank_name: snapshot.bankName,
    p_account_holder_type: snapshot.accountHolderType,
    p_account_type: snapshot.accountType,
    p_last4: snapshot.last4,
    p_fingerprint: snapshot.fingerprint,
    p_mandate_status: snapshot.mandateStatus,
    p_verification_status: snapshot.verificationStatus,
    p_provider_reference: parsed.providerSetupId,
    p_apply_after: applyAfter,
  })
  if (error || !data || typeof data !== "object" || Array.isArray(data)) throw new Error(`Unable to create funding-source review: ${error?.message ?? "Atomic write failed"}`)
  const fundingSourceId = Reflect.get(data, "funding_source_id")
  const changeRequestId = Reflect.get(data, "change_request_id")
  const resultApplyAfter = Reflect.get(data, "apply_after")
  const duplicate = Reflect.get(data, "duplicate") === true
  if (typeof fundingSourceId !== "string" || typeof changeRequestId !== "string" || typeof resultApplyAfter !== "string") {
    throw new Error("Funding-source review returned an invalid result")
  }
  if (duplicate) return { fundingSourceId, changeRequestId, applyAfter: resultApplyAfter }
  await Promise.all([
    recordEvent({ orgId: context.orgId, actorId: context.userId, eventType: "funding_source_review_requested", entityType: "payment_control_change", entityId: changeRequestId, payload: { funding_source_id: fundingSourceId, apply_after: resultApplyAfter } }),
    recordAudit({ orgId: context.orgId, actorId: context.userId, action: "insert", entityType: "org_funding_source", entityId: fundingSourceId, after: { status: "pending_approval", bank_name: snapshot.bankName, last4: snapshot.last4, apply_after: resultApplyAfter } }),
  ])
  return { fundingSourceId, changeRequestId, applyAfter: resultApplyAfter }
}

export async function decidePaymentControlChange(input: { changeRequestId: string; decision: "approved" | "rejected"; reason?: string }, orgId?: string) {
  const parsed = z.object({
    changeRequestId: z.string().uuid(),
    decision: z.enum(["approved", "rejected"]),
    reason: z.string().trim().min(8).max(1000).optional(),
  }).superRefine((value, refinement) => {
    if (value.decision === "rejected" && !value.reason) refinement.addIssue({ code: z.ZodIssueCode.custom, path: ["reason"], message: "A rejection reason is required" })
  }).parse(input)
  const context = await requireOrgContext(orgId)
  await requirePermission("payment.approve_run", context)
  const stepUpVerifiedAt = await requireRecentPaymentStepUp()
  const supabase = createServiceSupabaseClient()
  const { data, error } = await supabase.rpc("decide_payment_control_change_atomic", {
    p_org_id: context.orgId,
    p_change_request_id: parsed.changeRequestId,
    p_actor_user_id: context.userId,
    p_decision: parsed.decision,
    p_reason: parsed.reason ?? null,
    p_step_up_verified_at: stepUpVerifiedAt,
  })
  if (error || !data || typeof data !== "object" || Array.isArray(data)) throw new Error(`Unable to record control approval: ${error?.message ?? "Atomic decision failed"}`)
  const status = Reflect.get(data, "status")
  const approvalId = Reflect.get(data, "approval_id")
  const fundingSourceId = Reflect.get(data, "funding_source_id")
  if (typeof status !== "string" || typeof approvalId !== "string") throw new Error("Payment control decision returned an invalid result")
  await Promise.all([
    recordEvent({ orgId: context.orgId, actorId: context.userId, eventType: `funding_source_change_${parsed.decision}`, entityType: "payment_control_change", entityId: parsed.changeRequestId, payload: { funding_source_id: fundingSourceId, status } }),
    recordAudit({ orgId: context.orgId, actorId: context.userId, action: "insert", entityType: "payment_control_change_approval", entityId: approvalId, after: { change_request_id: parsed.changeRequestId, decision: parsed.decision, status } }),
  ])
  return data
}

export async function activateMaturedFundingSourceChanges(now = new Date()) {
  const supabase = createServiceSupabaseClient()
  const nowIso = now.toISOString()
  const { data: changes, error } = await supabase.from("payment_control_change_requests").select("id,org_id,funding_source_id").eq("kind", "org_funding_source").eq("status", "cooling_off").lte("apply_after", nowIso).limit(100)
  if (error) throw new Error(`Unable to load matured funding changes: ${error.message}`)
  let activated = 0
  let failed = 0
  for (const change of changes ?? []) {
    if (!change.org_id || !change.funding_source_id) continue
    const { error: activationError } = await supabase.rpc("activate_matured_funding_change_atomic", {
      p_org_id: change.org_id,
      p_change_request_id: change.id,
      p_now: nowIso,
    })
    if (activationError) {
      failed += 1
      await recordEvent({ orgId: change.org_id, eventType: "funding_source_activation_failed", entityType: "org_funding_source", entityId: change.funding_source_id, payload: { error: activationError.message } })
      continue
    }
    activated += 1
    await Promise.all([
      recordEvent({ orgId: change.org_id, eventType: "funding_source_activated", entityType: "org_funding_source", entityId: change.funding_source_id }),
      recordAudit({ orgId: change.org_id, action: "update", entityType: "org_funding_source", entityId: change.funding_source_id, before: { status: "cooling_off" }, after: { status: "active", is_default: true }, source: "cron" }),
    ])
  }
  return { activated, failed }
}
