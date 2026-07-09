"use client"

import { useState, useMemo, useEffect, type CSSProperties } from "react"
import type React from "react"
import { format, parseISO, isPast, isToday, isTomorrow, differenceInDays } from "date-fns"
import { toast } from "sonner"

import type { Task, TaskStatus, TaskPriority, TaskChecklistItem, TaskTrade } from "@/lib/types"
import { type TaskInput } from "@/lib/validation/tasks"
import { cn } from "@/lib/utils"
import { listOrgAssignableResourcesAction } from "@/app/(app)/tasks/actions"
import type { AssignableResource } from "@/app/(app)/projects/[id]/actions"
import { EntityAttachments, type AttachedFile } from "@/components/files"
import { LinkedDrawings } from "@/components/drawings"
import {
  listAttachmentsAction,
  detachFileLinkAction,
  uploadFileAction,
  attachFileAction,
} from "@/app/(app)/documents/actions"

import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Progress } from "@/components/ui/progress"
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
import { Checkbox } from "@/components/ui/checkbox"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Separator } from "@/components/ui/separator"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Calendar } from "@/components/ui/calendar"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Sheet, SheetContent } from "@/components/ui/sheet"
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectLabel,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import {
  Plus,
  Search,
  MoreHorizontal,
  CalendarDays,
  Bell,
  Clock,
  CheckCircle2,
  Timer,
  Ban,
  ChevronDown,
  SlidersHorizontal,
  FolderOpen,
  MapPin,
  Wrench,
  User,
  Trash2,
  Edit,
  Check,
  X,
} from "@/components/icons"

import { unwrapAction } from "@/lib/action-result"

// ============================================
// TYPES & CONSTANTS
// ============================================

interface TaskProjectOption {
  id: string
  name: string
}

interface TasksTabProps {
  tasks: Task[]
  /** Projects the task can be attached to. Empty = personal-only. */
  projects: TaskProjectOption[]
  /** Preselect the project filter (e.g. arriving from a project's Tasks nav). */
  initialProjectFilter?: string
  team: Array<{
    id: string
    user_id: string
    full_name: string
    avatar_url?: string
  }>
  onTaskCreate: (input: TaskInput) => Promise<Task>
  onTaskUpdate: (taskId: string, input: Partial<TaskInput>) => Promise<Task>
  onTaskDelete: (taskId: string) => Promise<void>
}

const NO_PROJECT = "none"

const STATUS_CONFIG: Record<TaskStatus, { label: string; color: string; bgColor: string }> = {
  todo: { label: "To Do", color: "text-muted-foreground", bgColor: "bg-muted" },
  in_progress: { label: "In Progress", color: "text-blue-600 dark:text-blue-400", bgColor: "bg-blue-500/10" },
  blocked: { label: "Blocked", color: "text-destructive", bgColor: "bg-destructive/10" },
  done: { label: "Done", color: "text-emerald-600 dark:text-emerald-400", bgColor: "bg-emerald-500/10" },
}

const PRIORITY_CONFIG: Record<TaskPriority, { label: string; color: string; bgColor: string; dotColor: string }> = {
  low: { label: "Low", color: "text-muted-foreground", bgColor: "bg-muted", dotColor: "bg-slate-400" },
  normal: { label: "Normal", color: "text-primary", bgColor: "bg-primary/10", dotColor: "bg-primary" },
  high: { label: "High", color: "text-amber-600 dark:text-amber-400", bgColor: "bg-amber-500/10", dotColor: "bg-amber-500" },
  urgent: { label: "Urgent", color: "text-destructive", bgColor: "bg-destructive/10", dotColor: "bg-destructive" },
}

const TRADE_CONFIG: Record<TaskTrade, { label: string; color: string }> = {
  general: { label: "General", color: "bg-slate-500" },
  demolition: { label: "Demolition", color: "bg-gray-600" },
  concrete: { label: "Concrete", color: "bg-stone-500" },
  framing: { label: "Framing", color: "bg-amber-600" },
  roofing: { label: "Roofing", color: "bg-red-600" },
  electrical: { label: "Electrical", color: "bg-yellow-500" },
  plumbing: { label: "Plumbing", color: "bg-blue-600" },
  hvac: { label: "HVAC", color: "bg-cyan-500" },
  insulation: { label: "Insulation", color: "bg-pink-500" },
  drywall: { label: "Drywall", color: "bg-gray-400" },
  painting: { label: "Painting", color: "bg-purple-500" },
  flooring: { label: "Flooring", color: "bg-orange-600" },
  cabinets: { label: "Cabinets", color: "bg-amber-700" },
  tile: { label: "Tile", color: "bg-teal-500" },
  landscaping: { label: "Landscaping", color: "bg-green-600" },
  other: { label: "Other", color: "bg-slate-400" },
}

const STATUS_ORDER: TaskStatus[] = ["todo", "in_progress", "blocked", "done"]
const PRIORITY_ORDER: TaskPriority[] = ["urgent", "high", "normal", "low"]
// Order the grouped sections appear in the list (active work first, done last).
const STATUS_SECTION_ORDER: TaskStatus[] = ["in_progress", "todo", "blocked", "done"]

// ============================================
// HELPER FUNCTIONS
// ============================================

function getInitials(name: string): string {
  return name
    .split(" ")
    .map((n) => n[0])
    .join("")
    .toUpperCase()
    .slice(0, 2)
}

function encodeAssignee(kind: "user" | "contact" | "company", id: string) {
  return `${kind}:${id}`
}

function taskAssigneeValue(task: Task): string {
  if (task.assignee_kind && task.assignee_id) return encodeAssignee(task.assignee_kind, task.assignee_id)
  return "unassigned"
}

function taskAssigneeName(task: Task): string | undefined {
  return (
    task.assignee?.full_name ??
    task.assignee_contact?.full_name ??
    task.assignee_company?.name ??
    undefined
  )
}

function formatDueDate(dateStr?: string): { label: string; isOverdue: boolean; isPriority: boolean } {
  if (!dateStr) return { label: "No due date", isOverdue: false, isPriority: false }

  const date = parseISO(dateStr)
  const today = new Date()
  today.setHours(0, 0, 0, 0)

  if (isToday(date)) return { label: "Today", isOverdue: false, isPriority: true }
  if (isTomorrow(date)) return { label: "Tomorrow", isOverdue: false, isPriority: true }
  if (isPast(date)) return { label: format(date, "MMM d"), isOverdue: true, isPriority: true }

  const daysAway = differenceInDays(date, today)
  if (daysAway <= 7) return { label: format(date, "EEE, MMM d"), isOverdue: false, isPriority: true }

  return { label: format(date, "MMM d"), isOverdue: false, isPriority: false }
}

function getChecklistProgress(checklist?: TaskChecklistItem[]): { completed: number; total: number; percent: number } {
  if (!checklist?.length) return { completed: 0, total: 0, percent: 0 }
  const completed = checklist.filter((item) => item.completed).length
  return { completed, total: checklist.length, percent: Math.round((completed / checklist.length) * 100) }
}

// Linear-style status glyph: empty ring for to-do, a half-filled pie for in
// progress, a slashed circle for blocked, and a green check when done.
function StatusCircle({ status, className }: { status: TaskStatus; className?: string }) {
  if (status === "done") return <CheckCircle2 className={cn("size-4 text-emerald-600 dark:text-emerald-400", className)} />
  if (status === "blocked") return <Ban className={cn("size-4 text-destructive", className)} />

  const fraction = status === "in_progress" ? 0.5 : 0
  const color = status === "in_progress" ? "text-blue-500" : "text-muted-foreground"
  const pieR = 2.5
  const circ = 2 * Math.PI * pieR
  return (
    <svg viewBox="0 0 16 16" fill="none" className={cn("size-4", color, className)} aria-hidden>
      <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="1.5" />
      {fraction > 0 && (
        <circle
          cx="8"
          cy="8"
          r={pieR}
          stroke="currentColor"
          strokeWidth={pieR * 2}
          strokeDasharray={`${circ * fraction} ${circ}`}
          transform="rotate(-90 8 8)"
        />
      )}
    </svg>
  )
}

function StatusMenu({
  status,
  onChange,
  children,
}: {
  status: TaskStatus
  onChange: (status: TaskStatus) => void
  children: React.ReactNode
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>{children}</DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-44">
        {STATUS_ORDER.map((item) => (
          <DropdownMenuItem key={item} onSelect={() => onChange(item)} className="gap-2">
            <StatusCircle status={item} />
            {STATUS_CONFIG[item].label}
            {item === status && <Check className="ml-auto size-3.5" />}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

// ============================================
// MAIN COMPONENT
// ============================================

export function TasksTab({
  tasks: initialTasks,
  projects,
  initialProjectFilter,
  team,
  onTaskCreate,
  onTaskUpdate,
  onTaskDelete,
}: TasksTabProps) {
  const [tasks, setTasks] = useState<Task[]>(initialTasks)
  const [searchQuery, setSearchQuery] = useState("")
  const [priorityFilter, setPriorityFilter] = useState<TaskPriority | "all">("all")
  const [assigneeFilter, setAssigneeFilter] = useState<string | "all">("all")
  const [projectFilter, setProjectFilter] = useState<string | "all">(initialProjectFilter ?? "all")
  const [tradeFilter, setTradeFilter] = useState<TaskTrade | "all">("all")
  const [collapsedStatuses, setCollapsedStatuses] = useState<TaskStatus[]>(["done"])

  const [createOpen, setCreateOpen] = useState(false)
  const [detailOpen, setDetailOpen] = useState(false)
  const [selectedTask, setSelectedTask] = useState<Task | null>(null)
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false)
  const [taskToDelete, setTaskToDelete] = useState<Task | null>(null)
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [assignableResources, setAssignableResources] = useState<AssignableResource[]>([])

  useEffect(() => {
    setTasks(initialTasks)
  }, [initialTasks])

  useEffect(() => {
    listOrgAssignableResourcesAction()
      .then((res) => setAssignableResources(res))
      .catch((err) => console.error("Failed to load assignable resources", err))
  }, [])

  // ============================================
  // COMPUTED VALUES
  // ============================================

  const filteredTasks = useMemo(() => {
    const query = searchQuery.trim().toLowerCase()
    return tasks.filter((task) => {
      if (query) {
        const matches =
          task.title.toLowerCase().includes(query) ||
          task.description?.toLowerCase().includes(query) ||
          task.location?.toLowerCase().includes(query)
        if (!matches) return false
      }
      if (priorityFilter !== "all" && task.priority !== priorityFilter) return false
      if (assigneeFilter !== "all") {
        const value = taskAssigneeValue(task)
        if (assigneeFilter === "unassigned" && value !== "unassigned") return false
        if (assigneeFilter !== "unassigned" && assigneeFilter !== value) return false
      }
      if (tradeFilter !== "all" && task.trade !== tradeFilter) return false
      if (projectFilter !== "all") {
        if (projectFilter === NO_PROJECT && task.project_id) return false
        if (projectFilter !== NO_PROJECT && task.project_id !== projectFilter) return false
      }
      return true
    })
  }, [tasks, searchQuery, priorityFilter, assigneeFilter, tradeFilter, projectFilter])

  const grouped = useMemo(() => {
    return STATUS_SECTION_ORDER.map((status) => ({
      status,
      tasks: filteredTasks
        .filter((task) => task.status === status)
        .sort((a, b) => PRIORITY_ORDER.indexOf(a.priority) - PRIORITY_ORDER.indexOf(b.priority)),
    })).filter((group) => group.tasks.length > 0)
  }, [filteredTasks])

  const assignableUsers = useMemo(
    () => assignableResources.filter((r) => r.type === "user"),
    [assignableResources],
  )
  const assignableContacts = useMemo(
    () => assignableResources.filter((r) => r.type === "contact"),
    [assignableResources],
  )

  const activeFilterCount = useMemo(() => {
    let count = 0
    if (priorityFilter !== "all") count++
    if (assigneeFilter !== "all") count++
    if (tradeFilter !== "all") count++
    if (projectFilter !== "all") count++
    return count
  }, [priorityFilter, assigneeFilter, tradeFilter, projectFilter])

  const projectName = (id: string | null | undefined) =>
    id ? projects.find((p) => p.id === id)?.name : undefined

  const defaultCreateProjectId =
    projectFilter !== "all" && projectFilter !== NO_PROJECT && projects.some((p) => p.id === projectFilter)
      ? projectFilter
      : undefined

  // ============================================
  // HANDLERS
  // ============================================

  const handleCreateTask = async (values: {
    title: string
    description?: string
    project_id?: string
    reminder_at?: string
  }) => {
    setIsSubmitting(true)
    try {
      const created = await onTaskCreate({
        title: values.title,
        description: values.description,
        project_id: values.project_id,
        reminder_at: values.reminder_at,
        status: "todo",
        priority: "normal",
      })
      setTasks((prev) => [created, ...prev])
      setCreateOpen(false)
      toast.success("Task created", { description: created.title })
    } catch (error) {
      console.error(error)
      toast.error("Failed to create task")
    } finally {
      setIsSubmitting(false)
    }
  }

  const handleUpdateTask = async (taskId: string, updates: Partial<TaskInput>) => {
    try {
      const updated = await onTaskUpdate(taskId, updates)
      setTasks((prev) => prev.map((t) => (t.id === taskId ? updated : t)))
      if (selectedTask?.id === taskId) setSelectedTask(updated)
      return updated
    } catch (error) {
      console.error(error)
      toast.error("Failed to update task")
      throw error
    }
  }

  const handleQuickStatusChange = async (task: Task, newStatus: TaskStatus) => {
    if (task.status === newStatus) return
    const previous = task.status
    setTasks((prev) => prev.map((t) => (t.id === task.id ? { ...t, status: newStatus } : t)))
    if (selectedTask?.id === task.id) setSelectedTask({ ...selectedTask, status: newStatus })
    try {
      await onTaskUpdate(task.id, { status: newStatus })
      if (newStatus === "done") toast.success("Task completed", { description: task.title })
    } catch (error) {
      console.error(error)
      setTasks((prev) => prev.map((t) => (t.id === task.id ? { ...t, status: previous } : t)))
      if (selectedTask?.id === task.id) setSelectedTask({ ...selectedTask, status: previous })
      toast.error("Failed to update task")
    }
  }

  const handleDeleteTask = async () => {
    if (!taskToDelete) return
    setIsSubmitting(true)
    try {
      await onTaskDelete(taskToDelete.id)
      setTasks((prev) => prev.filter((t) => t.id !== taskToDelete.id))
      setDeleteDialogOpen(false)
      if (selectedTask?.id === taskToDelete.id) {
        setDetailOpen(false)
        setSelectedTask(null)
      }
      setTaskToDelete(null)
      toast.success("Task deleted")
    } catch (error) {
      console.error(error)
      toast.error("Failed to delete task")
    } finally {
      setIsSubmitting(false)
    }
  }

  const openTaskDetail = (task: Task) => {
    setSelectedTask(task)
    setDetailOpen(true)
  }

  const clearFilters = () => {
    setPriorityFilter("all")
    setAssigneeFilter("all")
    setTradeFilter("all")
    setProjectFilter("all")
  }

  const toggleStatusCollapsed = (status: TaskStatus) => {
    setCollapsedStatuses((current) =>
      current.includes(status) ? current.filter((item) => item !== status) : [...current, status],
    )
  }

  const hasFiltersActive = activeFilterCount > 0 || searchQuery.trim().length > 0

  // ============================================
  // RENDER
  // ============================================

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden bg-background text-foreground">
      {/* Toolbar */}
      <div className="shrink-0 border-b bg-background/95 px-3 py-2 backdrop-blur">
        <div className="flex items-center gap-2">
          <div className="relative w-[220px]">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={searchQuery}
              onChange={(event) => setSearchQuery(event.target.value)}
              placeholder="Search tasks"
              className="h-8 pl-8 text-sm"
            />
          </div>

          <Popover>
            <PopoverTrigger asChild>
              <Button variant="outline" size="sm" className="h-8">
                <SlidersHorizontal className="size-4" />
                Filter
                {activeFilterCount > 0 && (
                  <Badge className="ml-1 h-4 min-w-4 justify-center rounded-none px-1 text-[10px] tabular-nums">
                    {activeFilterCount}
                  </Badge>
                )}
              </Button>
            </PopoverTrigger>
            <PopoverContent align="start" className="w-64 space-y-3 p-3">
              <div className="flex items-center justify-between">
                <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Filters</p>
                {activeFilterCount > 0 && (
                  <button
                    type="button"
                    onClick={clearFilters}
                    className="text-xs text-muted-foreground hover:text-foreground"
                  >
                    Clear all
                  </button>
                )}
              </div>

              <div className="space-y-1.5">
                <p className="text-xs text-muted-foreground">Priority</p>
                <Select value={priorityFilter} onValueChange={(value) => setPriorityFilter(value as TaskPriority | "all")}>
                  <SelectTrigger size="sm" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All priorities</SelectItem>
                    {PRIORITY_ORDER.map((priority) => (
                      <SelectItem key={priority} value={priority}>
                        <span className={cn("size-2 rounded-none", PRIORITY_CONFIG[priority].dotColor)} />
                        {PRIORITY_CONFIG[priority].label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-1.5">
                <p className="text-xs text-muted-foreground">Assignee</p>
                <Select value={assigneeFilter} onValueChange={setAssigneeFilter}>
                  <SelectTrigger size="sm" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All assignees</SelectItem>
                    <SelectItem value="unassigned">Unassigned</SelectItem>
                    {assignableUsers.length > 0 && (
                      <SelectGroup>
                        <SelectLabel>Team</SelectLabel>
                        {assignableUsers.map((member) => (
                          <SelectItem key={member.id} value={encodeAssignee("user", member.id)}>
                            {member.name}
                          </SelectItem>
                        ))}
                      </SelectGroup>
                    )}
                    {assignableContacts.length > 0 && (
                      <SelectGroup>
                        <SelectLabel>Contacts</SelectLabel>
                        {assignableContacts.map((contact) => (
                          <SelectItem key={contact.id} value={encodeAssignee("contact", contact.id)}>
                            {contact.name}
                          </SelectItem>
                        ))}
                      </SelectGroup>
                    )}
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-1.5">
                <p className="text-xs text-muted-foreground">Trade</p>
                <Select value={tradeFilter} onValueChange={(value) => setTradeFilter(value as TaskTrade | "all")}>
                  <SelectTrigger size="sm" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All trades</SelectItem>
                    {Object.entries(TRADE_CONFIG).map(([trade, config]) => (
                      <SelectItem key={trade} value={trade}>
                        <span className={cn("size-2 rounded-none", config.color)} />
                        {config.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              {projects.length > 0 && (
                <div className="space-y-1.5">
                  <p className="text-xs text-muted-foreground">Project</p>
                  <Select value={projectFilter} onValueChange={setProjectFilter}>
                    <SelectTrigger size="sm" className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">All projects</SelectItem>
                      <SelectItem value={NO_PROJECT}>Personal (no project)</SelectItem>
                      <SelectGroup>
                        <SelectLabel>Projects</SelectLabel>
                        {projects.map((project) => (
                          <SelectItem key={project.id} value={project.id}>
                            {project.name}
                          </SelectItem>
                        ))}
                      </SelectGroup>
                    </SelectContent>
                  </Select>
                </div>
              )}
            </PopoverContent>
          </Popover>

          <div className="flex-1" />

          <Button size="sm" className="h-8" onClick={() => setCreateOpen(true)}>
            <Plus className="size-4" />
            Add task
          </Button>
        </div>
      </div>

      {/* Grouped list */}
      <div className="min-h-0 flex-1 overflow-auto">
        {grouped.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center px-6 text-center">
            <div className="flex size-12 items-center justify-center rounded-none bg-muted">
              <CheckCircle2 className="size-6 text-muted-foreground" />
            </div>
            <p className="mt-4 text-sm font-medium">
              {hasFiltersActive ? "No tasks match these filters" : "No tasks yet"}
            </p>
            <p className="mt-1 max-w-sm text-sm text-muted-foreground">
              {hasFiltersActive ? (
                <button type="button" onClick={clearFilters} className="underline underline-offset-2 hover:text-foreground">
                  Clear filters
                </button>
              ) : (
                "Add your first task to start tracking your work across projects."
              )}
            </p>
          </div>
        ) : (
          grouped.map((group) => {
            const isCollapsed = collapsedStatuses.includes(group.status)
            return (
              <section key={group.status} className="border-b">
                <button
                  type="button"
                  onClick={() => toggleStatusCollapsed(group.status)}
                  className="sticky top-0 z-10 flex h-10 w-full items-center justify-between border-b bg-muted/40 px-4 text-left backdrop-blur transition-colors hover:bg-muted/60"
                  aria-expanded={!isCollapsed}
                >
                  <div className="flex items-center gap-2 text-sm font-medium">
                    <ChevronDown className={cn("size-4 text-muted-foreground transition-transform", isCollapsed && "-rotate-90")} />
                    <StatusCircle status={group.status} />
                    {STATUS_CONFIG[group.status].label}
                    <span className="text-muted-foreground">{group.tasks.length}</span>
                  </div>
                </button>
                {!isCollapsed && (
                  <div>
                    {group.tasks.map((task) => {
                      // Prefer the self-reminder date; fall back to a legacy due date.
                      const dateStr = task.reminder_at ?? task.due_date
                      const dateInfo = formatDueDate(dateStr ?? undefined)
                      const isReminder = Boolean(task.reminder_at)
                      const project = task.project_name ?? projectName(task.project_id)
                      return (
                        <div
                          key={task.id}
                          className={cn(
                            "group flex min-h-12 w-full items-center gap-3 border-b px-4 text-sm transition-colors last:border-b-0 hover:bg-accent/45",
                            selectedTask?.id === task.id && detailOpen && "bg-accent/70",
                          )}
                        >
                          <StatusMenu status={task.status} onChange={(value) => handleQuickStatusChange(task, value)}>
                            <button
                              type="button"
                              onClick={(event) => event.stopPropagation()}
                              className="flex size-6 shrink-0 items-center justify-center rounded-none hover:bg-accent"
                              aria-label={`Status: ${STATUS_CONFIG[task.status].label}`}
                            >
                              <StatusCircle status={task.status} />
                            </button>
                          </StatusMenu>

                          <button
                            type="button"
                            onClick={() => openTaskDetail(task)}
                            className="flex min-w-0 flex-1 items-center gap-2 text-left"
                          >
                            <span className={cn("truncate font-medium", task.status === "done" && "text-muted-foreground line-through")}>
                              {task.title}
                            </span>
                            <span className={cn("flex shrink-0 items-center gap-1.5 text-xs font-medium", PRIORITY_CONFIG[task.priority].color)}>
                              <span className={cn("size-2 shrink-0 rounded-none", PRIORITY_CONFIG[task.priority].dotColor)} />
                              {PRIORITY_CONFIG[task.priority].label}
                            </span>
                          </button>

                          <button
                            type="button"
                            onClick={() => openTaskDetail(task)}
                            className="flex shrink-0 items-center gap-3 text-xs text-muted-foreground"
                          >
                            <span className="hidden max-w-36 items-center gap-1 truncate md:flex">
                              <MapPin className="size-3 shrink-0" />
                              {project ?? "Personal"}
                            </span>
                            {task.assignee || task.assignee_contact || task.assignee_company ? (
                              <Avatar className="size-5 rounded-none">
                                <AvatarImage src={task.assignee?.avatar_url} />
                                <AvatarFallback className="rounded-none text-[9px]">
                                  {getInitials(taskAssigneeName(task) ?? "A")}
                                </AvatarFallback>
                              </Avatar>
                            ) : (
                              <User className="size-4" />
                            )}
                            {dateStr && (
                              <span
                                className={cn(
                                  "flex items-center gap-1 tabular-nums",
                                  dateInfo.isOverdue
                                    ? "text-destructive"
                                    : dateInfo.isPriority
                                      ? "text-amber-600 dark:text-amber-400"
                                      : "text-muted-foreground",
                                )}
                                title={isReminder ? "Reminder" : "Due date"}
                              >
                                {isReminder ? <Bell className="size-3 shrink-0" /> : <CalendarDays className="size-3 shrink-0" />}
                                {dateInfo.label}
                              </span>
                            )}
                          </button>

                          <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                              <button
                                type="button"
                                onClick={(event) => event.stopPropagation()}
                                className="flex size-6 shrink-0 items-center justify-center rounded-none text-muted-foreground opacity-0 transition-opacity hover:bg-accent hover:text-foreground group-hover:opacity-100 data-[state=open]:opacity-100"
                                aria-label="Task actions"
                              >
                                <MoreHorizontal className="size-4" />
                              </button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="end" className="w-40">
                              <DropdownMenuItem onSelect={() => openTaskDetail(task)}>
                                <Edit className="size-4" />
                                Open
                              </DropdownMenuItem>
                              <DropdownMenuSeparator />
                              <DropdownMenuItem
                                variant="destructive"
                                onSelect={() => {
                                  setTaskToDelete(task)
                                  setDeleteDialogOpen(true)
                                }}
                              >
                                <Trash2 className="size-4" />
                                Delete
                              </DropdownMenuItem>
                            </DropdownMenuContent>
                          </DropdownMenu>
                        </div>
                      )
                    })}
                  </div>
                )}
              </section>
            )
          })
        )}
      </div>

      {/* Create Task Dialog */}
      <CreateTaskDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        projects={projects}
        defaultProjectId={defaultCreateProjectId}
        onCreate={handleCreateTask}
        isSubmitting={isSubmitting}
      />

      {/* Task Detail Sheet */}
      {selectedTask && (
        <TaskDetailSheet
          open={detailOpen}
          onOpenChange={setDetailOpen}
          task={selectedTask}
          team={team}
          projects={projects}
          onUpdate={handleUpdateTask}
          onDelete={() => {
            setTaskToDelete(selectedTask)
            setDeleteDialogOpen(true)
          }}
        />
      )}

      {/* Delete Confirmation Dialog */}
      <AlertDialog open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete task</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to delete &ldquo;{taskToDelete?.title}&rdquo;? This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDeleteTask}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {isSubmitting ? "Deleting..." : "Delete"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

// ============================================
// CREATE TASK DIALOG
// ============================================

interface CreateTaskDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  projects: TaskProjectOption[]
  defaultProjectId?: string
  onCreate: (values: { title: string; description?: string; project_id?: string; reminder_at?: string }) => void
  isSubmitting: boolean
}

function CreateTaskDialog({ open, onOpenChange, projects, defaultProjectId, onCreate, isSubmitting }: CreateTaskDialogProps) {
  const [title, setTitle] = useState("")
  const [description, setDescription] = useState("")
  const [projectId, setProjectId] = useState<string>(defaultProjectId ?? NO_PROJECT)
  const [reminderAt, setReminderAt] = useState<Date | undefined>()

  // Reset the composer each time it opens so it stays a fast capture surface.
  useEffect(() => {
    if (open) {
      setTitle("")
      setDescription("")
      setProjectId(defaultProjectId ?? NO_PROJECT)
      setReminderAt(undefined)
    }
  }, [open, defaultProjectId])

  const submit = () => {
    if (!title.trim() || isSubmitting) return
    onCreate({
      title: title.trim(),
      description: description.trim() || undefined,
      project_id: projectId === NO_PROJECT ? undefined : projectId,
      reminder_at: reminderAt ? reminderAt.toISOString() : undefined,
    })
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent showCloseButton={false} className="overflow-hidden p-0 sm:max-w-2xl">
        <form
          onSubmit={(event) => {
            event.preventDefault()
            submit()
          }}
          onKeyDown={(event) => {
            if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
              event.preventDefault()
              submit()
            }
          }}
          className="flex flex-col"
        >
          <DialogHeader className="space-y-0 px-5 pt-5">
            <DialogTitle className="sr-only">New task</DialogTitle>
            <DialogDescription className="sr-only">
              Capture a task with a title, an optional description, whether it&rsquo;s personal or tied to a project, and a due date.
            </DialogDescription>
            <Input
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              placeholder="Task name"
              required
              autoFocus
              className="h-auto border-0 px-0 py-0 text-2xl font-semibold shadow-none focus-visible:ring-0 md:text-2xl"
            />
          </DialogHeader>

          <div className="px-5 pb-2 pt-2">
            <Textarea
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              placeholder="Add a description…"
              className="min-h-24 resize-none border-0 px-0 text-sm shadow-none focus-visible:ring-0"
            />

            <div className="mt-2 flex flex-wrap items-center gap-2">
              <Select value={projectId} onValueChange={setProjectId}>
                <SelectTrigger className="w-fit justify-start rounded-none bg-muted/50 px-3">
                  <FolderOpen className="size-4" />
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NO_PROJECT}>Personal task</SelectItem>
                  {projects.length > 0 && (
                    <SelectGroup>
                      <SelectLabel>Projects</SelectLabel>
                      {projects.map((project) => (
                        <SelectItem key={project.id} value={project.id}>
                          {project.name}
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  )}
                </SelectContent>
              </Select>

              <ReminderPicker
                value={reminderAt}
                onChange={setReminderAt}
                triggerClassName="w-fit justify-start rounded-none bg-muted/50 px-3"
                placeholder="Reminder"
              />
            </div>
          </div>

          <DialogFooter className="items-center justify-end border-t px-5 py-3">
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={isSubmitting || !title.trim()} className="gap-2">
              {isSubmitting ? "Creating…" : "Create task"}
              <kbd className="inline-flex items-center rounded-none border border-primary-foreground/40 px-1.5 py-0.5 text-xs font-medium text-primary-foreground">
                ⌘↵
              </kbd>
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

// ============================================
// REMINDER PICKER (date + time)
// ============================================

interface ReminderPickerProps {
  value?: Date
  onChange: (date: Date | undefined) => void
  triggerClassName?: string
  placeholder?: string
}

// Date + time-of-day picker for a self-reminder. Time defaults to 9:00 AM when a
// day is chosen without one; picking a time before a day uses today. Values are
// plain Date objects (local time); callers serialize with toISOString().
function ReminderPicker({ value, onChange, triggerClassName, placeholder = "Reminder" }: ReminderPickerProps) {
  const timeValue = value ? format(value, "HH:mm") : "09:00"

  const handleDaySelect = (day: Date | undefined) => {
    if (!day) {
      onChange(undefined)
      return
    }
    const [hours, minutes] = timeValue.split(":").map(Number)
    const next = new Date(day)
    next.setHours(hours ?? 9, minutes ?? 0, 0, 0)
    onChange(next)
  }

  const handleTimeChange = (time: string) => {
    if (!time) return
    const [hours, minutes] = time.split(":").map(Number)
    const base = value ? new Date(value) : new Date()
    base.setHours(hours ?? 0, minutes ?? 0, 0, 0)
    onChange(base)
  }

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button type="button" variant="outline" size="sm" className={triggerClassName}>
          <Bell className="size-4" />
          {value ? format(value, "MMM d, p") : <span className="text-muted-foreground">{placeholder}</span>}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-auto p-0">
        <Calendar mode="single" selected={value} onSelect={handleDaySelect} autoFocus />
        <div className="flex items-center justify-between gap-3 border-t p-3">
          <label className="flex items-center gap-2 text-sm">
            <Clock className="size-4 text-muted-foreground" />
            <input
              type="time"
              value={timeValue}
              onChange={(event) => handleTimeChange(event.target.value)}
              className="h-8 rounded-none border bg-background px-2 text-sm [color-scheme:light] dark:[color-scheme:dark]"
              aria-label="Reminder time"
            />
          </label>
          {value && (
            <button
              type="button"
              onClick={() => onChange(undefined)}
              className="text-xs text-muted-foreground hover:text-foreground"
            >
              Clear
            </button>
          )}
        </div>
      </PopoverContent>
    </Popover>
  )
}

// ============================================
// TASK DETAIL SHEET
// ============================================

interface TaskDetailSheetProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  task: Task
  team: TasksTabProps["team"]
  projects: TaskProjectOption[]
  onUpdate: (taskId: string, updates: Partial<TaskInput>) => Promise<Task>
  onDelete: () => void
}

function TaskDetailSheet({ open, onOpenChange, task, team, projects, onUpdate, onDelete }: TaskDetailSheetProps) {
  const [attachments, setAttachments] = useState<AttachedFile[]>([])
  const [attachmentsLoading, setAttachmentsLoading] = useState(false)
  const [isEditing, setIsEditing] = useState(false)
  const [editTitle, setEditTitle] = useState(task.title)
  const [editDescription, setEditDescription] = useState(task.description ?? "")
  const [newChecklistItem, setNewChecklistItem] = useState("")
  const [isSaving, setIsSaving] = useState(false)

  const checklistProgress = getChecklistProgress(task.checklist)

  const handleSaveBasicInfo = async () => {
    setIsSaving(true)
    try {
      await onUpdate(task.id, {
        title: editTitle,
        description: editDescription,
      })
      setIsEditing(false)
    } catch {
      // Error handled by parent
    } finally {
      setIsSaving(false)
    }
  }

  const handleChecklistToggle = async (itemId: string, completed: boolean) => {
    const updatedChecklist = (task.checklist ?? []).map((item) =>
      item.id === itemId
        ? { ...item, completed, completed_at: completed ? new Date().toISOString() : undefined }
        : item
    )
    await onUpdate(task.id, { checklist: updatedChecklist })
  }

  const handleAddChecklistItem = async () => {
    if (!newChecklistItem.trim()) return
    const updatedChecklist = [
      ...(task.checklist ?? []),
      { id: crypto.randomUUID(), text: newChecklistItem.trim(), completed: false },
    ]
    await onUpdate(task.id, { checklist: updatedChecklist })
    setNewChecklistItem("")
  }

  const handleRemoveChecklistItem = async (itemId: string) => {
    const updatedChecklist = (task.checklist ?? []).filter((item) => item.id !== itemId)
    await onUpdate(task.id, { checklist: updatedChecklist })
  }

  useEffect(() => {
    if (!open) return
    setAttachmentsLoading(true)
    listAttachmentsAction("task", task.id)
      .then((links) =>
        setAttachments(
          links.map((link) => ({
            id: link.file.id,
            linkId: link.id,
            file_name: link.file.file_name,
            mime_type: link.file.mime_type,
            size_bytes: link.file.size_bytes,
            download_url: link.file.download_url,
            thumbnail_url: link.file.thumbnail_url,
            created_at: link.created_at,
            link_role: link.link_role,
          }))
        )
      )
      .catch((error) => console.error("Failed to load task attachments", error))
      .finally(() => setAttachmentsLoading(false))
  }, [open, task.id])

  const handleAttach = async (files: File[], linkRole?: string) => {
    for (const file of files) {
      const formData = new FormData()
      formData.append("file", file)
      if (task.project_id) {
        formData.append("projectId", task.project_id)
      }
      formData.append("category", "other")

      const uploaded = unwrapAction(await uploadFileAction(formData))
      unwrapAction(await attachFileAction(uploaded.id, "task", task.id, task.project_id ?? undefined, linkRole))
    }

    const links = await listAttachmentsAction("task", task.id)
    setAttachments(
      links.map((link) => ({
        id: link.file.id,
        linkId: link.id,
        file_name: link.file.file_name,
        mime_type: link.file.mime_type,
        size_bytes: link.file.size_bytes,
        download_url: link.file.download_url,
        thumbnail_url: link.file.thumbnail_url,
        created_at: link.created_at,
        link_role: link.link_role,
      }))
    )
  }

  const handleDetach = async (linkId: string) => {
    unwrapAction(await detachFileLinkAction(linkId))
    const links = await listAttachmentsAction("task", task.id)
    setAttachments(
      links.map((link) => ({
        id: link.file.id,
        linkId: link.id,
        file_name: link.file.file_name,
        mime_type: link.file.mime_type,
        size_bytes: link.file.size_bytes,
        download_url: link.file.download_url,
        thumbnail_url: link.file.thumbnail_url,
        created_at: link.created_at,
        link_role: link.link_role,
      }))
    )
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        mobileFullscreen
        className="sm:max-w-xl sm:ml-auto sm:mr-4 sm:mt-4 sm:h-[calc(100vh-2rem)] shadow-2xl flex flex-col p-0 fast-sheet-animation"
        style={
          {
            animationDuration: "150ms",
            transitionDuration: "150ms",
          } satisfies CSSProperties
        }
      >
        {/* Header */}
        <div className="flex items-start justify-between gap-4 p-6 border-b bg-muted/30">
          <div className="flex-1 space-y-1">
            {isEditing ? (
              <Input
                value={editTitle}
                onChange={(e) => setEditTitle(e.target.value)}
                className="text-lg font-semibold h-auto py-1"
                autoFocus
              />
            ) : (
              <h2
                className={cn(
                  "text-lg font-semibold",
                  task.status === "done" && "line-through text-muted-foreground"
                )}
              >
                {task.title}
              </h2>
            )}
            <div className="flex items-center gap-2 flex-wrap">
              <Badge
                variant="secondary"
                className={cn(STATUS_CONFIG[task.status].bgColor, STATUS_CONFIG[task.status].color)}
              >
                <StatusCircle status={task.status} className="size-3.5" />
                <span className="ml-1">{STATUS_CONFIG[task.status].label}</span>
              </Badge>
              <Badge variant="outline" className={PRIORITY_CONFIG[task.priority].color}>
                <span className={cn("h-2 w-2 rounded-none mr-1.5", PRIORITY_CONFIG[task.priority].dotColor)} />
                {PRIORITY_CONFIG[task.priority].label}
              </Badge>
              {task.trade && (
                <Badge variant="outline">
                  <Wrench className="h-3 w-3 mr-1" />
                  {TRADE_CONFIG[task.trade as TaskTrade]?.label ?? task.trade}
                </Badge>
              )}
            </div>
          </div>

          <div className="flex items-center gap-1">
            {isEditing ? (
              <>
                <Button size="sm" variant="outline" onClick={() => setIsEditing(false)}>
                  Cancel
                </Button>
                <Button size="sm" onClick={handleSaveBasicInfo} disabled={isSaving}>
                  {isSaving ? "Saving..." : "Save"}
                </Button>
              </>
            ) : (
              <>
                <Button size="icon" variant="ghost" onClick={() => setIsEditing(true)}>
                  <Edit className="h-4 w-4" />
                </Button>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button size="icon" variant="ghost">
                      <MoreHorizontal className="h-4 w-4" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem className="text-destructive" onClick={onDelete}>
                      <Trash2 className="mr-2 h-4 w-4" />
                      Delete Task
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </>
            )}
          </div>
        </div>

        <ScrollArea className="flex-1">
          <div className="p-6 space-y-6">
            {/* Quick Actions */}
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <h4 className="text-sm font-medium text-muted-foreground">Quick updates</h4>
                <Badge variant="secondary" className="text-[11px]">Status, priority, owner</Badge>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <Select
                  value={task.status}
                  onValueChange={(value) => onUpdate(task.id, { status: value as TaskStatus })}
                >
                  <SelectTrigger className="w-full h-9">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {STATUS_ORDER.map((status) => (
                      <SelectItem key={status} value={status}>
                        <StatusCircle status={status} className="size-3.5" />
                        {STATUS_CONFIG[status].label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>

                <Select
                  value={task.priority}
                  onValueChange={(value) => onUpdate(task.id, { priority: value as TaskPriority })}
                >
                  <SelectTrigger className="w-full h-9">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {PRIORITY_ORDER.map((priority) => (
                      <SelectItem key={priority} value={priority}>
                        <span className={cn("h-2 w-2 rounded-none", PRIORITY_CONFIG[priority].dotColor)} />
                        {PRIORITY_CONFIG[priority].label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>

                <Select
                  value={task.assignee_kind === "user" ? task.assignee_id ?? "unassigned" : "unassigned"}
                  onValueChange={(value) =>
                    onUpdate(
                      task.id,
                      value === "unassigned"
                        ? { assignee_id: undefined, assignee_kind: undefined }
                        : { assignee_id: value, assignee_kind: "user" },
                    )
                  }
                >
                  <SelectTrigger className="w-full h-9">
                    <SelectValue placeholder="Unassigned" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="unassigned">Unassigned</SelectItem>
                    {(team ?? []).map((member) => (
                      <SelectItem key={member.user_id} value={member.user_id}>
                        <div className="flex items-center gap-2">
                          <Avatar className="h-5 w-5">
                            <AvatarImage src={member.avatar_url} />
                            <AvatarFallback className="text-[10px]">
                              {getInitials(member.full_name)}
                            </AvatarFallback>
                          </Avatar>
                          {member.full_name}
                        </div>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>

                <Select
                  value={task.project_id ?? NO_PROJECT}
                  onValueChange={(value) =>
                    onUpdate(task.id, { project_id: value === NO_PROJECT ? undefined : value })
                  }
                >
                  <SelectTrigger className="w-full h-9">
                    <SelectValue placeholder="Personal" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={NO_PROJECT}>Personal (no project)</SelectItem>
                    {projects.map((project) => (
                      <SelectItem key={project.id} value={project.id}>
                        {project.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>

            {/* Description */}
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <h4 className="text-sm font-medium text-muted-foreground">Description</h4>
                <Badge variant="outline" className="text-[11px]">Context</Badge>
              </div>
              {isEditing ? (
                <Textarea
                  value={editDescription}
                  onChange={(e) => setEditDescription(e.target.value)}
                  placeholder="Add a description..."
                  className="min-h-[100px]"
                />
              ) : (
                <p className="text-sm text-muted-foreground">
                  {task.description || "No description added."}
                </p>
              )}
            </div>

            <Separator />

            {/* Details Grid */}
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <h4 className="text-sm font-medium text-muted-foreground">Details</h4>
                <Badge variant="secondary" className="text-[11px]">Dates, trade, hours</Badge>
              </div>
              <div className="grid grid-cols-2 gap-4">
              <div className="space-y-1">
                <p className="text-xs font-medium text-muted-foreground">Reminder</p>
                <ReminderPicker
                  value={task.reminder_at ? parseISO(task.reminder_at) : undefined}
                  onChange={(date) => onUpdate(task.id, { reminder_at: date ? date.toISOString() : "" })}
                  triggerClassName="h-8 justify-start gap-1.5 px-2 font-normal"
                  placeholder="Set reminder"
                />
                {task.reminder_at && (
                  <p className="text-xs text-muted-foreground">
                    {task.reminder_sent_at
                      ? `Emailed ${format(parseISO(task.reminder_sent_at), "MMM d 'at' p")}`
                      : task.status === "done"
                        ? "Task done — no email will be sent"
                        : `We'll email you ${format(parseISO(task.reminder_at), "MMM d 'at' p")}`}
                  </p>
                )}
              </div>

              <div className="space-y-1">
                <p className="text-xs font-medium text-muted-foreground">Assignee</p>
                {task.assignee || task.assignee_contact || task.assignee_company ? (
                  <div className="flex items-center gap-2">
                    <Avatar className="h-6 w-6">
                      <AvatarImage src={task.assignee?.avatar_url} />
                      <AvatarFallback className="text-[10px]">
                        {getInitials(taskAssigneeName(task) ?? "A")}
                      </AvatarFallback>
                    </Avatar>
                    <div className="flex flex-col">
                      <span className="text-sm">{taskAssigneeName(task)}</span>
                      {task.assignee_company && (
                        <span className="text-xs text-muted-foreground">{task.assignee_company.name}</span>
                      )}
                      {task.assignee_contact?.company_name && (
                        <span className="text-xs text-muted-foreground">{task.assignee_contact.company_name}</span>
                      )}
                    </div>
                  </div>
                ) : (
                  <p className="text-sm text-muted-foreground">Unassigned</p>
                )}
              </div>

              {task.location && (
                <div className="space-y-1">
                  <p className="text-xs font-medium text-muted-foreground">Location</p>
                  <p className="text-sm flex items-center gap-1.5">
                    <MapPin className="h-4 w-4" />
                    {task.location}
                  </p>
                </div>
              )}

              {task.trade && (
                <div className="space-y-1">
                  <p className="text-xs font-medium text-muted-foreground">Trade</p>
                  <p className="text-sm flex items-center gap-1.5">
                    <Wrench className="h-4 w-4" />
                    {TRADE_CONFIG[task.trade as TaskTrade]?.label ?? task.trade}
                  </p>
                </div>
              )}

              {task.estimated_hours && (
                <div className="space-y-1">
                  <p className="text-xs font-medium text-muted-foreground">Estimated Hours</p>
                  <p className="text-sm flex items-center gap-1.5">
                    <Clock className="h-4 w-4" />
                    {task.estimated_hours}h
                  </p>
                </div>
              )}

              {task.actual_hours && (
                <div className="space-y-1">
                  <p className="text-xs font-medium text-muted-foreground">Actual Hours</p>
                  <p className="text-sm flex items-center gap-1.5">
                    <Timer className="h-4 w-4" />
                    {task.actual_hours}h
                  </p>
                </div>
              )}
              </div>
            </div>

            <Separator />

            {/* Attachments */}
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <h4 className="text-sm font-medium text-muted-foreground">Attachments</h4>
                <Badge variant="secondary" className="text-[11px]">Files</Badge>
              </div>
              <EntityAttachments
                entityType="task"
                entityId={task.id}
                projectId={task.project_id ?? undefined}
                attachments={attachments}
                onAttach={handleAttach}
                onDetach={handleDetach}
                compact
                readOnly={attachmentsLoading}
              />

              {task.project_id && (
                <LinkedDrawings
                  projectId={task.project_id}
                  entityType="task"
                  entityId={task.id}
                  title="Linked drawings"
                />
              )}
            </div>

            <Separator />

            {/* Checklist */}
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <h4 className="text-sm font-medium">Checklist</h4>
                {checklistProgress.total > 0 && (
                  <span className="text-xs text-muted-foreground">
                    {checklistProgress.completed}/{checklistProgress.total} completed
                  </span>
                )}
              </div>

              {checklistProgress.total > 0 && (
                <Progress value={checklistProgress.percent} className="h-2" />
              )}

              {/* Add new item */}
              <div className="flex gap-2">
                <Input
                  placeholder="Add checklist item..."
                  value={newChecklistItem}
                  onChange={(e) => setNewChecklistItem(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault()
                      handleAddChecklistItem()
                    }
                  }}
                />
                <Button variant="outline" onClick={handleAddChecklistItem}>
                  <Plus className="h-4 w-4" />
                </Button>
              </div>

              {/* Checklist items */}
              {(task.checklist ?? []).length > 0 && (
                <div className="space-y-1">
                  {task.checklist?.map((item) => (
                    <div
                      key={item.id}
                      className={cn(
                        "flex items-center gap-3 rounded-md px-3 py-2 group hover:bg-muted/50",
                        item.completed && "opacity-60"
                      )}
                    >
                      <Checkbox
                        checked={item.completed}
                        onCheckedChange={(checked) =>
                          handleChecklistToggle(item.id, checked as boolean)
                        }
                      />
                      <span
                        className={cn(
                          "flex-1 text-sm",
                          item.completed && "line-through text-muted-foreground"
                        )}
                      >
                        {item.text}
                      </span>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-6 w-6 opacity-0 group-hover:opacity-100 transition-opacity"
                        onClick={() => handleRemoveChecklistItem(item.id)}
                      >
                        <X className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  ))}
                </div>
              )}

              {(task.checklist ?? []).length === 0 && (
                <p className="text-sm text-muted-foreground text-center py-4">
                  No checklist items yet. Add one above.
                </p>
              )}
            </div>

            <Separator />

            {/* Activity / Metadata */}
            <div className="space-y-2">
              <h4 className="text-sm font-medium text-muted-foreground">Activity</h4>
              <div className="text-xs text-muted-foreground space-y-1 rounded-md border bg-muted/30 p-3">
                {task.created_by_name && (
                  <p>Created by {task.created_by_name}</p>
                )}
                <p>Created {format(parseISO(task.created_at), "MMM d, yyyy 'at' h:mm a")}</p>
                <p>Updated {format(parseISO(task.updated_at), "MMM d, yyyy 'at' h:mm a")}</p>
                {task.completed_at && (
                  <p className="text-emerald-600 dark:text-emerald-400">
                    Completed {format(parseISO(task.completed_at), "MMM d, yyyy 'at' h:mm a")}
                  </p>
                )}
              </div>
            </div>
          </div>
        </ScrollArea>

        <div className="flex-shrink-0 border-t bg-muted/30 px-6 py-4">
          <div className="flex gap-2">
            <Button variant="outline" className="flex-1" onClick={() => onOpenChange(false)}>
              Close
            </Button>
            <Button
              variant="destructive"
              className="flex-1"
              onClick={onDelete}
            >
              Delete
            </Button>
          </div>
        </div>
      </SheetContent>
    </Sheet>
  )
}
