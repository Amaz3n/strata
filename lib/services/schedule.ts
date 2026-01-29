import type { SupabaseClient } from "@supabase/supabase-js"

import type {
  ScheduleItem,
  ScheduleAssignment,
  ScheduleDependency,
  ScheduleBaseline,
  ScheduleTemplate,
  ScheduleItemChangeOrder,
  DrawSchedule,
  ChangeOrder,
} from "@/lib/types"
import type { 
  ScheduleItemInput, 
  ScheduleAssignmentInput, 
  ScheduleBaselineInput,
  ScheduleTemplateInput,
  ScheduleBulkUpdate,
  ScheduleDependencyInput 
} from "@/lib/validation/schedule"
import { 
  scheduleItemUpdateSchema,
  scheduleAssignmentInputSchema,
  scheduleDependencyInputSchema,
} from "@/lib/validation/schedule"
import { inspectionMetadataSchema } from "@/lib/validation/inspections"
import { recordEvent } from "@/lib/services/events"
import { recordAudit } from "@/lib/services/audit"
import { requireOrgContext } from "@/lib/services/context"

// ============================================================================
// SCHEDULE ITEMS
// ============================================================================

function mapScheduleItem(row: any, dependencyMap: Record<string, string[]>): ScheduleItem {
  return {
    id: row.id,
    org_id: row.org_id,
    project_id: row.project_id,
    name: row.name,
    item_type: row.item_type ?? "task",
    status: row.status ?? "planned",
    start_date: row.start_date ?? undefined,
    end_date: row.end_date ?? undefined,
    progress: typeof row.progress === "number" ? row.progress : 0,
    assigned_to: row.assigned_to ?? undefined,
    metadata: row.metadata ?? {},
    created_at: row.created_at,
    updated_at: row.updated_at,
    dependencies: dependencyMap[row.id] ?? [],
    // Enhanced fields
    phase: row.phase ?? undefined,
    trade: row.trade ?? undefined,
    location: row.location ?? undefined,
    planned_hours: row.planned_hours ?? undefined,
    actual_hours: row.actual_hours ?? undefined,
    constraint_type: row.constraint_type ?? "asap",
    constraint_date: row.constraint_date ?? undefined,
    is_critical_path: row.is_critical_path ?? false,
    float_days: row.float_days ?? 0,
    color: row.color ?? undefined,
    sort_order: row.sort_order ?? 0,
    // Cost tracking fields
    cost_code_id: row.cost_code_id ?? undefined,
    budget_cents: row.budget_cents ?? undefined,
    actual_cost_cents: row.actual_cost_cents ?? undefined,
  }
}

async function loadDependencies(supabase: SupabaseClient, orgId: string) {
  const { data, error } = await supabase
    .from("schedule_dependencies")
    .select("item_id, depends_on_item_id, dependency_type, lag_days")
    .eq("org_id", orgId)

  if (error) {
    throw new Error(`Failed to load schedule dependencies: ${error.message}`)
  }

  return (data ?? []).reduce<Record<string, string[]>>((acc, dep) => {
    if (!acc[dep.item_id]) acc[dep.item_id] = []
    acc[dep.item_id].push(dep.depends_on_item_id)
    return acc
  }, {})
}

async function loadDependencyDetails(supabase: SupabaseClient, orgId: string): Promise<ScheduleDependency[]> {
  const { data, error } = await supabase
    .from("schedule_dependencies")
    .select("id, org_id, project_id, item_id, depends_on_item_id, dependency_type, lag_days")
    .eq("org_id", orgId)

  if (error) {
    throw new Error(`Failed to load dependency details: ${error.message}`)
  }

  return (data ?? []).map((dep) => ({
    id: dep.id,
    org_id: dep.org_id,
    project_id: dep.project_id,
    item_id: dep.item_id,
    depends_on_item_id: dep.depends_on_item_id,
    dependency_type: dep.dependency_type ?? "FS",
    lag_days: dep.lag_days ?? 0,
  }))
}

export async function listScheduleItems(orgId?: string): Promise<ScheduleItem[]> {
  const { supabase, orgId: resolvedOrgId } = await requireOrgContext(orgId)
  return listScheduleItemsWithClient(supabase, resolvedOrgId)
}

export async function listScheduleItemsWithClient(supabase: SupabaseClient, orgId: string): Promise<ScheduleItem[]> {
  const dependencyMap = await loadDependencies(supabase, orgId)

  const { data, error } = await supabase
    .from("schedule_items")
    .select(`
      id, org_id, project_id, name, item_type, status, start_date, end_date,
      progress, assigned_to, metadata, created_at, updated_at,
      phase, trade, location, planned_hours, actual_hours,
      constraint_type, constraint_date, is_critical_path, float_days, color, sort_order,
      cost_code_id, budget_cents, actual_cost_cents
    `)
    .eq("org_id", orgId)
    .order("sort_order", { ascending: true })
    .order("start_date", { ascending: true, nullsFirst: false })

  if (error) {
    throw new Error(`Failed to list schedule items: ${error.message}`)
  }

  return (data ?? []).map((row) => mapScheduleItem(row, dependencyMap))
}

export async function listScheduleItemsByProject(projectId: string, orgId?: string): Promise<ScheduleItem[]> {
  const { supabase, orgId: resolvedOrgId } = await requireOrgContext(orgId)
  const dependencyMap = await loadDependencies(supabase, resolvedOrgId)

  const { data, error } = await supabase
    .from("schedule_items")
    .select(`
      id, org_id, project_id, name, item_type, status, start_date, end_date,
      progress, assigned_to, metadata, created_at, updated_at,
      phase, trade, location, planned_hours, actual_hours,
      constraint_type, constraint_date, is_critical_path, float_days, color, sort_order,
      cost_code_id, budget_cents, actual_cost_cents
    `)
    .eq("org_id", resolvedOrgId)
    .eq("project_id", projectId)
    .order("sort_order", { ascending: true })
    .order("start_date", { ascending: true, nullsFirst: false })

  if (error) {
    throw new Error(`Failed to list schedule items by project: ${error.message}`)
  }

  return (data ?? []).map((row) => mapScheduleItem(row, dependencyMap))
}

export async function getScheduleItemWithDetails(itemId: string, orgId?: string): Promise<ScheduleItem & { 
  assignments: ScheduleAssignment[]
  dependency_details: ScheduleDependency[]
}> {
  const { supabase, orgId: resolvedOrgId } = await requireOrgContext(orgId)

  const { data, error } = await supabase
    .from("schedule_items")
    .select(`
      id, org_id, project_id, name, item_type, status, start_date, end_date,
      progress, assigned_to, metadata, created_at, updated_at,
      phase, trade, location, planned_hours, actual_hours,
      constraint_type, constraint_date, is_critical_path, float_days, color, sort_order,
      cost_code_id, budget_cents, actual_cost_cents
    `)
    .eq("org_id", resolvedOrgId)
    .eq("id", itemId)
    .single()

  if (error || !data) {
    throw new Error("Schedule item not found")
  }

  const [dependencyMap, assignments, dependencyDetails] = await Promise.all([
    loadDependencies(supabase, resolvedOrgId),
    listAssignmentsByItem(itemId, resolvedOrgId),
    loadDependencyDetails(supabase, resolvedOrgId).then(deps => deps.filter(d => d.item_id === itemId)),
  ])

  return {
    ...mapScheduleItem(data, dependencyMap),
    assignments,
    dependency_details: dependencyDetails,
  }
}

export async function createScheduleItem({ input, orgId }: { input: ScheduleItemInput; orgId?: string }) {
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)

  const { data, error } = await supabase
    .from("schedule_items")
    .insert({
      org_id: resolvedOrgId,
      project_id: input.project_id,
      name: input.name,
      item_type: input.item_type ?? "task",
      status: input.status ?? "planned",
      start_date: input.start_date || null,
      end_date: input.end_date || null,
      progress: input.progress ?? 0,
      assigned_to: input.assigned_to || null,
      metadata: input.metadata ?? {},
      // Enhanced fields
      phase: input.phase || null,
      trade: input.trade || null,
      location: input.location || null,
      planned_hours: input.planned_hours ?? null,
      actual_hours: input.actual_hours ?? null,
      constraint_type: input.constraint_type ?? "asap",
      constraint_date: input.constraint_date || null,
      is_critical_path: input.is_critical_path ?? false,
      float_days: input.float_days ?? 0,
      color: input.color || null,
      sort_order: input.sort_order ?? 0,
    })
    .select(`
      id, org_id, project_id, name, item_type, status, start_date, end_date,
      progress, assigned_to, metadata, created_at, updated_at,
      phase, trade, location, planned_hours, actual_hours,
      constraint_type, constraint_date, is_critical_path, float_days, color, sort_order,
      cost_code_id, budget_cents, actual_cost_cents
    `)
    .single()

  if (error || !data) {
    throw new Error(`Failed to create schedule item: ${error?.message}`)
  }

  // Create dependencies if provided
  if (input.dependencies?.length) {
    const dependencyRows = input.dependencies.map((depId) => ({
      org_id: resolvedOrgId,
      project_id: input.project_id,
      item_id: data.id,
      depends_on_item_id: depId,
      dependency_type: "FS",
      lag_days: 0,
    }))

    const { error: dependencyError } = await supabase.from("schedule_dependencies").insert(dependencyRows)
    if (dependencyError) {
      console.error("Failed to create schedule dependencies", dependencyError)
    }
  }

  await recordEvent({
    orgId: resolvedOrgId,
    eventType: "schedule_item_created",
    entityType: "schedule_item",
    entityId: data.id as string,
    payload: { name: input.name, project_id: input.project_id, item_type: input.item_type },
  })

  await recordAudit({
    orgId: resolvedOrgId,
    actorId: userId,
    action: "insert",
    entityType: "schedule_item",
    entityId: data.id as string,
    after: data,
  })

  const dependencyMap = input.dependencies ? { [data.id]: input.dependencies } : {}
  return mapScheduleItem(data, dependencyMap)
}

export async function updateScheduleItem({
  itemId,
  input,
  orgId,
}: {
  itemId: string
  input: Partial<ScheduleItemInput>
  orgId?: string
}) {
  const parsed = scheduleItemUpdateSchema.parse(input)
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)

  const existing = await supabase
    .from("schedule_items")
    .select(`
      id, org_id, project_id, name, item_type, status, start_date, end_date,
      progress, assigned_to, metadata, created_at, updated_at,
      phase, trade, location, planned_hours, actual_hours,
      constraint_type, constraint_date, is_critical_path, float_days, color, sort_order,
      cost_code_id, budget_cents, actual_cost_cents
    `)
    .eq("org_id", resolvedOrgId)
    .eq("id", itemId)
    .single()

  if (existing.error || !existing.data) {
    throw new Error("Schedule item not found or not accessible")
  }

  const updateData: Record<string, any> = {}
  
  // Basic fields
  if (parsed.name !== undefined) updateData.name = parsed.name
  if (parsed.item_type !== undefined) updateData.item_type = parsed.item_type
  if (parsed.status !== undefined) updateData.status = parsed.status
  if (parsed.start_date !== undefined) updateData.start_date = parsed.start_date || null
  if (parsed.end_date !== undefined) updateData.end_date = parsed.end_date || null
  if (parsed.progress !== undefined) updateData.progress = parsed.progress
  if (parsed.assigned_to !== undefined) updateData.assigned_to = parsed.assigned_to || null
  if (parsed.metadata !== undefined) updateData.metadata = parsed.metadata
  
  // Enhanced fields
  if (parsed.phase !== undefined) updateData.phase = parsed.phase || null
  if (parsed.trade !== undefined) updateData.trade = parsed.trade || null
  if (parsed.location !== undefined) updateData.location = parsed.location || null
  if (parsed.planned_hours !== undefined) updateData.planned_hours = parsed.planned_hours
  if (parsed.actual_hours !== undefined) updateData.actual_hours = parsed.actual_hours
  if (parsed.constraint_type !== undefined) updateData.constraint_type = parsed.constraint_type
  if (parsed.constraint_date !== undefined) updateData.constraint_date = parsed.constraint_date || null
  if (parsed.is_critical_path !== undefined) updateData.is_critical_path = parsed.is_critical_path
  if (parsed.float_days !== undefined) updateData.float_days = parsed.float_days
  if (parsed.color !== undefined) updateData.color = parsed.color || null
  if (parsed.sort_order !== undefined) updateData.sort_order = parsed.sort_order

  const { data, error } =
    Object.keys(updateData).length === 0
      ? { data: existing.data, error: null }
      : await supabase
          .from("schedule_items")
          .update(updateData)
          .eq("org_id", resolvedOrgId)
          .eq("id", itemId)
          .select(`
            id, org_id, project_id, name, item_type, status, start_date, end_date,
            progress, assigned_to, metadata, created_at, updated_at,
            phase, trade, location, planned_hours, actual_hours,
            constraint_type, constraint_date, is_critical_path, float_days, color, sort_order,
            cost_code_id, budget_cents, actual_cost_cents
          `)
          .single()

  if (error || !data) {
    throw new Error(`Failed to update schedule item: ${error?.message}`)
  }

  // Update dependencies if provided
  if (parsed.dependencies !== undefined) {
    await supabase.from("schedule_dependencies").delete().eq("org_id", resolvedOrgId).eq("item_id", itemId)

    if (parsed.dependencies.length) {
      const dependencyRows = parsed.dependencies.map((depId) => ({
        org_id: resolvedOrgId,
        project_id: data.project_id,
        item_id: data.id,
        depends_on_item_id: depId,
        dependency_type: "FS",
        lag_days: 0,
      }))
      const { error: dependencyError } = await supabase.from("schedule_dependencies").insert(dependencyRows)
      if (dependencyError) {
        console.error("Failed to update schedule dependencies", dependencyError)
      }
    }
  }

  await recordEvent({
    orgId: resolvedOrgId,
    eventType: "schedule_item_updated",
    entityType: "schedule_item",
    entityId: data.id as string,
    payload: { name: data.name, status: data.status },
  })

  // Record risk events if applicable
  const end = data.end_date ?? data.start_date
  const isLate = end ? new Date(end) < new Date() : false
  const riskyStatus = ["at_risk", "blocked"].includes(String(data.status))
  if (isLate || riskyStatus) {
    await recordEvent({
      orgId: resolvedOrgId,
      eventType: "schedule_risk",
      entityType: "schedule_item",
      entityId: data.id as string,
      payload: { name: data.name, status: data.status, project_id: data.project_id },
      channel: "activity",
    })
  }

  await recordAudit({
    orgId: resolvedOrgId,
    actorId: userId,
    action: "update",
    entityType: "schedule_item",
    entityId: data.id as string,
    before: existing.data,
    after: data,
  })

  await maybeCreatePunchItemFromInspection({
    supabase,
    orgId: resolvedOrgId,
    userId,
    existing: existing.data,
    updated: data,
  })

  const dependencyMap =
    parsed.dependencies !== undefined 
      ? { [data.id]: parsed.dependencies } 
      : await loadDependencies(supabase, resolvedOrgId)

  return mapScheduleItem(data, dependencyMap)
}

async function maybeCreatePunchItemFromInspection({
  supabase,
  orgId,
  userId,
  existing,
  updated,
}: {
  supabase: SupabaseClient
  orgId: string
  userId: string
  existing: any
  updated: any
}) {
  if (updated.item_type !== "inspection") return

  const prevInspection = inspectionMetadataSchema.safeParse(existing?.metadata?.inspection ?? {})
  const nextInspection = inspectionMetadataSchema.safeParse(updated?.metadata?.inspection ?? {})
  if (!nextInspection.success) return

  const prevResult = prevInspection.success ? prevInspection.data.result : "pending"
  const nextResult = nextInspection.data.result

  if (nextResult !== "fail" || prevResult === "fail") return

  const { data: existingPunch } = await supabase
    .from("punch_items")
    .select("id")
    .eq("org_id", orgId)
    .eq("schedule_item_id", updated.id)
    .eq("created_from_inspection", true)
    .maybeSingle()

  if (existingPunch) return

  const failedChecklist = (nextInspection.data.checklist ?? [])
    .filter((item) => !item.checked)
    .map((item) => item.label)

  const descriptionParts: string[] = []
  if (nextInspection.data.notes) {
    descriptionParts.push(nextInspection.data.notes)
  }
  if (failedChecklist.length > 0) {
    descriptionParts.push(`Failed checklist: ${failedChecklist.join(", ")}`)
  }

  await supabase
    .from("punch_items")
    .insert({
      org_id: orgId,
      project_id: updated.project_id,
      title: `Failed inspection: ${updated.name}`,
      description: descriptionParts.length > 0 ? descriptionParts.join("\n") : "Inspection failed.",
      status: "open",
      severity: "High",
      location: updated.location ?? null,
      assigned_to: updated.assigned_to ?? null,
      created_by: userId,
      schedule_item_id: updated.id,
      created_from_inspection: true,
      verification_required: true,
    })
}

// Set a single assignment (user/contact/company) for a schedule item.
// Clears existing assignments for the item first.
export async function setScheduleItemAssignee({
  itemId,
  projectId,
  assignee,
  orgId,
}: {
  itemId: string
  projectId: string
  assignee:
    | { type: "user"; id: string; role?: string }
    | { type: "contact"; id: string; role?: string }
    | { type: "company"; id: string; role?: string }
    | null
  orgId?: string
}) {
  const { supabase, orgId: resolvedOrgId } = await requireOrgContext(orgId)

  // Clear existing assignments for this item
  await supabase.from("schedule_assignments").delete().eq("org_id", resolvedOrgId).eq("schedule_item_id", itemId)

  if (!assignee) {
    // Also clear assigned_to on schedule item
    await supabase.from("schedule_items").update({ assigned_to: null }).eq("id", itemId).eq("org_id", resolvedOrgId)
    return null
  }

  const assignmentInput: ScheduleAssignmentInput = {
    schedule_item_id: itemId,
    role: assignee.role ?? "assigned",
    actual_hours: 0,
  }

  if (assignee.type === "user") {
    assignmentInput.user_id = assignee.id
    await supabase.from("schedule_items").update({ assigned_to: assignee.id }).eq("id", itemId).eq("org_id", resolvedOrgId)
  } else {
    // Ensure assigned_to is cleared for contact/company
    await supabase.from("schedule_items").update({ assigned_to: null }).eq("id", itemId).eq("org_id", resolvedOrgId)
    if (assignee.type === "contact") {
      assignmentInput.contact_id = assignee.id
    }
    if (assignee.type === "company") {
      assignmentInput.company_id = assignee.id
    }
  }

  return createAssignment(assignmentInput, projectId, resolvedOrgId)
}

export async function deleteScheduleItem(itemId: string, orgId?: string): Promise<void> {
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)

  const existing = await supabase
    .from("schedule_items")
    .select("id, name, project_id")
    .eq("org_id", resolvedOrgId)
    .eq("id", itemId)
    .single()

  if (existing.error || !existing.data) {
    throw new Error("Schedule item not found")
  }

  const { error } = await supabase
    .from("schedule_items")
    .delete()
    .eq("org_id", resolvedOrgId)
    .eq("id", itemId)

  if (error) {
    throw new Error(`Failed to delete schedule item: ${error.message}`)
  }

  await recordAudit({
    orgId: resolvedOrgId,
    actorId: userId,
    action: "delete",
    entityType: "schedule_item",
    entityId: itemId,
    before: existing.data,
  })
}

export async function bulkUpdateScheduleItems(updates: ScheduleBulkUpdate, orgId?: string): Promise<ScheduleItem[]> {
  const { supabase, orgId: resolvedOrgId } = await requireOrgContext(orgId)
  
  const results: ScheduleItem[] = []
  const dependencyMap = await loadDependencies(supabase, resolvedOrgId)

  for (const item of updates.items) {
    const updateData: Record<string, any> = {}
    if (item.start_date !== undefined) updateData.start_date = item.start_date || null
    if (item.end_date !== undefined) updateData.end_date = item.end_date || null
    if (item.sort_order !== undefined) updateData.sort_order = item.sort_order
    if (item.progress !== undefined) updateData.progress = item.progress
    if (item.status !== undefined) updateData.status = item.status

    if (Object.keys(updateData).length > 0) {
      const { data, error } = await supabase
        .from("schedule_items")
        .update(updateData)
        .eq("org_id", resolvedOrgId)
        .eq("id", item.id)
        .select(`
          id, org_id, project_id, name, item_type, status, start_date, end_date,
          progress, assigned_to, metadata, created_at, updated_at,
          phase, trade, location, planned_hours, actual_hours,
          constraint_type, constraint_date, is_critical_path, float_days, color, sort_order,
          cost_code_id, budget_cents, actual_cost_cents
        `)
        .single()

      if (!error && data) {
        results.push(mapScheduleItem(data, dependencyMap))
      }
    }
  }

  return results
}

// ============================================================================
// DEPENDENCIES
// ============================================================================

export async function createDependency(input: ScheduleDependencyInput, projectId: string, orgId?: string): Promise<ScheduleDependency> {
  const parsed = scheduleDependencyInputSchema.parse(input)
  const { supabase, orgId: resolvedOrgId } = await requireOrgContext(orgId)

  const { data, error } = await supabase
    .from("schedule_dependencies")
    .insert({
      org_id: resolvedOrgId,
      project_id: projectId,
      item_id: parsed.item_id,
      depends_on_item_id: parsed.depends_on_item_id,
      dependency_type: parsed.dependency_type,
      lag_days: parsed.lag_days,
    })
    .select("id, org_id, project_id, item_id, depends_on_item_id, dependency_type, lag_days")
    .single()

  if (error || !data) {
    throw new Error(`Failed to create dependency: ${error?.message}`)
  }

  return {
    id: data.id,
    org_id: data.org_id,
    project_id: data.project_id,
    item_id: data.item_id,
    depends_on_item_id: data.depends_on_item_id,
    dependency_type: data.dependency_type ?? "FS",
    lag_days: data.lag_days ?? 0,
  }
}

export async function deleteDependency(dependencyId: string, orgId?: string): Promise<void> {
  const { supabase, orgId: resolvedOrgId } = await requireOrgContext(orgId)

  const { error } = await supabase
    .from("schedule_dependencies")
    .delete()
    .eq("org_id", resolvedOrgId)
    .eq("id", dependencyId)

  if (error) {
    throw new Error(`Failed to delete dependency: ${error.message}`)
  }
}

export async function listDependenciesByProject(projectId: string, orgId?: string): Promise<ScheduleDependency[]> {
  const { supabase, orgId: resolvedOrgId } = await requireOrgContext(orgId)

  const { data, error } = await supabase
    .from("schedule_dependencies")
    .select("id, org_id, project_id, item_id, depends_on_item_id, dependency_type, lag_days")
    .eq("org_id", resolvedOrgId)
    .eq("project_id", projectId)

  if (error) {
    throw new Error(`Failed to list dependencies: ${error.message}`)
  }

  return (data ?? []).map((dep) => ({
    id: dep.id,
    org_id: dep.org_id,
    project_id: dep.project_id,
    item_id: dep.item_id,
    depends_on_item_id: dep.depends_on_item_id,
    dependency_type: dep.dependency_type ?? "FS",
    lag_days: dep.lag_days ?? 0,
  }))
}

// ============================================================================
// ASSIGNMENTS
// ============================================================================

export async function listAssignmentsByItem(itemId: string, orgId?: string): Promise<ScheduleAssignment[]> {
  const { supabase, orgId: resolvedOrgId } = await requireOrgContext(orgId)

  const { data, error } = await supabase
    .from("schedule_assignments")
    .select(`
      id, org_id, project_id, schedule_item_id, user_id, contact_id, company_id,
      role, planned_hours, actual_hours, hourly_rate_cents, notes, confirmed_at, created_at, updated_at,
      user:app_users(id, full_name, avatar_url),
      contact:contacts(id, full_name, email),
      company:companies(id, name, company_type)
    `)
    .eq("org_id", resolvedOrgId)
    .eq("schedule_item_id", itemId)

  if (error) {
    throw new Error(`Failed to list assignments: ${error.message}`)
  }

  return (data ?? []).map((row: any) => ({
    id: row.id,
    org_id: row.org_id,
    project_id: row.project_id,
    schedule_item_id: row.schedule_item_id,
    user_id: row.user_id ?? undefined,
    contact_id: row.contact_id ?? undefined,
    company_id: row.company_id ?? undefined,
    role: row.role ?? "assigned",
    planned_hours: row.planned_hours ?? undefined,
    actual_hours: row.actual_hours ?? 0,
    hourly_rate_cents: row.hourly_rate_cents ?? undefined,
    notes: row.notes ?? undefined,
    confirmed_at: row.confirmed_at ?? undefined,
    created_at: row.created_at,
    updated_at: row.updated_at,
    user: row.user ?? undefined,
    contact: row.contact ?? undefined,
    company: row.company ?? undefined,
  }))
}

export async function listAssignmentsByProject(projectId: string, orgId?: string): Promise<ScheduleAssignment[]> {
  const { supabase, orgId: resolvedOrgId } = await requireOrgContext(orgId)

  const { data, error } = await supabase
    .from("schedule_assignments")
    .select(`
      id, org_id, project_id, schedule_item_id, user_id, contact_id, company_id,
      role, planned_hours, actual_hours, hourly_rate_cents, notes, confirmed_at, created_at, updated_at,
      user:app_users(id, full_name, avatar_url),
      contact:contacts(id, full_name, email),
      company:companies(id, name, company_type)
    `)
    .eq("org_id", resolvedOrgId)
    .eq("project_id", projectId)

  if (error) {
    throw new Error(`Failed to list assignments: ${error.message}`)
  }

  return (data ?? []).map((row: any) => ({
    id: row.id,
    org_id: row.org_id,
    project_id: row.project_id,
    schedule_item_id: row.schedule_item_id,
    user_id: row.user_id ?? undefined,
    contact_id: row.contact_id ?? undefined,
    company_id: row.company_id ?? undefined,
    role: row.role ?? "assigned",
    planned_hours: row.planned_hours ?? undefined,
    actual_hours: row.actual_hours ?? 0,
    hourly_rate_cents: row.hourly_rate_cents ?? undefined,
    notes: row.notes ?? undefined,
    confirmed_at: row.confirmed_at ?? undefined,
    created_at: row.created_at,
    updated_at: row.updated_at,
    user: row.user ?? undefined,
    contact: row.contact ?? undefined,
    company: row.company ?? undefined,
  }))
}

export async function createAssignment(input: ScheduleAssignmentInput, projectId: string, orgId?: string): Promise<ScheduleAssignment> {
  const parsed = scheduleAssignmentInputSchema.parse(input)
  const { supabase, orgId: resolvedOrgId } = await requireOrgContext(orgId)

  const { data, error } = await supabase
    .from("schedule_assignments")
    .insert({
      org_id: resolvedOrgId,
      project_id: projectId,
      schedule_item_id: parsed.schedule_item_id,
      user_id: parsed.user_id || null,
      contact_id: parsed.contact_id || null,
      company_id: parsed.company_id || null,
      role: parsed.role ?? "assigned",
      planned_hours: parsed.planned_hours ?? null,
      actual_hours: parsed.actual_hours ?? 0,
      hourly_rate_cents: parsed.hourly_rate_cents ?? null,
      notes: parsed.notes || null,
    })
    .select(`
      id, org_id, project_id, schedule_item_id, user_id, contact_id, company_id,
      role, planned_hours, actual_hours, hourly_rate_cents, notes, confirmed_at, created_at, updated_at,
      user:app_users(id, full_name, avatar_url),
      contact:contacts(id, full_name, email),
      company:companies(id, name, company_type)
    `)
    .single()

  if (error || !data) {
    throw new Error(`Failed to create assignment: ${error?.message}`)
  }

  const row = data as any
  return {
    id: row.id,
    org_id: row.org_id,
    project_id: row.project_id,
    schedule_item_id: row.schedule_item_id,
    user_id: row.user_id ?? undefined,
    contact_id: row.contact_id ?? undefined,
    company_id: row.company_id ?? undefined,
    role: row.role ?? "assigned",
    planned_hours: row.planned_hours ?? undefined,
    actual_hours: row.actual_hours ?? 0,
    hourly_rate_cents: row.hourly_rate_cents ?? undefined,
    notes: row.notes ?? undefined,
    confirmed_at: row.confirmed_at ?? undefined,
    created_at: row.created_at,
    updated_at: row.updated_at,
    user: row.user ?? undefined,
    contact: row.contact ?? undefined,
    company: row.company ?? undefined,
  }
}

export async function deleteAssignment(assignmentId: string, orgId?: string): Promise<void> {
  const { supabase, orgId: resolvedOrgId } = await requireOrgContext(orgId)

  const { error } = await supabase
    .from("schedule_assignments")
    .delete()
    .eq("org_id", resolvedOrgId)
    .eq("id", assignmentId)

  if (error) {
    throw new Error(`Failed to delete assignment: ${error.message}`)
  }
}

// ============================================================================
// BASELINES
// ============================================================================

export async function listBaselinesByProject(projectId: string, orgId?: string): Promise<ScheduleBaseline[]> {
  const { supabase, orgId: resolvedOrgId } = await requireOrgContext(orgId)

  const { data, error } = await supabase
    .from("schedule_baselines")
    .select("id, org_id, project_id, name, description, snapshot_at, items, is_active, created_by, created_at")
    .eq("org_id", resolvedOrgId)
    .eq("project_id", projectId)
    .order("created_at", { ascending: false })

  if (error) {
    throw new Error(`Failed to list baselines: ${error.message}`)
  }

  return (data ?? []).map((row) => ({
    id: row.id,
    org_id: row.org_id,
    project_id: row.project_id,
    name: row.name,
    description: row.description ?? undefined,
    snapshot_at: row.snapshot_at,
    items: row.items ?? [],
    is_active: row.is_active ?? false,
    created_by: row.created_by ?? undefined,
    created_at: row.created_at,
  }))
}

export async function createBaseline(input: ScheduleBaselineInput, orgId?: string): Promise<ScheduleBaseline> {
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)

  // Get current schedule items to snapshot
  const items = await listScheduleItemsByProject(input.project_id, resolvedOrgId)

  // If this will be active, deactivate other baselines first
  if (input.is_active) {
    await supabase
      .from("schedule_baselines")
      .update({ is_active: false })
      .eq("org_id", resolvedOrgId)
      .eq("project_id", input.project_id)
  }

  const { data, error } = await supabase
    .from("schedule_baselines")
    .insert({
      org_id: resolvedOrgId,
      project_id: input.project_id,
      name: input.name,
      description: input.description || null,
      items: items,
      is_active: input.is_active ?? false,
      created_by: userId,
    })
    .select("id, org_id, project_id, name, description, snapshot_at, items, is_active, created_by, created_at")
    .single()

  if (error || !data) {
    throw new Error(`Failed to create baseline: ${error?.message}`)
  }

  return {
    id: data.id,
    org_id: data.org_id,
    project_id: data.project_id,
    name: data.name,
    description: data.description ?? undefined,
    snapshot_at: data.snapshot_at,
    items: data.items ?? [],
    is_active: data.is_active ?? false,
    created_by: data.created_by ?? undefined,
    created_at: data.created_at,
  }
}

export async function setActiveBaseline(baselineId: string, projectId: string, orgId?: string): Promise<void> {
  const { supabase, orgId: resolvedOrgId } = await requireOrgContext(orgId)

  // Deactivate all baselines for this project
  await supabase
    .from("schedule_baselines")
    .update({ is_active: false })
    .eq("org_id", resolvedOrgId)
    .eq("project_id", projectId)

  // Activate the selected baseline
  const { error } = await supabase
    .from("schedule_baselines")
    .update({ is_active: true })
    .eq("org_id", resolvedOrgId)
    .eq("id", baselineId)

  if (error) {
    throw new Error(`Failed to set active baseline: ${error.message}`)
  }
}

export async function deleteBaseline(baselineId: string, orgId?: string): Promise<void> {
  const { supabase, orgId: resolvedOrgId } = await requireOrgContext(orgId)

  const { error } = await supabase
    .from("schedule_baselines")
    .delete()
    .eq("org_id", resolvedOrgId)
    .eq("id", baselineId)

  if (error) {
    throw new Error(`Failed to delete baseline: ${error.message}`)
  }
}

// ============================================================================
// TEMPLATES
// ============================================================================

export async function listTemplates(orgId?: string): Promise<ScheduleTemplate[]> {
  const { supabase, orgId: resolvedOrgId } = await requireOrgContext(orgId)

  const { data, error } = await supabase
    .from("schedule_templates")
    .select("id, org_id, name, description, project_type, property_type, items, is_public, created_by, created_at, updated_at")
    .or(`org_id.eq.${resolvedOrgId},is_public.eq.true`)
    .order("name", { ascending: true })

  if (error) {
    throw new Error(`Failed to list templates: ${error.message}`)
  }

  return (data ?? []).map((row) => ({
    id: row.id,
    org_id: row.org_id,
    name: row.name,
    description: row.description ?? undefined,
    project_type: row.project_type ?? undefined,
    property_type: row.property_type ?? undefined,
    items: row.items ?? [],
    is_public: row.is_public ?? false,
    created_by: row.created_by ?? undefined,
    created_at: row.created_at,
    updated_at: row.updated_at,
  }))
}

export async function createTemplate(input: ScheduleTemplateInput, orgId?: string): Promise<ScheduleTemplate> {
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)

  const { data, error } = await supabase
    .from("schedule_templates")
    .insert({
      org_id: resolvedOrgId,
      name: input.name,
      description: input.description || null,
      project_type: input.project_type || null,
      property_type: input.property_type || null,
      items: input.items ?? [],
      is_public: input.is_public ?? false,
      created_by: userId,
    })
    .select("id, org_id, name, description, project_type, property_type, items, is_public, created_by, created_at, updated_at")
    .single()

  if (error || !data) {
    throw new Error(`Failed to create template: ${error?.message}`)
  }

  return {
    id: data.id,
    org_id: data.org_id,
    name: data.name,
    description: data.description ?? undefined,
    project_type: data.project_type ?? undefined,
    property_type: data.property_type ?? undefined,
    items: data.items ?? [],
    is_public: data.is_public ?? false,
    created_by: data.created_by ?? undefined,
    created_at: data.created_at,
    updated_at: data.updated_at,
  }
}

export async function applyTemplate(templateId: string, projectId: string, orgId?: string): Promise<ScheduleItem[]> {
  const { supabase, orgId: resolvedOrgId } = await requireOrgContext(orgId)

  const { data: template, error } = await supabase
    .from("schedule_templates")
    .select("items")
    .eq("id", templateId)
    .single()

  if (error || !template) {
    throw new Error("Template not found")
  }

  const templateItems = template.items as Partial<ScheduleItem>[]
  const createdItems: ScheduleItem[] = []

  for (const item of templateItems) {
    const created = await createScheduleItem({
      input: {
        project_id: projectId,
        name: item.name ?? "Untitled",
        item_type: item.item_type ?? "task",
        status: "planned",
        phase: item.phase,
        trade: item.trade,
        planned_hours: item.planned_hours ?? 0,
        color: item.color,
        sort_order: item.sort_order ?? 0,
      } as any,
      orgId: resolvedOrgId,
    })
    createdItems.push(created)
  }

  return createdItems
}

export async function deleteTemplate(templateId: string, orgId?: string): Promise<void> {
  const { supabase, orgId: resolvedOrgId } = await requireOrgContext(orgId)

  const { error } = await supabase
    .from("schedule_templates")
    .delete()
    .eq("org_id", resolvedOrgId)
    .eq("id", templateId)

  if (error) {
    throw new Error(`Failed to delete template: ${error.message}`)
  }
}

// ============================================================================
// CHANGE ORDER INTEGRATION
// ============================================================================

function mapScheduleItemChangeOrder(row: any): ScheduleItemChangeOrder {
  return {
    id: row.id,
    org_id: row.org_id,
    schedule_item_id: row.schedule_item_id,
    change_order_id: row.change_order_id,
    days_adjusted: row.days_adjusted ?? 0,
    notes: row.notes ?? undefined,
    applied_at: row.applied_at ?? undefined,
    created_at: row.created_at,
    change_order: row.change_order ?? undefined,
  }
}

/**
 * Get all change order impacts for a schedule item
 */
export async function getScheduleChangeOrderImpacts(
  scheduleItemId: string,
  orgId?: string
): Promise<ScheduleItemChangeOrder[]> {
  const { supabase, orgId: resolvedOrgId } = await requireOrgContext(orgId)

  const { data, error } = await supabase
    .from("schedule_item_change_orders")
    .select(`
      id, org_id, schedule_item_id, change_order_id, days_adjusted, notes, applied_at, created_at,
      change_order:change_orders(id, co_number, title, status, amount_cents, days_impact)
    `)
    .eq("org_id", resolvedOrgId)
    .eq("schedule_item_id", scheduleItemId)
    .order("created_at", { ascending: false })

  if (error) {
    throw new Error(`Failed to get change order impacts: ${error.message}`)
  }

  return (data ?? []).map(mapScheduleItemChangeOrder)
}

/**
 * Get all change order impacts for a project's schedule items
 */
export async function getScheduleChangeOrderImpactsByProject(
  projectId: string,
  orgId?: string
): Promise<ScheduleItemChangeOrder[]> {
  const { supabase, orgId: resolvedOrgId } = await requireOrgContext(orgId)

  // Get all schedule items for this project
  const { data: scheduleItems } = await supabase
    .from("schedule_items")
    .select("id")
    .eq("org_id", resolvedOrgId)
    .eq("project_id", projectId)

  if (!scheduleItems?.length) return []

  const itemIds = scheduleItems.map((item) => item.id)

  const { data, error } = await supabase
    .from("schedule_item_change_orders")
    .select(`
      id, org_id, schedule_item_id, change_order_id, days_adjusted, notes, applied_at, created_at,
      change_order:change_orders(id, co_number, title, status, amount_cents, days_impact)
    `)
    .eq("org_id", resolvedOrgId)
    .in("schedule_item_id", itemIds)
    .order("created_at", { ascending: false })

  if (error) {
    throw new Error(`Failed to get change order impacts by project: ${error.message}`)
  }

  return (data ?? []).map(mapScheduleItemChangeOrder)
}

/**
 * Link a change order to a schedule item with an optional days adjustment
 */
export async function applyChangeOrderToSchedule({
  changeOrderId,
  scheduleItemId,
  daysAdjusted,
  notes,
  applyNow = false,
  orgId,
}: {
  changeOrderId: string
  scheduleItemId: string
  daysAdjusted: number
  notes?: string
  applyNow?: boolean
  orgId?: string
}): Promise<ScheduleItemChangeOrder> {
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)

  // Verify the schedule item exists
  const { data: scheduleItem, error: itemError } = await supabase
    .from("schedule_items")
    .select("id, name, project_id")
    .eq("org_id", resolvedOrgId)
    .eq("id", scheduleItemId)
    .single()

  if (itemError || !scheduleItem) {
    throw new Error("Schedule item not found")
  }

  // Verify the change order exists
  const { data: changeOrder, error: coError } = await supabase
    .from("change_orders")
    .select("id, co_number, title, status")
    .eq("org_id", resolvedOrgId)
    .eq("id", changeOrderId)
    .single()

  if (coError || !changeOrder) {
    throw new Error("Change order not found")
  }

  // Insert the link
  const { data, error } = await supabase
    .from("schedule_item_change_orders")
    .upsert(
      {
        org_id: resolvedOrgId,
        schedule_item_id: scheduleItemId,
        change_order_id: changeOrderId,
        days_adjusted: daysAdjusted,
        notes: notes || null,
        applied_at: applyNow ? new Date().toISOString() : null,
      },
      { onConflict: "schedule_item_id,change_order_id" }
    )
    .select(`
      id, org_id, schedule_item_id, change_order_id, days_adjusted, notes, applied_at, created_at
    `)
    .single()

  if (error || !data) {
    throw new Error(`Failed to apply change order to schedule: ${error?.message}`)
  }

  // If applying now, also adjust the schedule item dates
  if (applyNow && daysAdjusted !== 0) {
    await adjustScheduleItemDates(scheduleItemId, daysAdjusted, resolvedOrgId)
  }

  await recordEvent({
    orgId: resolvedOrgId,
    eventType: "schedule_co_applied",
    entityType: "schedule_item",
    entityId: scheduleItemId,
    payload: {
      change_order_id: changeOrderId,
      co_number: changeOrder.co_number,
      days_adjusted: daysAdjusted,
      applied: applyNow,
    },
  })

  await recordAudit({
    orgId: resolvedOrgId,
    actorId: userId,
    action: "insert",
    entityType: "schedule_item_change_order",
    entityId: data.id,
    after: data,
  })

  return mapScheduleItemChangeOrder({ ...data, change_order: changeOrder })
}

/**
 * Remove a change order link from a schedule item
 */
export async function removeChangeOrderFromSchedule(
  scheduleItemChangeOrderId: string,
  orgId?: string
): Promise<void> {
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)

  const { data: existing, error: fetchError } = await supabase
    .from("schedule_item_change_orders")
    .select("*")
    .eq("org_id", resolvedOrgId)
    .eq("id", scheduleItemChangeOrderId)
    .single()

  if (fetchError || !existing) {
    throw new Error("Schedule change order link not found")
  }

  const { error } = await supabase
    .from("schedule_item_change_orders")
    .delete()
    .eq("org_id", resolvedOrgId)
    .eq("id", scheduleItemChangeOrderId)

  if (error) {
    throw new Error(`Failed to remove change order link: ${error.message}`)
  }

  await recordAudit({
    orgId: resolvedOrgId,
    actorId: userId,
    action: "delete",
    entityType: "schedule_item_change_order",
    entityId: scheduleItemChangeOrderId,
    before: existing,
  })
}

/**
 * Helper to adjust schedule item dates by a number of days
 */
async function adjustScheduleItemDates(
  scheduleItemId: string,
  daysToAdd: number,
  orgId: string
): Promise<void> {
  const { supabase } = await requireOrgContext(orgId)

  const { data: item } = await supabase
    .from("schedule_items")
    .select("start_date, end_date")
    .eq("org_id", orgId)
    .eq("id", scheduleItemId)
    .single()

  if (!item) return

  const updateData: Record<string, string> = {}

  if (item.start_date) {
    const newStart = new Date(item.start_date)
    newStart.setDate(newStart.getDate() + daysToAdd)
    updateData.start_date = newStart.toISOString().split("T")[0]
  }

  if (item.end_date) {
    const newEnd = new Date(item.end_date)
    newEnd.setDate(newEnd.getDate() + daysToAdd)
    updateData.end_date = newEnd.toISOString().split("T")[0]
  }

  if (Object.keys(updateData).length > 0) {
    await supabase
      .from("schedule_items")
      .update(updateData)
      .eq("org_id", orgId)
      .eq("id", scheduleItemId)
  }
}

/**
 * Get the total days impact from all change orders on a schedule item
 */
export async function getTotalScheduleImpact(
  scheduleItemId: string,
  orgId?: string
): Promise<{ total_days: number; pending_days: number; applied_days: number }> {
  const { supabase, orgId: resolvedOrgId } = await requireOrgContext(orgId)

  const { data, error } = await supabase
    .from("schedule_item_change_orders")
    .select("days_adjusted, applied_at")
    .eq("org_id", resolvedOrgId)
    .eq("schedule_item_id", scheduleItemId)

  if (error) {
    throw new Error(`Failed to get total schedule impact: ${error.message}`)
  }

  const impacts = data ?? []
  const pending_days = impacts
    .filter((i) => !i.applied_at)
    .reduce((sum, i) => sum + (i.days_adjusted ?? 0), 0)
  const applied_days = impacts
    .filter((i) => i.applied_at)
    .reduce((sum, i) => sum + (i.days_adjusted ?? 0), 0)

  return {
    total_days: pending_days + applied_days,
    pending_days,
    applied_days,
  }
}

// ============================================================================
// DRAW SCHEDULE INTEGRATION
// ============================================================================

/**
 * Get all milestone items in a project that can be linked to draws
 */
export async function getDrawMilestones(
  projectId: string,
  orgId?: string
): Promise<ScheduleItem[]> {
  const { supabase, orgId: resolvedOrgId } = await requireOrgContext(orgId)
  const dependencyMap = await loadDependencies(supabase, resolvedOrgId)

  const { data, error } = await supabase
    .from("schedule_items")
    .select(`
      id, org_id, project_id, name, item_type, status, start_date, end_date,
      progress, assigned_to, metadata, created_at, updated_at,
      phase, trade, location, planned_hours, actual_hours,
      constraint_type, constraint_date, is_critical_path, float_days, color, sort_order,
      cost_code_id, budget_cents, actual_cost_cents
    `)
    .eq("org_id", resolvedOrgId)
    .eq("project_id", projectId)
    .eq("item_type", "milestone")
    .order("start_date", { ascending: true })

  if (error) {
    throw new Error(`Failed to get draw milestones: ${error.message}`)
  }

  return (data ?? []).map((row) => mapScheduleItem(row, dependencyMap))
}

/**
 * Link a milestone schedule item to a draw schedule
 */
export async function linkMilestoneToDraw({
  milestoneId,
  drawScheduleId,
  orgId,
}: {
  milestoneId: string
  drawScheduleId: string
  orgId?: string
}): Promise<void> {
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)

  // Verify the milestone exists and is a milestone type
  const { data: milestone, error: milestoneError } = await supabase
    .from("schedule_items")
    .select("id, name, item_type")
    .eq("org_id", resolvedOrgId)
    .eq("id", milestoneId)
    .single()

  if (milestoneError || !milestone) {
    throw new Error("Milestone not found")
  }

  if (milestone.item_type !== "milestone") {
    throw new Error("Only milestone items can be linked to draws")
  }

  // Update the draw schedule with the milestone reference
  const { error } = await supabase
    .from("draw_schedules")
    .update({ milestone_id: milestoneId })
    .eq("org_id", resolvedOrgId)
    .eq("id", drawScheduleId)

  if (error) {
    throw new Error(`Failed to link milestone to draw: ${error.message}`)
  }

  await recordEvent({
    orgId: resolvedOrgId,
    eventType: "draw_milestone_linked",
    entityType: "draw_schedule",
    entityId: drawScheduleId,
    payload: { milestone_id: milestoneId, milestone_name: milestone.name },
  })

  await recordAudit({
    orgId: resolvedOrgId,
    actorId: userId,
    action: "update",
    entityType: "draw_schedule",
    entityId: drawScheduleId,
    after: { milestone_id: milestoneId },
  })
}

/**
 * Remove milestone link from a draw schedule
 */
export async function unlinkMilestoneFromDraw(
  drawScheduleId: string,
  orgId?: string
): Promise<void> {
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)

  const { error } = await supabase
    .from("draw_schedules")
    .update({ milestone_id: null })
    .eq("org_id", resolvedOrgId)
    .eq("id", drawScheduleId)

  if (error) {
    throw new Error(`Failed to unlink milestone from draw: ${error.message}`)
  }

  await recordAudit({
    orgId: resolvedOrgId,
    actorId: userId,
    action: "update",
    entityType: "draw_schedule",
    entityId: drawScheduleId,
    after: { milestone_id: null },
  })
}

/**
 * Get draws linked to a specific milestone
 */
export async function getDrawsByMilestone(
  milestoneId: string,
  orgId?: string
): Promise<DrawSchedule[]> {
  const { supabase, orgId: resolvedOrgId } = await requireOrgContext(orgId)

  const { data, error } = await supabase
    .from("draw_schedules")
    .select(`
      id, org_id, project_id, draw_number, description, amount_cents,
      scheduled_date, status, milestone_id, created_at, updated_at
    `)
    .eq("org_id", resolvedOrgId)
    .eq("milestone_id", milestoneId)
    .order("draw_number", { ascending: true })

  if (error) {
    throw new Error(`Failed to get draws by milestone: ${error.message}`)
  }

  return (data ?? []).map((row) => ({
    id: row.id,
    org_id: row.org_id,
    project_id: row.project_id,
    draw_number: row.draw_number,
    title: (row as any).title ?? `Draw ${row.draw_number}`,
    description: row.description ?? undefined,
    amount_cents: row.amount_cents,
    due_date: row.scheduled_date ?? undefined,
    status: (row.status === "scheduled" ? "pending" : row.status) ?? "pending",
    milestone_id: row.milestone_id ?? undefined,
    created_at: row.created_at,
    updated_at: row.updated_at,
  })) as DrawSchedule[]
}

// ============================================================================
// COST CODE INTEGRATION
// ============================================================================

/**
 * Update schedule item cost tracking fields
 */
export async function updateScheduleItemCosts({
  itemId,
  costCodeId,
  budgetCents,
  actualCostCents,
  orgId,
}: {
  itemId: string
  costCodeId?: string | null
  budgetCents?: number | null
  actualCostCents?: number | null
  orgId?: string
}): Promise<ScheduleItem> {
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)

  const updateData: Record<string, any> = {}
  if (costCodeId !== undefined) updateData.cost_code_id = costCodeId
  if (budgetCents !== undefined) updateData.budget_cents = budgetCents
  if (actualCostCents !== undefined) updateData.actual_cost_cents = actualCostCents

  if (Object.keys(updateData).length === 0) {
    throw new Error("No cost fields to update")
  }

  const { data, error } = await supabase
    .from("schedule_items")
    .update(updateData)
    .eq("org_id", resolvedOrgId)
    .eq("id", itemId)
    .select(`
      id, org_id, project_id, name, item_type, status, start_date, end_date,
      progress, assigned_to, metadata, created_at, updated_at,
      phase, trade, location, planned_hours, actual_hours,
      constraint_type, constraint_date, is_critical_path, float_days, color, sort_order,
      cost_code_id, budget_cents, actual_cost_cents
    `)
    .single()

  if (error || !data) {
    throw new Error(`Failed to update schedule item costs: ${error?.message}`)
  }

  await recordAudit({
    orgId: resolvedOrgId,
    actorId: userId,
    action: "update",
    entityType: "schedule_item",
    entityId: itemId,
    after: updateData,
  })

  const dependencyMap = await loadDependencies(supabase, resolvedOrgId)
  return mapScheduleItem(data, dependencyMap)
}

/**
 * Get budget summary for schedule items grouped by cost code
 */
export async function getScheduleBudgetSummary(
  projectId: string,
  orgId?: string
): Promise<{
  total_budget_cents: number
  total_actual_cents: number
  variance_cents: number
  by_cost_code: Array<{
    cost_code_id: string | null
    cost_code_name?: string
    cost_code_number?: string
    budget_cents: number
    actual_cents: number
    item_count: number
  }>
}> {
  const { supabase, orgId: resolvedOrgId } = await requireOrgContext(orgId)

  const { data: items, error } = await supabase
    .from("schedule_items")
    .select(`
      id, cost_code_id, budget_cents, actual_cost_cents,
      cost_code:cost_codes(id, name, code)
    `)
    .eq("org_id", resolvedOrgId)
    .eq("project_id", projectId)

  if (error) {
    throw new Error(`Failed to get schedule budget summary: ${error.message}`)
  }

  // Aggregate by cost code
  const byCostCode = new Map<
    string | null,
    {
      cost_code_id: string | null
      cost_code_name?: string
      cost_code_number?: string
      budget_cents: number
      actual_cents: number
      item_count: number
    }
  >()

  let total_budget_cents = 0
  let total_actual_cents = 0

  for (const item of items ?? []) {
    const costCodeId = item.cost_code_id ?? null
    const costCode = item.cost_code as any

    if (!byCostCode.has(costCodeId)) {
      byCostCode.set(costCodeId, {
        cost_code_id: costCodeId,
        cost_code_name: costCode?.name,
        cost_code_number: costCode?.code,
        budget_cents: 0,
        actual_cents: 0,
        item_count: 0,
      })
    }

    const entry = byCostCode.get(costCodeId)!
    entry.budget_cents += item.budget_cents ?? 0
    entry.actual_cents += item.actual_cost_cents ?? 0
    entry.item_count += 1

    total_budget_cents += item.budget_cents ?? 0
    total_actual_cents += item.actual_cost_cents ?? 0
  }

  return {
    total_budget_cents,
    total_actual_cents,
    variance_cents: total_budget_cents - total_actual_cents,
    by_cost_code: Array.from(byCostCode.values()).sort((a, b) => {
      // Sort by cost code number, with null at the end
      if (!a.cost_code_number && !b.cost_code_number) return 0
      if (!a.cost_code_number) return 1
      if (!b.cost_code_number) return -1
      return a.cost_code_number.localeCompare(b.cost_code_number)
    }),
  }
}
