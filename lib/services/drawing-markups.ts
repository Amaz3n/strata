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
import { hasPermission, requirePermission } from "@/lib/services/permissions"
import { recordAudit } from "@/lib/services/audit"
import { recordEvent } from "@/lib/services/events"
import { enqueueSheetsListRefresh } from "@/lib/services/drawings"
import {
  assertConditionAcceptsUom,
  loadMeasurementContext,
  measureMarkup,
} from "@/lib/services/drawing-measurements"
import { MEASURING_MARKUP_TYPES, type MeasureUom } from "@/lib/drawings/measure"

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
  /** Real-world measurement, computed server-side. Null on non-measuring or uncalibrated markups. */
  quantity: number | null
  uom: MeasureUom | null
  /** Takeoff condition this measurement rolls into. */
  condition_id: string | null
  created_by?: string
  creator_name?: string
  creator_avatar?: string
  created_at: string
  updated_at: string
  carried_from_markup_id?: string
  carried_from_revision_id?: string
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
    // numeric arrives as a string over the wire; the UI does arithmetic on it.
    quantity: row.quantity === null || row.quantity === undefined ? null : Number(row.quantity),
    uom: (row.uom as MeasureUom | null) ?? null,
    condition_id: row.condition_id ?? null,
    created_by: row.created_by ?? undefined,
    creator_name: (row.app_users as any)?.full_name ?? undefined,
    creator_avatar: (row.app_users as any)?.avatar_url ?? undefined,
    created_at: row.created_at,
    updated_at: row.updated_at,
    carried_from_markup_id: row.carried_from_markup_id ?? undefined,
    carried_from_revision_id: row.carried_from_revision_id ?? undefined,
  }
}

export async function inheritPublishedMarkupsToRevision(input: {
  supabase: import("@supabase/supabase-js").SupabaseClient
  orgId: string
  drawingSheetId: string
  newVersionId: string
}) {
  const { data: priorVersion } = await input.supabase.from("drawing_sheet_versions").select("id")
    .eq("org_id", input.orgId).eq("drawing_sheet_id", input.drawingSheetId).neq("id", input.newVersionId)
    .order("created_at", { ascending: false }).limit(1).maybeSingle()
  if (!priorVersion) return { carried: 0 }
  const { data: markups, error } = await input.supabase.from("drawing_markups")
    .select("id,data,label,is_private,share_with_clients,share_with_subs,created_by")
    .eq("org_id", input.orgId).eq("drawing_sheet_id", input.drawingSheetId).eq("sheet_version_id", priorVersion.id)
    .eq("is_private", false)
  if (error) throw new Error(`Failed to load markups for inheritance: ${error.message}`)
  const carry = (markups ?? []).filter((markup) => {
    const type = markup.data && typeof markup.data === "object" && !Array.isArray(markup.data) ? markup.data.type : null
    return type !== "freehand"
  }).map((markup) => ({
    org_id: input.orgId, drawing_sheet_id: input.drawingSheetId, sheet_version_id: input.newVersionId,
    data: markup.data, label: markup.label, is_private: false, share_with_clients: markup.share_with_clients,
    share_with_subs: markup.share_with_subs, created_by: markup.created_by,
    carried_from_markup_id: markup.id, carried_from_revision_id: priorVersion.id,
  }))
  if (!carry.length) return { carried: 0 }
  const { error: insertError } = await input.supabase.from("drawing_markups").upsert(carry, { onConflict: "sheet_version_id,carried_from_markup_id", ignoreDuplicates: true })
  if (insertError) throw new Error(`Failed to carry drawing markups: ${insertError.message}`)
  return { carried: carry.length }
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
  await requirePermission("drawing.read", { supabase, orgId: resolvedOrgId, userId })

  let query = supabase
    .from("drawing_markups")
    .select(`
      id, org_id, drawing_sheet_id, sheet_version_id,
      data, label, is_private, share_with_clients, share_with_subs,
      quantity, uom, condition_id,
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

  if (parsed.condition_id) {
    query = query.eq("condition_id", parsed.condition_id)
  }

  if (parsed.measuring_only) {
    query = query.in("data->>type", [...MEASURING_MARKUP_TYPES])
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
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  await requirePermission("drawing.read", { supabase, orgId: resolvedOrgId, userId })

  const { data, error } = await supabase
    .from("drawing_markups")
    .select(`
      id, org_id, drawing_sheet_id, sheet_version_id,
      data, label, is_private, share_with_clients, share_with_subs,
      quantity, uom, condition_id,
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

  // Privacy on the single-get path mirrors the list path: a private markup
  // exists only for the person who drew it.
  if (data.is_private && data.created_by !== userId) return null

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
  await requirePermission("drawing.markup", { supabase, orgId: resolvedOrgId, userId })

  // The measured value is computed here, never accepted from the client — a
  // quantity that flows into an estimate has to be derived from geometry the
  // server can re-derive it from.
  const measurement = parsed.sheet_version_id
    ? measureMarkup(
        parsed.data,
        await loadMeasurementContext(supabase, resolvedOrgId, parsed.sheet_version_id),
      )
    : measureMarkup(parsed.data, { imageSize: null, feetPerImagePx: null })

  if (parsed.condition_id) {
    await assertConditionAcceptsUom(supabase, resolvedOrgId, parsed.condition_id, measurement.uom)
  }

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
      quantity: measurement.quantity,
      uom: measurement.uom,
      condition_id: parsed.condition_id ?? null,
      created_by: userId,
    })
    .select(`
      id, org_id, drawing_sheet_id, sheet_version_id,
      data, label, is_private, share_with_clients, share_with_subs,
      quantity, uom, condition_id,
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
      quantity: measurement.quantity,
      uom: measurement.uom,
      condition_id: parsed.condition_id ?? null,
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
  await requirePermission("drawing.markup", { supabase, orgId: resolvedOrgId, userId })

  const { data: existing, error: fetchError } = await supabase
    .from("drawing_markups")
    .select("*")
    .eq("org_id", resolvedOrgId)
    .eq("id", markupId)
    .single()

  if (fetchError || !existing) {
    throw new Error("Drawing markup not found")
  }

  // Ownership: only the creator edits a markup. A private markup is invisible
  // to everyone else, so a non-creator gets the same answer as a missing row.
  if (existing.is_private && existing.created_by !== userId) {
    throw new Error("Drawing markup not found")
  }
  if (existing.created_by !== userId) {
    // A row with no recorded creator can only be maintained by someone trusted
    // to manage the drawing register itself.
    const canManageOwnerless =
      existing.created_by === null &&
      (await hasPermission("drawing.upload", { supabase, orgId: resolvedOrgId, userId }))
    if (!canManageOwnerless) {
      throw new Error("Only the markup's creator can edit this markup")
    }
  }

  const updateData: Record<string, any> = {}
  if (parsed.data !== undefined) updateData.data = parsed.data
  if (parsed.label !== undefined) updateData.label = parsed.label
  if (parsed.is_private !== undefined) updateData.is_private = parsed.is_private
  if (parsed.share_with_clients !== undefined) updateData.share_with_clients = parsed.share_with_clients
  if (parsed.share_with_subs !== undefined) updateData.share_with_subs = parsed.share_with_subs

  // Geometry changed → the stored quantity is stale. Recompute against the
  // version this markup is pinned to before anything can roll it up.
  const nextData = (parsed.data ?? existing.data) as MarkupData
  const measurement = existing.sheet_version_id
    ? measureMarkup(
        nextData,
        await loadMeasurementContext(supabase, resolvedOrgId, existing.sheet_version_id as string),
      )
    : measureMarkup(nextData, { imageSize: null, feetPerImagePx: null })

  if (parsed.data !== undefined) {
    updateData.quantity = measurement.quantity
    updateData.uom = measurement.uom
  }

  if (parsed.condition_id !== undefined) {
    if (parsed.condition_id) {
      await assertConditionAcceptsUom(supabase, resolvedOrgId, parsed.condition_id, measurement.uom)
    }
    updateData.condition_id = parsed.condition_id
  }

  const { data, error } = await supabase
    .from("drawing_markups")
    .update(updateData)
    .eq("org_id", resolvedOrgId)
    .eq("id", markupId)
    .select(`
      id, org_id, drawing_sheet_id, sheet_version_id,
      data, label, is_private, share_with_clients, share_with_subs,
      quantity, uom, condition_id,
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
  await requirePermission("drawing.markup", { supabase, orgId: resolvedOrgId, userId })

  const { data: existing, error: fetchError } = await supabase
    .from("drawing_markups")
    .select("*")
    .eq("org_id", resolvedOrgId)
    .eq("id", markupId)
    .single()

  if (fetchError || !existing) {
    throw new Error("Drawing markup not found")
  }

  // A private markup can only be deleted by its creator — and stays invisible
  // to everyone else. A shared markup can additionally be removed by someone
  // holding drawing.upload, the register-management capability: whoever is
  // trusted to publish the sheets can also clean up what is drawn on them.
  if (existing.is_private && existing.created_by !== userId) {
    throw new Error("Drawing markup not found")
  }
  if (existing.created_by !== userId) {
    const canManage = await hasPermission("drawing.upload", { supabase, orgId: resolvedOrgId, userId })
    if (!canManage) {
      throw new Error("Only the markup's creator or a drawing manager can delete this markup")
    }
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
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  await requirePermission("drawing.read", { supabase, orgId: resolvedOrgId, userId })

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
  const { supabase, orgId: resolvedOrgId } = await requireOrgContext(orgId)
  const pins = await listDrawingPins({ drawing_sheet_id: sheetId }, resolvedOrgId)

  // Group pins by entity type for batch fetching
  const pinsByType: Record<PinEntityType, DrawingPin[]> = {
    task: [],
    rfi: [],
    punch_list: [],
    submittal: [],
    daily_log: [],
    observation: [],
    photo: [],
  }

  for (const pin of pins) {
    // Rows may carry `issue`, retired because it never had an entity of its
    // own; those skip enrichment and fall back to the pin label below.
    pinsByType[pin.entity_type]?.push(pin)
  }

  const entityMap = new Map<string, { title: string; status?: string }>()

  const [tasks, rfis, punchItems, submittals, dailyLogs, observations, photos] =
    await Promise.all([
    pinsByType.task.length > 0
      ? supabase
          .from("tasks")
          .select("id, title, status")
          .eq("org_id", resolvedOrgId)
          .in("id", pinsByType.task.map((p) => p.entity_id))
          .then(({ data }) => data ?? [])
      : Promise.resolve([]),
    pinsByType.rfi.length > 0
      ? supabase
          .from("rfis")
          .select("id, subject, status")
          .eq("org_id", resolvedOrgId)
          .in("id", pinsByType.rfi.map((p) => p.entity_id))
          .then(({ data }) => data ?? [])
      : Promise.resolve([]),
    pinsByType.punch_list.length > 0
      ? supabase
          .from("punch_items")
          .select("id, title, status")
          .eq("org_id", resolvedOrgId)
          .in("id", pinsByType.punch_list.map((p) => p.entity_id))
          .then(({ data }) => data ?? [])
      : Promise.resolve([]),
    pinsByType.submittal.length > 0
      ? supabase
          .from("submittals")
          .select("id, title, status")
          .eq("org_id", resolvedOrgId)
          .in("id", pinsByType.submittal.map((p) => p.entity_id))
          .then(({ data }) => data ?? [])
      : Promise.resolve([]),
    pinsByType.daily_log.length > 0
      ? supabase
          .from("daily_logs")
          .select("id, log_date, summary")
          .eq("org_id", resolvedOrgId)
          .in("id", pinsByType.daily_log.map((p) => p.entity_id))
          .then(({ data }) => data ?? [])
      : Promise.resolve([]),
    // Observations carry no title column — the description is the record.
    pinsByType.observation.length > 0
      ? supabase
          .from("observations")
          .select("id, description, status")
          .eq("org_id", resolvedOrgId)
          .in("id", pinsByType.observation.map((p) => p.entity_id))
          .then(({ data }) => data ?? [])
      : Promise.resolve([]),
    // Photos: title is the underlying file name (the pin's own label carries
    // the caption and wins in the enrichment below when present).
    pinsByType.photo.length > 0
      ? (async () => {
          const { data: photoRows } = await supabase
            .from("photos")
            .select("id, file_id")
            .eq("org_id", resolvedOrgId)
            .in("id", pinsByType.photo.map((p) => p.entity_id))
          const fileIds = (photoRows ?? [])
            .map((row) => row.file_id as string | null)
            .filter((value): value is string => !!value)
          const nameByFileId = new Map<string, string>()
          if (fileIds.length > 0) {
            const { data: fileRows } = await supabase
              .from("files")
              .select("id, file_name")
              .eq("org_id", resolvedOrgId)
              .in("id", fileIds)
            for (const file of fileRows ?? []) {
              nameByFileId.set(file.id as string, file.file_name as string)
            }
          }
          return (photoRows ?? []).map((row) => ({
            id: row.id as string,
            title: nameByFileId.get(row.file_id as string) ?? "Photo",
          }))
        })()
      : Promise.resolve([]),
  ])

  for (const task of tasks) {
    entityMap.set(task.id, { title: task.title, status: task.status })
  }
  for (const rfi of rfis) {
    entityMap.set(rfi.id, { title: rfi.subject, status: rfi.status })
  }
  for (const item of punchItems) {
    entityMap.set(item.id, { title: item.title, status: item.status })
  }
  for (const submittal of submittals) {
    entityMap.set(submittal.id, { title: submittal.title, status: submittal.status })
  }
  for (const log of dailyLogs) {
    entityMap.set(log.id, {
      title: log.summary || `Daily Log ${log.log_date ?? ""}`.trim(),
    })
  }
  for (const observation of observations) {
    entityMap.set(observation.id, {
      title: observation.description,
      status: observation.status,
    })
  }
  for (const photo of photos) {
    entityMap.set(photo.id, { title: photo.title })
  }

  // Enrich pins with entity data. For photo pins the label IS the caption, so
  // it takes precedence over the file-name title.
  return pins.map((pin) => {
    const entityData = entityMap.get(pin.entity_id)
    return {
      ...pin,
      entity_title:
        pin.entity_type === "photo"
          ? pin.label ?? entityData?.title
          : entityData?.title ?? pin.label,
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
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  await requirePermission("drawing.read", { supabase, orgId: resolvedOrgId, userId })

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
  await requirePermission("drawing.markup", { supabase, orgId: resolvedOrgId, userId })

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
  await requirePermission("drawing.markup", { supabase, orgId: resolvedOrgId, userId })

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
  await requirePermission("drawing.markup", { supabase, orgId: resolvedOrgId, userId })

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
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  await requirePermission("drawing.markup", { supabase, orgId: resolvedOrgId, userId })

  const { data: deleted, error } = await supabase
    .from("drawing_pins")
    .delete()
    .eq("org_id", resolvedOrgId)
    .eq("entity_type", entityType)
    .eq("entity_id", entityId)
    .select("*")

  if (error) {
    throw new Error(`Failed to delete pin for entity: ${error.message}`)
  }

  for (const pin of deleted ?? []) {
    await recordAudit({
      orgId: resolvedOrgId,
      actorId: userId,
      action: "delete",
      entityType: "drawing_pin",
      entityId: pin.id as string,
      before: pin,
    })
  }

  if ((deleted?.length ?? 0) > 0) {
    await enqueueSheetsListRefresh(resolvedOrgId)
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
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  await requirePermission("drawing.markup", { supabase, orgId: resolvedOrgId, userId })

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
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  await requirePermission("drawing.read", { supabase, orgId: resolvedOrgId, userId })

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
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  await requirePermission("drawing.read", { supabase, orgId: resolvedOrgId, userId })

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
  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  await requirePermission("drawing.read", { supabase, orgId: resolvedOrgId, userId })

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

  const { supabase, orgId: resolvedOrgId, userId } = await requireOrgContext(orgId)
  await requirePermission("drawing.read", { supabase, orgId: resolvedOrgId, userId })

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
