import { format, parseISO } from "date-fns"
import { Card, CardContent } from "@/components/ui/card"
import type { Project } from "@/lib/types"

interface ProjectOverviewTimelineProps {
  project: Project
  daysElapsed: number
  daysRemaining: number
  totalDays: number
  scheduleProgress: number
}

export function ProjectOverviewTimeline({
  project,
  daysElapsed,
  daysRemaining,
  totalDays,
  scheduleProgress,
}: ProjectOverviewTimelineProps) {
  const progressPercentage = totalDays > 0 ? Math.min(100, Math.round((daysElapsed / totalDays) * 100)) : 0

  return (
    <Card>
      <CardContent className="py-4">
        <div className="flex items-center justify-between mb-2">
          <span className="text-sm font-medium">Project Timeline</span>
          <span className="text-sm text-muted-foreground">
            {progressPercentage}% elapsed &bull; {scheduleProgress}% complete
          </span>
        </div>
        <div className="relative h-3 bg-muted overflow-hidden rounded-full">
          {/* Time elapsed bar */}
          <div
            className="absolute inset-y-0 left-0 bg-muted-foreground/30 rounded-full"
            style={{ width: `${progressPercentage}%` }}
          />
          {/* Work completed bar */}
          <div
            className="absolute inset-y-0 left-0 bg-primary rounded-full"
            style={{ width: `${scheduleProgress}%` }}
          />
          {/* Today marker */}
          <div
            className="absolute top-0 bottom-0 w-0.5 bg-foreground"
            style={{ left: `${progressPercentage}%` }}
          />
        </div>
        <div className="flex justify-between mt-2 text-xs text-muted-foreground">
          <span>
            {project.start_date ? format(parseISO(project.start_date), "MMM d, yyyy") : "Start"}
          </span>
          {daysRemaining > 0 && (
            <span className="font-medium text-foreground">
              {daysRemaining} days remaining
            </span>
          )}
          <span>
            {project.end_date ? format(parseISO(project.end_date), "MMM d, yyyy") : "End"}
          </span>
        </div>
      </CardContent>
    </Card>
  )
}
