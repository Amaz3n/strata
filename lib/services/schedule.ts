import type { SupabaseClient } from "@supabase/supabase-js"

import type { ScheduleItem } from "@/lib/types"
import type { ScheduleItemInput } from "@/lib/validation/schedule"
import { scheduleItemUpdateSchema } from "@/lib/validation/schedule"
import { recordEvent } from "@/lib/services/events"
import { recordAudit } from "@/lib/services/audit"
import { requireOrgContext } from "@/lib/services/context"

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
  }
}

async function loadDependencies(supabase: SupabaseClient, orgId: string) {
  const { data, error } = await supabase
    .from("schedule_dependencies")
    .select("item_id, depends_on_item_id")
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

export async function listScheduleItems(orgId?: string): Promise<ScheduleItem[]> {
  const { supabase, orgId: resolvedOrgId } = await requireOrgContext(orgId)
  return listScheduleItemsWithClient(supabase, resolvedOrgId)
}

export async function listScheduleItemsWithClient(supabase: SupabaseClient, orgId: string): Promise<ScheduleItem[]> {
  const dependencyMap = await loadDependencies(supabase, orgId)

  const { data, error } = await supabase
    .from("schedule_items")
    .select(
      "id, org_id, project_id, name, item_type, status, start_date, end_date, progress, assigned_to, metadata, created_at, updated_at",
    )
    .eq("org_id", orgId)
    .order("start_date", { ascending: true, nullsFirst: false })

  if (error) {
    throw new Error(`Failed to list schedule items: ${error.message}`)
  }

  return (data ?? []).map((row) => mapScheduleItem(row, dependencyMap))
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
      start_date: input.start_date,
      end_date: input.end_date,
      progress: input.progress ?? 0,
      assigned_to: input.assigned_to,
      metadata: input.metadata ?? {},
    })
    .select(
      "id, org_id, project_id, name, item_type, status, start_date, end_date, progress, assigned_to, metadata, created_at, updated_at",
    )
    .single()

  if (error || !data) {
    throw new Error(`Failed to create schedule item: ${error?.message}`)
  }

  if (input.dependencies?.length) {
    const dependencyRows = input.dependencies.map((depId) => ({
      org_id: resolvedOrgId,
      project_id: input.project_id,
      item_id: data.id,
      depends_on_item_id: depId,
    }))

    const { error: dependencyError } = await supabase.from("schedule_dependencies").insert(dependencyRows)
    if (dependencyError) {
      console.error("Failed to create schedule dependencies", dependencyError)
    }
  }

  await recordEvent({
    orgId: resolvedOrgId,
    eventType: "schedule_created",
    entityType: "schedule_item",
    entityId: data.id as string,
    payload: { name: input.name, project_id: input.project_id },
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
    .select(
      "id, org_id, project_id, name, item_type, status, start_date, end_date, progress, assigned_to, metadata, created_at, updated_at",
    )
    .eq("org_id", resolvedOrgId)
    .eq("id", itemId)
    .single()

  if (existing.error || !existing.data) {
    throw new Error("Schedule item not found or not accessible")
  }

  const updateData: Record<string, any> = {}
  if (parsed.name !== undefined) updateData.name = parsed.name
  if (parsed.item_type !== undefined) updateData.item_type = parsed.item_type
  if (parsed.status !== undefined) updateData.status = parsed.status
  if (parsed.start_date !== undefined) updateData.start_date = parsed.start_date
  if (parsed.end_date !== undefined) updateData.end_date = parsed.end_date
  if (parsed.progress !== undefined) updateData.progress = parsed.progress
  if (parsed.assigned_to !== undefined) updateData.assigned_to = parsed.assigned_to
  if (parsed.metadata !== undefined) updateData.metadata = parsed.metadata

  const { data, error } =
    Object.keys(updateData).length === 0
      ? { data: existing.data, error: null }
      : await supabase
          .from("schedule_items")
          .update(updateData)
          .eq("org_id", resolvedOrgId)
          .eq("id", itemId)
          .select(
            "id, org_id, project_id, name, item_type, status, start_date, end_date, progress, assigned_to, metadata, created_at, updated_at",
          )
          .single()

  if (error || !data) {
    throw new Error(`Failed to update schedule item: ${error?.message}`)
  }

  if (parsed.dependencies) {
    await supabase.from("schedule_dependencies").delete().eq("org_id", resolvedOrgId).eq("item_id", itemId)

    if (parsed.dependencies.length) {
      const dependencyRows = parsed.dependencies.map((depId) => ({
        org_id: resolvedOrgId,
        project_id: data.project_id,
        item_id: data.id,
        depends_on_item_id: depId,
      }))
      const { error: dependencyError } = await supabase.from("schedule_dependencies").insert(dependencyRows)
      if (dependencyError) {
        console.error("Failed to update schedule dependencies", dependencyError)
      }
    }
  }

  await recordEvent({
    orgId: resolvedOrgId,
    eventType: "schedule_updated",
    entityType: "schedule_item",
    entityId: data.id as string,
    payload: { name: data.name, status: data.status },
  })

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
    parsed.dependencies !== undefined ? { [data.id]: parsed.dependencies } : await loadDependencies(supabase, resolvedOrgId)

  return mapScheduleItem(data, dependencyMap)
}
