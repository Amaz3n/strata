"use client"

import Link from "next/link"

import { TasksTab } from "@/components/tasks/tasks-tab"
import { ArrowUpRight } from "@/components/icons"
import type { Task } from "@/lib/types"
import type { MyWorkApproval } from "@/lib/services/my-work"
import {
  createMyTaskAction,
  deleteMyTaskAction,
  updateMyTaskAction,
} from "./actions"

interface TasksPageClientProps {
  initialTasks: Task[]
  projects: Array<{ id: string; name: string }>
  team: Array<{ id: string; user_id: string; full_name: string; avatar_url?: string }>
  approvals: MyWorkApproval[]
  initialProjectFilter?: string
}

/* The Tasks page is the personal cross-project hub: approvals waiting on me sit
   in a hairline band up top; everything else is the task workbench where I create
   and manage my tasks across projects. */

function ApprovalsBand({ approvals }: { approvals: MyWorkApproval[] }) {
  if (approvals.length === 0) return null
  const total = approvals.reduce((sum, a) => sum + a.count, 0)

  return (
    <div className="flex items-center gap-2 overflow-x-auto border-b bg-muted/30 px-4 py-2">
      <span className="whitespace-nowrap text-xs font-medium text-muted-foreground">
        Waiting on me <span className="font-mono tabular-nums text-foreground/70">{total}</span>
      </span>
      <span className="text-muted-foreground/40">·</span>
      {approvals.map((approval) => (
        <Link
          key={approval.projectId}
          href={approval.href}
          className="group flex items-center gap-1.5 whitespace-nowrap border bg-background px-2 py-1 text-xs hover:border-foreground/30"
        >
          <span className="truncate">{approval.projectName}</span>
          <span className="font-mono tabular-nums text-muted-foreground">{approval.count}</span>
          <ArrowUpRight className="size-3 text-muted-foreground/50 transition-colors group-hover:text-foreground" />
        </Link>
      ))}
    </div>
  )
}

export function TasksPageClient({
  initialTasks,
  projects,
  team,
  approvals,
  initialProjectFilter,
}: TasksPageClientProps) {
  return (
    <div className="flex h-full min-h-0 flex-col">
      <ApprovalsBand approvals={approvals} />
      <div className="min-h-0 flex-1">
        <TasksTab
          tasks={initialTasks}
          projects={projects}
          team={team}
          initialProjectFilter={initialProjectFilter}
          onTaskCreate={(input) => createMyTaskAction(input)}
          onTaskUpdate={(taskId, updates) => updateMyTaskAction(taskId, updates)}
          onTaskDelete={(taskId) => deleteMyTaskAction(taskId)}
        />
      </div>
    </div>
  )
}
