import { requireOrgContext } from "@/lib/services/context"
import { requireAnyPermission, requirePermission } from "@/lib/services/permissions"
import { recordAudit } from "@/lib/services/audit"
import { recordEvent } from "@/lib/services/events"
import { closeoutItemInputSchema, closeoutItemUpdateSchema, type CloseoutItemInput, type CloseoutItemUpdate } from "@/lib/validation/closeout"
import type { CloseoutItem, CloseoutPackage } from "@/lib/types"

const defaultItems = [
  "As-built drawings",
  "O&M manuals",
  "Final lien waivers",
  "Warranty certificates",
  "Final inspection sign-off",
  "Closeout punch list",
]

const baseCloseoutItemSelect =
  "id, org_id, project_id, closeout_package_id, title, status, file_id, created_at, updated_at"
const extendedCloseoutItemSelect =
  "id, org_id, project_id, closeout_package_id, title, status, file_id, due_date, responsible_party, notes, created_at, updated_at"

function isMissingCloseoutOptionalColumnError(error: { message?: string } | null | undefined) {
  const message = error?.message ?? ""
  return (
    message.includes("column closeout_items.due_date does not exist") ||
    message.includes("column closeout_items.responsible_party does not exist") ||
    message.includes("column closeout_items.notes does not exist")
  )
}

function mapPackage(row: any): CloseoutPackage {
  return {
    id: row.id,
    org_id: row.org_id,
    project_id: row.project_id,
    status: row.status ?? "in_progress",
    created_at: row.created_at,
    updated_at: row.updated_at ?? row.created_at,
  }
}

function mapItem(row: any): CloseoutItem {
  return {
    id: row.id,
    org_id: row.org_id,
    project_id: row.project_id,
    closeout_package_id: row.closeout_package_id ?? undefined,
    title: row.title,
    status: row.status ?? "missing",
    file_id: row.file_id ?? undefined,
    due_date: row.due_date ?? undefined,
    responsible_party: row.responsible_party ?? undefined,
    notes: row.notes ?? undefined,
    attachment_count: row.attachment_count ?? 0,
    created_at: row.created_at,
    updated_at: row.updated_at ?? row.created_at,
  }
}

async function ensurePackage(projectId: string, orgId: string) {
  const { supabase } = await requireOrgContext(orgId)

  const { data: existing } = await supabase
    .from("closeout_packages")
    .select("id, org_id, project_id, status, created_at, updated_at")
    .eq("org_id", orgId)
    .eq("project_id", projectId)
    .maybeSingle()

  if (existing) return mapPackage(existing)

  const { data: created, error } = await supabase
    .from("closeout_packages")
    .insert({ org_id: orgId, project_id: projectId, status: "in_progress" })
    .select("id, org_id, project_id, status, created_at, updated_at")
    .single()

  if (error || !created) {
    throw new Error(`Failed to create closeout package: ${error?.message}`)
  }

  const itemRows = defaultItems.map((title) => ({
    org_id: orgId,
    project_id: projectId,
    closeout_package_id: created.id,
    title,
    status: "missing",
  }))
  await supabase.from("closeout_items").insert(itemRows)

  return mapPackage(created)
}

export async function getCloseoutPackage(projectId: string, orgId?: string): Promise<{ package: CloseoutPackage; items: CloseoutItem[] }> {
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  await requireAnyPermission(["org.member", "org.read"], { supabase, orgId: resolvedOrgId, userId })

  const pkg = await ensurePackage(projectId, resolvedOrgId)

  const loadItems = async (selectClause: string) =>
    supabase
      .from("closeout_items")
      .select(selectClause)
      .eq("org_id", resolvedOrgId)
      .eq("closeout_package_id", pkg.id)
      .order("created_at", { ascending: true })

  let { data, error } = await loadItems(extendedCloseoutItemSelect)

  if (error && isMissingCloseoutOptionalColumnError(error)) {
    const fallback = await loadItems(baseCloseoutItemSelect)
    data = fallback.data
    error = fallback.error
  }

  if (error) {
    throw new Error(`Failed to load closeout items: ${error.message}`)
  }

  const itemRows = (data as any[]) ?? []
  const itemIds = itemRows.map((item) => item.id as string)
  const attachmentCounts = new Map<string, number>()

  if (itemIds.length > 0) {
    const { data: links, error: linksError } = await supabase
      .from("file_links")
      .select("entity_id")
      .eq("org_id", resolvedOrgId)
      .eq("entity_type", "closeout_item")
      .in("entity_id", itemIds)

    if (linksError) {
      throw new Error(`Failed to load closeout file counts: ${linksError.message}`)
    }

    for (const link of links ?? []) {
      const entityId = link.entity_id as string
      attachmentCounts.set(entityId, (attachmentCounts.get(entityId) ?? 0) + 1)
    }
  }

  return {
    package: pkg,
    items: itemRows.map((item) => mapItem({ ...item, attachment_count: attachmentCounts.get(item.id as string) ?? 0 })),
  }
}

export async function createCloseoutItem({
  input,
  orgId,
}: {
  input: CloseoutItemInput
  orgId?: string
}): Promise<CloseoutItem> {
  const parsed = closeoutItemInputSchema.parse(input)
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  await requirePermission("org.member", { supabase, orgId: resolvedOrgId, userId })

  const pkg = parsed.closeout_package_id
    ? { id: parsed.closeout_package_id }
    : await ensurePackage(parsed.project_id, resolvedOrgId)

  let { data, error } = await supabase
    .from("closeout_items")
    .insert({
      org_id: resolvedOrgId,
      project_id: parsed.project_id,
      closeout_package_id: pkg.id,
      title: parsed.title,
      status: parsed.status ?? "missing",
      file_id: parsed.file_id ?? null,
      due_date: parsed.due_date ?? null,
      responsible_party: parsed.responsible_party?.trim() || null,
      notes: parsed.notes?.trim() || null,
    })
    .select("id, org_id, project_id, closeout_package_id, title, status, file_id, due_date, responsible_party, notes, created_at, updated_at")
    .single()

  if (error && isMissingCloseoutOptionalColumnError(error)) {
    const fallback = await supabase
      .from("closeout_items")
      .insert({
        org_id: resolvedOrgId,
        project_id: parsed.project_id,
        closeout_package_id: pkg.id,
        title: parsed.title,
        status: parsed.status ?? "missing",
        file_id: parsed.file_id ?? null,
      })
      .select(baseCloseoutItemSelect)
      .single()

    if (fallback.error || !fallback.data) {
      throw new Error(`Failed to create closeout item: ${fallback.error?.message ?? error.message}`)
    }

    data = fallback.data as any
    error = null as any
  }

  if (error || !data) {
    throw new Error(`Failed to create closeout item: ${error?.message}`)
  }

  await recordEvent({
    orgId: resolvedOrgId,
    eventType: "closeout_item_created",
    entityType: "closeout_item",
    entityId: data.id as string,
    payload: { project_id: parsed.project_id, title: parsed.title },
  })

  await recordAudit({
    orgId: resolvedOrgId,
    actorId: userId,
    action: "insert",
    entityType: "closeout_item",
    entityId: data.id as string,
    after: data,
  })

  return mapItem(data)
}

export async function updateCloseoutItem({
  itemId,
  input,
  orgId,
}: {
  itemId: string
  input: CloseoutItemUpdate
  orgId?: string
}): Promise<CloseoutItem> {
  const parsed = closeoutItemUpdateSchema.parse(input)
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  await requirePermission("org.member", { supabase, orgId: resolvedOrgId, userId })

  const { data: existing, error: existingError } = await supabase
    .from("closeout_items")
    .select(extendedCloseoutItemSelect)
    .eq("org_id", resolvedOrgId)
    .eq("id", itemId)
    .maybeSingle()

  let existingItem = existing
  let lookupError = existingError
  if (lookupError && isMissingCloseoutOptionalColumnError(lookupError)) {
    const fallback = await supabase
      .from("closeout_items")
      .select(baseCloseoutItemSelect)
      .eq("org_id", resolvedOrgId)
      .eq("id", itemId)
      .maybeSingle()

    existingItem = fallback.data as any
    lookupError = fallback.error
  }

  if (lookupError || !existingItem) {
    throw new Error("Closeout item not found")
  }

  const updateData: Record<string, any> = {}
  if (parsed.title !== undefined) updateData.title = parsed.title
  if (parsed.status !== undefined) updateData.status = parsed.status
  if (parsed.file_id !== undefined) updateData.file_id = parsed.file_id
  if (parsed.due_date !== undefined) updateData.due_date = parsed.due_date
  if (parsed.responsible_party !== undefined) updateData.responsible_party = parsed.responsible_party?.trim() || null
  if (parsed.notes !== undefined) updateData.notes = parsed.notes?.trim() || null
  updateData.updated_at = new Date().toISOString()

  const { data, error } = await supabase
    .from("closeout_items")
    .update(updateData)
    .eq("org_id", resolvedOrgId)
    .eq("id", itemId)
    .select(extendedCloseoutItemSelect)
    .single()

  let updatedItem = data
  let updateError = error
  if (updateError && isMissingCloseoutOptionalColumnError(updateError)) {
    const fallbackData = { ...updateData }
    delete fallbackData.due_date
    delete fallbackData.responsible_party
    delete fallbackData.notes

    const fallback = await supabase
      .from("closeout_items")
      .update(fallbackData)
      .eq("org_id", resolvedOrgId)
      .eq("id", itemId)
      .select(baseCloseoutItemSelect)
      .single()

      updatedItem = fallback.data as any
      updateError = fallback.error
      }

      if (updateError || !updatedItem) {
      throw new Error(`Failed to update closeout item: ${updateError?.message}`)
      }


  await recordEvent({
    orgId: resolvedOrgId,
    eventType: "closeout_item_updated",
    entityType: "closeout_item",
    entityId: updatedItem.id as string,
    payload: { project_id: updatedItem.project_id, status: updatedItem.status },
  })

  await recordAudit({
    orgId: resolvedOrgId,
    actorId: userId,
    action: "update",
    entityType: "closeout_item",
    entityId: updatedItem.id as string,
    before: existingItem,
    after: updatedItem,
  })

  if (updatedItem.closeout_package_id) {
    const { data: items } = await supabase
      .from("closeout_items")
      .select("status")
      .eq("org_id", resolvedOrgId)
      .eq("closeout_package_id", updatedItem.closeout_package_id)

    const total = items?.length ?? 0
    const completed = (items ?? []).filter((item) => item.status === "complete").length
    const nextStatus = total > 0 && completed === total ? "complete" : "in_progress"

    await supabase
      .from("closeout_packages")
      .update({ status: nextStatus, updated_at: new Date().toISOString() })
      .eq("org_id", resolvedOrgId)
      .eq("id", updatedItem.closeout_package_id)
  }

  return mapItem(updatedItem)
}
