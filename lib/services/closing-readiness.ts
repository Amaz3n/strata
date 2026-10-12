import "server-only"
import { z } from "zod"
import type { SupabaseClient } from "@supabase/supabase-js"
import { requireAuthorization } from "@/lib/services/authorization"
import { hasExecutedPurchaseAgreement } from "@/lib/services/community-sales"
import { getProjectWaiverReadiness } from "@/lib/services/waiver-register"
import { readAllRows } from "@/lib/land/paging"
import { assertAgreementMilestonesClear } from "@/lib/services/agreement-milestones"
import { closingCommissionRefusal } from "@/lib/services/sales-commissions"
import { createServiceSupabaseClient } from "@/lib/supabase/server"

const itemSchema = z.object({ id: z.string().uuid(), title: z.string(), is_gate: z.boolean(), evidence_required: z.boolean(),
  status: z.enum(["open", "complete", "waived"]), notes: z.string().nullable(),
  file_id: z.string().uuid().nullable(), completed_at: z.string().nullable(), completed_by: z.string().uuid().nullable() })

type ClosingScope = {
  supabase: SupabaseClient; orgId: string; userId: string; closingId: string; projectId: string
}
export async function authorizeClosingProject(input: ClosingScope) {
  await requireAuthorization({ permission: "closing.manage", orgId: input.orgId, userId: input.userId,
    projectId: input.projectId, supabase: input.supabase, resourceType: "closing", resourceId: input.closingId, logDecision: true })
}
export async function assertClosingReadiness(input: ClosingScope) {
  await authorizeClosingProject(input)
  const { data, error } = await input.supabase.rpc("read_inspection_closing_readiness", { p_org: input.orgId, p_home: input.projectId, p_actor: input.userId })
  if (error) throw new Error(`Required inspection readiness: ${error.message}`)
  z.object({ ready: z.literal(true) }).parse(data)
  // The agreement's contingencies and lender/title milestones required before
  // closing; the closings trigger refuses the same transition in the database.
  await assertAgreementMilestonesClear(input.supabase, input.orgId, input.projectId, "closing")
  const [items, executed, punch, waivers, commission] = await Promise.all([
    readAllRows((from, to) => input.supabase.from("closing_checklist_items").select("id,title,is_gate,evidence_required,status,notes,file_id,completed_at,completed_by")
      .eq("org_id", input.orgId).eq("closing_id", input.closingId).order("id").range(from, to), { cap: 1001, label: "Unable to verify closing checklist" }),
    hasExecutedPurchaseAgreement(input.projectId, input.orgId),
    // An item blocks until it is closed, and a verification-required item
    // blocks until someone verified it — "resolved" or closed without a
    // verification stamp is not done, the same rule project close-out reads.
    input.supabase.from("punch_items").select("id", { count: "exact", head: true }).eq("org_id", input.orgId)
      .eq("project_id", input.projectId).or("status.neq.closed,status.is.null,and(verification_required.eq.true,verified_at.is.null)"),
    getProjectWaiverReadiness(input.projectId, "closing.manage", input.orgId),
    // Commission terms are private to sales and AP; the coordinator settling the
    // home only needs to know whether they were approved (or declared none).
    closingCommissionRefusal(createServiceSupabaseClient(), input.orgId, input.projectId),
  ])
  if (items.truncated) throw new Error("Closing checklist exceeds the supported limit; reconcile it before settlement")
  const gates = z.array(itemSchema).parse(items.rows).filter(item => item.is_gate)
  if (!gates.length) throw new Error("Closing readiness gates are missing")
  for (const gate of gates) {
    if (gate.status === "open") throw new Error(`Complete or waive the closing gate: ${gate.title}`)
    if (!gate.completed_by || !gate.completed_at || !Number.isFinite(Date.parse(gate.completed_at))) throw new Error(`Closing gate completion evidence is missing: ${gate.title}`)
    if (gate.status === "waived" && (gate.notes?.trim().length ?? 0) < 10) throw new Error(`Document a waiver reason of at least 10 characters: ${gate.title}`)
    if (gate.evidence_required && (gate.status !== "complete" || !gate.file_id)) throw new Error(`Attach the evidence file to complete ${gate.title}; it cannot be waived`)
  }
  if (!executed) throw new Error("An executed purchase agreement is required")
  if (punch.error) throw new Error(`Unable to verify punch list: ${punch.error.message}`)
  if (punch.count === null || punch.count === undefined) throw new Error("Punch list count is unavailable")
  if (punch.count > 0) throw new Error("Open punch items must be cleared, and verified where required, before closing")
  if (!waivers.ready) throw new Error(`Final waivers outstanding: ${waivers.missing.join(", ")}`)
  if (commission) throw new Error(commission)
  await assertNoBillingOutsideClosing(input)
  const fileIds = [...new Set(gates.flatMap(gate => gate.file_id ? [gate.file_id] : []))]
  for (let offset = 0; offset < fileIds.length; offset += 100) {
    const batch = fileIds.slice(offset, offset + 100)
    const { data, error } = await input.supabase.from("files").select("id").eq("org_id", input.orgId)
      .eq("project_id", input.projectId).in("id", batch)
    if (error) throw new Error(`Unable to verify closing evidence files: ${error.message}`)
    const present = new Set((data ?? []).map(row => row.id))
    if (batch.some(id => !present.has(id))) throw new Error("Closing evidence file is missing or belongs to another home")
  }
}

/**
 * The closing invoice bills the home's whole price. An ordinary invoice already
 * issued on the home would bill part of it twice, so it is credited or voided
 * first; money taken before closing is collected as a deposit.
 */
async function assertNoBillingOutsideClosing(input: ClosingScope) {
  const invoices = await readAllRows((from, to) => input.supabase.from("invoices").select("id,invoice_number,total_cents")
    .eq("org_id", input.orgId).eq("project_id", input.projectId).not("status", "in", "(draft,void)").is("metadata->>invoice_kind", null)
    .order("id").range(from, to), { cap: 1001, label: "Unable to verify the home's invoices" })
  if (invoices.truncated) throw new Error("This home has more invoices than can be verified; reconcile them before closing")
  if (!invoices.rows.length) return
  const credits = await readAllRows((from, to) => input.supabase.from("receivable_adjustments").select("invoice_id,amount_cents")
    .eq("org_id", input.orgId).eq("adjustment_type", "credit_memo").eq("status", "posted").in("invoice_id", invoices.rows.map((row) => row.id))
    .order("id").range(from, to), { cap: 10001, label: "Unable to verify credits on the home's invoices" })
  if (credits.truncated) throw new Error("This home has more credits than can be verified; reconcile them before closing")
  const credited = new Map<string, number>()
  for (const row of credits.rows) credited.set(row.invoice_id, (credited.get(row.invoice_id) ?? 0) + Number(row.amount_cents))
  const open = invoices.rows.find((row) => Number(row.total_cents) - (credited.get(row.id) ?? 0) > 0)
  if (open) throw new Error(`Invoice ${open.invoice_number ?? open.id} bills this home outside the closing statement. The closing invoice bills the whole price, so credit or void it first; collect money before closing as a deposit.`)
}
