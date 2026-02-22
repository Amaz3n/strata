"use client"

import { useMemo, useState, useCallback, useEffect } from "react"
import {
  addDays,
  endOfWeek,
  isAfter,
  isBefore,
  isWithinInterval,
  parseISO,
  startOfDay,
} from "date-fns"

import type { Project, ScheduleItem, ScheduleDependency } from "@/lib/types"
import { cn } from "@/lib/utils"
import { ScheduleProvider, useSchedule } from "@/components/schedule/schedule-context"
import { ScheduleToolbar } from "@/components/schedule/schedule-toolbar"
import { ScheduleItemSheet } from "@/components/schedule/schedule-item-sheet"
import { GanttChart } from "@/components/schedule/gantt-chart"
import { LookaheadView } from "@/components/schedule/lookahead-view"
import { STATUS_COLORS } from "@/components/schedule/types"

import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Progress } from "@/components/ui/progress"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip"
import {
  AlertCircle,
  ArrowRight,
  Building2,
  CheckCircle,
  Clock,
} from "@/components/icons"
import { toast } from "sonner"
import {
  createScheduleItemAction,
  updateScheduleItemAction,
  bulkUpdateScheduleItemsAction,
  deleteScheduleItemAction,
  listDependenciesForProjectsAction,
} from "./actions"

interface ScheduleClientProps {
  scheduleItems: ScheduleItem[]
  projects: Project[]
}

// Project color palette for visual distinction
const PROJECT_COLORS = [
  "#3b82f6", // blue
  "#10b981", // emerald
  "#f59e0b", // amber
  "#8b5cf6", // violet
  "#ef4444", // red
  "#06b6d4", // cyan
  "#ec4899", // pink
  "#84cc16", // lime
  "#f97316", // orange
  "#6366f1", // indigo
]

function getProjectColor(projectId: string, projects: Project[]): string {
  const index = projects.findIndex((p) => p.id === projectId)
  return PROJECT_COLORS[index % PROJECT_COLORS.length]
}

// Portfolio Stats Component
function PortfolioStats({
  items,
  projects,
}: {
  items: ScheduleItem[]
  projects: Project[]
}) {
  const today = startOfDay(new Date())
  const weekEnd = endOfWeek(today, { weekStartsOn: 1 })

  const stats = useMemo(() => {
    const activeProjects = projects.filter(
      (p) => p.status === "active" || p.status === "planning"
    )

    const atRiskItems = items.filter((item) => {
      const status = item.status
      if (status === "at_risk" || status === "blocked") return true
      const endDate = item.end_date ? parseISO(item.end_date) : null
      const isOverdue =
        endDate && isBefore(endDate, today) && status !== "completed"
      return isOverdue
    })

    const dueThisWeek = items.filter((item) => {
      const endDate = item.end_date ? parseISO(item.end_date) : null
      if (!endDate) return false
      return (
        isWithinInterval(endDate, { start: today, end: weekEnd }) &&
        item.status !== "completed"
      )
    })

    const completedItems = items.filter((item) => item.status === "completed")
    const completionRate = items.length
      ? Math.round((completedItems.length / items.length) * 100)
      : 0

    const upcomingMilestones = items.filter((item) => {
      if (item.item_type !== "milestone" && item.item_type !== "inspection")
        return false
      const startDate = item.start_date ? parseISO(item.start_date) : null
      if (!startDate) return false
      return (
        isAfter(startDate, today) &&
        isBefore(startDate, addDays(today, 14)) &&
        item.status !== "completed"
      )
    })

    // Critical path items count
    const criticalPathItems = items.filter((item) => item.is_critical_path)

    return {
      activeProjects: activeProjects.length,
      totalItems: items.length,
      atRiskCount: atRiskItems.length,
      dueThisWeekCount: dueThisWeek.length,
      completionRate,
      completedCount: completedItems.length,
      upcomingMilestones: upcomingMilestones.length,
      criticalPathItems: criticalPathItems.length,
    }
  }, [items, projects, today, weekEnd])

  return (
    <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
      <Card>
        <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
          <CardTitle className="text-sm font-medium">Active Projects</CardTitle>
          <Building2 className="h-4 w-4 text-muted-foreground" />
        </CardHeader>
        <CardContent>
          <div className="text-2xl font-bold">{stats.activeProjects}</div>
          <p className="text-xs text-muted-foreground mt-1">
            {stats.totalItems} schedule items total
          </p>
        </CardContent>
      </Card>

      <Card className={stats.atRiskCount > 0 ? "border-warning/50" : ""}>
        <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
          <CardTitle className="text-sm font-medium">At Risk</CardTitle>
          <AlertCircle
            className={cn(
              "h-4 w-4",
              stats.atRiskCount > 0 ? "text-warning" : "text-muted-foreground"
            )}
          />
        </CardHeader>
        <CardContent>
          <div className="text-2xl font-bold">{stats.atRiskCount}</div>
          <p className="text-xs text-muted-foreground mt-1">
            {stats.criticalPathItems > 0 && (
              <span className="text-orange-500">
                {stats.criticalPathItems} on critical path
              </span>
            )}
            {stats.criticalPathItems === 0 && "Items needing attention"}
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
          <CardTitle className="text-sm font-medium">Due This Week</CardTitle>
          <Clock className="h-4 w-4 text-muted-foreground" />
        </CardHeader>
        <CardContent>
          <div className="text-2xl font-bold">{stats.dueThisWeekCount}</div>
          <p className="text-xs text-muted-foreground mt-1">
            {stats.upcomingMilestones > 0 && (
              <span>
                {stats.upcomingMilestones} milestone
                {stats.upcomingMilestones !== 1 ? "s" : ""} in 2 weeks
              </span>
            )}
            {stats.upcomingMilestones === 0 && "Inspections & milestones"}
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
          <CardTitle className="text-sm font-medium">Completion Rate</CardTitle>
          <CheckCircle className="h-4 w-4 text-emerald-500" />
        </CardHeader>
        <CardContent>
          <div className="text-2xl font-bold">{stats.completionRate}%</div>
          <Progress value={stats.completionRate} className="mt-2" />
          <p className="text-xs text-muted-foreground mt-1">
            {stats.completedCount} of {stats.totalItems} items done
          </p>
        </CardContent>
      </Card>
    </div>
  )
}

// Project Health Strip - Shows all projects at a glance
function ProjectHealthStrip({
  items,
  projects,
  selectedProjectId,
  onSelectProject,
}: {
  items: ScheduleItem[]
  projects: Project[]
  selectedProjectId: string
  onSelectProject: (id: string) => void
}) {
  const today = startOfDay(new Date())

  const projectStats = useMemo(() => {
    const activeProjects = projects.filter(
      (p) => p.status !== "completed" && p.status !== "cancelled"
    )

    return activeProjects.map((project) => {
      const projectItems = items.filter((item) => item.project_id === project.id)
      const atRisk = projectItems.filter((item) => {
        if (item.status === "at_risk" || item.status === "blocked") return true
        const endDate = item.end_date ? parseISO(item.end_date) : null
        return (
          endDate && isBefore(endDate, today) && item.status !== "completed"
        )
      })
      const completed = projectItems.filter((item) => item.status === "completed")
      const progress = projectItems.length
        ? Math.round((completed.length / projectItems.length) * 100)
        : 0

      return {
        ...project,
        itemCount: projectItems.length,
        atRiskCount: atRisk.length,
        progress,
        color: getProjectColor(project.id, projects),
      }
    })
  }, [items, projects, today])

  if (projectStats.length === 0) return null

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <div>
            <CardTitle className="text-base">Project Overview</CardTitle>
            <CardDescription>
              Click a project to filter the schedule
            </CardDescription>
          </div>
          {selectedProjectId !== "all" && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => onSelectProject("all")}
            >
              Show all
            </Button>
          )}
        </div>
      </CardHeader>
      <CardContent>
        <ScrollArea className="w-full">
          <div className="flex gap-3 pb-2">
            {projectStats.map((project) => {
              const isSelected = selectedProjectId === project.id
              return (
                <TooltipProvider key={project.id}>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <button
                        onClick={() =>
                          onSelectProject(isSelected ? "all" : project.id)
                        }
                        className={cn(
                          "flex-shrink-0 rounded-lg border p-3 transition-all hover:shadow-md min-w-[180px]",
                          isSelected
                            ? "ring-2 ring-primary border-primary bg-primary/5"
                            : "hover:border-muted-foreground/30"
                        )}
                      >
                        <div className="flex items-start gap-3">
                          <div
                            className="w-3 h-3 rounded-full flex-shrink-0 mt-1"
                            style={{ backgroundColor: project.color }}
                          />
                          <div className="min-w-0 text-left">
                            <p className="text-sm font-medium truncate max-w-[140px]">
                              {project.name}
                            </p>
                            <div className="flex items-center gap-2 mt-1">
                              <span className="text-xs text-muted-foreground">
                                {project.itemCount} items
                              </span>
                              {project.atRiskCount > 0 && (
                                <Badge
                                  variant="outline"
                                  className="text-[10px] px-1 py-0 bg-warning/10 text-warning border-warning/30"
                                >
                                  {project.atRiskCount} at risk
                                </Badge>
                              )}
                            </div>
                            <Progress
                              value={project.progress}
                              className="h-1.5 mt-2"
                            />
                          </div>
                        </div>
                      </button>
                    </TooltipTrigger>
                    <TooltipContent>
                      <p className="font-medium">{project.name}</p>
                      <p className="text-xs text-muted-foreground">
                        {project.progress}% complete
                      </p>
                    </TooltipContent>
                  </Tooltip>
                </TooltipProvider>
              )
            })}
          </div>
        </ScrollArea>
      </CardContent>
    </Card>
  )
}

// Inner component that uses the schedule context
function MasterScheduleInner({
  projects,
  projectFilter,
  onProjectFilterChange,
}: {
  projects: Project[]
  projectFilter: string
  onProjectFilterChange: (id: string) => void
}) {
  const { viewState, selectedItem, setSelectedItem, items } = useSchedule()
  const [sheetOpen, setSheetOpen] = useState(false)
  const [quickAddDates, setQuickAddDates] = useState<{
    start: Date
    end: Date
  } | null>(null)

  const handleAddItem = useCallback(() => {
    setSelectedItem(null)
    setQuickAddDates(null)
    setSheetOpen(true)
  }, [setSelectedItem])

  const handleEditItem = useCallback(
    (item: ScheduleItem) => {
      setSelectedItem(item)
      setSheetOpen(true)
    },
    [setSelectedItem]
  )

  const handleQuickAdd = useCallback(
    (startDate: Date, endDate: Date) => {
      setSelectedItem(null)
      setQuickAddDates({ start: startDate, end: endDate })
      setSheetOpen(true)
    },
    [setSelectedItem]
  )

  const handleSheetClose = useCallback((open: boolean) => {
    setSheetOpen(open)
    if (!open) {
      setQuickAddDates(null)
    }
  }, [])

  // Filter items by selected project
  const filteredItems = useMemo(() => {
    if (projectFilter === "all") return items
    return items.filter((item) => item.project_id === projectFilter)
  }, [items, projectFilter])

  // Determine which project to use for the sheet
  const defaultProjectId = useMemo(() => {
    if (projectFilter !== "all") return projectFilter
    if (projects.length > 0) return projects[0].id
    return ""
  }, [projectFilter, projects])

  // Render the appropriate view
  const renderView = () => {
    switch (viewState.view) {
      case "gantt":
        return (
          <GanttChart
            className="flex-1"
            onQuickAdd={handleQuickAdd}
            onEditItem={handleEditItem}
            onAddItem={handleAddItem}
          />
        )
      case "lookahead":
        return <LookaheadView className="flex-1" />
      default:
        return (
          <GanttChart
            className="flex-1"
            onQuickAdd={handleQuickAdd}
            onEditItem={handleEditItem}
            onAddItem={handleAddItem}
          />
        )
    }
  }

  return (
    <div className="flex flex-col h-full bg-background overflow-hidden w-full">
      <ScheduleToolbar onAddItem={handleAddItem} />
      {renderView()}
      <ScheduleItemSheet
        open={sheetOpen}
        onOpenChange={handleSheetClose}
        item={selectedItem}
        projectId={defaultProjectId}
        initialDates={quickAddDates}
        projects={projects}
      />
    </div>
  )
}

// Main export component
export function ScheduleClient({ scheduleItems, projects }: ScheduleClientProps) {
  const [items, setItems] = useState<ScheduleItem[]>(scheduleItems)
  const [dependencies, setDependencies] = useState<ScheduleDependency[]>([])
  const [projectFilter, setProjectFilter] = useState<string>("all")

  // Load dependencies on mount
  useEffect(() => {
    const projectIds = [...new Set(scheduleItems.map((item) => item.project_id))]
    if (projectIds.length > 0) {
      listDependenciesForProjectsAction(projectIds)
        .then(setDependencies)
        .catch(console.error)
    }
  }, [scheduleItems])

  // Filter items for display
  const filteredItems = useMemo(() => {
    if (projectFilter === "all") return items
    return items.filter((item) => item.project_id === projectFilter)
  }, [items, projectFilter])

  // Handlers
  const handleItemCreate = useCallback(
    async (item: Partial<ScheduleItem>) => {
      const created = await createScheduleItemAction(item)
      setItems((prev) => [...prev, created])
      toast.success("Schedule item created", { description: created.name })
      return created
    },
    []
  )

  const handleItemUpdate = useCallback(
    async (id: string, updates: Partial<ScheduleItem>) => {
      const updated = await updateScheduleItemAction(id, updates)
      setItems((prev) => prev.map((item) => (item.id === id ? updated : item)))
      return updated
    },
    []
  )

  const handleItemsBulkUpdate = useCallback(
    async (updates: { id: string; start_date?: string; end_date?: string; sort_order?: number; progress?: number; status?: ScheduleItem["status"] }[]) => {
      const updatedItems = await bulkUpdateScheduleItemsAction({ items: updates })
      if (updatedItems.length > 0) {
        const updatedMap = new Map(updatedItems.map((item) => [item.id, item]))
        setItems((prev) => prev.map((item) => updatedMap.get(item.id) ?? item))
      }
      return updatedItems
    },
    []
  )

  const handleItemDelete = useCallback(async (id: string) => {
    await deleteScheduleItemAction(id)
    setItems((prev) => prev.filter((item) => item.id !== id))
    toast.success("Schedule item deleted")
  }, [])

  return (
    <div className="flex flex-col gap-6 h-[calc(100vh-7rem)]">
      {/* Header */}
      <div className="flex-shrink-0">
        <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <p className="text-sm text-muted-foreground">
              Master schedule view across all projects
            </p>
            <h1 className="text-2xl font-bold mt-1">Schedule</h1>
          </div>
        </div>
      </div>

      {/* Portfolio Stats */}
      <div className="flex-shrink-0">
        <PortfolioStats items={items} projects={projects} />
      </div>

      {/* Project Health Strip */}
      <div className="flex-shrink-0">
        <ProjectHealthStrip
          items={items}
          projects={projects}
          selectedProjectId={projectFilter}
          onSelectProject={setProjectFilter}
        />
      </div>

      {/* Schedule View */}
      <Card className="flex-1 min-h-0 overflow-hidden">
        <CardContent className="p-0 h-full">
          <ScheduleProvider
            initialItems={filteredItems}
            initialDependencies={dependencies}
            onItemUpdate={handleItemUpdate}
            onItemsBulkUpdate={handleItemsBulkUpdate}
            onItemCreate={handleItemCreate}
            onItemDelete={handleItemDelete}
          >
            <MasterScheduleInner
              projects={projects}
              projectFilter={projectFilter}
              onProjectFilterChange={setProjectFilter}
            />
          </ScheduleProvider>
        </CardContent>
      </Card>
    </div>
  )
}
