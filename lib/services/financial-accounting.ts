import "server-only"

import { cache } from "react"
import { accountingProviderLabel } from "@/components/accounting/provider-label"
import type { FinancialAccountingMode } from "@/lib/financials/accounting-experience"
import { requireOrgContext } from "@/lib/services/context"
import { resolveAccountingTarget } from "@/lib/services/accounting-target"
import { selectAccountingMap } from "@/lib/services/accounting-rules"
import { createServiceSupabaseClient } from "@/lib/supabase/server"

/** Request-scoped only: switching ledger authority must never reuse another org's state. */
export const getFinancialAccountingMode = cache(async (orgId?: string, projectId?: string): Promise<FinancialAccountingMode> => {
  const context = await requireOrgContext(orgId)
  const service = createServiceSupabaseClient()
  const { data: settings, error } = await service.from("books_settings")
    .select("workspace_enabled, ledger_authority, arc_ledger_mode, external_sync_posture")
    .eq("org_id", context.orgId).maybeSingle()
  if (error) throw new Error(`Unable to load accounting mode: ${error.message}`)

  const official = settings?.ledger_authority === "arc"
  // A retained provider mapping must not make native accounting depend on a disconnected provider.
  const target = official && settings?.external_sync_posture !== "outbound_mirror"
    ? null : await resolveAccountingTarget({ orgId: context.orgId, projectId })
  const external = target ? {
    provider: target.connection.provider,
    label: accountingProviderLabel(target.connection.provider, target.connection.label),
    healthy: target.healthy,
  } : null
  const ledger = official ? "official"
    : settings?.workspace_enabled && settings.arc_ledger_mode === "parallel" ? "parallel"
    : settings?.workspace_enabled && settings.arc_ledger_mode === "shadow" ? "shadow"
    : external ? "external" : "none"
  return { ledger, external, externalSyncPosture: settings?.external_sync_posture ?? "normal" }
})

/**
 * Resolve the accounting presentation for a portfolio without issuing the
 * project/lot/map/connection query sequence once per row. Ledger authority is
 * org-wide; only the external routing target varies by project.
 */
export async function getFinancialAccountingModesForProjects(
  orgId: string,
  projectIds: string[],
): Promise<Record<string, FinancialAccountingMode>> {
  const context = await requireOrgContext(orgId)
  const service = createServiceSupabaseClient()
  const ids = [...new Set(projectIds.filter(Boolean))]
  if (ids.length === 0) return {}

  const [settingsResult, projectsResult, lotsResult, mapsResult, connectionsResult] = await Promise.all([
    service.from("books_settings").select("workspace_enabled, ledger_authority, arc_ledger_mode, external_sync_posture").eq("org_id", context.orgId).maybeSingle(),
    service.from("projects").select("id,division_id").eq("org_id", context.orgId).in("id", ids),
    service.from("lots").select("project_id,community_id").eq("org_id", context.orgId).in("project_id", ids),
    service.from("accounting_entity_map").select("id,org_id,connection_id,scope,division_id,community_id,project_id,dimensions").eq("org_id", context.orgId),
    service.from("accounting_connections").select("id,provider,label,status").eq("org_id", context.orgId),
  ])
  const firstError = [settingsResult.error, projectsResult.error, lotsResult.error, mapsResult.error, connectionsResult.error].find(Boolean)
  if (firstError) throw new Error(`Unable to load portfolio accounting modes: ${firstError.message}`)

  const settings = settingsResult.data
  const official = settings?.ledger_authority === "arc"
  const externalSyncPosture = settings?.external_sync_posture ?? "normal"
  const ledger = official ? "official"
    : settings?.workspace_enabled && settings.arc_ledger_mode === "parallel" ? "parallel"
    : settings?.workspace_enabled && settings.arc_ledger_mode === "shadow" ? "shadow"
    : null
  const projects = new Map((projectsResult.data ?? []).map((row) => [row.id, row]))
  const communities = new Map((lotsResult.data ?? []).flatMap((row) => row.project_id ? [[row.project_id, row.community_id]] : []))
  const connections = new Map((connectionsResult.data ?? []).map((row) => [row.id, row]))
  const maps = mapsResult.data ?? []

  return Object.fromEntries(ids.map((projectId) => {
    if (official && externalSyncPosture !== "outbound_mirror") {
      return [projectId, { ledger: "official", external: null, externalSyncPosture } satisfies FinancialAccountingMode]
    }
    const project = projects.get(projectId)
    const communityId = communities.get(projectId)
    const candidates = maps.filter((row) =>
      row.project_id === projectId ||
      (communityId && row.community_id === communityId) ||
      (project?.division_id && row.division_id === project.division_id) ||
      (!row.project_id && !row.community_id && !row.division_id),
    )
    const selected = selectAccountingMap(candidates)
    const connection = selected ? connections.get(selected.winner.connection_id) : null
    const external = connection && connection.status !== "disconnected" ? {
      provider: connection.provider,
      label: accountingProviderLabel(connection.provider, connection.label),
      healthy: connection.status === "active",
    } : null
    return [projectId, {
      ledger: ledger ?? (external ? "external" : "none"),
      external,
      externalSyncPosture,
    } satisfies FinancialAccountingMode]
  }))
}
