import "server-only"

import { z } from "zod"

import { recordAudit } from "@/lib/services/audit"
import { authorize } from "@/lib/services/authorization"
import { requireBooksAuthorization } from "@/lib/services/books/access"
import { collectBooksRows } from "@/lib/services/books/paging"
import { requireOrgContext } from "@/lib/services/context"
import { recordEvent } from "@/lib/services/events"
import { todayIsoDateOnly } from "@/lib/services/reports/dates"
import { createServiceSupabaseClient } from "@/lib/supabase/server"

export const COST_POOLS = ["equipment", "overhead", "insurance", "supervision", "other"] as const
export const COST_ALLOCATION_BASES = ["equal", "labor_hours", "direct_cost", "equipment_hours", "custom"] as const

/** Allocations listed at once, newest first; the register says when it truncates. */
const REGISTER_LIMIT = 200
/** Jobs offered as destinations. */
const DESTINATION_LIMIT = 500

const shareSchema = z.object({ project_id: z.string().uuid().nullable(), weight: z.coerce.number(), amount_cents: z.number().int() })
const allocationRowSchema = z.object({
  id: z.string().uuid(),
  allocation_date: z.string(),
  reference: z.string(),
  pool: z.enum(COST_POOLS),
  basis: z.enum(COST_ALLOCATION_BASES),
  source_account_id: z.string().uuid(),
  cost_code_id: z.string().uuid().nullable(),
  total_cents: z.number().int(),
  shares: z.array(shareSchema),
  evidence_url: z.string(),
  note: z.string(),
  corrects_allocation_id: z.string().uuid().nullable(),
  status: z.enum(["proposed", "approved", "rejected", "reallocated"]),
  prepared_by: z.string().uuid(),
  prepared_at: z.string(),
  reviewed_by: z.string().uuid().nullable(),
  reviewed_at: z.string().nullable(),
  review_note: z.string().nullable(),
})

/**
 * Shared construction cost and where it went: the pools with something left to
 * allocate, every allocation with its basis, shares and review, and the jobs it
 * can reach.
 */
export async function getCostAllocationRegister() {
  const context = await requireOrgContext()
  await requireBooksAuthorization({ permission: "books.read", userId: context.userId, orgId: context.orgId, supabase: context.supabase, logDecision: false })
  const service = createServiceSupabaseClient()
  const [pools, allocationResult, projects, costCodes, canPropose, canReview] = await Promise.all([
    service.rpc("books_cost_pools", { p_org_id: context.orgId, p_as_of: todayIsoDateOnly() }),
    service.from("books_cost_allocations").select("id, allocation_date, reference, pool, basis, source_account_id, cost_code_id, total_cents, shares, evidence_url, note, corrects_allocation_id, status, prepared_by, prepared_at, reviewed_by, reviewed_at, review_note", { count: "exact" })
      .eq("org_id", context.orgId).order("prepared_at", { ascending: false }).order("id").limit(REGISTER_LIMIT),
    collectBooksRows((from, to) => service.from("projects").select("id, name, status").eq("org_id", context.orgId).neq("status", "cancelled").order("name").order("id").range(from, to)),
    collectBooksRows((from, to) => service.from("cost_codes").select("id, code, name").eq("org_id", context.orgId).order("code").order("id").range(from, to)),
    ...["books.adjust", "books.close"].map(async permission => {
      const decision = await authorize({ permission, userId: context.userId, orgId: context.orgId, supabase: context.supabase, logDecision: false })
      return decision.allowed && decision.divisionScope !== "assigned"
    }),
  ])
  if (pools.error) throw new Error(`Failed to load cost pools: ${pools.error.message}`)
  if (allocationResult.error) throw new Error(`Failed to load cost allocations: ${allocationResult.error.message}`)
  const allocations = z.array(allocationRowSchema).parse(allocationResult.data ?? [])
  const accountIds = [...new Set(allocations.map(row => row.source_account_id))]
  const [accounts, people] = await Promise.all([
    accountIds.length ? service.from("gl_accounts").select("id, code, name").eq("org_id", context.orgId).in("id", accountIds) : Promise.resolve({ data: [], error: null }),
    loadPeople(allocations.flatMap(row => [row.prepared_by, row.reviewed_by])),
  ])
  if (accounts.error) throw new Error(`Failed to load pool accounts: ${accounts.error.message}`)
  const accountName = new Map((accounts.data ?? []).map(row => [String(row.id), `${row.code} ${row.name}`]))
  const projectName = new Map(projects.map(row => [String(row.id), String(row.name)]))
  const costCodeName = new Map(costCodes.map(row => [String(row.id), `${row.code} ${row.name}`]))
  return {
    userId: context.userId,
    canPropose: Boolean(canPropose),
    canReview: Boolean(canReview),
    pools: z.array(z.object({ account_id: z.string().uuid(), code: z.string(), name: z.string(), cents: z.coerce.number() })).parse(pools.data ?? [])
      .map(row => ({ accountId: row.account_id, label: `${row.code} ${row.name}`, cents: row.cents })),
    allocations: allocations.map(row => ({
      id: row.id, date: row.allocation_date, reference: row.reference, pool: row.pool, basis: row.basis, status: row.status,
      sourceAccountId: row.source_account_id, account: accountName.get(row.source_account_id) ?? "Pool account",
      costCodeId: row.cost_code_id, costCode: row.cost_code_id ? costCodeName.get(row.cost_code_id) ?? null : null,
      totalCents: row.total_cents, note: row.note, evidenceUrl: row.evidence_url, correctsId: row.corrects_allocation_id,
      shares: row.shares.map(share => ({ projectId: share.project_id, name: share.project_id ? projectName.get(share.project_id) ?? "Job" : "Retained as company overhead", weight: share.weight, cents: share.amount_cents })),
      preparedBy: row.prepared_by, preparedByName: people.get(row.prepared_by) ?? "A former member", preparedAt: row.prepared_at,
      reviewedByName: row.reviewed_by ? people.get(row.reviewed_by) ?? "A former member" : null, reviewedAt: row.reviewed_at, reviewNote: row.review_note,
    })),
    truncated: (allocationResult.count ?? 0) > allocations.length,
    total: allocationResult.count ?? allocations.length,
    projects: projects.slice(0, DESTINATION_LIMIT).map(row => ({ id: String(row.id), name: String(row.name) })),
    projectsTruncated: projects.length > DESTINATION_LIMIT,
    costCodes: costCodes.map(row => ({ id: String(row.id), label: `${row.code} ${row.name}` })),
  }
}

async function loadPeople(ids: Array<string | null>) {
  const unique = [...new Set(ids.filter((id): id is string => Boolean(id)))]
  if (!unique.length) return new Map<string, string>()
  const { data, error } = await createServiceSupabaseClient().from("app_users").select("id, full_name, email").in("id", unique)
  if (error) throw new Error(`Failed to load allocation reviewers: ${error.message}`)
  return new Map((data ?? []).map(row => [String(row.id), String(row.full_name || row.email)]))
}

const proposalSchema = z.object({
  date: z.string().date(),
  reference: z.string().trim().min(3).max(120),
  pool: z.enum(COST_POOLS),
  basis: z.enum(COST_ALLOCATION_BASES),
  sourceAccountId: z.string().uuid(),
  costCodeId: z.string().uuid().nullable(),
  totalCents: z.number().int().safe().positive(),
  weights: z.array(z.object({ projectId: z.string().uuid().nullable(), weight: z.number().positive().finite() })).min(1).max(250),
  evidenceUrl: z.string().url().startsWith("https://"),
  note: z.string().trim().min(10).max(4000),
  correctsId: z.string().uuid().nullable(),
})

/**
 * Proposes how a shared cost pool is spread: the basis, each job's weight (and
 * an optional retained share that stays company overhead) and the total. The
 * database splits it to the cent and refuses more than the pool holds; nothing
 * posts until a different member approves it. A reallocation names the
 * allocation it corrects.
 */
export async function proposeCostAllocation(input: z.input<typeof proposalSchema>) {
  const parsed = proposalSchema.parse(input)
  const context = await requireOrgContext()
  await requireBooksAuthorization({ permission: "books.adjust", userId: context.userId, orgId: context.orgId, supabase: context.supabase, resourceType: "books_cost_allocation", resourceId: context.orgId, logDecision: true })
  const { data, error } = await createServiceSupabaseClient().rpc("propose_books_cost_allocation", {
    p_org_id: context.orgId, p_date: parsed.date, p_reference: parsed.reference, p_pool: parsed.pool, p_basis: parsed.basis,
    p_source_account_id: parsed.sourceAccountId, p_cost_code_id: parsed.costCodeId, p_total_cents: parsed.totalCents,
    p_weights: parsed.weights.map(row => ({ project_id: row.projectId, weight: row.weight })), p_evidence_url: parsed.evidenceUrl, p_note: parsed.note,
    p_corrects: parsed.correctsId, p_actor_id: context.userId,
  })
  if (error) throw new Error(error.message)
  const id = z.string().uuid().parse(data)
  await recordEvent({ orgId: context.orgId, actorId: context.userId, eventType: "books.cost_allocation_proposed", entityType: "books_cost_allocation", entityId: id, payload: { pool: parsed.pool, total_cents: parsed.totalCents, corrects: parsed.correctsId } })
  await recordAudit({ orgId: context.orgId, actorId: context.userId, action: "insert", entityType: "books_cost_allocation", entityId: id, after: parsed, source: "books.cost_allocation" })
  return { id }
}

/**
 * Approves (and posts) or rejects a proposed allocation: an accounting judgment,
 * so it takes the close permission. The database refuses the proposer.
 */
export async function reviewCostAllocation(input: { allocationId: string; approve: boolean; note?: string }) {
  const parsed = z.object({ allocationId: z.string().uuid(), approve: z.boolean(), note: z.string().trim().max(4000).optional() }).parse(input)
  const context = await requireOrgContext()
  await requireBooksAuthorization({ permission: "books.close", userId: context.userId, orgId: context.orgId, supabase: context.supabase, resourceType: "books_cost_allocation", resourceId: parsed.allocationId, logDecision: true })
  const { data, error } = await createServiceSupabaseClient().rpc("review_books_cost_allocation", { p_org_id: context.orgId, p_allocation_id: parsed.allocationId, p_approve: parsed.approve, p_note: parsed.note ?? null, p_actor_id: context.userId })
  if (error) throw new Error(error.message)
  const result = z.object({ allocationId: z.string().uuid(), status: z.enum(["approved", "rejected"]), journalEntryId: z.string().uuid().nullable(), reversalEntryId: z.string().uuid().nullable() }).parse(data)
  await recordEvent({ orgId: context.orgId, actorId: context.userId, eventType: `books.cost_allocation_${result.status}`, entityType: "books_cost_allocation", entityId: parsed.allocationId, payload: { journal_entry_id: result.journalEntryId, reversal_entry_id: result.reversalEntryId } })
  await recordAudit({ orgId: context.orgId, actorId: context.userId, action: "update", entityType: "books_cost_allocation", entityId: parsed.allocationId, after: result, source: "books.cost_allocation" })
  return result
}
