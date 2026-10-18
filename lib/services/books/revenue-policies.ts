import "server-only"

import { z } from "zod"

import { primaryContractsInForce } from "@/lib/financials/project-revenue-basis"
import { inferRevenuePolicy, policyInForce, type RevenueBillingMethod, type RevenuePolicyRecord } from "@/lib/financials/revenue-policy"
import { recordAudit } from "@/lib/services/audit"
import { authorize } from "@/lib/services/authorization"
import { requireBooksAuthorization } from "@/lib/services/books/access"
import { collectBooksRows } from "@/lib/services/books/paging"
import { requireOrgContext } from "@/lib/services/context"
import { recordEvent } from "@/lib/services/events"
import { todayIsoDateOnly } from "@/lib/services/reports/dates"
import { createServiceSupabaseClient } from "@/lib/supabase/server"

const METHODS = ["percentage_of_completion", "closing"] as const
const BILLING_METHODS = ["fixed_price", "cost_plus_percent", "cost_plus_fixed_fee", "cost_plus_gmp", "time_and_materials", "purchase_agreement"] as const

const policyRowSchema = z.object({
  id: z.string().uuid(),
  project_id: z.string().uuid(),
  contract_id: z.string().uuid().nullable(),
  method: z.enum(METHODS),
  billing_method: z.enum(BILLING_METHODS),
  effective_from: z.string(),
  rationale: z.string(),
  status: z.enum(["inferred", "proposed", "approved", "rejected"]),
  prepared_by: z.string().uuid().nullable(),
  prepared_at: z.string(),
  reviewed_by: z.string().uuid().nullable(),
  reviewed_at: z.string().nullable(),
  review_note: z.string().nullable(),
})
type PolicyRow = z.infer<typeof policyRowSchema>

/** Cap on jobs listed at once; the register says when it truncates. */
const REGISTER_LIMIT = 500

async function loadOrgPolicyData(orgId: string) {
  const service = createServiceSupabaseClient()
  const [projects, settings, contracts, policies] = await Promise.all([
    collectBooksRows((from, to) => service.from("projects").select("id, name, status, property_type").eq("org_id", orgId).order("name").order("id").range(from, to)),
    collectBooksRows((from, to) => service.from("project_financial_settings").select("project_id, billing_model, fixed_price_billing_basis").eq("org_id", orgId).order("project_id").range(from, to)),
    collectBooksRows((from, to) => service.from("contracts").select("id, project_id, title, status, parent_contract_id, effective_date, contract_type, fixed_fee_cents, gmp_cents, snapshot, open_book, requires_client_cost_approval").eq("org_id", orgId).is("parent_contract_id", null).order("id").range(from, to)),
    collectBooksRows((from, to) => service.from("books_revenue_policies").select("id, project_id, contract_id, method, billing_method, effective_from, rationale, status, prepared_by, prepared_at, reviewed_by, reviewed_at, review_note").eq("org_id", orgId).order("prepared_at").order("id").range(from, to)),
  ])
  return { projects, settings: new Map(settings.map(row => [String(row.project_id), row])), contracts, policies: z.array(policyRowSchema).parse(policies) }
}

/**
 * Every job's revenue policy as of today: the method in force, whether it was
 * approved or only inferred, the billing method it was chosen for, what the
 * billing settings say now when they no longer agree, and any proposal waiting.
 * A job with several contracts lists each contract.
 */
export async function getRevenuePolicyRegister() {
  const context = await requireOrgContext()
  await requireBooksAuthorization({ permission: "books.read", userId: context.userId, orgId: context.orgId, supabase: context.supabase, logDecision: false })
  const today = todayIsoDateOnly()
  const { projects, settings, contracts, policies } = await loadOrgPolicyData(context.orgId)
  const records: RevenuePolicyRecord[] = policies.filter(row => row.status === "inferred" || row.status === "approved")
  const people = await loadPeople(context.orgId, policies.flatMap(row => [row.prepared_by, row.reviewed_by]))
  const rows = projects.slice(0, REGISTER_LIMIT).flatMap(project => {
    const projectContracts = contracts.filter(contract => contract.project_id === project.id)
    const primaries = primaryContractsInForce(project.id, projectContracts, today)
    const financialSettings = settings.get(project.id)
    const posture = {
      status: project.status ?? undefined,
      property_type: project.property_type ?? undefined,
      financial_settings: financialSettings ? { billing_model: financialSettings.billing_model ?? undefined, fixed_price_billing_basis: financialSettings.fixed_price_billing_basis ?? null } : null,
    }
    return (primaries.length > 1 ? primaries : [null]).map(contract => {
      const contractId = contract?.id ?? null
      const inForce = policyInForce(records, project.id, contractId, today)
      const settingsSay = inferRevenuePolicy(posture, contract ?? primaries[0] ?? null)
      const scope = policies.filter(row => row.project_id === project.id && row.contract_id === contractId)
      return {
        projectId: project.id,
        projectName: String(project.name),
        contractId,
        contractTitle: contract ? String(contract.title ?? "Contract") : null,
        inForce: inForce ? { id: inForce.id, method: inForce.method, billingMethod: inForce.billing_method, source: inForce.status === "approved" ? "approved" as const : "inferred" as const, effectiveFrom: inForce.effective_from } : null,
        settingsSay,
        drift: Boolean(inForce && inForce.method !== settingsSay.method),
        pending: scope.filter(row => row.status === "proposed").map(row => describe(row, people))[0] ?? null,
        history: scope.filter(row => row.status !== "proposed").map(row => describe(row, people)).reverse(),
      }
    })
  })
  const [canPropose, canReview] = await Promise.all(["books.manage", "books.close"].map(async permission => {
    const decision = await authorize({ permission, userId: context.userId, orgId: context.orgId, supabase: context.supabase, logDecision: false })
    return decision.allowed && decision.divisionScope !== "assigned"
  }))
  return { rows, truncated: projects.length > REGISTER_LIMIT, total: projects.length, userId: context.userId, canPropose, canReview }
}

function describe(row: PolicyRow, people: Map<string, string>) {
  return {
    id: row.id, method: row.method, billingMethod: row.billing_method, effectiveFrom: row.effective_from, rationale: row.rationale, status: row.status,
    preparedBy: row.prepared_by, preparedByName: row.prepared_by ? people.get(row.prepared_by) ?? "A former member" : "Arc", preparedAt: row.prepared_at,
    reviewedByName: row.reviewed_by ? people.get(row.reviewed_by) ?? "A former member" : null, reviewedAt: row.reviewed_at, reviewNote: row.review_note,
  }
}

async function loadPeople(orgId: string, ids: Array<string | null>) {
  const unique = [...new Set(ids.filter((id): id is string => Boolean(id)))]
  if (!unique.length) return new Map<string, string>()
  const { data, error } = await createServiceSupabaseClient().from("app_users").select("id, full_name, email").in("id", unique)
  if (error) throw new Error(`Failed to load policy reviewers: ${error.message}`)
  return new Map((data ?? []).map(row => [String(row.id), String(row.full_name || row.email)]))
}

const proposalSchema = z.object({
  projectId: z.string().uuid(),
  contractId: z.string().uuid().nullable(),
  method: z.enum(METHODS),
  billingMethod: z.enum(BILLING_METHODS),
  effectiveFrom: z.string().date(),
  rationale: z.string().trim().min(10).max(4000),
})

/**
 * Proposes how a job earns revenue from a date. A policy dated into a closed
 * month may only confirm the method that month was closed under (the attribution
 * of an inferred or unknown policy); changing it there needs the month reopened.
 */
export async function proposeRevenuePolicy(input: z.input<typeof proposalSchema>) {
  const parsed = proposalSchema.parse(input)
  const context = await requireOrgContext()
  await requireBooksAuthorization({ permission: "books.manage", userId: context.userId, orgId: context.orgId, supabase: context.supabase, resourceType: "project", resourceId: parsed.projectId, logDecision: true })
  const service = createServiceSupabaseClient()
  const { data: closed, error: closedError } = await service.from("accounting_periods").select("period_start, period_end")
    .eq("org_id", context.orgId).eq("status", "closed").gte("period_end", parsed.effectiveFrom).order("period_end", { ascending: false }).limit(1).maybeSingle()
  if (closedError) throw new Error(`Failed to check closed periods: ${closedError.message}`)
  if (closed) {
    const { policies } = await loadOrgPolicyData(context.orgId)
    const records: RevenuePolicyRecord[] = policies.filter(row => row.status === "inferred" || row.status === "approved")
    const closedUnder = policyInForce(records, parsed.projectId, parsed.contractId, closed.period_end)
    if (closedUnder && closedUnder.method !== parsed.method) {
      const month = new Date(`${closed.period_start}T00:00:00Z`).toLocaleDateString("en-US", { month: "long", year: "numeric", timeZone: "UTC" })
      throw new Error(`${month} is closed under the current method. Date the change after ${closed.period_end}, or reopen ${month} first.`)
    }
  }
  const { data, error } = await service.rpc("propose_books_revenue_policy", {
    p_org_id: context.orgId, p_project_id: parsed.projectId, p_contract_id: parsed.contractId, p_method: parsed.method,
    p_billing_method: parsed.billingMethod satisfies RevenueBillingMethod, p_effective_from: parsed.effectiveFrom, p_rationale: parsed.rationale, p_actor_id: context.userId,
  })
  if (error) throw new Error(error.message)
  await recordEvent({ orgId: context.orgId, eventType: "books.revenue_policy_proposed", entityType: "project", entityId: parsed.projectId, payload: { policy_id: data, contract_id: parsed.contractId, method: parsed.method, effective_from: parsed.effectiveFrom } })
  await recordAudit({ orgId: context.orgId, actorId: context.userId, action: "insert", entityType: "books_revenue_policy", entityId: String(data), after: parsed, source: "books.revenue_policy" })
  return { policyId: String(data) }
}

/**
 * Approves or rejects a proposed policy: an accounting judgment, so it takes the
 * close permission. The database refuses the proposer as reviewer.
 */
export async function reviewRevenuePolicy(input: { policyId: string; approve: boolean; note?: string }) {
  const parsed = z.object({ policyId: z.string().uuid(), approve: z.boolean(), note: z.string().trim().max(4000).optional() }).parse(input)
  const context = await requireOrgContext()
  await requireBooksAuthorization({ permission: "books.close", userId: context.userId, orgId: context.orgId, supabase: context.supabase, resourceType: "books_revenue_policy", resourceId: parsed.policyId, logDecision: true })
  const { data, error } = await createServiceSupabaseClient().rpc("review_books_revenue_policy", {
    p_org_id: context.orgId, p_policy_id: parsed.policyId, p_approve: parsed.approve, p_note: parsed.note ?? null, p_actor_id: context.userId,
  })
  if (error) throw new Error(error.message)
  const result = z.object({ policyId: z.string().uuid(), status: z.enum(["approved", "rejected"]), projectId: z.string().uuid() }).parse(data)
  await recordEvent({ orgId: context.orgId, eventType: `books.revenue_policy_${result.status}`, entityType: "project", entityId: result.projectId, payload: { policy_id: parsed.policyId } })
  await recordAudit({ orgId: context.orgId, actorId: context.userId, action: "update", entityType: "books_revenue_policy", entityId: parsed.policyId, after: { status: result.status, note: parsed.note ?? null }, source: "books.revenue_policy" })
  return result
}

/**
 * Jobs that have posted under a policy nobody has reviewed: an inferred
 * baseline still in force on the date. The close reports them; it does not
 * block on them, since the inferred method is the one the books already use.
 */
export async function loadUnreviewedRevenuePolicies(orgId: string, asOf: string) {
  const policies = z.array(policyRowSchema.pick({ id: true, project_id: true, contract_id: true, method: true, billing_method: true, effective_from: true, status: true, reviewed_at: true }))
    .parse(await collectBooksRows((from, to) => createServiceSupabaseClient().from("books_revenue_policies")
      .select("id, project_id, contract_id, method, billing_method, effective_from, status, reviewed_at").eq("org_id", orgId).in("status", ["inferred", "approved"]).order("id").range(from, to)))
  return policies.filter(row => row.status === "inferred" && policyInForce(policies, row.project_id, row.contract_id, asOf)?.id === row.id)
    .map(row => ({ projectId: row.project_id, contractId: row.contract_id, method: row.method }))
}
