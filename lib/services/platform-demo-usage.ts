import { createServiceSupabaseClient } from "@/lib/supabase/server"

const DEFAULT_DEMO_ORG_ID = "7982e17e-501e-4640-b410-f6d2385391f8"

type DemoUsageEvent = {
  id: string
  event_type: string
  created_at: string
  payload: {
    actor_email?: string | null
    label?: string | null
    path?: string | null
  }
}

export interface DemoUsageTopPage {
  label: string
  path: string
  count: number
}

export interface DemoUsageSummary {
  tracking: boolean
  lastActivityAt: string | null
  lastLoginAt: string | null
  membershipLastActiveAt: string | null
  logins: number
  pageViews: number
  uniquePages: number
  demoUserLabel: string
  topPages: DemoUsageTopPage[]
}

function demoOrgId() {
  return process.env.DEMO_USAGE_PRIMARY_ORG_ID ?? DEFAULT_DEMO_ORG_ID
}

function summarizeTopPages(events: DemoUsageEvent[]): DemoUsageTopPage[] {
  const counts = new Map<string, DemoUsageTopPage>()
  for (const event of events) {
    const path = event.payload?.path ?? "unknown"
    const label = event.payload?.label ?? path
    const current = counts.get(path) ?? { label, path, count: 0 }
    current.count += 1
    counts.set(path, current)
  }
  return [...counts.values()].sort((a, b) => b.count - a.count).slice(0, 5)
}

export async function getDemoUsageSummary(): Promise<DemoUsageSummary> {
  const supabase = createServiceSupabaseClient()
  const orgId = demoOrgId()

  const [{ data: events }, { data: demoAppUser }] = await Promise.all([
    supabase
      .from("events")
      .select("id, event_type, created_at, payload")
      .eq("org_id", orgId)
      .in("event_type", ["demo_login", "demo_page_view"])
      .order("created_at", { ascending: false })
      .limit(100),
    supabase
      .from("app_users")
      .select("id, email, full_name")
      .eq("email", "demo@arcnaples.com")
      .maybeSingle(),
  ])

  const usageEvents = (events ?? []) as DemoUsageEvent[]
  const pageViews = usageEvents.filter((event) => event.event_type === "demo_page_view")
  const logins = usageEvents.filter((event) => event.event_type === "demo_login")
  const lastEvent = usageEvents[0]
  const lastLogin = logins[0]
  const topPages = summarizeTopPages(pageViews)
  const uniquePages = new Set(pageViews.map((event) => event.payload?.path).filter(Boolean)).size

  const demoUserId = (demoAppUser as any)?.id as string | undefined
  const { data: demoMembership } = demoUserId
    ? await supabase
        .from("memberships")
        .select("last_active_at")
        .eq("org_id", orgId)
        .eq("user_id", demoUserId)
        .maybeSingle()
    : { data: null }

  return {
    tracking: Boolean(lastEvent),
    lastActivityAt: lastEvent?.created_at ?? null,
    lastLoginAt: lastLogin?.created_at ?? null,
    membershipLastActiveAt: (demoMembership as any)?.last_active_at ?? null,
    logins: logins.length,
    pageViews: pageViews.length,
    uniquePages,
    demoUserLabel: (demoAppUser as any)?.full_name ?? (demoAppUser as any)?.email ?? "demo@arcnaples.com",
    topPages,
  }
}
