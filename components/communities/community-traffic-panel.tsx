"use client"

import { useRouter } from "next/navigation"
import { useMemo, useState, useTransition } from "react"
import { toast } from "sonner"

import { logCommunityTrafficAction } from "@/app/(app)/communities/actions"
import { InlineStat } from "@/components/communities/inline-stat"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { unwrapAction } from "@/lib/action-result"
import type { CommunityTrafficDayDTO } from "@/lib/services/community-traffic"
import { cn } from "@/lib/utils"

export interface TrafficWeek {
  /** Monday of the week, ISO. */
  weekOf: string
  walkIns: number
  appointments: number
  webInquiries: number
}

const DAY_LABELS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]
const MONTH_LABELS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]

/** Monday of the week a date falls in, so weeks line up with a sales week. */
export function weekOf(isoDate: string) {
  const date = new Date(`${isoDate}T00:00:00Z`)
  date.setUTCDate(date.getUTCDate() - ((date.getUTCDay() + 6) % 7))
  return date.toISOString().slice(0, 10)
}

function addDays(isoDate: string, days: number) {
  const date = new Date(`${isoDate}T00:00:00Z`)
  date.setUTCDate(date.getUTCDate() + days)
  return date.toISOString().slice(0, 10)
}

function shortDate(isoDate: string) {
  const date = new Date(`${isoDate}T00:00:00Z`)
  return `${MONTH_LABELS[date.getUTCMonth()]} ${date.getUTCDate()}`
}

const EMPTY_DAY = { walkIns: "", appointments: "", webInquiries: "" }
type DayDraft = typeof EMPTY_DAY

/**
 * Traffic → appointments → sales: the production sales office's Monday number.
 *
 * Weekly counts are a shape, not a list, so they are drawn rather than tabled —
 * the table stays behind a disclosure for anyone reconciling a number. The
 * consultant fills a whole week at once, because that is when they sit down to
 * do it; `/sales` also increments web inquiries as a side effect of a new
 * inquiry, and the two compose rather than clobber.
 */
export function CommunityTrafficPanel({
  communityId,
  weeks,
  recentDays,
  salesInWindow,
  cancelsInWindow,
  windowDays,
  pacePerMonth,
  requiredPacePerMonth,
  canManage,
}: {
  communityId: string
  weeks: TrafficWeek[]
  recentDays: CommunityTrafficDayDTO[]
  /** Net sales over the same window the traffic covers. A conversion rate that
   *  divides a quarter of sales by two months of visits is not a rate. */
  salesInWindow: number
  cancelsInWindow: number
  windowDays: number
  /** What the community is actually absorbing, and what it has to. */
  pacePerMonth: number | null
  requiredPacePerMonth: number | null
  canManage: boolean
}) {
  const router = useRouter()
  const [isPending, startTransition] = useTransition()
  const [open, setOpen] = useState(false)
  const [showTable, setShowTable] = useState(false)
  const [weekStart, setWeekStart] = useState("")
  const [draft, setDraft] = useState<DayDraft[]>(() => DAY_LABELS.map(() => ({ ...EMPTY_DAY })))

  const totals = weeks.reduce(
    (sum, week) => ({
      walkIns: sum.walkIns + week.walkIns,
      appointments: sum.appointments + week.appointments,
      webInquiries: sum.webInquiries + week.webInquiries,
    }),
    { walkIns: 0, appointments: 0, webInquiries: 0 },
  )
  const traffic = totals.walkIns + totals.webInquiries

  const byDate = useMemo(() => new Map(recentDays.map((day) => [day.loggedDate, day])), [recentDays])
  /** Oldest week first, so the bars read left to right like a calendar. */
  const chartWeeks = useMemo(() => [...weeks].sort((a, b) => a.weekOf.localeCompare(b.weekOf)), [weeks])
  const peak = Math.max(1, ...chartWeeks.map((week) => week.walkIns + week.webInquiries))

  function openWeek(startDate: string) {
    const monday = weekOf(startDate)
    setWeekStart(monday)
    setDraft(
      DAY_LABELS.map((_, index) => {
        const day = byDate.get(addDays(monday, index))
        return day
          ? {
              walkIns: String(day.walkIns),
              appointments: String(day.appointments),
              webInquiries: String(day.webInquiries),
            }
          : { ...EMPTY_DAY }
      }),
    )
    setOpen(true)
  }

  function submit() {
    startTransition(async () => {
      try {
        // Only touched days are written, so opening the week to fix Thursday
        // does not stamp a zero over the rest of it.
        const edits = draft
          .map((day, index) => ({ day, date: addDays(weekStart, index) }))
          .filter(({ day, date }) => {
            const existing = byDate.get(date)
            const entered = {
              walkIns: Number(day.walkIns || 0),
              appointments: Number(day.appointments || 0),
              webInquiries: Number(day.webInquiries || 0),
            }
            if (!existing) return entered.walkIns > 0 || entered.appointments > 0 || entered.webInquiries > 0
            return (
              entered.walkIns !== existing.walkIns ||
              entered.appointments !== existing.appointments ||
              entered.webInquiries !== existing.webInquiries
            )
          })
        if (edits.length === 0) {
          setOpen(false)
          return
        }
        for (const { day, date } of edits) {
          unwrapAction(
            await logCommunityTrafficAction({
              communityId,
              loggedDate: date,
              walkIns: Number(day.walkIns || 0),
              appointments: Number(day.appointments || 0),
              webInquiries: Number(day.webInquiries || 0),
            }),
          )
        }
        toast.success(`${edits.length} ${edits.length === 1 ? "day" : "days"} logged`)
        setOpen(false)
        router.refresh()
      } catch (error) {
        toast.error("Unable to log traffic", { description: (error as Error).message })
      }
    })
  }

  const behind = pacePerMonth != null && requiredPacePerMonth != null && pacePerMonth < requiredPacePerMonth

  return (
    <section className="border">
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-b px-4 py-2.5">
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <h2 className="microlabel">Demand</h2>
          <p className="text-[11px] text-muted-foreground">last {windowDays} days</p>
        </div>
        {canManage ? (
          <Button
            size="sm"
            variant="outline"
            className="h-7 rounded-none text-xs"
            onClick={() => openWeek(new Date().toISOString().slice(0, 10))}
          >
            Log a week
          </Button>
        ) : null}
      </div>

      {/* The funnel is the whole point of the counts: what walked in, what sat
          down, what signed. Stated as a line so the drop between each step is
          the thing you read, not four numbers to subtract in your head. */}
      <dl className="flex flex-wrap items-baseline gap-x-5 gap-y-1 border-b px-4 py-2">
        <InlineStat label="Visits" value={String(traffic)} />
        <InlineStat
          label="Appointments"
          value={String(totals.appointments)}
          hint={traffic > 0 ? `${((totals.appointments / traffic) * 100).toFixed(0)}%` : undefined}
        />
        <InlineStat
          label="Sales"
          value={String(salesInWindow)}
          hint={traffic > 0 ? `${((salesInWindow / traffic) * 100).toFixed(1)}% of visits` : undefined}
        />
        {cancelsInWindow > 0 ? (
          <InlineStat label="Cancelled" value={String(cancelsInWindow)} tone="text-destructive" />
        ) : null}
        {/* Pace itself is the community header's number and is not repeated here.
            What the header cannot say is how far behind target the shortfall
            runs, so that is the only part of it this line carries. */}
        {behind ? (
          <InlineStat
            label="Behind"
            value={`${((requiredPacePerMonth as number) - (pacePerMonth as number)).toFixed(1)}`}
            hint="sales a month"
            tone="text-destructive"
          />
        ) : null}
      </dl>

      {chartWeeks.length === 0 ? (
        <p className="px-4 py-10 text-center text-xs text-muted-foreground">
          No traffic logged yet. Weekly counts are what pace and conversion are measured against.
        </p>
      ) : (
        <div className="p-4">
          <div className="flex items-end gap-2">
            {chartWeeks.map((week) => {
              const visits = week.walkIns + week.webInquiries
              return (
                <button
                  key={week.weekOf}
                  type="button"
                  disabled={!canManage}
                  onClick={() => openWeek(week.weekOf)}
                  title={`Week of ${shortDate(week.weekOf)}: ${week.walkIns} walk-ins, ${week.webInquiries} web, ${week.appointments} appointments`}
                  className="group flex flex-1 flex-col items-center gap-1.5 text-center"
                >
                  <span className="text-[11px] tabular-nums text-muted-foreground">{visits}</span>
                  <span className="flex h-24 w-full flex-col justify-end">
                    {/* Web sits on walk-ins because together they are the visit
                        count the conversion rate divides by. */}
                    <span
                      className="w-full bg-chart-2 transition-opacity group-hover:opacity-80"
                      style={{ height: `${(week.webInquiries / peak) * 100}%` }}
                    />
                    <span
                      className="w-full bg-chart-1 transition-opacity group-hover:opacity-80"
                      style={{ height: `${(week.walkIns / peak) * 100}%` }}
                    />
                  </span>
                  <span
                    className={cn(
                      "w-full border-t pt-1 text-[10px] tabular-nums",
                      week.appointments > 0 ? "text-foreground" : "text-muted-foreground/60",
                    )}
                  >
                    {week.appointments} appt
                  </span>
                  <span className="text-[10px] text-muted-foreground">{shortDate(week.weekOf)}</span>
                </button>
              )
            })}
          </div>
          <div className="mt-3 flex items-center gap-4 border-t pt-2 text-[11px] text-muted-foreground">
            <span className="flex items-center gap-1.5">
              <span className="size-2 bg-chart-1" /> Walk-ins
            </span>
            <span className="flex items-center gap-1.5">
              <span className="size-2 bg-chart-2" /> Web
            </span>
            <button
              type="button"
              className="ml-auto underline underline-offset-2 hover:text-foreground"
              onClick={() => setShowTable((current) => !current)}
            >
              {showTable ? "Hide weekly counts" : "Show weekly counts"}
            </button>
          </div>
        </div>
      )}

      {showTable && chartWeeks.length > 0 ? (
        <div className="overflow-x-auto border-t">
          <Table>
            <TableHeader>
              <TableRow className="microlabel hover:bg-transparent">
                <TableHead>Week of</TableHead>
                <TableHead className="text-right">Walk-ins</TableHead>
                <TableHead className="text-right">Web</TableHead>
                <TableHead className="text-right">Appointments</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {weeks.map((week) => (
                <TableRow key={week.weekOf} className="text-xs">
                  <TableCell className="tabular-nums">{week.weekOf}</TableCell>
                  <TableCell className="text-right tabular-nums">{week.walkIns}</TableCell>
                  <TableCell className="text-right tabular-nums text-muted-foreground">{week.webInquiries}</TableCell>
                  <TableCell className="text-right tabular-nums">{week.appointments}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      ) : null}

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="rounded-none sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Week of {weekStart ? shortDate(weekStart) : ""}</DialogTitle>
            <DialogDescription>
              What was already logged is filled in. A day you do not touch is left exactly as it is.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-2">
            <div className="grid grid-cols-[3.5rem_1fr_1fr_1fr] items-center gap-2">
              <span />
              <span className="microlabel text-center">Walk-ins</span>
              <span className="microlabel text-center">Web</span>
              <span className="microlabel text-center">Appts</span>
            </div>
            {DAY_LABELS.map((label, index) => (
              <div key={label} className="grid grid-cols-[3.5rem_1fr_1fr_1fr] items-center gap-2">
                <Label htmlFor={`traffic-${index}-walk`} className="text-xs text-muted-foreground">
                  {label}
                </Label>
                {(["walkIns", "webInquiries", "appointments"] as const).map((field) => (
                  <Input
                    key={field}
                    id={field === "walkIns" ? `traffic-${index}-walk` : undefined}
                    aria-label={`${label} ${field === "walkIns" ? "walk-ins" : field === "webInquiries" ? "web inquiries" : "appointments"}`}
                    type="number"
                    min={0}
                    className="h-8 rounded-none text-center text-xs tabular-nums"
                    value={draft[index][field]}
                    onChange={(event) =>
                      setDraft((current) =>
                        current.map((day, position) =>
                          position === index ? { ...day, [field]: event.target.value } : day,
                        ),
                      )
                    }
                  />
                ))}
              </div>
            ))}
          </div>
          <DialogFooter className="items-center sm:justify-between">
            <button
              type="button"
              className="text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground"
              onClick={() => openWeek(addDays(weekStart, -7))}
            >
              Previous week
            </button>
            <div className="flex gap-2">
              <Button variant="outline" onClick={() => setOpen(false)}>
                Cancel
              </Button>
              <Button disabled={!weekStart || isPending} onClick={submit}>
                {isPending ? "Saving…" : "Save week"}
              </Button>
            </div>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  )
}
