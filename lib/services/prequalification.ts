import type { SupabaseClient } from "@supabase/supabase-js"

import { recordAudit } from "@/lib/services/audit"
import { requireOrgContext } from "@/lib/services/context"
import { recordEvent } from "@/lib/services/events"
import { requireAnyPermission, requirePermission } from "@/lib/services/permissions"
import { prequalificationReviewSchema, prequalificationSubmissionSchema } from "@/lib/validation/prequalification"
import { getComplianceRules } from "@/lib/services/compliance"

const SELECT = "id, org_id, company_id, status, requested_by, requested_at, submitted_at, reviewed_by, reviewed_at, expires_at, single_project_limit_cents, aggregate_limit_cents, emr, bonding_single_cents, bonding_aggregate_cents, years_in_business, annual_revenue_cents, largest_project_cents, trades, references_data, questionnaire, review_notes, portal_token_id, created_at, updated_at"

export type Prequalification = {
  id: string
  org_id: string
  company_id: string
  status: "requested" | "submitted" | "under_review" | "approved" | "approved_with_limits" | "declined" | "expired"
  requested_by: string | null
  requested_at: string
  submitted_at: string | null
  reviewed_by: string | null
  reviewed_at: string | null
  expires_at: string | null
  single_project_limit_cents: number | null
  aggregate_limit_cents: number | null
  emr: number | null
  bonding_single_cents: number | null
  bonding_aggregate_cents: number | null
  years_in_business: number | null
  annual_revenue_cents: number | null
  largest_project_cents: number | null
  trades: string[] | null
  references_data: Array<Record<string, unknown>>
  questionnaire: Record<string, unknown>
  review_notes: string | null
  portal_token_id: string | null
  created_at: string
  updated_at: string
}

function defaultExpiryDate(validityDays = 365) {
  const date = new Date()
  date.setUTCDate(date.getUTCDate() + validityDays)
  return date.toISOString().slice(0, 10)
}

export async function getLatestPrequalificationWithClient(supabase: SupabaseClient, orgId: string, companyId: string): Promise<Prequalification | null> {
  const { data, error } = await supabase.from("prequalifications").select(SELECT).eq("org_id", orgId).eq("company_id", companyId).order("created_at", { ascending: false }).limit(1).maybeSingle()
  if (error) throw new Error(`Failed to load prequalification: ${error.message}`)
  return data as Prequalification | null
}

export async function getLatestPrequalification(companyId: string, orgId?: string) {
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  await requireAnyPermission(["org.member", "directory.read", "directory.write"], { supabase, orgId: resolvedOrgId, userId })
  return getLatestPrequalificationWithClient(supabase, resolvedOrgId, companyId)
}

export async function requestPrequalification(companyId: string, orgId?: string): Promise<Prequalification> {
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  await requireAnyPermission(["directory.write", "prequal.review"], { supabase, orgId: resolvedOrgId, userId })
  const { data: company } = await supabase.from("companies").select("id").eq("org_id", resolvedOrgId).eq("id", companyId).maybeSingle()
  if (!company) throw new Error("Company not found")
  const latest = await getLatestPrequalificationWithClient(supabase, resolvedOrgId, companyId)
  if (latest && ["requested", "submitted", "under_review"].includes(latest.status)) return latest
  const { data, error } = await supabase.from("prequalifications").insert({ org_id: resolvedOrgId, company_id: companyId, status: "requested", requested_by: userId }).select(SELECT).single()
  if (error || !data) throw new Error(`Failed to request prequalification: ${error?.message}`)
  await recordAudit({ orgId: resolvedOrgId, actorId: userId, action: "insert", entityType: "prequalification", entityId: data.id, after: data })
  return data as Prequalification
}

export async function submitPrequalificationFromPortal(args: { supabase: SupabaseClient; orgId: string; companyId: string; portalTokenId: string; input: unknown }): Promise<Prequalification> {
  const parsed = prequalificationSubmissionSchema.parse(args.input)
  const latest = await getLatestPrequalificationWithClient(args.supabase, args.orgId, args.companyId)
  if (!latest || !["requested", "submitted"].includes(latest.status)) throw new Error("No open prequalification request")
  const now = new Date().toISOString()
  const { data, error } = await args.supabase.from("prequalifications").update({ ...parsed, status: "under_review", submitted_at: now, portal_token_id: args.portalTokenId }).eq("org_id", args.orgId).eq("id", latest.id).select(SELECT).single()
  if (error || !data) throw new Error(`Failed to submit prequalification: ${error?.message}`)
  await recordEvent({ orgId: args.orgId, eventType: "prequalification.submitted", entityType: "prequalification", entityId: latest.id, channel: "notification", payload: { company_id: args.companyId, requested_by: latest.requested_by } })
  return data as Prequalification
}

export async function reviewPrequalification(prequalificationId: string, input: unknown, orgId?: string): Promise<Prequalification> {
  const parsed = prequalificationReviewSchema.parse(input)
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  await requirePermission("prequal.review", { supabase, orgId: resolvedOrgId, userId })
  const { data: existing } = await supabase.from("prequalifications").select(SELECT).eq("org_id", resolvedOrgId).eq("id", prequalificationId).maybeSingle()
  if (!existing) throw new Error("Prequalification not found")
  if (!["submitted", "under_review"].includes(existing.status)) throw new Error("Only submitted prequalifications can be reviewed")
  const now = new Date().toISOString()
  const rules = await getComplianceRules(resolvedOrgId)
  const expiresAt = parsed.decision === "declined" ? null : parsed.expires_at ?? defaultExpiryDate(rules.prequalification_validity_days)
  const { data, error } = await supabase.from("prequalifications").update({ status: parsed.decision, reviewed_by: userId, reviewed_at: now, expires_at: expiresAt, single_project_limit_cents: parsed.single_project_limit_cents ?? null, aggregate_limit_cents: parsed.aggregate_limit_cents ?? null, review_notes: parsed.review_notes ?? null }).eq("org_id", resolvedOrgId).eq("id", prequalificationId).select(SELECT).single()
  if (error || !data) throw new Error(`Failed to review prequalification: ${error?.message}`)
  const approved = parsed.decision === "approved" || parsed.decision === "approved_with_limits"
  const { error: companyError } = await supabase.from("companies").update({ prequalified: approved, prequalified_at: approved ? now : null }).eq("org_id", resolvedOrgId).eq("id", existing.company_id)
  if (companyError) throw new Error(`Failed to update company prequalification: ${companyError.message}`)
  await recordEvent({ orgId: resolvedOrgId, actorId: userId, eventType: approved ? "prequalification.approved" : "prequalification.declined", entityType: "prequalification", entityId: prequalificationId, payload: { company_id: existing.company_id, status: parsed.decision } })
  await recordAudit({ orgId: resolvedOrgId, actorId: userId, action: "update", entityType: "prequalification", entityId: prequalificationId, before: existing, after: data })
  return data as Prequalification
}

export async function expirePrequalificationsWithClient(supabase: SupabaseClient, orgId: string, today: string): Promise<number> {
  const { data, error } = await supabase.from("prequalifications").select("id, company_id").eq("org_id", orgId).in("status", ["approved", "approved_with_limits"]).lt("expires_at", today)
  if (error) throw new Error(`Failed to find expired prequalifications: ${error.message}`)
  if (!data?.length) return 0
  const ids = data.map((row) => row.id)
  const companyIds = Array.from(new Set(data.map((row) => row.company_id)))
  const { error: updateError } = await supabase.from("prequalifications").update({ status: "expired" }).eq("org_id", orgId).in("id", ids)
  if (updateError) throw new Error(`Failed to expire prequalifications: ${updateError.message}`)
  await supabase.from("companies").update({ prequalified: false, prequalified_at: null }).eq("org_id", orgId).in("id", companyIds)
  for (const row of data) await recordEvent({ orgId, eventType: "prequalification.expired", entityType: "prequalification", entityId: row.id, channel: "notification", payload: { company_id: row.company_id } }).catch(() => null)
  return data.length
}

export async function getCompanyPrequalificationWarning(args: { companyId: string | null; commitmentTotalCents?: number; excludeCommitmentId?: string; orgId?: string }): Promise<string | null> {
  if (!args.companyId) return "No vendor company is assigned; prequalification could not be checked."
  const latest = await getLatestPrequalification(args.companyId, args.orgId)
  if (!latest || !["approved", "approved_with_limits"].includes(latest.status)) return "Vendor does not have a current approved prequalification."
  if (latest.expires_at && latest.expires_at < new Date().toISOString().slice(0, 10)) return "Vendor prequalification has expired."
  if (args.commitmentTotalCents != null && latest.single_project_limit_cents != null && args.commitmentTotalCents > latest.single_project_limit_cents) return `Commitment exceeds the vendor's single-project prequalification limit by $${((args.commitmentTotalCents - latest.single_project_limit_cents) / 100).toLocaleString("en-US")}.`
  if (args.commitmentTotalCents != null && latest.aggregate_limit_cents != null) {
    const { supabase, orgId } = await requireOrgContext(args.orgId)
    let query = supabase
      .from("commitments")
      .select("total_cents")
      .eq("org_id", orgId)
      .eq("company_id", args.companyId)
      .eq("status", "approved")
    if (args.excludeCommitmentId) query = query.neq("id", args.excludeCommitmentId)
    const { data, error } = await query
    if (error) throw new Error(`Failed to check aggregate prequalification capacity: ${error.message}`)
    const activeTotal = (data ?? []).reduce((sum, commitment) => sum + Number(commitment.total_cents ?? 0), 0)
    const resultingTotal = activeTotal + args.commitmentTotalCents
    if (resultingTotal > latest.aggregate_limit_cents) {
      return `Commitments exceed the vendor's aggregate prequalification limit by $${((resultingTotal - latest.aggregate_limit_cents) / 100).toLocaleString("en-US")}.`
    }
  }
  return null
}

export async function getBidInvitePrequalificationWarnings(
  companyIds: string[],
  orgId?: string,
): Promise<Map<string, string>> {
  if (companyIds.length === 0) return new Map()
  const { supabase, orgId: resolvedOrgId } = await requireOrgContext(orgId)
  const uniqueIds = Array.from(new Set(companyIds))
  const { data, error } = await supabase
    .from("prequalifications")
    .select("company_id, status, expires_at, created_at")
    .eq("org_id", resolvedOrgId)
    .in("company_id", uniqueIds)
    .order("created_at", { ascending: false })
  if (error) throw new Error(`Failed to check bid invite prequalification: ${error.message}`)

  const latestByCompany = new Map<string, { status: string; expires_at: string | null }>()
  for (const row of data ?? []) {
    if (!latestByCompany.has(row.company_id)) latestByCompany.set(row.company_id, row)
  }
  const today = new Date().toISOString().slice(0, 10)
  const warnings = new Map<string, string>()
  for (const companyId of uniqueIds) {
    const latest = latestByCompany.get(companyId)
    if (!latest || !["approved", "approved_with_limits"].includes(latest.status)) {
      warnings.set(companyId, "Vendor does not have a current approved prequalification.")
    } else if (latest.expires_at && latest.expires_at < today) {
      warnings.set(companyId, "Vendor prequalification has expired.")
    }
  }
  return warnings
}
