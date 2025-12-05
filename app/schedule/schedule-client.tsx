"use client"

import { useMemo, useState, useTransition, useCallback, useEffect } from "react"
import Link from "next/link"
import {
  addDays,
  differenceInCalendarDays,
  endOfWeek,
  format,
  isAfter,
  isBefore,
  isSameDay,
  isWithinInterval,
  parseISO,
  startOfDay,
  startOfWeek,
  subDays,
} from "date-fns"

import type { Project, ScheduleItem, ScheduleDependency } from "@/lib/types"
import { cn } from "@/lib/utils"
import { ScheduleProvider, useSchedule } from "@/components/schedule/schedule-context"
import { ScheduleToolbar } from "@/components/schedule/schedule-toolbar"
import { ScheduleItemSheet } from "@/components/schedule/schedule-item-sheet"
import { GanttChart } from "@/components/schedule/gantt-chart"
import { LookaheadView } from "@/components/schedule/lookahead-view"
import { STATUS_COLORS, PHASE_COLORS, parseDate } from "@/components/schedule/types"
import { scheduleStatuses } from "@/lib/validation/schedule"

import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Progress } from "@/components/ui/progress"
import { Checkbox } from "@/components/ui/checkbox"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Separator } from "@/components/ui/separator"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  AlertCircle,
  AlertTriangle,
  ArrowRight,
  ArrowRightLeft,
  Building2,
  CalendarDays,
  CheckCircle,
  CheckSquare,
  ClipboardCheck,
  Clock,
  Flag,
  Layers,
  Link2,
  MoreHorizontal,
  TrendingUp,
  Truck,
} from "@/components/icons"
import { toast } from "sonner"
import {
  createScheduleItemAction,
  updateScheduleItemAction,
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

// Master List View with project grouping
function MasterListView({
  projects,
  projectFilter,
}: {
  projects: Project[]
  projectFilter: string
}) {
  const { items, selectedItem, setSelectedItem, onItemUpdate, viewState } =
    useSchedule()
  const today = startOfDay(new Date())

  const getItemIcon = (type: string) => {
    switch (type) {
      case "milestone":
        return <Flag className="h-4 w-4" />
      case "inspection":
        return <ClipboardCheck className="h-4 w-4" />
      case "handoff":
        return <ArrowRightLeft className="h-4 w-4" />
      case "phase":
        return <Layers className="h-4 w-4" />
      case "delivery":
        return <Truck className="h-4 w-4" />
      default:
        return <CheckSquare className="h-4 w-4" />
    }
  }

  const isOverdue = (item: ScheduleItem) => {
    const endDate = parseDate(item.end_date) || parseDate(item.start_date)
    return endDate && isBefore(endDate, today) && item.status !== "completed"
  }

  const handleStatusChange = async (itemId: string, newStatus: string) => {
    await onItemUpdate(itemId, { status: newStatus as ScheduleItem["status"] })
  }

  // Group items by project when viewing all
  const groupedItems = useMemo(() => {
    const filtered =
      projectFilter === "all"
        ? items
        : items.filter((item) => item.project_id === projectFilter)

    if (projectFilter !== "all" || viewState.groupBy !== "none") {
      return new Map([["all", filtered]])
    }

    // Group by project
    const groups = new Map<string, ScheduleItem[]>()
    for (const item of filtered) {
      const projectId = item.project_id
      if (!groups.has(projectId)) {
        groups.set(projectId, [])
      }
      groups.get(projectId)!.push(item)
    }
    return groups
  }, [items, projectFilter, viewState.groupBy])

  const projectLookup = useMemo(
    () =>
      projects.reduce<Record<string, Project>>(
        (acc, p) => ({ ...acc, [p.id]: p }),
        {}
      ),
    [projects]
  )

  return (
    <div className="flex-1 overflow-auto">
      <Table>
        <TableHeader className="sticky top-0 bg-background z-10">
          <TableRow>
            <TableHead className="w-12"></TableHead>
            <TableHead>Item</TableHead>
            <TableHead>Project</TableHead>
            <TableHead>Type</TableHead>
            <TableHead>Phase</TableHead>
            <TableHead>Dates</TableHead>
            <TableHead>Status</TableHead>
            <TableHead className="w-32">Progress</TableHead>
            <TableHead className="w-12"></TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {Array.from(groupedItems.entries()).map(([groupKey, groupItems]) => {
            const project = projectLookup[groupKey]
            const showGroupHeader =
              projectFilter === "all" &&
              viewState.groupBy === "none" &&
              groupKey !== "all"

            return (
              <TooltipProvider key={groupKey}>
                {showGroupHeader && project && (
                  <TableRow className="bg-muted/30 hover:bg-muted/50">
                    <TableCell colSpan={9}>
                      <div className="flex items-center gap-2">
                        <div
                          className="w-3 h-3 rounded-full"
                          style={{
                            backgroundColor: getProjectColor(
                              project.id,
                              projects
                            ),
                          }}
                        />
                        <span className="font-medium">{project.name}</span>
                        <Badge variant="secondary" className="text-xs">
                          {groupItems.length} items
                        </Badge>
                        <Link
                          href={`/projects/${project.id}`}
                          className="ml-auto text-xs text-primary hover:underline flex items-center gap-1"
                        >
                          View project
                          <ArrowRight className="h-3 w-3" />
                        </Link>
                      </div>
                    </TableCell>
                  </TableRow>
                )}
                {groupItems.map((item) => {
                  const statusColors =
                    STATUS_COLORS[item.status] || STATUS_COLORS.planned
                  const overdue = isOverdue(item)
                  const isSelected = selectedItem?.id === item.id
                  const itemProject = projectLookup[item.project_id]

                  return (
                    <TableRow
                      key={item.id}
                      className={cn(
                        "cursor-pointer transition-colors",
                        isSelected && "bg-primary/5",
                        overdue && "border-l-2 border-l-red-500"
                      )}
                      onClick={() => setSelectedItem(item)}
                    >
                      <TableCell>
                        <Checkbox
                          checked={item.status === "completed"}
                          onClick={(e) => {
                            e.stopPropagation()
                            handleStatusChange(
                              item.id,
                              item.status === "completed"
                                ? "in_progress"
                                : "completed"
                            )
                          }}
                        />
                      </TableCell>
                      <TableCell>
                        <div className="flex items-center gap-2">
                          <div className={cn("p-1 rounded", statusColors.bg)}>
                            {getItemIcon(item.item_type)}
                          </div>
                          <div className="min-w-0">
                            <div className="font-medium truncate max-w-[200px]">
                              {item.name}
                            </div>
                            {item.location && (
                              <div className="text-xs text-muted-foreground truncate">
                                {item.location}
                              </div>
                            )}
                          </div>
                          {item.dependencies && item.dependencies.length > 0 && (
                            <Tooltip>
                              <TooltipTrigger>
                                <Link2 className="h-3.5 w-3.5 text-muted-foreground" />
                              </TooltipTrigger>
                              <TooltipContent>
                                {item.dependencies.length} dependencies
                              </TooltipContent>
                            </Tooltip>
                          )}
                          {item.is_critical_path && (
                            <Tooltip>
                              <TooltipTrigger>
                                <AlertTriangle className="h-3.5 w-3.5 text-orange-500" />
                              </TooltipTrigger>
                              <TooltipContent>Critical path item</TooltipContent>
                            </Tooltip>
                          )}
                        </div>
                      </TableCell>
                      <TableCell>
                        {itemProject && (
                          <div className="flex items-center gap-1.5">
                            <div
                              className="w-2 h-2 rounded-full"
                              style={{
                                backgroundColor: getProjectColor(
                                  itemProject.id,
                                  projects
                                ),
                              }}
                            />
                            <span className="text-sm truncate max-w-[120px]">
                              {itemProject.name}
                            </span>
                          </div>
                        )}
                      </TableCell>
                      <TableCell>
                        <Badge variant="outline" className="capitalize">
                          {item.item_type}
                        </Badge>
                      </TableCell>
                      <TableCell>
                        {item.phase ? (
                          <div className="flex items-center gap-1.5">
                            <div
                              className="w-2 h-2 rounded-full"
                              style={{
                                backgroundColor:
                                  PHASE_COLORS[item.phase] || "#64748b",
                              }}
                            />
                            <span className="text-sm capitalize">
                              {item.phase.replace(/_/g, " ")}
                            </span>
                          </div>
                        ) : (
                          <span className="text-muted-foreground">—</span>
                        )}
                      </TableCell>
                      <TableCell className="text-sm text-muted-foreground">
                        {item.start_date ? (
                          <>
                            {format(parseDate(item.start_date)!, "MMM d")}
                            {item.end_date &&
                              ` – ${format(parseDate(item.end_date)!, "MMM d")}`}
                          </>
                        ) : (
                          "No dates"
                        )}
                        {overdue && (
                          <span className="text-red-500 text-xs ml-2">
                            Overdue
                          </span>
                        )}
                      </TableCell>
                      <TableCell>
                        <Select
                          value={item.status}
                          onValueChange={(value) =>
                            handleStatusChange(item.id, value)
                          }
                        >
                          <SelectTrigger
                            className={cn(
                              "h-8 w-32",
                              statusColors.bg,
                              statusColors.text
                            )}
                            onClick={(e) => e.stopPropagation()}
                          >
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            {scheduleStatuses.map((status) => (
                              <SelectItem key={status} value={status}>
                                <span className="capitalize">
                                  {status.replace(/_/g, " ")}
                                </span>
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </TableCell>
                      <TableCell>
                        <div className="space-y-1">
                          <Progress value={item.progress || 0} className="h-2" />
                          <span className="text-xs text-muted-foreground">
                            {item.progress || 0}%
                          </span>
                        </div>
                      </TableCell>
                      <TableCell>
                        <DropdownMenu>
                          <DropdownMenuTrigger
                            asChild
                            onClick={(e) => e.stopPropagation()}
                          >
                            <Button variant="ghost" size="icon" className="h-8 w-8">
                              <MoreHorizontal className="h-4 w-4" />
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end">
                            <DropdownMenuItem asChild>
                              <Link href={`/projects/${item.project_id}`}>
                                Go to project
                              </Link>
                            </DropdownMenuItem>
                            <DropdownMenuItem>Edit</DropdownMenuItem>
                            <DropdownMenuItem className="text-destructive">
                              Delete
                            </DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </TableCell>
                    </TableRow>
                  )
                })}
              </TooltipProvider>
            )
          })}
          {items.length === 0 && (
            <TableRow>
              <TableCell
                colSpan={9}
                className="text-center py-12 text-muted-foreground"
              >
                No schedule items yet. Add your first item to get started.
              </TableCell>
            </TableRow>
          )}
        </TableBody>
      </Table>
    </div>
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
          />
        )
      case "list":
        return (
          <MasterListView projects={projects} projectFilter={projectFilter} />
        )
      case "lookahead":
        return <LookaheadView className="flex-1" />
      default:
        return (
          <GanttChart
            className="flex-1"
            onQuickAdd={handleQuickAdd}
            onEditItem={handleEditItem}
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
  const [isPending, startTransition] = useTransition()

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
