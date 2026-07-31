import "server-only"

import { recordAudit } from "@/lib/services/audit"
import { recordEvent } from "@/lib/services/events"
import { createServiceSupabaseClient } from "@/lib/supabase/server"

/** Applies explicit org/project rules after ingestion; every pass is auditable. */
export async function evaluateAndAutoApproveVendorBill(input: { orgId: string; billId: string }) {
  const client = createServiceSupabaseClient()
  const { data: bill } = await client.from("vendor_bills").select("id,org_id,project_id,company_id,bill_number,total_cents,status,metadata,company:companies(metadata)").eq("org_id", input.orgId).eq("id", input.billId).maybeSingle()
  if (!bill || bill.status !== "pending") return { approved: false, ruleId: null }
  const { data: rules, error } = await client.from("invoice_auto_approval_rules").select("*").eq("org_id", input.orgId).eq("is_active", true).or(`project_id.is.null,project_id.eq.${bill.project_id}`).order("project_id", { ascending: false, nullsFirst: false })
  if (error) throw new Error(`Failed to evaluate auto-approval rules: ${error.message}`)
  const company = Array.isArray(bill.company) ? bill.company[0] : bill.company
  const trustTier = String((company?.metadata as any)?.vendor_trust_tier ?? "")
  for (const rule of rules ?? []) {
    if (rule.max_amount_cents != null && Number(bill.total_cents) > Number(rule.max_amount_cents)) continue
    if (rule.company_id && rule.company_id !== bill.company_id) continue
    if (rule.vendor_trust_tiers?.length && !rule.vendor_trust_tiers.includes(trustTier)) continue
    if (rule.require_no_duplicates) {
      const { count } = await client.from("vendor_bills").select("id", { count: "exact", head: true }).eq("org_id", input.orgId).eq("company_id", bill.company_id).ilike("bill_number", bill.bill_number)
      if ((count ?? 0) > 1) continue
    }
    const now = new Date().toISOString()
    const { data: approved, error: updateError } = await client.from("vendor_bills").update({ status: "approved", approved_at: now, approved_by: null, metadata: { ...(bill.metadata as object ?? {}), auto_approved_rule_id: rule.id } }).eq("org_id", input.orgId).eq("id", bill.id).eq("status", "pending").select("*").maybeSingle()
    if (updateError) throw new Error(`Failed to auto-approve bill: ${updateError.message}`)
    if (!approved) return { approved: false, ruleId: null }
    await Promise.all([
      recordAudit({ orgId: input.orgId, action: "update", entityType: "vendor_bill", entityId: bill.id, before: bill, after: approved, source: "invoice_auto_approval" }),
      recordEvent({ orgId: input.orgId, eventType: "vendor_bill_auto_approved", entityType: "vendor_bill", entityId: bill.id, payload: { project_id: bill.project_id, rule_id: rule.id, amount_cents: bill.total_cents } }),
    ])
    return { approved: true, ruleId: rule.id }
  }
  return { approved: false, ruleId: null }
}
