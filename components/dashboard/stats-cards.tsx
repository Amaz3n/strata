import { Card, CardContent } from "@/components/ui/card"
import { FolderOpen, CheckSquare, Clock, Camera } from "@/components/icons"
import type { DashboardStats } from "@/lib/types"

interface StatsCardsProps {
  stats: DashboardStats
}

export function StatsCards({ stats }: StatsCardsProps) {
  const items = [
    {
      label: "Active Projects",
      value: stats.activeProjects,
      icon: FolderOpen,
      trend: "Up to date",
    },
    {
      label: "Tasks This Week",
      value: stats.tasksThisWeek,
      icon: CheckSquare,
      trend: "Next 7 days",
    },
    {
      label: "Pending Approvals",
      value: stats.pendingApprovals,
      icon: Clock,
      trend: "Awaiting review",
    },
    {
      label: "Recent Photos",
      value: stats.recentPhotos,
      icon: Camera,
      trend: "Last 7 days",
    },
  ]

  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
      {items.map((stat) => (
        <Card key={stat.label} className="bg-card">
          <CardContent className="p-6">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm font-medium text-muted-foreground">{stat.label}</p>
                <p className="text-3xl font-bold mt-1">{stat.value}</p>
                <p className="text-xs text-muted-foreground mt-1">{stat.trend}</p>
              </div>
              <div className="flex h-12 w-12 items-center justify-center rounded-lg bg-primary/10">
                <stat.icon className="h-6 w-6 text-primary" />
              </div>
            </div>
          </CardContent>
        </Card>
      ))}
    </div>
  )
}
