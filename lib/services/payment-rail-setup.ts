import "server-only"

import { z } from "zod"

import { getAppBaseUrl } from "@/lib/integrations/payments/stripe"
import { getPaymentRailProvider } from "@/lib/integrations/payments/payment-rail-registry"
import { recordAudit } from "@/lib/services/audit"
import { requireOrgContext } from "@/lib/services/context"
import { recordEvent } from "@/lib/services/events"
import { hasPermission, requirePermission } from "@/lib/services/permissions"
import { requireRecentPaymentStepUp } from "@/lib/services/payment-step-up"
import {
  getPaymentApprovalRouting,
  listPaymentApproverCandidates,
  type PaymentRunApprover,
} from "@/lib/services/payment-approvers"
import { claimVendorCompany, getVendorPaymentPortalContext } from "@/lib/services/vendor-payment-identities"
import { createServiceSupabaseClient } from "@/lib/supabase/server"
import {
  startVendorPayoutSetupSchema,
  updatePaymentRailPolicySchema,
  type StartVendorPayoutSetupInput,
  type UpdatePaymentRailPolicyInput,
} from "@/lib/validation/fintech-payments"

const DEFAULT_PROVIDER = "stripe"

function jsonString(value: unknown, key: string) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  const candidate = Reflect.get(value, key)
  return typeof candidate === "string" ? candidate : null
}

async function listRecipientRelationships(recipientAccountId: string) {
  const supabase = createServiceSupabaseClient()
  const pageSize = 500
  const rows: Array<{ id: string; org_id: string }> = []
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await supabase.from("vendor_payment_relationships")
      .select("id,org_id")
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
    coolingHours: number
    perPaymentLimitCents: number | null
    perRunLimitCents: number | null
    dailyLimitCents: number | null
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
  }
  canManage: boolean
  canApprove: boolean
}

export async function getPaymentRailSettings(orgId?: string): Promise<PaymentRailSettings> {
  const context = await requireOrgContext(orgId)
  await requirePermission("payment.release", context)
  const supabase = createServiceSupabaseClient()
  const [{ data: policy }, { data: fundingSources }, { data: changes }, canManage, canApprove] = await Promise.all([
    supabase.from("payment_rail_policies").select("enabled,approval_mode,control_change_cooling_hours,per_payment_limit_cents,per_run_limit_cents,daily_limit_cents,waiver_jurisdiction").eq("org_id", context.orgId).maybeSingle(),
    supabase.from("org_funding_sources").select("id,provider,bank_name,last4,verification_status,status,is_default,usable_after").eq("org_id", context.orgId).order("created_at", { ascending: false }).limit(20),
    supabase.from("payment_control_change_requests").select("id,funding_source_id,requested_by_user_id,status,required_approvals,apply_after,proposed_masked_details").eq("org_id", context.orgId).eq("kind", "org_funding_source").in("status", ["pending_approval", "cooling_off"]).order("created_at", { ascending: false }).limit(20),
    hasPermission("payments.manage_rail", context),
    hasPermission("payments.approve_run", context),
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
      coolingHours: Number(policy?.control_change_cooling_hours ?? 72),
      perPaymentLimitCents: policy?.per_payment_limit_cents == null ? null : Number(policy.per_payment_limit_cents),
      perRunLimitCents: policy?.per_run_limit_cents == null ? null : Number(policy.per_run_limit_cents),
      dailyLimitCents: policy?.daily_limit_cents == null ? null : Number(policy.daily_limit_cents),
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
    },
    canManage,
    canApprove,
  }
}

export async function updatePaymentRailPolicy(input: UpdatePaymentRailPolicyInput, orgId?: string) {
  const parsed = updatePaymentRailPolicySchema.parse(input)
  const context = await requireOrgContext(orgId)
  await requirePermission("payments.manage_rail", context)
  const supabase = createServiceSupabaseClient()
  const { data: existing } = await supabase.from("payment_rail_policies").select("id,enabled,approval_mode").eq("org_id", context.orgId).maybeSingle()
  if (parsed.enabled) {
    const { count } = await supabase.from("org_funding_sources").select("id", { count: "exact", head: true }).eq("org_id", context.orgId).eq("status", "active")
    if (!count) throw new Error("Approve and activate a funding source before enabling electronic payments")
  }
  const payload = {
    org_id: context.orgId,
    ...parsed,
    requester_may_approve: false,
    require_dual_for_control_changes: true,
    waiver_jurisdiction: "FL",
    updated_by: context.userId,
    ...(!existing ? { created_by: context.userId } : {}),
  }
  const { data, error } = await supabase.from("payment_rail_policies").upsert(payload, { onConflict: "org_id" }).select("id,enabled,approval_mode").single()
  if (error || !data) throw new Error(`Unable to save payment policy: ${error?.message}`)
  await Promise.all([
    recordEvent({ orgId: context.orgId, actorId: context.userId, eventType: "payment_rail_policy_updated", entityType: "payment_rail_policy", entityId: data.id, payload: { enabled: data.enabled, approval_mode: data.approval_mode } }),
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
    .select("id,org_id")
    .single()
  if (error || !relationship) throw new Error(`Unable to link the verified payout account: ${error?.message}`)
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
  const refreshUrl = new URL(`/access?payments=refresh&entity=${entity.id}`, baseUrl).toString()
  const url = await provider.createRecipientOnboardingLink({ providerAccountId: recipientRow.provider_account_id, refreshUrl, returnUrl: returnUrl.toString() })
  await Promise.all(affectedOrgIds.flatMap((affectedOrgId) => [
    recordEvent({ orgId: affectedOrgId, eventType: "vendor_recipient_onboarding_started", entityType: "payment_recipient_account", entityId: recipient.id, payload: { vendor_entity_id: entity.id } }),
    recordAudit({ orgId: affectedOrgId, action: "update", entityType: "payment_recipient_account", entityId: recipient.id, after: { status: recipient.status, onboarding_link_created: true }, source: "vendor_portal" }),
  ]))
  return { url, recipientId: recipient.id, status: recipient.status }
}

export async function syncVendorRecipient(
  providerAccountId: string,
  providerKey = DEFAULT_PROVIDER,
  auditSource = "stripe_webhook",
) {
  const provider = getPaymentRailProvider(providerKey)
  const snapshot = await provider.retrieveRecipient(providerAccountId)
  const supabase = createServiceSupabaseClient()
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
  const relationships = await listRecipientRelationships(recipient.id)
  const relationshipStatus = snapshot.status === "ready" ? "active" : "onboarding"
  await Promise.all(relationships.flatMap((relationship) => [
    supabase.from("vendor_payment_relationships")
      .update({ status: relationshipStatus })
      .eq("org_id", relationship.org_id)
      .eq("id", relationship.id),
    recordEvent({ orgId: relationship.org_id, eventType: "vendor_recipient_status_updated", entityType: "payment_recipient_account", entityId: recipient.id, payload: { status: snapshot.status, payouts_enabled: snapshot.payoutsEnabled } }),
    recordAudit({ orgId: relationship.org_id, action: "update", entityType: "payment_recipient_account", entityId: recipient.id, after: { status: snapshot.status, payouts_enabled: snapshot.payoutsEnabled }, source: auditSource }),
  ]))
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
  await requirePermission("payments.manage_rail", context)
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
  await requirePermission("payments.manage_rail", context)
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
  await requirePermission("payments.approve_run", context)
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
