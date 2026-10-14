import type { SupabaseClient } from "@supabase/supabase-js"
import { z } from "zod"

import { recordAudit } from "@/lib/services/audit"
import { requireAuthorization } from "@/lib/services/authorization"
import { requireOrgContext } from "@/lib/services/context"
import { recordEvent } from "@/lib/services/events"
import { requirePermission } from "@/lib/services/permissions"
import { resolveVisibleProjectIds } from "@/lib/services/projects"
import { createServiceSupabaseClient } from "@/lib/supabase/server"
import {
  openSlots,
  pickRoom,
  sessionInterval,
  zonedTimeToUtc,
  type HoursWindow,
  type Interval,
  type OpenSlot,
} from "@/lib/selections/appointment-slots"
import {
  appointmentOutcomeSchema,
  bookAppointmentSchema,
  cancelAppointmentSchema,
  consultantHoursSchema,
  openSlotsSchema,
  rescheduleAppointmentSchema,
  studioLocationSchema,
  studioRoomsSchema,
  type AppointmentOutcomeInput,
  type BookAppointmentInput,
  type CancelAppointmentInput,
  type ConsultantHoursInput,
  type OpenSlotsInput,
  type RescheduleAppointmentInput,
  type StudioLocationInput,
  type StudioRoomsInput,
} from "@/lib/validation/design-studio"

/**
 * Design studio sessions: who meets the buyer, where, and when.
 *
 * The database is the fence (20261013100000): a consultant is never in two
 * sessions at once, a studio never holds more sessions than it has rooms in
 * service, a session sits inside the consultant's hours at that studio and
 * before every covered cutoff, and every booking, move and cancellation queues
 * the buyer's notice in the same transaction. This service authorizes the
 * caller on the home, picks a free room, writes with the service role (a
 * member's own JWT writes nothing here), and turns the database's refusal into
 * the coordinator's sentence.
 */

type OrgContext = Awaited<ReturnType<typeof requireOrgContext>>

type AppointmentStatus = "scheduled" | "completed" | "no_show" | "canceled"

export interface AppointmentDto {
  id: string
  projectId: string
  communityId: string | null
  contactId: string | null
  consultantUserId: string | null
  locationId: string | null
  roomId: string | null
  scheduledAt: string
  endsAt: string
  durationMinutes: number
  status: AppointmentStatus
  revision: number
  groupIds: string[]
  notes: string | null
  cancelReason: string | null
  projectName: string | null
  communityName: string | null
  buyerName: string | null
  /** False when the home has no buyer, or the buyer has no email: the coordinator tells them. */
  buyerHasEmail: boolean
  consultantName: string | null
  locationName: string | null
  roomName: string | null
  /** The studio's zone; every time on this session reads in it. */
  timeZone: string | null
}

interface StudioRoomDto {
  id: string
  name: string
  isActive: boolean
}

interface StudioConsultantDto {
  userId: string
  name: string
  windows: HoursWindow[]
}

export interface StudioLocationDto {
  id: string
  name: string
  address: string | null
  timeZone: string
  divisionId: string | null
  isArchived: boolean
  rooms: StudioRoomDto[]
  /** Everyone with hours at this studio. */
  consultants: StudioConsultantDto[]
}

export interface StudioDirectory {
  locations: StudioLocationDto[]
  /** Everyone who may run a session (design_studio.manage), for the hours table. */
  consultants: Array<{ userId: string; name: string }>
}

const APPOINTMENT_COLUMNS =
  "id, org_id, community_id, project_id, contact_id, coordinator_user_id, location_id, room_id, scheduled_at, ends_at, duration_minutes, status, revision, group_ids, notes, cancel_reason"
const APPOINTMENT_SELECT = `${APPOINTMENT_COLUMNS}, project:projects!inner(name, division_id), community:communities(name), buyer:contacts(full_name, email), consultant:app_users!design_studio_appointments_coordinator_user_id_fkey(full_name), location:design_studio_locations(name, time_zone), room:design_studio_rooms(name)`

/** The calendar list is a page; `countAppointments` says how many there are. */
const APPOINTMENT_LIST_CAP = 100
const STUDIO_CAP = 50
const DAY_BOOKING_CAP = 500

const uuid = z.string().uuid()

/** A PostgREST embed arrives as one object or, for a to-many shape, a list of one. */
function embedded<T extends z.ZodTypeAny>(shape: T) {
  return z.union([shape, z.array(shape)]).nullish()
}

function relation<T>(value: T | T[] | null | undefined): T | null {
  if (Array.isArray(value)) return value[0] ?? null
  return value ?? null
}

const appointmentRowSchema = z.object({
  id: uuid,
  community_id: uuid.nullable(),
  project_id: uuid,
  contact_id: uuid.nullable(),
  coordinator_user_id: uuid.nullable(),
  location_id: uuid.nullable(),
  room_id: uuid.nullable(),
  scheduled_at: z.string(),
  ends_at: z.string(),
  duration_minutes: z.number(),
  status: z.enum(["scheduled", "completed", "no_show", "canceled"]),
  revision: z.number(),
  group_ids: z.array(uuid).nullable(),
  notes: z.string().nullable(),
  cancel_reason: z.string().nullable(),
  project: embedded(z.object({ name: z.string().nullable() })),
  community: embedded(z.object({ name: z.string().nullable() })),
  buyer: embedded(z.object({ full_name: z.string().nullable(), email: z.string().nullable() })),
  consultant: embedded(z.object({ full_name: z.string().nullable() })),
  location: embedded(z.object({ name: z.string().nullable(), time_zone: z.string().nullable() })),
  room: embedded(z.object({ name: z.string().nullable() })),
})
type AppointmentRow = z.infer<typeof appointmentRowSchema>

function toAppointmentDto(row: AppointmentRow): AppointmentDto {
  const location = relation(row.location)
  return {
    id: row.id,
    projectId: row.project_id,
    communityId: row.community_id,
    contactId: row.contact_id,
    consultantUserId: row.coordinator_user_id,
    locationId: row.location_id,
    roomId: row.room_id,
    scheduledAt: row.scheduled_at,
    endsAt: row.ends_at,
    durationMinutes: row.duration_minutes,
    status: row.status,
    revision: row.revision,
    groupIds: row.group_ids ?? [],
    notes: row.notes,
    cancelReason: row.cancel_reason,
    projectName: relation(row.project)?.name ?? null,
    communityName: relation(row.community)?.name ?? null,
    buyerName: relation(row.buyer)?.full_name ?? null,
    buyerHasEmail: Boolean(relation(row.buyer)?.email?.trim()),
    consultantName: relation(row.consultant)?.full_name ?? null,
    locationName: location?.name ?? null,
    roomName: relation(row.room)?.name ?? null,
    timeZone: location?.time_zone ?? null,
  }
}

// ---------------------------------------------------------------------------
// Reading the calendar.
// ---------------------------------------------------------------------------

interface AppointmentFilter {
  communityId?: string
  /** Narrows to sessions on this division's homes. */
  divisionId?: string
  projectId?: string
  from?: string
  to?: string
  /** Defaults to every status but canceled: a canceled session holds no time. */
  statuses?: AppointmentStatus[]
}

const LIVE_STATUSES: AppointmentStatus[] = ["scheduled", "completed", "no_show"]

/**
 * The calendar shows the homes the reader can see: a division- or
 * project-scoped coordinator does not read another division's buyers. The list
 * and its count both resolve visibility here so they cannot disagree. Reading
 * is part of every selections surface; booking keeps the stricter permission.
 */
async function appointmentQuery(context: OrgContext, opts: AppointmentFilter, head: boolean) {
  // Returned wrapped: an awaited query builder would run the query.
  await requirePermission("selections.read", context)
  const visibleProjectIds = await resolveVisibleProjectIds({ ...context, includePrecon: true })
  if (visibleProjectIds?.length === 0) return null
  let query = head
    ? context.supabase.from("design_studio_appointments").select("id, project:projects!inner(division_id)", { count: "exact", head: true })
    : context.supabase.from("design_studio_appointments").select(APPOINTMENT_SELECT)
  query = query.eq("org_id", context.orgId).in("status", opts.statuses ?? LIVE_STATUSES)
  if (visibleProjectIds) query = query.in("project_id", visibleProjectIds)
  if (opts.divisionId) query = query.eq("project.division_id", opts.divisionId)
  if (opts.communityId) query = query.eq("community_id", opts.communityId)
  if (opts.projectId) query = query.eq("project_id", opts.projectId)
  if (opts.from) query = query.gte("ends_at", opts.from)
  if (opts.to) query = query.lt("scheduled_at", opts.to)
  return { query }
}

/** How many sessions match, uncapped -- `listAppointments` returns a page. */
export async function countAppointments(opts: AppointmentFilter = {}): Promise<number> {
  const context = await requireOrgContext()
  const scoped = await appointmentQuery(context, opts, true)
  if (!scoped) return 0
  const { count, error } = await scoped.query
  if (error) throw new Error(`Failed to count design studio sessions: ${error.message}`)
  return count ?? 0
}

export async function listAppointments(opts: AppointmentFilter & { limit?: number } = {}): Promise<AppointmentDto[]> {
  const context = await requireOrgContext()
  const scoped = await appointmentQuery(context, opts, false)
  if (!scoped) return []
  const { data, error } = await scoped.query.order("scheduled_at").limit(Math.min(opts.limit ?? 50, APPOINTMENT_LIST_CAP))
  if (error) throw new Error(`Failed to load design studio sessions: ${error.message}`)
  return (data ?? []).map((row) => toAppointmentDto(appointmentRowSchema.parse(row)))
}

const HOME_BATCH = 200

const homeNextRowSchema = z.object({ project_id: uuid, scheduled_at: z.string() })

/**
 * The next scheduled session of each home, for a desk that asks "who has no
 * session booked". Read per home batch, so a busy calendar never pushes a
 * booked home off the end of a capped page.
 */
export async function nextAppointmentsByHome(projectIds: string[]): Promise<Map<string, string>> {
  const context = await requireOrgContext()
  await requirePermission("selections.read", context)
  const next = new Map<string, string>()
  const now = new Date().toISOString()
  const batches = Array.from({ length: Math.ceil(projectIds.length / HOME_BATCH) }, (_, index) => projectIds.slice(index * HOME_BATCH, (index + 1) * HOME_BATCH))
  const results = await Promise.all(batches.map((batch) =>
    context.supabase
      .from("design_studio_appointments")
      .select("project_id, scheduled_at")
      .eq("org_id", context.orgId)
      .eq("status", "scheduled")
      .gte("ends_at", now)
      .in("project_id", batch)
      .order("scheduled_at")
      .limit(DAY_BOOKING_CAP)))
  for (const { data, error } of results) {
    if (error) throw new Error(`Failed to load booked sessions: ${error.message}`)
    for (const row of z.array(homeNextRowSchema).parse(data ?? [])) {
      if (!next.has(row.project_id)) next.set(row.project_id, row.scheduled_at)
    }
  }
  return next
}

/** The home's next scheduled session, read for that home alone. */
export async function getNextAppointmentForHome(projectId: string): Promise<AppointmentDto | null> {
  const [next] = await listAppointments({ projectId, statuses: ["scheduled"], from: new Date().toISOString(), limit: 1 })
  return next ?? null
}

// ---------------------------------------------------------------------------
// Studios, rooms and hours.
// ---------------------------------------------------------------------------

const consultantRowSchema = z.object({ id: uuid, full_name: z.string().nullable(), email: z.string().nullable() })

async function consultantNames(db: SupabaseClient, userIds: string[]): Promise<Map<string, string>> {
  if (userIds.length === 0) return new Map()
  const { data, error } = await db.from("app_users").select("id, full_name, email").in("id", userIds)
  if (error) throw new Error(`Failed to load consultants: ${error.message}`)
  return new Map(z.array(consultantRowSchema).parse(data ?? []).map((row) => [row.id, row.full_name ?? row.email ?? "Consultant"]))
}

const locationRowSchema = z.object({
  id: uuid,
  name: z.string(),
  address: z.string().nullable(),
  time_zone: z.string(),
  division_id: uuid.nullable(),
  is_archived: z.boolean(),
})
const roomRowSchema = z.object({ id: uuid, location_id: uuid, name: z.string(), is_active: z.boolean(), sort_order: z.number() })
const hoursRowSchema = z.object({ user_id: uuid, location_id: uuid, weekday: z.number(), start_minute: z.number(), end_minute: z.number() })

export async function listStudios(opts: { includeArchived?: boolean } = {}): Promise<StudioDirectory> {
  const context = await requireOrgContext()
  await requirePermission("selections.read", context)
  const db = createServiceSupabaseClient()
  let locationQuery = context.supabase
    .from("design_studio_locations")
    .select("id, name, address, time_zone, division_id, is_archived")
    .eq("org_id", context.orgId)
    .order("name")
    .limit(STUDIO_CAP)
  if (!opts.includeArchived) locationQuery = locationQuery.eq("is_archived", false)
  const [locationsResult, holdersResult] = await Promise.all([
    locationQuery,
    db.rpc("org_permission_holders", { p_org_id: context.orgId, p_permission: "design_studio.manage" }),
  ])
  if (locationsResult.error) throw new Error(`Failed to load studios: ${locationsResult.error.message}`)
  if (holdersResult.error) throw new Error(`Failed to load consultants: ${holdersResult.error.message}`)
  const locations = z.array(locationRowSchema).parse(locationsResult.data ?? [])
  const locationIds = locations.map((row) => row.id)
  const [roomsResult, hoursResult] = locationIds.length
    ? await Promise.all([
        db.from("design_studio_rooms").select("id, location_id, name, is_active, sort_order").eq("org_id", context.orgId).in("location_id", locationIds).order("sort_order").order("name"),
        db.from("design_studio_consultant_hours").select("user_id, location_id, weekday, start_minute, end_minute").eq("org_id", context.orgId).in("location_id", locationIds).order("weekday").order("start_minute"),
      ])
    : [{ data: [], error: null }, { data: [], error: null }]
  if (roomsResult.error) throw new Error(`Failed to load studio rooms: ${roomsResult.error.message}`)
  if (hoursResult.error) throw new Error(`Failed to load consultant hours: ${hoursResult.error.message}`)
  const holderIds = z.array(z.string().uuid()).parse(holdersResult.data ?? [])
  const roomRows = z.array(roomRowSchema).parse(roomsResult.data ?? [])
  const hourRows = z.array(hoursRowSchema).parse(hoursResult.data ?? [])
  const names = await consultantNames(db, Array.from(new Set([...holderIds, ...hourRows.map((row) => row.user_id)])))

  return {
    locations: locations.map((location) => {
      const byUser = new Map<string, HoursWindow[]>()
      for (const row of hourRows.filter((hours) => hours.location_id === location.id)) {
        const windows = byUser.get(row.user_id) ?? []
        windows.push({ weekday: row.weekday, startMinute: row.start_minute, endMinute: row.end_minute })
        byUser.set(row.user_id, windows)
      }
      return {
        id: location.id,
        name: location.name,
        address: location.address,
        timeZone: location.time_zone,
        divisionId: location.division_id,
        isArchived: location.is_archived,
        rooms: roomRows
          .filter((room) => room.location_id === location.id)
          .map((room) => ({ id: room.id, name: room.name, isActive: room.is_active })),
        consultants: Array.from(byUser.entries())
          .map(([userId, windows]) => ({ userId, name: names.get(userId) ?? "Consultant", windows }))
          .sort((a, b) => a.name.localeCompare(b.name)),
      }
    }),
    consultants: holderIds.map((userId) => ({ userId, name: names.get(userId) ?? "Consultant" })).sort((a, b) => a.name.localeCompare(b.name)),
  }
}

/**
 * A studio assigned to a division is that division's. The member's own client
 * sees only the studios their division scope reaches (row security), so a
 * studio it cannot read is one this caller may not change or book into --
 * whatever the service role could read.
 */
async function assertStudioInScope(context: OrgContext, locationId: string) {
  const { data, error } = await context.supabase.from("design_studio_locations").select("id").eq("org_id", context.orgId).eq("id", locationId).maybeSingle()
  if (error) throw new Error(`Failed to load the studio: ${error.message}`)
  if (!data) throw new Error("Studio not found")
}

export async function saveStudioLocation(raw: StudioLocationInput): Promise<{ id: string }> {
  const input = studioLocationSchema.parse(raw)
  const context = await requireOrgContext()
  await requirePermission("design_studio.manage", context)
  const payload = {
    name: input.name,
    address: input.address ?? null,
    time_zone: input.timeZone,
    division_id: input.divisionId ?? null,
    is_archived: input.isArchived,
  }
  const write = input.id
    ? context.supabase.from("design_studio_locations").update(payload).eq("org_id", context.orgId).eq("id", input.id)
    : context.supabase.from("design_studio_locations").insert({ org_id: context.orgId, created_by: context.userId, ...payload })
  const { data: saved, error } = await write.select("id").maybeSingle()
  if (error?.code === "23505") throw new Error(`A studio named ${input.name} already exists`)
  // The member's own client writes this one, so the division wall is row security's.
  if (error?.code === "42501") throw new Error("That studio is outside your divisions")
  if (error) throw new Error(error.message)
  const data = z.object({ id: uuid }).safeParse(saved)
  if (!data.success) throw new Error("Studio not found")
  await Promise.all([
    recordEvent({ orgId: context.orgId, actorId: context.userId, eventType: input.id ? "design_studio_location_updated" : "design_studio_location_created", entityType: "design_studio_location", entityId: data.data.id, payload }),
    recordAudit({ orgId: context.orgId, actorId: context.userId, action: input.id ? "update" : "insert", entityType: "design_studio_location", entityId: data.data.id, after: payload }),
  ])
  return { id: data.data.id }
}

/**
 * The studio's rooms, as listed. A room left off the list is taken out of
 * service rather than deleted: past sessions still name it, and the database
 * refuses to retire a room with sessions ahead.
 */
export async function saveStudioRooms(raw: StudioRoomsInput): Promise<{ rooms: number }> {
  const input = studioRoomsSchema.parse(raw)
  const context = await requireOrgContext()
  await requirePermission("design_studio.manage", context)
  await assertStudioInScope(context, input.locationId)
  const { error } = await createServiceSupabaseClient().rpc("replace_studio_rooms", {
    p_org_id: context.orgId, p_location_id: input.locationId,
    p_rooms: input.rooms.map((room) => ({ id: room.id ?? null, name: room.name, isActive: room.isActive })),
  })
  if (error) throw new Error(error.message)
  await Promise.all([
    recordEvent({ orgId: context.orgId, actorId: context.userId, eventType: "design_studio_rooms_updated", entityType: "design_studio_location", entityId: input.locationId, payload: { rooms: input.rooms } }),
    recordAudit({ orgId: context.orgId, actorId: context.userId, action: "update", entityType: "design_studio_location", entityId: input.locationId, after: { rooms: input.rooms } }),
  ])
  return { rooms: input.rooms.length }
}

/** One consultant's week at one studio, replaced whole. */
export async function saveConsultantHours(raw: ConsultantHoursInput): Promise<{ windows: number }> {
  const input = consultantHoursSchema.parse(raw)
  const context = await requireOrgContext()
  await requirePermission("design_studio.manage", context)
  await assertStudioInScope(context, input.locationId)
  const { error } = await createServiceSupabaseClient().rpc("replace_consultant_hours", {
    p_org_id: context.orgId, p_location_id: input.locationId, p_user_id: input.userId, p_windows: input.windows,
  })
  if (error) {
    throw new Error(error.code === "23P01" ? "Those hours overlap hours the consultant already works at another studio" : error.message)
  }
  await Promise.all([
    recordEvent({ orgId: context.orgId, actorId: context.userId, eventType: "design_studio_hours_updated", entityType: "design_studio_location", entityId: input.locationId, payload: { user_id: input.userId, windows: input.windows } }),
    recordAudit({ orgId: context.orgId, actorId: context.userId, action: "update", entityType: "design_studio_location", entityId: input.locationId, after: { user_id: input.userId, windows: input.windows } }),
  ])
  return { windows: input.windows.length }
}

// ---------------------------------------------------------------------------
// Booking, moving and closing out sessions.
// ---------------------------------------------------------------------------

interface StudioForBooking {
  id: string
  name: string
  timeZone: string
  rooms: Array<{ id: string; isActive: boolean }>
}

async function loadStudio(context: OrgContext, db: SupabaseClient, locationId: string): Promise<StudioForBooking> {
  const orgId = context.orgId
  await assertStudioInScope(context, locationId)
  const [locationResult, roomsResult] = await Promise.all([
    db.from("design_studio_locations").select("id, name, time_zone, is_archived").eq("org_id", orgId).eq("id", locationId).maybeSingle(),
    db.from("design_studio_rooms").select("id, is_active, sort_order").eq("org_id", orgId).eq("location_id", locationId).order("sort_order"),
  ])
  if (locationResult.error) throw new Error(`Failed to load the studio: ${locationResult.error.message}`)
  if (roomsResult.error) throw new Error(`Failed to load the studio's rooms: ${roomsResult.error.message}`)
  const location = locationRowSchema.pick({ id: true, name: true, time_zone: true, is_archived: true }).safeParse(locationResult.data)
  if (!location.success) throw new Error("Studio not found")
  if (location.data.is_archived) throw new Error(`${location.data.name} is closed; choose another studio`)
  return {
    id: location.data.id,
    name: location.data.name,
    timeZone: location.data.time_zone,
    rooms: z.array(roomRowSchema.pick({ id: true, is_active: true })).parse(roomsResult.data ?? []).map((room) => ({ id: room.id, isActive: room.is_active })),
  }
}

const bookingRowSchema = z.object({ id: uuid, room_id: uuid.nullable(), scheduled_at: z.string(), ends_at: z.string() })

/** Sessions booked over a window, read with the service role: a room taken by another division's buyer is still taken. */
async function bookingsOver(
  db: SupabaseClient,
  orgId: string,
  filter: { locationId?: string; consultantUserId?: string },
  window: Interval,
  excludeAppointmentId?: string,
): Promise<Array<Interval & { roomId: string | null }>> {
  let query = db
    .from("design_studio_appointments")
    .select("id, room_id, scheduled_at, ends_at")
    .eq("org_id", orgId)
    .eq("status", "scheduled")
    .lt("scheduled_at", window.end)
    .gt("ends_at", window.start)
    .limit(DAY_BOOKING_CAP)
  if (filter.locationId) query = query.eq("location_id", filter.locationId)
  if (filter.consultantUserId) query = query.eq("coordinator_user_id", filter.consultantUserId)
  const { data, error } = await query
  if (error) throw new Error(`Failed to read the studio calendar: ${error.message}`)
  return z.array(bookingRowSchema).parse(data ?? [])
    .filter((row) => row.id !== excludeAppointmentId)
    .map((row) => ({ roomId: row.room_id, start: row.scheduled_at, end: row.ends_at }))
}

interface HomeForBooking {
  communityId: string | null
  buyerContactId: string | null
  openGroups: Array<{ groupId: string; cutoffDate: string | null }>
}

const openGroupRowSchema = z.object({ group_id: uuid, cutoff_date: z.string().nullable() })

async function loadHome(db: SupabaseClient, orgId: string, projectId: string): Promise<HomeForBooking> {
  const [lotResult, buyerResult, groupsResult] = await Promise.all([
    db.from("lots").select("community_id").eq("org_id", orgId).eq("project_id", projectId).limit(1).maybeSingle(),
    db.rpc("selection_home_buyer", { p_org_id: orgId, p_project_id: projectId }),
    db.from("project_selection_groups").select("group_id, cutoff_date").eq("org_id", orgId).eq("project_id", projectId).eq("status", "open"),
  ])
  if (lotResult.error) throw new Error(`Failed to load the home: ${lotResult.error.message}`)
  if (buyerResult.error) throw new Error(`Failed to load the home's buyer: ${buyerResult.error.message}`)
  if (groupsResult.error) throw new Error(`Failed to load the home's selection groups: ${groupsResult.error.message}`)
  const lot = z.object({ community_id: uuid.nullable() }).nullable().parse(lotResult.data)
  return {
    communityId: lot?.community_id ?? null,
    buyerContactId: typeof buyerResult.data === "string" ? buyerResult.data : null,
    openGroups: z.array(openGroupRowSchema).parse(groupsResult.data ?? []).map((row) => ({ groupId: row.group_id, cutoffDate: row.cutoff_date })),
  }
}

async function authorizeHome(context: OrgContext, projectId: string) {
  await requireAuthorization({
    permission: "design_studio.manage", orgId: context.orgId, userId: context.userId, projectId,
    supabase: context.supabase, resourceType: "project", resourceId: projectId, logDecision: true,
  })
}

type WriteError = { code?: string; message: string; details?: string | null }

function isConstraint(error: WriteError, name: string) {
  return error.code === "23P01" && error.message.includes(name)
}

async function describeWriteError(db: SupabaseClient, error: WriteError, consultantUserId: string, studio: StudioForBooking): Promise<Error> {
  if (isConstraint(error, "design_studio_appointments_consultant_free")) {
    const names = await consultantNames(db, [consultantUserId])
    return new Error(`${names.get(consultantUserId) ?? "That consultant"} is already in a session then`)
  }
  if (isConstraint(error, "design_studio_appointments_home_free")) return new Error("This home already has a session then")
  if (isConstraint(error, "design_studio_appointments_room_free")) return studioFull(studio)
  // The slot trigger's refusals are already written for the coordinator.
  if (error.code === "23514") return new Error(error.message)
  return new Error(`Failed to save the session: ${error.message}`)
}

function studioFull(studio: StudioForBooking) {
  const rooms = studio.rooms.filter((room) => room.isActive).length
  return new Error(rooms === 1 ? `The room at ${studio.name} is booked then` : `All ${rooms} rooms at ${studio.name} are booked then`)
}

/**
 * Writes the session into the first free room. Two coordinators can race for
 * the last room; the loser's write is refused by the room constraint, so it
 * re-reads the calendar and tries the next free room until the studio is full.
 */
async function writeInFreeRoom(
  db: SupabaseClient,
  orgId: string,
  studio: StudioForBooking,
  consultantUserId: string,
  window: Interval,
  excludeAppointmentId: string | undefined,
  write: (roomId: string) => PromiseLike<{ data: unknown; error: WriteError | null }>,
): Promise<AppointmentRow> {
  for (let attempt = 0; attempt <= studio.rooms.length; attempt += 1) {
    const bookings = await bookingsOver(db, orgId, { locationId: studio.id }, window, excludeAppointmentId)
    const roomId = pickRoom(studio.rooms, bookings, window)
    if (!roomId) throw studioFull(studio)
    const { data, error } = await write(roomId)
    if (!error && data) return appointmentRowSchema.parse(data)
    if (error && isConstraint(error, "design_studio_appointments_room_free")) continue
    throw await describeWriteError(db, error ?? { message: "missing row" }, consultantUserId, studio)
  }
  throw studioFull(studio)
}

export async function bookAppointment(raw: BookAppointmentInput): Promise<AppointmentDto> {
  const input = bookAppointmentSchema.parse(raw)
  const context = await requireOrgContext()
  await requirePermission("design_studio.manage", context)
  await authorizeHome(context, input.projectId)
  const db = createServiceSupabaseClient()
  const [home, studio] = await Promise.all([loadHome(db, context.orgId, input.projectId), loadStudio(context, db, input.locationId)])
  const window = sessionInterval(input.scheduledAt, input.durationMinutes)
  const groupIds = input.groupIds ?? home.openGroups.map((group) => group.groupId)
  const row = await writeInFreeRoom(db, context.orgId, studio, input.consultantUserId, window, undefined, (roomId) =>
    db.from("design_studio_appointments").insert({
      org_id: context.orgId,
      project_id: input.projectId,
      community_id: home.communityId,
      contact_id: home.buyerContactId,
      coordinator_user_id: input.consultantUserId,
      location_id: studio.id,
      room_id: roomId,
      scheduled_at: window.start,
      duration_minutes: input.durationMinutes,
      status: "scheduled",
      group_ids: groupIds,
      notes: input.notes ?? null,
      booked_by: context.userId,
    }).select(APPOINTMENT_SELECT).single(),
  )
  const appointment = toAppointmentDto(row)
  const facts = { project_id: input.projectId, location_id: studio.id, room_id: appointment.roomId, consultant_user_id: input.consultantUserId, scheduled_at: appointment.scheduledAt, ends_at: appointment.endsAt, group_ids: groupIds }
  await Promise.all([
    recordEvent({ orgId: context.orgId, actorId: context.userId, eventType: "design_studio_appointment_booked", entityType: "design_studio_appointment", entityId: appointment.id, payload: facts }),
    recordAudit({ orgId: context.orgId, actorId: context.userId, action: "insert", entityType: "design_studio_appointment", entityId: appointment.id, after: facts }),
  ])
  return appointment
}

async function loadAppointmentForChange(context: OrgContext, db: SupabaseClient, appointmentId: string) {
  const { data, error } = await db.from("design_studio_appointments").select(APPOINTMENT_COLUMNS).eq("org_id", context.orgId).eq("id", appointmentId).maybeSingle()
  if (error) throw new Error(`Failed to load the session: ${error.message}`)
  if (!data) throw new Error("Session not found")
  const row = appointmentRowSchema.parse(data)
  // A change to a session is a change on its home: authorized there.
  await authorizeHome(context, row.project_id)
  return row
}

/** Moves a session: new time, studio or consultant. The covered cutoffs never move with it. */
export async function rescheduleAppointment(raw: RescheduleAppointmentInput): Promise<AppointmentDto> {
  const input = rescheduleAppointmentSchema.parse(raw)
  const context = await requireOrgContext()
  await requirePermission("design_studio.manage", context)
  const db = createServiceSupabaseClient()
  const before = await loadAppointmentForChange(context, db, input.appointmentId)
  if (before.status !== "scheduled") throw new Error(`A ${before.status.replace("_", " ")} session cannot be moved; book a new one`)
  const studio = await loadStudio(context, db, input.locationId)
  const window = sessionInterval(input.scheduledAt, input.durationMinutes)
  const row = await writeInFreeRoom(db, context.orgId, studio, input.consultantUserId, window, before.id, (roomId) =>
    db.from("design_studio_appointments").update({
      coordinator_user_id: input.consultantUserId,
      location_id: studio.id,
      room_id: roomId,
      scheduled_at: window.start,
      duration_minutes: input.durationMinutes,
    }).eq("org_id", context.orgId).eq("id", before.id).eq("status", "scheduled").select(APPOINTMENT_SELECT).single(),
  )
  const appointment = toAppointmentDto(row)
  const previous = { scheduled_at: before.scheduled_at, ends_at: before.ends_at, location_id: before.location_id, room_id: before.room_id, consultant_user_id: before.coordinator_user_id }
  const next = { scheduled_at: appointment.scheduledAt, ends_at: appointment.endsAt, location_id: appointment.locationId, room_id: appointment.roomId, consultant_user_id: appointment.consultantUserId }
  await Promise.all([
    recordEvent({ orgId: context.orgId, actorId: context.userId, eventType: "design_studio_appointment_rescheduled", entityType: "design_studio_appointment", entityId: appointment.id, payload: { project_id: appointment.projectId, revision: appointment.revision, previous, next } }),
    recordAudit({ orgId: context.orgId, actorId: context.userId, action: "update", entityType: "design_studio_appointment", entityId: appointment.id, before: previous, after: next }),
  ])
  return appointment
}

export async function cancelAppointment(raw: CancelAppointmentInput): Promise<AppointmentDto> {
  const input = cancelAppointmentSchema.parse(raw)
  const context = await requireOrgContext()
  await requirePermission("design_studio.manage", context)
  const db = createServiceSupabaseClient()
  const before = await loadAppointmentForChange(context, db, input.appointmentId)
  if (before.status !== "scheduled") throw new Error(`This session is already ${before.status.replace("_", " ")}`)
  const { data, error } = await db
    .from("design_studio_appointments")
    .update({ status: "canceled", cancel_reason: input.reason })
    .eq("org_id", context.orgId).eq("id", before.id).eq("status", "scheduled")
    .select(APPOINTMENT_SELECT).single()
  if (error || !data) throw new Error(`Failed to cancel the session: ${error?.message ?? "it changed while you were working"}`)
  const appointment = toAppointmentDto(appointmentRowSchema.parse(data))
  await Promise.all([
    recordEvent({ orgId: context.orgId, actorId: context.userId, eventType: "design_studio_appointment_canceled", entityType: "design_studio_appointment", entityId: appointment.id, payload: { project_id: appointment.projectId, scheduled_at: before.scheduled_at, reason: input.reason } }),
    recordAudit({ orgId: context.orgId, actorId: context.userId, action: "update", entityType: "design_studio_appointment", entityId: appointment.id, before: { status: before.status }, after: { status: "canceled", cancel_reason: input.reason } }),
  ])
  return appointment
}

/** Closes out a session that has started: it happened, or the buyer did not come. */
export async function recordAppointmentOutcome(raw: AppointmentOutcomeInput): Promise<AppointmentDto> {
  const input = appointmentOutcomeSchema.parse(raw)
  const context = await requireOrgContext()
  await requirePermission("design_studio.manage", context)
  const db = createServiceSupabaseClient()
  const before = await loadAppointmentForChange(context, db, input.appointmentId)
  if (before.status !== "scheduled") throw new Error(`This session is already ${before.status.replace("_", " ")}`)
  if (Date.parse(before.scheduled_at) > Date.now()) throw new Error("A session is closed out once it has started")
  const { data, error } = await db
    .from("design_studio_appointments")
    .update({ status: input.outcome })
    .eq("org_id", context.orgId).eq("id", before.id).eq("status", "scheduled")
    .select(APPOINTMENT_SELECT).single()
  if (error || !data) throw new Error(`Failed to close out the session: ${error?.message ?? "it changed while you were working"}`)
  const appointment = toAppointmentDto(appointmentRowSchema.parse(data))
  await Promise.all([
    recordEvent({ orgId: context.orgId, actorId: context.userId, eventType: `design_studio_appointment_${input.outcome}`, entityType: "design_studio_appointment", entityId: appointment.id, payload: { project_id: appointment.projectId } }),
    recordAudit({ orgId: context.orgId, actorId: context.userId, action: "update", entityType: "design_studio_appointment", entityId: appointment.id, before: { status: before.status }, after: { status: input.outcome } }),
  ])
  return appointment
}

/**
 * The starts the booking dialog offers for one consultant at one studio on one
 * day: inside their hours, with them and a room free, ahead of now, and on or
 * before every covered cutoff.
 */
export async function listOpenSlots(raw: OpenSlotsInput): Promise<{ timeZone: string; slots: OpenSlot[] }> {
  const input = openSlotsSchema.parse(raw)
  const context = await requireOrgContext()
  await requirePermission("design_studio.manage", context)
  await authorizeHome(context, input.projectId)
  const db = createServiceSupabaseClient()
  const studio = await loadStudio(context, db, input.locationId)
  const day: Interval = {
    start: zonedTimeToUtc(input.date, 0, studio.timeZone).toISOString(),
    end: zonedTimeToUtc(input.date, 1440, studio.timeZone).toISOString(),
  }
  const [hoursResult, consultantBusy, roomBookings, home, moving] = await Promise.all([
    db.from("design_studio_consultant_hours").select("weekday, start_minute, end_minute").eq("org_id", context.orgId).eq("location_id", studio.id).eq("user_id", input.consultantUserId),
    bookingsOver(db, context.orgId, { consultantUserId: input.consultantUserId }, day, input.appointmentId),
    bookingsOver(db, context.orgId, { locationId: studio.id }, day, input.appointmentId),
    loadHome(db, context.orgId, input.projectId),
    input.appointmentId
      ? db.from("design_studio_appointments").select("group_ids").eq("org_id", context.orgId).eq("id", input.appointmentId).maybeSingle()
      : Promise.resolve({ data: null, error: null }),
  ])
  if (hoursResult.error) throw new Error(`Failed to load the consultant's hours: ${hoursResult.error.message}`)
  if (moving.error) throw new Error(`Failed to load the session: ${moving.error.message}`)
  const movingGroups = z.object({ group_ids: z.array(uuid).nullable() }).nullable().parse(moving.data)
  const covered = new Set<string>(movingGroups?.group_ids ?? home.openGroups.map((group) => group.groupId))
  return {
    timeZone: studio.timeZone,
    slots: openSlots({
      date: input.date,
      timeZone: studio.timeZone,
      durationMinutes: input.durationMinutes,
      windows: z.array(hoursRowSchema.omit({ user_id: true, location_id: true })).parse(hoursResult.data ?? []).map((row) => ({ weekday: row.weekday, startMinute: row.start_minute, endMinute: row.end_minute })),
      consultantBusy,
      rooms: studio.rooms,
      roomBookings,
      cutoffs: home.openGroups.filter((group) => covered.has(group.groupId)).map((group) => group.cutoffDate),
      now: new Date(),
    }),
  }
}
