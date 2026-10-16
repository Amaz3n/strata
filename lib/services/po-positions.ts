import { readAllRows } from "@/lib/land/paging"
import { classifyPoPosition, type PoPosition, type PoPositionException } from "@/lib/purchasing/po-position"
import { requireAuthorization } from "@/lib/services/authorization"
import { requireOrgContext } from "@/lib/services/context"
import { resolvePurchasingQueueReadScope } from "@/lib/services/purchasing-queue-scope"
import { createServiceSupabaseClient } from "@/lib/supabase/server"

export type PoPositionRow = PoPosition & { companyName: string | null; projectName: string | null; exceptions: PoPositionException[] }

type ViewRow = {
  project_id: string; commitment_id: string; title: string | null; contract_number: string | null; company_id: string | null
  status: string; division_id: string | null; community_id: string | null; pay_on_po: boolean
  original_cents: number; approved_vpo_cents: number; pending_vpo_count: number; billed_cents: number; paid_cents: number
  retainage_held_cents: number; completion_billed_cents: number; open_completion_count: number; unclaimed_vpo_cents: number
  open_vendor_credit_cents: number
}

const POSITION_SELECT = `project_id, commitment_id, title, contract_number, company_id, status, division_id, community_id, pay_on_po,
  original_cents, approved_vpo_cents, pending_vpo_count, billed_cents, paid_cents, retainage_held_cents, completion_billed_cents,
  open_completion_count, unclaimed_vpo_cents, open_vendor_credit_cents`

/** A home's purchase orders are dozens; an org-wide scan stops here and says so. */
export const PO_POSITION_SCAN_CAP = 5000
const MEMBERSHIP_PROJECT_LIMIT = 300

function toPosition(row: ViewRow): PoPosition {
  return {
    commitmentId: row.commitment_id, projectId: row.project_id, title: row.title ?? "Purchase order",
    contractNumber: row.contract_number, companyId: row.company_id, status: row.status,
    divisionId: row.division_id, communityId: row.community_id, payOnPo: row.pay_on_po,
    originalCents: Number(row.original_cents), approvedVpoCents: Number(row.approved_vpo_cents),
    pendingVpoCount: Number(row.pending_vpo_count), billedCents: Number(row.billed_cents), paidCents: Number(row.paid_cents),
    retainageHeldCents: Number(row.retainage_held_cents), completionBilledCents: Number(row.completion_billed_cents),
    openCompletionCount: Number(row.open_completion_count), unclaimedVpoCents: Number(row.unclaimed_vpo_cents),
    openVendorCreditCents: Number(row.open_vendor_credit_cents),
  }
}

function mapRow(row: ViewRow, names: { companies: Map<string, string>; projects: Map<string, string> }): PoPositionRow {
  const position = toPosition(row)
  return {
    ...position,
    companyName: row.company_id ? names.companies.get(row.company_id) ?? null : null,
    projectName: names.projects.get(row.project_id) ?? null,
    exceptions: classifyPoPosition(position),
  }
}

async function resolveNames(reader: ReturnType<typeof createServiceSupabaseClient>, orgId: string, rows: ViewRow[]) {
  const companyIds = [...new Set(rows.map((row) => row.company_id).filter((id): id is string => Boolean(id)))]
  const projectIds = [...new Set(rows.map((row) => row.project_id))]
  const [companies, projects] = await Promise.all([
    companyIds.length ? reader.from("companies").select("id,name").eq("org_id", orgId).in("id", companyIds.slice(0, 300)) : { data: [], error: null },
    projectIds.length ? reader.from("projects").select("id,name").eq("org_id", orgId).in("id", projectIds.slice(0, 300)) : { data: [], error: null },
  ])
  if (companies.error) throw new Error(`Failed to load vendors: ${companies.error.message}`)
  if (projects.error) throw new Error(`Failed to load homes: ${projects.error.message}`)
  return {
    companies: new Map((companies.data ?? []).map((row) => [String(row.id), String(row.name)])),
    projects: new Map((projects.data ?? []).map((row) => [String(row.id), String(row.name)])),
  }
}

/** One home's purchase orders for the workbench's reconciliation section. */
export async function getProjectPoPositions(projectId: string, orgId?: string): Promise<{ rows: PoPositionRow[]; truncated: boolean }> {
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  await requireAuthorization({ permission: "commitment.read", userId, orgId: resolvedOrgId, projectId, supabase, logDecision: true, resourceType: "project", resourceId: projectId })
  // Authorized against the home above; the view is read with the service role and the explicit org and project predicates.
  const reader = createServiceSupabaseClient()
  const { data, error } = await reader.from("purchase_order_positions").select(POSITION_SELECT)
    .eq("org_id", resolvedOrgId).eq("project_id", projectId).order("title").limit(PO_POSITION_SCAN_CAP + 1).returns<ViewRow[]>()
  if (error) throw new Error(`Failed to load purchase-order positions: ${error.message}`)
  const rows = (data ?? []).slice(0, PO_POSITION_SCAN_CAP)
  const names = await resolveNames(reader, resolvedOrgId, rows)
  return { rows: rows.map((row) => mapRow(row, names)), truncated: (data?.length ?? 0) > PO_POSITION_SCAN_CAP }
}

/**
 * The purchase orders in the desk's ambient scope that the books disagree
 * about. Read-only: any fix is the workbench's action on the PO.
 */
export async function listPoPositionExceptions(filters: { divisionId?: string | null; communityId?: string | null; limit?: number } = {}, orgId?: string) {
  const context = await requireOrgContext(orgId)
  const { supabase, orgId: resolvedOrgId, userId } = context
  await requireAuthorization({ permission: "price_book.read", userId, orgId: resolvedOrgId, supabase, logDecision: true })
  const scope = await resolvePurchasingQueueReadScope(context, filters.divisionId)
  if (scope.divisionIds?.length === 0) return { rows: [], total: 0, truncated: false }
  const reader = createServiceSupabaseClient()
  let projectIds: string[] | null = null
  if (scope.projectMembershipRequired) {
    const { data, error } = await reader.from("project_members").select("project_id").eq("org_id", resolvedOrgId).eq("user_id", userId).eq("status", "active").limit(MEMBERSHIP_PROJECT_LIMIT + 1)
    if (error) throw new Error(`Failed to scope purchase-order positions: ${error.message}`)
    if ((data?.length ?? 0) > MEMBERSHIP_PROJECT_LIMIT) throw new Error("Too many assigned homes to scan purchase-order positions; narrow the community lens")
    projectIds = (data ?? []).map((row) => String(row.project_id))
    if (projectIds.length === 0) return { rows: [], total: 0, truncated: false }
  }
  const scan = await readAllRows<ViewRow>((from, to) => {
    let query = reader.from("purchase_order_positions").select(POSITION_SELECT).eq("org_id", resolvedOrgId)
    if (scope.divisionIds) query = query.in("division_id", scope.divisionIds)
    if (filters.communityId) query = query.eq("community_id", filters.communityId)
    if (projectIds) query = query.in("project_id", projectIds)
    return query.order("commitment_id").range(from, to).returns<ViewRow[]>()
  }, { cap: PO_POSITION_SCAN_CAP, pageSize: 1000, label: "Failed to scan purchase-order positions" })
  const flagged = scan.rows.filter((row) => classifyPoPosition(toPosition(row)).length > 0)
  const shown = flagged.slice(0, filters.limit ?? 25)
  const names = await resolveNames(reader, resolvedOrgId, shown)
  return { rows: shown.map((row) => mapRow(row, names)), total: flagged.length, truncated: scan.truncated }
}
