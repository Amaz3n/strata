import "server-only"

import { type RevenueRecognitionBasis } from "@/lib/financials/billing-model"
import { z } from "zod"

import { primaryContractsInForce, resolveProjectRevenueBasis } from "@/lib/financials/project-revenue-basis"
import { inferRevenuePolicy, policyInForce, REVENUE_METHOD_LABELS, type AppliedRevenuePolicy, type RevenueBillingMethod } from "@/lib/financials/revenue-policy"
import { todayIsoDateOnly } from "@/lib/services/reports/dates"
import { createServiceSupabaseClient } from "@/lib/supabase/server"

const PAGE_SIZE = 500

const revenuePolicyRecordSchema = z.object({
  id: z.string(),
  project_id: z.string(),
  contract_id: z.string().nullable(),
  method: z.enum(["percentage_of_completion", "closing"]),
  billing_method: z.enum(["fixed_price", "cost_plus_percent", "cost_plus_fixed_fee", "cost_plus_gmp", "time_and_materials", "purchase_agreement"]),
  effective_from: z.string(),
  status: z.enum(["inferred", "proposed", "approved", "rejected"]),
  reviewed_at: z.string().nullable(),
})

async function collectPages<T>(
  loadPage: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>,
  label: string,
): Promise<T[]> {
  const rows: T[] = []
  for (let page = 0; ; page += 1) {
    const from = page * PAGE_SIZE
    const { data, error } = await loadPage(from, from + PAGE_SIZE - 1)
    if (error) throw new Error(`Failed to load ${label}: ${error.message}`)
    const batch = data ?? []
    rows.push(...batch)
    if (batch.length < PAGE_SIZE) return rows
  }
}

export type ProjectRevenueBasis = {
  projectId: string
  status: string | null
  /** The one method the job earns under, or null when its contracts earn differently under approved policies. */
  basis: RevenueRecognitionBasis | null
  /** Primary contracts in force on the date; two or more means policy and WIP per contract. */
  contractIds: string[]
  /** The policy applied to the project ("") or to each contract when it has several. */
  policies: Record<string, AppliedRevenuePolicy>
}

type InferredBaseline = { project_id: string; contract_id: string | null; method: RevenueRecognitionBasis; billing_method: RevenueBillingMethod }

/**
 * How every project in an organization earns revenue on any date: the
 * recorded policy in force (`policyInForce`), else what the billing settings
 * say through `getProjectFinancialFeatureConfig`. Books' projector, revenue
 * recognition and the period-close WIP check all read this rather than
 * inspecting `property_type`. A job whose contracts earn differently is allowed
 * only when each contract's policy has been approved; otherwise the conflict is
 * refused with the cure.
 */
export async function loadRevenuePolicyResolver(orgId: string) {
  const service = createServiceSupabaseClient()
  const [projects, settings, contracts, records] = await Promise.all([
    // Every paged read carries a total order. Without one, PostgREST is free to
    // return a different slice per page, so a project can be skipped outright and
    // the posture that decides its revenue basis silently goes missing.
    collectPages(
      (from, to) => service.from("projects").select("id, name, status, property_type").eq("org_id", orgId).order("id", { ascending: true }).range(from, to),
      "projects for revenue basis",
    ),
    collectPages(
      (from, to) => service.from("project_financial_settings").select("project_id, billing_model, fixed_price_billing_basis").eq("org_id", orgId).order("project_id", { ascending: true }).range(from, to),
      "project financial settings",
    ),
    collectPages(
      (from, to) => service.from("contracts").select("id, project_id, status, parent_contract_id, effective_date, contract_type, fixed_fee_cents, gmp_cents, snapshot, open_book, requires_client_cost_approval").eq("org_id", orgId).order("id", { ascending: true }).range(from, to),
      "contracts for revenue basis",
    ),
    collectPages(
      (from, to) => service.from("books_revenue_policies").select("id, project_id, contract_id, method, billing_method, effective_from, status, reviewed_at").eq("org_id", orgId).in("status", ["inferred", "approved"]).order("id", { ascending: true }).range(from, to),
      "revenue policies",
    ),
  ])
  const policies = z.array(revenuePolicyRecordSchema).parse(records)
  const settingsByProject = new Map(settings.map((row) => [String(row.project_id), row]))
  const contractsByProject = new Map<string, typeof contracts>()
  for (const contract of contracts) {
    const projectId = String(contract.project_id)
    const group = contractsByProject.get(projectId) ?? []
    group.push(contract)
    contractsByProject.set(projectId, group)
  }
  const projectById = new Map(projects.map((project) => [String(project.id), project]))
  const unrecorded = new Map<string, InferredBaseline>()

  const resolve = (projectId: string, date: string): ProjectRevenueBasis => {
    const project = projectById.get(projectId)
    if (!project) throw new Error(`Project ${projectId} is outside this organization`)
    const financialSettings = settingsByProject.get(projectId)
    const posture = {
      id: projectId,
      status: project.status ?? undefined,
      property_type: project.property_type ?? undefined,
      financial_settings: financialSettings
        ? { billing_model: financialSettings.billing_model ?? undefined, fixed_price_billing_basis: financialSettings.fixed_price_billing_basis ?? null }
        : null,
    }
    const projectContracts = contractsByProject.get(projectId) ?? []
    const primaries = primaryContractsInForce(projectId, projectContracts, date)
    const scopes = primaries.length > 1 ? primaries : [null]
    const applied: Record<string, AppliedRevenuePolicy> = {}
    for (const contract of scopes) {
      const record = policyInForce(policies, projectId, contract?.id ?? null, date)
      if (record) {
        applied[contract?.id ?? ""] = { method: record.method, billingMethod: record.billing_method, source: record.status === "approved" ? "approved" : "inferred", policyId: record.id }
        continue
      }
      const inferred = inferRevenuePolicy(posture, contract ?? primaries[0] ?? null)
      // A project with one contract keeps the established checks (superseded-only evidence).
      const method = contract ? inferred.method : resolveProjectRevenueBasis(posture, projectContracts, date)
      applied[contract?.id ?? ""] = { method, billingMethod: inferred.billingMethod, source: "unrecorded", policyId: null }
      unrecorded.set(`${projectId}:${contract?.id ?? ""}`, { project_id: projectId, contract_id: contract?.id ?? null, method, billing_method: inferred.billingMethod })
    }
    const methods = new Set(Object.values(applied).map((policy) => policy.method))
    if (methods.size > 1 && Object.values(applied).some((policy) => policy.source !== "approved")) {
      throw new Error(`${project.name ?? projectId} has contracts that earn revenue differently (${[...methods].map((method) => REVENUE_METHOD_LABELS[method]).join(" and ")}). Approve a revenue policy for each of its contracts before posting or closing.`)
    }
    return {
      projectId,
      status: project.status ? String(project.status) : null,
      basis: methods.size === 1 ? [...methods][0] : null,
      contractIds: primaries.map((contract) => contract.id),
      policies: applied,
    }
  }

  return {
    projectIds: projects.map((project) => String(project.id)),
    resolve,
    /**
     * The policy one document earns under, on its own date. On a job whose
     * contracts earn differently, the document must name its contract.
     */
    forDocument(projectId: string, contractId: string | null, date: string): AppliedRevenuePolicy {
      const resolved = resolve(projectId, date)
      if (resolved.basis) return resolved.policies[contractId && resolved.policies[contractId] ? contractId : ""] ?? Object.values(resolved.policies)[0]
      const policy = contractId ? resolved.policies[contractId] : undefined
      if (!policy) throw new Error("This job's contracts earn revenue differently, so each invoice must name the contract it bills.")
      return policy
    },
    /** Baselines inferred while resolving that are not recorded yet. */
    unrecorded: () => [...unrecorded.values()],
  }
}

/** Records the inferred baselines so a later change of billing settings cannot rewrite them. */
export async function recordInferredRevenuePolicies(orgId: string, baselines: InferredBaseline[]) {
  if (baselines.length === 0) return 0
  const { data, error } = await createServiceSupabaseClient().rpc("record_books_inferred_revenue_policies", { p_org_id: orgId, p_policies: baselines })
  if (error) throw new Error(`Failed to record inferred revenue policies: ${error.message}`)
  return Number(data ?? 0)
}

export async function loadProjectRevenueBases(orgId: string, asOf = todayIsoDateOnly()): Promise<ProjectRevenueBasis[]> {
  const resolver = await loadRevenuePolicyResolver(orgId)
  return resolver.projectIds.map((projectId) => resolver.resolve(projectId, asOf))
}

export async function loadRevenueBasisByProject(orgId: string) {
  const rows = await loadProjectRevenueBases(orgId)
  return new Map(rows.map((row) => [row.projectId, row.basis]))
}
