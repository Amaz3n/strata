"use client"

import { useEffect, useMemo, useState } from "react"
import { format } from "date-fns"
import { toast } from "sonner"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Plus, Lock, Unlock, Check, X, Edit, Trash2, Copy } from "@/components/icons"
import type { DailyLog, DailyReport } from "@/lib/types"
import type { ManpowerInput } from "@/lib/validation/daily-logs"
import type { DailyLogsWorkspaceProps } from "./types"
import { WEATHER_OPTIONS, dayCompleteness, type DayBucket } from "./day-aggregate"
import { CommercialSections } from "./commercial-sections"

interface DayDetailsProps extends Pick<
  DailyLogsWorkspaceProps,
  | "projectId"
  | "scheduleItems"
  | "onUpdateReport"
  | "onSubmitReport"
  | "onReopenReport"
  | "onAddManpower"
  | "onUpdateManpower"
  | "onDeleteManpower"
  | "onAddSection"
  | "onUpdateSection"
  | "onDeleteSection"
  | "onRefreshWeather"
> {
  date: Date
  hasUnsavedLog: boolean
  bucket: DayBucket | undefined
  carryForward?: { fromDate: string; rows: ManpowerInput[] } | null
}

type LogAuthor = NonNullable<DailyLog["author"]>
function authorName(author: LogAuthor | undefined) {
  return author?.full_name?.trim() || author?.email?.trim() || "Unknown author"
}

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

interface ManpowerFormValues {
  company: string
  trade: string
  workers: string
  hours: string
}

const EMPTY_MANPOWER: ManpowerFormValues = {
  company: "",
  trade: "",
  workers: "",
  hours: "",
}

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
    <div className="flex flex-wrap items-center gap-2 border bg-muted/30 p-2">
      <Input
        autoFocus
        value={form.company}
        onChange={(e) => setForm((f) => ({ ...f, company: e.target.value }))}
        aria-label="Crew company"
        placeholder="Company / sub"
        className="h-8 min-w-[8rem] flex-1 text-sm"
      />
      <Input
        value={form.trade}
        onChange={(e) => setForm((f) => ({ ...f, trade: e.target.value }))}
        aria-label="Crew trade"
        placeholder="Trade"
        className="h-8 w-28 text-sm"
      />
      <Input
        value={form.workers}
        onChange={(e) =>
          setForm((f) => ({
            ...f,
            workers: e.target.value.replace(/[^0-9]/g, ""),
          }))
        }
        aria-label="Number of workers"
        placeholder="# crew"
        inputMode="numeric"
        className="h-8 w-20 text-sm tabular-nums"
      />
      <Input
        value={form.hours}
        onChange={(e) =>
          setForm((f) => ({
            ...f,
            hours: e.target.value.replace(/[^0-9.]/g, ""),
          }))
        }
        aria-label="Crew hours"
        placeholder="hrs"
        inputMode="decimal"
        className="h-8 w-16 text-sm tabular-nums"
      />
      <div className="flex items-center gap-1">
        <Button
          aria-label="Save crew"
          size="icon"
          className="h-8 w-8"
          disabled={!canSave || busy}
          onClick={() => onSubmit(form)}
        >
          <Check className="h-4 w-4" />
        </Button>
        <Button
          aria-label="Cancel crew changes"
          variant="ghost"
          size="icon"
          className="h-8 w-8"
          disabled={busy}
          onClick={onCancel}
        >
          <X className="h-4 w-4" />
        </Button>
      </div>
    </div>
  )
}

function ManpowerSection({
  onPendingChange,
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
  onPendingChange: (pending: boolean) => void
  onAdd: DayDetailsProps["onAddManpower"]
  onUpdate: DayDetailsProps["onUpdateManpower"]
  onDelete: DayDetailsProps["onDeleteManpower"]
}) {
  const manpower = report?.manpower ?? []
  const [adding, setAdding] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    onPendingChange(adding || editingId !== null || busy)
  }, [onPendingChange, adding, editingId, busy])

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

  const gridCols = "grid grid-cols-[minmax(0,1fr)_minmax(0,0.7fr)_2rem_2.5rem_3.5rem] items-center gap-x-1 sm:gap-x-3"

  return (
    <Section
      label="Crews on site"
      action={
        !locked && !adding ? (
          <Button
            variant="ghost"
            size="sm"
            className="h-7 text-xs text-muted-foreground"
            onClick={() => setAdding(true)}
          >
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
            className="group/cf flex w-full items-center gap-2.5 border border-dashed px-3 py-2.5 text-left text-sm text-muted-foreground transition-colors hover:border-primary/40 hover:bg-primary/5 hover:text-foreground"
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
            <div
              className={cn(
                gridCols,
                "border-b pb-1.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground/70",
              )}
            >
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
                  onSubmit={(values) =>
                    run(
                      () => onUpdate(m.id, toManpowerInput(values)),
                      () => setEditingId(null),
                    )
                  }
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
                    <span className="flex items-center gap-0.5 opacity-100">
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
                        onClick={() =>
                          run(
                            () => onDelete(m.id),
                            () => {},
                          )
                        }
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
                onSubmit={(values) =>
                  run(
                    () => onAdd(dateKey, toManpowerInput(values)),
                    () => setAdding(false),
                  )
                }
              />
            </div>
          )}
        </div>
      )}
    </Section>
  )
}

function StatusControl({
  blocked,
  report,
  missing,
  onSubmit,
  onReopen,
}: {
  blocked: boolean
  report: DailyReport | undefined
  missing: string[]
  onSubmit: DayDetailsProps["onSubmitReport"]
  onReopen: DayDetailsProps["onReopenReport"]
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
          className="flex items-center gap-1.5 rounded-full bg-success/10 px-2.5 py-1 text-xs font-medium text-success"
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
        disabled={busy || !report || blocked}
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
          disabled={busy || !report || blocked}
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

export function DayDetails(props: DayDetailsProps) {
  const { date, bucket, projectId, carryForward } = props
  const report = bucket?.report
  const locked = report?.status === "submitted"
  const recordedWeather = report?.weather ?? bucket?.weather ?? ""
  const dateKey = format(date, "yyyy-MM-dd")
  const [crewPending, setCrewPending] = useState(false)
  const [sectionPending, setSectionPending] = useState(false)
  const completeness = useMemo(() => dayCompleteness(bucket), [bucket])
  const [busy, setBusy] = useState(false)
  async function update(values: Parameters<DayDetailsProps["onUpdateReport"]>[1]) {
    setBusy(true)
    try {
      await props.onUpdateReport(dateKey, values)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Unable to save day details")
    } finally {
      setBusy(false)
    }
  }
  async function refreshWeather() {
    if (!report) return
    setBusy(true)
    try {
      await props.onRefreshWeather(report.id)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Unable to refresh weather")
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="border-b pb-5" aria-label="Day details">
      <p className="pt-4 text-xs leading-5 text-muted-foreground">
        Add details that apply to the whole day. Your saved logs below are included in the report automatically.
      </p>
      <Section label="Conditions">
        <div className="grid gap-4 sm:grid-cols-2">
          <label className="space-y-1.5 text-xs font-medium">
            <span>Weather</span>
            <select
              aria-label="Day weather"
              value={recordedWeather}
              disabled={locked || busy}
              onChange={(event) => void update({ weather: event.target.value })}
              className="h-9 w-full border bg-background px-2 text-sm disabled:opacity-60"
            >
              <option value="" disabled>Not recorded</option>
              {recordedWeather && !WEATHER_OPTIONS.some((option) => option.value === recordedWeather) && (
                <option value={recordedWeather}>{recordedWeather}</option>
              )}
              {WEATHER_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.value}
                </option>
              ))}
            </select>
          </label>
          <label className="space-y-1.5 text-xs font-medium">
            <span>Day type</span>
            <select
              aria-label="Day type"
              value={report?.day_type ?? ""}
              disabled={locked || busy}
              onChange={(event) => {
                const value = event.target.value
                if (
                  value === "work_day" ||
                  value === "rain_day" ||
                  value === "weekend" ||
                  value === "holiday" ||
                  value === "no_work"
                )
                  void update({ day_type: value })
              }}
              className="h-9 w-full border bg-background px-2 text-sm disabled:opacity-60"
            >
              <option value="" disabled>
                Not recorded
              </option>
              <option value="work_day">Work day</option>
              <option value="rain_day">Rain day</option>
              <option value="weekend">Weekend</option>
              <option value="holiday">Holiday</option>
              <option value="no_work">No work</option>
            </select>
          </label>
        </div>
        {report?.weather_auto && (
          <p className="mt-2 text-xs text-muted-foreground">
            Observed weather: {format(new Date(report.weather_auto.fetched_at), "MMM d, h:mm a")}
            {report.weather_auto.temperature_max != null &&
              ` · ${Math.round(report.weather_auto.temperature_max)}${report.weather_auto.units?.temperature ?? "°F"}`}
          </p>
        )}
        {!locked && report && (
          <Button
            variant="ghost"
            size="sm"
            className="mt-2 h-7 px-0 text-xs"
            disabled={busy}
            onClick={() => void refreshWeather()}
          >
            Refresh observed weather
          </Button>
        )}
      </Section>
      <ManpowerSection
        onPendingChange={setCrewPending}
        report={report}
        dateKey={dateKey}
        locked={locked}
        carryForward={carryForward}
        onAdd={props.onAddManpower}
        onUpdate={props.onUpdateManpower}
        onDelete={props.onDeleteManpower}
      />
      <CommercialSections
        onPendingChange={setSectionPending}
        report={report}
        dateKey={dateKey}
        locked={locked}
        scheduleItems={props.scheduleItems}
        onAdd={props.onAddSection}
        onUpdate={props.onUpdateSection}
        onDelete={props.onDeleteSection}
      />
      <div className="mt-5 space-y-4 border-t pt-5">
        <div>
          <h3 className="text-sm font-medium">{locked ? "Submitted report" : "Finish the day"}</h3>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">
            {locked
              ? "The report is locked. New logs are recorded as addenda."
              : "Submitting locks the day’s record. You can still add an addendum afterward."}
          </p>
          {!locked && completeness.missing.length > 0 && (
            <p className="mt-1 text-xs text-muted-foreground">
              Not recorded: {completeness.missing.join(", ")}. You can submit with these gaps.
            </p>
          )}
        </div>
        {!locked && (crewPending || sectionPending) && (
          <p role="status" className="text-xs text-muted-foreground">
            Save or cancel unfinished day details before submitting.
          </p>
        )}
        {!locked && props.hasUnsavedLog && (
          <p role="status" className="text-xs text-muted-foreground">
            Save the unfinished log above before submitting this day.
          </p>
        )}
        <label className="flex items-center gap-2 text-xs">
          <input
            type="checkbox"
            checked={report?.share_with_client ?? false}
            disabled={locked || busy}
            onChange={(event) => void update({ share_with_client: event.target.checked })}
          />
          Share report in client portal
        </label>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <StatusControl
            blocked={props.hasUnsavedLog || crewPending || sectionPending || busy}
            report={report}
            missing={completeness.missing}
            onSubmit={props.onSubmitReport}
            onReopen={props.onReopenReport}
          />
          {report && (
            <Button variant="ghost" size="sm" asChild>
              <a href={`/projects/${projectId}/exports/daily-report?id=${report.id}`} target="_blank" rel="noreferrer">
                Open report PDF
              </a>
            </Button>
          )}
        </div>
      </div>
    </div>
  )
}
