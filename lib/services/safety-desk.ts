import { requireOrgContext } from "@/lib/services/context"
import { requirePermission } from "@/lib/services/permissions"

export type SafetyDeskIncident = {
  id: string
  project_id: string
  project_name: string
  incident_number: number
  occurred_at: string
  severity: "near_miss" | "first_aid" | "medical_treatment" | "lost_time" | "fatality"
  description: string
  status: "open" | "under_review" | "closed"
  is_osha_recordable: boolean
}

export type SafetyDeskObservation = {
  id: string
  project_id: string
  project_name: string
  observation_number: number
  category: "positive" | "at_risk" | "deficiency" | null
  description: string
  due_date: string | null
  status: "open" | "resolved"
  created_at: string
}

export type SafetyDeskInspection = {
  id: string
  project_id: string
  project_name: string
  inspection_number: number
  title: string
  kind: "safety" | "quality"
  status: "draft" | "in_progress" | "completed"
  result: "pass" | "fail" | "partial" | null
  inspected_at: string | null
  updated_at: string
}

export type SafetyDeskData = {
  incidents: SafetyDeskIncident[]
  observations: SafetyDeskObservation[]
  inspections: SafetyDeskInspection[]
}

const DESK_CAP = 500

function projectName(project: { name?: string | null } | Array<{ name?: string | null }> | null): string {
  const row = Array.isArray(project) ? project[0] : project
  return row?.name ?? "Untitled project"
}

/** Cross-project, read-only operating view for an organization's safety team. */
export async function getSafetyDesk(orgId?: string): Promise<SafetyDeskData> {
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  await requirePermission("safety.read", { supabase, orgId: resolvedOrgId, userId })

  const [incidentResult, observationResult, inspectionResult] = await Promise.all([
    supabase
      .from("safety_incidents")
      .select("id, project_id, incident_number, occurred_at, severity, description, status, is_osha_recordable, project:projects(name)")
      .eq("org_id", resolvedOrgId)
      .order("occurred_at", { ascending: false })
      .limit(DESK_CAP),
    supabase
      .from("observations")
      .select("id, project_id, observation_number, category, description, due_date, status, created_at, project:projects(name)")
      .eq("org_id", resolvedOrgId)
      .order("created_at", { ascending: false })
      .limit(DESK_CAP),
    supabase
      .from("inspections")
      .select("id, project_id, inspection_number, title, kind, status, result, inspected_at, updated_at, project:projects(name)")
      .eq("org_id", resolvedOrgId)
      .eq("kind", "safety")
      .order("updated_at", { ascending: false })
      .limit(DESK_CAP),
  ])

  if (incidentResult.error) throw new Error(`Failed to load safety incidents: ${incidentResult.error.message}`)
  if (observationResult.error) throw new Error(`Failed to load safety observations: ${observationResult.error.message}`)
  if (inspectionResult.error) throw new Error(`Failed to load safety inspections: ${inspectionResult.error.message}`)

  return {
    incidents: (incidentResult.data ?? []).map(({ project, ...row }) => ({
      ...row,
      project_name: projectName(project),
    })),
    observations: (observationResult.data ?? []).map(({ project, ...row }) => ({
      ...row,
      project_name: projectName(project),
    })),
    inspections: (inspectionResult.data ?? []).map(({ project, ...row }) => ({
      ...row,
      project_name: projectName(project),
    })),
  }
}
