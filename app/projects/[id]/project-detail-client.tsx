"use client"

import { useState, useMemo, useEffect } from "react"
import Link from "next/link"
import {
  format,
  formatDistanceToNow,
  differenceInCalendarDays,
  parseISO,
  isAfter,
  isBefore,
  addDays,
} from "date-fns"
import { useForm } from "react-hook-form"
import { zodResolver } from "@hookform/resolvers/zod"
import { toast } from "sonner"
import { DateRange } from "react-day-picker"

import type { Project, Task, ScheduleItem, DailyLog, FileMetadata } from "@/lib/types"
import type {
  ProjectStats,
  ProjectTeamMember,
  ProjectActivity,
  EnhancedFileMetadata,
  FileCategory,
  ProjectRoleOption,
  TeamDirectoryEntry,
} from "./actions"
import {
  createProjectScheduleItemAction,
  updateProjectScheduleItemAction,
  deleteProjectScheduleItemAction,
  createProjectTaskAction,
  updateProjectTaskAction,
  deleteProjectTaskAction,
  createProjectDailyLogAction,
  uploadProjectFileAction,
  deleteProjectFileAction,
  getFileDownloadUrlAction,
  addProjectMembersAction,
  removeProjectMemberAction,
  updateProjectMemberRoleAction,
  getProjectTeamDirectoryAction,
} from "./actions"
import { FilesManager } from "@/components/files"
import { ScheduleView } from "@/components/schedule"
import { DailyLogsTab } from "@/components/daily-logs"
import { TasksTab } from "@/components/tasks"
import { scheduleItemInputSchema, type ScheduleItemInput } from "@/lib/validation/schedule"
import { cn } from "@/lib/utils"

import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { Progress } from "@/components/ui/progress"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
import { Checkbox } from "@/components/ui/checkbox"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Separator } from "@/components/ui/separator"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { Calendar } from "@/components/ui/calendar"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet"
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu"
import {
  CalendarDays,
  CheckCircle,
  Clock,
  AlertCircle,
  Plus,
  MoreHorizontal,
  Camera,
  FileText,
  Users,
  DollarSign,
  TrendingUp,
  Upload,
  ArrowUpRight,
  ClipboardList,
  Building2,
  Search,
  RotateCw,
  Mail,
  UserPlus,
  Settings,
} from "@/components/icons"

interface ProjectDetailClientProps {
  project: Project
  stats: ProjectStats
  tasks: Task[]
  scheduleItems: ScheduleItem[]
  dailyLogs: DailyLog[]
  files: EnhancedFileMetadata[]
  team: ProjectTeamMember[]
  activity: ProjectActivity[]
}

const statusColors: Record<string, string> = {
  planning: "bg-chart-3/20 text-chart-3 border-chart-3/30",
  bidding: "bg-blue-500/20 text-blue-600 border-blue-500/30",
  active: "bg-success/20 text-success border-success/30",
  on_hold: "bg-warning/20 text-warning border-warning/30",
  completed: "bg-muted text-muted-foreground border-muted",
  cancelled: "bg-destructive/20 text-destructive border-destructive/30",
}

const statusLabels: Record<string, string> = {
  planning: "Planning",
  bidding: "Bidding",
  active: "Active",
  on_hold: "On Hold",
  completed: "Completed",
  cancelled: "Cancelled",
}


const scheduleStatusColors: Record<string, string> = {
  planned: "bg-muted text-muted-foreground",
  in_progress: "bg-primary/10 text-primary",
  at_risk: "bg-warning/20 text-warning",
  blocked: "bg-destructive/10 text-destructive",
  completed: "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-200",
  done: "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-200",
}

function getInitials(name: string): string {
  return name
    .split(" ")
    .map(n => n[0])
    .join("")
    .toUpperCase()
    .slice(0, 2)
}

function formatActivityEvent(event: ProjectActivity): { icon: React.ReactNode; title: string; description: string } {
  const eventMap: Record<string, { icon: React.ReactNode; title: string }> = {
    task_created: { icon: <CheckCircle className="h-4 w-4 text-success" />, title: "Task created" },
    task_updated: { icon: <CheckCircle className="h-4 w-4 text-primary" />, title: "Task updated" },
    task_completed: { icon: <CheckCircle className="h-4 w-4 text-success" />, title: "Task completed" },
    daily_log_created: { icon: <ClipboardList className="h-4 w-4 text-chart-2" />, title: "Daily log added" },
    schedule_item_created: { icon: <CalendarDays className="h-4 w-4 text-chart-3" />, title: "Schedule item added" },
    schedule_item_updated: { icon: <CalendarDays className="h-4 w-4 text-primary" />, title: "Schedule updated" },
    file_uploaded: { icon: <FileText className="h-4 w-4 text-chart-4" />, title: "File uploaded" },
    project_updated: { icon: <Building2 className="h-4 w-4 text-primary" />, title: "Project updated" },
    project_created: { icon: <Building2 className="h-4 w-4 text-success" />, title: "Project created" },
  }

  const config = eventMap[event.event_type] ?? { icon: <AlertCircle className="h-4 w-4" />, title: event.event_type }
  const description = event.payload?.title ?? event.payload?.name ?? event.payload?.summary ?? ""

  return { ...config, description }
}


// Schedule item type and status options
const scheduleItemTypes = ["task", "milestone", "inspection", "handoff"]
const scheduleStatusOptions = [
  { value: "planned", label: "Planned" },
  { value: "in_progress", label: "In Progress" },
  { value: "at_risk", label: "At Risk" },
  { value: "blocked", label: "Blocked" },
  { value: "completed", label: "Completed" },
]


// DateRangePicker component
function DateRangePicker({
  dateRange,
  onDateRangeChange,
  placeholder = "Pick date range",
}: {
  dateRange?: DateRange
  onDateRangeChange: (range: DateRange | undefined) => void
  placeholder?: string
}) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          className={cn(
            "w-full justify-start text-left font-normal",
            !dateRange?.from && "text-muted-foreground"
          )}
        >
          <CalendarDays className="mr-2 h-4 w-4" />
          {dateRange?.from ? (
            dateRange.to ? (
              <>
                {format(dateRange.from, "LLL dd, y")} – {format(dateRange.to, "LLL dd, y")}
              </>
            ) : (
              format(dateRange.from, "LLL dd, y")
            )
          ) : (
            <span>{placeholder}</span>
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-auto p-0" align="start">
        <Calendar
          initialFocus
          mode="range"
          defaultMonth={dateRange?.from}
          selected={dateRange}
          onSelect={onDateRangeChange}
          numberOfMonths={2}
        />
      </PopoverContent>
    </Popover>
  )
}

export function ProjectDetailClient({
  project,
  stats,
  tasks: initialTasks,
  scheduleItems: initialScheduleItems,
  dailyLogs: initialDailyLogs,
  files: initialFiles,
  team,
  activity,
}: ProjectDetailClientProps) {
  const [activeTab, setActiveTab] = useState("overview")
  const today = new Date()

  // State for data
  const [tasks, setTasks] = useState<Task[]>(initialTasks)
  const [scheduleItems, setScheduleItems] = useState<ScheduleItem[]>(initialScheduleItems)
  const [dailyLogs, setDailyLogs] = useState<DailyLog[]>(initialDailyLogs)
  const [files, setFiles] = useState<EnhancedFileMetadata[]>(initialFiles)
  const [teamMembers, setTeamMembers] = useState<ProjectTeamMember[]>(team)

  // Sheet states
  const [scheduleSheetOpen, setScheduleSheetOpen] = useState(false)
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [teamSheetOpen, setTeamSheetOpen] = useState(false)

  // Date range for schedule items
  const [scheduleDateRange, setScheduleDateRange] = useState<DateRange | undefined>()

  // Team management state
  const [teamSearch, setTeamSearch] = useState("")
  const [roleFilter, setRoleFilter] = useState("all")
  const [teamDirectoryLoading, setTeamDirectoryLoading] = useState(false)
  const [teamLoading, setTeamLoading] = useState(false)
  const [availablePeople, setAvailablePeople] = useState<TeamDirectoryEntry[]>([])
  const [projectRoles, setProjectRoles] = useState<ProjectRoleOption[]>([])
  const [selectedRoleId, setSelectedRoleId] = useState<string | undefined>()
  const [selectedUserIds, setSelectedUserIds] = useState<Set<string>>(new Set())
  const [directorySearch, setDirectorySearch] = useState("")

  useEffect(() => {
    void loadTeamDirectory()
  }, [])

  async function loadTeamDirectory() {
    setTeamDirectoryLoading(true)
    try {
      const { roles, people } = await getProjectTeamDirectoryAction(project.id)
      setProjectRoles(roles)
      setAvailablePeople(people)
      if (!selectedRoleId && roles.length > 0) {
        setSelectedRoleId(roles[0].id)
      }
    } catch (error) {
      console.error(error)
      toast.error("Unable to load team directory")
    } finally {
      setTeamDirectoryLoading(false)
    }
  }

  // Forms
  const scheduleForm = useForm<ScheduleItemInput>({
    resolver: zodResolver(scheduleItemInputSchema),
    defaultValues: {
      project_id: project.id,
      name: "",
      item_type: "task",
      status: "planned",
      start_date: "",
      end_date: "",
    },
  })

  // Form handlers
  async function handleCreateScheduleItem(values: ScheduleItemInput) {
    setIsSubmitting(true)
    try {
      const formattedValues = {
        ...values,
        start_date: scheduleDateRange?.from ? format(scheduleDateRange.from, "yyyy-MM-dd") : "",
        end_date: scheduleDateRange?.to ? format(scheduleDateRange.to, "yyyy-MM-dd") : "",
      }
      const created = await createProjectScheduleItemAction(project.id, formattedValues)
      setScheduleItems((prev) => [created, ...prev])
      scheduleForm.reset()
      setScheduleDateRange(undefined)
      setScheduleSheetOpen(false)
      toast.success("Schedule item created", { description: created.name })
    } catch (error) {
      console.error(error)
      toast.error("Failed to create schedule item")
    } finally {
      setIsSubmitting(false)
    }
  }

  async function handleFileUpload(uploadFiles: File[], category?: FileCategory) {
    for (const file of uploadFiles) {
      const formData = new FormData()
      formData.append("file", file)
      const uploaded = await uploadProjectFileAction(project.id, formData)
      setFiles((prev) => [uploaded, ...prev])
    }
  }

  async function handleFileDelete(fileId: string) {
    await deleteProjectFileAction(project.id, fileId)
    setFiles((prev) => prev.filter((f) => f.id !== fileId))
  }

  async function handleFileDownload(file: EnhancedFileMetadata) {
    try {
      // Use the existing download URL if available, otherwise fetch a new one
      const url = file.download_url || await getFileDownloadUrlAction(file.id)
      
      // Create a temporary link and trigger download
      const link = document.createElement("a")
      link.href = url
      link.download = file.file_name
      link.target = "_blank"
      document.body.appendChild(link)
      link.click()
      document.body.removeChild(link)
    } catch (error) {
      console.error("Download failed:", error)
      toast.error("Failed to download file")
    }
  }

  async function handleAddMembers() {
    const userIds = Array.from(selectedUserIds)
    const roleId = selectedRoleId ?? projectRoles[0]?.id

    if (!userIds.length) {
      toast.info("Select at least one person to add")
      return
    }

    if (!roleId) {
      toast.error("Choose a project role before adding people")
      return
    }

    setTeamLoading(true)
    try {
      const added = await addProjectMembersAction(project.id, { userIds, roleId })
      setTeamMembers((prev) => {
        const map = new Map(prev.map((member) => [member.user_id, member]))
        added.forEach((member) => map.set(member.user_id, member))
        return Array.from(map.values())
      })
      setSelectedUserIds(new Set())
      toast.success("Team updated", {
        description: `${added.length} member${added.length === 1 ? "" : "s"} assigned to this project`,
      })
      await loadTeamDirectory()
      setTeamSheetOpen(false)
    } catch (error) {
      console.error(error)
      toast.error("Failed to update team", { description: error instanceof Error ? error.message : undefined })
    } finally {
      setTeamLoading(false)
    }
  }

  async function handleRemoveMember(memberId: string) {
    setTeamLoading(true)
    try {
      await removeProjectMemberAction(project.id, memberId)
      setTeamMembers((prev) => prev.filter((member) => member.id !== memberId))
      await loadTeamDirectory()
      toast.success("Removed from project")
    } catch (error) {
      console.error(error)
      toast.error("Failed to remove member", { description: error instanceof Error ? error.message : undefined })
    } finally {
      setTeamLoading(false)
    }
  }

  async function handleRoleChange(memberId: string, roleId: string) {
    setTeamLoading(true)
    try {
      const updated = await updateProjectMemberRoleAction(project.id, memberId, roleId)
      setTeamMembers((prev) => prev.map((member) => (member.id === memberId ? updated : member)))
      await loadTeamDirectory()
      toast.success("Role updated")
    } catch (error) {
      console.error(error)
      toast.error("Failed to update role", { description: error instanceof Error ? error.message : undefined })
    } finally {
      setTeamLoading(false)
    }
  }

  async function handleQuickAdd(userId: string) {
    const roleId = selectedRoleId ?? projectRoles[0]?.id
    if (!roleId) {
      toast.error("Select a project role before adding")
      return
    }
    setTeamLoading(true)
    try {
      const added = await addProjectMembersAction(project.id, { userIds: [userId], roleId })
      setTeamMembers((prev) => {
        const map = new Map(prev.map((member) => [member.user_id, member]))
        added.forEach((member) => map.set(member.user_id, member))
        return Array.from(map.values())
      })
      toast.success("Member added")
      await loadTeamDirectory()
    } catch (error) {
      console.error(error)
      toast.error("Failed to add member", { description: error instanceof Error ? error.message : undefined })
    } finally {
      setTeamLoading(false)
    }
  }

  function toggleUserSelection(userId: string) {
    setSelectedUserIds((prev) => {
      const next = new Set(prev)
      if (next.has(userId)) {
        next.delete(userId)
      } else {
        next.add(userId)
      }
      return next
    })
  }

  // Calculate progress percentage
  const progressPercentage = stats.totalDays > 0 
    ? Math.min(100, Math.round((stats.daysElapsed / stats.totalDays) * 100))
    : 0

  // Upcoming schedule items
  const upcomingItems = useMemo(() => {
    return scheduleItems
      .filter(item => {
        const endDate = item.end_date ? parseISO(item.end_date) : null
        const startDate = item.start_date ? parseISO(item.start_date) : null
        const targetDate = endDate ?? startDate
        return (
          targetDate &&
          isAfter(targetDate, today) &&
          item.status !== "completed" &&
          item.status !== "cancelled"
        )
      })
      .slice(0, 5)
  }, [scheduleItems, today])

  // At risk items
  const atRiskItems = useMemo(() => {
    return scheduleItems.filter(item => {
      const endDate = item.end_date ? parseISO(item.end_date) : null
      const isOverdue =
        endDate && isBefore(endDate, today) && item.status !== "completed" && item.status !== "cancelled"
      const isAtRisk = item.status === "at_risk" || item.status === "blocked"
      return isOverdue || isAtRisk
    })
  }, [scheduleItems, today])

  const teamWorkload = useMemo(() => {
    const map: Record<string, { tasks: number; schedule: number; nextDue?: string }> = {}
    tasks.forEach((task) => {
      if (!task.assignee_id) return
      if (!map[task.assignee_id]) map[task.assignee_id] = { tasks: 0, schedule: 0 }
      map[task.assignee_id].tasks += 1
      if (task.due_date) {
        const existing = map[task.assignee_id].nextDue
        if (!existing || isBefore(parseISO(task.due_date), parseISO(existing))) {
          map[task.assignee_id].nextDue = task.due_date
        }
      }
    })
    scheduleItems.forEach((item) => {
      if (!item.assigned_to) return
      if (!map[item.assigned_to]) map[item.assigned_to] = { tasks: 0, schedule: 0 }
      map[item.assigned_to].schedule += 1
    })
    return map
  }, [scheduleItems, tasks])

  const filteredTeam = useMemo(() => {
    const search = teamSearch.trim().toLowerCase()
    return teamMembers.filter((member) => {
      const matchesSearch = search
        ? member.full_name.toLowerCase().includes(search) || member.email.toLowerCase().includes(search)
        : true
      const matchesRole =
        roleFilter === "all"
          ? true
          : member.role_id === roleFilter || member.role === roleFilter || member.role_label === roleFilter
      return matchesSearch && matchesRole
    })
  }, [roleFilter, teamMembers, teamSearch])


  const filteredDirectory = useMemo(() => {
    const search = directorySearch.trim().toLowerCase()
    return availablePeople
      .filter((person) => {
        if (!search) return true
        return (
          person.full_name.toLowerCase().includes(search) ||
          person.email.toLowerCase().includes(search) ||
          (person.project_role_label ?? "").toLowerCase().includes(search)
        )
      })
      .sort((a, b) => Number(Boolean(a.project_member_id)) - Number(Boolean(b.project_member_id)))
  }, [availablePeople, directorySearch])

  // Mini gantt data
  const ganttEnd = project.end_date ? parseISO(project.end_date) : addDays(today, 90)
  const ganttStart = project.start_date ? parseISO(project.start_date) : today
  const ganttTotalDays = Math.max(1, differenceInCalendarDays(ganttEnd, ganttStart))

  function getBarPosition(startDate?: string, endDate?: string) {
    const start = startDate ? parseISO(startDate) : ganttStart
    const end = endDate ? parseISO(endDate) : start
    const startDelta = Math.max(0, differenceInCalendarDays(start, ganttStart))
    const endDelta = Math.max(startDelta + 1, differenceInCalendarDays(end, ganttStart) + 1)
    const left = Math.min(100, (startDelta / ganttTotalDays) * 100)
    const width = Math.min(100 - left, ((endDelta - startDelta) / ganttTotalDays) * 100)
    return { left, width: Math.max(width, 2) }
  }

  return (
    <div className="flex flex-col h-[calc(100vh-5rem)] space-y-4 p-4 lg:p-6 overflow-hidden">
      {/* Header Section - Fixed */}
      <div className="flex-shrink-0 space-y-4">
        {/* Project Header */}
        <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
          <div className="space-y-1">
            <div className="flex items-center gap-3">
              <h1 className="text-2xl font-bold tracking-tight">{project.name}</h1>
              <Badge variant="outline" className={statusColors[project.status]}>
                {statusLabels[project.status]}
              </Badge>
            </div>
            {project.address && (
              <p className="text-muted-foreground flex items-center gap-2">
                <Building2 className="h-4 w-4" />
                {project.address}
              </p>
            )}
            <div className="flex items-center gap-4 text-sm text-muted-foreground">
              {project.start_date && project.end_date && (
                <span className="flex items-center gap-1.5">
                  <CalendarDays className="h-4 w-4" />
                  {format(parseISO(project.start_date), "MMM d, yyyy")} – {format(parseISO(project.end_date), "MMM d, yyyy")}
                </span>
              )}
              {stats.daysRemaining > 0 && (
                <span className="flex items-center gap-1.5">
                  <Clock className="h-4 w-4" />
                  {stats.daysRemaining} days remaining
                </span>
              )}
              {project.total_value && (
                <span className="flex items-center gap-1.5">
                  <DollarSign className="h-4 w-4" />
                  ${project.total_value.toLocaleString()}
                </span>
              )}
              {project.property_type && (
                <span className="capitalize">
                  {project.property_type}
                </span>
              )}
              {project.project_type && (
                <span className="capitalize">
                  {project.project_type.replace("_", " ")}
                </span>
              )}
            </div>
            {project.description && (
              <p className="text-sm text-muted-foreground mt-2 max-w-2xl">
                {project.description}
              </p>
            )}
          </div>

          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm">
              <ArrowUpRight className="mr-2 h-4 w-4" />
              Client Portal
            </Button>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" size="icon">
                  <MoreHorizontal className="h-4 w-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem>
                  <Settings className="mr-2 h-4 w-4" />
                  Project Settings
                </DropdownMenuItem>
                <DropdownMenuItem>
                  <Users className="mr-2 h-4 w-4" />
                  Manage Team
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem className="text-destructive">Archive Project</DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>
      </div>

      {/* Main Tabs */}
      <Tabs value={activeTab} onValueChange={setActiveTab} className="flex-1 flex flex-col min-h-0 space-y-4">
        <TabsList className="w-full justify-start overflow-x-auto flex-shrink-0">
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="schedule">Schedule</TabsTrigger>
          <TabsTrigger value="tasks">Tasks</TabsTrigger>
          <TabsTrigger value="daily-logs">Daily Logs</TabsTrigger>
          <TabsTrigger value="files">Files</TabsTrigger>
          <TabsTrigger value="team">Team</TabsTrigger>
        </TabsList>

        {/* Overview Tab */}
        <TabsContent value="overview" className="flex-1 overflow-y-auto space-y-6 pr-2">
          {/* Timeline Progress Bar */}
          <Card>
            <CardContent className="py-4">
              <div className="flex items-center justify-between mb-2">
                <span className="text-sm font-medium">Project Timeline</span>
                <span className="text-sm text-muted-foreground">
                  {progressPercentage}% elapsed • {stats.scheduleProgress}% complete
                </span>
              </div>
              <div className="relative h-3 bg-muted overflow-hidden">
                {/* Time elapsed bar */}
                <div
                  className="absolute inset-y-0 left-0 bg-muted-foreground/30"
                  style={{ width: `${progressPercentage}%` }}
                />
                {/* Work completed bar */}
                <div
                  className="absolute inset-y-0 left-0 bg-primary"
                  style={{ width: `${stats.scheduleProgress}%` }}
                />
                {/* Today marker */}
                <div
                  className="absolute top-0 bottom-0 w-0.5 bg-foreground"
                  style={{ left: `${progressPercentage}%` }}
                />
              </div>
              <div className="flex justify-between mt-2 text-xs text-muted-foreground">
                <span>{project.start_date ? format(parseISO(project.start_date), "MMM d") : "Start"}</span>
                <span>{project.end_date ? format(parseISO(project.end_date), "MMM d") : "End"}</span>
              </div>
            </CardContent>
          </Card>

          {/* Stats Grid */}
          <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
            <Card>
              <CardHeader className="flex flex-row items-center justify-between pb-2">
                <CardTitle className="text-sm font-medium">Tasks</CardTitle>
                <CheckCircle className="h-4 w-4 text-muted-foreground" />
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-bold">{stats.completedTasks}/{stats.totalTasks}</div>
                <p className="text-xs text-muted-foreground">
                  {stats.openTasks} open • {stats.overdueTasks > 0 && (
                    <span className="text-destructive">{stats.overdueTasks} overdue</span>
                  )}
                </p>
                <Progress value={stats.totalTasks > 0 ? (stats.completedTasks / stats.totalTasks) * 100 : 0} className="mt-2" />
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="flex flex-row items-center justify-between pb-2">
                <CardTitle className="text-sm font-medium">Schedule Health</CardTitle>
                {stats.atRiskItems > 0 ? (
                  <AlertCircle className="h-4 w-4 text-warning" />
                ) : (
                  <TrendingUp className="h-4 w-4 text-success" />
                )}
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-bold">{stats.scheduleProgress}%</div>
                <p className="text-xs text-muted-foreground">
                  {stats.atRiskItems > 0 ? (
                    <span className="text-warning">{stats.atRiskItems} items at risk</span>
                  ) : (
                    "On track"
                  )}
                </p>
                <Progress value={stats.scheduleProgress} className="mt-2" />
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="flex flex-row items-center justify-between pb-2">
                <CardTitle className="text-sm font-medium">Milestones</CardTitle>
                <CalendarDays className="h-4 w-4 text-muted-foreground" />
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-bold">{stats.upcomingMilestones}</div>
                <p className="text-xs text-muted-foreground">upcoming milestones</p>
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="flex flex-row items-center justify-between pb-2">
                <CardTitle className="text-sm font-medium">Field Activity</CardTitle>
                <Camera className="h-4 w-4 text-muted-foreground" />
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-bold">{stats.recentPhotos}</div>
                <p className="text-xs text-muted-foreground">
                  photos • {stats.openPunchItems} punch items
                </p>
              </CardContent>
            </Card>
          </div>

          <div className="grid gap-6 lg:grid-cols-3">
            {/* Recent Activity */}
            <Card className="lg:col-span-2">
              <CardHeader>
                <CardTitle className="text-base">Recent Activity</CardTitle>
                <CardDescription>Latest updates on this project</CardDescription>
              </CardHeader>
              <CardContent>
                <ScrollArea className="h-[320px] pr-4">
                  <div className="space-y-4">
                    {activity.length > 0 ? activity.map((event) => {
                      const { icon, title, description } = formatActivityEvent(event)
                      return (
                        <div key={event.id} className="flex gap-3">
                          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-muted">
                            {icon}
                          </div>
                          <div className="flex-1 space-y-1">
                            <p className="text-sm font-medium leading-none">{title}</p>
                            {description && (
                              <p className="text-sm text-muted-foreground">{description}</p>
                            )}
                            <p className="text-xs text-muted-foreground">
                              {formatDistanceToNow(parseISO(event.created_at), { addSuffix: true })}
                            </p>
                          </div>
                        </div>
                      )
                    }) : (
                      <p className="text-sm text-muted-foreground text-center py-8">No recent activity</p>
                    )}
                  </div>
                </ScrollArea>
              </CardContent>
            </Card>

            {/* Upcoming Items */}
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Coming Up</CardTitle>
                <CardDescription>Upcoming schedule items</CardDescription>
              </CardHeader>
              <CardContent>
                <div className="space-y-3">
                  {upcomingItems.length > 0 ? upcomingItems.map((item) => (
                    <div key={item.id} className="flex items-start gap-3 rounded-lg border p-3">
                      <div className={cn(
                        "flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-xs font-medium",
                        item.item_type === "milestone" ? "bg-chart-3/20 text-chart-3" : "bg-muted"
                      )}>
                        {item.start_date ? format(parseISO(item.start_date), "dd") : "—"}
                      </div>
                      <div className="flex-1 space-y-1">
                        <p className="text-sm font-medium leading-none">{item.name}</p>
                        <p className="text-xs text-muted-foreground capitalize">{item.item_type}</p>
                      </div>
                      <Badge variant="outline" className={scheduleStatusColors[item.status] ?? ""}>
                        {item.progress ?? 0}%
                      </Badge>
                    </div>
                  )) : (
                    <p className="text-sm text-muted-foreground text-center py-4">No upcoming items</p>
                  )}
                </div>
              </CardContent>
            </Card>
          </div>

          {/* At Risk Section */}
          {atRiskItems.length > 0 && (
            <Card className="border-warning/50">
              <CardHeader>
                <div className="flex items-center gap-2">
                  <AlertCircle className="h-5 w-5 text-warning" />
                  <CardTitle className="text-base">Attention Required</CardTitle>
                </div>
                <CardDescription>Items that need immediate attention</CardDescription>
              </CardHeader>
              <CardContent>
                <div className="space-y-2">
                  {atRiskItems.slice(0, 5).map((item) => (
                    <div key={item.id} className="flex items-center justify-between rounded-lg border border-warning/30 bg-warning/5 p-3">
                      <div>
                        <p className="font-medium">{item.name}</p>
                        <p className="text-sm text-muted-foreground">
                          {item.end_date ? `Due ${format(parseISO(item.end_date), "MMM d")}` : "No end date"}
                        </p>
                      </div>
                      <Badge variant="outline" className={scheduleStatusColors[item.status] ?? "bg-warning/20 text-warning"}>
                        {item.status.replace("_", " ")}
                      </Badge>
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>
          )}
        </TabsContent>

        {/* Schedule Tab */}
        <TabsContent
          value="schedule"
          className="flex-1 min-h-0 w-full min-w-0 data-[state=active]:flex flex-col"
        >
          <ScheduleView
            projectId={project.id}
            items={scheduleItems}
            onItemCreate={async (item) => {
              const created = await createProjectScheduleItemAction(project.id, item)
              setScheduleItems((prev) => [...prev, created])
              toast.success("Schedule item created", { description: created.name })
              return created
            }}
            onItemUpdate={async (id, updates) => {
              const updated = await updateProjectScheduleItemAction(project.id, id, updates)
              setScheduleItems((prev) => prev.map((item) => (item.id === id ? updated : item)))
              return updated
            }}
            onItemDelete={async (id) => {
              await deleteProjectScheduleItemAction(project.id, id)
              setScheduleItems((prev) => prev.filter((item) => item.id !== id))
              toast.success("Schedule item deleted")
            }}
          />
        </TabsContent>

        {/* Tasks Tab */}
        <TabsContent value="tasks" className="flex-1 min-h-0 data-[state=active]:flex flex-col">
          <TasksTab
            projectId={project.id}
            tasks={tasks}
            team={teamMembers.map((m) => ({
              id: m.id,
              user_id: m.user_id,
              full_name: m.full_name,
              avatar_url: m.avatar_url,
            }))}
            onTaskCreate={async (input) => {
              const created = await createProjectTaskAction(project.id, input)
              setTasks((prev) => [created, ...prev])
              toast.success("Task created", { description: created.title })
              return created
            }}
            onTaskUpdate={async (taskId, updates) => {
              const updated = await updateProjectTaskAction(project.id, taskId, updates)
              setTasks((prev) => prev.map((t) => (t.id === taskId ? updated : t)))
              return updated
            }}
            onTaskDelete={async (taskId) => {
              await deleteProjectTaskAction(project.id, taskId)
              setTasks((prev) => prev.filter((t) => t.id !== taskId))
              toast.success("Task deleted")
            }}
          />
        </TabsContent>

        {/* Daily Logs Tab */}
        <TabsContent value="daily-logs" className="flex-1 min-h-0 data-[state=active]:flex flex-col">
          <DailyLogsTab
            projectId={project.id}
            dailyLogs={dailyLogs}
            files={files}
            onCreateLog={async (values) => {
              const created = await createProjectDailyLogAction(project.id, values)
              setDailyLogs(prev => [created, ...prev])
              return created
            }}
            onUploadFiles={handleFileUpload}
            onDownloadFile={handleFileDownload}
          />
        </TabsContent>

        {/* Files Tab */}
        <TabsContent value="files" className="flex-1 overflow-hidden data-[state=active]:flex flex-col">
          <FilesManager
            files={files}            projectId={project.id}
            onUpload={handleFileUpload}
            onDelete={handleFileDelete}
            onDownload={handleFileDownload}
          />
        </TabsContent>

        {/* Team Tab */}
        <TabsContent value="team" className="flex-1 overflow-y-auto space-y-4 pr-2">
          {/* Header */}
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <h2 className="text-lg font-semibold">Project Directory</h2>
              <p className="text-sm text-muted-foreground">
                {teamMembers.length} {teamMembers.length === 1 ? "person" : "people"} on this project
              </p>
            </div>
            <Sheet open={teamSheetOpen} onOpenChange={setTeamSheetOpen}>
              <SheetTrigger asChild>
                <Button onClick={() => void loadTeamDirectory()}>
                  <UserPlus className="mr-2 h-4 w-4" />
                  Add Member
                </Button>
              </SheetTrigger>
              <SheetContent
                side="right"
                className="sm:max-w-md w-full max-w-md ml-auto mr-4 mt-4 h-[calc(100vh-2rem)] rounded-lg border shadow-2xl flex flex-col"
              >
                <div className="flex-1 overflow-y-auto px-4">
                  <SheetHeader className="pt-6 pb-4">
                    <SheetTitle className="text-lg font-semibold leading-none tracking-tight">Add team member</SheetTitle>
                    <SheetDescription className="text-sm text-muted-foreground">
                      Select people from your organization to add to this project.
                    </SheetDescription>
                  </SheetHeader>
                  <div className="space-y-4">
                    <Select
                      value={selectedRoleId ?? projectRoles[0]?.id ?? ""}
                      onValueChange={setSelectedRoleId}
                      disabled={!projectRoles.length}
                    >
                      <SelectTrigger>
                        <SelectValue placeholder="Select role" />
                      </SelectTrigger>
                      <SelectContent>
                        {projectRoles.map((role) => (
                          <SelectItem key={role.id} value={role.id}>
                            {role.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <div className="rounded-lg border">
                      <div className="flex items-center gap-2 border-b px-3 py-2">
                        <Search className="h-4 w-4 text-muted-foreground" />
                        <Input
                          value={directorySearch}
                          onChange={(e) => setDirectorySearch(e.target.value)}
                          placeholder="Search people..."
                          className="h-8 border-0 shadow-none focus-visible:ring-0"
                        />
                      </div>
                      <ScrollArea className="h-[400px]">
                        <div className="divide-y">
                          {filteredDirectory.length > 0 ? (
                            filteredDirectory.map((person) => {
                              const isSelected = selectedUserIds.has(person.user_id)
                              const alreadyOnProject = Boolean(person.project_member_id)
                              return (
                                <button
                                  key={person.user_id}
                                  type="button"
                                  onClick={() => toggleUserSelection(person.user_id)}
                                  className={cn(
                                    "flex w-full items-center gap-3 px-3 py-3 text-left transition hover:bg-muted/60",
                                    isSelected && "bg-primary/10"
                                  )}
                                >
                                  <Checkbox
                                    checked={isSelected}
                                    onCheckedChange={() => toggleUserSelection(person.user_id)}
                                  />
                                  <Avatar className="h-8 w-8">
                                    <AvatarImage src={person.avatar_url} alt={person.full_name} />
                                    <AvatarFallback className="text-xs">{getInitials(person.full_name)}</AvatarFallback>
                                  </Avatar>
                                  <div className="min-w-0 flex-1">
                                    <div className="flex items-center gap-2">
                                      <p className="text-sm font-medium truncate">{person.full_name}</p>
                                      {alreadyOnProject && (
                                        <Badge variant="secondary" className="text-[10px]">
                                          On project
                                        </Badge>
                                      )}
                                    </div>
                                    <p className="text-xs text-muted-foreground truncate">{person.email}</p>
                                  </div>
                                </button>
                              )
                            })
                          ) : (
                            <div className="flex items-center justify-center py-8 text-sm text-muted-foreground">
                              No people found
                            </div>
                          )}
                        </div>
                      </ScrollArea>
                    </div>
                  </div>
                </div>
                <div className="flex-shrink-0 border-t bg-background p-4">
                  <Button
                    className="w-full"
                    disabled={selectedUserIds.size === 0 || teamLoading || teamDirectoryLoading}
                    onClick={handleAddMembers}
                  >
                    {teamLoading ? "Adding..." : `Add ${selectedUserIds.size || ""} ${selectedUserIds.size === 1 ? "person" : "people"}`}
                  </Button>
                </div>
              </SheetContent>
            </Sheet>
          </div>

          {/* Search and Filter Bar */}
          {teamMembers.length > 0 && (
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
              <div className="flex flex-1 items-center gap-2 rounded-lg border bg-background px-3">
                <Search className="h-4 w-4 text-muted-foreground" />
                <Input
                  value={teamSearch}
                  onChange={(e) => setTeamSearch(e.target.value)}
                  placeholder="Search by name or email..."
                  className="h-9 border-0 shadow-none focus-visible:ring-0"
                />
              </div>
              <Select value={roleFilter} onValueChange={setRoleFilter}>
                <SelectTrigger className="w-full sm:w-[160px]">
                  <SelectValue placeholder="All roles" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All roles</SelectItem>
                  {projectRoles.map((role) => (
                    <SelectItem key={role.id} value={role.id}>
                      {role.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}

          {/* Team Member Cards */}
          {filteredTeam.length > 0 ? (
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {filteredTeam.map((member) => {
                const workload = teamWorkload[member.user_id] ?? { tasks: 0, schedule: 0 }
                return (
                  <Card key={member.id} className="relative group">
                    <CardContent className="p-4">
                      <div className="flex items-start gap-3">
                        <Avatar className="h-12 w-12">
                          <AvatarImage src={member.avatar_url} alt={member.full_name} />
                          <AvatarFallback>{getInitials(member.full_name)}</AvatarFallback>
                        </Avatar>
                        <div className="min-w-0 flex-1">
                          <p className="font-medium truncate">{member.full_name}</p>
                          <Badge variant="secondary" className="mt-1 text-[11px]">
                            {member.role_label}
                          </Badge>
                        </div>
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button variant="ghost" size="icon" className="h-8 w-8 opacity-0 group-hover:opacity-100 transition-opacity">
                              <MoreHorizontal className="h-4 w-4" />
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end">
                            <DropdownMenuItem asChild>
                              <Link href={`/people/${member.user_id}`}>View profile</Link>
                            </DropdownMenuItem>
                            <DropdownMenuItem
                              onClick={() => {
                                const newRole = projectRoles.find(r => r.id !== member.role_id)?.id
                                if (newRole) handleRoleChange(member.id, newRole)
                              }}
                            >
                              Change role
                            </DropdownMenuItem>
                            <DropdownMenuSeparator />
                            <DropdownMenuItem
                              className="text-destructive"
                              onClick={() => handleRemoveMember(member.id)}
                            >
                              Remove from project
                            </DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </div>

                      {/* Contact Info */}
                      <div className="mt-3 space-y-1.5">
                        <a
                          href={`mailto:${member.email}`}
                          className="flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground transition-colors"
                        >
                          <Mail className="h-3.5 w-3.5" />
                          <span className="truncate">{member.email}</span>
                        </a>
                      </div>

                      {/* Workload indicator */}
                      {(workload.tasks > 0 || workload.schedule > 0) && (
                        <div className="mt-3 pt-3 border-t flex items-center gap-3 text-xs text-muted-foreground">
                          {workload.tasks > 0 && (
                            <span>{workload.tasks} task{workload.tasks !== 1 ? "s" : ""}</span>
                          )}
                          {workload.schedule > 0 && (
                            <span>{workload.schedule} schedule item{workload.schedule !== 1 ? "s" : ""}</span>
                          )}
                        </div>
                      )}
                    </CardContent>
                  </Card>
                )
              })}
            </div>
          ) : teamMembers.length > 0 ? (
            // No results from search/filter
            <Card>
              <CardContent className="py-12">
                <div className="flex flex-col items-center justify-center text-center">
                  <div className="flex h-12 w-12 items-center justify-center rounded-full bg-muted mb-4">
                    <Search className="h-6 w-6 text-muted-foreground" />
                  </div>
                  <p className="font-medium">No matches found</p>
                  <p className="text-sm text-muted-foreground mt-1">
                    Try adjusting your search or filter.
                  </p>
                  <Button
                    variant="outline"
                    className="mt-4"
                    onClick={() => {
                      setTeamSearch("")
                      setRoleFilter("all")
                    }}
                  >
                    Clear filters
                  </Button>
                </div>
              </CardContent>
            </Card>
          ) : (
            // Empty state - no team members
            <Card>
              <CardContent className="py-16">
                <div className="flex flex-col items-center justify-center text-center">
                  <div className="flex h-16 w-16 items-center justify-center rounded-full bg-muted mb-4">
                    <Users className="h-8 w-8 text-muted-foreground" />
                  </div>
                  <h3 className="text-lg font-semibold">No team members yet</h3>
                  <p className="text-sm text-muted-foreground mt-1 max-w-sm">
                    Add people from your organization to collaborate on this project.
                  </p>
                  <Button className="mt-6" onClick={() => { setTeamSheetOpen(true); void loadTeamDirectory() }}>
                    <UserPlus className="mr-2 h-4 w-4" />
                    Add first member
                  </Button>
                </div>
              </CardContent>
            </Card>
          )}
        </TabsContent>
      </Tabs>
    </div>
  )
}
