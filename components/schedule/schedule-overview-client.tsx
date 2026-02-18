"use client"

import { useState, useMemo, useCallback } from "react"
import { format, isBefore, startOfDay, differenceInDays } from "date-fns"
import { cn } from "@/lib/utils"
import type { Project, ScheduleItem, ScheduleDependency } from "@/lib/types"
import { ScheduleProvider, useSchedule } from "./schedule-context"
import { ScheduleView } from "./schedule-view"
import { ScheduleOverviewEmptyState } from "./schedule-empty-state"
import { GanttChartSkeleton } from "./schedule-skeleton"
import { STATUS_COLORS } from "./types"
import type { ScheduleBulkItemUpdate } from "./types"

import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Progress } from "@/components/ui/progress"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { ScrollArea } from "@/components/ui/scroll-area"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  Building2,
  CalendarDays,
  AlertTriangle,
  CheckCircle2,
  Clock,
  TrendingUp,
  ChevronRight,
} from "lucide-react"

interface ScheduleOverviewClientProps {
  projects: Project[]
  allItems: ScheduleItem[]
  allDependencies: ScheduleDependency[]
  onItemUpdate: (id: string, updates: Partial<ScheduleItem>) => Promise<ScheduleItem>
  onItemsBulkUpdate: (updates: ScheduleBulkItemUpdate[]) => Promise<ScheduleItem[]>
  onItemCreate: (item: Partial<ScheduleItem>) => Promise<ScheduleItem>
  onItemDelete: (id: string) => Promise<void>
  onDependencyCreate: (from: string, to: string, type?: string) => Promise<ScheduleDependency>
  onDependencyDelete: (id: string) => Promise<void>
}

// Summary stats component
function ScheduleStats({
  items,
  projects,
}: {
  items: ScheduleItem[]
  projects: Project[]
}) {
  const today = startOfDay(new Date())

  const stats = useMemo(() => {
    const atRisk = items.filter((i) => i.status === "at_risk" || i.status === "blocked").length
    const completed = items.filter((i) => i.status === "completed").length
    const inProgress = items.filter((i) => i.status === "in_progress").length
    const overdue = items.filter((i) => {
      const endDate = i.end_date ? new Date(i.end_date) : null
      return endDate && isBefore(endDate, today) && i.status !== "completed"
    }).length
    const dueThisWeek = items.filter((i) => {
      const endDate = i.end_date ? new Date(i.end_date) : null
      if (!endDate || i.status === "completed") return false
      const daysUntil = differenceInDays(endDate, today)
      return daysUntil >= 0 && daysUntil <= 7
    }).length
    const completionRate = items.length > 0 ? Math.round((completed / items.length) * 100) : 0

    return { atRisk, completed, inProgress, overdue, dueThisWeek, completionRate, total: items.length }
  }, [items, today])

  return (
    <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-6 gap-4">
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-2">
            <Building2 className="h-4 w-4" />
            Active Projects
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="text-2xl font-bold">{projects.length}</div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-2">
            <CalendarDays className="h-4 w-4" />
            Total Items
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="text-2xl font-bold">{stats.total}</div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-2">
            <Clock className="h-4 w-4" />
            Due This Week
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="text-2xl font-bold">{stats.dueThisWeek}</div>
        </CardContent>
      </Card>

      <Card className={cn(stats.atRisk > 0 && "border-amber-200 dark:border-amber-900")}>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-2">
            <AlertTriangle className="h-4 w-4 text-amber-500" />
            At Risk
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className={cn("text-2xl font-bold", stats.atRisk > 0 && "text-amber-600")}>
            {stats.atRisk}
          </div>
        </CardContent>
      </Card>

      <Card className={cn(stats.overdue > 0 && "border-red-200 dark:border-red-900")}>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-2">
            <AlertTriangle className="h-4 w-4 text-red-500" />
            Overdue
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className={cn("text-2xl font-bold", stats.overdue > 0 && "text-red-600")}>
            {stats.overdue}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-2">
            <TrendingUp className="h-4 w-4" />
            Completion
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="text-2xl font-bold">{stats.completionRate}%</div>
          <Progress value={stats.completionRate} className="h-1.5 mt-2" />
        </CardContent>
      </Card>
    </div>
  )
}

// Project card for the sidebar
function ProjectCard({
  project,
  items,
  isSelected,
  onSelect,
}: {
  project: Project
  items: ScheduleItem[]
  isSelected: boolean
  onSelect: () => void
}) {
  const today = startOfDay(new Date())

  const stats = useMemo(() => {
    const completed = items.filter((i) => i.status === "completed").length
    const atRisk = items.filter((i) => i.status === "at_risk" || i.status === "blocked").length
    const completionRate = items.length > 0 ? Math.round((completed / items.length) * 100) : 0
    return { completed, atRisk, completionRate, total: items.length }
  }, [items])

  return (
    <div
      className={cn(
        "p-3 rounded-lg border cursor-pointer transition-all hover:bg-muted/50",
        isSelected && "bg-primary/5 border-primary"
      )}
      onClick={onSelect}
    >
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2 min-w-0">
          <Building2 className="h-4 w-4 text-muted-foreground flex-shrink-0" />
          <span className="font-medium truncate">{project.name}</span>
        </div>
        <ChevronRight className={cn("h-4 w-4 text-muted-foreground transition-transform", isSelected && "rotate-90")} />
      </div>

      <div className="flex items-center gap-2 text-xs text-muted-foreground mb-2">
        <span>{stats.total} items</span>
        {stats.atRisk > 0 && (
          <Badge variant="outline" className="bg-amber-50 text-amber-700 border-amber-200 text-xs">
            {stats.atRisk} at risk
          </Badge>
        )}
      </div>

      <div className="flex items-center gap-2">
        <Progress value={stats.completionRate} className="h-1.5 flex-1" />
        <span className="text-xs text-muted-foreground w-8">{stats.completionRate}%</span>
      </div>
    </div>
  )
}

export function ScheduleOverviewClient({
  projects,
  allItems,
  allDependencies,
  onItemUpdate,
  onItemsBulkUpdate,
  onItemCreate,
  onItemDelete,
  onDependencyCreate,
  onDependencyDelete,
}: ScheduleOverviewClientProps) {
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(
    projects.length > 0 ? projects[0].id : null
  )
  const [viewMode, setViewMode] = useState<"overview" | "project">("project")

  // Get items grouped by project
  const itemsByProject = useMemo(() => {
    const map = new Map<string, ScheduleItem[]>()
    for (const project of projects) {
      map.set(project.id, allItems.filter((i) => i.project_id === project.id))
    }
    return map
  }, [projects, allItems])

  const selectedProject = projects.find((p) => p.id === selectedProjectId)
  const selectedItems = selectedProjectId ? itemsByProject.get(selectedProjectId) || [] : []
  const selectedDependencies = selectedProjectId
    ? allDependencies.filter((d) => d.project_id === selectedProjectId)
    : []

  if (projects.length === 0) {
    return <ScheduleOverviewEmptyState />
  }

  return (
    <div className="flex flex-col h-full">
      {/* Stats header */}
      <div className="p-4 border-b bg-muted/20">
        <ScheduleStats items={allItems} projects={projects} />
      </div>

      {/* Main content */}
      <div className="flex flex-1 min-h-0">
        {/* Project sidebar */}
        <div className="w-72 border-r bg-muted/10 flex flex-col">
          <div className="p-3 border-b">
            <h3 className="text-sm font-medium text-muted-foreground uppercase tracking-wider">
              Projects
            </h3>
          </div>
          <ScrollArea className="flex-1">
            <div className="p-3 space-y-2">
              {projects.map((project) => (
                <ProjectCard
                  key={project.id}
                  project={project}
                  items={itemsByProject.get(project.id) || []}
                  isSelected={project.id === selectedProjectId}
                  onSelect={() => setSelectedProjectId(project.id)}
                />
              ))}
            </div>
          </ScrollArea>
        </div>

        {/* Schedule view */}
        <div className="flex-1 min-w-0">
          {selectedProject ? (
            <ScheduleView
              projectId={selectedProject.id}
              items={selectedItems}
              dependencies={selectedDependencies}
              onItemUpdate={onItemUpdate}
              onItemsBulkUpdate={onItemsBulkUpdate}
              onItemCreate={onItemCreate}
              onItemDelete={onItemDelete}
              onDependencyCreate={onDependencyCreate}
              onDependencyDelete={onDependencyDelete}
            />
          ) : (
            <div className="flex items-center justify-center h-full text-muted-foreground">
              Select a project to view its schedule
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
