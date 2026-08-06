import "server-only"

import { z } from "zod"

import { APPROVAL_GATE_REASONS, loadApprovalGateSettings } from "@/lib/financials/approval-gates"
import { requireOrgContext } from "@/lib/services/context"
import { requirePermission } from "@/lib/services/permissions"
import { recordAudit } from "@/lib/services/audit"
import { getComplianceRulesWithClient } from "@/lib/services/compliance"
import { propagateApprovalToLedger } from "@/lib/services/cost-plus"
import { enqueueVendorBillSync } from "@/lib/services/accounting-sync"
import { recordEvent } from "@/lib/services/events"
import { createServiceSupabaseClient } from "@/lib/supabase/server"

/**
 * Approving a payable without a human.
 *
 * A rule matching is the only thing this skips. Everything a human approval does
 * — the coding must equal the total, every line must carry a cost code where the
 * project requires one, the lien-waiver state gets seeded, job costs get posted,
 * and the bill is queued for the accounting integration — happens here too.
 *
 * It used to be a bare status update. An auto-approved bill therefore never
 * reached job costs, never reached QuickBooks, could be approved with no coding
 * at all, and left `approved_by` null — which silently disabled the dual-control
 * check that refuses to let one person both approve a bill and pay it.
 */
export async function evaluateAndAutoApproveVendorBill(input: { orgId: string; billId: string }) {
  const client = createServiceSupabaseClient()
  const { data: bill } = await client
    .from("vendor_bills")
    .select("id,org_id,project_id,company_id,bill_number,total_cents,status,metadata,lien_waiver_status,company:companies(metadata)")
    .eq("org_id", input.orgId)
    .eq("id", input.billId)
    .maybeSingle()
  if (!bill || bill.status !== "pending") return { approved: false, ruleId: null }
  const { data: rules, error } = await client
    .from("invoice_auto_approval_rules")
    .select("*")
    .eq("org_id", input.orgId)
    .eq("is_active", true)
    .or(`project_id.is.null,project_id.eq.${bill.project_id}`)
    .order("project_id", { ascending: false, nullsFirst: false })
  if (error) throw new Error(`Failed to evaluate auto-approval rules: ${error.message}`)
  const company = Array.isArray(bill.company) ? bill.company[0] : bill.company
  const trustTier = String((company?.metadata as Record<string, unknown> | null)?.vendor_trust_tier ?? "")

  for (const rule of rules ?? []) {
    if (rule.max_amount_cents != null && Number(bill.total_cents) > Number(rule.max_amount_cents)) continue
    if (rule.company_id && rule.company_id !== bill.company_id) continue
    if (rule.vendor_trust_tiers?.length && !rule.vendor_trust_tiers.includes(trustTier)) continue
    if (rule.require_no_duplicates) {
      const { count } = await client
        .from("vendor_bills")
        .select("id", { count: "exact", head: true })
        .eq("org_id", input.orgId)
        .eq("company_id", bill.company_id)
        .ilike("bill_number", bill.bill_number)
      if ((count ?? 0) > 1) continue
    }

    // The same coding gates a human approval passes. A rule says who may skip
    // review, never that the payable may be incomplete.
    const { data: lines, error: linesError } = await client
      .from("bill_lines")
      .select("cost_code_id,quantity,unit_cost_cents")
      .eq("org_id", input.orgId)
      .eq("bill_id", bill.id)
    if (linesError) throw new Error(`Failed to load payable coding: ${linesError.message}`)
    const codedLines = lines ?? []
    if (codedLines.length === 0) continue
    const codedTotal = codedLines.reduce(
      (sum, line) => sum + Math.round(Number(line.quantity ?? 1) * Number(line.unit_cost_cents ?? 0)),
      0,
    )
    if (codedTotal !== Number(bill.total_cents ?? 0)) continue
    if (bill.project_id) {
      const gates = await loadApprovalGateSettings({ supabase: client, orgId: input.orgId, projectId: bill.project_id })
      if (gates.cost_codes_enabled && codedLines.some((line) => !line.cost_code_id)) continue
    }

    const complianceRules = await getComplianceRulesWithClient(client, input.orgId)
    const now = new Date().toISOString()
    const lienWaiverStatus = complianceRules.require_lien_waiver
      ? bill.lien_waiver_status === "received"
        ? bill.lien_waiver_status
        : "requested"
      : bill.lien_waiver_status ?? "not_required"

    const { data: approved, error: updateError } = await client
      .from("vendor_bills")
      .update({
        status: "approved",
        approved_at: now,
        approved_by: null,
        lien_waiver_status: lienWaiverStatus,
        lien_waiver_received_at: lienWaiverStatus === "received" ? undefined : null,
        metadata: { ...((bill.metadata as object) ?? {}), auto_approved_rule_id: rule.id },
      })
      .eq("org_id", input.orgId)
      .eq("id", bill.id)
      .eq("status", "pending")
      .select("*")
      .maybeSingle()
    if (updateError) throw new Error(`Failed to auto-approve bill: ${updateError.message}`)
    if (!approved) return { approved: false, ruleId: null }

    // Same rollback contract as the human path: a payable that could not reach
    // the cost ledger is not approved, because the approval is what the ledger
    // entry is evidence of.
    try {
      await propagateApprovalToLedger({ source: "vendor_bill", sourceId: bill.id, orgId: input.orgId })
    } catch (ledgerError) {
      await client
        .from("vendor_bills")
        .update({
          status: bill.status,
          approved_at: null,
          approved_by: null,
          lien_waiver_status: bill.lien_waiver_status ?? null,
          metadata: (bill.metadata as object) ?? {},
        })
        .eq("org_id", input.orgId)
        .eq("id", bill.id)
      const message = ledgerError instanceof Error ? ledgerError.message : String(ledgerError ?? "Unknown error")
      throw new Error(`Auto-approval was reverted because the project cost ledger could not be updated: ${message}`)
    }

    await enqueueVendorBillSync(bill.id, input.orgId)
    await Promise.all([
      recordAudit({
        orgId: input.orgId,
        action: "update",
        entityType: "vendor_bill",
        entityId: bill.id,
        before: bill,
        after: approved,
        source: "invoice_auto_approval",
      }),
      recordEvent({
        orgId: input.orgId,
        eventType: "vendor_bill_auto_approved",
        entityType: "vendor_bill",
        entityId: bill.id,
        payload: { project_id: bill.project_id, rule_id: rule.id, amount_cents: bill.total_cents },
      }),
      // The submitter is told an automatic approval the same way they are told a
      // human one; from the vendor's side nothing about it is different.
      recordEvent({
        orgId: input.orgId,
        eventType: "vendor_bill_approved",
        entityType: "vendor_bill",
        entityId: bill.id,
        payload: {
          project_id: bill.project_id,
          company_id: bill.company_id,
          bill_number: bill.bill_number,
          amount_cents: bill.total_cents,
          auto_approved: true,
        },
      }),
    ])
    return { approved: true, ruleId: rule.id }
  }
  return { approved: false, ruleId: null }
}

/**
 * Administering the rules.
 *
 * These existed as a table and an evaluator with no surface at all: a rule could
 * only be created by writing to the database directly, and once one existed
 * nobody could see it, edit it, or turn it off. A control that decides which
 * invoices skip human approval is the last one that should be invisible, so
 * reading and writing it needs the same authority it gives away.
 */

const autoApprovalRuleSchema = z.object({
  id: z.string().uuid().optional(),
  name: z.string().trim().min(1, "Give the rule a name").max(120),
  project_id: z.string().uuid().nullable().optional(),
  company_id: z.string().uuid().nullable().optional(),
  max_amount_cents: z.number().int().positive().nullable().optional(),
  vendor_trust_tiers: z.array(z.string().trim().min(1).max(40)).max(10).default([]),
  require_no_duplicates: z.boolean().default(true),
  is_active: z.boolean().default(true),
})

export type AutoApprovalRuleInput = z.infer<typeof autoApprovalRuleSchema>

export interface AutoApprovalRule {
  id: string
  name: string
  projectId: string | null
  projectName: string | null
  companyId: string | null
  companyName: string | null
  maxAmountCents: number | null
  vendorTrustTiers: string[]
  requireNoDuplicates: boolean
  isActive: boolean
  createdAt: string
}

export async function listAutoApprovalRules(orgId?: string): Promise<AutoApprovalRule[]> {
  const context = await requireOrgContext(orgId)
  await requirePermission("bill.approve", context)
  const supabase = createServiceSupabaseClient()
  const { data, error } = await supabase
    .from("invoice_auto_approval_rules")
    .select("id,name,project_id,company_id,max_amount_cents,vendor_trust_tiers,require_no_duplicates,is_active,created_at,project:projects(name),company:companies(name)")
    .eq("org_id", context.orgId)
    .order("created_at", { ascending: false })
    .limit(200)
  if (error) throw new Error(`Unable to load auto-approval rules: ${error.message}`)
  return (data ?? []).map((row) => {
    const project = Array.isArray(row.project) ? row.project[0] : row.project
    const company = Array.isArray(row.company) ? row.company[0] : row.company
    return {
      id: row.id,
      name: row.name,
      projectId: row.project_id ?? null,
      projectName: project?.name ?? null,
      companyId: row.company_id ?? null,
      companyName: company?.name ?? null,
      maxAmountCents: row.max_amount_cents == null ? null : Number(row.max_amount_cents),
      vendorTrustTiers: row.vendor_trust_tiers ?? [],
      requireNoDuplicates: row.require_no_duplicates,
      isActive: row.is_active,
      createdAt: row.created_at,
    }
  })
}

export async function upsertAutoApprovalRule(input: AutoApprovalRuleInput, orgId?: string) {
  const parsed = autoApprovalRuleSchema.parse(input)
  const context = await requireOrgContext(orgId)
  await requirePermission("bill.approve", context)
  const supabase = createServiceSupabaseClient()

  const payload = {
    org_id: context.orgId,
    name: parsed.name,
    project_id: parsed.project_id ?? null,
    company_id: parsed.company_id ?? null,
    max_amount_cents: parsed.max_amount_cents ?? null,
    vendor_trust_tiers: parsed.vendor_trust_tiers,
    require_no_duplicates: parsed.require_no_duplicates,
    is_active: parsed.is_active,
  }

  const { data, error } = parsed.id
    ? await supabase.from("invoice_auto_approval_rules").update(payload).eq("org_id", context.orgId).eq("id", parsed.id).select("id").maybeSingle()
    : await supabase.from("invoice_auto_approval_rules").insert({ ...payload, created_by: context.userId }).select("id").maybeSingle()
  if (error || !data) throw new Error(`Unable to save the auto-approval rule: ${error?.message ?? "not found"}`)

  await Promise.all([
    recordAudit({
      orgId: context.orgId,
      actorId: context.userId,
      action: parsed.id ? "update" : "insert",
      entityType: "invoice_auto_approval_rule",
      entityId: data.id,
      after: payload,
    }),
    recordEvent({
      orgId: context.orgId,
      actorId: context.userId,
      eventType: "invoice_auto_approval_rule_changed",
      entityType: "invoice_auto_approval_rule",
      entityId: data.id,
      payload: { name: parsed.name, is_active: parsed.is_active, project_id: parsed.project_id ?? null },
    }),
  ])
  return { id: data.id }
}

export async function deleteAutoApprovalRule(ruleId: string, orgId?: string) {
  const context = await requireOrgContext(orgId)
  await requirePermission("bill.approve", context)
  const supabase = createServiceSupabaseClient()
  const { error } = await supabase.from("invoice_auto_approval_rules").delete().eq("org_id", context.orgId).eq("id", ruleId)
  if (error) throw new Error(`Unable to delete the auto-approval rule: ${error.message}`)
  await recordAudit({
    orgId: context.orgId,
    actorId: context.userId,
    action: "delete",
    entityType: "invoice_auto_approval_rule",
    entityId: ruleId,
  })
  return { deleted: true as const }
}
