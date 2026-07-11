import { recordAudit } from "@/lib/services/audit"
import { requireOrgContext } from "@/lib/services/context"
import { recordEvent } from "@/lib/services/events"
import { requirePermission } from "@/lib/services/permissions"
import { insertWithProjectNumberRetry } from "@/lib/services/project-sequence"
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
  description: string
  involved_company_id: string | null
  involved_company_name?: string | null
  involved_person_name: string | null
  witness_names: string | null
  immediate_action: string | null
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

export type Observation = {
  id: string
  org_id: string
  project_id: string
  observation_number: number
  kind: "safety" | "quality"
  category: "positive" | "at_risk" | "deficiency" | null
  description: string
  location: string | null
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
  "id, org_id, project_id, incident_number, occurred_at, severity, classification, location, description, involved_company_id, involved_person_name, witness_names, immediate_action, root_cause, is_osha_recordable, reported_by, status, closed_at, created_at, updated_at, involved_company:companies(name)"
const TALK_SELECT =
  "id, org_id, project_id, held_at, topic, notes, presenter_name, presenter_user_id, attendee_count, attendees, file_id, created_at"
const OBSERVATION_SELECT =
  "id, org_id, project_id, observation_number, kind, category, description, location, company_id, photo_file_id, status, resolved_at, due_date, created_by, created_at, company:companies(name)"

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

// ---------------------------------------------------------------------------
// Incidents
// ---------------------------------------------------------------------------

export async function listSafetyIncidents(projectId: string, orgId?: string): Promise<SafetyIncident[]> {
  const { supabase, orgId: resolvedOrgId } = await requireOrgContext(orgId)
  const { data, error } = await supabase
    .from("safety_incidents")
    .select(INCIDENT_SELECT)
    .eq("org_id", resolvedOrgId)
    .eq("project_id", projectId)
    .order("incident_number", { ascending: false })
    .limit(250)
  if (error) throw new Error(`Failed to load incidents: ${error.message}`)
  return (data ?? []).map(mapIncident)
}

export async function createSafetyIncident(input: SafetyIncidentInput, orgId?: string): Promise<SafetyIncident> {
  const parsed = safetyIncidentInputSchema.parse(input)
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  await requirePermission("safety.write", { supabase, orgId: resolvedOrgId, userId })

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
      location: parsed.location ?? null,
      description: parsed.description,
      involved_company_id: parsed.involved_company_id ?? null,
      involved_person_name: parsed.involved_person_name ?? null,
      witness_names: parsed.witness_names ?? null,
      immediate_action: parsed.immediate_action ?? null,
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

export async function updateSafetyIncident(incidentId: string, input: SafetyIncidentUpdate, orgId?: string): Promise<SafetyIncident> {
  const parsed = safetyIncidentUpdateSchema.parse(input)
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  await requirePermission("safety.write", { supabase, orgId: resolvedOrgId, userId })

  const { data: existing } = await supabase
    .from("safety_incidents")
    .select(INCIDENT_SELECT)
    .eq("org_id", resolvedOrgId)
    .eq("id", incidentId)
    .maybeSingle()
  if (!existing) throw new Error("Incident not found")

  const updateData: Record<string, unknown> = {}
  for (const key of [
    "occurred_at",
    "severity",
    "classification",
    "location",
    "description",
    "involved_company_id",
    "involved_person_name",
    "witness_names",
    "immediate_action",
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
    .eq("id", incidentId)
    .select(INCIDENT_SELECT)
    .single()
  if (error || !data) throw new Error(`Failed to update incident: ${error?.message}`)

  await recordAudit({ orgId: resolvedOrgId, actorId: userId, action: "update", entityType: "safety_incident", entityId: incidentId, before: existing, after: data })
  return mapIncident(data)
}

// ---------------------------------------------------------------------------
// Toolbox talks
// ---------------------------------------------------------------------------

export async function listToolboxTalks(projectId: string, orgId?: string): Promise<ToolboxTalk[]> {
  const { supabase, orgId: resolvedOrgId } = await requireOrgContext(orgId)
  const { data, error } = await supabase
    .from("toolbox_talks")
    .select(TALK_SELECT)
    .eq("org_id", resolvedOrgId)
    .eq("project_id", projectId)
    .order("held_at", { ascending: false })
    .limit(250)
  if (error) throw new Error(`Failed to load toolbox talks: ${error.message}`)
  return (data ?? []) as ToolboxTalk[]
}

export async function createToolboxTalk(input: ToolboxTalkInput, orgId?: string): Promise<ToolboxTalk> {
  const parsed = toolboxTalkInputSchema.parse(input)
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  await requirePermission("safety.write", { supabase, orgId: resolvedOrgId, userId })

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

export async function deleteToolboxTalk(talkId: string, orgId?: string): Promise<void> {
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  await requirePermission("safety.write", { supabase, orgId: resolvedOrgId, userId })
  const { data: existing } = await supabase.from("toolbox_talks").select(TALK_SELECT).eq("org_id", resolvedOrgId).eq("id", talkId).maybeSingle()
  if (!existing) throw new Error("Toolbox talk not found")
  const { error } = await supabase.from("toolbox_talks").delete().eq("org_id", resolvedOrgId).eq("id", talkId)
  if (error) throw new Error(`Failed to delete toolbox talk: ${error.message}`)
  await recordAudit({ orgId: resolvedOrgId, actorId: userId, action: "delete", entityType: "toolbox_talk", entityId: talkId, before: existing })
}

// ---------------------------------------------------------------------------
// Observations
// ---------------------------------------------------------------------------

export async function listObservations(projectId: string, orgId?: string): Promise<Observation[]> {
  const { supabase, orgId: resolvedOrgId } = await requireOrgContext(orgId)
  const { data, error } = await supabase
    .from("observations")
    .select(OBSERVATION_SELECT)
    .eq("org_id", resolvedOrgId)
    .eq("project_id", projectId)
    .order("observation_number", { ascending: false })
    .limit(500)
  if (error) throw new Error(`Failed to load observations: ${error.message}`)
  return (data ?? []).map(mapObservation)
}

export async function createObservation(input: ObservationInput, orgId?: string): Promise<Observation> {
  const parsed = observationInputSchema.parse(input)
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  await requirePermission("safety.write", { supabase, orgId: resolvedOrgId, userId })

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
      location: parsed.location ?? null,
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

export async function updateObservation(observationId: string, input: ObservationUpdate, orgId?: string): Promise<Observation> {
  const parsed = observationUpdateSchema.parse(input)
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  await requirePermission("safety.write", { supabase, orgId: resolvedOrgId, userId })

  const { data: existing } = await supabase
    .from("observations")
    .select(OBSERVATION_SELECT)
    .eq("org_id", resolvedOrgId)
    .eq("id", observationId)
    .maybeSingle()
  if (!existing) throw new Error("Observation not found")

  const updateData: Record<string, unknown> = {}
  for (const key of ["description", "category", "location", "company_id", "due_date"] as const) {
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
    .eq("id", observationId)
    .select(OBSERVATION_SELECT)
    .single()
  if (error || !data) throw new Error(`Failed to update observation: ${error?.message}`)

  await recordAudit({ orgId: resolvedOrgId, actorId: userId, action: "update", entityType: "observation", entityId: observationId, before: existing, after: data })
  return mapObservation(data)
}
