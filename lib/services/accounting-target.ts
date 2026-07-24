import { createServiceSupabaseClient } from "@/lib/supabase/server"
import { requireOrgContext } from "@/lib/services/context"
import { requirePermission } from "@/lib/services/permissions"
import { recordAudit } from "@/lib/services/audit"
import { recordEvent } from "@/lib/services/events"
import type {
  AccountingConnection,
  AccountingDimensionKind,
  AccountingDimensionValue,
  AccountingProviderKey,
  AccountingTarget,
} from "@/lib/integrations/accounting/provider"
import { selectAccountingMap } from "@/lib/services/accounting-rules"
import { requireAccountingConnectionForOrg } from "@/lib/services/accounting-connections"
import { getProvider } from "@/lib/integrations/accounting/registry"

type EntityMapRow = {
  id: string
  org_id: string
  connection_id: string
  scope: AccountingTarget["resolvedFrom"]
  division_id: string | null
  community_id: string | null
  project_id: string | null
  dimensions: Partial<Record<AccountingDimensionKind, AccountingDimensionValue>> | null
}

type ConnectionRow = {
  id: string
  org_id: string
  provider: AccountingProviderKey
  label: string
  external_account_id: string
  external_account_name: string | null
  status: AccountingConnection["status"]
  settings: Record<string, unknown> | null
  connected_at: string
  last_sync_at: string | null
  last_error: string | null
}

function mapConnection(row: ConnectionRow): AccountingConnection {
  return {
    id: row.id,
    orgId: row.org_id,
    provider: row.provider,
    label: row.label,
    externalAccountId: row.external_account_id,
    externalAccountName: row.external_account_name,
    status: row.status,
    settings: row.settings ?? {},
    connectedAt: row.connected_at,
    lastSyncAt: row.last_sync_at,
    lastError: row.last_error,
  }
}

export async function resolveAccountingTarget(input: { orgId: string; projectId?: string | null }): Promise<AccountingTarget | null> {
  const supabase = createServiceSupabaseClient()
  let divisionId: string | null = null
  let communityId: string | null = null

  if (input.projectId) {
    const [{ data: project }, { data: lot }] = await Promise.all([
      supabase.from("projects").select("division_id").eq("org_id", input.orgId).eq("id", input.projectId).maybeSingle(),
      supabase.from("lots").select("community_id").eq("org_id", input.orgId).eq("project_id", input.projectId).maybeSingle(),
    ])
    divisionId = project?.division_id ?? null
    communityId = lot?.community_id ?? null
  }

  const candidates = [
    input.projectId ? `project_id.eq.${input.projectId}` : null,
    communityId ? `community_id.eq.${communityId}` : null,
    divisionId ? `division_id.eq.${divisionId}` : null,
    "and(project_id.is.null,community_id.is.null,division_id.is.null)",
  ].filter((value): value is string => Boolean(value))

  const { data, error } = await supabase
    .from("accounting_entity_map")
    .select("id,org_id,connection_id,scope,division_id,community_id,project_id,dimensions")
    .eq("org_id", input.orgId)
    .or(candidates.join(","))
  if (error) throw new Error(`Unable to resolve accounting target: ${error.message}`)

  const rows = (data ?? []) as EntityMapRow[]
  const selected = selectAccountingMap(rows)
  if (!selected) return null
  const { winner, dimensions } = selected

  const { data: connection, error: connectionError } = await supabase
    .from("accounting_connections")
    .select("id,org_id,provider,label,external_account_id,external_account_name,status,settings,connected_at,last_sync_at,last_error")
    .eq("org_id", input.orgId)
    .eq("id", winner.connection_id)
    .maybeSingle()
  if (connectionError || !connection) throw new Error(connectionError?.message ?? "Accounting connection not found")

  const mapped = mapConnection(connection as ConnectionRow)
  return { connection: mapped, dimensions, resolvedFrom: winner.scope, healthy: mapped.status === "active" }
}

export async function countSyncedTransactionsForProject(projectId: string, connectionId: string, orgId: string): Promise<number> {
  const supabase = createServiceSupabaseClient()
  const [{ data: invoices }, { data: expenses }, { data: bills }] = await Promise.all([
    supabase.from("invoices").select("id").eq("org_id", orgId).eq("project_id", projectId),
    supabase.from("project_expenses").select("id").eq("org_id", orgId).eq("project_id", projectId),
    supabase.from("vendor_bills").select("id").eq("org_id", orgId).eq("project_id", projectId),
  ])
  const entityIds = [...(invoices ?? []), ...(expenses ?? []), ...(bills ?? [])].map((row) => row.id)
  if (entityIds.length === 0) return 0
  const { count, error } = await supabase
    .from("accounting_sync_records")
    .select("id", { count: "exact", head: true })
    .eq("org_id", orgId)
    .eq("connection_id", connectionId)
    .in("entity_id", entityIds)
    .neq("external_id", "")
  if (error) throw new Error(`Unable to inspect synced transactions: ${error.message}`)
  return count ?? 0
}

async function countSyncedTransactionsForScope(input: {
  orgId: string
  connectionId: string
  projectId?: string | null
  divisionId?: string | null
  communityId?: string | null
}) {
  const supabase = createServiceSupabaseClient()
  if (!input.projectId && !input.divisionId && !input.communityId) {
    const { count, error } = await supabase.from("accounting_sync_records")
      .select("id", { count: "exact", head: true })
      .eq("org_id", input.orgId)
      .eq("connection_id", input.connectionId)
      .neq("external_id", "")
    if (error) throw new Error(`Unable to inspect synced transactions: ${error.message}`)
    return count ?? 0
  }

  let projectIds: string[] = []
  if (input.projectId) projectIds = [input.projectId]
  else if (input.divisionId) {
    const { data } = await supabase.from("projects").select("id").eq("org_id", input.orgId).eq("division_id", input.divisionId)
    projectIds = (data ?? []).map((row) => row.id)
  } else if (input.communityId) {
    const { data } = await supabase.from("lots").select("project_id").eq("org_id", input.orgId).eq("community_id", input.communityId).not("project_id", "is", null)
    projectIds = (data ?? []).flatMap((row) => row.project_id ? [row.project_id] : [])
  }
  if (projectIds.length === 0) return 0
  const [{ data: invoices }, { data: expenses }, { data: bills }, { data: payments }] = await Promise.all([
    supabase.from("invoices").select("id").eq("org_id", input.orgId).in("project_id", projectIds),
    supabase.from("project_expenses").select("id").eq("org_id", input.orgId).in("project_id", projectIds),
    supabase.from("vendor_bills").select("id").eq("org_id", input.orgId).in("project_id", projectIds),
    supabase.from("payments").select("id").eq("org_id", input.orgId).in("project_id", projectIds),
  ])
  const entityIds = [...(invoices ?? []), ...(expenses ?? []), ...(bills ?? []), ...(payments ?? [])].map((row) => row.id)
  if (entityIds.length === 0) return 0
  const { count, error } = await supabase.from("accounting_sync_records")
    .select("id", { count: "exact", head: true })
    .eq("org_id", input.orgId)
    .eq("connection_id", input.connectionId)
    .in("entity_id", entityIds)
    .neq("external_id", "")
  if (error) throw new Error(`Unable to inspect synced transactions: ${error.message}`)
  return count ?? 0
}

export async function upsertAccountingEntityMap(input: {
  id?: string
  connectionId: string
  divisionId?: string | null
  communityId?: string | null
  projectId?: string | null
  dimensions: Partial<Record<AccountingDimensionKind, AccountingDimensionValue>>
  acknowledgeResync?: boolean
}) {
  const context = await requireOrgContext()
  await requirePermission("accounting.entity_map.manage", context)
  const supabase = createServiceSupabaseClient()
  const connection = await requireAccountingConnectionForOrg(input.connectionId, context.orgId, { activeOnly: true })
  const supportedDimensions = new Set(getProvider(connection.provider).capabilities.dimensions)
  const unsupportedDimension = Object.keys(input.dimensions).find((key) => !supportedDimensions.has(key as AccountingDimensionKind))
  if (unsupportedDimension) throw new Error(`${connection.label} does not support the ${unsupportedDimension} accounting dimension`)

  const scopeChecks = [
    input.projectId ? supabase.from("projects").select("id").eq("org_id", context.orgId).eq("id", input.projectId).maybeSingle() : null,
    input.divisionId ? supabase.from("divisions").select("id").eq("org_id", context.orgId).eq("id", input.divisionId).maybeSingle() : null,
    input.communityId ? supabase.from("communities").select("id").eq("org_id", context.orgId).eq("id", input.communityId).maybeSingle() : null,
  ].filter((query): query is Exclude<typeof query, null> => query !== null)
  const scopeResults = await Promise.all(scopeChecks)
  if (scopeResults.some((result) => result.error || !result.data)) throw new Error("Accounting mapping scope not found for this organization")

  const { data: current } = input.id
    ? await supabase.from("accounting_entity_map").select("*").eq("org_id", context.orgId).eq("id", input.id).maybeSingle()
    : { data: null }
  if (current && current.connection_id !== input.connectionId) {
    const count = await countSyncedTransactionsForScope({
      orgId: context.orgId,
      connectionId: current.connection_id,
      projectId: current.project_id,
      divisionId: current.division_id,
      communityId: current.community_id,
    })
    if (count > 0 && !input.acknowledgeResync) {
      throw new Error(`This routing scope has ${count} synced transaction${count === 1 ? "" : "s"}; its accounting connection cannot be changed without acknowledgement.`)
    }
    if (count > 0) await requirePermission("org.admin", context)
  }

  const payload = {
    org_id: context.orgId,
    connection_id: input.connectionId,
    division_id: input.divisionId ?? null,
    community_id: input.communityId ?? null,
    project_id: input.projectId ?? null,
    dimensions: input.dimensions,
    created_by: context.userId,
    ...(input.acknowledgeResync
      ? { reassignment_acknowledged_at: new Date().toISOString(), reassignment_acknowledged_by: context.userId }
      : {}),
  }
  const query = input.id
    ? supabase.from("accounting_entity_map").update(payload).eq("org_id", context.orgId).eq("id", input.id)
    : supabase.from("accounting_entity_map").insert(payload)
  const { data, error } = await query.select("*").single()
  if (error) throw new Error(`Unable to save accounting mapping: ${error.message}`)

  await Promise.all([
    recordAudit({ orgId: context.orgId, actorId: context.userId, action: input.id ? "update" : "insert", entityType: "accounting_entity_map", entityId: data.id, before: current, after: data }),
    recordEvent({ orgId: context.orgId, actorId: context.userId, eventType: current?.connection_id !== input.connectionId && current ? "accounting_connection_reassigned" : "accounting_entity_map_updated", entityType: "accounting_entity_map", entityId: data.id, payload: { scope: data.scope, connection_id: input.connectionId } }),
  ])
  return data
}

export async function getProjectAccountingLink(input: { projectId: string; orgId?: string }) {
  const { orgId } = await requireOrgContext(input.orgId)
  const supabase = createServiceSupabaseClient()
  const { data: projectMap } = await supabase.from("accounting_entity_map")
    .select("id,connection_id,dimensions").eq("org_id", orgId).eq("project_id", input.projectId).maybeSingle()
  const target = await resolveAccountingTarget({ orgId, projectId: input.projectId })
  return {
    mapId: projectMap?.id ?? null,
    connectionId: target?.connection.id ?? null,
    accountingCustomerId: target?.dimensions.customer?.id ?? null,
    accountingCustomerName: target?.dimensions.customer?.name ?? null,
    qboCustomerId: target?.dimensions.customer?.id ?? null,
    qboCustomerName: target?.dimensions.customer?.name ?? null,
    target,
  }
}
