import { requireAuthorization } from "@/lib/services/authorization"
import { readAllRowsById } from "@/lib/land/paging"
import { safetyWorkspaceQuerySchema, safetyWorkspaceCursorSchema, safetyRowIdentitySchema, toolboxTalkRecordSchema, toolboxTalkSummarySchema } from "@/lib/validation/safety"
import { recordAudit } from "@/lib/services/audit"
import { requireOrgContext } from "@/lib/services/context"
import { recordEvent } from "@/lib/services/events"
import { requirePermission } from "@/lib/services/permissions"
import { insertWithProjectNumberRetry } from "@/lib/services/project-sequence"
import { resolveProjectLocation } from "@/lib/services/locations"
import {
  observationInputSchema,
  observationUpdateSchema,
  safetyIncidentInputSchema,
  safetyIncidentUpdateSchema,
  toolboxTalkInputSchema,
  type ObservationInput,
  type ObservationUpdate,
  type SafetyIncidentInput,
  type SafetyIncidentUpdate,
  type ToolboxTalkInput,
} from "@/lib/validation/safety"

export type SafetyIncident = {
  id: string
  org_id: string
  project_id: string
  incident_number: number
  occurred_at: string
  severity: "near_miss" | "first_aid" | "medical_treatment" | "lost_time" | "fatality"
  classification: string | null
  location: string | null
  location_id: string | null
  description: string
  involved_company_id: string | null
  involved_company_name?: string | null
  involved_person_name: string | null
  witness_names: string | null
  immediate_action: string | null
  photo_file_id: string | null
  root_cause: string | null
  is_osha_recordable: boolean
  reported_by: string | null
  status: "open" | "under_review" | "closed"
  closed_at: string | null
  created_at: string
  updated_at: string
}

export type ToolboxTalk = {
  id: string
  org_id: string
  project_id: string
  held_at: string
  topic: string
  notes: string | null
  presenter_name: string | null
  presenter_user_id: string | null
  attendee_count: number | null
  attendees: Array<{ name: string; company?: string | null }>
  file_id: string | null
  created_at: string
}

export type ToolboxTalkSummary = Pick<ToolboxTalk,
  "id" | "org_id" | "project_id" | "created_at" | "held_at" | "topic" | "presenter_name" | "attendee_count">

export type Observation = {
  id: string
  org_id: string
  project_id: string
  observation_number: number
  kind: "safety" | "quality"
  category: "positive" | "at_risk" | "deficiency" | null
  description: string
  location: string | null
  location_id: string | null
  company_id: string | null
  company_name?: string | null
  photo_file_id: string | null
  status: "open" | "resolved"
  resolved_at: string | null
  due_date: string | null
  created_by: string | null
  created_at: string
}

/** Severities that trigger the org-admin email alert. */
export const ALERT_SEVERITIES = new Set(["lost_time", "fatality"])

const INCIDENT_SELECT =
  "id, org_id, project_id, incident_number, occurred_at, severity, classification, location, location_id, description, involved_company_id, involved_person_name, witness_names, immediate_action, root_cause, photo_file_id, is_osha_recordable, reported_by, status, closed_at, created_at, updated_at, involved_company:companies(name)"
const TALK_SELECT =
  "id, org_id, project_id, held_at, topic, notes, presenter_name, presenter_user_id, attendee_count, attendees, file_id, created_at"
const OBSERVATION_SELECT =
  "id, org_id, project_id, observation_number, kind, category, description, location, location_id, company_id, photo_file_id, status, resolved_at, due_date, created_by, created_at, company:companies(name)"

function mapIncident(row: Record<string, any>): SafetyIncident {
  const { involved_company, ...rest } = row
  const company = Array.isArray(involved_company) ? involved_company[0] : involved_company
  return { ...rest, involved_company_name: company?.name ?? null } as SafetyIncident
}

function mapObservation(row: Record<string, any>): Observation {
  const { company, ...rest } = row
  const companyRow = Array.isArray(company) ? company[0] : company
  return { ...rest, company_name: companyRow?.name ?? null } as Observation
}

async function validateSafetyReferences({ supabase, orgId, projectId, companyId, fileId }: {
  supabase: Awaited<ReturnType<typeof requireOrgContext>>["supabase"]
  orgId: string; projectId: string; companyId?: string | null; fileId?: string | null
}) {
  await Promise.all([
    companyId ? (async () => {
      const { data, error } = await supabase.from("companies").select("id").eq("org_id", orgId).eq("id", companyId).maybeSingle()
      if (error || !data) throw new Error("Safety company is unavailable in this organization")
    })() : Promise.resolve(),
    fileId ? (async () => {
      const { data, error } = await supabase.from("files").select("id").eq("org_id", orgId).eq("project_id", projectId).eq("id", fileId).maybeSingle()
      if (error || !data) throw new Error("Safety evidence does not belong to this home or is unavailable")
    })() : Promise.resolve(),
  ])
}

// ---------------------------------------------------------------------------
// Incidents
// ---------------------------------------------------------------------------

export async function listSafetyIncidents(projectId: string, orgId?: string): Promise<SafetyIncident[]> {
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  await requirePermission("safety.read", { supabase, orgId: resolvedOrgId, userId })
  await requireAuthorization({ supabase, orgId: resolvedOrgId, userId, permission: "safety.read", projectId: projectId, resourceType: "project", resourceId: projectId })
  const rows = await readAllRowsById((after, limit) => {
    let query = supabase.from("safety_incidents").select(INCIDENT_SELECT).eq("org_id", resolvedOrgId)
      .eq("project_id", projectId).order("id", { ascending: true }).limit(limit)
    if (after) query = query.gt("id", after)
    return query
  }, { cap: 10000, pageSize: 100, label: "Failed to load safety_incidents" })
  return rows.map(mapIncident)
}

export async function createSafetyIncident(input: SafetyIncidentInput, orgId?: string): Promise<SafetyIncident> {
  const parsed = safetyIncidentInputSchema.parse(input)
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  await requirePermission("safety.write", { supabase, orgId: resolvedOrgId, userId })
  await requireAuthorization({ supabase, orgId: resolvedOrgId, userId, permission: "safety.write", projectId: parsed.project_id, resourceType: "project", resourceId: parsed.project_id })
  await validateSafetyReferences({ supabase, orgId: resolvedOrgId, projectId: parsed.project_id, companyId: parsed.involved_company_id, fileId: parsed.photo_file_id })
  const location = await resolveProjectLocation(parsed.project_id, parsed.location_id, resolvedOrgId)

  const { data } = await insertWithProjectNumberRetry<Record<string, any>>({
    supabase,
    table: "safety_incidents",
    numberColumn: "incident_number",
    rpcName: "next_incident_number",
    conflictConstraint: "safety_incidents_project_id_incident_number_key",
    projectId: parsed.project_id,
    payload: {
      org_id: resolvedOrgId,
      project_id: parsed.project_id,
      occurred_at: parsed.occurred_at,
      severity: parsed.severity,
      classification: parsed.classification ?? null,
      location_id: location?.id ?? null,
      location: location?.full_path ?? parsed.location ?? null,
      description: parsed.description,
      involved_company_id: parsed.involved_company_id ?? null,
      involved_person_name: parsed.involved_person_name ?? null,
      witness_names: parsed.witness_names ?? null,
      immediate_action: parsed.immediate_action ?? null,
      photo_file_id: parsed.photo_file_id ?? null,
      is_osha_recordable: parsed.is_osha_recordable ?? false,
      reported_by: userId,
    },
    select: INCIDENT_SELECT,
    entityLabel: "safety incident",
  })

  const incident = mapIncident(data)

  await recordEvent({
    orgId: resolvedOrgId,
    eventType: "safety_incident_reported",
    entityType: "safety_incident",
    entityId: incident.id,
    payload: {
      project_id: parsed.project_id,
      severity: parsed.severity,
      title: `Safety incident #${incident.incident_number}: ${parsed.severity.replace(/_/g, " ")}`,
      actor_id: userId,
    },
  })
  if (ALERT_SEVERITIES.has(parsed.severity)) {
    await recordEvent({
      orgId: resolvedOrgId,
      eventType: "safety_incident_alert",
      entityType: "safety_incident",
      entityId: incident.id,
      payload: {
        project_id: parsed.project_id,
        severity: parsed.severity,
        title: `Serious safety incident reported (${parsed.severity.replace(/_/g, " ")})`,
        message: parsed.description.slice(0, 280),
        actor_id: userId,
      },
    })
  }
  await recordAudit({ orgId: resolvedOrgId, actorId: userId, action: "insert", entityType: "safety_incident", entityId: incident.id, after: data })

  return incident
}

export async function updateSafetyIncident(incidentId: string, input: SafetyIncidentUpdate, orgId?: string, expectedProjectId?: string): Promise<SafetyIncident> {
  const parsed = safetyIncidentUpdateSchema.parse(input)
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  await requirePermission("safety.write", { supabase, orgId: resolvedOrgId, userId })

  const { data: existing, error: lookupError } = await supabase
    .from("safety_incidents")
    .select(INCIDENT_SELECT)
    .eq("org_id", resolvedOrgId)
    .eq("id", incidentId)
    .maybeSingle()
  if (lookupError) throw new Error(`Failed to load incident: ${lookupError.message}`)
  if (!existing) throw new Error("Incident not found")
  if (expectedProjectId && existing.project_id !== expectedProjectId) throw new Error("Safety record belongs to another home")
  await requireAuthorization({ supabase, orgId: resolvedOrgId, userId, permission: "safety.write", projectId: existing.project_id, resourceType: "project", resourceId: existing.project_id })
  await validateSafetyReferences({ supabase, orgId: resolvedOrgId, projectId: existing.project_id, companyId: parsed.involved_company_id, fileId: parsed.photo_file_id })


  const updateData: Record<string, unknown> = {}
  if (parsed.location_id !== undefined) {
    const location = await resolveProjectLocation(existing.project_id, parsed.location_id, resolvedOrgId)
    updateData.location_id = location?.id ?? null
    updateData.location = location?.full_path ?? null
  }
  for (const key of [
    "occurred_at",
    "severity",
    "classification",
    "description",
    "involved_company_id",
    "involved_person_name",
    "witness_names",
    "immediate_action",
    "photo_file_id",
    "root_cause",
    "is_osha_recordable",
  ] as const) {
    if (parsed[key] !== undefined) updateData[key] = parsed[key]
  }
  if (parsed.status !== undefined) {
    updateData.status = parsed.status
    updateData.closed_at = parsed.status === "closed" ? new Date().toISOString() : null
  }

  const { data, error } = await supabase
    .from("safety_incidents")
    .update(updateData)
    .eq("org_id", resolvedOrgId)
    .eq("id", incidentId).eq("project_id", existing.project_id)
    .select(INCIDENT_SELECT)
    .single()
  if (error || !data) throw new Error(`Failed to update incident: ${error?.message}`)

  if (parsed.severity && parsed.severity !== existing.severity && ALERT_SEVERITIES.has(parsed.severity)) {
    await recordEvent({ orgId: resolvedOrgId, eventType: "safety_incident_alert", entityType: "safety_incident", entityId: incidentId,
      payload: { project_id: existing.project_id, severity: parsed.severity,
        title: `Serious safety incident escalation (${parsed.severity.replace(/_/g, " ")})`,
        message: String(data.description).slice(0, 280), actor_id: userId } })
  }
  await recordAudit({ orgId: resolvedOrgId, actorId: userId, action: "update", entityType: "safety_incident", entityId: incidentId, before: existing, after: data })
  return mapIncident(data)
}

// ---------------------------------------------------------------------------
// Toolbox talks
// ---------------------------------------------------------------------------

export async function listToolboxTalks(projectId: string, orgId?: string): Promise<ToolboxTalk[]> {
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  await requirePermission("safety.read", { supabase, orgId: resolvedOrgId, userId })
  await requireAuthorization({ supabase, orgId: resolvedOrgId, userId, permission: "safety.read", projectId: projectId, resourceType: "project", resourceId: projectId })
  const rows = await readAllRowsById((after, limit) => {
    let query = supabase.from("toolbox_talks").select(TALK_SELECT).eq("org_id", resolvedOrgId)
      .eq("project_id", projectId).order("id", { ascending: true }).limit(limit)
    if (after) query = query.gt("id", after)
    return query
  }, { cap: 10000, pageSize: 100, label: "Failed to load toolbox_talks" })
  return rows as ToolboxTalk[]
}

export async function createToolboxTalk(input: ToolboxTalkInput, orgId?: string): Promise<ToolboxTalk> {
  const parsed = toolboxTalkInputSchema.parse(input)
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  await requirePermission("safety.write", { supabase, orgId: resolvedOrgId, userId })
  await requireAuthorization({ supabase, orgId: resolvedOrgId, userId, permission: "safety.write", projectId: parsed.project_id, resourceType: "project", resourceId: parsed.project_id })
  await validateSafetyReferences({ supabase, orgId: resolvedOrgId, projectId: parsed.project_id, companyId: undefined, fileId: parsed.file_id })

  const { data, error } = await supabase
    .from("toolbox_talks")
    .insert({
      org_id: resolvedOrgId,
      project_id: parsed.project_id,
      held_at: parsed.held_at,
      topic: parsed.topic,
      notes: parsed.notes ?? null,
      presenter_name: parsed.presenter_name ?? null,
      presenter_user_id: userId,
      attendee_count: parsed.attendee_count ?? (parsed.attendees.length > 0 ? parsed.attendees.length : null),
      attendees: parsed.attendees,
      file_id: parsed.file_id ?? null,
    })
    .select(TALK_SELECT)
    .single()
  if (error || !data) throw new Error(`Failed to record toolbox talk: ${error?.message}`)

  await recordAudit({ orgId: resolvedOrgId, actorId: userId, action: "insert", entityType: "toolbox_talk", entityId: data.id, after: data })
  return data as ToolboxTalk
}

export async function deleteToolboxTalk(talkId: string, orgId?: string, expectedProjectId?: string): Promise<void> {
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  await requirePermission("safety.write", { supabase, orgId: resolvedOrgId, userId })
  const { data: existing, error: lookupError } = await supabase.from("toolbox_talks").select(TALK_SELECT).eq("org_id", resolvedOrgId).eq("id", talkId).maybeSingle()
  if (lookupError) throw new Error(`Failed to load toolbox talk: ${lookupError.message}`)
  if (!existing) throw new Error("Toolbox talk not found")
  if (expectedProjectId && existing.project_id !== expectedProjectId) throw new Error("Safety record belongs to another home")
  await requireAuthorization({ supabase, orgId: resolvedOrgId, userId, permission: "safety.write", projectId: existing.project_id, resourceType: "project", resourceId: existing.project_id })

  const { data: deleted, error } = await supabase.from("toolbox_talks").delete().eq("org_id", resolvedOrgId).eq("id", talkId).eq("project_id", existing.project_id).select("id")
  if (error || deleted?.length !== 1) throw new Error(`Failed to delete toolbox talk: ${error?.message ?? "Record changed or is unavailable"}`)
  await recordAudit({ orgId: resolvedOrgId, actorId: userId, action: "delete", entityType: "toolbox_talk", entityId: talkId, before: existing })
}

// ---------------------------------------------------------------------------
// Observations
// ---------------------------------------------------------------------------

export async function listObservations(projectId: string, orgId?: string): Promise<Observation[]> {
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  await requirePermission("safety.read", { supabase, orgId: resolvedOrgId, userId })
  await requireAuthorization({ supabase, orgId: resolvedOrgId, userId, permission: "safety.read", projectId: projectId, resourceType: "project", resourceId: projectId })
  const rows = await readAllRowsById((after, limit) => {
    let query = supabase.from("observations").select(OBSERVATION_SELECT).eq("org_id", resolvedOrgId)
      .eq("project_id", projectId).order("id", { ascending: true }).limit(limit)
    if (after) query = query.gt("id", after)
    return query
  }, { cap: 10000, pageSize: 100, label: "Failed to load observations" })
  return rows.map(mapObservation)
}

export async function createObservation(input: ObservationInput, orgId?: string): Promise<Observation> {
  const parsed = observationInputSchema.parse(input)
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  await requirePermission("safety.write", { supabase, orgId: resolvedOrgId, userId })
  await requireAuthorization({ supabase, orgId: resolvedOrgId, userId, permission: "safety.write", projectId: parsed.project_id, resourceType: "project", resourceId: parsed.project_id })
  await validateSafetyReferences({ supabase, orgId: resolvedOrgId, projectId: parsed.project_id, companyId: parsed.company_id, fileId: parsed.photo_file_id })
  const location = await resolveProjectLocation(parsed.project_id, parsed.location_id, resolvedOrgId)

  const { data } = await insertWithProjectNumberRetry<Record<string, any>>({
    supabase,
    table: "observations",
    numberColumn: "observation_number",
    rpcName: "next_observation_number",
    conflictConstraint: "observations_project_id_observation_number_key",
    projectId: parsed.project_id,
    payload: {
      org_id: resolvedOrgId,
      project_id: parsed.project_id,
      kind: parsed.kind,
      category: parsed.category ?? null,
      description: parsed.description,
      location_id: location?.id ?? null,
      location: location?.full_path ?? parsed.location ?? null,
      company_id: parsed.company_id ?? null,
      photo_file_id: parsed.photo_file_id ?? null,
      due_date: parsed.due_date ?? null,
      created_by: userId,
    },
    select: OBSERVATION_SELECT,
    entityLabel: "observation",
  })

  const observation = mapObservation(data)

  await recordEvent({
    orgId: resolvedOrgId,
    eventType: "observation_created",
    entityType: "observation",
    entityId: observation.id,
    payload: { project_id: parsed.project_id, kind: parsed.kind, category: parsed.category ?? null, actor_id: userId },
  })
  await recordAudit({ orgId: resolvedOrgId, actorId: userId, action: "insert", entityType: "observation", entityId: observation.id, after: data })

  return observation
}

export async function updateObservation(observationId: string, input: ObservationUpdate, orgId?: string, expectedProjectId?: string): Promise<Observation> {
  const parsed = observationUpdateSchema.parse(input)
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  await requirePermission("safety.write", { supabase, orgId: resolvedOrgId, userId })

  const { data: existing, error: lookupError } = await supabase
    .from("observations")
    .select(OBSERVATION_SELECT)
    .eq("org_id", resolvedOrgId)
    .eq("id", observationId)
    .maybeSingle()
  if (lookupError) throw new Error(`Failed to load observation: ${lookupError.message}`)
  if (!existing) throw new Error("Observation not found")
  if (expectedProjectId && existing.project_id !== expectedProjectId) throw new Error("Safety record belongs to another home")
  await requireAuthorization({ supabase, orgId: resolvedOrgId, userId, permission: "safety.write", projectId: existing.project_id, resourceType: "project", resourceId: existing.project_id })
  await validateSafetyReferences({ supabase, orgId: resolvedOrgId, projectId: existing.project_id, companyId: parsed.company_id, fileId: undefined })


  const updateData: Record<string, unknown> = {}
  if (parsed.location_id !== undefined) {
    const location = await resolveProjectLocation(existing.project_id, parsed.location_id, resolvedOrgId)
    updateData.location_id = location?.id ?? null
    updateData.location = location?.full_path ?? null
  }
  for (const key of ["description", "category", "company_id", "due_date"] as const) {
    if (parsed[key] !== undefined) updateData[key] = parsed[key]
  }
  if (parsed.status !== undefined) {
    updateData.status = parsed.status
    updateData.resolved_at = parsed.status === "resolved" ? new Date().toISOString() : null
  }

  const { data, error } = await supabase
    .from("observations")
    .update(updateData)
    .eq("org_id", resolvedOrgId)
    .eq("id", observationId).eq("project_id", existing.project_id)
    .select(OBSERVATION_SELECT)
    .single()
  if (error || !data) throw new Error(`Failed to update observation: ${error?.message}`)

  await recordAudit({ orgId: resolvedOrgId, actorId: userId, action: "update", entityType: "observation", entityId: observationId, before: existing, after: data })
  return mapObservation(data)
}

export async function getSafetyWorkspace(projectId: string, input: unknown = {}, orgId?: string) {
  const filters = safetyWorkspaceQuerySchema.parse(input)
  const context = await requireOrgContext(orgId)
  const { supabase, orgId: resolvedOrgId, userId } = context
  await requirePermission("safety.read", context)
  await requireAuthorization({ ...context, permission: "safety.read", projectId, resourceType: "project", resourceId: projectId })
  const positions = { incident: null, observation: null, talk: null }
  const cursor = filters.after ? safetyWorkspaceCursorSchema.parse(JSON.parse(Buffer.from(filters.after, "base64url").toString("utf8"))) : null
  if (cursor && (cursor.org !== resolvedOrgId || cursor.home !== projectId || cursor.actor !== userId || cursor.q !== filters.q || cursor.type !== filters.type || cursor.status !== filters.status)) {
    throw new Error("Safety filters or home changed. Restart from the first page.")
  }
  const current = cursor?.positions ?? positions
  const definitions = [
    { kind: "incident", table: "safety_incidents", select: INCIDENT_SELECT, text: "description", closed: "closed" },
    { kind: "observation", table: "observations", select: OBSERVATION_SELECT, text: "description", closed: "resolved" },
    { kind: "talk", table: "toolbox_talks", select: "id, org_id, project_id, created_at, held_at, topic, presenter_name, attendee_count", text: "topic", closed: null },
  ] as const
  const pages = await Promise.all(definitions.map(async definition => {
    const eligible = (filters.type === "all" || filters.type === definition.kind) && (definition.kind !== "talk" || filters.status === "all")
    if (!eligible) return { kind: definition.kind, rows: [], count: 0, more: false, position: current[definition.kind] }
    const scoped = (head: boolean) => {
      let query = supabase.from(definition.table).select(head ? "id" : definition.select, head ? { count: "exact", head: true } : {})
        .eq("org_id", resolvedOrgId).eq("project_id", projectId)
      if (filters.q) query = query.ilike(definition.text, `%${filters.q.replace(/[\\%_]/g, "\\$&")}%`)
      if (filters.status !== "all" && definition.closed) query = filters.status === "closed" ? query.eq("status", definition.closed) : query.neq("status", definition.closed)
      return query
    }
    let query = scoped(false).order("created_at", { ascending: false }).order("id", { ascending: false }).limit(51)
    const position = current[definition.kind]
    if (position) query = query.or(`created_at.lt.${position.date},and(created_at.eq.${position.date},id.lt.${position.id})`)
    const [page, total] = await Promise.all([query, scoped(true)])
    if (page.error || total.error || !Array.isArray(page.data) || typeof total.count !== "number" || !Number.isSafeInteger(total.count) || total.count < 0) throw new Error(`Failed to load safety ${definition.kind}: ${page.error?.message ?? total.error?.message ?? "Source unavailable"}`)
    const rows = page.data.slice(0, 50).map(row => safetyRowIdentitySchema.parse(row))
    if (rows.some(row => row.org_id !== resolvedOrgId || row.project_id !== projectId)) throw new Error("Safety source returned another home")
    const last = rows.at(-1)
    let more = page.data.length > 50
    if (last && !more) {
      const probe = await scoped(false).select("id").or(`created_at.lt.${last.created_at},and(created_at.eq.${last.created_at},id.lt.${last.id})`).limit(1)
      if (probe.error || !Array.isArray(probe.data)) throw new Error(`Failed to confirm safety continuation: ${probe.error?.message ?? "Source unavailable"}`)
      more = probe.data.length > 0
    }
    return { kind: definition.kind, rows, count: total.count, more, position: last ? { date: last.created_at, id: last.id } : position }
  }))
  const [incidents, observations, talks] = pages
  const nextPositions = { incident: incidents.position, observation: observations.position, talk: talks.position }
  const nextAfter = pages.some(page => page.more) ? Buffer.from(JSON.stringify(safetyWorkspaceCursorSchema.parse({ org: resolvedOrgId, home: projectId, actor: userId, q: filters.q, type: filters.type, status: filters.status, positions: nextPositions }))).toString("base64url") : null
  return {
    incidents: incidents.rows.map(mapIncident), observations: observations.rows.map(mapObservation),
    talks: talks.rows.map(row => toolboxTalkSummarySchema.parse(row)),
    total: pages.reduce((sum, page) => sum + page.count, 0),
    counts: { incident: incidents.count, observation: observations.count, talk: talks.count },
    nextAfter, currentAfter: filters.after ?? null, filters: { q: filters.q, type: filters.type, status: filters.status },
  }
}

export async function getSafetyRecord(projectId: string, kind: "incident" | "observation" | "talk", recordId: string, orgId?: string) {
  const context = await requireOrgContext(orgId)
  await requirePermission("safety.read", context)
  await requireAuthorization({ ...context, permission: "safety.read", projectId, resourceType: "project", resourceId: projectId })
  const definition = kind === "incident" ? { table: "safety_incidents", select: INCIDENT_SELECT } : kind === "observation" ? { table: "observations", select: OBSERVATION_SELECT } : { table: "toolbox_talks", select: TALK_SELECT }
  const { data, error } = await context.supabase.from(definition.table).select(definition.select)
    .eq("org_id", context.orgId).eq("project_id", projectId).eq("id", recordId).maybeSingle()
  if (error) throw new Error(`Failed to load selected safety record: ${error.message}`)
  if (!data) return null
  const identity = safetyRowIdentitySchema.parse(data)
  if (identity.org_id !== context.orgId || identity.project_id !== projectId || identity.id !== recordId) throw new Error("Selected safety source differs from the requested home or record")
  if (kind === "incident") return { kind, data: mapIncident(data) }
  if (kind === "observation") return { kind, data: mapObservation(data) }
  const talk = toolboxTalkRecordSchema.parse(data)
  return { kind, data: talk }
}
