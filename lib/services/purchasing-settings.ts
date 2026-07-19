import type { SupabaseClient } from "@supabase/supabase-js"

import { DEFAULT_VPO_APPROVAL_BANDS, parseVpoApprovalBands } from "@/lib/financials/vpo-approval-thresholds"
import { requireOrgContext } from "@/lib/services/context"
import { requireAuthorization } from "@/lib/services/authorization"

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

export type PurchasingSettings = {
  org_id: string
  pay_on_po_enabled: boolean
  po_completion_requires_verification: boolean
  vpo_reason_code_required: boolean
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

async function ensureDefaults(supabase: SupabaseClient, orgId: string) {
  const { error: settingsError } = await supabase.from("purchasing_settings").upsert({
    org_id: orgId,
    vpo_approval_thresholds: DEFAULT_VPO_APPROVAL_BANDS,
  }, { onConflict: "org_id", ignoreDuplicates: true })
  if (settingsError) throw new Error(`Failed to initialize purchasing settings: ${settingsError.message}`)

  const { error: reasonsError } = await supabase.from("variance_reason_codes").upsert(
    DEFAULT_REASON_CODES.map(([code, label], index) => ({
      org_id: orgId,
      code,
      label,
      is_backcharge: code === "back_charge",
      sort_order: index,
    })),
    { onConflict: "org_id,code", ignoreDuplicates: true },
  )
  if (reasonsError) throw new Error(`Failed to initialize variance reasons: ${reasonsError.message}`)
}

export async function getPurchasingSettings(orgId?: string): Promise<PurchasingSettings> {
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  await requireAuthorization({ permission: "price_book.read", userId, orgId: resolvedOrgId, supabase })
  await ensureDefaults(supabase, resolvedOrgId)
  const { data, error } = await supabase.from("purchasing_settings").select("*").eq("org_id", resolvedOrgId).single()
  if (error || !data) throw new Error(`Failed to load purchasing settings: ${error?.message}`)
  return {
    org_id: resolvedOrgId,
    pay_on_po_enabled: data.pay_on_po_enabled ?? false,
    po_completion_requires_verification: data.po_completion_requires_verification ?? true,
    vpo_reason_code_required: data.vpo_reason_code_required ?? true,
    vpo_approval_thresholds: parseVpoApprovalBands(data.vpo_approval_thresholds),
    expiring_agreement_lead_days: data.expiring_agreement_lead_days ?? 30,
  }
}

export async function listVarianceReasonCodes({
  orgId,
  includeInactive = false,
}: { orgId?: string; includeInactive?: boolean } = {}): Promise<VarianceReasonCode[]> {
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  await requireAuthorization({ permission: "vpo.request", userId, orgId: resolvedOrgId, supabase })
  await ensureDefaults(supabase, resolvedOrgId)
  let query = supabase.from("variance_reason_codes")
    .select("id, code, label, description, is_active, is_backcharge, sort_order")
    .eq("org_id", resolvedOrgId)
    .order("sort_order").order("label")
  if (!includeInactive) query = query.eq("is_active", true)
  const { data, error } = await query
  if (error) throw new Error(`Failed to load variance reasons: ${error.message}`)
  return data ?? []
}
