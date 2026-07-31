"use client"

import { useMemo, useState } from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"

import type { RunwayHome, StudioRunway } from "@/lib/services/design-studio"
import { StudioShell } from "@/components/design-studio/studio-shell"
import { BookAppointmentDialog } from "@/components/design-studio/book-appointment-dialog"
import { Button } from "@/components/ui/button"
import { AlertTriangle, Calendar } from "@/components/icons"

import "./studio.css"

/** Counter chips double as filters — the desk's only filtering affordance. */
type Focus = "all" | "overdue" | "due_soon" | "unbooked" | "ready"

/** Column tones. Only the bucket that is genuinely broken carries a fill. */
type Tone = "late" | "soon" | "neutral" | "none"

type BucketKey = "past" | "week" | "next" | "month" | "later" | "none"

interface Props {
  runway: StudioRunway
  communityId?: string
  bookableHomes: Array<{ projectId: string; label: string; communityId: string | null }>
  canManage: boolean
}

/**
 * Time is bucketed rather than plotted. A coordinator asks "who do I have to
 * call this week", not "where does this lot sit on a twelve-week continuum" —
 * and a calendar axis has to invent a position for a cutoff that never
 * resolved, which put "we could not compute a date" in the same place as
 * "two months late". Every home lands in exactly one honest column instead.
 */
const BUCKETS: Array<{ key: BucketKey; label: string; tone: Tone }> = [
  { key: "past", label: "Past cutoff", tone: "late" },
  { key: "week", label: "This week", tone: "soon" },
  { key: "next", label: "Next week", tone: "neutral" },
  { key: "month", label: "2–4 weeks", tone: "neutral" },
  { key: "later", label: "5+ weeks", tone: "neutral" },
  { key: "none", label: "No date", tone: "none" },
]

/**
 * Past this many chips a cell collapses. Row height is set by the fullest cell
 * in it, so an uncapped pile-up in one bucket would push five empty cells to
 * the same height. The count of what is hidden is always shown.
 */
const CELL_CAP = 4

function bucketFor(home: RunwayHome): BucketKey {
  if (home.daysToCutoff === null) return "none"
  if (home.daysToCutoff < 0) return "past"
  if (home.daysToCutoff < 7) return "week"
  if (home.daysToCutoff < 14) return "next"
  if (home.daysToCutoff < 28) return "month"
  return "later"
}

function matchesFocus(home: RunwayHome, focus: Focus): boolean {
  switch (focus) {
    case "overdue":
      return home.state === "overdue"
    case "due_soon":
      return home.state === "due_soon"
    case "unbooked":
      return !home.appointmentAt && (home.state === "overdue" || home.state === "due_soon")
    case "ready":
      return home.categoryCount > 0 && home.chosenCount === home.categoryCount
    default:
      return true
  }
}

function formatDay(value: string | null) {
  if (!value) return "No date"
  return new Date(`${value}T00:00:00`).toLocaleDateString(undefined, { month: "short", day: "numeric" })
}

function formatSlot(value: string) {
  return new Date(value).toLocaleString(undefined, { weekday: "short", hour: "numeric", minute: "2-digit" })
}

export function RunwayBoard({ runway, communityId, bookableHomes, canManage }: Props) {
  const router = useRouter()
  const [focus, setFocus] = useState<Focus>("all")
  const [booking, setBooking] = useState(false)
  const [expanded, setExpanded] = useState<string[]>([])

  const counters: Array<{ key: Focus; label: string; value: number; tone: Tone }> = [
    { key: "overdue", label: "Past cutoff", value: runway.counters.overdue, tone: "late" },
    { key: "due_soon", label: "Cuts off in 14 days", value: runway.counters.dueSoon, tone: "soon" },
    { key: "unbooked", label: "No appointment booked", value: runway.counters.unbooked, tone: "neutral" },
    { key: "ready", label: "Ready to sign", value: runway.counters.readyToSign, tone: "none" },
  ]

  /**
   * Filtering removes chips rather than fading them: a board you cannot read
   * is not made readable by making a quarter of it translucent. Lanes that
   * empty out drop away with them.
   */
  const grid = useMemo(() => {
    const rows = runway.lanes.map((lane) => {
      const cells = new Map<BucketKey, RunwayHome[]>()
      let total = 0
      for (const home of lane.homes) {
        if (!matchesFocus(home, focus)) continue
        const bucket = bucketFor(home)
        const list = cells.get(bucket) ?? []
        list.push(home)
        cells.set(bucket, list)
        total += 1
      }
      for (const list of cells.values()) {
        list.sort((a, b) => (a.daysToCutoff ?? 0) - (b.daysToCutoff ?? 0) || a.lotLabel.localeCompare(b.lotLabel))
      }
      return { lane, cells, total }
    })
    const columnTotals = new Map<BucketKey, number>()
    for (const row of rows) {
      for (const [bucket, list] of row.cells) {
        columnTotals.set(bucket, (columnTotals.get(bucket) ?? 0) + list.length)
      }
    }
    return { rows: rows.filter((row) => row.total > 0), columnTotals }
  }, [runway.lanes, focus])

  const isEmpty = runway.lanes.length === 0
  const filteredOut = focus !== "all" && grid.rows.length === 0

  function toggleCell(key: string) {
    setExpanded((current) => (current.includes(key) ? current.filter((item) => item !== key) : [...current, key]))
  }

  return (
    <StudioShell
      active="runway"
      action={
        canManage ? (
          <Button size="sm" className="h-8 rounded-none" onClick={() => setBooking(true)}>
            <Calendar className="mr-1.5 h-3.5 w-3.5" />
            Book appointment
          </Button>
        ) : null
      }
    >
      <div className="grid grid-cols-2 border-b lg:grid-cols-4 border-border">
        {counters.map((counter) => (
          <button
            key={counter.key}
            type="button"
            className="studio-counter"
            data-tone={counter.tone}
            data-live={counter.value > 0}
            data-active={focus === counter.key}
            onClick={() => setFocus((current) => (current === counter.key ? "all" : counter.key))}
            aria-pressed={focus === counter.key}
          >
            <span className="studio-counter-value tabular-nums text-2xl leading-none font-semibold tracking-tight">
              {counter.value}
            </span>
            <span className="text-[11.5px] text-muted-foreground">{counter.label}</span>
          </button>
        ))}
      </div>

      {isEmpty ? (
        <div className="flex flex-col items-center gap-2 px-6 py-20 text-center">
          <p className="text-sm font-medium">No selection groups are open</p>
          <p className="max-w-md text-[13px] text-muted-foreground">
            Cutoffs appear here once a community has selection groups and a sold home has a schedule to anchor them to.
          </p>
          <Button asChild size="sm" variant="outline" className="mt-2 h-8 rounded-none">
            <Link href="/design-studio/rules">Set up cutoff rules</Link>
          </Button>
        </div>
      ) : filteredOut ? (
        <div className="flex flex-col items-center gap-2 px-6 py-20 text-center">
          <p className="text-sm font-medium">Nothing matches that filter</p>
          <Button size="sm" variant="outline" className="mt-1 h-8 rounded-none" onClick={() => setFocus("all")}>
            Show every group
          </Button>
        </div>
      ) : (
        <>
          <div className="overflow-x-auto">
            <table className="studio-matrix">
              <thead>
                <tr>
                  <th scope="col" className="studio-matrix-corner">
                    <span className="microlabel">Selection group</span>
                  </th>
                  {BUCKETS.map((bucket) => (
                    <th key={bucket.key} scope="col" data-tone={bucket.tone}>
                      <span className="studio-col-label">{bucket.label}</span>
                      <span className="studio-col-count tabular-nums">{grid.columnTotals.get(bucket.key) ?? 0}</span>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {grid.rows.map(({ lane, cells }) => (
                  <tr key={lane.groupId}>
                    <th scope="row" className="studio-matrix-lane">
                      <span className="block text-[12.5px] font-semibold">{lane.name}</span>
                      <span className="font-mono block text-[10.5px] font-normal text-muted-foreground">
                        {lane.cutoffRule}
                      </span>
                    </th>
                    {BUCKETS.map((bucket) => {
                      const homes = cells.get(bucket.key) ?? []
                      const cellKey = `${lane.groupId}:${bucket.key}`
                      const isOpen = expanded.includes(cellKey)
                      const shown = isOpen ? homes : homes.slice(0, CELL_CAP)
                      const hidden = homes.length - shown.length
                      return (
                        <td key={bucket.key} data-tone={bucket.tone}>
                          {shown.map((home) => {
                            const complete = home.categoryCount > 0 && home.chosenCount === home.categoryCount
                            return (
                              <Link
                                key={`${home.projectId}-${lane.groupId}`}
                                href={`/design-studio/sheet/${home.projectId}`}
                                className="studio-chip"
                                data-state={home.state}
                                data-complete={complete}
                                title={`${home.lotLabel} · ${home.buyerName} — ${home.chosenCount} of ${home.categoryCount} chosen · cutoff ${formatDay(home.cutoffDate)}`}
                              >
                                <span className="studio-chip-head">
                                  <span className="font-mono flex-none text-[11.5px] tabular-nums">{home.lotLabel}</span>
                                  <span className="min-w-0 flex-1 truncate text-[11.5px]">{home.buyerName}</span>
                                  {home.blocksStart && (
                                    <AlertTriangle className="h-3 w-3 flex-none text-destructive" aria-label="Holding a start" />
                                  )}
                                </span>
                                <span className="studio-chip-meta tabular-nums">
                                  {home.chosenCount}/{home.categoryCount} chosen · {formatDay(home.cutoffDate)}
                                </span>
                                <span
                                  className="studio-chip-bar"
                                  style={{ "--studio-progress": home.progress } as React.CSSProperties}
                                />
                              </Link>
                            )
                          })}
                          {hidden > 0 && (
                            <button type="button" className="studio-cell-more" onClick={() => toggleCell(cellKey)}>
                              {hidden} more
                            </button>
                          )}
                          {isOpen && homes.length > CELL_CAP && (
                            <button type="button" className="studio-cell-more" onClick={() => toggleCell(cellKey)}>
                              Show fewer
                            </button>
                          )}
                        </td>
                      )
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <p className="studio-legend">
            One card per home per open group, in the column for how long the buyer has left.
            <span className="studio-legend-mark" data-mark="bar" /> categories chosen
            <span className="studio-legend-mark" data-mark="dashed" /> cutoff date not resolved
            <AlertTriangle className="h-3 w-3 text-destructive" /> holding a start
          </p>
        </>
      )}

      <div className="grid border-t lg:grid-cols-[minmax(0,1fr)_320px] border-border">
        <section className="flex flex-col gap-2 px-5 py-4">
          <p className="microlabel">Appointments this week</p>
          {runway.appointments.length === 0 ? (
            <p className="py-6 text-[13px] text-muted-foreground">
              No sessions booked this week.
            </p>
          ) : (
            <ul className="flex flex-col">
              {runway.appointments.map((appointment) => (
                <li
                  key={appointment.id}
                  className="flex items-center gap-4 border-b py-2.5 last:border-b-0 border-border"
                >
                  <span className="font-mono tabular-nums w-24 flex-none text-[11px] text-muted-foreground">
                    {formatSlot(appointment.scheduled_at)}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[13px] font-semibold">
                      {appointment.buyer_name ?? appointment.project_name ?? "Buyer"}
                    </span>
                    <span className="block truncate text-[11.5px] text-muted-foreground">
                      {[appointment.community_name, appointment.location].filter(Boolean).join(" · ") || "Design studio"}
                    </span>
                  </span>
                  <Button asChild size="sm" variant="outline" className="h-7 flex-none rounded-none">
                    <Link href={`/design-studio/sheet/${appointment.project_id}`}>Open sheet</Link>
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section
          className="flex flex-col gap-2 border-t px-5 py-4 lg:border-l lg:border-t-0 border-border bg-muted/40"
        >
          <p className="microlabel">Blocking a start</p>
          {runway.blockedStarts.length === 0 ? (
            <p className="py-6 text-[13px] text-muted-foreground">
              No start package is waiting on selections.
            </p>
          ) : (
            <ul className="flex flex-col">
              {runway.blockedStarts.map((blocked) => (
                <li key={blocked.projectId} className="border-b py-2.5 last:border-b-0 border-border">
                  <Link
                    href={`/design-studio/sheet/${blocked.projectId}`}
                    className="font-mono tabular-nums block text-[11.5px] underline-offset-2 hover:underline"
                  >
                    {blocked.lotLabel} · {blocked.buyerName}
                  </Link>
                  <span className="block text-[11.5px] text-muted-foreground">
                    {blocked.groupNames.length} open{" "}
                    {blocked.groupNames.length === 1 ? "group" : "groups"} ({blocked.groupNames.join(", ")})
                    {blocked.targetWeek ? ` · target ${formatDay(blocked.targetWeek)}` : ""}
                  </span>
                  {blocked.worstDaysOverdue !== null && (
                    <span className="block text-[11.5px] text-destructive">
                      {blocked.worstDaysOverdue} days past cutoff
                    </span>
                  )}
                </li>
              ))}
            </ul>
          )}
          <p className="pt-1 text-[11.5px] text-muted-foreground">
            Selections are the gate this desk owns. Locking the last open group clears the start package.
          </p>
        </section>
      </div>

      {canManage && (
        <BookAppointmentDialog
          open={booking}
          onOpenChange={setBooking}
          homes={bookableHomes}
          communityId={communityId}
          onBooked={() => router.refresh()}
        />
      )}
    </StudioShell>
  )
}
