"use client"

import { useState, useRef, useEffect } from "react"
import { format, isAfter, subDays } from "date-fns"
import { toast } from "sonner"

import type { DailyLog, ScheduleItem, Task } from "@/lib/types"
import type { FileCategory, ProjectPunchItem } from "@/app/(app)/projects/[id]/actions"
import type { DailyLogEntryInput, DailyLogInput } from "@/lib/validation/daily-logs"
import { cn } from "@/lib/utils"

import { Button } from "@/components/ui/button"
import { Calendar } from "@/components/ui/calendar"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Input } from "@/components/ui/input"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  Drawer,
  DrawerContent,
  DrawerTrigger,
} from "@/components/ui/drawer"
import {
  CalendarDays,
  Plus,
  Camera,
  Send,
  X,
  ChevronDown,
  ClipboardList,
  CheckCircle2,
  FileText,
  Hammer,
} from "@/components/icons"

const weatherOptions = [
  { value: "Sunny", emoji: "☀️" },
  { value: "Partly Cloudy", emoji: "⛅" },
  { value: "Cloudy", emoji: "☁️" },
  { value: "Light Rain", emoji: "🌧️" },
  { value: "Heavy Rain", emoji: "⛈️" },
  { value: "Snow", emoji: "❄️" },
  { value: "Windy", emoji: "💨" },
  { value: "Hot", emoji: "🔥" },
  { value: "Cold", emoji: "🥶" },
]

interface QuickLogEntryProps {
  projectId: string
  scheduleItems: ScheduleItem[]
  tasks: Task[]
  punchItems: ProjectPunchItem[]
  onCreateLog: (values: DailyLogInput) => Promise<DailyLog>
  onUploadFiles: (
    files: File[],
    context?: {
      category?: FileCategory
      dailyLogId?: string
      scheduleItemId?: string
      tags?: string[]
    },
  ) => Promise<void>
  trigger?: React.ReactNode
}

type DateOption = "today" | "yesterday" | "custom"

type WorkEntryDraft = {
  id: string
  schedule_item_id?: string
  description: string
  hours: string
  progress: string
  location?: string
  trade?: string
}

type InspectionEntryDraft = {
  id: string
  schedule_item_id?: string
  result?: "pass" | "fail" | "partial" | "n_a"
  notes: string
}

type TaskUpdateDraft = {
  id: string
  task_id?: string
  mark_complete: boolean
}

type PunchUpdateDraft = {
  id: string
  punch_item_id?: string
  mark_closed: boolean
}

function createDraftId() {
  return `draft-${Date.now()}-${Math.random().toString(16).slice(2)}`
}

export function QuickLogEntry({
  projectId,
  scheduleItems,
  tasks,
  punchItems,
  onCreateLog,
  onUploadFiles,
  trigger,
}: QuickLogEntryProps) {
  const today = new Date()
  const fileInputRef = useRef<HTMLInputElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  // State
  const [open, setOpen] = useState(false)
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [summary, setSummary] = useState("")
  const [selectedWeather, setSelectedWeather] = useState<string>("")
  const [selectedDate, setSelectedDate] = useState<DateOption>("today")
  const [customDate, setCustomDate] = useState<Date | undefined>(undefined)
  const [selectedFiles, setSelectedFiles] = useState<File[]>([])
  const [showDatePicker, setShowDatePicker] = useState(false)

  // Detailed entries - collapsed by default
  const [showDetailedEntries, setShowDetailedEntries] = useState(false)
  const [workItems, setWorkItems] = useState<WorkEntryDraft[]>([])
  const [inspectionItems, setInspectionItems] = useState<InspectionEntryDraft[]>([])
  const [taskUpdates, setTaskUpdates] = useState<TaskUpdateDraft[]>([])
  const [punchUpdates, setPunchUpdates] = useState<PunchUpdateDraft[]>([])

  // Auto-resize textarea
  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.style.height = "auto"
      textareaRef.current.style.height = `${Math.min(textareaRef.current.scrollHeight, 150)}px`
    }
  }, [summary])

  // Focus textarea when drawer opens
  useEffect(() => {
    if (open && textareaRef.current) {
      setTimeout(() => textareaRef.current?.focus(), 100)
    }
  }, [open])

  // Get actual date value
  function getDateValue(): string {
    if (selectedDate === "today") {
      return format(today, "yyyy-MM-dd")
    } else if (selectedDate === "yesterday") {
      return format(subDays(today, 1), "yyyy-MM-dd")
    } else if (customDate) {
      return format(customDate, "yyyy-MM-dd")
    }
    return format(today, "yyyy-MM-dd")
  }

  // Reset form
  function resetForm() {
    setSummary("")
    setSelectedWeather("")
    setSelectedDate("today")
    setCustomDate(undefined)
    setSelectedFiles([])
    setShowDetailedEntries(false)
    setWorkItems([])
    setInspectionItems([])
    setTaskUpdates([])
    setPunchUpdates([])
  }

  function buildEntries(): DailyLogEntryInput[] {
    const entries: DailyLogEntryInput[] = []

    for (const item of workItems) {
      if (!item.schedule_item_id && !item.description.trim() && !item.hours && !item.progress) continue
      const hoursValue = item.hours ? Number(item.hours) : undefined
      const progressValue = item.progress ? Number(item.progress) : undefined
      entries.push({
        entry_type: "work",
        description: item.description.trim() || undefined,
        hours: Number.isFinite(hoursValue) ? hoursValue : undefined,
        progress: Number.isFinite(progressValue) ? progressValue : undefined,
        schedule_item_id: item.schedule_item_id || undefined,
        location: item.location || undefined,
        trade: item.trade || undefined,
      })
    }

    for (const item of inspectionItems) {
      if (!item.schedule_item_id && !item.notes.trim() && !item.result) continue
      entries.push({
        entry_type: "inspection",
        description: item.notes.trim() || undefined,
        schedule_item_id: item.schedule_item_id || undefined,
        inspection_result: item.result ?? undefined,
      })
    }

    for (const item of taskUpdates) {
      if (!item.task_id) continue
      entries.push({
        entry_type: "task_update",
        task_id: item.task_id,
        metadata: { mark_complete: item.mark_complete },
      })
    }

    for (const item of punchUpdates) {
      if (!item.punch_item_id) continue
      entries.push({
        entry_type: "punch_update",
        punch_item_id: item.punch_item_id,
        metadata: { mark_closed: item.mark_closed },
      })
    }

    return entries
  }

  // Handle submit
  async function handleSubmit() {
    const entries = buildEntries()
    const hasLogContent = Boolean(summary.trim() || selectedWeather || entries.length > 0)

    if (!hasLogContent && selectedFiles.length === 0) {
      return
    }

    setIsSubmitting(true)
    try {
      let createdLog: DailyLog | null = null

      if (hasLogContent || selectedFiles.length > 0) {
        createdLog = await onCreateLog({
          project_id: projectId,
          date: getDateValue(),
          summary: summary.trim(),
          weather: selectedWeather || undefined,
          entries,
        })
      }

      if (selectedFiles.length > 0 && createdLog) {
        await onUploadFiles(selectedFiles, {
          dailyLogId: createdLog.id,
          category: "photos",
        })
      }

      if (selectedFiles.length > 0 && !hasLogContent) {
        toast.success(`${selectedFiles.length} photo${selectedFiles.length > 1 ? "s" : ""} uploaded`)
      } else {
        toast.success("Log added")
      }

      resetForm()
      setOpen(false)
    } catch (error) {
      console.error(error)
      toast.error("Failed to add log")
    } finally {
      setIsSubmitting(false)
    }
  }

  // Handle file selection
  function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    if (e.target.files) {
      setSelectedFiles(prev => [...prev, ...Array.from(e.target.files!)])
    }
    e.target.value = ""
  }

  function removeFile(index: number) {
    setSelectedFiles(prev => prev.filter((_, i) => i !== index))
  }

  function addWorkItem() {
    setWorkItems((prev) => [
      ...prev,
      { id: createDraftId(), description: "", hours: "", progress: "" },
    ])
  }

  function updateWorkItem(id: string, patch: Partial<WorkEntryDraft>) {
    setWorkItems((prev) => prev.map((item) => (item.id === id ? { ...item, ...patch } : item)))
  }

  function removeWorkItem(id: string) {
    setWorkItems((prev) => prev.filter((item) => item.id !== id))
  }

  function addInspectionItem() {
    setInspectionItems((prev) => [
      ...prev,
      { id: createDraftId(), notes: "" },
    ])
  }

  function updateInspectionItem(id: string, patch: Partial<InspectionEntryDraft>) {
    setInspectionItems((prev) => prev.map((item) => (item.id === id ? { ...item, ...patch } : item)))
  }

  function removeInspectionItem(id: string) {
    setInspectionItems((prev) => prev.filter((item) => item.id !== id))
  }

  function addTaskUpdate() {
    setTaskUpdates((prev) => [
      ...prev,
      { id: createDraftId(), mark_complete: true },
    ])
  }

  function updateTaskUpdate(id: string, patch: Partial<TaskUpdateDraft>) {
    setTaskUpdates((prev) => prev.map((item) => (item.id === id ? { ...item, ...patch } : item)))
  }

  function removeTaskUpdate(id: string) {
    setTaskUpdates((prev) => prev.filter((item) => item.id !== id))
  }

  function addPunchUpdate() {
    setPunchUpdates((prev) => [
      ...prev,
      { id: createDraftId(), mark_closed: true },
    ])
  }

  function updatePunchUpdate(id: string, patch: Partial<PunchUpdateDraft>) {
    setPunchUpdates((prev) => prev.map((item) => (item.id === id ? { ...item, ...patch } : item)))
  }

  function removePunchUpdate(id: string) {
    setPunchUpdates((prev) => prev.filter((item) => item.id !== id))
  }

  const structuredEntryCount = buildEntries().length
  const canSubmit = Boolean(
    summary.trim() ||
    selectedFiles.length > 0 ||
    selectedWeather ||
    structuredEntryCount > 0
  )

  return (
    <Drawer open={open} onOpenChange={setOpen}>
      <DrawerTrigger asChild>
        {trigger || (
          <Button size="sm" className="gap-2">
            <Plus className="h-4 w-4" />
            <span className="hidden sm:inline">New Entry</span>
          </Button>
        )}
      </DrawerTrigger>
      <DrawerContent className="mx-auto max-w-lg outline-none flex flex-col max-h-[90vh]">
        {/* Scrollable content area */}
        <div className="flex-1 overflow-y-auto p-4 pb-4">
          {/* Header with date selector */}
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-1">
              <button
                type="button"
                onClick={() => {
                  setSelectedDate("today")
                  setCustomDate(undefined)
                }}
                className={cn(
                  "px-3 py-1.5 text-xs font-medium rounded-full transition-colors",
                  selectedDate === "today"
                    ? "bg-primary text-primary-foreground"
                    : "bg-muted text-muted-foreground hover:bg-muted/80"
                )}
              >
                Today
              </button>
              <button
                type="button"
                onClick={() => {
                  setSelectedDate("yesterday")
                  setCustomDate(undefined)
                }}
                className={cn(
                  "px-3 py-1.5 text-xs font-medium rounded-full transition-colors",
                  selectedDate === "yesterday"
                    ? "bg-primary text-primary-foreground"
                    : "bg-muted text-muted-foreground hover:bg-muted/80"
                )}
              >
                Yesterday
              </button>

              <Popover open={showDatePicker} onOpenChange={setShowDatePicker}>
                <PopoverTrigger asChild>
                  <button
                    type="button"
                    className={cn(
                      "flex items-center gap-1 px-3 py-1.5 text-xs font-medium rounded-full transition-colors",
                      selectedDate === "custom"
                        ? "bg-primary text-primary-foreground"
                        : "bg-muted text-muted-foreground hover:bg-muted/80"
                    )}
                  >
                    <CalendarDays className="h-3 w-3" />
                    {selectedDate === "custom" && customDate ? (
                      format(customDate, "MMM d")
                    ) : (
                      "Pick"
                    )}
                  </button>
                </PopoverTrigger>
                <PopoverContent className="w-auto p-0" align="start">
                  <Calendar
                    mode="single"
                    selected={customDate}
                    onSelect={(date) => {
                      if (date) {
                        setCustomDate(date)
                        setSelectedDate("custom")
                        setShowDatePicker(false)
                      }
                    }}
                    disabled={(date) => isAfter(date, today)}
                    initialFocus
                  />
                </PopoverContent>
              </Popover>
            </div>
          </div>

          {/* Weather chips */}
          <div className="mb-4">
            <div className="flex gap-1.5 overflow-x-auto sm:overflow-x-visible sm:flex-wrap pb-2 sm:pb-0 -mx-1 px-1 sm:mx-0 sm:px-0 hide-scrollbar">
              {weatherOptions.map(({ value, emoji }) => (
                <button
                  key={value}
                  type="button"
                  onClick={() => setSelectedWeather(selectedWeather === value ? "" : value)}
                  className={cn(
                    "flex-shrink-0 sm:flex-shrink flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-full border transition-colors",
                    selectedWeather === value
                      ? "border-primary bg-primary/10 text-primary"
                      : "border-border bg-background text-muted-foreground hover:border-muted-foreground/50"
                  )}
                >
                  <span>{emoji}</span>
                  <span className="hidden sm:inline">{value}</span>
                </button>
              ))}
            </div>
          </div>

          {/* Main text input */}
          <div className="relative bg-muted/30 rounded-lg border focus-within:border-muted-foreground/40 transition-colors mb-3">
            <textarea
              ref={textareaRef}
              value={summary}
              onChange={(e) => setSummary(e.target.value)}
              placeholder="What happened on site today?"
              className="w-full bg-transparent resize-none px-4 py-3 text-sm placeholder:text-muted-foreground focus:outline-none min-h-[80px]"
              rows={1}
            />
          </div>

          {/* Photo previews */}
          {selectedFiles.length > 0 && (
            <div className="mb-4">
              <div className="flex gap-2 overflow-x-auto pb-2 -mx-1 px-1 hide-scrollbar">
                {selectedFiles.map((file, index) => (
                  <div
                    key={index}
                    className="relative flex-shrink-0 w-16 h-16 rounded-lg overflow-hidden bg-muted"
                  >
                    <img
                      src={URL.createObjectURL(file)}
                      alt={`Preview ${index + 1}`}
                      className="w-full h-full object-cover"
                    />
                    <button
                      type="button"
                      onClick={() => removeFile(index)}
                      className="absolute top-1 right-1 w-5 h-5 bg-black/60 rounded-full flex items-center justify-center hover:bg-black/80 transition-colors"
                    >
                      <X className="h-3 w-3 text-white" />
                    </button>
                  </div>
                ))}
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  className="flex-shrink-0 w-16 h-16 rounded-lg border-2 border-dashed border-muted-foreground/25 flex flex-col items-center justify-center text-muted-foreground hover:border-muted-foreground/40 hover:bg-muted/50 transition-colors"
                >
                  <Plus className="h-4 w-4" />
                </button>
              </div>
            </div>
          )}

          {/* Detailed entries toggle */}
          <button
            type="button"
            onClick={() => setShowDetailedEntries(!showDetailedEntries)}
            className="w-full flex items-center justify-between py-3 text-sm text-muted-foreground hover:text-foreground transition-colors"
          >
            <span className="flex items-center gap-2">
              <ClipboardList className="h-4 w-4" />
              {showDetailedEntries ? "Hide detailed entries" : "Add detailed entries"}
              {structuredEntryCount > 0 && (
                <span className="px-1.5 py-0.5 text-xs bg-primary/10 text-primary rounded-full">
                  {structuredEntryCount}
                </span>
              )}
            </span>
            <ChevronDown className={cn(
              "h-4 w-4 transition-transform",
              showDetailedEntries && "rotate-180"
            )} />
          </button>

          {/* Detailed entries section - collapsible */}
          {showDetailedEntries && (
            <div className="space-y-4 pt-2 border-t">
              {/* Work performed */}
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
                    <ClipboardList className="h-3.5 w-3.5" />
                    Work Performed
                  </div>
                  <Button type="button" size="sm" variant="ghost" className="h-6 text-xs px-2" onClick={addWorkItem}>
                    + Add
                  </Button>
                </div>
                {workItems.map((item) => (
                  <div key={item.id} className="rounded-lg border p-2 space-y-2">
                    <div className="grid gap-2 sm:grid-cols-2">
                      <Select
                        value={item.schedule_item_id ?? ""}
                        onValueChange={(value) => {
                          const scheduleItem = scheduleItems.find((candidate) => candidate.id === value)
                          updateWorkItem(item.id, {
                            schedule_item_id: value,
                            trade: scheduleItem?.trade ?? item.trade,
                            location: scheduleItem?.location ?? item.location,
                          })
                        }}
                      >
                        <SelectTrigger className="h-8 text-xs">
                          <SelectValue placeholder="Schedule item" />
                        </SelectTrigger>
                        <SelectContent>
                          {scheduleItems.map((scheduleItem) => (
                            <SelectItem key={scheduleItem.id} value={scheduleItem.id}>
                              {scheduleItem.name}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <Input
                        value={item.description}
                        onChange={(event) => updateWorkItem(item.id, { description: event.target.value })}
                        placeholder="Work summary"
                        className="h-8 text-xs"
                      />
                    </div>
                    <div className="grid gap-2 grid-cols-4">
                      <Input
                        value={item.hours}
                        onChange={(event) => updateWorkItem(item.id, { hours: event.target.value })}
                        placeholder="Hrs"
                        type="number"
                        min="0"
                        className="h-8 text-xs"
                      />
                      <Input
                        value={item.progress}
                        onChange={(event) => updateWorkItem(item.id, { progress: event.target.value })}
                        placeholder="%"
                        type="number"
                        min="0"
                        max="100"
                        className="h-8 text-xs"
                      />
                      <Input
                        value={item.trade ?? ""}
                        onChange={(event) => updateWorkItem(item.id, { trade: event.target.value })}
                        placeholder="Trade"
                        className="h-8 text-xs"
                      />
                      <Input
                        value={item.location ?? ""}
                        onChange={(event) => updateWorkItem(item.id, { location: event.target.value })}
                        placeholder="Location"
                        className="h-8 text-xs"
                      />
                    </div>
                    <div className="flex justify-end">
                      <button type="button" className="text-xs text-muted-foreground hover:text-destructive" onClick={() => removeWorkItem(item.id)}>
                        Remove
                      </button>
                    </div>
                  </div>
                ))}
              </div>

              {/* Inspections */}
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
                    <CheckCircle2 className="h-3.5 w-3.5" />
                    Inspections
                  </div>
                  <Button type="button" size="sm" variant="ghost" className="h-6 text-xs px-2" onClick={addInspectionItem}>
                    + Add
                  </Button>
                </div>
                {inspectionItems.map((item) => (
                  <div key={item.id} className="rounded-lg border p-2 space-y-2">
                    <div className="grid gap-2 sm:grid-cols-2">
                      <Select
                        value={item.schedule_item_id ?? ""}
                        onValueChange={(value) => updateInspectionItem(item.id, { schedule_item_id: value })}
                      >
                        <SelectTrigger className="h-8 text-xs">
                          <SelectValue placeholder="Inspection item" />
                        </SelectTrigger>
                        <SelectContent>
                          {scheduleItems.map((scheduleItem) => (
                            <SelectItem key={scheduleItem.id} value={scheduleItem.id}>
                              {scheduleItem.name}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <Select
                        value={item.result ?? ""}
                        onValueChange={(value) => updateInspectionItem(item.id, { result: value as InspectionEntryDraft["result"] })}
                      >
                        <SelectTrigger className="h-8 text-xs">
                          <SelectValue placeholder="Result" />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="pass">Pass</SelectItem>
                          <SelectItem value="fail">Fail</SelectItem>
                          <SelectItem value="partial">Partial</SelectItem>
                          <SelectItem value="n_a">N/A</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                    <textarea
                      value={item.notes}
                      onChange={(event) => updateInspectionItem(item.id, { notes: event.target.value })}
                      placeholder="Notes"
                      className="w-full min-h-[50px] resize-none rounded-lg border bg-muted/30 px-3 py-2 text-xs focus:outline-none"
                    />
                    <div className="flex justify-end">
                      <button type="button" className="text-xs text-muted-foreground hover:text-destructive" onClick={() => removeInspectionItem(item.id)}>
                        Remove
                      </button>
                    </div>
                  </div>
                ))}
              </div>

              {/* Task updates */}
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
                    <FileText className="h-3.5 w-3.5" />
                    Task Updates
                  </div>
                  <Button type="button" size="sm" variant="ghost" className="h-6 text-xs px-2" onClick={addTaskUpdate}>
                    + Add
                  </Button>
                </div>
                {taskUpdates.map((item) => (
                  <div key={item.id} className="rounded-lg border p-2 space-y-2">
                    <Select
                      value={item.task_id ?? ""}
                      onValueChange={(value) => updateTaskUpdate(item.id, { task_id: value })}
                    >
                      <SelectTrigger className="h-8 text-xs">
                        <SelectValue placeholder="Select task" />
                      </SelectTrigger>
                      <SelectContent>
                        {tasks.map((task) => (
                          <SelectItem key={task.id} value={task.id}>
                            {task.title}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <div className="flex items-center justify-between">
                      <label className="flex items-center gap-2 text-xs text-muted-foreground">
                        <input
                          type="checkbox"
                          checked={item.mark_complete}
                          onChange={(event) => updateTaskUpdate(item.id, { mark_complete: event.target.checked })}
                          className="rounded"
                        />
                        Mark complete
                      </label>
                      <button type="button" className="text-xs text-muted-foreground hover:text-destructive" onClick={() => removeTaskUpdate(item.id)}>
                        Remove
                      </button>
                    </div>
                  </div>
                ))}
              </div>

              {/* Punch updates */}
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
                    <Hammer className="h-3.5 w-3.5" />
                    Punch Updates
                  </div>
                  <Button type="button" size="sm" variant="ghost" className="h-6 text-xs px-2" onClick={addPunchUpdate}>
                    + Add
                  </Button>
                </div>
                {punchUpdates.map((item) => (
                  <div key={item.id} className="rounded-lg border p-2 space-y-2">
                    <Select
                      value={item.punch_item_id ?? ""}
                      onValueChange={(value) => updatePunchUpdate(item.id, { punch_item_id: value })}
                    >
                      <SelectTrigger className="h-8 text-xs">
                        <SelectValue placeholder="Select punch item" />
                      </SelectTrigger>
                      <SelectContent>
                        {punchItems.map((punch) => (
                          <SelectItem key={punch.id} value={punch.id}>
                            {punch.title}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <div className="flex items-center justify-between">
                      <label className="flex items-center gap-2 text-xs text-muted-foreground">
                        <input
                          type="checkbox"
                          checked={item.mark_closed}
                          onChange={(event) => updatePunchUpdate(item.id, { mark_closed: event.target.checked })}
                          className="rounded"
                        />
                        Mark closed
                      </label>
                      <button type="button" className="text-xs text-muted-foreground hover:text-destructive" onClick={() => removePunchUpdate(item.id)}>
                        Remove
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* Fixed footer */}
        <div className="flex-shrink-0 border-t bg-background px-4 py-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-1">
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                className="flex items-center gap-1.5 px-3 py-2 text-muted-foreground hover:text-foreground hover:bg-muted rounded-lg transition-colors"
              >
                <Camera className="h-4 w-4" />
                <span className="text-xs font-medium">Photo</span>
                {selectedFiles.length > 0 && (
                  <span className="text-xs text-primary">({selectedFiles.length})</span>
                )}
              </button>
              <input
                ref={fileInputRef}
                type="file"
                accept="image/*"
                multiple
                className="hidden"
                onChange={handleFileChange}
              />
            </div>

            <Button
              type="button"
              size="sm"
              disabled={!canSubmit || isSubmitting}
              onClick={handleSubmit}
              className="gap-2 px-4"
            >
              {isSubmitting ? (
                "Logging..."
              ) : (
                <>
                  <span>Log it</span>
                  <Send className="h-3.5 w-3.5" />
                </>
              )}
            </Button>
          </div>
        </div>
      </DrawerContent>
    </Drawer>
  )
}
