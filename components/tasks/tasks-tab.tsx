"use client"

import { useState, useMemo, type CSSProperties } from "react"
import { format, parseISO, isPast, isToday, isTomorrow, differenceInDays } from "date-fns"
import { useForm } from "react-hook-form"
import { zodResolver } from "@hookform/resolvers/zod"
import { toast } from "sonner"
import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
  DragOverlay,
  type DragOverEvent,
} from "@dnd-kit/core"
import { useSortable, SortableContext, verticalListSortingStrategy } from "@dnd-kit/sortable"
import { useDroppable } from "@dnd-kit/core"
import { CSS } from "@dnd-kit/utilities"

import type { Task, TaskStatus, TaskPriority, TaskChecklistItem, TaskTrade } from "@/lib/types"
import { taskInputSchema, type TaskInput } from "@/lib/validation/tasks"
import { cn } from "@/lib/utils"

import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
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
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "@/components/ui/sheet"
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form"
import {
  Select,
  SelectContent,
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
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
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
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import {
  Plus,
  Search,
  MoreHorizontal,
  CalendarDays,
  Clock,
  AlertCircle,
  CheckCircle,
  CheckCircle2,
  Circle,
  Timer,
  Ban,
  ChevronRight,
  Filter,
  LayoutGrid,
  List,
  Calendar as CalendarIcon,
  MapPin,
  Wrench,
  Tag,
  User,
  ArrowUpRight,
  Trash2,
  Edit,
  Flag,
  Square,
  SquareCheck,
  X,
  GripVertical,
} from "@/components/icons"

// ============================================
// TYPES & CONSTANTS
// ============================================

interface TasksTabProps {
  projectId: string
  tasks: Task[]
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

type ViewMode = "board" | "list"
type GroupBy = "status" | "priority" | "assignee" | "trade" | "due_date"

const STATUS_CONFIG: Record<TaskStatus, { label: string; icon: React.ReactNode; color: string; bgColor: string }> = {
  todo: {
    label: "To Do",
    icon: <Circle className="h-4 w-4" />,
    color: "text-muted-foreground",
    bgColor: "bg-muted",
  },
  in_progress: {
    label: "In Progress",
    icon: <Timer className="h-4 w-4" />,
    color: "text-blue-600 dark:text-blue-400",
    bgColor: "bg-blue-500/10",
  },
  blocked: {
    label: "Blocked",
    icon: <Ban className="h-4 w-4" />,
    color: "text-destructive",
    bgColor: "bg-destructive/10",
  },
  done: {
    label: "Done",
    icon: <CheckCircle2 className="h-4 w-4" />,
    color: "text-emerald-600 dark:text-emerald-400",
    bgColor: "bg-emerald-500/10",
  },
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

// ============================================
// MAIN COMPONENT
// ============================================

export function TasksTab({
  projectId,
  tasks: initialTasks,
  team,
  onTaskCreate,
  onTaskUpdate,
  onTaskDelete,
}: TasksTabProps) {
  // State
  const [tasks, setTasks] = useState<Task[]>(initialTasks)
  const [viewMode, setViewMode] = useState<ViewMode>("board")
  const [searchQuery, setSearchQuery] = useState("")
  const [statusFilter, setStatusFilter] = useState<TaskStatus | "all">("all")
  const [priorityFilter, setPriorityFilter] = useState<TaskPriority | "all">("all")
  const [assigneeFilter, setAssigneeFilter] = useState<string | "all">("all")
  const [tradeFilter, setTradeFilter] = useState<TaskTrade | "all">("all")
  const [showCompleted, setShowCompleted] = useState(true)

  // Sheet states
  const [createSheetOpen, setCreateSheetOpen] = useState(false)
  const [detailSheetOpen, setDetailSheetOpen] = useState(false)
  const [selectedTask, setSelectedTask] = useState<Task | null>(null)
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false)
  const [taskToDelete, setTaskToDelete] = useState<Task | null>(null)
  const [isSubmitting, setIsSubmitting] = useState(false)

  // Form
  const createForm = useForm<TaskInput>({
    resolver: zodResolver(taskInputSchema),
    defaultValues: {
      project_id: projectId,
      title: "",
      description: "",
      status: "todo",
      priority: "normal",
      location: "",
      trade: undefined,
      estimated_hours: undefined,
      tags: [],
      checklist: [],
    },
  })

  // ============================================
  // COMPUTED VALUES
  // ============================================

  const filteredTasks = useMemo(() => {
    return tasks.filter((task) => {
      // Search filter
      if (searchQuery) {
        const query = searchQuery.toLowerCase()
        const matchesTitle = task.title.toLowerCase().includes(query)
        const matchesDesc = task.description?.toLowerCase().includes(query)
        const matchesLocation = task.location?.toLowerCase().includes(query)
        if (!matchesTitle && !matchesDesc && !matchesLocation) return false
      }

      // Status filter
      if (statusFilter !== "all" && task.status !== statusFilter) return false

      // Priority filter
      if (priorityFilter !== "all" && task.priority !== priorityFilter) return false

      // Assignee filter
      if (assigneeFilter !== "all") {
        if (assigneeFilter === "unassigned" && task.assignee_id) return false
        if (assigneeFilter !== "unassigned" && task.assignee_id !== assigneeFilter) return false
      }

      // Trade filter
      if (tradeFilter !== "all" && task.trade !== tradeFilter) return false

      // Show completed filter
      if (!showCompleted && task.status === "done") return false

      return true
    })
  }, [tasks, searchQuery, statusFilter, priorityFilter, assigneeFilter, tradeFilter, showCompleted])

  const tasksByStatus = useMemo(() => {
    const grouped: Record<TaskStatus, Task[]> = {
      todo: [],
      in_progress: [],
      blocked: [],
      done: [],
    }

    filteredTasks.forEach((task) => {
      grouped[task.status].push(task)
    })

    // Sort each group by priority
    Object.keys(grouped).forEach((status) => {
      grouped[status as TaskStatus].sort((a, b) => {
        const priorityA = PRIORITY_ORDER.indexOf(a.priority)
        const priorityB = PRIORITY_ORDER.indexOf(b.priority)
        return priorityA - priorityB
      })
    })

    return grouped
  }, [filteredTasks])

  const stats = useMemo(() => {
    const total = tasks.length
    const completed = tasks.filter((t) => t.status === "done").length
    const overdue = tasks.filter((t) => {
      if (!t.due_date || t.status === "done") return false
      return isPast(parseISO(t.due_date))
    }).length
    const blocked = tasks.filter((t) => t.status === "blocked").length
    const inProgress = tasks.filter((t) => t.status === "in_progress").length

    return { total, completed, overdue, blocked, inProgress }
  }, [tasks])

  const activeFiltersCount = useMemo(() => {
    let count = 0
    if (statusFilter !== "all") count++
    if (priorityFilter !== "all") count++
    if (assigneeFilter !== "all") count++
    if (tradeFilter !== "all") count++
    if (!showCompleted) count++
    return count
  }, [statusFilter, priorityFilter, assigneeFilter, tradeFilter, showCompleted])

  // ============================================
  // HANDLERS
  // ============================================

  const handleCreateTask = async (values: TaskInput) => {
    setIsSubmitting(true)
    try {
      const created = await onTaskCreate(values)
      setTasks((prev) => [created, ...prev])
      createForm.reset()
      setCreateSheetOpen(false)
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
      if (selectedTask?.id === taskId) {
        setSelectedTask(updated)
      }
      return updated
    } catch (error) {
      console.error(error)
      toast.error("Failed to update task")
      throw error
    }
  }

  const handleQuickStatusChange = async (task: Task, newStatus: TaskStatus, isOptimistic = false) => {
    if (isOptimistic) {
      // Optimistic update: update UI immediately
      setTasks((prev) => prev.map((t) => (t.id === task.id ? { ...t, status: newStatus } : t)))
      if (selectedTask?.id === task.id) {
        setSelectedTask({ ...selectedTask, status: newStatus })
      }

      // Update server in background
      try {
        await onTaskUpdate(task.id, { status: newStatus })
        if (newStatus === "done") {
          toast.success("Task completed! 🎉", { description: task.title })
        }
      } catch (error) {
        // Revert on failure
        setTasks((prev) => prev.map((t) => (t.id === task.id ? { ...t, status: task.status } : t)))
        if (selectedTask?.id === task.id) {
          setSelectedTask({ ...selectedTask, status: task.status })
        }
        toast.error("Failed to update task")
      }
    } else {
      // Normal update: wait for server
      try {
        await handleUpdateTask(task.id, { status: newStatus })
        if (newStatus === "done") {
          toast.success("Task completed! 🎉", { description: task.title })
        }
      } catch {
        // Error already handled
      }
    }
  }

  const handleDeleteTask = async () => {
    if (!taskToDelete) return
    
    setIsSubmitting(true)
    try {
      await onTaskDelete(taskToDelete.id)
      setTasks((prev) => prev.filter((t) => t.id !== taskToDelete.id))
      setDeleteDialogOpen(false)
      setTaskToDelete(null)
      if (selectedTask?.id === taskToDelete.id) {
        setDetailSheetOpen(false)
        setSelectedTask(null)
      }
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
    setDetailSheetOpen(true)
  }

  const clearFilters = () => {
    setStatusFilter("all")
    setPriorityFilter("all")
    setAssigneeFilter("all")
    setTradeFilter("all")
    setShowCompleted(true)
    setSearchQuery("")
  }

  // ============================================
  // RENDER
  // ============================================

  return (
    <div className="flex flex-col h-full space-y-4">
      {/* Unified Toolbar */}
      <div className="flex items-center gap-2 flex-wrap">
        {/* Search */}
        <div className="relative w-[200px]">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder="Search tasks..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="pl-9 h-9"
          />
        </div>

        {/* Status Filter */}
        <Select value={statusFilter} onValueChange={(v) => setStatusFilter(v as TaskStatus | "all")}>
          <SelectTrigger className="h-9 w-[120px]">
            <SelectValue placeholder="Status" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Status</SelectItem>
            {STATUS_ORDER.map((status) => (
              <SelectItem key={status} value={status}>
                <div className="flex items-center gap-2">
                  <span className={STATUS_CONFIG[status].color}>{STATUS_CONFIG[status].icon}</span>
                  {STATUS_CONFIG[status].label}
                </div>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        {/* Priority Filter */}
        <Select value={priorityFilter} onValueChange={(v) => setPriorityFilter(v as TaskPriority | "all")}>
          <SelectTrigger className="h-9 w-[120px]">
            <SelectValue placeholder="Priority" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Priority</SelectItem>
            {PRIORITY_ORDER.map((priority) => (
              <SelectItem key={priority} value={priority}>
                <div className="flex items-center gap-2">
                  <span className={cn("h-2 w-2 rounded-full", PRIORITY_CONFIG[priority].dotColor)} />
                  {PRIORITY_CONFIG[priority].label}
                </div>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        {/* Assignee Filter */}
        <Select value={assigneeFilter} onValueChange={setAssigneeFilter}>
          <SelectTrigger className="h-9 w-[140px]">
            <SelectValue placeholder="Assignee" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Assignees</SelectItem>
            <SelectItem value="unassigned">Unassigned</SelectItem>
            {team.map((member) => (
              <SelectItem key={member.user_id} value={member.user_id}>
                <div className="flex items-center gap-2">
                  <Avatar className="h-5 w-5">
                    <AvatarImage src={member.avatar_url} />
                    <AvatarFallback className="text-[10px]">{getInitials(member.full_name)}</AvatarFallback>
                  </Avatar>
                  <span className="truncate">{member.full_name}</span>
                </div>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        {/* Trade Filter */}
        <Select value={tradeFilter} onValueChange={(v) => setTradeFilter(v as TaskTrade | "all")}>
          <SelectTrigger className="h-9 w-[120px]">
            <SelectValue placeholder="Trade" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Trades</SelectItem>
            {Object.entries(TRADE_CONFIG).map(([trade, config]) => (
              <SelectItem key={trade} value={trade}>
                <div className="flex items-center gap-2">
                  <span className={cn("h-2 w-2 rounded-full", config.color)} />
                  {config.label}
                </div>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        {/* Show Completed Toggle */}
        <Button
          variant={showCompleted ? "secondary" : "outline"}
          size="sm"
          className="h-9"
          onClick={() => setShowCompleted(!showCompleted)}
        >
          <CheckCircle2 className="mr-1.5 h-4 w-4" />
          Done
        </Button>

        {/* Clear Filters */}
        {activeFiltersCount > 0 && (
          <Button variant="ghost" size="sm" className="h-9" onClick={clearFilters}>
            <X className="mr-1.5 h-4 w-4" />
            Clear ({activeFiltersCount})
          </Button>
        )}

        {/* Spacer */}
        <div className="flex-1" />

        {/* View Toggle */}
        <div className="flex items-center rounded-lg border p-0.5">
          <Button
            variant={viewMode === "board" ? "secondary" : "ghost"}
            size="sm"
            className="h-7 px-2.5"
            onClick={() => setViewMode("board")}
          >
            <LayoutGrid className="h-4 w-4" />
          </Button>
          <Button
            variant={viewMode === "list" ? "secondary" : "ghost"}
            size="sm"
            className="h-7 px-2.5"
            onClick={() => setViewMode("list")}
          >
            <List className="h-4 w-4" />
          </Button>
        </div>

        {/* Add Task */}
        <Button onClick={() => setCreateSheetOpen(true)} size="sm" className="h-9">
          <Plus className="mr-1.5 h-4 w-4" />
          Add Task
        </Button>
      </div>

      {/* Main Content */}
      <div className="flex-1 min-h-0 overflow-hidden">
        {viewMode === "board" ? (
          <BoardView
            tasksByStatus={tasksByStatus}
            onTaskClick={openTaskDetail}
            onStatusChange={handleQuickStatusChange}
            onAddTask={() => setCreateSheetOpen(true)}
          />
        ) : (
          <ListView
            tasks={filteredTasks}
            onTaskClick={openTaskDetail}
            onStatusChange={handleQuickStatusChange}
            onDeleteClick={(task) => {
              setTaskToDelete(task)
              setDeleteDialogOpen(true)
            }}
          />
        )}
      </div>

      {/* Create Task Sheet */}
      <CreateTaskSheet
        open={createSheetOpen}
        onOpenChange={setCreateSheetOpen}
        form={createForm}
        team={team}
        onSubmit={handleCreateTask}
        isSubmitting={isSubmitting}
      />

      {/* Task Detail Sheet */}
      {selectedTask && (
        <TaskDetailSheet
          open={detailSheetOpen}
          onOpenChange={setDetailSheetOpen}
          task={selectedTask}
          team={team}
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
            <AlertDialogTitle>Delete Task</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to delete "{taskToDelete?.title}"? This action cannot be undone.
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
// BOARD VIEW COMPONENT
// ============================================

interface BoardViewProps {
  tasksByStatus: Record<TaskStatus, Task[]>
  onTaskClick: (task: Task) => void
  onStatusChange: (task: Task, status: TaskStatus, isOptimistic?: boolean) => void
  onAddTask: () => void
}

function BoardView({ tasksByStatus, onTaskClick, onStatusChange, onAddTask }: BoardViewProps) {
  const [activeTask, setActiveTask] = useState<Task | null>(null)

  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: {
        distance: 8,
      },
    }),
    useSensor(KeyboardSensor)
  )

  const handleDragStart = (event: DragStartEvent) => {
    const { active } = event
    const taskId = active.id as string
    // Find the task across all columns
    for (const status of STATUS_ORDER) {
      const task = tasksByStatus[status].find(t => t.id === taskId)
      if (task) {
        setActiveTask(task)
        break
      }
    }
  }

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event
    setActiveTask(null)

    if (!over) return

    const activeId = active.id as string
    const overId = over.id as string

    // Check if dropped on a column
    if (STATUS_ORDER.includes(overId as TaskStatus)) {
      const newStatus = overId as TaskStatus
      // Find the task
      for (const status of STATUS_ORDER) {
        const task = tasksByStatus[status].find(t => t.id === activeId)
        if (task && task.status !== newStatus) {
          onStatusChange(task, newStatus, true) // Use optimistic update
          break
        }
      }
    } else {
      // Dropped on another task - get that task's status
      for (const status of STATUS_ORDER) {
        const targetTask = tasksByStatus[status].find(t => t.id === overId)
        if (targetTask) {
          const sourceTask = Object.values(tasksByStatus).flat().find(t => t.id === activeId)
          if (sourceTask && sourceTask.status !== status) {
            onStatusChange(sourceTask, status, true) // Use optimistic update
          }
          break
        }
      }
    }
  }

  // Get all task IDs for sortable context
  const allTaskIds = useMemo(() => {
    return STATUS_ORDER.flatMap(status => tasksByStatus[status].map(t => t.id))
  }, [tasksByStatus])

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      onDragStart={handleDragStart}
      onDragEnd={handleDragEnd}
    >
      <div className="grid h-full grid-cols-4 overflow-x-auto">
        {STATUS_ORDER.map((status, index) => (
          <DroppableColumn
            key={status}
            status={status}
            tasks={tasksByStatus[status]}
            onTaskClick={onTaskClick}
            onStatusChange={onStatusChange}
            onAddTask={onAddTask}
            isFirst={index === 0}
            isLast={index === STATUS_ORDER.length - 1}
          />
        ))}
      </div>

      <DragOverlay>
        {activeTask ? (
          <div className="opacity-90 rotate-2">
            <TaskCard
              task={activeTask}
              onClick={() => {}}
              onStatusChange={() => {}}
              isDragging
            />
          </div>
        ) : null}
      </DragOverlay>
    </DndContext>
  )
}

// ============================================
// DROPPABLE COLUMN COMPONENT
// ============================================

interface DroppableColumnProps {
  status: TaskStatus
  tasks: Task[]
  onTaskClick: (task: Task) => void
  onStatusChange: (task: Task, status: TaskStatus, isOptimistic?: boolean) => void
  onAddTask: () => void
  isFirst: boolean
  isLast: boolean
}

function DroppableColumn({ status, tasks, onTaskClick, onStatusChange, onAddTask, isFirst, isLast }: DroppableColumnProps) {
  const taskIds = useMemo(() => tasks.map(t => t.id), [tasks])

  const { setNodeRef, isOver } = useDroppable({
    id: status,
  })

  return (
    <div
      className={cn(
        "flex flex-col min-w-[260px] h-full",
        !isFirst && "border-l border-border"
      )}
    >
      {/* Column Header */}
      <div className="flex items-center justify-between py-3 px-3 border-b border-border">
        <div className="flex items-center gap-2">
          <span className={cn("flex items-center gap-1.5", STATUS_CONFIG[status].color)}>
            {STATUS_CONFIG[status].icon}
            <span className="font-medium text-sm text-foreground">
              {STATUS_CONFIG[status].label}
            </span>
          </span>
          <Badge variant="secondary" className="text-xs h-5 px-1.5 min-w-[24px] justify-center">
            {tasks.length}
          </Badge>
        </div>
      </div>

      {/* Cards Container */}
      <SortableContext items={taskIds} strategy={verticalListSortingStrategy} id={status}>
        <div
          ref={setNodeRef}
          className={cn(
            "flex-1 overflow-y-auto",
            isOver && "bg-muted/50"
          )}
        >
          <div className="p-2 space-y-2 min-h-[100px]" data-status={status}>
            {tasks.map((task) => (
              <DraggableTaskCard
                key={task.id}
                task={task}
                onClick={() => onTaskClick(task)}
                onStatusChange={onStatusChange}
              />
            ))}

            {tasks.length === 0 && (
              <div className="flex flex-col items-center justify-center py-8 text-center">
                <div className={cn("flex h-10 w-10 items-center justify-center rounded-full mb-2", STATUS_CONFIG[status].bgColor)}>
                  <span className={STATUS_CONFIG[status].color}>
                    {STATUS_CONFIG[status].icon}
                  </span>
                </div>
                <p className="text-xs text-muted-foreground">No tasks</p>
              </div>
            )}

            {/* Add Task Button */}
            <Button
              variant="ghost"
              className="w-full justify-start text-muted-foreground h-8 mt-1"
              onClick={onAddTask}
            >
              <Plus className="mr-2 h-4 w-4" />
              Add task
            </Button>
          </div>
        </div>
      </SortableContext>
    </div>
  )
}

// ============================================
// DRAGGABLE TASK CARD COMPONENT
// ============================================

interface DraggableTaskCardProps {
  task: Task
  onClick: () => void
  onStatusChange: (task: Task, status: TaskStatus, isOptimistic?: boolean) => void
}

function DraggableTaskCard({ task, onClick, onStatusChange }: DraggableTaskCardProps) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: task.id })

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
  }

  return (
    <div ref={setNodeRef} style={style} {...attributes} {...listeners}>
      <TaskCard
        task={task}
        onClick={onClick}
        onStatusChange={onStatusChange}
        isDragging={isDragging}
      />
    </div>
  )
}

// ============================================
// TASK CARD COMPONENT
// ============================================

interface TaskCardProps {
  task: Task
  onClick: () => void
  onStatusChange: (task: Task, status: TaskStatus, isOptimistic?: boolean) => void
  isDragging?: boolean
}

function TaskCard({ task, onClick, onStatusChange, isDragging }: TaskCardProps) {
  const dueInfo = formatDueDate(task.due_date)

  return (
    <Card
      className={cn(
        "group cursor-pointer transition-all hover:border-primary/50 hover:shadow-sm",
        isDragging && "shadow-lg border-primary/50 bg-background"
      )}
      onClick={onClick}
    >
      <CardContent className="p-2">
        {/* Single Row: Priority + Title + Due Date + Assignee + Menu */}
        <div className="flex items-center gap-2">
          {/* Priority Dot */}
          <span className={cn("h-2 w-2 rounded-full flex-shrink-0", PRIORITY_CONFIG[task.priority].dotColor)} />

          {/* Task Title */}
          <p
            className={cn(
              "text-sm font-medium leading-tight flex-1 min-w-0 truncate",
              task.status === "done" && "line-through text-muted-foreground"
            )}
          >
            {task.title}
          </p>

          {/* Due Date */}
          {task.due_date && (
            <span
              className={cn(
                "text-xs flex items-center gap-1 flex-shrink-0",
                dueInfo.isOverdue ? "text-destructive" : dueInfo.isPriority ? "text-amber-600 dark:text-amber-400" : "text-muted-foreground"
              )}
            >
              <CalendarDays className="h-3.5 w-3.5" />
              {dueInfo.label}
            </span>
          )}

          {/* Assignee Avatar */}
          {task.assignee && (
            <Avatar className="h-5 w-5 flex-shrink-0">
              <AvatarImage src={task.assignee.avatar_url} alt={task.assignee.full_name} />
              <AvatarFallback className="text-[9px]">{getInitials(task.assignee.full_name)}</AvatarFallback>
            </Avatar>
          )}

          {/* More Menu */}
          <DropdownMenu>
            <DropdownMenuTrigger asChild onClick={(e) => e.stopPropagation()}>
              <Button variant="ghost" size="icon" className="h-5 w-5 -mr-1 flex-shrink-0 opacity-0 group-hover:opacity-100 hover:opacity-100 focus:opacity-100">
                <MoreHorizontal className="h-3.5 w-3.5" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" onClick={(e) => e.stopPropagation()}>
              <DropdownMenuSub>
                <DropdownMenuSubTrigger>
                  <Flag className="mr-2 h-4 w-4" />
                  Change Status
                </DropdownMenuSubTrigger>
                <DropdownMenuSubContent>
                  {STATUS_ORDER.map((status) => (
                    <DropdownMenuItem
                      key={status}
                      onClick={() => onStatusChange(task, status)}
                      disabled={task.status === status}
                    >
                      <span className={cn("mr-2", STATUS_CONFIG[status].color)}>
                        {STATUS_CONFIG[status].icon}
                      </span>
                      {STATUS_CONFIG[status].label}
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuSubContent>
              </DropdownMenuSub>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </CardContent>
    </Card>
  )
}

// ============================================
// LIST VIEW COMPONENT
// ============================================

interface ListViewProps {
  tasks: Task[]
  onTaskClick: (task: Task) => void
  onStatusChange: (task: Task, status: TaskStatus, isOptimistic?: boolean) => void
  onDeleteClick: (task: Task) => void
}

function ListView({ tasks, onTaskClick, onStatusChange, onDeleteClick }: ListViewProps) {
  const sortedTasks = useMemo(() => {
    return [...tasks].sort((a, b) => {
      // First sort by status
      const statusA = STATUS_ORDER.indexOf(a.status)
      const statusB = STATUS_ORDER.indexOf(b.status)
      if (statusA !== statusB) return statusA - statusB

      // Then by priority
      const priorityA = PRIORITY_ORDER.indexOf(a.priority)
      const priorityB = PRIORITY_ORDER.indexOf(b.priority)
      if (priorityA !== priorityB) return priorityA - priorityB

      // Then by due date
      if (a.due_date && b.due_date) {
        return parseISO(a.due_date).getTime() - parseISO(b.due_date).getTime()
      }
      if (a.due_date) return -1
      if (b.due_date) return 1

      return 0
    })
  }, [tasks])

  return (
    <div className="rounded-lg border shadow-sm overflow-hidden h-full bg-card">
      <ScrollArea className="h-full">
        <Table>
          <TableHeader className="sticky top-0 bg-muted/40 backdrop-blur z-10">
            <TableRow className="divide-x">
              <TableHead className="w-[52px] px-4 py-3" />
              <TableHead className="min-w-[260px] px-4 py-3 text-left">Task</TableHead>
              <TableHead className="w-[140px] px-4 py-3 text-left">Status</TableHead>
              <TableHead className="w-[120px] px-4 py-3 text-left">Priority</TableHead>
              <TableHead className="w-[140px] px-4 py-3 text-left">Trade</TableHead>
              <TableHead className="w-[140px] px-4 py-3 text-left">Due Date</TableHead>
              <TableHead className="w-[200px] px-4 py-3 text-left">Assignee</TableHead>
              <TableHead className="w-[150px] px-4 py-3 text-left">Progress</TableHead>
              <TableHead className="w-[64px] px-2 py-3" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {sortedTasks.length > 0 ? (
              sortedTasks.map((task) => {
                const dueInfo = formatDueDate(task.due_date)
                const checklistProgress = getChecklistProgress(task.checklist)

                return (
                  <TableRow
                    key={task.id}
                    className="cursor-pointer hover:bg-muted/40 transition-colors divide-x"
                    onClick={() => onTaskClick(task)}
                  >
                    <TableCell className="px-4 py-3 align-middle" onClick={(e) => e.stopPropagation()}>
                      <Checkbox
                        checked={task.status === "done"}
                        onCheckedChange={(checked) =>
                          onStatusChange(task, checked ? "done" : "todo")
                        }
                      />
                    </TableCell>
                    <TableCell className="px-4 py-3 align-middle">
                      <div className="space-y-0.5">
                        <p
                          className={cn(
                            "font-medium",
                            task.status === "done" && "line-through text-muted-foreground"
                          )}
                        >
                          {task.title}
                        </p>
                        {task.location && (
                          <p className="text-xs text-muted-foreground flex items-center gap-1">
                            <MapPin className="h-3 w-3" />
                            {task.location}
                          </p>
                        )}
                      </div>
                    </TableCell>
                    <TableCell className="px-4 py-3 align-middle">
                      <Badge
                        variant="secondary"
                        className={cn("text-xs", STATUS_CONFIG[task.status].bgColor, STATUS_CONFIG[task.status].color)}
                      >
                        {STATUS_CONFIG[task.status].label}
                      </Badge>
                    </TableCell>
                    <TableCell className="px-4 py-3 align-middle">
                      <div className="flex items-center gap-1.5">
                        <span className={cn("h-2 w-2 rounded-full", PRIORITY_CONFIG[task.priority].dotColor)} />
                        <span className="text-sm">{PRIORITY_CONFIG[task.priority].label}</span>
                      </div>
                    </TableCell>
                    <TableCell className="px-4 py-3 align-middle">
                      {task.trade ? (
                        <Badge variant="outline" className="text-xs">
                          {TRADE_CONFIG[task.trade as TaskTrade]?.label ?? task.trade}
                        </Badge>
                      ) : (
                        <span className="text-muted-foreground text-sm">—</span>
                      )}
                    </TableCell>
                    <TableCell className="px-4 py-3 align-middle">
                      {task.due_date ? (
                        <span
                          className={cn(
                            "text-sm",
                            dueInfo.isOverdue && "text-destructive",
                            dueInfo.isPriority && !dueInfo.isOverdue && "text-amber-600 dark:text-amber-400"
                          )}
                        >
                          {dueInfo.label}
                        </span>
                      ) : (
                        <span className="text-muted-foreground text-sm">—</span>
                      )}
                    </TableCell>
                    <TableCell className="px-4 py-3 align-middle">
                      {task.assignee ? (
                        <div className="flex items-center gap-2 min-w-0">
                          <Avatar className="h-6 w-6 flex-shrink-0">
                            <AvatarImage src={task.assignee.avatar_url} />
                            <AvatarFallback className="text-[10px]">
                              {getInitials(task.assignee.full_name)}
                            </AvatarFallback>
                          </Avatar>
                          <span className="text-sm truncate">{task.assignee.full_name}</span>
                        </div>
                      ) : (
                        <span className="text-muted-foreground text-sm">Unassigned</span>
                      )}
                    </TableCell>
                    <TableCell className="px-4 py-3 align-middle">
                      {checklistProgress.total > 0 ? (
                        <div className="flex items-center gap-2">
                          <Progress value={checklistProgress.percent} className="w-16 h-1.5" />
                          <span className="text-xs text-muted-foreground">
                            {checklistProgress.completed}/{checklistProgress.total}
                          </span>
                        </div>
                      ) : (
                        <span className="text-muted-foreground text-sm">—</span>
                      )}
                    </TableCell>
                    <TableCell className="px-2 py-3 align-middle" onClick={(e) => e.stopPropagation()}>
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button variant="ghost" size="icon" className="h-8 w-8">
                            <MoreHorizontal className="h-4 w-4" />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <DropdownMenuItem onClick={() => onTaskClick(task)}>
                            <Edit className="mr-2 h-4 w-4" />
                            Edit
                          </DropdownMenuItem>
                          <DropdownMenuSeparator />
                          <DropdownMenuItem
                            className="text-destructive"
                            onClick={() => onDeleteClick(task)}
                          >
                            <Trash2 className="mr-2 h-4 w-4" />
                            Delete
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </TableCell>
                  </TableRow>
                )
              })
            ) : (
              <TableRow>
                <TableCell colSpan={9} className="px-6 py-10">
                  <div className="flex flex-col items-center justify-center py-12 text-center">
                    <div className="flex h-12 w-12 items-center justify-center rounded-full bg-muted mb-4">
                      <CheckCircle2 className="h-6 w-6 text-muted-foreground" />
                    </div>
                    <p className="font-medium">No tasks found</p>
                    <p className="text-sm text-muted-foreground mt-1">
                      Try adjusting your filters or create a new task.
                    </p>
                  </div>
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </ScrollArea>
    </div>
  )
}

// ============================================
// CREATE TASK SHEET
// ============================================

interface CreateTaskSheetProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  form: ReturnType<typeof useForm<TaskInput>>
  team: TasksTabProps["team"]
  onSubmit: (values: TaskInput) => void
  isSubmitting: boolean
}

function CreateTaskSheet({ open, onOpenChange, form, team, onSubmit, isSubmitting }: CreateTaskSheetProps) {
  const [newChecklistItem, setNewChecklistItem] = useState("")

  const handleAddChecklistItem = () => {
    if (!newChecklistItem.trim()) return
    const current = form.getValues("checklist") ?? []
    form.setValue("checklist", [
      ...current,
      { id: crypto.randomUUID(), text: newChecklistItem.trim(), completed: false },
    ])
    setNewChecklistItem("")
  }

  const handleRemoveChecklistItem = (id: string) => {
    const current = form.getValues("checklist") ?? []
    form.setValue(
      "checklist",
      current.filter((item) => item.id !== id)
    )
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        className="sm:max-w-lg w-full max-w-md ml-auto mr-4 mt-4 h-[calc(100vh-2rem)] rounded-lg border shadow-2xl flex flex-col p-0 fast-sheet-animation"
        style={
          {
            animationDuration: "150ms",
            transitionDuration: "150ms",
          } satisfies CSSProperties
        }
      >
        <SheetHeader className="px-6 pt-6 pb-4 border-b bg-muted/30">
          <SheetTitle className="flex items-center gap-2">
            <SquareCheck className="h-5 w-5" />
            New Task
          </SheetTitle>
          <SheetDescription>
            Use trades, dates, and assignment to keep tasks aligned with the schedule.
          </SheetDescription>
        </SheetHeader>

        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="flex-1 flex flex-col overflow-hidden">
            <ScrollArea className="flex-1">
              <div className="px-6 py-4 space-y-6">
                <div className="space-y-3">
                  <FormField
                    control={form.control}
                    name="title"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Title *</FormLabel>
                        <FormControl>
                          <Input placeholder="Install kitchen backsplash" {...field} />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />

                  <FormField
                    control={form.control}
                    name="description"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Description</FormLabel>
                        <FormControl>
                          <Textarea
                            placeholder="Add details about this task..."
                            className="min-h-[80px] resize-none"
                            {...field}
                          />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                </div>

                <Separator />

                <div className="space-y-3">
                  <div className="flex items-center justify-between">
                    <h4 className="text-sm font-medium text-muted-foreground">Planning</h4>
                    <Badge variant="secondary" className="text-xs">
                      Status & priority
                    </Badge>
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <FormField
                      control={form.control}
                      name="status"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel>Status</FormLabel>
                          <Select onValueChange={field.onChange} value={field.value}>
                            <FormControl>
                              <SelectTrigger className="w-full">
                                <SelectValue placeholder="Select status" />
                              </SelectTrigger>
                            </FormControl>
                            <SelectContent>
                              {STATUS_ORDER.map((status) => (
                                <SelectItem key={status} value={status}>
                                  <div className="flex items-center gap-2">
                                    <span className={STATUS_CONFIG[status].color}>
                                      {STATUS_CONFIG[status].icon}
                                    </span>
                                    {STATUS_CONFIG[status].label}
                                  </div>
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                          <FormMessage />
                        </FormItem>
                      )}
                    />

                    <FormField
                      control={form.control}
                      name="priority"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel>Priority</FormLabel>
                          <Select onValueChange={field.onChange} value={field.value}>
                            <FormControl>
                              <SelectTrigger className="w-full">
                                <SelectValue placeholder="Select priority" />
                              </SelectTrigger>
                            </FormControl>
                            <SelectContent>
                              {PRIORITY_ORDER.map((priority) => (
                                <SelectItem key={priority} value={priority}>
                                  <div className="flex items-center gap-2">
                                    <span className={cn("h-2 w-2 rounded-full", PRIORITY_CONFIG[priority].dotColor)} />
                                    {PRIORITY_CONFIG[priority].label}
                                  </div>
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <FormField
                    control={form.control}
                    name="start_date"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Start Date</FormLabel>
                        <FormControl>
                          <Input type="date" {...field} />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />

                  <FormField
                    control={form.control}
                    name="due_date"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Due Date</FormLabel>
                        <FormControl>
                          <Input type="date" {...field} />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <FormField
                    control={form.control}
                    name="assignee_id"
                    render={({ field }) => (
                      <FormItem className="col-span-2">
                        <FormLabel>Assignee</FormLabel>
                        <Select onValueChange={field.onChange} value={field.value ?? ""}>
                          <FormControl>
                            <SelectTrigger className="w-full">
                              <SelectValue placeholder="Select assignee" />
                            </SelectTrigger>
                          </FormControl>
                          <SelectContent>
                            <SelectItem value="unassigned">Unassigned</SelectItem>
                            {team.map((member) => (
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
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                </div>

                <Separator />

                <div className="space-y-4">
                  <div className="flex items-center justify-between">
                    <h4 className="text-sm font-medium text-muted-foreground">Construction details</h4>
                    <Badge variant="outline" className="text-[11px]">
                      Optional
                    </Badge>
                  </div>

                  <div className="grid grid-cols-2 gap-3">
                    <FormField
                      control={form.control}
                      name="location"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel>Location</FormLabel>
                          <FormControl>
                            <Input placeholder="e.g., Kitchen, 2nd Floor" {...field} />
                          </FormControl>
                          <FormMessage />
                        </FormItem>
                      )}
                    />

                    <FormField
                      control={form.control}
                      name="trade"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Trade</FormLabel>
                        <Select onValueChange={field.onChange} value={field.value ?? "none"}>
                          <FormControl>
                            <SelectTrigger className="w-full">
                              <SelectValue placeholder="Select trade" />
                            </SelectTrigger>
                          </FormControl>
                          <SelectContent>
                            <SelectItem value="none">None</SelectItem>
                              {Object.entries(TRADE_CONFIG).map(([trade, config]) => (
                                <SelectItem key={trade} value={trade}>
                                  <div className="flex items-center gap-2">
                                    <span className={cn("h-2 w-2 rounded-full", config.color)} />
                                    {config.label}
                                  </div>
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                  </div>

                  <FormField
                    control={form.control}
                    name="estimated_hours"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Estimated Hours</FormLabel>
                        <FormControl>
                          <Input
                            type="number"
                            min="0"
                            step="0.5"
                            placeholder="e.g., 4"
                            {...field}
                            onChange={(e) =>
                              field.onChange(e.target.value ? parseFloat(e.target.value) : undefined)
                            }
                            value={field.value ?? ""}
                          />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                </div>

                <Separator />

                <div className="space-y-3">
                  <div className="flex items-center justify-between">
                    <h4 className="text-sm font-medium text-muted-foreground">Checklist</h4>
                    {(form.watch("checklist") ?? []).length > 0 && (
                      <Badge variant="secondary" className="text-[11px]">
                        {(form.watch("checklist") ?? []).length} items
                      </Badge>
                    )}
                  </div>

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
                    <Button type="button" variant="outline" onClick={handleAddChecklistItem}>
                      <Plus className="h-4 w-4" />
                    </Button>
                  </div>

                  {(form.watch("checklist") ?? []).length > 0 && (
                    <div className="space-y-2">
                      {form.watch("checklist")?.map((item) => (
                        <div key={item.id} className="flex items-center gap-2 rounded-md border px-3 py-2">
                          <Checkbox checked={item.completed} disabled />
                          <span className="flex-1 text-sm">{item.text}</span>
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon"
                            className="h-6 w-6"
                            onClick={() => handleRemoveChecklistItem(item.id)}
                          >
                            <X className="h-3.5 w-3.5" />
                          </Button>
                        </div>
                      ))}
                    </div>
                  )}

                  {(form.watch("checklist") ?? []).length === 0 && (
                    <p className="text-sm text-muted-foreground">
                      Break the task down into smaller steps to track progress.
                    </p>
                  )}
                </div>
              </div>
            </ScrollArea>

            <div className="flex-shrink-0 border-t bg-muted/30 px-6 py-4">
              <div className="flex gap-2">
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => {
                    form.reset()
                    onOpenChange(false)
                  }}
                  className="flex-1"
                >
                  Cancel
                </Button>
                <Button type="submit" disabled={isSubmitting} className="flex-1">
                  {isSubmitting ? "Creating..." : "Create Task"}
                </Button>
              </div>
            </div>
          </form>
        </Form>
      </SheetContent>
    </Sheet>
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
  onUpdate: (taskId: string, updates: Partial<TaskInput>) => Promise<Task>
  onDelete: () => void
}

function TaskDetailSheet({ open, onOpenChange, task, team, onUpdate, onDelete }: TaskDetailSheetProps) {
  const [isEditing, setIsEditing] = useState(false)
  const [editTitle, setEditTitle] = useState(task.title)
  const [editDescription, setEditDescription] = useState(task.description ?? "")
  const [newChecklistItem, setNewChecklistItem] = useState("")
  const [isSaving, setIsSaving] = useState(false)

  const dueInfo = formatDueDate(task.due_date)
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

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        className="sm:max-w-xl w-full max-w-lg ml-auto mr-4 mt-4 h-[calc(100vh-2rem)] rounded-lg border shadow-2xl flex flex-col p-0 fast-sheet-animation"
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
                {STATUS_CONFIG[task.status].icon}
                <span className="ml-1">{STATUS_CONFIG[task.status].label}</span>
              </Badge>
              <Badge variant="outline" className={PRIORITY_CONFIG[task.priority].color}>
                <span className={cn("h-2 w-2 rounded-full mr-1.5", PRIORITY_CONFIG[task.priority].dotColor)} />
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
              <div className="grid grid-cols-3 gap-3">
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
                        <div className="flex items-center gap-2">
                          <span className={STATUS_CONFIG[status].color}>{STATUS_CONFIG[status].icon}</span>
                          {STATUS_CONFIG[status].label}
                        </div>
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
                        <div className="flex items-center gap-2">
                          <span className={cn("h-2 w-2 rounded-full", PRIORITY_CONFIG[priority].dotColor)} />
                          {PRIORITY_CONFIG[priority].label}
                        </div>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>

                <Select
                  value={task.assignee_id ?? "unassigned"}
                  onValueChange={(value) =>
                    onUpdate(task.id, { assignee_id: value === "unassigned" ? undefined : value })
                  }
                >
                  <SelectTrigger className="w-full h-9">
                    <SelectValue placeholder="Unassigned" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="unassigned">Unassigned</SelectItem>
                    {team.map((member) => (
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
                <p className="text-xs font-medium text-muted-foreground">Due Date</p>
                <p
                  className={cn(
                    "text-sm flex items-center gap-1.5",
                    dueInfo.isOverdue && "text-destructive"
                  )}
                >
                  <CalendarDays className="h-4 w-4" />
                  {dueInfo.label}
                </p>
              </div>

              <div className="space-y-1">
                <p className="text-xs font-medium text-muted-foreground">Assignee</p>
                {task.assignee ? (
                  <div className="flex items-center gap-2">
                    <Avatar className="h-6 w-6">
                      <AvatarImage src={task.assignee.avatar_url} />
                      <AvatarFallback className="text-[10px]">
                        {getInitials(task.assignee.full_name)}
                      </AvatarFallback>
                    </Avatar>
                    <span className="text-sm">{task.assignee.full_name}</span>
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
