import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
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

function formatRelative(timestamp?: string | null) {
  if (!timestamp) return "No activity yet"
  const diffMs = Date.now() - new Date(timestamp).getTime()
  const diffMinutes = Math.max(0, Math.round(diffMs / 60000))
  if (diffMinutes < 1) return "Just now"
  if (diffMinutes < 60) return `${diffMinutes}m ago`
  const diffHours = Math.round(diffMinutes / 60)
  if (diffHours < 24) return `${diffHours}h ago`
  const diffDays = Math.round(diffHours / 24)
  return `${diffDays}d ago`
}

function demoOrgId() {
  return process.env.DEMO_USAGE_PRIMARY_ORG_ID ?? DEFAULT_DEMO_ORG_ID
}

function summarizeTopPages(events: DemoUsageEvent[]) {
  const counts = new Map<string, { label: string; path: string; count: number }>()
  for (const event of events) {
    const path = event.payload?.path ?? "unknown"
    const label = event.payload?.label ?? path
    const current = counts.get(path) ?? { label, path, count: 0 }
    current.count += 1
    counts.set(path, current)
  }
  return [...counts.values()].sort((a, b) => b.count - a.count).slice(0, 5)
}

export async function DemoUsageCard() {
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
  const demoUserLabel = (demoAppUser as any)?.full_name ?? (demoAppUser as any)?.email ?? "demo@arcnaples.com"

  return (
    <Card>
      <CardHeader>
        <div className="flex items-start justify-between gap-3">
          <div>
            <CardTitle>Demo usage</CardTitle>
            <CardDescription>Recent page activity for the Patagonia Demo org.</CardDescription>
          </div>
          <Badge variant={lastEvent ? "default" : "outline"}>{lastEvent ? "Tracking" : "Waiting"}</Badge>
        </div>
      </CardHeader>
      <CardContent className="space-y-5">
        <div className="grid gap-3 sm:grid-cols-3">
          <div>
            <p className="text-xs font-medium uppercase text-muted-foreground">Last activity</p>
            <p className="mt-1 text-lg font-semibold">{formatRelative(lastEvent?.created_at)}</p>
          </div>
          <div>
            <p className="text-xs font-medium uppercase text-muted-foreground">Logins</p>
            <p className="mt-1 text-lg font-semibold">{logins.length}</p>
          </div>
          <div>
            <p className="text-xs font-medium uppercase text-muted-foreground">Page views</p>
            <p className="mt-1 text-lg font-semibold">{pageViews.length}</p>
          </div>
        </div>

        <div>
          <p className="text-xs font-medium uppercase text-muted-foreground">Demo user</p>
          <p className="mt-1 text-sm font-medium">{demoUserLabel}</p>
          <p className="text-xs text-muted-foreground">Last login {formatRelative(lastLogin?.created_at)}</p>
          <p className="text-xs text-muted-foreground">Membership last active {formatRelative((demoMembership as any)?.last_active_at)}</p>
          <p className="text-xs text-muted-foreground">{uniquePages} unique pages explored</p>
        </div>

        <div className="space-y-2">
          <p className="text-xs font-medium uppercase text-muted-foreground">Top pages</p>
          {topPages.length ? (
            topPages.map((page) => (
              <div key={page.path} className="flex items-center justify-between gap-3 rounded-md border px-3 py-2 text-sm">
                <div className="min-w-0">
                  <p className="truncate font-medium">{page.label}</p>
                  <p className="truncate text-xs text-muted-foreground">{page.path}</p>
                </div>
                <Badge variant="secondary">{page.count}</Badge>
              </div>
            ))
          ) : (
            <p className="rounded-md border px-3 py-2 text-sm text-muted-foreground">No demo page views tracked yet.</p>
          )}
        </div>
      </CardContent>
    </Card>
  )
}
