import { recordAudit } from "@/lib/services/audit"
import { requireOrgContext } from "@/lib/services/context"
import { recordEvent } from "@/lib/services/events"
import { requirePermission } from "@/lib/services/permissions"
import { communityTrafficInputSchema, type CommunityTrafficInput } from "@/lib/validation/communities"

export interface CommunityTrafficDayDTO {
  id: string
  communityId: string
  loggedDate: string
  walkIns: number
  appointments: number
  webInquiries: number
  notes: string | null
}

function isoDay(date: Date) {
  return date.toISOString().slice(0, 10)
}

export async function listCommunityTraffic(
  communityId: string,
  { days = 56 }: { days?: number } = {},
  orgId?: string,
): Promise<CommunityTrafficDayDTO[]> {
  const context = await requireOrgContext(orgId)
  await requirePermission("community.read", context)
  const since = new Date()
  since.setUTCDate(since.getUTCDate() - days)
  const { data, error } = await context.supabase
    .from("community_traffic")
    .select("id, community_id, logged_date, walk_ins, appointments, web_inquiries, notes")
    .eq("org_id", context.orgId)
    .eq("community_id", communityId)
    .gte("logged_date", isoDay(since))
    .order("logged_date", { ascending: false })
    .limit(400)
  if (error) throw new Error(`Failed to load traffic: ${error.message}`)
  return (data ?? []).map((row) => ({
    id: row.id as string,
    communityId: row.community_id as string,
    loggedDate: row.logged_date as string,
    walkIns: Number(row.walk_ins ?? 0),
    appointments: Number(row.appointments ?? 0),
    webInquiries: Number(row.web_inquiries ?? 0),
    notes: (row.notes as string | null) ?? null,
  }))
}

/**
 * Adds to a day's counters instead of replacing them, so logging a walk-in from
 * the Sales desk and the consultant's own end-of-day entry on the community
 * workbench compose rather than clobber each other.
 *
 * Read-then-upsert: two people registering the same walk-in minute could lose a
 * count, which is the right trade for a footfall tally that nothing financial
 * depends on.
 */
export async function incrementCommunityTraffic(
  {
    communityId,
    loggedDate,
    walkIns = 0,
    appointments = 0,
    webInquiries = 0,
  }: {
    communityId: string
    loggedDate: string
    walkIns?: number
    appointments?: number
    webInquiries?: number
  },
  orgId?: string,
): Promise<CommunityTrafficDayDTO> {
  const context = await requireOrgContext(orgId)
  await requirePermission("sales.manage", context)

  const { data: existing, error: existingError } = await context.supabase
    .from("community_traffic")
    .select("walk_ins, appointments, web_inquiries, notes")
    .eq("org_id", context.orgId)
    .eq("community_id", communityId)
    .eq("logged_date", loggedDate)
    .maybeSingle()
  if (existingError) throw new Error(`Failed to read traffic: ${existingError.message}`)

  return logCommunityTraffic(
    {
      communityId,
      loggedDate,
      walkIns: Number(existing?.walk_ins ?? 0) + walkIns,
      appointments: Number(existing?.appointments ?? 0) + appointments,
      webInquiries: Number(existing?.web_inquiries ?? 0) + webInquiries,
      notes: (existing?.notes as string | null) ?? null,
    },
    orgId,
  )
}

export async function logCommunityTraffic(
  input: CommunityTrafficInput,
  orgId?: string,
): Promise<CommunityTrafficDayDTO> {
  const parsed = communityTrafficInputSchema.parse(input)
  const context = await requireOrgContext(orgId)
  await requirePermission("sales.manage", context)

  const { data: community, error: communityError } = await context.supabase
    .from("communities")
    .select("id")
    .eq("org_id", context.orgId)
    .eq("id", parsed.communityId)
    .is("archived_at", null)
    .maybeSingle()
  if (communityError || !community) throw new Error("Community not found")

  const { data, error } = await context.supabase
    .from("community_traffic")
    .upsert(
      {
        org_id: context.orgId,
        community_id: parsed.communityId,
        logged_date: parsed.loggedDate,
        walk_ins: parsed.walkIns,
        appointments: parsed.appointments,
        web_inquiries: parsed.webInquiries,
        notes: parsed.notes || null,
        recorded_by: context.userId,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "community_id,logged_date" },
    )
    .select("id, community_id, logged_date, walk_ins, appointments, web_inquiries, notes")
    .single()
  if (error) throw new Error(`Failed to log traffic: ${error.message}`)

  await Promise.all([
    recordEvent({
      orgId: context.orgId,
      actorId: context.userId,
      eventType: "community_traffic.logged",
      entityType: "community_traffic",
      entityId: data.id,
      payload: { community_id: parsed.communityId, logged_date: parsed.loggedDate },
    }),
    recordAudit({
      orgId: context.orgId,
      actorId: context.userId,
      action: "update",
      entityType: "community_traffic",
      entityId: data.id,
      after: data,
    }),
  ])

  return {
    id: data.id as string,
    communityId: data.community_id as string,
    loggedDate: data.logged_date as string,
    walkIns: Number(data.walk_ins ?? 0),
    appointments: Number(data.appointments ?? 0),
    webInquiries: Number(data.web_inquiries ?? 0),
    notes: (data.notes as string | null) ?? null,
  }
}
