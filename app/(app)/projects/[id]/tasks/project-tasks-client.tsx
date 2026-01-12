"use client"

import { useState } from "react"
import { toast } from "sonner"

import { TasksTab } from "@/components/tasks/tasks-tab"
import type { Task } from "@/lib/types"
import {
  createProjectTaskAction,
  updateProjectTaskAction,
  deleteProjectTaskAction,
} from "../actions"

interface ProjectTasksClientProps {
  projectId: string
  initialTasks: Task[]
  team: {
    id: string
    user_id: string
    full_name: string
    avatar_url?: string | null
  }[]
}

export function ProjectTasksClient({ projectId, initialTasks, team }: ProjectTasksClientProps) {
  const [tasks, setTasks] = useState<Task[]>(initialTasks)

  return (
    <div className="flex-1 min-h-0">
      <TasksTab
        projectId={projectId}
        tasks={tasks}
        team={team}
        onTaskCreate={async (input) => {
          const created = await createProjectTaskAction(projectId, input)
          setTasks((prev) => [created, ...prev])
          toast.success("Task created", { description: created.title })
          return created
        }}
        onTaskUpdate={async (taskId, updates) => {
          const updated = await updateProjectTaskAction(projectId, taskId, updates)
          setTasks((prev) => prev.map((task) => (task.id === taskId ? updated : task)))
          return updated
        }}
        onTaskDelete={async (taskId) => {
          await deleteProjectTaskAction(projectId, taskId)
          setTasks((prev) => prev.filter((task) => task.id !== taskId))
          toast.success("Task deleted")
        }}
      />
    </div>
  )
}
