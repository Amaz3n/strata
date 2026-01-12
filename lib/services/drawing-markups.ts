import type {
  MarkupType,
  MarkupData,
  DrawingMarkupInput,
  DrawingMarkupUpdate,
  DrawingMarkupListFilters,
  PinEntityType,
  PinStatus,
  PinStyle,
  DrawingPinInput,
  DrawingPinUpdate,
  DrawingPinListFilters,
} from "@/lib/validation/drawings"
import {
  drawingMarkupInputSchema,
  drawingMarkupUpdateSchema,
  drawingMarkupListFiltersSchema,
  drawingPinInputSchema,
  drawingPinUpdateSchema,
  drawingPinListFiltersSchema,
} from "@/lib/validation/drawings"
import { requireOrgContext } from "@/lib/services/context"
import { recordAudit } from "@/lib/services/audit"
import { recordEvent } from "@/lib/services/events"

async function enqueueSheetsListRefresh(orgId: string) {
  try {
    const { supabase } = await requireOrgContext(orgId)
    await supabase.from("outbox").insert({
      org_id: orgId,
      // outbox.event_id may have an FK to events; leave null unless you have a real event row
      event_id: null,
      job_type: "refresh_drawing_sheets_list",
      status: "pending",
      run_at: new Date().toISOString(),
      retry_count: 0,
      last_error: "",
      payload: {},
    })
  } catch (e) {
    console.error("[drawings] Failed to enqueue drawing_sheets_list refresh:", e)
  }
}

// ============================================================================
// TYPES
// ============================================================================

export interface DrawingMarkup {
  id: string
  org_id: string
  drawing_sheet_id: string
  sheet_version_id?: string
  data: MarkupData
  label?: string
  is_private: boolean
  share_with_clients: boolean
  share_with_subs: boolean
  created_by?: string
  creator_name?: string
  creator_avatar?: string
  created_at: string
  updated_at: string
}

export interface DrawingPin {
  id: string
  org_id: string
  project_id: string
  drawing_sheet_id: string
  sheet_version_id?: string
  x_position: number
  y_position: number
  entity_type: PinEntityType
  entity_id: string
  label?: string
  style: PinStyle
  status?: PinStatus
  share_with_clients: boolean
  share_with_subs: boolean
  created_by?: string
  creator_name?: string
  creator_avatar?: string
  created_at: string
  updated_at: string
  // Related entity data (populated on fetch)
  entity_title?: string
  entity_status?: string
}

/**
 * Aggregated status counts for a sheet's pins.
 * Used for status indicator dots on sheet cards.
 */
export interface SheetStatusCounts {
  open: number
  inProgress: number
  completed: number
  total: number
  byType: Record<string, number>    // e.g., { task: 3, rfi: 1 }
  byStatus: Record<string, number>  // e.g., { open: 2, in_progress: 1 }
}

// ============================================================================
// MAPPERS
// ============================================================================

function mapDrawingMarkup(row: any): DrawingMarkup {
  return {
    id: row.id,
    org_id: row.org_id,
    drawing_sheet_id: row.drawing_sheet_id,
    sheet_version_id: row.sheet_version_id ?? undefined,
    data: row.data as MarkupData,
    label: row.label ?? undefined,
    is_private: row.is_private ?? false,
    share_with_clients: row.share_with_clients ?? false,
    share_with_subs: row.share_with_subs ?? false,
    created_by: row.created_by ?? undefined,
    creator_name: (row.app_users as any)?.full_name ?? undefined,
    creator_avatar: (row.app_users as any)?.avatar_url ?? undefined,
    created_at: row.created_at,
    updated_at: row.updated_at,
  }
}

function mapDrawingPin(row: any): DrawingPin {
  return {
    id: row.id,
    org_id: row.org_id,
    project_id: row.project_id,
    drawing_sheet_id: row.drawing_sheet_id,
    sheet_version_id: row.sheet_version_id ?? undefined,
    x_position: parseFloat(row.x_position),
    y_position: parseFloat(row.y_position),
    entity_type: row.entity_type as PinEntityType,
    entity_id: row.entity_id,
    label: row.label ?? undefined,
    style: (row.style as PinStyle) ?? {},
    status: row.status ?? undefined,
    share_with_clients: row.share_with_clients ?? false,
    share_with_subs: row.share_with_subs ?? false,
    created_by: row.created_by ?? undefined,
    creator_name: (row.app_users as any)?.full_name ?? undefined,
    creator_avatar: (row.app_users as any)?.avatar_url ?? undefined,
    created_at: row.created_at,
    updated_at: row.updated_at,
  }
}

// ============================================================================
// DRAWING MARKUPS
// ============================================================================

/**
 * List markups with filters
 */
export async function listDrawingMarkups(
  filters: Partial<DrawingMarkupListFilters> = {},
  orgId?: string
): Promise<DrawingMarkup[]> {
  const parsed = drawingMarkupListFiltersSchema.parse(filters)
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)

  let query = supabase
    .from("drawing_markups")
    .select(`
      id, org_id, drawing_sheet_id, sheet_version_id,
      data, label, is_private, share_with_clients, share_with_subs,
      created_by, created_at, updated_at,
      app_users!drawing_markups_created_by_fkey(full_name, avatar_url)
    `)
    .eq("org_id", resolvedOrgId)

  if (parsed.drawing_sheet_id) {
    query = query.eq("drawing_sheet_id", parsed.drawing_sheet_id)
  }

  if (parsed.sheet_version_id) {
    query = query.eq("sheet_version_id", parsed.sheet_version_id)
  }

  if (parsed.created_by) {
    query = query.eq("created_by", parsed.created_by)
  }

  // Filter by markup type within the JSON data
  if (parsed.markup_type) {
    query = query.eq("data->>type", parsed.markup_type)
  }

  // Filter private markups - only show current user's private markups
  if (!parsed.include_private) {
    query = query.or(`is_private.eq.false,created_by.eq.${userId}`)
  }

  const { data, error } = await query
    .order("created_at", { ascending: false })
    .range(parsed.offset, parsed.offset + parsed.limit - 1)

  if (error) {
    throw new Error(`Failed to list drawing markups: ${error.message}`)
  }

  return (data ?? []).map(mapDrawingMarkup)
}

/**
 * Get a single markup by ID
 */
export async function getDrawingMarkup(
  markupId: string,
  orgId?: string
): Promise<DrawingMarkup | null> {
  const { supabase, orgId: resolvedOrgId } = await requireOrgContext(orgId)

  const { data, error } = await supabase
    .from("drawing_markups")
    .select(`
      id, org_id, drawing_sheet_id, sheet_version_id,
      data, label, is_private, share_with_clients, share_with_subs,
      created_by, created_at, updated_at,
      app_users!drawing_markups_created_by_fkey(full_name, avatar_url)
    `)
    .eq("org_id", resolvedOrgId)
    .eq("id", markupId)
    .single()

  if (error) {
    if (error.code === "PGRST116") return null
    throw new Error(`Failed to get drawing markup: ${error.message}`)
  }

  return mapDrawingMarkup(data)
}

/**
 * Create a new markup
 */
export async function createDrawingMarkup(
  input: DrawingMarkupInput,
  orgId?: string
): Promise<DrawingMarkup> {
  const parsed = drawingMarkupInputSchema.parse(input)
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)

  const { data, error } = await supabase
    .from("drawing_markups")
    .insert({
      org_id: resolvedOrgId,
      drawing_sheet_id: parsed.drawing_sheet_id,
      sheet_version_id: parsed.sheet_version_id,
      data: parsed.data,
      label: parsed.label,
      is_private: parsed.is_private ?? false,
      share_with_clients: parsed.share_with_clients ?? false,
      share_with_subs: parsed.share_with_subs ?? false,
      created_by: userId,
    })
    .select(`
      id, org_id, drawing_sheet_id, sheet_version_id,
      data, label, is_private, share_with_clients, share_with_subs,
      created_by, created_at, updated_at,
      app_users!drawing_markups_created_by_fkey(full_name, avatar_url)
    `)
    .single()

  if (error || !data) {
    throw new Error(`Failed to create drawing markup: ${error?.message}`)
  }

  await recordAudit({
    orgId: resolvedOrgId,
    actorId: userId,
    action: "insert",
    entityType: "drawing_markup",
    entityId: data.id as string,
    after: data,
  })

  await recordEvent({
    orgId: resolvedOrgId,
    eventType: "drawing_markup_created",
    entityType: "drawing_markup",
    entityId: data.id as string,
    payload: {
      drawing_sheet_id: parsed.drawing_sheet_id,
      markup_type: parsed.data.type,
    },
  })

  // Keep denormalized list counts fresh (best-effort).
  await enqueueSheetsListRefresh(resolvedOrgId)

  return mapDrawingMarkup(data)
}

/**
 * Update a markup
 */
export async function updateDrawingMarkup(
  markupId: string,
  updates: DrawingMarkupUpdate,
  orgId?: string
): Promise<DrawingMarkup> {
  const parsed = drawingMarkupUpdateSchema.parse(updates)
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)

  const { data: existing, error: fetchError } = await supabase
    .from("drawing_markups")
    .select("*")
    .eq("org_id", resolvedOrgId)
    .eq("id", markupId)
    .single()

  if (fetchError || !existing) {
    throw new Error("Drawing markup not found")
  }

  const updateData: Record<string, any> = {}
  if (parsed.data !== undefined) updateData.data = parsed.data
  if (parsed.label !== undefined) updateData.label = parsed.label
  if (parsed.is_private !== undefined) updateData.is_private = parsed.is_private
  if (parsed.share_with_clients !== undefined) updateData.share_with_clients = parsed.share_with_clients
  if (parsed.share_with_subs !== undefined) updateData.share_with_subs = parsed.share_with_subs

  const { data, error } = await supabase
    .from("drawing_markups")
    .update(updateData)
    .eq("org_id", resolvedOrgId)
    .eq("id", markupId)
    .select(`
      id, org_id, drawing_sheet_id, sheet_version_id,
      data, label, is_private, share_with_clients, share_with_subs,
      created_by, created_at, updated_at,
      app_users!drawing_markups_created_by_fkey(full_name, avatar_url)
    `)
    .single()

  if (error || !data) {
    throw new Error(`Failed to update drawing markup: ${error?.message}`)
  }

  await recordAudit({
    orgId: resolvedOrgId,
    actorId: userId,
    action: "update",
    entityType: "drawing_markup",
    entityId: markupId,
    before: existing,
    after: data,
  })

  await enqueueSheetsListRefresh(resolvedOrgId)

  return mapDrawingMarkup(data)
}

/**
 * Delete a markup
 */
export async function deleteDrawingMarkup(markupId: string, orgId?: string): Promise<void> {
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)

  const { data: existing, error: fetchError } = await supabase
    .from("drawing_markups")
    .select("*")
    .eq("org_id", resolvedOrgId)
    .eq("id", markupId)
    .single()

  if (fetchError || !existing) {
    throw new Error("Drawing markup not found")
  }

  const { error } = await supabase
    .from("drawing_markups")
    .delete()
    .eq("org_id", resolvedOrgId)
    .eq("id", markupId)

  if (error) {
    throw new Error(`Failed to delete drawing markup: ${error.message}`)
  }

  await recordAudit({
    orgId: resolvedOrgId,
    actorId: userId,
    action: "delete",
    entityType: "drawing_markup",
    entityId: markupId,
    before: existing,
  })

  await enqueueSheetsListRefresh(resolvedOrgId)
}

/**
 * Bulk delete markups for a sheet
 */
export async function deleteMarkupsForSheet(
  sheetId: string,
  orgId?: string
): Promise<number> {
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)

  const { data, error } = await supabase
    .from("drawing_markups")
    .delete()
    .eq("org_id", resolvedOrgId)
    .eq("drawing_sheet_id", sheetId)
    .select("id")

  if (error) {
    throw new Error(`Failed to delete markups: ${error.message}`)
  }

  return data?.length ?? 0
}

// ============================================================================
// DRAWING PINS
// ============================================================================

/**
 * List pins with filters
 */
export async function listDrawingPins(
  filters: Partial<DrawingPinListFilters> = {},
  orgId?: string
): Promise<DrawingPin[]> {
  const parsed = drawingPinListFiltersSchema.parse(filters)
  const { supabase, orgId: resolvedOrgId } = await requireOrgContext(orgId)

  let query = supabase
    .from("drawing_pins")
    .select(`
      id, org_id, project_id, drawing_sheet_id, sheet_version_id,
      x_position, y_position, entity_type, entity_id,
      label, style, status, share_with_clients, share_with_subs,
      created_by, created_at, updated_at,
      app_users!drawing_pins_created_by_fkey(full_name, avatar_url)
    `)
    .eq("org_id", resolvedOrgId)

  if (parsed.project_id) {
    query = query.eq("project_id", parsed.project_id)
  }

  if (parsed.drawing_sheet_id) {
    query = query.eq("drawing_sheet_id", parsed.drawing_sheet_id)
  }

  if (parsed.sheet_version_id) {
    query = query.eq("sheet_version_id", parsed.sheet_version_id)
  }

  if (parsed.entity_type) {
    query = query.eq("entity_type", parsed.entity_type)
  }

  if (parsed.entity_id) {
    query = query.eq("entity_id", parsed.entity_id)
  }

  if (parsed.status) {
    query = query.eq("status", parsed.status)
  }

  if (parsed.created_by) {
    query = query.eq("created_by", parsed.created_by)
  }

  const { data, error } = await query
    .order("created_at", { ascending: false })
    .range(parsed.offset, parsed.offset + parsed.limit - 1)

  if (error) {
    throw new Error(`Failed to list drawing pins: ${error.message}`)
  }

  return (data ?? []).map(mapDrawingPin)
}

/**
 * List pins for a sheet with entity details
 * This function enriches pins with entity information
 */
export async function listDrawingPinsWithEntities(
  sheetId: string,
  orgId?: string
): Promise<DrawingPin[]> {
  const pins = await listDrawingPins({ drawing_sheet_id: sheetId }, orgId)
  const { supabase } = await requireOrgContext(orgId)

  // Group pins by entity type for batch fetching
  const pinsByType: Record<PinEntityType, DrawingPin[]> = {
    task: [],
    rfi: [],
    punch_list: [],
    submittal: [],
    daily_log: [],
    observation: [],
    issue: [],
  }

  for (const pin of pins) {
    pinsByType[pin.entity_type].push(pin)
  }

  // Fetch entity titles for each type
  const entityMap = new Map<string, { title: string; status?: string }>()

  // Fetch tasks
  if (pinsByType.task.length > 0) {
    const { data } = await supabase
      .from("tasks")
      .select("id, title, status")
      .in("id", pinsByType.task.map((p) => p.entity_id))
    for (const task of data ?? []) {
      entityMap.set(task.id, { title: task.title, status: task.status })
    }
  }

  // Fetch RFIs
  if (pinsByType.rfi.length > 0) {
    const { data } = await supabase
      .from("rfis")
      .select("id, subject, status")
      .in("id", pinsByType.rfi.map((p) => p.entity_id))
    for (const rfi of data ?? []) {
      entityMap.set(rfi.id, { title: rfi.subject, status: rfi.status })
    }
  }

  // Fetch punch list items
  if (pinsByType.punch_list.length > 0) {
    const { data } = await supabase
      .from("punch_list_items")
      .select("id, title, status")
      .in("id", pinsByType.punch_list.map((p) => p.entity_id))
    for (const item of data ?? []) {
      entityMap.set(item.id, { title: item.title, status: item.status })
    }
  }

  // Fetch submittals
  if (pinsByType.submittal.length > 0) {
    const { data } = await supabase
      .from("submittals")
      .select("id, title, status")
      .in("id", pinsByType.submittal.map((p) => p.entity_id))
    for (const submittal of data ?? []) {
      entityMap.set(submittal.id, { title: submittal.title, status: submittal.status })
    }
  }

  // Enrich pins with entity data
  return pins.map((pin) => {
    const entityData = entityMap.get(pin.entity_id)
    return {
      ...pin,
      entity_title: entityData?.title ?? pin.label,
      entity_status: entityData?.status,
    }
  })
}

/**
 * Get a single pin by ID
 */
export async function getDrawingPin(
  pinId: string,
  orgId?: string
): Promise<DrawingPin | null> {
  const { supabase, orgId: resolvedOrgId } = await requireOrgContext(orgId)

  const { data, error } = await supabase
    .from("drawing_pins")
    .select(`
      id, org_id, project_id, drawing_sheet_id, sheet_version_id,
      x_position, y_position, entity_type, entity_id,
      label, style, status, share_with_clients, share_with_subs,
      created_by, created_at, updated_at,
      app_users!drawing_pins_created_by_fkey(full_name, avatar_url)
    `)
    .eq("org_id", resolvedOrgId)
    .eq("id", pinId)
    .single()

  if (error) {
    if (error.code === "PGRST116") return null
    throw new Error(`Failed to get drawing pin: ${error.message}`)
  }

  return mapDrawingPin(data)
}

/**
 * Get pins for a specific entity
 */
export async function getPinsForEntity(
  entityType: PinEntityType,
  entityId: string,
  orgId?: string
): Promise<DrawingPin[]> {
  return listDrawingPins({ entity_type: entityType, entity_id: entityId }, orgId)
}

/**
 * Create a new pin
 */
export async function createDrawingPin(
  input: DrawingPinInput,
  orgId?: string
): Promise<DrawingPin> {
  const parsed = drawingPinInputSchema.parse(input)
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)

  const { data, error } = await supabase
    .from("drawing_pins")
    .insert({
      org_id: resolvedOrgId,
      project_id: parsed.project_id,
      drawing_sheet_id: parsed.drawing_sheet_id,
      sheet_version_id: parsed.sheet_version_id,
      x_position: parsed.x_position,
      y_position: parsed.y_position,
      entity_type: parsed.entity_type,
      entity_id: parsed.entity_id,
      label: parsed.label,
      style: parsed.style ?? {},
      status: parsed.status,
      share_with_clients: parsed.share_with_clients ?? false,
      share_with_subs: parsed.share_with_subs ?? false,
      created_by: userId,
    })
    .select(`
      id, org_id, project_id, drawing_sheet_id, sheet_version_id,
      x_position, y_position, entity_type, entity_id,
      label, style, status, share_with_clients, share_with_subs,
      created_by, created_at, updated_at,
      app_users!drawing_pins_created_by_fkey(full_name, avatar_url)
    `)
    .single()

  if (error || !data) {
    throw new Error(`Failed to create drawing pin: ${error?.message}`)
  }

  await recordAudit({
    orgId: resolvedOrgId,
    actorId: userId,
    action: "insert",
    entityType: "drawing_pin",
    entityId: data.id as string,
    after: data,
  })

  await recordEvent({
    orgId: resolvedOrgId,
    eventType: "drawing_pin_created",
    entityType: "drawing_pin",
    entityId: data.id as string,
    payload: {
      drawing_sheet_id: parsed.drawing_sheet_id,
      linked_entity_type: parsed.entity_type,
      linked_entity_id: parsed.entity_id,
    },
  })

  await enqueueSheetsListRefresh(resolvedOrgId)

  return mapDrawingPin(data)
}

/**
 * Update a pin
 */
export async function updateDrawingPin(
  pinId: string,
  updates: DrawingPinUpdate,
  orgId?: string
): Promise<DrawingPin> {
  const parsed = drawingPinUpdateSchema.parse(updates)
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)

  const { data: existing, error: fetchError } = await supabase
    .from("drawing_pins")
    .select("*")
    .eq("org_id", resolvedOrgId)
    .eq("id", pinId)
    .single()

  if (fetchError || !existing) {
    throw new Error("Drawing pin not found")
  }

  const updateData: Record<string, any> = {}
  if (parsed.x_position !== undefined) updateData.x_position = parsed.x_position
  if (parsed.y_position !== undefined) updateData.y_position = parsed.y_position
  if (parsed.label !== undefined) updateData.label = parsed.label
  if (parsed.style !== undefined) updateData.style = parsed.style
  if (parsed.status !== undefined) updateData.status = parsed.status
  if (parsed.share_with_clients !== undefined) updateData.share_with_clients = parsed.share_with_clients
  if (parsed.share_with_subs !== undefined) updateData.share_with_subs = parsed.share_with_subs

  const { data, error } = await supabase
    .from("drawing_pins")
    .update(updateData)
    .eq("org_id", resolvedOrgId)
    .eq("id", pinId)
    .select(`
      id, org_id, project_id, drawing_sheet_id, sheet_version_id,
      x_position, y_position, entity_type, entity_id,
      label, style, status, share_with_clients, share_with_subs,
      created_by, created_at, updated_at,
      app_users!drawing_pins_created_by_fkey(full_name, avatar_url)
    `)
    .single()

  if (error || !data) {
    throw new Error(`Failed to update drawing pin: ${error?.message}`)
  }

  await recordAudit({
    orgId: resolvedOrgId,
    actorId: userId,
    action: "update",
    entityType: "drawing_pin",
    entityId: pinId,
    before: existing,
    after: data,
  })

  await enqueueSheetsListRefresh(resolvedOrgId)

  return mapDrawingPin(data)
}

/**
 * Delete a pin
 */
export async function deleteDrawingPin(pinId: string, orgId?: string): Promise<void> {
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)

  const { data: existing, error: fetchError } = await supabase
    .from("drawing_pins")
    .select("*")
    .eq("org_id", resolvedOrgId)
    .eq("id", pinId)
    .single()

  if (fetchError || !existing) {
    throw new Error("Drawing pin not found")
  }

  const { error } = await supabase
    .from("drawing_pins")
    .delete()
    .eq("org_id", resolvedOrgId)
    .eq("id", pinId)

  if (error) {
    throw new Error(`Failed to delete drawing pin: ${error.message}`)
  }

  await recordAudit({
    orgId: resolvedOrgId,
    actorId: userId,
    action: "delete",
    entityType: "drawing_pin",
    entityId: pinId,
    before: existing,
  })

  await enqueueSheetsListRefresh(resolvedOrgId)
}

/**
 * Delete pin when entity is deleted
 */
export async function deletePinForEntity(
  entityType: PinEntityType,
  entityId: string,
  orgId?: string
): Promise<void> {
  const { supabase, orgId: resolvedOrgId } = await requireOrgContext(orgId)

  const { error } = await supabase
    .from("drawing_pins")
    .delete()
    .eq("org_id", resolvedOrgId)
    .eq("entity_type", entityType)
    .eq("entity_id", entityId)

  if (error) {
    throw new Error(`Failed to delete pin for entity: ${error.message}`)
  }
}

/**
 * Update pin status when entity status changes
 */
export async function syncPinStatus(
  entityType: PinEntityType,
  entityId: string,
  newStatus: PinStatus,
  orgId?: string
): Promise<void> {
  const { supabase, orgId: resolvedOrgId } = await requireOrgContext(orgId)

  const { error } = await supabase
    .from("drawing_pins")
    .update({ status: newStatus })
    .eq("org_id", resolvedOrgId)
    .eq("entity_type", entityType)
    .eq("entity_id", entityId)

  if (error) {
    throw new Error(`Failed to sync pin status: ${error.message}`)
  }
}

// ============================================================================
// HELPERS
// ============================================================================

/**
 * Get markup counts by type for a sheet
 */
export async function getMarkupCountsByType(
  sheetId: string,
  orgId?: string
): Promise<Record<MarkupType, number>> {
  const { supabase, orgId: resolvedOrgId } = await requireOrgContext(orgId)

  const { data, error } = await supabase
    .from("drawing_markups")
    .select("data->>type")
    .eq("org_id", resolvedOrgId)
    .eq("drawing_sheet_id", sheetId)

  if (error) {
    throw new Error(`Failed to get markup counts: ${error.message}`)
  }

  const counts: Partial<Record<MarkupType, number>> = {}
  for (const row of data ?? []) {
    const type = (row as any)["data->>type"] as MarkupType
    if (type) {
      counts[type] = (counts[type] ?? 0) + 1
    }
  }

  return counts as Record<MarkupType, number>
}

/**
 * Get pin counts by status for a sheet
 */
export async function getPinCountsByStatus(
  sheetId: string,
  orgId?: string
): Promise<Record<string, number>> {
  const { supabase, orgId: resolvedOrgId } = await requireOrgContext(orgId)

  const { data, error } = await supabase
    .from("drawing_pins")
    .select("status")
    .eq("org_id", resolvedOrgId)
    .eq("drawing_sheet_id", sheetId)

  if (error) {
    throw new Error(`Failed to get pin counts: ${error.message}`)
  }

  const counts: Record<string, number> = { total: data?.length ?? 0 }
  for (const row of data ?? []) {
    const status = row.status ?? "unknown"
    counts[status] = (counts[status] ?? 0) + 1
  }

  return counts
}

/**
 * Get pin counts by entity type for a sheet
 */
export async function getPinCountsByEntityType(
  sheetId: string,
  orgId?: string
): Promise<Record<PinEntityType, number>> {
  const { supabase, orgId: resolvedOrgId } = await requireOrgContext(orgId)

  const { data, error } = await supabase
    .from("drawing_pins")
    .select("entity_type")
    .eq("org_id", resolvedOrgId)
    .eq("drawing_sheet_id", sheetId)

  if (error) {
    throw new Error(`Failed to get pin counts: ${error.message}`)
  }

  const counts: Partial<Record<PinEntityType, number>> = {}
  for (const row of data ?? []) {
    const type = row.entity_type as PinEntityType
    counts[type] = (counts[type] ?? 0) + 1
  }

  return counts as Record<PinEntityType, number>
}

/**
 * Get aggregated pin status counts for multiple sheets.
 * Optimized for batch loading in grid/list views.
 */
export async function getSheetStatusCounts({
  sheetIds,
  orgId,
}: {
  sheetIds: string[]
  orgId?: string
}): Promise<Record<string, SheetStatusCounts>> {
  if (sheetIds.length === 0) {
    return {}
  }

  const { supabase, orgId: resolvedOrgId } = await requireOrgContext(orgId)

  const { data, error } = await supabase
    .from("drawing_pins")
    .select("drawing_sheet_id, status, entity_type")
    .eq("org_id", resolvedOrgId)
    .in("drawing_sheet_id", sheetIds)

  if (error) {
    throw new Error(`Failed to get sheet status counts: ${error.message}`)
  }

  // Initialize counts for all sheets
  const counts: Record<string, SheetStatusCounts> = {}

  for (const sheetId of sheetIds) {
    counts[sheetId] = {
      open: 0,
      inProgress: 0,
      completed: 0,
      total: 0,
      byType: {},
      byStatus: {},
    }
  }

  // Aggregate by sheet
  for (const pin of data ?? []) {
    const sheetCounts = counts[pin.drawing_sheet_id]
    if (!sheetCounts) continue

    sheetCounts.total++

    // Aggregate by status category
    const status = pin.status ?? "unknown"
    if (["open", "pending"].includes(status)) {
      sheetCounts.open++
    } else if (status === "in_progress") {
      sheetCounts.inProgress++
    } else if (["closed", "approved"].includes(status)) {
      sheetCounts.completed++
    }

    // Detailed breakdowns
    sheetCounts.byType[pin.entity_type] = (sheetCounts.byType[pin.entity_type] || 0) + 1
    sheetCounts.byStatus[status] = (sheetCounts.byStatus[status] || 0) + 1
  }

  return counts
}
