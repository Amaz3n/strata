import type { SupabaseClient } from "@supabase/supabase-js"

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

/** Which tally a lead lands in, from the source the consultant or form recorded. */
export function trafficBucketForSource(source: string | null | undefined): "walkIns" | "appointments" | "webInquiries" {
  const normalized = (source ?? "").toLowerCase()
  if (/web|online|internet|form|portal|site|zillow|realtor/.test(normalized)) return "webInquiries"
  if (/appointment|scheduled|tour|booking/.test(normalized)) return "appointments"
  return "walkIns"
}

const TRAFFIC_COLUMN = { walkIns: "walk_ins", appointments: "appointments", webInquiries: "web_inquiries" } as const

/**
 * Counts a new lead against its community's daily traffic.
 *
 * Conversion rates are only as honest as their denominator, and a tally that
 * depends on somebody remembering to open the traffic panel is not a
 * denominator. Called from lead creation, which has already authorized the
 * write. One atomic increment (`increment_community_traffic`), so a burst of
 * leads counts every one; row-level security still decides who may count.
 *
 * Deliberately best-effort: a footfall tally must never be the reason a lead
 * fails to save.
 */
export async function recordLeadTraffic(
  context: { supabase: SupabaseClient; orgId: string; userId: string },
  input: { communityId: string; source?: string | null; occurredOn?: string },
) {
  const loggedDate = input.occurredOn ?? isoDay(new Date())
  const { error } = await context.supabase.rpc("increment_community_traffic", {
    p_org_id: context.orgId,
    p_community_id: input.communityId,
    p_day: loggedDate,
    p_bucket: TRAFFIC_COLUMN[trafficBucketForSource(input.source)],
  })
  if (error) console.error("Failed to record community traffic for a new lead", { communityId: input.communityId, loggedDate, error })
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
