import "server-only"

import { getProjectPosture } from "@/lib/product-tier"
import { listReports, type ReportCatalogGroup, groupReports } from "@/lib/reports/registry"
import type { ReportAvailabilityContext, ReportDefinition, ReportScopeContext } from "@/lib/reports/types"
import { requireOrgContext } from "@/lib/services/context"
import { getAmbientDeskContext } from "@/lib/services/desk-context"
import { getCurrentUserPermissions, requireProjectPermission } from "@/lib/services/permissions"

/**
 * Assembles what the catalog and the viewer need: the ambient lens, the posture,
 * and the permission list. Scope is resolved here once and threaded through, so
 * no report has to re-derive it.
 */

export interface ReportScopeResolution {
  context: ReportScopeContext
  permissions: string[]
  availability: Omit<ReportAvailabilityContext, "scope" | "posture">
}

/**
 * The data gates behind `available()`. Head counts only — each answers "does
 * this org have any of the thing", which is what decides whether a report can
 * possibly say something. Errors read as absent rather than failing the catalog.
 */
async function getReportAvailability(): Promise<ReportScopeResolution["availability"]> {
  const { supabase, orgId } = await requireOrgContext()
  const exists = async (query: PromiseLike<{ count: number | null; error: unknown }>) => {
    const { count, error } = await query
    return !error && (count ?? 0) > 0
  }

  const [hasCommunities, hasPayApplications, hasDrawSchedules, hasPrequalifications, hasArcBooks] = await Promise.all([
    exists(
      supabase.from("communities").select("id", { count: "exact", head: true }).eq("org_id", orgId).is("archived_at", null),
    ),
    exists(supabase.from("pay_applications").select("id", { count: "exact", head: true }).eq("org_id", orgId)),
    exists(supabase.from("draw_schedules").select("id", { count: "exact", head: true }).eq("org_id", orgId)),
    exists(supabase.from("prequalifications").select("id", { count: "exact", head: true }).eq("org_id", orgId)),
    exists(supabase.from("books_settings").select("id", { count: "exact", head: true }).eq("org_id", orgId).eq("workspace_enabled", true)),
  ])

  return { hasCommunities, hasPayApplications, hasDrawSchedules, hasPrequalifications, hasArcBooks }
}

export async function resolveOrgReportScope(): Promise<ReportScopeResolution> {
  const [{ permissions }, ambient, context, availability] = await Promise.all([
    getCurrentUserPermissions(),
    getAmbientDeskContext(),
    requireOrgContext(),
    getReportAvailability(),
  ])

  const community = ambient.communities.find((entry) => entry.id === ambient.communityId)
  const division = ambient.divisions.find((entry) => entry.id === ambient.divisionId)

  return {
    permissions,
    availability,
    context: {
      scope: "org",
      divisionId: ambient.divisionId,
      communityId: ambient.communityId,
      divisionLabel: division?.name,
      communityLabel: community?.name,
      scopeLabel: "Organization-wide",
      posture: getProjectPosture(null, context.productTier),
    },
  }
}

/**
 * Route-side entry point: resolves the project itself, permission-checked, so an
 * API handler does not have to reach into the project page's server actions.
 */
export async function resolveProjectReportScopeById(projectId: string): Promise<ReportScopeResolution | null> {
  const { supabase, orgId, userId } = await requireOrgContext()
  await requireProjectPermission(userId, projectId, "project.read")

  const { data, error } = await supabase
    .from("projects")
    .select("id, name, property_type")
    .eq("org_id", orgId)
    .eq("id", projectId)
    .maybeSingle()

  if (error || !data) return null
  return resolveProjectReportScope(data)
}

export async function resolveProjectReportScope(project: {
  id: string
  name: string
  property_type?: string | null
}): Promise<ReportScopeResolution> {
  const [{ permissions }, context, availability] = await Promise.all([
    getCurrentUserPermissions(),
    requireOrgContext(),
    getReportAvailability(),
  ])

  return {
    permissions,
    availability,
    context: {
      scope: "project",
      projectId: project.id,
      projectName: project.name,
      scopeLabel: project.name,
      posture: getProjectPosture(project.property_type, context.productTier),
    },
  }
}

function catalogFilter(resolution: ReportScopeResolution) {
  return {
    scope: resolution.context.scope,
    posture: resolution.context.posture,
    ...resolution.availability,
    permissions: resolution.permissions,
  }
}

/** Catalog rows this membership can actually open at this scope. */
export function catalogFor(resolution: ReportScopeResolution): ReportCatalogGroup[] {
  return groupReports(listReports(catalogFilter(resolution)), resolution.context.posture)
}

/** True when this membership may open this specific report at this scope. */
export function canRunReport(resolution: ReportScopeResolution, definition: ReportDefinition): boolean {
  return listReports(catalogFilter(resolution)).some((candidate) => candidate.slug === definition.slug)
}
