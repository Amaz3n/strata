import type { SupabaseClient } from "@supabase/supabase-js"

import type { 
  ScheduleItem, 
  ScheduleAssignment, 
  ScheduleDependency, 
  ScheduleBaseline,
  ScheduleTemplate 
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
      constraint_type, constraint_date, is_critical_path, float_days, color, sort_order
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
      constraint_type, constraint_date, is_critical_path, float_days, color, sort_order
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
      constraint_type, constraint_date, is_critical_path, float_days, color, sort_order
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
      constraint_type, constraint_date, is_critical_path, float_days, color, sort_order
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
      constraint_type, constraint_date, is_critical_path, float_days, color, sort_order
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
            constraint_type, constraint_date, is_critical_path, float_days, color, sort_order
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

  const dependencyMap =
    parsed.dependencies !== undefined 
      ? { [data.id]: parsed.dependencies } 
      : await loadDependencies(supabase, resolvedOrgId)

  return mapScheduleItem(data, dependencyMap)
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
          constraint_type, constraint_date, is_critical_path, float_days, color, sort_order
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
        planned_hours: item.planned_hours,
        color: item.color,
        sort_order: item.sort_order,
      },
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
