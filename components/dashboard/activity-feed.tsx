import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { CheckCircle, Camera, ClipboardList, Receipt, CalendarDays, Clock } from "@/components/icons"
import type { LucideIcon } from "@/components/icons"
import { getOrgActivity } from "@/lib/services/events"

const activityIcons: Record<string, LucideIcon> = {
  task_completed: CheckCircle,
  photo_uploaded: Camera,
  daily_log: ClipboardList,
  change_order: Receipt,
  schedule_update: CalendarDays,
}

const activityColors: Record<string, string> = {
  task_completed: "text-success",
  photo_uploaded: "text-primary",
  daily_log: "text-chart-2",
  change_order: "text-warning",
  schedule_update: "text-chart-4",
}

export async function ActivityFeed() {
  const activity = await loadActivity()

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-lg font-semibold">Recent Activity</CardTitle>
      </CardHeader>
      <CardContent>
        {activity.length === 0 ? (
          <EmptyState />
        ) : (
          <div className="space-y-4">
            {activity.map((item) => {
              const Icon = activityIcons[item.type] || CheckCircle
              const colorClass = activityColors[item.type] || "text-muted-foreground"

              return (
                <div key={item.id} className="flex gap-3">
                  <div className={`mt-0.5 shrink-0 ${colorClass}`}>
                    <Icon className="h-5 w-5" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="text-sm">{item.title}</p>
                    <p className="text-xs text-muted-foreground mt-0.5">
                      {item.meta ?? "Activity"} • {formatTimestamp(item.createdAt)}
                    </p>
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </CardContent>
    </Card>
  )
}

async function loadActivity() {
  try {
    return await getOrgActivity(12)
  } catch (error) {
    console.error("Unable to load activity feed", error)
    return []
  }
}

function formatTimestamp(date: string) {
  const createdAt = new Date(date)
  const now = new Date()
  const diffMs = now.getTime() - createdAt.getTime()
  const diffMinutes = Math.floor(diffMs / 60000)
  if (diffMinutes < 60) return `${diffMinutes || 1}m ago`
  const diffHours = Math.floor(diffMinutes / 60)
  if (diffHours < 24) return `${diffHours}h ago`
  const diffDays = Math.floor(diffHours / 24)
  if (diffDays < 7) return `${diffDays}d ago`
  return createdAt.toLocaleDateString()
}

function EmptyState() {
  return (
    <div className="flex items-center gap-3 text-sm text-muted-foreground">
      <Clock className="h-4 w-4" />
      <p>No activity yet. Tasks, logs, and uploads will show up here automatically.</p>
    </div>
  )
}
