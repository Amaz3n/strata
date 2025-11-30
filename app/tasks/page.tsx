import { AppShell } from "@/components/layout/app-shell"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Checkbox } from "@/components/ui/checkbox"
import { Input } from "@/components/ui/input"
import { Avatar, AvatarFallback } from "@/components/ui/avatar"
import { Plus, Search } from "@/components/icons"
import type { Task, TaskPriority, TaskStatus, Project } from "@/lib/types"
import { listTasksAction } from "./actions"
import { listProjectsAction } from "../projects/actions"
import { getCurrentUserAction } from "../actions/user"

const statusLabels: Record<TaskStatus, string> = {
  todo: "To Do",
  in_progress: "In Progress",
  blocked: "Blocked",
  done: "Done",
}

const priorityColors: Record<TaskPriority, string> = {
  low: "bg-muted text-muted-foreground",
  normal: "bg-primary/20 text-primary",
  high: "bg-warning/20 text-warning",
  urgent: "bg-destructive/20 text-destructive",
}

export default async function TasksPage() {
  const [tasks, projects, currentUser] = await Promise.all([
    listTasksAction(),
    listProjectsAction(),
    getCurrentUserAction(),
  ])

  const openTaskCount = tasks.filter((task) => task.status !== "done").length

  const getProjectName = (projectId: string) => {
    return projects.find((p) => p.id === projectId)?.name || "Unknown"
  }

  const tasksByStatus = tasks.reduce<Record<TaskStatus, Task[]>>((acc, task) => {
    if (!acc[task.status]) acc[task.status] = []
    acc[task.status].push(task)
    return acc
  }, {} as Record<TaskStatus, Task[]>)

  const columns: TaskStatus[] = ["todo", "in_progress", "blocked", "done"]

  return (
    <AppShell title="Tasks" user={currentUser} badges={{ projects: projects.length, tasks: openTaskCount }}>
      <div className="p-4 lg:p-6 space-y-6">
        {/* Header */}
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="hidden lg:block">
            <h1 className="text-2xl font-bold">Tasks</h1>
            <p className="text-muted-foreground mt-1">Track and manage tasks across all projects</p>
          </div>
          <Button className="w-full sm:w-auto">
            <Plus className="mr-2 h-4 w-4" />
            New Task
          </Button>
        </div>

        {/* Filters */}
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
          <div className="relative flex-1 max-w-sm">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input placeholder="Search tasks..." className="pl-9" />
          </div>
        </div>

        {/* Kanban board */}
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
          {columns.map((status) => (
            <div key={status} className="space-y-3">
              <div className="flex items-center justify-between">
                <h3 className="font-semibold text-sm">{statusLabels[status]}</h3>
                <Badge variant="secondary" className="text-xs">
                  {tasksByStatus[status]?.length || 0}
                </Badge>
              </div>

              <div className="space-y-2">
                {tasksByStatus[status]?.map((task) => (
                  <Card key={task.id} className="cursor-pointer hover:border-primary/50 transition-colors">
                    <CardContent className="p-3">
                      <div className="flex items-start gap-2">
                        <Checkbox className="mt-0.5" checked={status === "done"} />
                        <div className="min-w-0 flex-1">
                          <p
                            className={`text-sm font-medium ${status === "done" ? "line-through text-muted-foreground" : ""}`}
                          >
                            {task.title}
                          </p>
                          <p className="text-xs text-muted-foreground mt-1">{getProjectName(task.project_id)}</p>

                          <div className="flex items-center justify-between mt-3">
                            <Badge variant="secondary" className={`text-xs ${priorityColors[task.priority]}`}>
                              {task.priority}
                            </Badge>
                            {task.assignee_id && (
                              <Avatar className="h-6 w-6">
                                <AvatarFallback className="text-xs bg-primary text-primary-foreground">
                                  JD
                                </AvatarFallback>
                              </Avatar>
                            )}
                          </div>
                        </div>
                      </div>
                    </CardContent>
                  </Card>
                ))}

                {/* Add task button */}
                <Button variant="ghost" className="w-full justify-start text-muted-foreground h-9">
                  <Plus className="mr-2 h-4 w-4" />
                  Add task
                </Button>
              </div>
            </div>
          ))}
        </div>
      </div>
    </AppShell>
  )
}
