import "server-only"
import { z } from "zod"
import { requireOrgContext } from "@/lib/services/context"
import { requireBooksAuthorization } from "@/lib/services/books/access"
import { createServiceSupabaseClient } from "@/lib/supabase/server"
import { collectBooksRows } from "@/lib/services/books/paging"
import { recordAudit } from "@/lib/services/audit"
import { recordEvent } from "@/lib/services/events"

async function warrantyContext() {
  const context = await requireOrgContext()
  await requireBooksAuthorization({ permission: "books.adjust", userId: context.userId, orgId: context.orgId, supabase: context.supabase, logDecision: true })
  return context
}
export async function getWarrantyAccountingWorkspace(projectId?: string) {
  const context = await warrantyContext()
  const service = createServiceSupabaseClient()
  if (projectId) z.string().uuid().parse(projectId)
  const visits = await collectBooksRows((from,to) => {
    let query = service.from("warranty_service_visits").select("id,project_id,visit_number,internal_labor_cents,internal_material_cents,books_approved_cost_cents,books_reserve_consumed_cents,books_cost_approved_at,books_cost_sources,project:projects(name)").eq("org_id",context.orgId).eq("status","completed")
    if (projectId) query = query.eq("project_id",projectId)
    return query.order("id").range(from,to)
  })
  return visits.map(visit => { const project = Array.isArray(visit.project) ? visit.project[0] : visit.project; return { id: visit.id, projectId: visit.project_id, label: `${project?.name ?? "Project"} · Visit ${visit.visit_number}`, submittedCents: Number(visit.internal_labor_cents ?? 0)+Number(visit.internal_material_cents ?? 0), approvedCents: Number(visit.books_approved_cost_cents), reserveCents: Number(visit.books_reserve_consumed_cents), approvedAt: visit.books_cost_approved_at } })
}
export async function getWarrantyCostSources(visitId: string) {
  const context = await warrantyContext()
  const service = createServiceSupabaseClient()
  const { data: visit, error } = await service.from("warranty_service_visits").select("project_id").eq("org_id",context.orgId).eq("id",z.string().uuid().parse(visitId)).single()
  if (error) throw new Error(`Visit not found: ${error.message}`)
  const sources = await collectBooksRows((from,to) => service.from("job_cost_entries").select("id,source_type,incurred_on,cost_cents,metadata").eq("org_id",context.orgId).eq("project_id",visit.project_id).eq("status","posted").gt("cost_cents",0).neq("source_type","inventory_event").order("id").range(from,to))
  return sources.map(row => ({ id: row.id, incurredOn: row.incurred_on, amountCents: Number(row.cost_cents), label: typeof row.metadata?.description === "string" ? row.metadata.description : String(row.source_type).replaceAll("_", " ") }))
}
const approvalSchema = z.object({ visitId: z.string().uuid(), date: z.string().date(), evidenceUrl: z.string().url().startsWith("https://"), sources: z.array(z.object({ jobCostEntryId: z.string().uuid(), amountCents: z.number().int().safe().positive() })).min(1).max(100) })
export async function approveWarrantyAccounting(input: z.input<typeof approvalSchema>) {
  const parsed = approvalSchema.parse(input)
  const context = await warrantyContext()
  const { data, error } = await createServiceSupabaseClient().rpc("approve_books_warranty_cost", { p_org_id: context.orgId, p_visit_id: parsed.visitId, p_date: parsed.date, p_sources: parsed.sources.map(row => ({ job_cost_entry_id: row.jobCostEntryId, amount_cents: row.amountCents })), p_evidence_url: parsed.evidenceUrl, p_actor_id: context.userId })
  if (error) throw new Error(`Failed to approve warranty costs: ${error.message}`)
  await recordAudit({ orgId: context.orgId, actorId: context.userId, action: "update", entityType: "warranty_service_visit", entityId: parsed.visitId, after: { ...parsed, result: data }, source: "books.warranty_cost_approval" })
  await recordEvent({ orgId: context.orgId, actorId: context.userId, eventType: "books.warranty_cost_approved", entityType: "warranty_service_visit", entityId: parsed.visitId })
  return { approved: true }
}
export async function reverseWarrantyAccounting(input: { visitId: string; date: string; reason: string }) {
  const parsed = z.object({ visitId: z.string().uuid(), date: z.string().date(), reason: z.string().trim().min(10).max(2000) }).parse(input)
  const context = await warrantyContext()
  const { error } = await createServiceSupabaseClient().rpc("reverse_books_warranty_cost", { p_org_id: context.orgId, p_visit_id: parsed.visitId, p_date: parsed.date, p_reason: parsed.reason, p_actor_id: context.userId })
  if (error) throw new Error(`Failed to reverse warranty cost approval: ${error.message}`)
  await recordAudit({ orgId: context.orgId, actorId: context.userId, action: "update", entityType: "warranty_service_visit", entityId: parsed.visitId, after: parsed, source: "books.warranty_cost_reversal" })
  await recordEvent({ orgId: context.orgId, actorId: context.userId, eventType: "books.warranty_cost_reversed", entityType: "warranty_service_visit", entityId: parsed.visitId })
  return { reversed: true }
}
export async function provisionWarrantyAtClosingForService(orgId: string, projectId: string, date: string, actorId: string) {
  const { error } = await createServiceSupabaseClient().rpc("post_books_warranty_reserve", { p_org_id: orgId, p_project_id: projectId, p_date: date, p_initial: true, p_actor_id: actorId })
  if (error) throw new Error(`Failed to provide the approved warranty reserve: ${error.message}`)
}

export async function setWarrantyReserveEstimate(input: { projectId: string; date: string; amountCents: number; evidenceUrl: string }) {
  const parsed = z.object({ projectId: z.string().uuid(), date: z.string().date(), amountCents: z.number().int().safe().nonnegative(), evidenceUrl: z.string().url().startsWith("https://") }).parse(input)
  const context = await warrantyContext()
  const { error } = await createServiceSupabaseClient().rpc("set_books_warranty_estimate", { p_org_id: context.orgId, p_project_id: parsed.projectId, p_date: parsed.date, p_amount_cents: parsed.amountCents, p_evidence_url: parsed.evidenceUrl, p_actor_id: context.userId })
  if (error) throw new Error(`Failed to record warranty estimate: ${error.message}`)
  await recordAudit({ orgId: context.orgId, actorId: context.userId, action: "update", entityType: "project", entityId: parsed.projectId, after: parsed, source: "books.warranty_estimate" })
  await recordEvent({ orgId: context.orgId, actorId: context.userId, eventType: "books.warranty_estimate_updated", entityType: "project", entityId: parsed.projectId })
  return { saved: true }
}

export async function reconcileWarrantyRecoveriesForService(orgId: string, projectIds?: Set<string> | null) {
  if (projectIds?.size === 0) return []
  const service = createServiceSupabaseClient()
  const backcharges = await collectBooksRows((from,to) => service.from("warranty_backcharges").select("warranty_request_id,project_id").eq("org_id",orgId).not("vendor_credit_bill_id","is",null).order("id").range(from,to))
  const requests = new Map(backcharges.filter(row => !projectIds || projectIds.has(row.project_id)).map(row => [row.warranty_request_id,row.project_id]))
  const failures: Array<{ sourceType: string; sourceId: string; error: string }> = []
  for (const [requestId,projectId] of requests) {
    const { error } = await service.rpc("reconcile_books_warranty_recovery", { p_org_id: orgId, p_request_id: requestId, p_date: new Date().toISOString().slice(0,10) })
    if (error) failures.push({ sourceType: "warranty_reserve_recovery", sourceId: projectId, error: error.message })
  }
  return failures
}
