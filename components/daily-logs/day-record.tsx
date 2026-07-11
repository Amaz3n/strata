"use client"

import { useEffect, useMemo, useState } from "react"
import { addDays, format } from "date-fns"
import { toast } from "sonner"

import { cn } from "@/lib/utils"
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { getCoordinatesFromAddress, getDailyWeather, type DailyWeather } from "@/lib/utils/weather"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  Plus,
  Clock,
  CheckCircle2,
  XCircle,
  Truck,
  ShieldCheck,
  Camera,
  MoreHorizontal,
  AlertTriangle,
  ClipboardList,
  ChevronDown,
  Users,
  MessageSquare,
  Send,
  Lock,
  Unlock,
  Check,
  X,
  Edit,
  Trash2,
  ChevronLeft,
  ChevronRight,
  Copy,
  CalendarDays,
  Share2,
} from "@/components/icons"
import type { DailyLog, DailyReport, DailyReportDayType, ScheduleItem, Task } from "@/lib/types"
import type { EnhancedFileMetadata, ProjectPunchItem } from "@/app/(app)/projects/[id]/actions"
import type { DailyReportSectionInput, DailyReportSectionKind, DailyReportUpdateInput, ManpowerInput } from "@/lib/validation/daily-logs"
import { HighlightedMentionsText, MentionTextarea, type MentionableUser } from "./mention-textarea"
import { WEATHER_OPTIONS, dayCompleteness, weatherEmoji, type DayBucket } from "./day-aggregate"
import { CompletenessRing } from "./completeness-ring"
import { DAILY_LOGS_PANE_HEADER_CLASS, DAILY_LOGS_PANE_SUBHEADER_CLASS } from "./layout"
import { CommercialSections } from "./commercial-sections"

const DAY_TYPES: { value: DailyReportDayType; label: string }[] = [
  { value: "work_day", label: "Work day" },
  { value: "rain_day", label: "Rain day" },
  { value: "weekend", label: "Weekend" },
  { value: "holiday", label: "Holiday" },
  { value: "no_work", label: "No work" },
]

function dayTypeLabel(dayType: DailyReportDayType | undefined): string | undefined {
  return DAY_TYPES.find((d) => d.value === dayType)?.label
}

function automaticWeatherText(report: DailyReport | undefined) {
  const weather = report?.weather_auto
  if (!weather) return undefined
  const unit = weather.units?.temperature ?? "°F"
  const temperature = weather.temperature_max != null ? `${Math.round(weather.temperature_max)}${unit}` : undefined
  const rain = weather.precipitation != null && weather.precipitation > 0 ? `${weather.precipitation}${weather.units?.precipitation ?? " in"} rain` : undefined
  const wind = weather.wind_speed_max != null ? `${Math.round(weather.wind_speed_max)} ${weather.units?.wind_speed ?? "mph"} wind` : undefined
  return [temperature, rain, wind].filter(Boolean).join(" · ")
}

interface DayRecordProps {
  date: Date
  bucket: DayBucket | undefined
  scheduleById: Record<string, ScheduleItem>
  tasksById: Record<string, Task>
  punchById: Record<string, ProjectPunchItem>
  mentionableUsers: MentionableUser[]
  projectAddress?: string
  projectId: string
  /** Chronological index of this day among logged days — "Report No. 042". */
  reportNumber?: number
  /** Nearest earlier day with crews, offered as a one-click starting point. */
  carryForward?: { fromDate: string; rows: ManpowerInput[] } | null
  onNavigateDay: (step: 1 | -1) => void
  canGoNext: boolean
  onAddLog: () => void
  onUpdateLog: (
    dailyLogId: string,
    values: { summary?: string; weather?: string; mentioned_user_ids?: string[] },
  ) => Promise<Pick<DailyLog, "id" | "notes" | "weather" | "updated_at" | "mentions">>
  onCreateComment: (
    dailyLogId: string,
    values: { body: string; mentioned_user_ids?: string[] },
  ) => Promise<NonNullable<DailyLog["comments"]>[number]>
  onDeleteLog?: (dailyLogId: string) => Promise<void>
  onUpdateReport: (date: string, values: DailyReportUpdateInput) => Promise<DailyReport>
  onSubmitReport: (reportId: string) => Promise<DailyReport>
  onReopenReport: (reportId: string) => Promise<DailyReport>
  onAddManpower: (date: string, values: ManpowerInput) => Promise<DailyReport>
  onUpdateManpower: (manpowerId: string, values: ManpowerInput) => Promise<DailyReport>
  onDeleteManpower: (manpowerId: string) => Promise<DailyReport>
  onAddSection: (date: string, kind: DailyReportSectionKind, input: DailyReportSectionInput) => Promise<DailyReport>
  onUpdateSection: (kind: DailyReportSectionKind, id: string, input: DailyReportSectionInput) => Promise<DailyReport>
  onDeleteSection: (kind: DailyReportSectionKind, id: string) => Promise<DailyReport>
  onRefreshWeather: (reportId: string) => Promise<DailyReport>
  onImageClick: (file: EnhancedFileMetadata) => void
}

type LogAuthor = NonNullable<DailyLog["author"]>

function authorName(author: LogAuthor | undefined): string {
  return author?.full_name?.trim() || author?.email?.trim() || "Unknown author"
}

function authorInitials(author: LogAuthor | undefined): string {
  const name = author?.full_name?.trim()
  if (name) {
    const parts = name.split(/\s+/)
    return ((parts[0]?.[0] ?? "") + (parts[1]?.[0] ?? "")).toUpperCase() || name.slice(0, 2).toUpperCase()
  }
  return author?.email?.slice(0, 2).toUpperCase() ?? "?"
}

// ---------------------------------------------------------------------------
// Suggested weather — the single most litigated field and the one nobody
// fills. Fetched per project address + date, applied with one click.
// ---------------------------------------------------------------------------

const geocodeCache = new Map<string, Promise<{ lat: number; lon: number } | null>>()
const weatherCache = new Map<string, Promise<DailyWeather | null>>()

function useSuggestedWeather(address: string | undefined, dateKey: string, enabled: boolean) {
  const [suggestion, setSuggestion] = useState<DailyWeather | null>(null)

  useEffect(() => {
    setSuggestion(null)
    if (!enabled || !address) return
    let active = true

    const cacheKey = `${address}|${dateKey}`
    let promise = weatherCache.get(cacheKey)
    if (!promise) {
      let coords = geocodeCache.get(address)
      if (!coords) {
        coords = getCoordinatesFromAddress(address)
        geocodeCache.set(address, coords)
      }
      promise = coords.then((c) => (c ? getDailyWeather(c.lat, c.lon, dateKey) : null))
      weatherCache.set(cacheKey, promise)
    }

    promise.then((result) => {
      if (active) setSuggestion(result)
    })
    return () => {
      active = false
    }
  }, [address, dateKey, enabled])

  return suggestion
}

// One KPI in the titleblock scorecard.
function Stat({
  icon: Icon,
  children,
  tone,
}: {
  icon: React.ComponentType<{ className?: string }>
  children: React.ReactNode
  tone?: "danger"
}) {
  return (
    <span
      className={cn(
        "flex items-center gap-1 tabular-nums",
        tone === "danger" ? "font-medium text-destructive" : "text-muted-foreground",
      )}
    >
      <Icon className="h-3.5 w-3.5" />
      {children}
    </span>
  )
}

// A titled block of the report. The label is typographic — small caps set
// against a hairline rule — so the page reads like a typeset report, not a form.
function Section({
  label,
  meta,
  action,
  children,
}: {
  label: string
  meta?: React.ReactNode
  action?: React.ReactNode
  children: React.ReactNode
}) {
  return (
    <section className="py-6 first-of-type:pt-5">
      <div className="mb-3.5 flex items-center gap-3">
        <h3 className="flex-shrink-0 text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
          {label}
        </h3>
        {meta && (
          <span className="flex-shrink-0 font-mono text-[10px] tabular-nums text-muted-foreground/70">{meta}</span>
        )}
        <span className="h-px min-w-4 flex-1 bg-border" aria-hidden />
        {action && <span className="flex-shrink-0">{action}</span>}
      </div>
      {children}
    </section>
  )
}

// Photo gallery — adaptive square tiles with a working "+N" overflow tile.
function PhotoGrid({
  photos,
  onImageClick,
}: {
  photos: EnhancedFileMetadata[]
  onImageClick: (file: EnhancedFileMetadata) => void
}) {
  const OVERFLOW_AT = 10
  const KEEP = OVERFLOW_AT - 1
  const overflow = photos.length > OVERFLOW_AT ? photos.length - KEEP : 0
  const visible = overflow ? photos.slice(0, KEEP) : photos.slice(0, OVERFLOW_AT)

  return (
    <div className="grid grid-cols-[repeat(auto-fill,minmax(96px,1fr))] gap-1.5">
      {visible.map((photo) => (
        <button
          key={photo.id}
          onClick={() => onImageClick(photo)}
          className="relative aspect-square overflow-hidden rounded-lg bg-muted transition-all hover:ring-2 hover:ring-primary/40 hover:ring-offset-1 hover:ring-offset-background"
        >
          {photo.thumbnail_url ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={photo.thumbnail_url} alt="" className="h-full w-full object-cover" />
          ) : (
            <div className="grid h-full w-full place-items-center">
              <Camera className="h-5 w-5 text-muted-foreground/40" />
            </div>
          )}
        </button>
      ))}
      {overflow > 0 && (
        <button
          onClick={() => onImageClick(photos[KEEP])}
          className="grid aspect-square place-items-center rounded-lg bg-foreground font-mono text-sm font-medium text-background transition-opacity hover:opacity-90"
        >
          +{overflow}
        </button>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Manpower — headcount + hours per crew, the first thing an owner asks for.
// ---------------------------------------------------------------------------

interface ManpowerFormValues {
  company: string
  trade: string
  workers: string
  hours: string
}

const EMPTY_MANPOWER: ManpowerFormValues = { company: "", trade: "", workers: "", hours: "" }

function toManpowerInput(v: ManpowerFormValues): ManpowerInput {
  const workers = v.workers.trim() ? Number(v.workers) : undefined
  const hours = v.hours.trim() ? Number(v.hours) : undefined
  return {
    company: v.company.trim() || undefined,
    trade: v.trade.trim() || undefined,
    workers: Number.isFinite(workers) ? workers : undefined,
    hours: Number.isFinite(hours) ? hours : undefined,
  }
}

function ManpowerRowForm({
  initial,
  busy,
  onCancel,
  onSubmit,
}: {
  initial: ManpowerFormValues
  busy: boolean
  onCancel: () => void
  onSubmit: (values: ManpowerFormValues) => void
}) {
  const [form, setForm] = useState<ManpowerFormValues>(initial)
  const canSave = Boolean(form.company.trim() || form.trade.trim())

  return (
    <div className="flex flex-wrap items-center gap-2 rounded-md border bg-muted/30 p-2">
      <Input
        autoFocus
        value={form.company}
        onChange={(e) => setForm((f) => ({ ...f, company: e.target.value }))}
        placeholder="Company / sub"
        className="h-8 min-w-[8rem] flex-1 text-sm"
      />
      <Input
        value={form.trade}
        onChange={(e) => setForm((f) => ({ ...f, trade: e.target.value }))}
        placeholder="Trade"
        className="h-8 w-28 text-sm"
      />
      <Input
        value={form.workers}
        onChange={(e) => setForm((f) => ({ ...f, workers: e.target.value.replace(/[^0-9]/g, "") }))}
        placeholder="# crew"
        inputMode="numeric"
        className="h-8 w-20 text-sm tabular-nums"
      />
      <Input
        value={form.hours}
        onChange={(e) => setForm((f) => ({ ...f, hours: e.target.value.replace(/[^0-9.]/g, "") }))}
        placeholder="hrs"
        inputMode="decimal"
        className="h-8 w-16 text-sm tabular-nums"
      />
      <div className="flex items-center gap-1">
        <Button size="icon" className="h-8 w-8" disabled={!canSave || busy} onClick={() => onSubmit(form)}>
          <Check className="h-4 w-4" />
        </Button>
        <Button variant="ghost" size="icon" className="h-8 w-8" disabled={busy} onClick={onCancel}>
          <X className="h-4 w-4" />
        </Button>
      </div>
    </div>
  )
}

function ManpowerSection({
  report,
  dateKey,
  locked,
  carryForward,
  onAdd,
  onUpdate,
  onDelete,
}: {
  report: DailyReport | undefined
  dateKey: string
  locked: boolean
  carryForward?: { fromDate: string; rows: ManpowerInput[] } | null
  onAdd: DayRecordProps["onAddManpower"]
  onUpdate: DayRecordProps["onUpdateManpower"]
  onDelete: DayRecordProps["onDeleteManpower"]
}) {
  const manpower = report?.manpower ?? []
  const [adding, setAdding] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const totalWorkers = manpower.reduce((sum, m) => sum + (m.workers ?? 0), 0)
  const totalHours = manpower.reduce((sum, m) => sum + (m.hours ?? 0), 0)

  if (locked && manpower.length === 0) return null

  async function run(fn: () => Promise<unknown>, done: () => void) {
    setBusy(true)
    try {
      await fn()
      done()
    } catch (error) {
      console.error(error)
      toast.error(error instanceof Error ? error.message : "Failed to save manpower")
    } finally {
      setBusy(false)
    }
  }

  const gridCols = "grid grid-cols-[minmax(0,1fr)_minmax(0,7rem)_3rem_3.5rem_3.75rem] items-center gap-x-3"

  return (
    <Section
      label="Manpower"
      action={
        !locked && !adding ? (
          <Button variant="ghost" size="sm" className="h-7 text-xs text-muted-foreground" onClick={() => setAdding(true)}>
            <Plus className="mr-1 h-3.5 w-3.5" />
            Add crew
          </Button>
        ) : undefined
      }
    >
      {manpower.length === 0 && !adding ? (
        carryForward && !locked ? (
          <button
            type="button"
            disabled={busy}
            onClick={() =>
              run(
                async () => {
                  for (const row of carryForward.rows) await onAdd(dateKey, row)
                },
                () => {},
              )
            }
            className="group/cf flex w-full items-center gap-2.5 rounded-lg border border-dashed px-3 py-2.5 text-left text-sm text-muted-foreground transition-colors hover:border-primary/40 hover:bg-primary/5 hover:text-foreground"
          >
            <Copy className="h-3.5 w-3.5 flex-shrink-0 transition-colors group-hover/cf:text-primary" />
            <span>
              Copy {carryForward.rows.length} {carryForward.rows.length === 1 ? "crew" : "crews"} from{" "}
              <span className="font-medium">{format(new Date(`${carryForward.fromDate}T12:00:00`), "EEE, MMM d")}</span>
            </span>
            {busy && <span className="ml-auto text-xs">Copying…</span>}
          </button>
        ) : (
          <p className="text-sm text-muted-foreground">No crews on site recorded.</p>
        )
      ) : (
        <div>
          {manpower.length > 0 && (
            <div className={cn(gridCols, "border-b pb-1.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground/70")}>
              <span>Company</span>
              <span>Trade</span>
              <span className="text-right">Crew</span>
              <span className="text-right">Hours</span>
              <span aria-hidden />
            </div>
          )}

          {manpower.map((m) =>
            editingId === m.id ? (
              <div key={m.id} className="border-b border-border/60 py-1.5">
                <ManpowerRowForm
                  busy={busy}
                  initial={{
                    company: m.company ?? "",
                    trade: m.trade ?? "",
                    workers: m.workers != null ? String(m.workers) : "",
                    hours: m.hours != null ? String(m.hours) : "",
                  }}
                  onCancel={() => setEditingId(null)}
                  onSubmit={(values) => run(() => onUpdate(m.id, toManpowerInput(values)), () => setEditingId(null))}
                />
              </div>
            ) : (
              <div key={m.id} className={cn(gridCols, "group/mp border-b border-border/60 py-2 text-sm")}>
                <span className="min-w-0 truncate font-medium">{m.company || m.trade || "Crew"}</span>
                <span className="min-w-0 truncate text-muted-foreground">{m.company ? m.trade : undefined}</span>
                <span className="text-right font-mono text-xs tabular-nums">{m.workers ?? "—"}</span>
                <span className="text-right font-mono text-xs tabular-nums">{m.hours != null ? m.hours : "—"}</span>
                <span className="flex items-center justify-end gap-0.5">
                  {!locked && (
                    <span className="flex items-center gap-0.5 opacity-0 transition-opacity group-hover/mp:opacity-100">
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-6 w-6 text-muted-foreground"
                        aria-label="Edit crew"
                        onClick={() => setEditingId(m.id)}
                      >
                        <Edit className="h-3.5 w-3.5" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-6 w-6 text-muted-foreground hover:text-destructive"
                        aria-label="Remove crew"
                        disabled={busy}
                        onClick={() => run(() => onDelete(m.id), () => {})}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </span>
                  )}
                </span>
              </div>
            ),
          )}

          {manpower.length > 1 && (
            <div className={cn(gridCols, "py-2 text-sm font-medium")}>
              <span className="text-[10px] uppercase tracking-wide text-muted-foreground">Total</span>
              <span aria-hidden />
              <span className="text-right font-mono text-xs tabular-nums">{totalWorkers}</span>
              <span className="text-right font-mono text-xs tabular-nums">{totalHours > 0 ? totalHours : "—"}</span>
              <span aria-hidden />
            </div>
          )}

          {adding && (
            <div className="pt-2">
              <ManpowerRowForm
                initial={EMPTY_MANPOWER}
                busy={busy}
                onCancel={() => setAdding(false)}
                onSubmit={(values) => run(() => onAdd(dateKey, toManpowerInput(values)), () => setAdding(false))}
              />
            </div>
          )}
        </div>
      )}
    </Section>
  )
}

// A single field note: author + time + editable narrative + that note's photos +
// discussion thread. Only rendered for logs that carry a narrative, photos, or a
// conversation — logs that only fed the rollup sections don't get an empty card.
function NoteCard({
  log,
  photos,
  locked,
  addendum,
  mentionableUsers,
  onUpdateLog,
  onCreateComment,
  onDeleteLog,
  onImageClick,
}: {
  log: DailyLog
  photos: EnhancedFileMetadata[]
  locked: boolean
  addendum: boolean
  mentionableUsers: MentionableUser[]
  onUpdateLog: DayRecordProps["onUpdateLog"]
  onCreateComment: DayRecordProps["onCreateComment"]
  onDeleteLog?: DayRecordProps["onDeleteLog"]
  onImageClick: (file: EnhancedFileMetadata) => void
}) {
  const [isEditing, setIsEditing] = useState(false)
  const [draft, setDraft] = useState(log.notes ?? "")
  const [mentionIds, setMentionIds] = useState<string[]>((log.mentions ?? []).map((m) => m.mentioned_user_id))
  const [isSaving, setIsSaving] = useState(false)

  const comments = useMemo(
    () => (log.comments ?? []).slice().sort((a, b) => a.created_at.localeCompare(b.created_at)),
    [log.comments],
  )

  // Comments always render; the composer appears on demand so a day with many
  // discussed notes doesn't stack a column of empty inputs.
  const [threadOpen, setThreadOpen] = useState(false)
  const [reply, setReply] = useState("")
  const [replyMentions, setReplyMentions] = useState<string[]>([])
  const [isReplying, setIsReplying] = useState(false)

  useEffect(() => {
    if (isEditing) return
    setDraft(log.notes ?? "")
    setMentionIds((log.mentions ?? []).map((m) => m.mentioned_user_id))
  }, [isEditing, log.notes, log.mentions])

  async function save() {
    setIsSaving(true)
    try {
      await onUpdateLog(log.id, { summary: draft.trim(), weather: log.weather, mentioned_user_ids: mentionIds })
      setIsEditing(false)
      toast.success("Note updated")
    } catch (error) {
      console.error(error)
      toast.error(error instanceof Error ? error.message : "Failed to update note")
    } finally {
      setIsSaving(false)
    }
  }

  async function submitReply() {
    if (!reply.trim()) return
    setIsReplying(true)
    try {
      await onCreateComment(log.id, { body: reply.trim(), mentioned_user_ids: replyMentions })
      setReply("")
      setReplyMentions([])
      setThreadOpen(true)
      toast.success("Reply added")
    } catch (error) {
      console.error(error)
      toast.error("Failed to add reply")
    } finally {
      setIsReplying(false)
    }
  }

  return (
    <article className="group/log flex gap-3">
      <Avatar className="mt-0.5 h-7 w-7 flex-shrink-0">
        <AvatarImage src={log.author?.avatar_url} alt="" />
        <AvatarFallback className="bg-primary/12 text-[10px] font-semibold text-primary">
          {authorInitials(log.author)}
        </AvatarFallback>
      </Avatar>

      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="text-[13px] font-semibold leading-none">{log.created_via_portal ? log.portal_company_name ?? "Subcontractor" : authorName(log.author)}</span>
          {log.created_via_portal && <span className="border px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wider text-muted-foreground">From sub</span>}
          {log.created_at && (
            <span className="font-mono text-[10px] leading-none text-muted-foreground">
              {format(new Date(log.created_at), "h:mm a")}
            </span>
          )}
          {addendum && (
            <span className="rounded-full bg-amber-500/10 px-2 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-amber-700 dark:text-amber-500">
              Addendum
            </span>
          )}

          <span className="ml-auto flex items-center gap-0.5 opacity-0 transition-opacity group-hover/log:opacity-100">
            {!isEditing && (
              <Button
                variant="ghost"
                size="icon"
                className="h-6 w-6 text-muted-foreground"
                aria-label="Reply"
                onClick={() => setThreadOpen(true)}
              >
                <MessageSquare className="h-3.5 w-3.5" />
              </Button>
            )}
            {!isEditing && !locked && (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="ghost" size="icon" className="h-6 w-6 text-muted-foreground" aria-label="Note actions">
                    <MoreHorizontal className="h-3.5 w-3.5" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem onClick={() => setIsEditing(true)}>Edit note</DropdownMenuItem>
                  {onDeleteLog && (
                    <>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem
                        className="cursor-pointer font-medium text-destructive"
                        onClick={async () => {
                          if (!confirm("Delete this note? Comments and mentions on it are removed too.")) return
                          try {
                            await onDeleteLog(log.id)
                            toast.success("Note deleted")
                          } catch (error) {
                            console.error(error)
                            toast.error(error instanceof Error ? error.message : "Failed to delete note")
                          }
                        }}
                      >
                        Delete note
                      </DropdownMenuItem>
                    </>
                  )}
                </DropdownMenuContent>
              </DropdownMenu>
            )}
          </span>
        </div>

        <div className="mt-1.5">
          {isEditing ? (
            <div className="space-y-2">
              <div className="rounded-lg border bg-muted/30">
                <MentionTextarea
                  value={draft}
                  onChange={setDraft}
                  mentionableUsers={mentionableUsers}
                  mentionedUserIds={mentionIds}
                  onMentionedUserIdsChange={setMentionIds}
                  placeholder="What happened on site?"
                  rows={3}
                  className="min-h-[84px]"
                />
              </div>
              <div className="flex justify-end gap-2">
                <Button variant="ghost" size="sm" onClick={() => setIsEditing(false)} disabled={isSaving}>
                  Cancel
                </Button>
                <Button size="sm" onClick={() => void save()} disabled={isSaving}>
                  {isSaving ? "Saving…" : "Save"}
                </Button>
              </div>
            </div>
          ) : log.notes ? (
            <p className="whitespace-pre-wrap text-sm leading-relaxed">
              <HighlightedMentionsText value={log.notes} mentionableUsers={mentionableUsers} />
            </p>
          ) : (
            <p className="text-sm italic text-muted-foreground">Photos only — no narrative.</p>
          )}
        </div>

        {photos.length > 0 && !isEditing && (
          <div className="mt-2.5">
            <PhotoGrid photos={photos} onImageClick={onImageClick} />
          </div>
        )}

        {/* Thread — conversation hangs off the note on a rail; it stays open
            even on a submitted report, since talk is not part of the locked record. */}
        {(comments.length > 0 || threadOpen) && (
          <div className="mt-3 space-y-3 border-l-2 border-border/70 pl-3.5">
            {comments.map((c) => (
              <div key={c.id} className="flex gap-2.5">
                <Avatar className="h-5 w-5 flex-shrink-0">
                  <AvatarImage src={c.author?.avatar_url} alt="" />
                  <AvatarFallback className="bg-primary/12 text-[8px] font-semibold text-primary">
                    {authorInitials(c.author)}
                  </AvatarFallback>
                </Avatar>
                <div className="min-w-0 flex-1">
                  <div className="flex items-baseline gap-2">
                    <span className="text-xs font-semibold">{authorName(c.author)}</span>
                    <span className="font-mono text-[10px] text-muted-foreground">
                      {format(new Date(c.created_at), "MMM d, h:mm a")}
                    </span>
                  </div>
                  <p className="mt-0.5 whitespace-pre-wrap text-[13px] leading-snug">
                    <HighlightedMentionsText value={c.body} mentionableUsers={mentionableUsers} />
                  </p>
                </div>
              </div>
            ))}

            {threadOpen ? (
              <div className="flex items-end gap-2">
                <div className="min-w-0 flex-1 rounded-lg border bg-background">
                  <MentionTextarea
                    value={reply}
                    onChange={setReply}
                    mentionableUsers={mentionableUsers}
                    mentionedUserIds={replyMentions}
                    onMentionedUserIdsChange={setReplyMentions}
                    placeholder="Reply or @mention…"
                    multiline={false}
                    onSubmit={() => void submitReply()}
                  />
                </div>
                <Button
                  size="icon"
                  className="h-9 w-9 flex-shrink-0"
                  disabled={!reply.trim() || isReplying}
                  onClick={() => void submitReply()}
                >
                  <Send className="h-3.5 w-3.5" />
                </Button>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => setThreadOpen(true)}
                className="flex items-center gap-1.5 text-xs text-muted-foreground transition-colors hover:text-foreground"
              >
                <MessageSquare className="h-3 w-3" />
                Reply
              </button>
            )}
          </div>
        )}
      </div>
    </article>
  )
}

// The Draft / Submitted lifecycle control in the titleblock. Submitting an
// incomplete day is allowed, but never silently — the gate names what's missing.
function StatusControl({
  report,
  missing,
  onSubmit,
  onReopen,
}: {
  report: DailyReport | undefined
  missing: string[]
  onSubmit: DayRecordProps["onSubmitReport"]
  onReopen: DayRecordProps["onReopenReport"]
}) {
  const [busy, setBusy] = useState(false)
  const [gateOpen, setGateOpen] = useState(false)
  const submitted = report?.status === "submitted"

  async function run(fn: () => Promise<unknown>, success: string) {
    if (!report) return
    setBusy(true)
    try {
      await fn()
      toast.success(success)
    } catch (error) {
      console.error(error)
      toast.error(error instanceof Error ? error.message : "Something went wrong")
    } finally {
      setBusy(false)
    }
  }

  if (submitted) {
    return (
      <div className="flex items-center gap-2">
        <span
          className="flex items-center gap-1.5 rounded-full bg-emerald-500/10 px-2.5 py-1 text-xs font-medium text-emerald-700 dark:text-emerald-400"
          title={
            report?.submitted_at
              ? `Submitted ${format(new Date(report.submitted_at), "MMM d, h:mm a")}${
                  report.submitted_by_user ? ` by ${authorName(report.submitted_by_user)}` : ""
                }`
              : "Submitted"
          }
        >
          <Lock className="h-3.5 w-3.5" />
          Submitted
        </span>
        <Button
          variant="ghost"
          size="sm"
          className="h-8 text-xs text-muted-foreground"
          disabled={busy}
          onClick={() => run(() => onReopen(report!.id), "Report reopened")}
        >
          <Unlock className="mr-1 h-3.5 w-3.5" />
          Reopen
        </Button>
      </div>
    )
  }

  if (missing.length === 0) {
    return (
      <Button
        variant="outline"
        size="sm"
        className="h-8 text-xs"
        disabled={busy || !report}
        onClick={() => run(() => onSubmit(report!.id), "Report submitted")}
        title={!report ? "Add something to this day first" : undefined}
      >
        <Check className="mr-1 h-3.5 w-3.5" />
        Submit day
      </Button>
    )
  }

  return (
    <Popover open={gateOpen} onOpenChange={setGateOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          className="h-8 text-xs"
          disabled={busy || !report}
          title={!report ? "Add something to this day first" : undefined}
        >
          <Check className="mr-1 h-3.5 w-3.5" />
          Submit day
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-64 p-3">
        <p className="text-sm font-semibold">Submit with gaps?</p>
        <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
          This report is missing {missing.map((m) => m.toLowerCase()).join(", ")}. Submitting locks the record.
        </p>
        <div className="mt-3 flex justify-end gap-2">
          <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={() => setGateOpen(false)}>
            Keep editing
          </Button>
          <Button
            size="sm"
            className="h-7 text-xs"
            disabled={busy}
            onClick={() => {
              setGateOpen(false)
              void run(() => onSubmit(report!.id), "Report submitted")
            }}
          >
            Submit anyway
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  )
}

export function DayRecord({
  date,
  bucket,
  scheduleById,
  tasksById,
  punchById,
  mentionableUsers,
  projectAddress,
  projectId,
  reportNumber,
  carryForward,
  onNavigateDay,
  canGoNext,
  onAddLog,
  onUpdateLog,
  onCreateComment,
  onDeleteLog,
  onUpdateReport,
  onSubmitReport,
  onReopenReport,
  onAddManpower,
  onUpdateManpower,
  onDeleteManpower,
  onAddSection,
  onUpdateSection,
  onDeleteSection,
  onRefreshWeather,
  onImageClick,
}: DayRecordProps) {
  const report = bucket?.report
  const locked = report?.status === "submitted"
  const hasManpower = (report?.manpower?.length ?? 0) > 0
  const hasCommercialSections = (report?.delays?.length ?? 0) + (report?.equipment?.length ?? 0) + (report?.deliveries?.length ?? 0) + (report?.visitors?.length ?? 0) > 0

  const isEmpty = !bucket || (bucket.logs.length === 0 && bucket.photos.length === 0 && !hasManpower && !hasCommercialSections)
  const maxTradeHours = bucket ? Math.max(1, ...bucket.hoursByTrade.map((t) => t.hours)) : 1

  const dateKey = format(date, "yyyy-MM-dd")

  const inspectionCount = bucket ? bucket.passedInspections.length + bucket.failedInspections.length : 0

  const completeness = useMemo(() => dayCompleteness(bucket), [bucket])

  // Weather suggestion only matters while the field is empty and editable.
  const suggestedWeather = useSuggestedWeather(projectAddress, dateKey, !locked && !bucket?.weather)

  // What the schedule says should be happening on this date — context for the
  // narrative, and the first thing to check when a day reads empty.
  const scheduledToday = useMemo(() => {
    return Object.values(scheduleById)
      .filter((item) => {
        if (item.status === "cancelled") return false
        if (!item.start_date) return false
        const end = item.end_date ?? item.start_date
        return item.start_date.slice(0, 10) <= dateKey && dateKey <= end.slice(0, 10)
      })
      .sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0))
      .slice(0, 8)
  }, [scheduleById, dateKey])

  async function setWeather(weather: string) {
    try {
      await onUpdateReport(dateKey, { weather })
    } catch (error) {
      console.error(error)
      toast.error(error instanceof Error ? error.message : "Failed to set weather")
    }
  }

  async function setDayType(day_type: DailyReportDayType) {
    try {
      await onUpdateReport(dateKey, { day_type })
    } catch (error) {
      console.error(error)
      toast.error(error instanceof Error ? error.message : "Failed to set day type")
    }
  }

  async function setClientSharing(share_with_client: boolean) {
    try {
      await onUpdateReport(dateKey, { share_with_client })
    } catch (error) {
      console.error(error)
      toast.error(error instanceof Error ? error.message : "Failed to update sharing")
    }
  }

  async function refreshWeather() {
    if (!report) return
    try {
      await onRefreshWeather(report.id)
      toast.success("Weather refreshed")
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to refresh weather")
    }
  }

  // Schedule / task / punch items referenced by this day's entries.
  const links = useMemo(() => {
    if (!bucket) return [] as { kind: string; label: string }[]
    const seen = new Set<string>()
    const rows: { kind: string; label: string }[] = []
    for (const log of bucket.logs) {
      for (const e of log.entries ?? []) {
        if (e.schedule_item_id && scheduleById[e.schedule_item_id] && !seen.has(`s:${e.schedule_item_id}`)) {
          seen.add(`s:${e.schedule_item_id}`)
          rows.push({ kind: "Schedule", label: scheduleById[e.schedule_item_id].name })
        }
        if (e.task_id && tasksById[e.task_id] && !seen.has(`t:${e.task_id}`)) {
          seen.add(`t:${e.task_id}`)
          rows.push({ kind: "Task", label: tasksById[e.task_id].title })
        }
        if (e.punch_item_id && punchById[e.punch_item_id] && !seen.has(`p:${e.punch_item_id}`)) {
          seen.add(`p:${e.punch_item_id}`)
          rows.push({ kind: "Punch", label: punchById[e.punch_item_id].title })
        }
      }
    }
    return rows
  }, [bucket, scheduleById, tasksById, punchById])

  // Group photos under the log that owns them; the rest become "site photos".
  const { photosByLog, unlinkedPhotos } = useMemo(() => {
    const byLog = new Map<string, EnhancedFileMetadata[]>()
    const unlinked: EnhancedFileMetadata[] = []
    if (bucket) {
      const logIds = new Set(bucket.logs.map((l) => l.id))
      for (const photo of bucket.photos) {
        if (photo.daily_log_id && logIds.has(photo.daily_log_id)) {
          const list = byLog.get(photo.daily_log_id) ?? []
          list.push(photo)
          byLog.set(photo.daily_log_id, list)
        } else {
          unlinked.push(photo)
        }
      }
    }
    return { photosByLog: byLog, unlinkedPhotos: unlinked }
  }, [bucket])

  // Notes worth rendering as attributed cards: those with narrative, photos, or a
  // conversation. Logs that only carried typed entries already show in the rollup.
  const noteLogs = useMemo(() => {
    if (!bucket) return [] as DailyLog[]
    return bucket.logs.filter(
      (log) =>
        Boolean(log.notes?.trim()) ||
        (log.comments?.length ?? 0) > 0 ||
        (photosByLog.get(log.id)?.length ?? 0) > 0,
    )
  }, [bucket, photosByLog])

  const submittedAtMs = report?.submitted_at ? new Date(report.submitted_at).getTime() : null

  const hasRollup =
    !!bucket &&
    (bucket.totalHours > 0 ||
      bucket.workEntries.length > 0 ||
      bucket.passedInspections.length > 0 ||
      bucket.deliveries.length > 0 ||
      bucket.constraints.length > 0 ||
      bucket.safety.length > 0 ||
      bucket.taskUpdates.length > 0 ||
      bucket.punchUpdates.length > 0)

  return (
    <div className="flex min-w-0 flex-1 flex-col overflow-hidden bg-background">
      {/* Titleblock — a compact single-row header sized to match the navigator's
          header strip, so the two panes' top bars align. */}
      <header
        className={cn(
          "flex flex-shrink-0 items-center justify-between gap-3 border-b px-6",
          DAILY_LOGS_PANE_HEADER_CLASS,
        )}
      >
        <div className="flex min-w-0 items-baseline gap-2.5">
          <h1 className="truncate text-lg font-semibold leading-none tracking-tight">{format(date, "MMMM d, yyyy")}</h1>
          <span className="hidden whitespace-nowrap font-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground sm:inline">
            {format(date, "EEE")}
            {reportNumber != null && ` · Nº ${String(reportNumber).padStart(3, "0")}`}
          </span>
          {locked && report?.submitted_at && (
            <span
              className="hidden items-center gap-1 whitespace-nowrap font-mono text-[10px] uppercase tracking-wide text-emerald-700 dark:text-emerald-500 md:inline-flex"
              title={`Submitted ${format(new Date(report.submitted_at), "MMM d, h:mm a")}${
                report.submitted_by_user ? ` by ${authorName(report.submitted_by_user)}` : ""
              }`}
            >
              <Lock className="h-3 w-3" />
              Submitted {format(new Date(report.submitted_at), "MMM d")}
            </span>
          )}
        </div>
        <div className="flex flex-shrink-0 items-center gap-2">
          <div className="mr-1 flex items-center gap-0.5">
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8 text-muted-foreground"
              aria-label="Previous day"
              onClick={() => onNavigateDay(-1)}
            >
              <ChevronLeft className="h-4 w-4" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8 text-muted-foreground"
              aria-label="Next day"
              disabled={!canGoNext}
              onClick={() => onNavigateDay(1)}
            >
              <ChevronRight className="h-4 w-4" />
            </Button>
          </div>
          {!locked && !isEmpty && (
            <Popover>
              <PopoverTrigger asChild>
                <button
                  className="flex h-8 items-center gap-1.5 rounded-md px-2 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                  aria-label={`${completeness.done} of ${completeness.total} recorded`}
                >
                  <CompletenessRing completeness={completeness} size={18} strokeWidth={2.5} />
                  <span className="font-mono tabular-nums">
                    {completeness.done}/{completeness.total}
                  </span>
                </button>
              </PopoverTrigger>
              <PopoverContent align="end" className="w-52 p-2">
                <p className="px-1.5 pb-1.5 pt-0.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                  Report checklist
                </p>
                <div className="space-y-0.5">
                  {completeness.segments.map((seg) => (
                    <div key={seg.key} className="flex items-center gap-2 rounded px-1.5 py-1 text-sm">
                      <span
                        className={cn(
                          "grid h-4 w-4 place-items-center rounded-full",
                          seg.done ? "bg-emerald-500/15" : "border border-dashed border-muted-foreground/40",
                        )}
                      >
                        {seg.done && (
                          <Check className="h-2.5 w-2.5 text-emerald-600 dark:text-emerald-400" strokeWidth={3} />
                        )}
                      </span>
                      <span className={cn(!seg.done && "text-muted-foreground")}>{seg.label}</span>
                    </div>
                  ))}
                </div>
              </PopoverContent>
            </Popover>
          )}
          <StatusControl report={report} missing={completeness.missing} onSubmit={onSubmitReport} onReopen={onReopenReport} />
          {report ? <Button variant="ghost" size="sm" asChild><a href={`/projects/${projectId}/exports/daily-report?id=${report.id}`} target="_blank" rel="noreferrer">PDF</a></Button> : null}
          <Button
            variant={report?.share_with_client ? "secondary" : "ghost"}
            size="sm"
            disabled={locked}
            title={report?.share_with_client ? "Shared with client portal" : "Hidden from client portal"}
            onClick={() => void setClientSharing(!(report?.share_with_client ?? false))}
          >
            <Share2 className="mr-1.5 h-4 w-4" />
            {report?.share_with_client ? "Client" : "Private"}
          </Button>
          <Button size="sm" onClick={onAddLog}>
            <Plus className="mr-1.5 h-4 w-4" />
            {locked ? "Add addendum" : "Add log"}
          </Button>
        </div>
      </header>

      {/* Conditions bar: editable weather + day type, then the KPI scorecard. */}
      <div
        className={cn(
          "flex flex-shrink-0 flex-wrap items-center gap-x-4 gap-y-1.5 border-b px-6 text-xs",
          DAILY_LOGS_PANE_SUBHEADER_CLASS,
        )}
      >
        {/* Weather */}
        {locked ? (
            bucket?.weather ? (
              <span className="flex items-center gap-1.5 font-medium text-foreground">
                <span aria-hidden>{weatherEmoji(bucket.weather)}</span>
                {bucket.weather}
              </span>
            ) : (
              <span className="text-muted-foreground">Weather not recorded</span>
            )
          ) : (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button className="flex items-center gap-1.5 rounded-md px-1.5 py-0.5 font-medium text-foreground transition-colors hover:bg-muted">
                  {bucket?.weather ? (
                    <>
                      <span aria-hidden>{weatherEmoji(bucket.weather)}</span>
                      {bucket.weather}
                    </>
                  ) : (
                    <span className="text-muted-foreground">Set weather</span>
                  )}
                  <ChevronDown className="h-3 w-3 text-muted-foreground" />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start">
                <DropdownMenuLabel>Weather</DropdownMenuLabel>
                {WEATHER_OPTIONS.map((w) => (
                  <DropdownMenuItem key={w.value} onClick={() => void setWeather(w.value)}>
                    <span className="mr-2" aria-hidden>
                      {w.emoji}
                    </span>
                    {w.value}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          )}

          {/* Observed conditions for this address + date; one click records them. */}
          {!locked && !bucket?.weather && suggestedWeather && (
            <button
              onClick={() => void setWeather(suggestedWeather.condition)}
              className="flex items-center gap-1.5 rounded-full border border-dashed px-2.5 py-0.5 text-xs text-muted-foreground transition-colors hover:border-primary/40 hover:bg-primary/5 hover:text-foreground"
              title="Recorded conditions for the project address — click to apply"
            >
              <span aria-hidden>{weatherEmoji(suggestedWeather.condition)}</span>
              {suggestedWeather.condition}
              {suggestedWeather.tempMax != null && (
                <span className="tabular-nums">{suggestedWeather.tempMax}°</span>
              )}
              <span className="font-medium text-primary">Apply</span>
            </button>
          )}

          {!bucket?.weather && automaticWeatherText(report) && (
            <span className="font-mono text-[10px] tabular-nums text-muted-foreground" title="Automatic Open-Meteo observation">
              {automaticWeatherText(report)}
            </span>
          )}
          {!locked && report && (
            <button type="button" className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground hover:text-foreground" onClick={() => void refreshWeather()}>
              Refresh weather
            </button>
          )}

          {/* Day type */}
          {locked ? (
            report?.day_type && <span className="text-muted-foreground">{dayTypeLabel(report.day_type)}</span>
          ) : (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button className="flex items-center gap-1 rounded-md px-1.5 py-0.5 text-muted-foreground transition-colors hover:bg-muted">
                  {report?.day_type ? dayTypeLabel(report.day_type) : "Set day type"}
                  <ChevronDown className="h-3 w-3" />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start">
                <DropdownMenuLabel>Day type</DropdownMenuLabel>
                {DAY_TYPES.map((d) => (
                  <DropdownMenuItem key={d.value} onClick={() => void setDayType(d.value)}>
                    {d.label}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          )}

          {/* KPI scorecard */}
          {bucket && !isEmpty && (
            <>
              {bucket.manpowerWorkers > 0 && <Stat icon={Users}>{bucket.manpowerWorkers} on site</Stat>}
              {bucket.totalHours > 0 && (
                <Stat icon={Clock}>
                  {bucket.totalHours}h
                  {bucket.hoursByTrade.length > 0 && (
                    <span className="text-muted-foreground/70">
                      {" "}
                      · {bucket.hoursByTrade.length} {bucket.hoursByTrade.length === 1 ? "trade" : "trades"}
                    </span>
                  )}
                </Stat>
              )}
              {bucket.photos.length > 0 && (
                <Stat icon={Camera}>
                  {bucket.photos.length} {bucket.photos.length === 1 ? "photo" : "photos"}
                </Stat>
              )}
              {inspectionCount > 0 && (
                <Stat icon={CheckCircle2}>
                  {inspectionCount} {inspectionCount === 1 ? "inspection" : "inspections"}
                </Stat>
              )}
              {bucket.failedInspections.length > 0 && (
                <Stat icon={AlertTriangle} tone="danger">
                  {bucket.failedInspections.length} {bucket.failedInspections.length === 1 ? "issue" : "issues"}
                </Stat>
              )}
            </>
          )}
      </div>

      {/* What the schedule expected of this day — context, not a claim. */}
      {scheduledToday.length > 0 && (
        <div className="flex items-center gap-2 overflow-x-auto border-b bg-muted/30 px-6 py-2">
          <span className="flex flex-shrink-0 items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
            <CalendarDays className="h-3 w-3" />
            On the schedule
          </span>
          <div className="flex items-center gap-1.5">
            {scheduledToday.map((item) => (
              <span
                key={item.id}
                className="flex-shrink-0 whitespace-nowrap rounded-full border bg-background px-2 py-0.5 text-[11px] text-muted-foreground"
              >
                {item.name}
                {item.location && <span className="text-muted-foreground/60"> · {item.location}</span>}
              </span>
            ))}
          </div>
        </div>
      )}

      {/* Body */}
      <div className="min-h-0 flex-1 overflow-y-auto">
        {isEmpty ? (
          <div className="flex h-full flex-col items-center justify-center px-6 py-16 text-center">
            <div className="mb-4 grid h-14 w-14 place-items-center rounded-full bg-muted">
              <ClipboardList className="h-7 w-7 text-muted-foreground" />
            </div>
            <h3 className="font-semibold">No report for this day</h3>
            <p className="mt-1 max-w-[300px] text-sm text-muted-foreground">
              Capture manpower, weather, work, and progress for {format(date, "MMM d")}.
            </p>
            <div className="mt-4 flex items-center gap-2">
              <Button onClick={onAddLog}>
                <Plus className="mr-1.5 h-4 w-4" />
                Start this day&apos;s report
              </Button>
            </div>
            {/* Manpower can be added on an otherwise-empty day. */}
            <div className="mt-6 w-full max-w-md text-left">
              <ManpowerSection
                report={report}
                dateKey={dateKey}
                locked={locked}
                carryForward={carryForward}
                onAdd={onAddManpower}
                onUpdate={onUpdateManpower}
                onDelete={onDeleteManpower}
              />
              <CommercialSections
                report={report}
                dateKey={dateKey}
                locked={locked}
                scheduleItems={Object.values(scheduleById)}
                onAdd={onAddSection}
                onUpdate={onUpdateSection}
                onDelete={onDeleteSection}
              />
            </div>
          </div>
        ) : (
          <div className="mx-auto w-full max-w-3xl px-8 pb-6">
            {/* Failed inspections float to the top — the thing you must not miss. */}
            {bucket!.failedInspections.length > 0 && (
              <div className="mt-5 space-y-2 rounded-r-lg border-l-2 border-destructive bg-destructive/[0.04] py-3 pl-4 pr-4">
                {bucket!.failedInspections.map((e) => (
                  <div key={e.id} className="flex items-start gap-2.5 text-sm">
                    <XCircle className="mt-0.5 h-4 w-4 flex-shrink-0 text-destructive" />
                    <span>
                      <span className="font-semibold text-destructive">
                        {scheduleById[e.schedule_item_id ?? ""]?.name ?? "Inspection"} failed
                      </span>
                      {e.description && <span className="text-muted-foreground"> — {e.description}</span>}
                    </span>
                  </div>
                ))}
              </div>
            )}

            {/* Manpower — always present for a draft; hidden when locked + empty. */}
            <ManpowerSection
              report={report}
              dateKey={dateKey}
              locked={locked}
              carryForward={carryForward}
              onAdd={onAddManpower}
              onUpdate={onUpdateManpower}
              onDelete={onDeleteManpower}
            />

            <CommercialSections
              report={report}
              dateKey={dateKey}
              locked={locked}
              scheduleItems={Object.values(scheduleById)}
              onAdd={onAddSection}
              onUpdate={onUpdateSection}
              onDelete={onDeleteSection}
            />

            {bucket!.totalHours > 0 && (
              <Section
                label="Labor by trade"
                meta={`${bucket!.totalHours} hrs · ${bucket!.hoursByTrade.length} ${bucket!.hoursByTrade.length === 1 ? "trade" : "trades"}`}
              >
                <div className="space-y-2">
                  {bucket!.hoursByTrade.map((t) => (
                    <div key={t.trade} className="flex items-center gap-4">
                      <span className="w-32 flex-shrink-0 truncate text-sm">{t.trade}</span>
                      <div className="h-1 flex-1 overflow-hidden rounded-full bg-muted">
                        <div
                          className="h-full rounded-full bg-primary/80"
                          style={{ width: `${(t.hours / maxTradeHours) * 100}%` }}
                        />
                      </div>
                      <span className="w-12 flex-shrink-0 text-right font-mono text-xs tabular-nums text-muted-foreground">
                        {t.hours}h
                      </span>
                    </div>
                  ))}
                </div>
              </Section>
            )}

            {bucket!.workEntries.length > 0 && (
              <Section label="Work performed" meta={String(bucket!.workEntries.length)}>
                <div className="divide-y divide-border/60">
                  {bucket!.workEntries.map((e) => {
                    const scheduleItem = scheduleById[e.schedule_item_id ?? ""]
                    return (
                      <div key={e.id} className="flex items-center gap-4 py-2.5 text-sm">
                        <div className="min-w-0 flex-1">
                          <span className="font-medium">{scheduleItem?.name ?? e.description ?? "Work item"}</span>
                          {(e.trade || e.location) && (
                            <span className="ml-2 text-xs text-muted-foreground">
                              {[e.trade, e.location].filter(Boolean).join(" · ")}
                            </span>
                          )}
                        </div>
                        {e.hours != null && (
                          <span className="flex-shrink-0 font-mono text-xs tabular-nums text-muted-foreground">
                            {e.hours}h
                          </span>
                        )}
                        {e.progress != null && (
                          <div className="flex flex-shrink-0 items-center gap-2">
                            <div className="h-1 w-16 overflow-hidden rounded-full bg-muted">
                              <div
                                className={cn(
                                  "h-full rounded-full",
                                  e.progress >= 100 ? "bg-emerald-500" : "bg-primary/80",
                                )}
                                style={{ width: `${Math.min(e.progress, 100)}%` }}
                              />
                            </div>
                            <span className="w-9 text-right font-mono text-xs tabular-nums text-muted-foreground">
                              {e.progress}%
                            </span>
                          </div>
                        )}
                      </div>
                    )
                  })}
                </div>
              </Section>
            )}

            {bucket!.passedInspections.length > 0 && (
              <Section label="Inspections">
                <div className="divide-y divide-border/60">
                  {bucket!.passedInspections.map((e) => (
                    <div key={e.id} className="flex items-center gap-2.5 py-2 text-sm">
                      <CheckCircle2 className="h-4 w-4 flex-shrink-0 text-emerald-500" />
                      <span className="min-w-0 flex-1 truncate">
                        {scheduleById[e.schedule_item_id ?? ""]?.name ?? e.description ?? "Inspection"}
                      </span>
                      <span className="flex-shrink-0 text-xs font-medium text-emerald-600 dark:text-emerald-400">
                        Passed
                      </span>
                    </div>
                  ))}
                </div>
              </Section>
            )}

            {bucket!.deliveries.length > 0 && (
              <Section label="Deliveries">
                <div className="divide-y divide-border/60">
                  {bucket!.deliveries.map((e) => (
                    <div key={e.id} className="flex items-center gap-2.5 py-2 text-sm">
                      <Truck className="h-4 w-4 flex-shrink-0 text-muted-foreground" />
                      <span>{e.description ?? "Delivery"}</span>
                    </div>
                  ))}
                </div>
              </Section>
            )}

            {bucket!.constraints.length > 0 && (
              <Section label="Delays & constraints">
                <div className="space-y-2">
                  {bucket!.constraints.map((e) => (
                    <div
                      key={e.id}
                      className="flex items-start gap-2.5 border-l-2 border-amber-400 py-0.5 pl-3.5 text-sm dark:border-amber-500"
                    >
                      <span>{e.description ?? "Constraint"}</span>
                    </div>
                  ))}
                </div>
              </Section>
            )}

            {bucket!.safety.length > 0 && (
              <Section label="Safety">
                <div className="divide-y divide-border/60">
                  {bucket!.safety.map((e) => (
                    <div key={e.id} className="flex items-center gap-2.5 py-2 text-sm">
                      <ShieldCheck className="h-4 w-4 flex-shrink-0 text-muted-foreground" />
                      <span>{e.description ?? "Safety note"}</span>
                    </div>
                  ))}
                </div>
              </Section>
            )}

            {(bucket!.taskUpdates.length > 0 || bucket!.punchUpdates.length > 0) && (
              <Section label="Task & punch updates">
                <div className="divide-y divide-border/60">
                  {bucket!.taskUpdates.map((e) => {
                    const done = Boolean(e.metadata?.mark_complete)
                    return (
                      <div key={e.id} className="flex items-center gap-2.5 py-2 text-sm">
                        <span className="min-w-0 flex-1 truncate">{tasksById[e.task_id ?? ""]?.title ?? "Task"}</span>
                        <span
                          className={cn(
                            "flex-shrink-0 text-xs font-medium",
                            done ? "text-emerald-600 dark:text-emerald-400" : "text-blue-600 dark:text-blue-400",
                          )}
                        >
                          {done ? "Completed" : "Updated"}
                        </span>
                      </div>
                    )
                  })}
                  {bucket!.punchUpdates.map((e) => {
                    const closed = Boolean(e.metadata?.mark_closed)
                    return (
                      <div key={e.id} className="flex items-center gap-2.5 py-2 text-sm">
                        <span className="min-w-0 flex-1 truncate">
                          {punchById[e.punch_item_id ?? ""]?.title ?? "Punch item"}
                        </span>
                        <span
                          className={cn(
                            "flex-shrink-0 text-xs font-medium",
                            closed ? "text-emerald-600 dark:text-emerald-400" : "text-orange-600 dark:text-orange-400",
                          )}
                        >
                          {closed ? "Closed" : "In progress"}
                        </span>
                      </div>
                    )
                  })}
                </div>
              </Section>
            )}

            {links.length > 0 && (
              <Section label="Linked">
                <div className="flex flex-wrap gap-x-5 gap-y-1.5">
                  {links.map((l) => (
                    <span key={`${l.kind}-${l.label}`} className="flex items-baseline gap-1.5 text-sm">
                      <span className="font-mono text-[9px] font-semibold uppercase tracking-wide text-muted-foreground">
                        {l.kind}
                      </span>
                      <span className="max-w-[240px] truncate">{l.label}</span>
                    </span>
                  ))}
                </div>
              </Section>
            )}

            {/* Notes & discussion — attributed narrative, threads, and the team's
                @mention traffic. Talk anchored to the day it happened. */}
            {noteLogs.length > 0 && (
              <Section label="Notes & discussion" meta={String(noteLogs.length)}>
                <div className="space-y-6">
                  {noteLogs.map((log) => (
                    <NoteCard
                      key={log.id}
                      log={log}
                      photos={photosByLog.get(log.id) ?? []}
                      locked={locked}
                      addendum={
                        submittedAtMs != null && new Date(log.created_at).getTime() > submittedAtMs
                      }
                      mentionableUsers={mentionableUsers}
                      onUpdateLog={onUpdateLog}
                      onCreateComment={onCreateComment}
                      onDeleteLog={onDeleteLog}
                      onImageClick={onImageClick}
                    />
                  ))}
                </div>
              </Section>
            )}

            {/* Photos not tied to any specific note. */}
            {unlinkedPhotos.length > 0 && (
              <Section label="Site photos" meta={String(unlinkedPhotos.length)}>
                <PhotoGrid photos={unlinkedPhotos} onImageClick={onImageClick} />
              </Section>
            )}

            {/* A day with only manpower/conditions but no logged detail. */}
            {!hasRollup && noteLogs.length === 0 && unlinkedPhotos.length === 0 && (
              <div className="py-10 text-center text-sm text-muted-foreground">
                Manpower and conditions recorded. Add a log to capture work, photos, and notes.
              </div>
            )}
          </div>
        )}

        {/* End-of-document day nav: reviewing a week should feel like reading. */}
        <div className="mx-auto flex w-full max-w-3xl items-center justify-between border-t px-8 py-3">
          <button
            onClick={() => onNavigateDay(-1)}
            className="group flex items-center gap-1.5 rounded-md px-2 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            <ChevronLeft className="h-3.5 w-3.5 transition-transform group-hover:-translate-x-0.5" />
            {format(addDays(date, -1), "EEE, MMM d")}
          </button>
          {canGoNext && (
            <button
              onClick={() => onNavigateDay(1)}
              className="group flex items-center gap-1.5 rounded-md px-2 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            >
              {format(addDays(date, 1), "EEE, MMM d")}
              <ChevronRight className="h-3.5 w-3.5 transition-transform group-hover:translate-x-0.5" />
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
