import Link from "next/link"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { ArrowUpRight } from "@/components/icons"
import type { Project, Task, TaskPriority } from "@/lib/types"

const priorityColors: Record<TaskPriority, string> = {
  low: "bg-muted text-muted-foreground",
  normal: "bg-primary/20 text-primary",
  high: "bg-warning/20 text-warning",
  urgent: "bg-destructive/20 text-destructive",
}

interface TasksPreviewProps {
  tasks: Task[]
  projects: Project[]
}

export function TasksPreview({ tasks, projects }: TasksPreviewProps) {
  const pendingTasks = tasks.filter((t) => t.status !== "done").slice(0, 5)

  const getProjectName = (projectId: string) => {
    return projects.find((p) => p.id === projectId)?.name || "Unknown Project"
  }

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between pb-2">
        <CardTitle className="text-lg font-semibold">Upcoming Tasks</CardTitle>
        <Button variant="ghost" size="sm" asChild>
          <Link href="/tasks">
            View All
            <ArrowUpRight className="ml-1 h-4 w-4" />
          </Link>
        </Button>
      </CardHeader>
      <CardContent>
        {pendingTasks.length === 0 ? (
          <p className="text-sm text-muted-foreground">No upcoming tasks. Everything looks good.</p>
        ) : (
          <div className="space-y-3">
            {pendingTasks.map((task) => (
              <div key={task.id} className="flex items-start gap-3 rounded-lg border border-border p-3">
                <Checkbox id={task.id} className="mt-0.5" />
                <div className="min-w-0 flex-1">
                  <label htmlFor={task.id} className="text-sm font-medium cursor-pointer">
                    {task.title}
                  </label>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    {getProjectName(task.project_id)}
                    {task.due_date && ` • Due ${new Date(task.due_date).toLocaleDateString()}`}
                  </p>
                </div>
                <Badge variant="secondary" className={priorityColors[task.priority]}>
                  {task.priority}
                </Badge>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  )
}
