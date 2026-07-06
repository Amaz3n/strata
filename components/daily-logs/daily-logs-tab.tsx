"use client"

import { useState, useMemo, useEffect, useRef, type ComponentType, type ReactNode } from "react"
import {
  format,
  parseISO,
  isSameDay,
  addDays,
} from "date-fns"
import { toast } from "sonner"
import { useSearchParams } from "next/navigation"

import type { DailyLog, DailyReport, ScheduleItem, Task } from "@/lib/types"
import type { EnhancedFileMetadata, FileCategory, ProjectPunchItem } from "@/app/(app)/projects/[id]/actions"
import type { DailyLogInput, DailyReportUpdateInput, ManpowerInput } from "@/lib/validation/daily-logs"
import { cn } from "@/lib/utils"

import { FileViewer } from "@/components/files/file-viewer"
import { useMobileAction } from "@/components/layout/mobile-action-context"
import { useUser } from "@/lib/auth/client"
import { QuickLogEntry } from "./quick-log-entry"
import { DailyLogsWorkspace } from "./daily-logs-workspace"
import { HighlightedMentionsText, MentionTextarea, type MentionableUser } from "./mention-textarea"
import { buildDayBuckets, dayCompleteness, daySummaryLine, imageFilesOf, weatherEmoji, type DayBucket } from "./day-aggregate"
import { CompletenessRing } from "./completeness-ring"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu"
import {
  Plus,
  AtSign,
  MoreHorizontal,
  Camera,
  FileText,
  ClipboardList,
  CheckCircle2,
  Hammer,
  XCircle,
  CheckCircle,
  Clock,
  ChevronLeft,
  ChevronRight,
  AlertTriangle,
  MessageSquare,
  Send,
  Users,
} from "@/components/icons"

// ============================================================================
// Log Entry Component - Redesigned for density and clarity
// ============================================================================

interface LogEntryProps {
  log: DailyLog
  photos: EnhancedFileMetadata[]
  scheduleById: Record<string, ScheduleItem>
  tasksById: Record<string, Task>
  punchById: Record<string, ProjectPunchItem>
  mentionableUsers: MentionableUser[]
  isHighlighted?: boolean
  onImageClick: (file: EnhancedFileMetadata) => void
  onCreateComment: (dailyLogId: string, values: { body: string; mentioned_user_ids?: string[] }) => Promise<NonNullable<DailyLog["comments"]>[number]>
  onUpdateLog: (dailyLogId: string, values: { summary?: string; weather?: string; mentioned_user_ids?: string[] }) => Promise<Pick<DailyLog, "id" | "notes" | "weather" | "updated_at" | "mentions">>
  onDeleteLog?: (dailyLogId: string) => Promise<void>
}

function CommentComposer({
  dailyLogId,
  mentionableUsers,
  onCreateComment,
}: {
  dailyLogId: string
  mentionableUsers: MentionableUser[]
  onCreateComment: LogEntryProps["onCreateComment"]
}) {
  const [body, setBody] = useState("")
  const [mentionedUserIds, setMentionedUserIds] = useState<string[]>([])
  const [isSubmitting, setIsSubmitting] = useState(false)

  async function submitComment() {
    if (!body.trim()) return
    setIsSubmitting(true)
    try {
      await onCreateComment(dailyLogId, {
        body: body.trim(),
        mentioned_user_ids: mentionedUserIds,
      })
      setBody("")
      setMentionedUserIds([])
      toast.success("Reply added")
    } catch (error) {
      console.error(error)
      toast.error("Failed to add reply")
    } finally {
      setIsSubmitting(false)
    }
  }

  return (
    <div className="relative mt-3 border-t pt-3">
      <div className="relative flex items-center gap-2">
        <div className="min-w-0 flex-1 rounded-md border bg-background">
          <MentionTextarea
            value={body}
            onChange={setBody}
            mentionableUsers={mentionableUsers}
            mentionedUserIds={mentionedUserIds}
            onMentionedUserIdsChange={setMentionedUserIds}
            placeholder="Reply or @mention someone..."
            multiline={false}
            onSubmit={() => void submitComment()}
            className="pr-2"
          />
        </div>
        <Button
          type="button"
          size="icon"
          className="h-9 w-9 flex-shrink-0"
          disabled={!body.trim() || isSubmitting}
          onClick={() => void submitComment()}
        >
          <Send className="h-3.5 w-3.5" />
        </Button>
      </div>
    </div>
  )
}

function LogEntry({ log, photos, scheduleById, tasksById, punchById, mentionableUsers, isHighlighted, onImageClick, onCreateComment, onUpdateLog, onDeleteLog }: LogEntryProps) {
  const [isEditing, setIsEditing] = useState(false)
  const [editSummary, setEditSummary] = useState(log.notes ?? "")
  const [editMentionIds, setEditMentionIds] = useState<string[]>((log.mentions ?? []).map((mention) => mention.mentioned_user_id))
  const [isSavingEdit, setIsSavingEdit] = useState(false)
  const entries = log.entries ?? []
  const mentions = log.mentions ?? []
  const comments = log.comments ?? []
  const workEntries = entries.filter(e => e.entry_type === "work")
  const inspections = entries.filter(e => e.entry_type === "inspection")
  const taskUpdates = entries.filter(e => e.entry_type === "task_update")
  const punchUpdates = entries.filter(e => e.entry_type === "punch_update")

  const failedInspections = inspections.filter(i => i.inspection_result === "fail")
  const passedInspections = inspections.filter(i => i.inspection_result === "pass")

  const hasStructuredContent = workEntries.length > 0 || inspections.length > 0 || taskUpdates.length > 0 || punchUpdates.length > 0
  const hasContent = log.notes || hasStructuredContent || photos.length > 0 || mentions.length > 0 || comments.length > 0

  useEffect(() => {
    if (isEditing) return
    setEditSummary(log.notes ?? "")
    setEditMentionIds((log.mentions ?? []).map((mention) => mention.mentioned_user_id))
  }, [isEditing, log.notes, log.mentions])

  async function saveEdit() {
    setIsSavingEdit(true)
    try {
      await onUpdateLog(log.id, {
        summary: editSummary.trim(),
        weather: log.weather,
        mentioned_user_ids: editMentionIds,
      })
      setIsEditing(false)
      toast.success("Log updated")
    } catch (error) {
      console.error(error)
      toast.error("Failed to update log")
    } finally {
      setIsSavingEdit(false)
    }
  }

  return (
    <div id={`daily-log-${log.id}`} className={cn("group flex scroll-mt-24 gap-3 pb-4", isHighlighted && "rounded-lg bg-primary/5 ring-2 ring-primary/20")}>
      {/* Time marker */}
      <div className="w-14 flex-shrink-0 text-[11px] text-muted-foreground font-medium text-right pt-[14px]">
        {log.created_at && format(parseISO(log.created_at), "h:mm a")}
      </div>

      {/* Timeline */}
      <div className="relative flex flex-col items-center pt-[14px]">
        <div className="w-2 h-2 rounded-full bg-border group-hover:bg-primary transition-colors flex-shrink-0" />
        <div className="w-px flex-1 bg-border/50 mt-1" />
      </div>

      {/* Entry card */}
      <div className={cn(
        "flex-1 min-w-0 rounded-lg border bg-card transition-shadow hover:shadow-sm",
        failedInspections.length > 0 && "border-red-200 dark:border-red-900/50"
      )}>
        {/* Failed inspections alert */}
        {failedInspections.length > 0 && (
          <div className="px-4 py-2 bg-red-500/10 border-b border-red-200 dark:border-red-900/50">
            {failedInspections.map((i) => (
              <div key={i.id} className="flex items-center gap-2 text-sm text-red-700 dark:text-red-400">
                <XCircle className="h-4 w-4 flex-shrink-0" />
                <span className="font-medium">
                  {scheduleById[i.schedule_item_id ?? ""]?.name ?? "Inspection"} failed
                </span>
                {i.description && (
                  <span className="text-red-600/80 dark:text-red-400/80">— {i.description}</span>
                )}
              </div>
            ))}
          </div>
        )}

        <div className="p-3">
          {/* Header row */}
          <div className="flex items-start justify-between gap-3">
            <div className="flex-1 min-w-0">
              {isEditing ? (
                <div className="space-y-2">
                  <div className="rounded-lg border bg-muted/30">
                    <MentionTextarea
                      value={editSummary}
                      onChange={setEditSummary}
                      mentionableUsers={mentionableUsers}
                      mentionedUserIds={editMentionIds}
                      onMentionedUserIdsChange={setEditMentionIds}
                      placeholder="What happened on site today?"
                      rows={2}
                      className="min-h-[72px]"
                    />
                  </div>
                  <div className="flex justify-end gap-2">
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() => {
                        setEditSummary(log.notes ?? "")
                        setEditMentionIds((log.mentions ?? []).map((mention) => mention.mentioned_user_id))
                        setIsEditing(false)
                      }}
                      disabled={isSavingEdit}
                    >
                      Cancel
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      onClick={() => void saveEdit()}
                      disabled={isSavingEdit}
                    >
                      {isSavingEdit ? "Saving..." : "Save"}
                    </Button>
                  </div>
                </div>
              ) : log.notes && (
                <p className="whitespace-pre-wrap text-sm leading-relaxed">
                  <HighlightedMentionsText value={log.notes} mentionableUsers={mentionableUsers} />
                </p>
              )}
              {!hasContent && (
                <p className="text-sm text-muted-foreground italic">Empty log entry</p>
              )}
            </div>

            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7 flex-shrink-0 opacity-0 group-hover:opacity-100 transition-opacity -mt-0.5 -mr-1"
                >
                  <MoreHorizontal className="h-4 w-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onClick={() => setIsEditing(true)}>Edit</DropdownMenuItem>
                {onDeleteLog && (
                  <>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem
                      className="text-destructive font-medium cursor-pointer"
                      onClick={async () => {
                        if (confirm("Are you sure you want to delete this daily log? All associated comments and mentions will be deleted.")) {
                          try {
                            await onDeleteLog(log.id)
                            toast.success("Daily log deleted")
                          } catch (error) {
                            console.error(error)
                            toast.error("Failed to delete daily log")
                          }
                        }
                      }}
                    >
                      Delete
                    </DropdownMenuItem>
                  </>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>

          {/* Work entries - table style */}
          {workEntries.length > 0 && (
            <div className={cn(log.notes && "mt-3")}>
              <div className="text-[11px] font-medium text-muted-foreground mb-1.5 flex items-center gap-1.5 uppercase tracking-wide">
                <ClipboardList className="h-3 w-3" />
                Work Performed
              </div>
              <div className="space-y-1">
                {workEntries.map((e) => {
                  const scheduleItem = scheduleById[e.schedule_item_id ?? ""]
                  return (
                    <div
                      key={e.id}
                      className="flex items-center gap-3 py-1.5 px-2 rounded bg-muted/50 text-sm"
                    >
                      <span className="flex-1 min-w-0 truncate font-medium">
                        {scheduleItem?.name ?? e.description ?? "Work item"}
                      </span>
                      {e.trade && (
                        <span className="text-xs text-muted-foreground hidden md:block">
                          {e.trade}
                        </span>
                      )}
                      {e.location && (
                        <span className="text-xs text-muted-foreground hidden lg:block">
                          {e.location}
                        </span>
                      )}
                      {e.hours != null && (
                        <span className="flex items-center gap-1 text-xs text-muted-foreground tabular-nums flex-shrink-0">
                          <Clock className="h-3 w-3" />
                          {e.hours}h
                        </span>
                      )}
                      {e.progress != null && (
                        <div className="flex items-center gap-1.5 flex-shrink-0">
                          <div className="w-14 h-1.5 bg-background rounded-full overflow-hidden">
                            <div
                              className={cn(
                                "h-full rounded-full transition-all",
                                e.progress >= 100 ? "bg-green-500" : "bg-primary"
                              )}
                              style={{ width: `${Math.min(e.progress, 100)}%` }}
                            />
                          </div>
                          <span className="text-xs tabular-nums w-7 text-right">
                            {e.progress}%
                          </span>
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>
            </div>
          )}

          {/* Passed inspections & updates - inline */}
          {(passedInspections.length > 0 || taskUpdates.length > 0 || punchUpdates.length > 0) && (
            <div className={cn("flex flex-wrap gap-1.5", (log.notes || workEntries.length > 0) && "mt-3")}>
              {passedInspections.map((i) => (
                <span
                  key={i.id}
                  className="inline-flex items-center gap-1 px-2 py-0.5 bg-green-500/10 text-green-700 dark:text-green-400 rounded text-xs font-medium"
                >
                  <CheckCircle className="h-3 w-3" />
                  {scheduleById[i.schedule_item_id ?? ""]?.name ?? "Inspection"} passed
                </span>
              ))}
              {taskUpdates.map((e) => {
                const task = tasksById[e.task_id ?? ""]
                const done = Boolean(e.metadata?.mark_complete)
                return (
                  <span
                    key={e.id}
                    className={cn(
                      "inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-medium",
                      done
                        ? "bg-green-500/10 text-green-700 dark:text-green-400"
                        : "bg-blue-500/10 text-blue-700 dark:text-blue-400"
                    )}
                  >
                    {done ? <CheckCircle className="h-3 w-3" /> : <FileText className="h-3 w-3" />}
                    {task?.title ?? "Task"} {done && "completed"}
                  </span>
                )
              })}
              {punchUpdates.map((e) => {
                const punch = punchById[e.punch_item_id ?? ""]
                const closed = Boolean(e.metadata?.mark_closed)
                return (
                  <span
                    key={e.id}
                    className={cn(
                      "inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-medium",
                      closed
                        ? "bg-green-500/10 text-green-700 dark:text-green-400"
                        : "bg-orange-500/10 text-orange-700 dark:text-orange-400"
                    )}
                  >
                    {closed ? <CheckCircle className="h-3 w-3" /> : <Hammer className="h-3 w-3" />}
                    {punch?.title ?? "Punch item"} {closed && "closed"}
                  </span>
                )
              })}
            </div>
          )}

          {mentions.length > 0 && (
            <div className={cn("flex flex-wrap gap-1.5", (log.notes || workEntries.length > 0 || passedInspections.length > 0 || taskUpdates.length > 0 || punchUpdates.length > 0) && "mt-3")}>
              {mentions.map((mention) => (
                <span
                  key={mention.id}
                  className="inline-flex items-center gap-1 rounded-full bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary"
                >
                  <AtSign className="h-3 w-3" />
                  {mention.user?.full_name ?? mention.user?.email ?? "Mentioned user"}
                </span>
              ))}
            </div>
          )}

          {/* Photos */}
          {photos.length > 0 && (
            <div className={cn("flex gap-1.5 overflow-x-auto -mx-1 px-1 pb-1", (log.notes || workEntries.length > 0 || passedInspections.length > 0 || taskUpdates.length > 0 || punchUpdates.length > 0) && "mt-3")}>
              {photos.slice(0, 6).map((photo, idx) => {
                const isLast = idx === 5 && photos.length > 6
                return (
                  <button
                    key={photo.id}
                    onClick={() => onImageClick(photo)}
                    className="relative flex-shrink-0 w-20 h-20 rounded-md overflow-hidden bg-muted hover:ring-2 hover:ring-primary/50 transition-all"
                  >
                    {photo.thumbnail_url ? (
                      <img
                        src={photo.thumbnail_url}
                        alt=""
                        className="w-full h-full object-cover"
                      />
                    ) : (
                      <div className="w-full h-full flex items-center justify-center">
                        <Camera className="h-5 w-5 text-muted-foreground/40" />
                      </div>
                    )}
                    {isLast && (
                      <div className="absolute inset-0 bg-black/60 flex items-center justify-center">
                        <span className="text-white text-sm font-medium">+{photos.length - 6}</span>
                      </div>
                    )}
                  </button>
                )
              })}
            </div>
          )}

          {(
            <div className={cn((log.notes || workEntries.length > 0 || passedInspections.length > 0 || taskUpdates.length > 0 || punchUpdates.length > 0 || mentions.length > 0 || photos.length > 0) && "mt-3")}>
              {comments.length > 0 && (
                <div className="space-y-2 border-t pt-3">
                  <div className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                    <MessageSquare className="h-3 w-3" />
                    Replies
                  </div>
                  {comments.map((comment) => (
                    <div key={comment.id} className="rounded-md bg-muted/50 px-3 py-2 text-sm">
                      <div className="mb-1 flex items-center gap-2 text-xs text-muted-foreground">
                        <span className="font-medium text-foreground">
                          {comment.author?.full_name ?? comment.author?.email ?? "Teammate"}
                        </span>
                        <span>{format(parseISO(comment.created_at), "MMM d, h:mm a")}</span>
                      </div>
                      <p className="whitespace-pre-wrap leading-relaxed">
                        <HighlightedMentionsText value={comment.body} mentionableUsers={mentionableUsers} />
                      </p>
                      {comment.mentions && comment.mentions.length > 0 && (
                        <div className="mt-2 flex flex-wrap gap-1">
                          {comment.mentions.map((mention) => (
                            <span key={mention.id} className="inline-flex items-center gap-1 rounded-full bg-background px-1.5 py-0.5 text-[11px] font-medium text-primary">
                              <AtSign className="h-2.5 w-2.5" />
                              {mention.user?.full_name ?? mention.user?.email ?? "Mentioned user"}
                            </span>
                          ))}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}

              <CommentComposer
                dailyLogId={log.id}
                mentionableUsers={mentionableUsers}
                onCreateComment={onCreateComment}
              />
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

// ============================================================================
// Standalone Photo Strip
// ============================================================================

interface PhotoStripProps {
  photos: EnhancedFileMetadata[]
  onImageClick: (file: EnhancedFileMetadata) => void
}

function PhotoStrip({ photos, onImageClick }: PhotoStripProps) {
  return (
    <div className="group flex gap-3 pb-4">
      {/* Time marker */}
      <div className="w-14 flex-shrink-0 text-[11px] text-muted-foreground font-medium text-right pt-[14px]">
        {photos[0]?.created_at && format(parseISO(photos[0].created_at), "h:mm a")}
      </div>

      {/* Timeline */}
      <div className="relative flex flex-col items-center pt-[14px]">
        <div className="w-2 h-2 rounded-full bg-border group-hover:bg-primary transition-colors flex-shrink-0" />
        <div className="w-px flex-1 bg-border/50 mt-1" />
      </div>

      {/* Photo card */}
      <div className="flex-1 min-w-0 rounded-lg border bg-card p-3">
        <div className="flex items-center gap-2 text-xs text-muted-foreground mb-2">
          <Camera className="h-3.5 w-3.5" />
          <span>{photos.length} {photos.length === 1 ? "photo" : "photos"}</span>
        </div>
        <div className="flex gap-1.5 overflow-x-auto -mx-1 px-1 pb-1">
          {photos.slice(0, 8).map((photo, idx) => {
            const isLast = idx === 7 && photos.length > 8
            return (
              <button
                key={photo.id}
                onClick={() => onImageClick(photo)}
                className="relative flex-shrink-0 w-20 h-20 rounded-md overflow-hidden bg-muted hover:ring-2 hover:ring-primary/50 transition-all"
              >
                {photo.thumbnail_url ? (
                  <img
                    src={photo.thumbnail_url}
                    alt=""
                    className="w-full h-full object-cover"
                  />
                ) : (
                  <div className="w-full h-full flex items-center justify-center">
                    <Camera className="h-5 w-5 text-muted-foreground/40" />
                  </div>
                )}
                {isLast && (
                  <div className="absolute inset-0 bg-black/60 flex items-center justify-center">
                    <span className="text-white text-sm font-medium">+{photos.length - 8}</span>
                  </div>
                )}
              </button>
            )
          })}
        </div>
      </div>
    </div>
  )
}

function mobileDayLabel(date: Date, today: Date) {
  if (isSameDay(date, today)) return "Today"
  if (isSameDay(date, addDays(today, -1))) return "Yesterday"
  return format(date, "EEEE")
}

function MobileDayChip({
  dateKey,
  bucket,
  today,
  selected,
  onSelect,
}: {
  dateKey: string
  bucket?: DayBucket
  today: Date
  selected: boolean
  onSelect: () => void
}) {
  const date = parseISO(dateKey)
  const completeness = dayCompleteness(bucket)

  return (
    <button
      type="button"
      onClick={onSelect}
      data-selected={selected || undefined}
      className={cn(
        "flex h-[64px] w-[64px] flex-shrink-0 flex-col items-center justify-between rounded-lg border px-2 py-2 text-center transition-colors",
        selected
          ? "border-primary bg-primary text-primary-foreground"
          : "border-border bg-background hover:border-muted-foreground/40 hover:bg-muted/50",
      )}
    >
      <span
        className={cn(
          "text-[9px] font-semibold uppercase leading-none tracking-wide",
          selected ? "text-primary-foreground/75" : "text-muted-foreground",
        )}
      >
        {format(date, "EEE")}
      </span>
      <span className="text-xl font-semibold leading-none tabular-nums">{format(date, "d")}</span>
      {bucket ? (
        <CompletenessRing
          completeness={completeness}
          size={16}
          strokeWidth={2.5}
          className={selected ? "text-primary-foreground" : undefined}
        />
      ) : (
        <span
          className={cn(
            "h-1.5 w-1.5 rounded-full",
            isSameDay(date, today) ? "bg-primary" : "bg-muted-foreground/35",
            selected && "bg-primary-foreground/80",
          )}
        />
      )}
    </button>
  )
}

function MobileDayStat({
  icon: Icon,
  children,
  tone,
}: {
  icon: ComponentType<{ className?: string }>
  children: ReactNode
  tone?: "danger" | "success"
}) {
  return (
    <span
      className={cn(
        "inline-flex h-8 flex-shrink-0 items-center gap-1.5 rounded-md border px-2.5 text-xs font-medium",
        tone === "danger"
          ? "border-destructive/20 bg-destructive/10 text-destructive"
          : tone === "success"
            ? "border-emerald-500/20 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400"
            : "border-border bg-background text-muted-foreground",
      )}
    >
      <Icon className="h-3.5 w-3.5" />
      {children}
    </span>
  )
}

// ============================================================================
// Main Component
// ============================================================================

interface DailyLogsTabProps {
  projectId: string
  projectAddress?: string
  projectStartDate?: string
  dailyLogs: DailyLog[]
  dailyReports: DailyReport[]
  files: EnhancedFileMetadata[]
  scheduleItems: ScheduleItem[]
  tasks: Task[]
  punchItems: ProjectPunchItem[]
  mentionableUsers: MentionableUser[]
  onCreateLog: (values: DailyLogInput) => Promise<DailyLog>
  onCreateComment: (dailyLogId: string, values: { body: string; mentioned_user_ids?: string[] }) => Promise<NonNullable<DailyLog["comments"]>[number]>
  onUpdateLog: (dailyLogId: string, values: { summary?: string; weather?: string; mentioned_user_ids?: string[] }) => Promise<Pick<DailyLog, "id" | "notes" | "weather" | "updated_at" | "mentions">>
  onUpdateReport: (date: string, values: DailyReportUpdateInput) => Promise<DailyReport>
  onSubmitReport: (reportId: string) => Promise<DailyReport>
  onReopenReport: (reportId: string) => Promise<DailyReport>
  onAddManpower: (date: string, values: ManpowerInput) => Promise<DailyReport>
  onUpdateManpower: (manpowerId: string, values: ManpowerInput) => Promise<DailyReport>
  onDeleteManpower: (manpowerId: string) => Promise<DailyReport>
  onUploadFiles: (
    files: File[],
    context?: {
      category?: FileCategory
      dailyLogId?: string
      scheduleItemId?: string
      tags?: string[]
    },
  ) => Promise<void>
  onDownloadFile: (file: EnhancedFileMetadata) => Promise<void>
  onDeleteLog?: (dailyLogId: string) => Promise<void>
}

export function DailyLogsTab({
  projectId,
  projectAddress,
  projectStartDate,
  dailyLogs,
  dailyReports,
  files,
  scheduleItems,
  tasks,
  punchItems,
  mentionableUsers,
  onCreateLog,
  onCreateComment,
  onUpdateLog,
  onUpdateReport,
  onSubmitReport,
  onReopenReport,
  onAddManpower,
  onUpdateManpower,
  onDeleteManpower,
  onUploadFiles,
  onDownloadFile,
  onDeleteLog,
}: DailyLogsTabProps) {
  const today = useMemo(() => new Date(), [])
  const todayKey = format(today, "yyyy-MM-dd")
  const { user } = useUser()
  const searchParams = useSearchParams()
  const highlightedLogId = searchParams.get("logId")

  // Image viewer state
  const [viewerOpen, setViewerOpen] = useState(false)
  const [viewerFile, setViewerFile] = useState<EnhancedFileMetadata | null>(null)

  // Mobile "New log" — surfaced as the square action button in the bottom nav
  const [mobileLogOpen, setMobileLogOpen] = useState(false)
  const { setAction } = useMobileAction()
  useEffect(() => {
    setAction({ label: "New log", icon: Plus, onAction: () => setMobileLogOpen(true) })
    return () => setAction(null)
  }, [setAction])

  const scheduleById = useMemo(
    () => scheduleItems.reduce<Record<string, ScheduleItem>>((acc, item) => {
      acc[item.id] = item
      return acc
    }, {}),
    [scheduleItems],
  )

  const tasksById = useMemo(
    () => tasks.reduce<Record<string, Task>>((acc, item) => {
      acc[item.id] = item
      return acc
    }, {}),
    [tasks],
  )

  const punchById = useMemo(
    () => punchItems.reduce<Record<string, ProjectPunchItem>>((acc, item) => {
      acc[item.id] = item
      return acc
    }, {}),
    [punchItems],
  )

  // Get all image files
  const imageFiles = useMemo(() => imageFilesOf(files), [files])

  const dayBuckets = useMemo(
    () => buildDayBuckets(dailyLogs, imageFiles, user?.id, dailyReports),
    [dailyLogs, imageFiles, user?.id, dailyReports],
  )

  const mobileInitialKey = useMemo(() => {
    if (dayBuckets.has(todayKey)) return todayKey
    const keys = Array.from(dayBuckets.keys()).sort((a, b) => b.localeCompare(a))
    return keys[0] ?? todayKey
  }, [dayBuckets, todayKey])

  const [mobileSelectedKey, setMobileSelectedKey] = useState(mobileInitialKey)

  useEffect(() => {
    if (highlightedLogId) {
      const highlighted = dailyLogs.find((log) => log.id === highlightedLogId)
      if (highlighted) {
        setMobileSelectedKey(highlighted.date)
        return
      }
    }
    if (mobileSelectedKey !== todayKey && !dayBuckets.has(mobileSelectedKey)) {
      setMobileSelectedKey(mobileInitialKey)
    }
  }, [dailyLogs, dayBuckets, highlightedLogId, mobileInitialKey, mobileSelectedKey, todayKey])

  const mobileSelectedDate = useMemo(() => parseISO(mobileSelectedKey), [mobileSelectedKey])
  const mobileSelectedBucket = dayBuckets.get(mobileSelectedKey)
  const mobileCompleteness = useMemo(() => dayCompleteness(mobileSelectedBucket), [mobileSelectedBucket])

  const mobileDayKeys = useMemo(() => {
    const keys = new Set<string>([mobileSelectedKey])
    for (let i = 0; i < 14; i += 1) {
      keys.add(format(addDays(today, -i), "yyyy-MM-dd"))
    }
    for (const key of dayBuckets.keys()) keys.add(key)
    return Array.from(keys).sort((a, b) => a.localeCompare(b))
  }, [dayBuckets, mobileSelectedKey, today])

  const mobileDayRailRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const selectedDay = mobileDayRailRef.current?.querySelector("[data-selected]")
    selectedDay?.scrollIntoView({ block: "nearest", inline: "end" })
  }, [mobileDayKeys.length, mobileSelectedKey])

  const mobilePhotosByLogId = useMemo(() => {
    const groups: Record<string, EnhancedFileMetadata[]> = {}
    for (const photo of mobileSelectedBucket?.photos ?? []) {
      const logId = photo.daily_log_id ?? "standalone"
      if (!groups[logId]) groups[logId] = []
      groups[logId].push(photo)
    }
    return groups
  }, [mobileSelectedBucket])

  const mobileStandalonePhotos = mobilePhotosByLogId.standalone ?? []
  const mobileHasActivity = Boolean(
    mobileSelectedBucket &&
      (mobileSelectedBucket.logs.length > 0 ||
        mobileSelectedBucket.photos.length > 0 ||
        (mobileSelectedBucket.report?.manpower?.length ?? 0) > 0),
  )

  function selectAdjacentMobileDay(step: 1 | -1) {
    const nextKey = format(addDays(parseISO(mobileSelectedKey), step), "yyyy-MM-dd")
    if (step > 0 && nextKey > todayKey) return
    setMobileSelectedKey(nextKey)
  }

  function handleImageClick(file: EnhancedFileMetadata) {
    setViewerFile(file)
    setViewerOpen(true)
  }

  useEffect(() => {
    if (!highlightedLogId) return
    const handle = window.setTimeout(() => {
      document.getElementById(`daily-log-${highlightedLogId}`)?.scrollIntoView({
        behavior: "smooth",
        block: "center",
      })
    }, 100)
    return () => window.clearTimeout(handle)
  }, [highlightedLogId, mobileSelectedKey])

  return (
    <>
    {/* Desktop (lg+): day-centric workspace */}
    <div className="hidden lg:flex flex-1 min-h-0">
      <DailyLogsWorkspace
        projectId={projectId}
        projectAddress={projectAddress}
        projectStartDate={projectStartDate}
        dailyLogs={dailyLogs}
        dailyReports={dailyReports}
        files={files}
        scheduleItems={scheduleItems}
        tasks={tasks}
        punchItems={punchItems}
        mentionableUsers={mentionableUsers}
        onCreateLog={onCreateLog}
        onCreateComment={onCreateComment}
        onUpdateLog={onUpdateLog}
        onUpdateReport={onUpdateReport}
        onSubmitReport={onSubmitReport}
        onReopenReport={onReopenReport}
        onAddManpower={onAddManpower}
        onUpdateManpower={onUpdateManpower}
        onDeleteManpower={onDeleteManpower}
        onUploadFiles={onUploadFiles}
        onDownloadFile={onDownloadFile}
        onDeleteLog={onDeleteLog}
      />
    </div>

    {/* Mobile / tablet (<lg): day-focused workspace with drawer capture. */}
    <div className="flex lg:hidden flex-1 min-h-0 flex-col bg-background">
      <div className="flex-shrink-0 border-b bg-background">
        <div className="flex items-center justify-between gap-3 px-4 py-3">
          <div className="min-w-0">
            <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">Daily report</p>
            <h1 className="mt-0.5 truncate text-xl font-semibold leading-tight tracking-tight">
              {format(mobileSelectedDate, "MMMM d, yyyy")}
            </h1>
            <p className="mt-0.5 truncate font-mono text-[10px] uppercase tracking-wide text-muted-foreground">
              {mobileDayLabel(mobileSelectedDate, today)}
              {mobileSelectedBucket?.report?.status === "submitted" ? " · Submitted" : " · Draft"}
            </p>
          </div>

          <div className="flex flex-shrink-0 items-center gap-1">
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label="Previous day"
              onClick={() => selectAdjacentMobileDay(-1)}
            >
              <ChevronLeft className="h-4 w-4" />
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label="Next day"
              disabled={mobileSelectedKey >= todayKey}
              onClick={() => selectAdjacentMobileDay(1)}
            >
              <ChevronRight className="h-4 w-4" />
            </Button>
            <Button type="button" size="sm" className="ml-1 h-8 px-3" onClick={() => setMobileLogOpen(true)}>
              <Plus className="h-4 w-4" />
              Log
            </Button>
          </div>
        </div>

        <div ref={mobileDayRailRef} className="flex gap-2 overflow-x-auto px-4 pb-3 hide-scrollbar">
          {mobileDayKeys.map((key) => (
            <MobileDayChip
              key={key}
              dateKey={key}
              bucket={dayBuckets.get(key)}
              today={today}
              selected={key === mobileSelectedKey}
              onSelect={() => setMobileSelectedKey(key)}
            />
          ))}
        </div>

        <div className="flex h-12 items-center gap-2 overflow-x-auto border-t bg-muted/20 px-4 hide-scrollbar">
          <span className="inline-flex h-8 flex-shrink-0 items-center gap-1.5 rounded-md border bg-background px-2.5 text-xs font-medium text-muted-foreground">
            <CompletenessRing completeness={mobileCompleteness} size={16} strokeWidth={2.5} />
            {mobileCompleteness.done}/{mobileCompleteness.total}
          </span>
          {mobileSelectedBucket?.weather ? (
            <MobileDayStat icon={Clock}>
              <span aria-hidden>{weatherEmoji(mobileSelectedBucket.weather)}</span>
              {mobileSelectedBucket.weather}
            </MobileDayStat>
          ) : (
            <MobileDayStat icon={Clock}>No weather</MobileDayStat>
          )}
          {mobileSelectedBucket?.manpowerWorkers ? (
            <MobileDayStat icon={Users}>{mobileSelectedBucket.manpowerWorkers} on site</MobileDayStat>
          ) : null}
          {mobileSelectedBucket?.totalHours ? (
            <MobileDayStat icon={Clock}>{mobileSelectedBucket.totalHours}h</MobileDayStat>
          ) : null}
          {mobileSelectedBucket?.photos.length ? (
            <MobileDayStat icon={Camera}>{mobileSelectedBucket.photos.length} photos</MobileDayStat>
          ) : null}
          {mobileSelectedBucket?.failedInspections.length ? (
            <MobileDayStat icon={AlertTriangle} tone="danger">
              {mobileSelectedBucket.failedInspections.length} issues
            </MobileDayStat>
          ) : mobileSelectedBucket?.passedInspections.length ? (
            <MobileDayStat icon={CheckCircle2} tone="success">
              {mobileSelectedBucket.passedInspections.length} inspections
            </MobileDayStat>
          ) : null}
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
        {!mobileHasActivity ? (
          <div className="flex min-h-[360px] flex-col items-center justify-center text-center">
            <div className="mb-4 grid h-14 w-14 place-items-center rounded-full bg-muted">
              <ClipboardList className="h-7 w-7 text-muted-foreground" />
            </div>
            <h3 className="font-semibold">No activity for this day</h3>
            <p className="mt-1 max-w-[280px] text-sm leading-relaxed text-muted-foreground">
              Start this report with a quick note, attachment, weather, or detailed entry.
            </p>
            <Button type="button" className="mt-4" onClick={() => setMobileLogOpen(true)}>
              <Plus className="mr-2 h-4 w-4" />
              Add log
            </Button>
          </div>
        ) : (
          <div className="mx-auto max-w-2xl">
            {mobileSelectedBucket && daySummaryLine(mobileSelectedBucket) && (
              <div className="mb-4 rounded-lg border bg-muted/25 px-3 py-2.5">
                <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
                  First note
                </p>
                <p className="mt-1 line-clamp-2 text-sm leading-relaxed">{daySummaryLine(mobileSelectedBucket)}</p>
              </div>
            )}

            {mobileSelectedBucket?.logs.map((log) => (
              <LogEntry
                key={log.id}
                log={log}
                photos={mobilePhotosByLogId[log.id] ?? []}
                scheduleById={scheduleById}
                tasksById={tasksById}
                punchById={punchById}
                mentionableUsers={mentionableUsers}
                isHighlighted={highlightedLogId === log.id}
                onImageClick={handleImageClick}
                onCreateComment={onCreateComment}
                onUpdateLog={onUpdateLog}
                onDeleteLog={onDeleteLog}
              />
            ))}

            {mobileStandalonePhotos.length > 0 && (
              <PhotoStrip photos={mobileStandalonePhotos} onImageClick={handleImageClick} />
            )}
          </div>
        )}
      </div>
      </div>

      {/* Mobile "New log" — opened from the bottom-nav action button */}
      <QuickLogEntry
        projectId={projectId}
        projectAddress={projectAddress}
        scheduleItems={scheduleItems}
        tasks={tasks}
        punchItems={punchItems}
        mentionableUsers={mentionableUsers}
        onCreateLog={onCreateLog}
        onUploadFiles={onUploadFiles}
        defaultDate={mobileSelectedDate}
        open={mobileLogOpen}
        onOpenChange={setMobileLogOpen}
      />

      {/* Image Viewer */}
      <FileViewer
        file={viewerFile ? {
          ...viewerFile,
          download_url: viewerFile.download_url,
          thumbnail_url: viewerFile.thumbnail_url,
        } : null}
        files={imageFiles.map(f => ({
          ...f,
          download_url: f.download_url,
          thumbnail_url: f.thumbnail_url,
        }))}
        open={viewerOpen}
        onOpenChange={setViewerOpen}
        onDownload={(file) => onDownloadFile(file as EnhancedFileMetadata)}
      />
    </>
  )
}
