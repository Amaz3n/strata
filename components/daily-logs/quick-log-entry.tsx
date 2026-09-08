"use client"

import { useState, useRef, useEffect, useMemo } from "react"
import { format, isAfter, isSameDay, subDays } from "date-fns"
import { toast } from "sonner"

import type { DailyLog, ScheduleItem, Task } from "@/lib/types"
import type { FileCategory, ProjectPunchItem } from "@/app/(app)/projects/[id]/actions"
import type { DailyLogEntryInput, DailyLogInput } from "@/lib/validation/daily-logs"
import { cn } from "@/lib/utils"

import { dailyLogDraftStorage } from "@/lib/daily-logs/draft-storage"
import { useOfflineDailyLogs } from "@/lib/hooks/use-offline-daily-logs"
import { getCoordinatesFromAddress, getCurrentWeather } from "@/lib/utils/weather"
import { MentionTextarea, type MentionableUser } from "./mention-textarea"

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
import { Switch } from "@/components/ui/switch"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import {
  Drawer,
  DrawerContent,
  DrawerTrigger,
} from "@/components/ui/drawer"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import {
  CalendarDays,
  Plus,
  Camera,
  Paperclip,
  Send,
  X,
  ChevronDown,
  ClipboardList,
} from "@/components/icons"
import { LocationPicker } from "@/components/locations/location-picker"
import type { ProjectLocation } from "@/lib/services/locations"

const weatherOptions = [
  { value: "Sunny", emoji: "☀️" },
  { value: "Partly Cloudy", emoji: "⛅" },
  { value: "Cloudy", emoji: "☁️" },
  { value: "Light Rain", emoji: "🌧️" },
  { value: "Heavy Rain", emoji: "⛈️" },
  { value: "Windy", emoji: "💨" },
  { value: "Hot", emoji: "🔥" },
]

interface QuickLogEntryProps {
  projectId: string
  userId?: string
  projectAddress?: string
  scheduleItems: ScheduleItem[]
  tasks: Task[]
  punchItems: ProjectPunchItem[]
  locations: ProjectLocation[]
  canManageLocations: boolean
  mentionableUsers: MentionableUser[]
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
  /** Controlled open state. When provided, the internal trigger is not rendered unless `trigger` is passed. */
  open?: boolean
  onOpenChange?: (open: boolean) => void
  /** Pre-select this date when the composer opens (day-centric desktop flow). */
  defaultDate?: Date
  /**
   * Presentation shell. Mobile keeps the bottom `drawer`; the day-centric desktop
   * workspace uses a centered `dialog` (mirrors the platform issues composer).
   */
  variant?: "drawer" | "dialog" | "inline"
  onLoadContext?: () => Promise<void>
  contextLoading?: boolean
  contextError?: string | null
  onDraftPendingChange?: (pending: boolean) => void
}

type DateOption = "today" | "yesterday" | "custom"

type WorkEntryDraft = {
  id: string
  schedule_item_id?: string
  description: string
  hours: string
  progress: string
  location?: string
  location_id?: string
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

interface QuickLogDraft {
  summary: string
  weather: string
  date: string
  files: File[]
  mentionedUserIds: string[]
  activeDetails: string[]
  showDetailedEntries: boolean
  workItems: WorkEntryDraft[]
  inspectionItems: InspectionEntryDraft[]
  taskUpdates: TaskUpdateDraft[]
  punchUpdates: PunchUpdateDraft[]
  deliveriesText: string
  constraintsText: string
  safetyText: string
  submissionId: string | null
  createdLog: DailyLog | null
  uploadedFileIndexes?: number[]
  completed?: boolean
}

function createDraftId() {
  return `draft-${Date.now()}-${Math.random().toString(16).slice(2)}`
}

function weatherEmojiFor(condition: string): string {
  return weatherOptions.find((option) => option.value === condition)?.emoji ?? "🌤️"
}

// A section title with a quiet "Add" affordance — the repeating unit of the
// detailed-entries editor. Kept minimal and symmetric across every section.
function EntrySectionHeader({ label, onAdd }: { label: string; onAdd: () => void }) {
  return (
    <div className="flex items-center justify-between">
      <h4 className="text-[11px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">{label}</h4>
      <button
        type="button"
        onClick={onAdd}
        className="flex items-center gap-1 rounded-md px-1.5 py-1 text-xs font-medium text-primary transition-colors hover:bg-primary/10"
      >
        <Plus className="h-3.5 w-3.5" />
        Add
      </button>
    </div>
  )
}

// The uniform delete control for every entry card — a hairline icon button that
// sits in the top-right corner so cards stay symmetric.
function RemoveEntryButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label="Remove entry"
      className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive"
    >
      <X className="h-4 w-4" />
    </button>
  )
}

function canPreviewSelectedImage(file: File) {
  const lowerName = file.name.toLowerCase()
  const lowerType = file.type.toLowerCase()
  return !(
    lowerType === "image/heic" ||
    lowerType === "image/heif" ||
    lowerName.endsWith(".heic") ||
    lowerName.endsWith(".heif")
  )
}

function isImageAttachment(file: File) {
  const lowerName = file.name.toLowerCase()
  const lowerType = file.type.toLowerCase()
  return lowerType.startsWith("image/") || lowerName.endsWith(".heic") || lowerName.endsWith(".heif")
}

export function QuickLogEntry({
  projectId,
  userId,
  projectAddress,
  scheduleItems,
  tasks,
  punchItems,
  locations,
  canManageLocations,
  mentionableUsers,
  onCreateLog,
  onUploadFiles,
  trigger,
  open: controlledOpen,
  onOpenChange,
  defaultDate,
  variant = "drawer",
  onLoadContext,
  contextLoading = false,
  contextError,
  onDraftPendingChange,
}: QuickLogEntryProps) {
  const today = new Date()
  const draftKey = userId ? `daily-log-draft:${userId}:${projectId}:${format(defaultDate ?? today, "yyyy-MM-dd")}` : null
  const [draftReady, setDraftReady] = useState(!draftKey)
  const [draftRecovered, setDraftRecovered] = useState(false)
  const [draftError, setDraftError] = useState<string | null>(null)
  const latestDraft = useRef<QuickLogDraft | null>(null)
  const draftFinished = useRef(false)
  const hydratedDraftKey = useRef<string | null>(null)
  const draftLoadFailed = useRef(false)
  const submissionId = useRef<string | null>(null)
  const submittingLock = useRef(false)
  const createdLogRef = useRef<DailyLog | null>(null)
  const uploadedFiles = useRef(new Set<File>())
  const loadContext = () => { void onLoadContext?.().catch(() => undefined) }
  const fileInputRef = useRef<HTMLInputElement>(null)

  // Drag-and-drop attachments — dialog/desktop affordance.
  const [dragActive, setDragActive] = useState(false)
  const dragDepth = useRef(0)
  const isFileDrag = (event: React.DragEvent) => Array.from(event.dataTransfer.types).includes("Files")
  const isSupportedAttachment = (file: File) => file.size > 0

  // State (supports both uncontrolled trigger usage and controlled open)
  const [internalOpen, setInternalOpen] = useState(false)
  const isControlled = controlledOpen !== undefined
  const open = isControlled ? controlledOpen : internalOpen
  const setOpen = (next: boolean) => {
    if (!isControlled) setInternalOpen(next)
    onOpenChange?.(next)
  }
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [savedLogId, setSavedLogId] = useState<string | null>(null)
  const [summary, setSummary] = useState("")
  const [selectedWeather, setSelectedWeather] = useState<string>("")
  const [selectedDate, setSelectedDate] = useState<DateOption>("today")
  const [customDate, setCustomDate] = useState<Date | undefined>(undefined)
  const [selectedFiles, setSelectedFiles] = useState<File[]>([])
  const [mentionedUserIds, setMentionedUserIds] = useState<string[]>([])
  const [showDatePicker, setShowDatePicker] = useState(false)

  // Blob URLs for the attachment thumbnails. Minting these in the render body
  // leaks: each render allocates a fresh URL that pins the whole File in
  // memory, and a superintendent attaching a dozen site photos re-renders on
  // every keystroke in the summary field. Derive them once per file list and
  // revoke the previous batch.
  const previewUrls = useMemo(
    () => selectedFiles.map((file) => (isImageAttachment(file) && canPreviewSelectedImage(file) ? URL.createObjectURL(file) : null)),
    [selectedFiles],
  )
  useEffect(() => {
    return () => {
      for (const url of previewUrls) if (url) URL.revokeObjectURL(url)
    }
  }, [previewUrls])

  // When opened with a target date (day-centric desktop flow), pre-select it.
  useEffect(() => {
    if ((!open && variant !== "inline") || !defaultDate || createdLogRef.current) return
    if (isSameDay(defaultDate, today)) {
      setSelectedDate("today")
    } else if (isSameDay(defaultDate, subDays(today, 1))) {
      setSelectedDate("yesterday")
    } else {
      setSelectedDate("custom")
      setCustomDate(defaultDate)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, defaultDate, variant])

  // Offline sync hook
  const { isOnline, pendingLogs, saveOfflineLog, syncPendingLogs, isSyncing } = useOfflineDailyLogs(projectId, userId)

  // Auto-fetch weather when opening drawer if not set
  useEffect(() => {
    if (variant === "inline" || !draftReady || !open || selectedWeather || !projectAddress || !isOnline) return

    let mounted = true
    async function fetchWeather() {
      const coords = await getCoordinatesFromAddress(projectAddress!)
      if (!coords || !mounted) return
      
      const weather = await getCurrentWeather(coords.lat, coords.lon)
      if (weather && mounted) {
        setSelectedWeather(weather.condition)
        // Optionally append temperature to summary if desired
      }
    }
    
    fetchWeather()

    return () => { mounted = false }
  }, [open, projectAddress, selectedWeather, isOnline, draftReady, variant])

  // Detailed entries - collapsed by default
  const [showDetailedEntries, setShowDetailedEntries] = useState(false)
  const [activeDetails, setActiveDetails] = useState<string[]>([])
  const [workItems, setWorkItems] = useState<WorkEntryDraft[]>([])
  const [inspectionItems, setInspectionItems] = useState<InspectionEntryDraft[]>([])
  const [taskUpdates, setTaskUpdates] = useState<TaskUpdateDraft[]>([])
  const [punchUpdates, setPunchUpdates] = useState<PunchUpdateDraft[]>([])
  // Site events — one entry per non-empty line, captured as free text.
  const [deliveriesText, setDeliveriesText] = useState("")
  const [constraintsText, setConstraintsText] = useState("")
  const [safetyText, setSafetyText] = useState("")

  // Get actual date value from the day-picker chips. In the day-centric flow the
  // picker is seeded from the open day, but the chips still let you retarget.
  function getDateValue(): string {
    if (variant === "inline" && defaultDate) return format(defaultDate, "yyyy-MM-dd")
    if (selectedDate === "today") {
      return format(today, "yyyy-MM-dd")
    } else if (selectedDate === "yesterday") {
      return format(subDays(today, 1), "yyyy-MM-dd")
    } else if (customDate) {
      return format(customDate, "yyyy-MM-dd")
    }
    return format(today, "yyyy-MM-dd")
  }

  const draftSnapshot = useMemo<QuickLogDraft>(() => ({
    summary, weather: selectedWeather, date: getDateValue(), files: selectedFiles,
    mentionedUserIds, activeDetails, showDetailedEntries, workItems, inspectionItems,
    taskUpdates, punchUpdates, deliveriesText, constraintsText, safetyText,
    submissionId: submissionId.current, createdLog: createdLogRef.current,
    uploadedFileIndexes: selectedFiles.flatMap((file, index) => uploadedFiles.current.has(file) ? [index] : []),
    // Submission state makes ref changes part of the persisted snapshot.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [summary, selectedWeather, selectedDate, customDate, selectedFiles, mentionedUserIds, activeDetails,
    showDetailedEntries, workItems, inspectionItems, taskUpdates, punchUpdates, deliveriesText,
    constraintsText, safetyText, savedLogId, isSubmitting, defaultDate, variant])
  latestDraft.current = draftSnapshot
  if (draftFinished.current && (summary || selectedFiles.length || workItems.length || inspectionItems.length || taskUpdates.length || punchUpdates.length || deliveriesText || constraintsText || safetyText) && !isSubmitting) draftFinished.current = false

  useEffect(() => {
    if (!draftKey) { setDraftReady(true); return }
    let active = true
    setDraftReady(false)
    void dailyLogDraftStorage.load<QuickLogDraft>(draftKey).then((draft) => {
      if (!active || !draft || draft.completed) return
      setSummary(draft.summary)
      setSelectedWeather(draft.weather)
      setSelectedDate("custom")
      setCustomDate(new Date(`${draft.date}T12:00:00`))
      setSelectedFiles(draft.files)
      uploadedFiles.current = new Set((draft.uploadedFileIndexes ?? []).map((index) => draft.files[index]).filter(Boolean))
      setMentionedUserIds(draft.mentionedUserIds)
      setActiveDetails(draft.activeDetails)
      setShowDetailedEntries(draft.showDetailedEntries)
      setWorkItems(draft.workItems)
      setInspectionItems(draft.inspectionItems)
      setTaskUpdates(draft.taskUpdates)
      setPunchUpdates(draft.punchUpdates)
      setDeliveriesText(draft.deliveriesText)
      setConstraintsText(draft.constraintsText)
      setSafetyText(draft.safetyText)
      submissionId.current = draft.submissionId
      createdLogRef.current = draft.createdLog
      setSavedLogId(draft.createdLog?.id ?? null)
      setDraftRecovered(Boolean(draft.summary || draft.files.length || draft.workItems.length || draft.inspectionItems.length || draft.deliveriesText || draft.constraintsText || draft.safetyText || draft.taskUpdates.length || draft.punchUpdates.length))
    }).catch(() => {
      draftLoadFailed.current = true
      if (active) setDraftError("Draft recovery is unavailable on this device. Keep this page open until your log is saved.")
    }).finally(() => { if (active) { hydratedDraftKey.current = draftKey; setDraftReady(true) } })
    return () => { active = false }
  }, [draftKey])

  useEffect(() => {
    if (!draftReady || !draftKey || draftFinished.current || draftLoadFailed.current) return
    void dailyLogDraftStorage.save(draftKey, draftSnapshot).then(() => setDraftError(null)).catch(() => {
      setDraftError("This draft could not be saved on your device. Keep this page open until your log is saved.")
    })
  }, [draftKey, draftReady, draftSnapshot])

  useEffect(() => () => {
    if (draftKey && hydratedDraftKey.current === draftKey && latestDraft.current && !draftFinished.current && !draftLoadFailed.current) {
      void dailyLogDraftStorage.save(draftKey, latestDraft.current).catch(() => {})
    }
  }, [draftKey])

  async function persistSubmissionDraft() {
    if (!draftKey || !latestDraft.current) return
    await dailyLogDraftStorage.save(draftKey, {
      ...latestDraft.current, submissionId: submissionId.current, createdLog: createdLogRef.current,
      uploadedFileIndexes: selectedFiles.flatMap((file, index) => uploadedFiles.current.has(file) ? [index] : []),
    })
  }

  async function finishDraft() {
    if (draftKey && latestDraft.current) {
      // A completion marker prevents recovery if deletion is interrupted.
      await dailyLogDraftStorage.save(draftKey, { ...latestDraft.current, completed: true })
      draftFinished.current = true
      await dailyLogDraftStorage.remove(draftKey).catch(() => {})
    }
    draftFinished.current = true
    setDraftRecovered(false)
  }

  // Reset form
  function resetForm() {
    submissionId.current = null
    createdLogRef.current = null
    setSavedLogId(null)
    uploadedFiles.current.clear()
    setActiveDetails([])
    setSummary("")
    setSelectedWeather("")
    setSelectedDate(defaultDate ? "custom" : "today")
    setCustomDate(defaultDate)
    setSelectedFiles([])
    setMentionedUserIds([])
    setShowDetailedEntries(false)
    setWorkItems([])
    setInspectionItems([])
    setTaskUpdates([])
    setPunchUpdates([])
    setDeliveriesText("")
    setConstraintsText("")
    setSafetyText("")
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
        location_id: item.location_id || undefined,
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

    // Site events: one entry per non-empty line.
    const siteEvents: [string, "delivery" | "constraint" | "safety"][] = [
      [deliveriesText, "delivery"],
      [constraintsText, "constraint"],
      [safetyText, "safety"],
    ]
    for (const [text, entry_type] of siteEvents) {
      for (const line of text.split("\n")) {
        const description = line.trim()
        if (description) entries.push({ entry_type, description })
      }
    }

    return entries
  }

  // Handle submit
  async function handleSubmit() {
    if (submittingLock.current || !draftReady) return
    const entries = buildEntries()
    const hasLogContent = Boolean(summary.trim() || selectedWeather || entries.length > 0)

    if (!hasLogContent && selectedFiles.length === 0) {
      return
    }

    submittingLock.current = true
    submissionId.current ??= crypto.randomUUID()
    setIsSubmitting(true)
    try {
      await persistSubmissionDraft()
      if (!isOnline && !createdLogRef.current) {
        await saveOfflineLog(
          {
            submission_id: submissionId.current,
            project_id: projectId,
            date: getDateValue(),
            summary: summary.trim(),
            weather: selectedWeather || undefined,
            entries,
            mentioned_user_ids: mentionedUserIds,
          },
          selectedFiles,
          { category: selectedFiles.every(isImageAttachment) ? "photos" : "other" },
        )
        await finishDraft()
        resetForm()
        setOpen(false)
        return
      }

      let createdLog = createdLogRef.current

      if (!createdLog && (hasLogContent || selectedFiles.length > 0)) {
        createdLog = await onCreateLog({
          submission_id: submissionId.current,
          project_id: projectId,
          date: getDateValue(),
          summary: summary.trim(),
          weather: selectedWeather || undefined,
          entries,
          mentioned_user_ids: mentionedUserIds,
        })
        createdLogRef.current = createdLog
        setSavedLogId(createdLog.id)
        await persistSubmissionDraft()
      }

      if (selectedFiles.length > 0 && createdLog) {
        await onUploadFiles(selectedFiles.filter((file) => !uploadedFiles.current.has(file)), {
          dailyLogId: createdLog.id,
          category: selectedFiles.every(isImageAttachment) ? "photos" : "other",
        })
        selectedFiles.forEach((file) => uploadedFiles.current.add(file))
        await persistSubmissionDraft()
      }

      await finishDraft()
      toast.success("Log saved")

      resetForm()
      setOpen(false)
    } catch (error) {
      console.error(error)
      toast.error(error instanceof Error ? error.message : "Failed to add log. Your draft is still here.")
    } finally {
      submittingLock.current = false
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

  useEffect(() => {
    onDraftPendingChange?.(!draftReady || canSubmit || isSubmitting)
  }, [onDraftPendingChange, draftReady, canSubmit, isSubmitting])

  // Drag-and-drop drop handler (dialog only).
  function handleDrop(event: React.DragEvent) {
    if (!isFileDrag(event)) return
    event.preventDefault()
    dragDepth.current = 0
    setDragActive(false)
    const dropped = Array.from(event.dataTransfer.files).filter(isSupportedAttachment)
    if (dropped.length === 0) return
    setSelectedFiles((prev) => [...prev, ...dropped])
  }

  // ---------------------------------------------------------------------------
  // Shared building blocks — reused by both the mobile drawer and desktop dialog.
  // ---------------------------------------------------------------------------

  const banners = (
    <>
      {!draftReady && <p role="status" className="px-4 py-2 text-xs text-muted-foreground">Recovering your draft…</p>}
      {draftRecovered && <p role="status" className="px-4 py-2 text-xs text-muted-foreground">Your draft was restored.</p>}
      {draftError && <p role="alert" className="px-4 py-2 text-xs text-destructive">{draftError}</p>}
      {!isOnline && (
        <div className="bg-yellow-500/10 border-b border-yellow-500/20 text-yellow-700 dark:text-yellow-400 px-4 py-2 text-xs font-medium flex items-center justify-center">
          You are offline. Logs will be saved to your device and synced later.
        </div>
      )}
      {isOnline && pendingLogs.length > 0 && (
        <div className="bg-primary/10 border-b border-primary/20 text-primary px-4 py-2 flex items-center justify-between text-xs font-medium">
          <span>You have {pendingLogs.length} offline log{pendingLogs.length !== 1 ? 's' : ''} waiting to sync.</span>
          <Button
            size="sm"
            variant="default"
            className="h-6 px-2 text-[10px]"
            disabled={isSyncing}
            onClick={() => syncPendingLogs(onCreateLog, onUploadFiles)}
          >
            {isSyncing ? "Syncing..." : "Sync Now"}
          </Button>
        </div>
      )}
    </>
  )

  // Day-picker chips — Today / Yesterday / a specific date. Seeded from the open
  // day in the day-centric flow, but still lets you retarget the entry.
  const datePickerChips = (
    <div className="flex items-center gap-1.5">
      <button
        type="button"
        onClick={() => {
          setSelectedDate("today")
          setCustomDate(undefined)
        }}
        className={cn(
          "rounded-full px-3.5 py-1.5 text-xs font-medium transition-colors",
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
          "rounded-full px-3.5 py-1.5 text-xs font-medium transition-colors",
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
              "flex items-center gap-1.5 rounded-full px-3.5 py-1.5 text-xs font-medium transition-colors",
              selectedDate === "custom"
                ? "bg-primary text-primary-foreground"
                : "bg-muted text-muted-foreground hover:bg-muted/80"
            )}
          >
            <CalendarDays className="h-3 w-3" />
            {selectedDate === "custom" && customDate ? format(customDate, "MMM d") : "Pick a date"}
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
  )

  const dateBlock = <div className="mb-3">{datePickerChips}</div>

  const composerBody = (
    <fieldset disabled={!draftReady || Boolean(savedLogId) || isSubmitting} className="min-w-0">
      <legend className="sr-only">Log content</legend>
      {/* Hidden file input — shared by the preview grid's add tile and the
          footer's attach button in either shell. */}
      <input
        ref={fileInputRef}
        type="file"
        multiple
        className="hidden"
        onChange={handleFileChange}
      />

      {/* Weather. The drawer keeps the manual chips; the dialog captures it
          automatically from the project address and shows a quiet read-out. */}
      {variant === "drawer" ? (
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
      ) : selectedWeather && variant !== "inline" ? (
        <div className="mb-3 flex items-center gap-1.5 text-xs">
          <span aria-hidden>{weatherEmojiFor(selectedWeather)}</span>
          <span className="font-medium text-foreground">{selectedWeather}</span>
          <span className="text-muted-foreground">· auto-detected</span>
        </div>
      ) : null}

      {/* Main text input */}
      <div className="relative bg-muted/30 rounded-lg border focus-within:border-muted-foreground/40 transition-colors mb-3">
        <MentionTextarea
          value={summary}
          onChange={setSummary}
          mentionableUsers={mentionableUsers}
          mentionedUserIds={mentionedUserIds}
          onMentionedUserIdsChange={setMentionedUserIds}
          placeholder={getDateValue() === format(today, "yyyy-MM-dd") ? "What happened on site today?" : `What happened on ${getDateValue()}?`}
          rows={1}
          className="min-h-[80px]"
        />
      </div>

      {/* Attachment previews */}
      {selectedFiles.length > 0 && (
        <div className="mb-4">
          <div className="flex gap-2 overflow-x-auto pb-2 -mx-1 px-1 hide-scrollbar">
            {selectedFiles.map((file, index) => {
              const previewUrl = previewUrls[index]
              return (
              <div
                key={index}
                className="relative flex-shrink-0 w-16 h-16 rounded-lg overflow-hidden bg-muted"
              >
                {previewUrl ? (
                  <img
                    src={previewUrl}
                    alt={`Preview ${index + 1}`}
                    className="w-full h-full object-cover"
                  />
                ) : (
                  <div className="flex h-full w-full flex-col items-center justify-center gap-1 px-1 text-center text-[10px] text-muted-foreground">
                    <Paperclip className="h-4 w-4" />
                    {file.name.split(".").pop()?.slice(0, 5).toUpperCase() || "FILE"}
                  </div>
                )}
                <button
                  type="button"
                  aria-label={`Remove ${file.name}`}
                  onClick={() => removeFile(index)}
                  className="absolute top-1 right-1 w-5 h-5 bg-black/60 rounded-full flex items-center justify-center hover:bg-black/80 transition-colors"
                >
                  <X className="h-3 w-3 text-white" />
                </button>
              </div>
              )
            })}
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
      {variant !== "inline" && <button
        type="button"
        onClick={() => { loadContext(); setShowDetailedEntries(!showDetailedEntries) }}
        aria-expanded={showDetailedEntries}
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
      </button>}

      {/* Detailed entries — a minimal, symmetric editor. Each section shares the
          same header + card rhythm so the form reads as one system. */}
      {showDetailedEntries && <div
        className={cn(
          "grid transition-[grid-template-rows,opacity] duration-200 ease-out motion-reduce:transition-none",
          showDetailedEntries ? "grid-rows-[1fr] opacity-100" : "grid-rows-[0fr] opacity-0",
        )}
      >
        <div className="min-h-0 overflow-hidden">
          <div className="mt-1 space-y-6 border-t pt-4">
            {/* Work performed */}
            {(variant !== "inline" || activeDetails.includes("work")) && <section className="space-y-2.5">
            <EntrySectionHeader label="Work performed" onAdd={addWorkItem} />
            {workItems.length > 0 && (
              <div className="space-y-2">
                {workItems.map((item) => (
                  <div key={item.id} className="rounded-xl border bg-muted/20 p-2.5">
                    <div className="flex items-center gap-2">
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
                        <SelectTrigger className="h-9 flex-1 text-sm">
                          <SelectValue placeholder="Schedule item (optional)" />
                        </SelectTrigger>
                        <SelectContent>
                          {scheduleItems.map((scheduleItem) => (
                            <SelectItem key={scheduleItem.id} value={scheduleItem.id}>
                              {scheduleItem.name}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <RemoveEntryButton onClick={() => removeWorkItem(item.id)} />
                    </div>
                    <Input
                      value={item.description}
                      onChange={(event) => updateWorkItem(item.id, { description: event.target.value })}
                      placeholder="What was done"
                      className="mt-2 h-9 text-sm"
                    />
                    <div className="mt-2 grid grid-cols-4 gap-2">
                      <Input
                        value={item.hours}
                        onChange={(event) => updateWorkItem(item.id, { hours: event.target.value })}
                        placeholder="Hrs"
                        type="number"
                        min="0"
                        className="h-9 text-center text-sm tabular-nums"
                      />
                      <Input
                        value={item.progress}
                        onChange={(event) => updateWorkItem(item.id, { progress: event.target.value })}
                        placeholder="%"
                        type="number"
                        min="0"
                        max="100"
                        className="h-9 text-center text-sm tabular-nums"
                      />
                      <Input
                        value={item.trade ?? ""}
                        onChange={(event) => updateWorkItem(item.id, { trade: event.target.value })}
                        placeholder="Trade"
                        className="h-9 text-sm"
                      />
                      <LocationPicker projectId={projectId} locations={locations} value={item.location_id ?? null} canCreate={canManageLocations} onValueChange={(id, path) => updateWorkItem(item.id, { location_id: id ?? undefined, location: path ?? undefined })} />
                    </div>
                  </div>
                ))}
              </div>
            )}
          </section>}

          {/* Inspections */}
          {(variant !== "inline" || activeDetails.includes("inspection")) && <section className="space-y-2.5">
            <EntrySectionHeader label="Inspections" onAdd={addInspectionItem} />
            {inspectionItems.length > 0 && (
              <div className="space-y-2">
                {inspectionItems.map((item) => (
                  <div key={item.id} className="rounded-xl border bg-muted/20 p-2.5">
                    <div className="flex items-center gap-2">
                      <Select
                        value={item.schedule_item_id ?? ""}
                        onValueChange={(value) => updateInspectionItem(item.id, { schedule_item_id: value })}
                      >
                        <SelectTrigger className="h-9 flex-1 text-sm">
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
                      <RemoveEntryButton onClick={() => removeInspectionItem(item.id)} />
                    </div>
                    <ToggleGroup
                      type="single"
                      variant="outline"
                      size="sm"
                      value={item.result ?? ""}
                      onValueChange={(value) =>
                        updateInspectionItem(item.id, { result: (value || undefined) as InspectionEntryDraft["result"] })
                      }
                      className="mt-2 grid w-full grid-cols-4 gap-1"
                    >
                      {(["pass", "fail", "partial", "n_a"] as const).map((result) => (
                        <ToggleGroupItem key={result} value={result} className="h-8 w-full text-xs capitalize">
                          {result === "n_a" ? "N/A" : result}
                        </ToggleGroupItem>
                      ))}
                    </ToggleGroup>
                    <Input
                      value={item.notes}
                      onChange={(event) => updateInspectionItem(item.id, { notes: event.target.value })}
                      placeholder="Notes (optional)"
                      className="mt-2 h-9 text-sm"
                    />
                  </div>
                ))}
              </div>
            )}
          </section>}

          {/* Task updates */}
          {(variant !== "inline" || activeDetails.includes("task")) && <section className="space-y-2.5">
            <EntrySectionHeader label="Task updates" onAdd={addTaskUpdate} />
            {taskUpdates.length > 0 && (
              <div className="space-y-2">
                {taskUpdates.map((item) => (
                  <div key={item.id} className="rounded-xl border bg-muted/20 p-2.5">
                    <div className="flex items-center gap-2">
                      <Select
                        value={item.task_id ?? ""}
                        onValueChange={(value) => updateTaskUpdate(item.id, { task_id: value })}
                      >
                        <SelectTrigger className="h-9 flex-1 text-sm">
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
                      <RemoveEntryButton onClick={() => removeTaskUpdate(item.id)} />
                    </div>
                    <label className="mt-2 flex h-9 items-center justify-between rounded-lg px-1 text-sm">
                      <span className="text-muted-foreground">Mark complete</span>
                      <Switch
                        checked={item.mark_complete}
                        onCheckedChange={(checked) => updateTaskUpdate(item.id, { mark_complete: checked })}
                      />
                    </label>
                  </div>
                ))}
              </div>
            )}
          </section>}

          {/* Punch updates */}
          {(variant !== "inline" || activeDetails.includes("punch")) && <section className="space-y-2.5">
            <EntrySectionHeader label="Punch updates" onAdd={addPunchUpdate} />
            {punchUpdates.length > 0 && (
              <div className="space-y-2">
                {punchUpdates.map((item) => (
                  <div key={item.id} className="rounded-xl border bg-muted/20 p-2.5">
                    <div className="flex items-center gap-2">
                      <Select
                        value={item.punch_item_id ?? ""}
                        onValueChange={(value) => updatePunchUpdate(item.id, { punch_item_id: value })}
                      >
                        <SelectTrigger className="h-9 flex-1 text-sm">
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
                      <RemoveEntryButton onClick={() => removePunchUpdate(item.id)} />
                    </div>
                    <label className="mt-2 flex h-9 items-center justify-between rounded-lg px-1 text-sm">
                      <span className="text-muted-foreground">Mark closed</span>
                      <Switch
                        checked={item.mark_closed}
                        onCheckedChange={(checked) => updatePunchUpdate(item.id, { mark_closed: checked })}
                      />
                    </label>
                  </div>
                ))}
              </div>
            )}
          </section>}

          {/* Site events — deliveries, delays/constraints, safety. One per line. */}
          <section className="space-y-3">
            {(
              [
                { key: "delivery", label: "Deliveries", value: deliveriesText, set: setDeliveriesText, placeholder: "Lumber package, rebar…" },
                { key: "constraint", label: "Delays & constraints", value: constraintsText, set: setConstraintsText, placeholder: "Waiting on inspection, weather hold…" },
                { key: "safety", label: "Safety", value: safetyText, set: setSafetyText, placeholder: "Toolbox talk, incident…" },
              ] as const
            ).filter(({ key }) => variant !== "inline" || activeDetails.includes(key)).map(({ label, value, set, placeholder }) => (
              <div key={label} className="space-y-1.5">
                <h4 className="text-[11px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">{label}</h4>
                <textarea
                  aria-label={label}
                  value={value}
                  onChange={(event) => set(event.target.value)}
                  placeholder={placeholder}
                  rows={2}
                  className="flex min-h-[52px] w-full resize-none rounded-lg border bg-muted/20 px-3 py-2 text-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                />
              </div>
            ))}
          </section>
          </div>
        </div>
      </div>}
    </fieldset>
  )

  if (variant === "inline") {
    return (
      <form
        aria-label={`Add log for ${getDateValue()}`}
        className="border bg-card"
        onSubmit={(event) => { event.preventDefault(); if (canSubmit) void handleSubmit() }}
        onFocusCapture={loadContext}
        onKeyDown={(event) => {
          if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
            event.preventDefault()
            if (canSubmit) void handleSubmit()
          }
        }}
        onDragOver={(event) => { if (isFileDrag(event)) event.preventDefault() }}
        onDrop={handleDrop}
      >
        {banners}
        <fieldset disabled={isSubmitting || !draftReady} className="min-w-0 p-4 sm:p-5">
          <legend className="sr-only">New daily log</legend>
          <div className="mb-3 flex items-center justify-between gap-2">
            <h2 className="text-sm font-medium">Add a log</h2>
          </div>
          {composerBody}
          {savedLogId && <p role="status" className="mb-3 text-sm text-muted-foreground">Your log is saved. Retry to finish attaching your files.</p>}
          {contextLoading && <p role="status" className="mb-3 text-xs text-muted-foreground">Loading people and project details…</p>}
          {contextError && <p role="alert" className="mb-3 text-xs text-destructive">{contextError} <button type="button" onClick={loadContext} className="underline">Retry</button></p>}
          <div className="flex flex-wrap items-center gap-2">
            <Button type="button" variant="ghost" size="sm" onClick={() => fileInputRef.current?.click()}><Paperclip className="size-4" />Attach</Button>
            <Select value="" onValueChange={(value) => {
              loadContext()
              setActiveDetails((previous) => previous.includes(value) ? previous : [...previous, value])
              setShowDetailedEntries(true)
              if (value === "work") addWorkItem()
              if (value === "inspection") addInspectionItem()
              if (value === "task") addTaskUpdate()
              if (value === "punch") addPunchUpdate()
            }}>
              <SelectTrigger aria-label="Add to log" className="h-8 w-auto gap-2 border-0 shadow-none"><Plus className="size-4" /><SelectValue placeholder="Add to log" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="work">Work performed</SelectItem>
                <SelectItem value="inspection">Inspection</SelectItem>
                <SelectItem value="task">Task update</SelectItem>
                <SelectItem value="punch">Punch update</SelectItem>
                <SelectItem value="delivery">Delivery</SelectItem>
                <SelectItem value="constraint">Delay or constraint</SelectItem>
                <SelectItem value="safety">Safety</SelectItem>
              </SelectContent>
            </Select>
            <Button type="submit" size="sm" className="ml-auto" disabled={!draftReady || !canSubmit || isSubmitting}>{isSubmitting ? "Saving…" : savedLogId ? "Retry attachments" : "Save log"}</Button>
          </div>
        </fieldset>
      </form>
    )
  }

  // Desktop day-centric workspace: a centered dialog mirroring the platform
  // issues composer — clean header, drag-to-attach, ⌘↵ to submit.
  if (variant === "dialog") {
    return (
      <Dialog open={open} onOpenChange={setOpen}>
        {trigger ? <DialogTrigger asChild>{trigger}</DialogTrigger> : null}
        <DialogContent showCloseButton={false} className="gap-0 overflow-hidden p-0 sm:max-w-2xl">
          <div
            className="relative flex flex-col"
            onKeyDown={(event) => {
              if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
                event.preventDefault()
                if (canSubmit && !isSubmitting) void handleSubmit()
              }
            }}
            onDragEnter={(event) => {
              if (!isFileDrag(event)) return
              event.preventDefault()
              dragDepth.current += 1
              setDragActive(true)
            }}
            onDragOver={(event) => {
              if (isFileDrag(event)) event.preventDefault()
            }}
            onDragLeave={(event) => {
              if (!isFileDrag(event)) return
              dragDepth.current -= 1
              if (dragDepth.current <= 0) {
                dragDepth.current = 0
                setDragActive(false)
              }
            }}
            onDrop={handleDrop}
          >
            {dragActive && (
              <div className="pointer-events-none absolute inset-0 z-30 flex flex-col items-center justify-center gap-2 border-2 border-dashed border-primary bg-background/90 text-sm font-medium">
                <Paperclip className="size-6 text-muted-foreground" />
                Drop attachments here
              </div>
            )}
            <DialogHeader className="space-y-0 border-b px-5 py-3">
              <DialogTitle className="sr-only">New log entry</DialogTitle>
              <DialogDescription className="sr-only">
                Record site activity, weather, attachments, and progress for the day.
              </DialogDescription>
              {datePickerChips}
            </DialogHeader>
            {banners}
            <div className="max-h-[65vh] overflow-y-auto px-5 py-4">
              {composerBody}
            </div>
            <DialogFooter className="items-center justify-between border-t px-5 py-3 sm:justify-between">
              <Button
                type="button"
                variant="outline"
                onClick={() => fileInputRef.current?.click()}
                aria-label="Attach files"
                className="h-10 min-w-10 gap-1.5 px-3"
              >
                <Paperclip className="size-4" />
                {selectedFiles.length > 0 && (
                  <span className="ml-1 text-xs text-primary">{selectedFiles.length}</span>
                )}
              </Button>
              <div className="flex items-center gap-2">
                <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
                  Cancel
                </Button>
                <Button
                  type="button"
                  disabled={!draftReady || !canSubmit || isSubmitting}
                  onClick={handleSubmit}
                  className="gap-2"
                >
                  {isSubmitting ? (
                    "Logging…"
                  ) : (
                    <>
                      Log it
                      <kbd className="inline-flex items-center rounded border border-primary-foreground/40 px-1.5 py-0.5 text-xs font-medium text-primary-foreground">
                        ⌘↵
                      </kbd>
                    </>
                  )}
                </Button>
              </div>
            </DialogFooter>
          </div>
        </DialogContent>
      </Dialog>
    )
  }

  // Mobile / feed: bottom drawer (unchanged).
  return (
    <Drawer open={open} onOpenChange={setOpen}>
      {trigger ? (
        <DrawerTrigger asChild>{trigger}</DrawerTrigger>
      ) : isControlled ? null : (
        <DrawerTrigger asChild>
          <Button size="sm" className="gap-2">
            <Plus className="h-4 w-4" />
            <span className="hidden sm:inline">New Entry</span>
          </Button>
        </DrawerTrigger>
      )}
      <DrawerContent className="mx-auto max-w-lg outline-none flex flex-col max-h-[90vh]">
        {banners}
        {/* Scrollable content area */}
        <div className="flex-1 overflow-y-auto p-4 pb-4">
          {dateBlock}
          {composerBody}
        </div>

        {/* Fixed footer */}
        <div className="flex-shrink-0 border-t bg-background px-4 py-3">
          <div className="flex items-center justify-between">
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              className="flex items-center gap-1.5 px-3 py-2 text-muted-foreground hover:text-foreground hover:bg-muted rounded-lg transition-colors"
            >
              <Paperclip className="h-4 w-4" />
              <span className="text-xs font-medium">Attach</span>
              {selectedFiles.length > 0 && (
                <span className="text-xs text-primary">({selectedFiles.length})</span>
              )}
            </button>

            <Button
              type="button"
              size="sm"
              disabled={!draftReady || !canSubmit || isSubmitting}
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
