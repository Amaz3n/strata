import type { SupabaseClient } from "@supabase/supabase-js"

import { z } from "zod"

import { parseVpoApprovalBands } from "@/lib/financials/vpo-approval-thresholds"
import { createServiceSupabaseClient } from "@/lib/supabase/server"
import { recordAudit } from "@/lib/services/audit"
import { requireAuthorization } from "@/lib/services/authorization"
import { requireOrgContext } from "@/lib/services/context"
import { recordEvent } from "@/lib/services/events"
import {
  MAX_VARIANCE_REASON_CODES,
  purchasingSettingsUpdateSchema,
  varianceReasonCodeSchema,
  type PurchasingSettingsUpdate,
  type VarianceReasonCodeInput,
} from "@/lib/validation/purchasing-settings"

const DEFAULT_REASON_CODES = [
  ["missed_scope", "Missed scope / estimating omission"],
  ["plan_error", "Plan/spec error"],
  ["damage_theft", "Damage or theft"],
  ["selection_after_cutoff", "Selection after cutoff"],
  ["site_condition", "Unforeseen site condition"],
  ["back_charge", "Trade back-charge"],
  ["winter_condition", "Winter/weather condition"],
  ["code_required", "Inspection/code requirement"],
  ["price_increase", "Vendor price increase"],
  ["quantity_overrun", "Quantity overrun"],
  ["warranty_rework", "Warranty/rework"],
  ["other", "Other"],
] as const

export const DEFAULT_EXPIRING_AGREEMENT_LEAD_DAYS = 30
/** Cost evidence is required from the first approval band's limit upward. */
export const DEFAULT_VPO_EVIDENCE_REQUIRED_OVER_CENTS = 100_000

export type PurchasingSettings = {
  org_id: string
  pay_on_po_enabled: boolean
  po_completion_requires_verification: boolean
  po_completion_requires_inspection: boolean
  vpo_reason_code_required: boolean
  /** Null: never required for ordinary variance orders; 0: always. A back-charge always needs evidence. */
  vpo_evidence_required_over_cents: number | null
  vpo_approval_thresholds: ReturnType<typeof parseVpoApprovalBands>
  expiring_agreement_lead_days: number
}

export type VarianceReasonCode = {
  id: string
  code: string
  label: string
  description: string | null
  is_active: boolean
  is_backcharge: boolean
  sort_order: number
}

async function seedReasonCodes(orgId: string) {
  const { error } = await createServiceSupabaseClient().from("variance_reason_codes").upsert(
    DEFAULT_REASON_CODES.map(([code, label], index) => ({
      org_id: orgId,
      code,
      label,
      is_backcharge: code === "back_charge",
      sort_order: index,
    })),
    { onConflict: "org_id,code", ignoreDuplicates: true },
  )
  if (error) throw new Error(`Failed to initialize variance reasons: ${error.message}`)
}

function mapSettings(orgId: string, data: Record<string, unknown> | null): PurchasingSettings {
  return {
    org_id: orgId,
    pay_on_po_enabled: data?.pay_on_po_enabled === true,
    po_completion_requires_verification: data?.po_completion_requires_verification !== false,
    po_completion_requires_inspection: data?.po_completion_requires_inspection === true,
    vpo_reason_code_required: data?.vpo_reason_code_required !== false,
    vpo_evidence_required_over_cents: data && "vpo_evidence_required_over_cents" in data
      ? (typeof data.vpo_evidence_required_over_cents === "number" ? data.vpo_evidence_required_over_cents : null)
      : DEFAULT_VPO_EVIDENCE_REQUIRED_OVER_CENTS,
    vpo_approval_thresholds: parseVpoApprovalBands(data?.vpo_approval_thresholds),
    expiring_agreement_lead_days: typeof data?.expiring_agreement_lead_days === "number"
      ? data.expiring_agreement_lead_days
      : DEFAULT_EXPIRING_AGREEMENT_LEAD_DAYS,
  }
}

/** An org that never saved settings runs on the defaults; reading does not create a row. */
export async function getPurchasingSettings(orgId?: string): Promise<PurchasingSettings> {
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  await requireAuthorization({ permission: "price_book.read", userId, orgId: resolvedOrgId, supabase })
  const { data, error } = await supabase.from("purchasing_settings").select("*").eq("org_id", resolvedOrgId).maybeSingle()
  if (error) throw new Error(`Failed to load purchasing settings: ${error.message}`)
  return mapSettings(resolvedOrgId, data)
}

export async function updatePurchasingSettings(input: PurchasingSettingsUpdate, orgId?: string): Promise<PurchasingSettings> {
  const parsed = purchasingSettingsUpdateSchema.parse(input)
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  await requireAuthorization({ permission: "purchasing_settings.write", userId, orgId: resolvedOrgId, supabase, logDecision: true, resourceType: "purchasing_settings", resourceId: resolvedOrgId })
  const service = createServiceSupabaseClient()
  const { data: current, error: readError } = await service.from("purchasing_settings").select("*").eq("org_id", resolvedOrgId).maybeSingle()
  if (readError) throw new Error(`Failed to load purchasing settings: ${readError.message}`)
  const before = mapSettings(resolvedOrgId, current)
  const next = { ...before, ...parsed }
  const { error } = await service.from("purchasing_settings").upsert({
    org_id: resolvedOrgId,
    pay_on_po_enabled: next.pay_on_po_enabled,
    po_completion_requires_verification: next.po_completion_requires_verification,
    po_completion_requires_inspection: next.po_completion_requires_inspection,
    vpo_reason_code_required: next.vpo_reason_code_required,
    vpo_evidence_required_over_cents: next.vpo_evidence_required_over_cents,
    vpo_approval_thresholds: next.vpo_approval_thresholds,
    expiring_agreement_lead_days: next.expiring_agreement_lead_days,
  }, { onConflict: "org_id" })
  if (error) throw new Error(`Failed to save purchasing settings: ${error.message}`)
  await Promise.all([
    seedReasonCodes(resolvedOrgId),
    recordEvent({ orgId: resolvedOrgId, actorId: userId, eventType: "purchasing_settings.updated", entityType: "purchasing_settings", entityId: resolvedOrgId, payload: { changed: Object.keys(parsed) } }),
  ])
  await recordAudit({ orgId: resolvedOrgId, actorId: userId, action: current ? "update" : "insert", entityType: "purchasing_settings", entityId: resolvedOrgId, before: { ...before }, after: { ...next }, critical: true })
  return next
}

/**
 * Whether pay-on-PO applies to a home, and whether its completions need a
 * verification step. The community's own flag wins over the org default. Payment
 * holds and completion creation both ask this, so they cannot disagree.
 */
export async function resolvePayOnPo(client: SupabaseClient, orgId: string, projectId: string) {
  const [{ data: lot, error: lotError }, { data: settings, error: settingsError }] = await Promise.all([
    client.from("lots").select("community:communities(pay_on_po_enabled)").eq("org_id", orgId).eq("project_id", projectId).limit(1).maybeSingle(),
    client.from("purchasing_settings").select("pay_on_po_enabled,po_completion_requires_verification").eq("org_id", orgId).maybeSingle(),
  ])
  if (lotError) throw new Error(`Failed to resolve the lot's pay-on-PO setting: ${lotError.message}`)
  if (settingsError) throw new Error(`Failed to resolve purchasing settings: ${settingsError.message}`)
  const community = Array.isArray(lot?.community) ? lot.community[0] : lot?.community
  return {
    enabled: community?.pay_on_po_enabled ?? settings?.pay_on_po_enabled ?? false,
    requiresVerification: settings?.po_completion_requires_verification ?? true,
  }
}

/**
 * The lead-day setting on its own, read with a client the caller has already
 * authorized. PO generation needs it to warn about agreements about to lapse and
 * must not inherit `price_book.read` from the full settings reader to get it.
 */
export async function getExpiringAgreementLeadDays(supabase: SupabaseClient, orgId: string): Promise<number> {
  const { data, error } = await supabase.from("purchasing_settings")
    .select("expiring_agreement_lead_days").eq("org_id", orgId).maybeSingle()
  if (error) throw new Error(`Failed to load purchasing settings: ${error.message}`)
  return data?.expiring_agreement_lead_days ?? DEFAULT_EXPIRING_AGREEMENT_LEAD_DAYS
}

export async function listVarianceReasonCodes({
  orgId,
  includeInactive = false,
}: { orgId?: string; includeInactive?: boolean } = {}): Promise<VarianceReasonCode[]> {
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  await requireAuthorization({ permission: "vpo.request", userId, orgId: resolvedOrgId, supabase })
  const load = async () => {
    const { data, error } = await supabase.from("variance_reason_codes")
      .select("id, code, label, description, is_active, is_backcharge, sort_order")
      .eq("org_id", resolvedOrgId)
      .order("sort_order").order("label").limit(MAX_VARIANCE_REASON_CODES)
    if (error) throw new Error(`Failed to load variance reasons: ${error.message}`)
    return data ?? []
  }
  let rows = await load()
  if (rows.length === 0) {
    await seedReasonCodes(resolvedOrgId)
    rows = await load()
  }
  return includeInactive ? rows : rows.filter((row) => row.is_active)
}

export async function upsertVarianceReasonCode(input: VarianceReasonCodeInput, orgId?: string): Promise<VarianceReasonCode> {
  const parsed = varianceReasonCodeSchema.parse(input)
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  await requireAuthorization({ permission: "purchasing_settings.write", userId, orgId: resolvedOrgId, supabase, logDecision: true, resourceType: "variance_reason_code", resourceId: parsed.id })
  const service = createServiceSupabaseClient()
  const { data: all, error: listError } = await service.from("variance_reason_codes")
    .select("id, code, label, description, is_active, is_backcharge, sort_order").eq("org_id", resolvedOrgId).limit(MAX_VARIANCE_REASON_CODES + 1)
  if (listError) throw new Error(`Failed to load variance reasons: ${listError.message}`)
  const existing = parsed.id ? (all ?? []).find((row) => row.id === parsed.id) ?? null : null
  if (parsed.id && !existing) throw new Error("Variance reason not found.")
  if (!existing && (all ?? []).length >= MAX_VARIANCE_REASON_CODES) throw new Error(`An organization can keep at most ${MAX_VARIANCE_REASON_CODES} variance reasons. Retire one first.`)
  if ((all ?? []).some((row) => row.code === parsed.code && row.id !== parsed.id)) throw new Error("A variance reason with this code already exists.")
  if (existing && existing.code !== parsed.code) throw new Error("A variance reason's code cannot change; retire it and add a new one.")
  if (existing && existing.is_backcharge !== parsed.is_backcharge) {
    // The flag decides the approval band and the sign of the order, so it cannot move under live orders.
    const { count, error: usedError } = await service.from("commitment_change_orders")
      .select("id", { count: "exact", head: true }).eq("org_id", resolvedOrgId).eq("reason_code_id", existing.id)
    if (usedError) throw new Error(`Failed to check reason usage: ${usedError.message}`)
    if ((count ?? 0) > 0) throw new Error("Variance orders already use this reason, so its back-charge setting cannot change.")
  }
  const payload = {
    org_id: resolvedOrgId,
    code: parsed.code,
    label: parsed.label,
    description: parsed.description ?? null,
    is_backcharge: parsed.is_backcharge,
    ...(existing ? {} : { sort_order: (all ?? []).reduce((max, row) => Math.max(max, row.sort_order), -1) + 1 }),
  }
  const query = existing
    ? service.from("variance_reason_codes").update(payload).eq("org_id", resolvedOrgId).eq("id", existing.id)
    : service.from("variance_reason_codes").insert(payload)
  const { data, error } = await query.select("id, code, label, description, is_active, is_backcharge, sort_order").single()
  if (error || !data) throw new Error(`Failed to save variance reason: ${error?.message}`)
  await Promise.all([
    recordEvent({ orgId: resolvedOrgId, actorId: userId, eventType: "purchasing_settings.updated", entityType: "variance_reason_code", entityId: data.id, payload: { code: data.code } }),
    recordAudit({ orgId: resolvedOrgId, actorId: userId, action: existing ? "update" : "insert", entityType: "variance_reason_code", entityId: data.id, before: existing ? { ...existing } : null, after: { ...data }, critical: true }),
  ])
  return data
}

export async function setVarianceReasonCodeActive(reasonCodeId: string, isActive: boolean, orgId?: string): Promise<void> {
  const id = z.string().uuid().parse(reasonCodeId)
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  await requireAuthorization({ permission: "purchasing_settings.write", userId, orgId: resolvedOrgId, supabase, logDecision: true, resourceType: "variance_reason_code", resourceId: id })
  const { data, error } = await createServiceSupabaseClient().from("variance_reason_codes")
    .update({ is_active: isActive }).eq("org_id", resolvedOrgId).eq("id", id).select("id, code").maybeSingle()
  if (error) throw new Error(`Failed to update variance reason: ${error.message}`)
  if (!data) throw new Error("Variance reason not found.")
  await Promise.all([
    recordEvent({ orgId: resolvedOrgId, actorId: userId, eventType: "purchasing_settings.updated", entityType: "variance_reason_code", entityId: id, payload: { code: data.code, is_active: isActive } }),
    recordAudit({ orgId: resolvedOrgId, actorId: userId, action: "update", entityType: "variance_reason_code", entityId: id, after: { is_active: isActive }, critical: true }),
  ])
}
