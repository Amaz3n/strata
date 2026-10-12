import { readAllRows } from "@/lib/land/paging"
import {
  reconcileDevelopment,
  type DevelopmentJobLedger,
  type DevelopmentPhaseLedger,
} from "@/lib/land/development-reconciliation"
import { requireCommunityScope } from "@/lib/services/communities"
import { requireOrgContext } from "@/lib/services/context"
import { requirePermission } from "@/lib/services/permissions"
import { createServiceSupabaseClient } from "@/lib/supabase/server"

export interface CommunityDevelopmentLedger {
  jobs: Array<DevelopmentJobLedger & { projectName: string }>
  phases: DevelopmentPhaseLedger[]
  /** Development jobs a phase may be linked to: projects in the community's division that are not homes. */
  linkableProjects: Array<{ id: string; name: string }>
}

/** A ceiling on the rows one community's reconciliation reads; past it the read fails rather than reconciling part. */
const LEDGER_ROW_CAP = 50_000
/** The job picker lists this many candidates, most recently created first. */
const LINKABLE_PROJECT_CAP = 200

/**
 * Each development job's budget, commitments and actual cost reconciled to the
 * phases it develops and the lots its cost reached (`reconcileDevelopment`).
 * Read-only: budgets, contracts and allocations are changed on the job's own
 * workbench and in Books.
 *
 * Money is read with the service client after the caller is authorized for the
 * community and for financial reports: a land manager reconciling a phase is not
 * a member of every development job, and the job is walled to the community's
 * division by the database.
 */
export async function getCommunityDevelopmentLedger(communityId: string, orgId?: string): Promise<CommunityDevelopmentLedger> {
  const context = await requireOrgContext(orgId)
  await Promise.all([requirePermission("community.read", context), requirePermission("report.read", context)])
  const community = await requireCommunityScope(communityId, context)
  const service = createServiceSupabaseClient()

  const [phases, lots] = await Promise.all([
    context.supabase.from("community_phases").select("id, development_project_id").eq("org_id", context.orgId).eq("community_id", communityId),
    readAllRows<{ id: string; community_phase_id: string | null; delivered_at: string | null }>(
      (from, to) =>
        context.supabase.from("lots").select("id, community_phase_id, delivered_at")
          .eq("org_id", context.orgId).eq("community_id", communityId).order("id").range(from, to),
      { cap: LEDGER_ROW_CAP, label: "Failed to load the community's lots" },
    ),
  ])
  if (phases.error) throw new Error(`Failed to load phases: ${phases.error.message}`)
  if (lots.truncated) throw new Error("This community has more lots than the development ledger reads")
  const phaseRows = (phases.data ?? []) as Array<{ id: string; development_project_id: string | null }>
  const jobIds = Array.from(new Set(phaseRows.map((phase) => phase.development_project_id).filter((id): id is string => Boolean(id))))

  const empty = { rows: [], truncated: false }
  const [projects, budgets, commitments, costEntries, allocations, candidates] = await Promise.all([
    jobIds.length ? service.from("projects").select("id, name").eq("org_id", context.orgId).in("id", jobIds) : { data: [], error: null },
    jobIds.length ? service.rpc("dashboard_budget_rollup", { p_org_id: context.orgId, p_project_ids: jobIds }) : { data: [], error: null },
    jobIds.length
      ? readAllRows<{ project_id: string; total_cents: number | null }>(
        (from, to) => service.from("commitments").select("project_id, total_cents")
          .eq("org_id", context.orgId).in("project_id", jobIds).in("status", ["approved", "executed"]).order("id").range(from, to),
        { cap: LEDGER_ROW_CAP, label: "Failed to load development commitments" },
      )
      : empty,
    jobIds.length
      ? readAllRows<{ project_id: string; source_type: string | null; cost_cents: number | null }>(
        (from, to) => service.from("job_cost_entries").select("project_id, source_type, cost_cents")
          .eq("org_id", context.orgId).in("project_id", jobIds).eq("status", "posted").order("id").range(from, to),
        { cap: LEDGER_ROW_CAP, label: "Failed to load development cost" },
      )
      : empty,
    jobIds.length
      ? readAllRows<{ project_id: string; status: "proposed" | "approved" | "rejected"; shares: unknown }>(
        (from, to) => service.from("books_development_allocations").select("project_id, status, shares")
          .eq("org_id", context.orgId).in("project_id", jobIds).eq("status", "approved").order("id").range(from, to),
        { cap: LEDGER_ROW_CAP, label: "Failed to load development allocations" },
      )
      : empty,
    // Candidates for the job picker: the community's division, newest first.
    (community.divisionId
      ? service.from("projects").select("id, name").eq("org_id", context.orgId).eq("division_id", community.divisionId)
      : service.from("projects").select("id, name").eq("org_id", context.orgId).is("division_id", null)
    ).in("status", ["planning", "active", "on_hold"]).order("created_at", { ascending: false }).limit(LINKABLE_PROJECT_CAP),
  ])
  for (const result of [projects, budgets, candidates]) {
    if (result.error) throw new Error(`Failed to load the development ledger: ${result.error.message}`)
  }
  if (commitments.truncated || costEntries.truncated || allocations.truncated) {
    throw new Error("This community's development jobs exceed what the ledger reads")
  }
  const candidateRows = (candidates.data ?? []) as Array<{ id: string; name: string }>
  // A home on a lot is never a development job.
  const { data: homes, error: homesError } = candidateRows.length
    ? await service.from("lots").select("project_id").eq("org_id", context.orgId).in("project_id", candidateRows.map((row) => row.id))
    : { data: [], error: null }
  if (homesError) throw new Error(`Failed to load the development ledger: ${homesError.message}`)

  const budgetByJob = new Map(((budgets.data ?? []) as Array<{ project_id: string; budget_cents: number }>).map((row) => [row.project_id, Number(row.budget_cents)]))
  const committedByJob = new Map<string, number>()
  for (const row of commitments.rows) committedByJob.set(row.project_id, (committedByJob.get(row.project_id) ?? 0) + Number(row.total_cents ?? 0))

  const ledger = reconcileDevelopment({
    phases: phaseRows.map((phase) => ({ id: phase.id, developmentProjectId: phase.development_project_id })),
    jobs: jobIds.map((projectId) => ({ projectId, budgetCents: budgetByJob.get(projectId) ?? 0, committedCents: committedByJob.get(projectId) ?? 0 })),
    costEntries: costEntries.rows.map((row) => ({ projectId: row.project_id, sourceType: row.source_type, costCents: Number(row.cost_cents ?? 0) })),
    allocations: allocations.rows.map((row) => ({
      projectId: row.project_id,
      status: row.status,
      shares: (Array.isArray(row.shares) ? row.shares : []).map((share: { lot_id?: unknown; amount_cents?: unknown }) => ({
        lotId: String(share.lot_id ?? ""),
        amountCents: Number(share.amount_cents ?? 0),
      })),
    })),
    lots: lots.rows.map((lot) => ({ id: lot.id, phaseId: lot.community_phase_id, delivered: Boolean(lot.delivered_at) })),
  })

  const projectName = new Map(((projects.data ?? []) as Array<{ id: string; name: string }>).map((row) => [row.id, row.name]))
  const homeIds = new Set(((homes ?? []) as Array<{ project_id: string }>).map((row) => row.project_id))
  return {
    jobs: ledger.jobs.map((job) => ({ ...job, projectName: projectName.get(job.projectId) ?? "Development job" })),
    phases: ledger.phases,
    linkableProjects: candidateRows.filter((project) => !homeIds.has(project.id)),
  }
}
