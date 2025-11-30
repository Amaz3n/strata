"use client"

import { useMemo, useState, useTransition } from "react"
import { addDays, differenceInCalendarDays, endOfWeek, format, isAfter, isBefore, isSameDay, isWithinInterval, parseISO, startOfDay, startOfWeek } from "date-fns"
import { useForm } from "react-hook-form"
import { zodResolver } from "@hookform/resolvers/zod"

import type { Project, ScheduleItem } from "@/lib/types"
import type { ScheduleItemInput } from "@/lib/validation/schedule"
import { scheduleItemInputSchema } from "@/lib/validation/schedule"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Calendar } from "@/components/ui/calendar"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { DateRange } from "react-day-picker"
import { Progress } from "@/components/ui/progress"
import { Sheet, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Form, FormControl, FormDescription, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form"
import { Checkbox } from "@/components/ui/checkbox"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Slider } from "@/components/ui/slider"
import { AlertCircle, CalendarDays, CheckCircle, Clock, Plus } from "@/components/icons"
import { cn } from "@/lib/utils"
import { toast } from 'sonner'
import { createScheduleItemAction, updateScheduleItemAction } from "./actions"

interface ScheduleClientProps {
  scheduleItems: ScheduleItem[]
  projects: Project[]
}

const statusClasses: Record<string, string> = {
  planned: "bg-muted text-muted-foreground",
  in_progress: "bg-primary/10 text-primary",
  at_risk: "bg-warning/20 text-warning",
  blocked: "bg-destructive/10 text-destructive",
  completed: "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-200",
  done: "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-200",
}

const statusOptions = [
  { value: "planned", label: "Planned" },
  { value: "in_progress", label: "In Progress" },
  { value: "at_risk", label: "At Risk" },
  { value: "blocked", label: "Blocked" },
  { value: "completed", label: "Completed" },
]

const itemTypeOptions = ["task", "milestone", "inspection", "handoff"]

function normalizeStatus(status?: string) {
  return status?.toLowerCase().replaceAll(" ", "_") ?? "planned"
}

function formatStatus(status?: string) {
  const normalized = normalizeStatus(status)
  return statusOptions.find((opt) => opt.value === normalized)?.label ?? "Planned"
}

function dateKey(date: Date) {
  return format(date, "yyyy-MM-dd")
}

function parseDate(value?: string | null) {
  return value ? parseISO(value) : null
}

function formatDateRange(start?: string, end?: string) {
  if (!start && !end) return "No dates"
  const startDate = start ? parseDate(start) : null
  const endDate = end ? parseDate(end) : null

  if (startDate && endDate && !isSameDay(startDate, endDate)) {
    return `${format(startDate, "MMM d")} – ${format(endDate, "MMM d")}`
  }

  if (startDate) return format(startDate, "MMM d")
  if (endDate) return format(endDate, "MMM d")
  return "No dates"
}

function isCompleted(item: ScheduleItem) {
  const normalized = normalizeStatus(item.status)
  return normalized === "completed" || normalized === "done"
}

function isOverdue(item: ScheduleItem, today: Date) {
  const end = parseDate(item.end_date ?? item.start_date)
  return end ? isBefore(end, today) && !isCompleted(item) : false
}

function isAtRisk(item: ScheduleItem, today: Date) {
  const normalized = normalizeStatus(item.status)
  if (normalized === "at_risk" || normalized === "blocked") return true

  const end = parseDate(item.end_date ?? item.start_date)
  if (!end) return false

  const nearingDeadline = isWithinInterval(end, { start: today, end: addDays(today, 3) })
  const lowProgress = (item.progress ?? 0) < 40
  return nearingDeadline && lowProgress
}

function buildDayBuckets(items: ScheduleItem[]) {
  const buckets: Record<string, ScheduleItem[]> = {}
  items.forEach((item) => {
    const start = parseDate(item.start_date)
    const end = parseDate(item.end_date) ?? start
    if (!start && !end) return

    const rangeStart = start ?? end ?? null
    const rangeEnd = end ?? start ?? null
    if (!rangeStart || !rangeEnd) return

    let cursor = rangeStart
    let safety = 0
    while (!isAfter(cursor, rangeEnd) && safety < 90) {
      const key = dateKey(cursor)
      if (!buckets[key]) buckets[key] = []
      buckets[key].push(item)
      cursor = addDays(cursor, 1)
      safety += 1
    }
  })
  return buckets
}

export function ScheduleClient({ scheduleItems, projects }: ScheduleClientProps) {
  const today = startOfDay(new Date())
  const [projectFilter, setProjectFilter] = useState<string>("all")
  const [timeframe, setTimeframe] = useState<string>("90")
  const [view, setView] = useState<"list" | "calendar">("list")
  const [focusedDate, setFocusedDate] = useState<Date | undefined>(today)
  const [items, setItems] = useState<ScheduleItem[]>(scheduleItems)
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [savingIds, setSavingIds] = useState<Record<string, boolean>>({})
  const [isPending, startTransition] = useTransition()
  const [sheetOpen, setSheetOpen] = useState(false)

  const [dateRange, setDateRange] = useState<DateRange | undefined>()

  const createForm = useForm<ScheduleItemInput>({
    resolver: zodResolver(scheduleItemInputSchema),
    defaultValues: {
      name: "",
      project_id: projects[0]?.id ?? "",
      item_type: "task",
      status: "planned",
      start_date: "",
      end_date: "",
      dependencies: [],
      notes: "",
    },
  })

  const horizonDays = timeframe === "all" ? null : Number(timeframe)
  const horizonEnd = horizonDays ? addDays(today, horizonDays) : null
  const timelineEnd = horizonEnd ?? addDays(today, 45)

  const projectLookup = useMemo(
    () => projects.reduce<Record<string, string>>((acc, project) => ({ ...acc, [project.id]: project.name }), {}),
    [projects],
  )

  const filteredItems = useMemo(() => {
    return items
      .filter((item) => {
        if (projectFilter !== "all" && item.project_id !== projectFilter) return false
        if (!horizonEnd) return true

        const start = parseDate(item.start_date)
        const end = parseDate(item.end_date)
        if (!start && !end) return true

        const target = start ?? end
        return target ? isBefore(target, horizonEnd) || isSameDay(target, horizonEnd) : true
      })
      .sort((a, b) => {
        const aDate = parseDate(a.start_date ?? a.end_date ?? "")?.getTime() ?? Number.MAX_SAFE_INTEGER
        const bDate = parseDate(b.start_date ?? b.end_date ?? "")?.getTime() ?? Number.MAX_SAFE_INTEGER
        return aDate - bDate
      })
  }, [items, projectFilter, horizonEnd])

  const dayBuckets = useMemo(() => buildDayBuckets(filteredItems), [filteredItems])
  const busyDates = useMemo(() => Object.keys(dayBuckets).map((key) => parseISO(key)), [dayBuckets])

  const atRiskItems = filteredItems.filter((item) => isAtRisk(item, today) || isOverdue(item, today))
  const completedPercentage = filteredItems.length
    ? Math.round((filteredItems.filter(isCompleted).length / filteredItems.length) * 100)
    : 0

  const thisWeekItems = useMemo(() => {
    const start = startOfWeek(focusedDate ?? today, { weekStartsOn: 1 })
    const end = endOfWeek(focusedDate ?? today, { weekStartsOn: 1 })
    return filteredItems.filter((item) => {
      const startDate = parseDate(item.start_date)
      const endDate = parseDate(item.end_date) ?? startDate
      if (!startDate && !endDate) return false

      const targetStart = startDate ?? endDate!
      const targetEnd = endDate ?? startDate!
      return (
        isWithinInterval(targetStart, { start, end }) ||
        isWithinInterval(targetEnd, { start, end }) ||
        (isBefore(targetStart, start) && isAfter(targetEnd, end))
      )
    })
  }, [filteredItems, focusedDate, today])

  const focusedDayItems = useMemo(() => {
    if (!focusedDate) return []
    return dayBuckets[dateKey(focusedDate)] ?? []
  }, [dayBuckets, focusedDate])

  const dueThisWeekCount = thisWeekItems.length

  const timelineItems = filteredItems.filter((item) => item.start_date || item.end_date)
  const totalDays = Math.max(1, differenceInCalendarDays(timelineEnd, today))

  async function handleCreate(values: ScheduleItemInput) {
    setIsSubmitting(true)
    try {
      const formattedValues = {
        ...values,
        start_date: dateRange?.from ? format(dateRange.from, "yyyy-MM-dd") : "",
        end_date: dateRange?.to ? format(dateRange.to, "yyyy-MM-dd") : "",
      }
      const created = await createScheduleItemAction(formattedValues)
      setItems((prev) => [created, ...prev])
      createForm.reset({
        name: "",
        project_id: projects[0]?.id ?? "",
        item_type: "task",
        status: "planned",
        start_date: "",
        end_date: "",
        dependencies: [],
        notes: "",
      })
      setDateRange(undefined)
      toast.success("Schedule item created", { description: created.name })
      setSheetOpen(false)
    } catch (error) {
      console.error(error)
      toast.error("Error creating schedule item", { description: "Please try again." })
    } finally {
      setIsSubmitting(false)
    }
  }

  function markSaving(id: string, value: boolean) {
    setSavingIds((prev) => ({ ...prev, [id]: value }))
  }

  function updateLocal(updated: ScheduleItem) {
    setItems((prev) => prev.map((item) => (item.id === updated.id ? updated : item)))
  }

  async function handleStatusChange(itemId: string, status: string) {
    markSaving(itemId, true)
    startTransition(async () => {
      try {
        const updated = await updateScheduleItemAction(itemId, { status })
        updateLocal(updated)
      } catch (error) {
        console.error(error)
        toast.error("Failed to update status")
      } finally {
        markSaving(itemId, false)
      }
    })
  }

  async function handleProgressChange(itemId: string, progress: number) {
    markSaving(itemId, true)
    startTransition(async () => {
      try {
        const updated = await updateScheduleItemAction(itemId, { progress })
        updateLocal(updated)
      } catch (error) {
        console.error(error)
        toast.error("Failed to update progress")
      } finally {
        markSaving(itemId, false)
      }
    })
  }

function barPosition(start?: string, end?: string) {
  const startDate = parseDate(start) ?? today
  const endDate = parseDate(end) ?? startDate
  const startDelta = Math.max(0, differenceInCalendarDays(startDate, today))
  const endDelta = Math.max(startDelta + 1, differenceInCalendarDays(endDate, today) + 1)
  const left = Math.min(100, (startDelta / totalDays) * 100)
  const width = Math.min(100 - left, ((endDelta - startDelta) / totalDays) * 100)
  return { left, width: Math.max(width, 4) }
}

interface DateRangePickerProps {
  dateRange?: DateRange
  onDateRangeChange: (range: DateRange | undefined) => void
  placeholder?: string
}

function DateRangePicker({ dateRange, onDateRangeChange, placeholder = "Pick a date range" }: DateRangePickerProps) {
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
                {format(dateRange.from, "LLL dd, y")} -{" "}
                {format(dateRange.to, "LLL dd, y")}
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

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <p className="text-sm text-muted-foreground">Sequence-critical schedule with dependencies and field cues</p>
          <h1 className="text-2xl font-bold mt-1">Schedule</h1>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" className="hidden sm:inline-flex">
            <CalendarDays className="mr-2 h-4 w-4" />
            Export calendar
          </Button>
          <Sheet open={sheetOpen} onOpenChange={setSheetOpen}>
            <SheetTrigger asChild>
              <Button>
                <Plus className="mr-2 h-4 w-4" />
                New item
              </Button>
            </SheetTrigger>
            <SheetContent
              side="right"
              className="sm:max-w-lg w-full max-w-md ml-auto mr-4 mt-4 h-[calc(100vh-2rem)] rounded-lg border shadow-2xl flex flex-col fast-sheet-animation"
              style={{
                animationDuration: '150ms',
                transitionDuration: '150ms'
              } as React.CSSProperties}
            >
              <div className="flex-1 overflow-y-auto px-4">
                <div className="pt-6 pb-4">
                  <h2 className="text-lg font-semibold leading-none tracking-tight">New schedule item</h2>
                  <p className="text-sm text-muted-foreground">Capture sequencing, dates, and dependencies without leaving the schedule.</p>
                </div>
                <Form {...createForm}>
                  <form onSubmit={createForm.handleSubmit(handleCreate)} className="space-y-4">
                    <FormField
                      control={createForm.control}
                      name="name"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel>Title</FormLabel>
                          <FormControl>
                            <Input placeholder="Rough-in inspection" {...field} />
                          </FormControl>
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                    <FormField
                      control={createForm.control}
                      name="project_id"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel>Project</FormLabel>
                          <Select onValueChange={field.onChange} value={field.value}>
                            <FormControl>
                              <SelectTrigger className="w-full">
                                <SelectValue placeholder="Pick a project" />
                              </SelectTrigger>
                            </FormControl>
                            <SelectContent>
                              {projects.map((project) => (
                                <SelectItem key={project.id} value={project.id}>
                                  {project.name}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                    <div className="grid grid-cols-2 gap-3">
                      <FormField
                        control={createForm.control}
                        name="item_type"
                        render={({ field }) => (
                          <FormItem>
                            <FormLabel>Type</FormLabel>
                            <Select onValueChange={field.onChange} value={field.value}>
                              <FormControl>
                                <SelectTrigger className="w-full">
                                  <SelectValue placeholder="Type" />
                                </SelectTrigger>
                              </FormControl>
                              <SelectContent>
                                {itemTypeOptions.map((type) => (
                                  <SelectItem key={type} value={type}>
                                    {type}
                                  </SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                            <FormMessage />
                          </FormItem>
                        )}
                      />
                      <FormField
                        control={createForm.control}
                        name="status"
                        render={({ field }) => (
                          <FormItem>
                            <FormLabel>Status</FormLabel>
                            <Select onValueChange={field.onChange} value={field.value}>
                              <FormControl>
                                <SelectTrigger className="w-full">
                                  <SelectValue placeholder="Status" />
                                </SelectTrigger>
                              </FormControl>
                              <SelectContent>
                                {statusOptions.map((status) => (
                                  <SelectItem key={status.value} value={status.value}>
                                    {status.label}
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
                      control={createForm.control}
                      name="start_date"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel>Date Range</FormLabel>
                          <FormControl>
                            <DateRangePicker
                              dateRange={dateRange}
                              onDateRangeChange={setDateRange}
                              placeholder="Pick date range"
                            />
                          </FormControl>
                          <FormMessage />
                        </FormItem>
                      )}
                    />


                    <FormField
                      control={createForm.control}
                      name="dependencies"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel>Dependencies</FormLabel>
                          <FormDescription>Select prerequisites across any project.</FormDescription>
                          <FormControl>
                            <ScrollArea className="h-32 rounded-md border p-2">
                              <div className="space-y-2">
                                {items.map((item) => (
                                  <Label key={item.id} className="flex items-center gap-2 text-sm font-normal">
                                    <Checkbox
                                      checked={field.value?.includes(item.id)}
                                      onCheckedChange={(checked) => {
                                        const current = field.value ?? []
                                        const next = checked ? [...current, item.id] : current.filter((id) => id !== item.id)
                                        field.onChange(next)
                                      }}
                                    />
                                    <span className="truncate">{item.name}</span>
                                  </Label>
                                ))}
                                {items.length === 0 && <p className="text-xs text-muted-foreground">No existing items yet.</p>}
                              </div>
                            </ScrollArea>
                          </FormControl>
                          <FormMessage />
                        </FormItem>
                      )}
                    />

                    <FormField
                      control={createForm.control}
                      name="notes"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel>Notes</FormLabel>
                          <FormControl>
                            <Textarea
                              placeholder="Add any additional notes or details..."
                              className="min-h-[80px] resize-none"
                              {...field}
                            />
                          </FormControl>
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                  </form>
                </Form>
              </div>
              <div className="flex-shrink-0 border-t bg-background p-4">
                <div className="flex gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => {
                      createForm.reset({
                        name: "",
                        project_id: projects[0]?.id ?? "",
                        item_type: "task",
                        status: "planned",
                        start_date: "",
                        end_date: "",
                        dependencies: [],
                        notes: "",
                      })
                      setDateRange(undefined)
                      setSheetOpen(false)
                    }}
                    className="flex-1"
                  >
                    Cancel
                  </Button>
                  <Button
                    type="submit"
                    disabled={isSubmitting}
                    className="flex-1"
                    onClick={createForm.handleSubmit(handleCreate)}
                  >
                    {isSubmitting ? "Saving..." : "Create item"}
                  </Button>
                </div>
              </div>
            </SheetContent>
          </Sheet>
        </div>
      </div>

      <div className="grid gap-4 md:grid-cols-3">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">At risk or blocked</CardTitle>
            <AlertCircle className="h-4 w-4 text-warning" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{atRiskItems.length}</div>
            <p className="text-xs text-muted-foreground mt-1">
              Items needing attention now — sorted by dependencies and proximity.
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Due this week</CardTitle>
            <Clock className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{dueThisWeekCount}</div>
            <p className="text-xs text-muted-foreground mt-1">Includes inspections and milestones within 7 days.</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Completion rate</CardTitle>
            <CheckCircle className="h-4 w-4 text-emerald-500" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{completedPercentage}%</div>
            <Progress value={completedPercentage} className="mt-3" />
            <p className="text-xs text-muted-foreground mt-1">Projects stay green when dependencies are cleared early.</p>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader className="pb-0">
          <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
            <div className="flex flex-wrap items-center gap-3">
              <Select value={projectFilter} onValueChange={setProjectFilter}>
                <SelectTrigger className="w-[180px]">
                  <SelectValue placeholder="All projects" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All projects</SelectItem>
                  {projects.map((project) => (
                    <SelectItem key={project.id} value={project.id}>
                      {project.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Select value={timeframe} onValueChange={setTimeframe}>
                <SelectTrigger className="w-[150px]">
                  <SelectValue placeholder="Horizon" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="30">Next 30 days</SelectItem>
                  <SelectItem value="60">Next 60 days</SelectItem>
                  <SelectItem value="90">Next 90 days</SelectItem>
                  <SelectItem value="all">Full schedule</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <Tabs value={view} onValueChange={(val) => setView(val as "list" | "calendar")} className="md:w-auto w-full">
              <TabsList className="w-full md:w-auto">
                <TabsTrigger value="list" className="flex-1 md:flex-none">
                  List view
                </TabsTrigger>
                <TabsTrigger value="calendar" className="flex-1 md:flex-none">
                  Calendar
                </TabsTrigger>
              </TabsList>
            </Tabs>
          </div>
        </CardHeader>
        <CardContent>
          <Tabs value={view} onValueChange={(val) => setView(val as "list" | "calendar")}>
            <TabsContent value="list" className="pt-4">
              <div className="rounded-lg border">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Item</TableHead>
                      <TableHead>Project</TableHead>
                      <TableHead>Type</TableHead>
                      <TableHead>Dates</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead className="w-[200px]">Progress</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {filteredItems.map((item) => {
                      const status = normalizeStatus(item.status)
                      const badgeClass = statusClasses[status] ?? statusClasses.planned
                      const projectName = projectLookup[item.project_id] ?? "Unknown project"
                      const progressValue = item.progress ?? 0
                      return (
                        <TableRow
                          key={item.id}
                          className={cn(isOverdue(item, today) ? "border-l-2 border-destructive/60" : undefined)}
                        >
                          <TableCell>
                            <div className="space-y-1">
                              <div className="flex items-center gap-2">
                                <Badge variant="outline" className="rounded-full">
                                  {item.item_type}
                                </Badge>
                                <p className="font-medium leading-tight">{item.name}</p>
                              </div>
                              <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                                {item.dependencies?.length ? (
                                  <Badge variant="secondary" className="text-[11px]">
                                    {item.dependencies.length} dependency{item.dependencies.length > 1 ? "ies" : ""}
                                  </Badge>
                                ) : null}
                                {isOverdue(item, today) && <span className="text-destructive">Overdue</span>}
                              </div>
                            </div>
                          </TableCell>
                          <TableCell className="text-muted-foreground">{projectName}</TableCell>
                          <TableCell className="capitalize">{item.item_type}</TableCell>
                          <TableCell className="text-muted-foreground text-sm">
                            {formatDateRange(item.start_date, item.end_date)}
                          </TableCell>
                          <TableCell>
                            <Select
                              value={status}
                              onValueChange={(val) => handleStatusChange(item.id, val)}
                              disabled={savingIds[item.id] || isPending}
                            >
                              <SelectTrigger className="w-[140px]">
                                <SelectValue />
                              </SelectTrigger>
                              <SelectContent>
                                {statusOptions.map((option) => (
                                  <SelectItem key={option.value} value={option.value}>
                                    {option.label}
                                  </SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                          </TableCell>
                          <TableCell>
                            <div className="space-y-2">
                              <Slider
                                value={[progressValue]}
                                onValueCommit={(val) => handleProgressChange(item.id, val[0])}
                                max={100}
                                step={5}
                                disabled={savingIds[item.id] || isPending}
                              />
                              <div className="flex items-center justify-between text-xs text-muted-foreground">
                                <span>{progressValue}%</span>
                                {isAtRisk(item, today) && <span className="text-warning">Needs push</span>}
                              </div>
                            </div>
                          </TableCell>
                        </TableRow>
                      )
                    })}
                    {filteredItems.length === 0 && (
                      <TableRow>
                        <TableCell colSpan={6} className="text-center py-10 text-muted-foreground">
                          No schedule items for this view yet.
                        </TableCell>
                      </TableRow>
                    )}
                  </TableBody>
                </Table>
              </div>

              <div className="mt-6 rounded-lg border p-4">
                <div className="flex items-center justify-between mb-3">
                  <div>
                    <p className="text-xs text-muted-foreground">Dependency map</p>
                    <h4 className="font-semibold">Mini Gantt</h4>
                  </div>
                  <Badge variant="outline">{timelineItems.length} items</Badge>
                </div>
                <div className="space-y-3">
                  {timelineItems.map((item) => {
                    const { left, width } = barPosition(item.start_date, item.end_date)
                    return (
                      <div key={item.id} className="space-y-1">
                        <div className="flex items-center justify-between text-xs text-muted-foreground">
                          <span className="font-medium text-foreground">{item.name}</span>
                          <span>{formatDateRange(item.start_date, item.end_date)}</span>
                        </div>
                        <div className="relative h-3 rounded-md bg-muted">
                          <div
                            className="absolute inset-y-0 rounded-md bg-primary/80"
                            style={{ left: `${left}%`, width: `${width}%` }}
                          />
                          {item.dependencies?.length ? (
                            <span className="absolute right-1 top-1/2 -translate-y-1/2 text-[11px] text-background">
                              ↳ {item.dependencies.length} deps
                            </span>
                          ) : null}
                        </div>
                      </div>
                    )
                  })}
                  {timelineItems.length === 0 && (
                    <p className="text-sm text-muted-foreground">Add dates to see the sequence visualization.</p>
                  )}
                </div>
              </div>
            </TabsContent>

            <TabsContent value="calendar" className="pt-4">
              <div className="grid gap-6 lg:grid-cols-2">
                <div className="rounded-lg border p-3">
                  <Calendar
                    mode="single"
                    selected={focusedDate}
                    onSelect={(date) => setFocusedDate(date ?? today)}
                    modifiers={{ busy: busyDates }}
                    modifiersClassNames={{
                      busy: "data-[selected=false]:bg-primary/10 data-[selected=false]:text-primary",
                    }}
                  />
                </div>
                <div className="space-y-4">
                  <div className="flex items-center justify-between">
                    <div>
                      <p className="text-xs text-muted-foreground">Day plan</p>
                      <h3 className="text-lg font-semibold">
                        {focusedDate ? format(focusedDate, "EEEE, MMM d") : "Select a day"}
                      </h3>
                    </div>
                    <Badge variant="outline">{focusedDayItems.length} items</Badge>
                  </div>

                  <div className="space-y-3">
                    {focusedDayItems.map((item) => {
                      const status = normalizeStatus(item.status)
                      const badgeClass = statusClasses[status] ?? statusClasses.planned
                      const projectName = projectLookup[item.project_id] ?? "Unknown project"
                      const progressValue = item.progress ?? 0
                      return (
                        <div key={item.id} className="rounded-lg border p-3">
                          <div className="flex items-start justify-between gap-3">
                            <div>
                              <p className="font-medium leading-tight">{item.name}</p>
                              <p className="text-xs text-muted-foreground mt-1">
                                {projectName} • {item.item_type}
                              </p>
                            </div>
                            <Badge className={cn("capitalize", badgeClass)}>{formatStatus(item.status)}</Badge>
                          </div>
                          <div className="mt-3 space-y-2">
                            <div className="flex items-center justify-between text-xs text-muted-foreground">
                              <span>{formatDateRange(item.start_date, item.end_date)}</span>
                              {item.dependencies?.length ? <span>{item.dependencies.length} prereq(s)</span> : null}
                            </div>
                            <Progress value={progressValue} />
                          </div>
                        </div>
                      )
                    })}
                    {focusedDayItems.length === 0 && (
                      <Card className="border-dashed">
                        <CardContent className="py-8 text-center text-sm text-muted-foreground">
                          No scheduled work on this day yet.
                        </CardContent>
                      </Card>
                    )}
                  </div>

                  <div className="rounded-lg border p-3">
                    <div className="flex items-center justify-between mb-3">
                      <div>
                        <p className="text-xs text-muted-foreground">This week</p>
                        <h4 className="font-semibold">Sequenced items</h4>
                      </div>
                      <Badge variant="secondary">{thisWeekItems.length}</Badge>
                    </div>
                    <div className="space-y-3">
                      {thisWeekItems.map((item) => (
                        <div key={item.id} className="flex items-start justify-between gap-3">
                          <div>
                            <p className="font-medium leading-tight">{item.name}</p>
                            <p className="text-xs text-muted-foreground">
                              {projectLookup[item.project_id] ?? "Unknown project"} • {formatDateRange(item.start_date, item.end_date)}
                            </p>
                          </div>
                          {isOverdue(item, today) ? (
                            <Badge variant="destructive">Overdue</Badge>
                          ) : (
                            <Badge variant="outline">{formatStatus(item.status)}</Badge>
                          )}
                        </div>
                      ))}
                      {thisWeekItems.length === 0 && (
                        <p className="text-sm text-muted-foreground">
                          Nothing scheduled this week — pull items forward to stay ahead.
                        </p>
                      )}
                    </div>
                  </div>
                </div>
              </div>
            </TabsContent>
          </Tabs>
        </CardContent>
      </Card>
    </div>
  )
}
