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

interface Props {
  runway: StudioRunway
  communityId?: string
  communities: Array<{ id: string; name: string }>
  bookableHomes: Array<{ projectId: string; label: string; communityId: string | null }>
  canManage: boolean
}

const DAY_MS = 86_400_000

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
  if (!value) return "Unresolved"
  return new Date(`${value}T00:00:00`).toLocaleDateString(undefined, { month: "short", day: "numeric" })
}

function formatSlot(value: string) {
  return new Date(value).toLocaleString(undefined, { weekday: "short", hour: "numeric", minute: "2-digit" })
}

export function RunwayBoard({ runway, communityId, communities, bookableHomes, canManage }: Props) {
  const router = useRouter()
  const [focus, setFocus] = useState<Focus>("all")
  const [booking, setBooking] = useState(false)

  // The axis runs from the earliest overdue cutoff to the horizon, so a badly
  // missed date stays on the board instead of being clipped off the left edge.
  const axis = useMemo(() => {
    const today = Date.now()
    const dated = runway.lanes.flatMap((lane) =>
      lane.homes.map((home) => (home.cutoffDate ? Date.parse(`${home.cutoffDate}T00:00:00`) : null)),
    )
    const known = dated.filter((value): value is number => value !== null)
    const earliest = known.length ? Math.min(...known, today) : today
    const overdueDays = Math.max(0, Math.ceil((today - earliest) / DAY_MS))
    const leadIn = Math.min(overdueDays + 5, 90)
    const start = today - leadIn * DAY_MS
    const span = (leadIn + runway.horizonDays) * DAY_MS
    const ticks = Array.from({ length: 5 }, (_, index) => {
      const at = start + (span * index) / 4
      return {
        percent: (index / 4) * 100,
        label: new Date(at).toLocaleDateString(undefined, { month: "short", day: "numeric" }),
      }
    })
    return { start, span, todayPercent: ((today - start) / span) * 100, ticks }
  }, [runway])

  /**
   * Chips at nearby dates would sit on top of each other, so each lane packs
   * them into as few rows as fit: sorted by date, a chip drops to the next row
   * when it would overlap the last one placed in the row above.
   */
  const packedLanes = useMemo(() => {
    const MIN_GAP_PERCENT = 15
    return runway.lanes.map((lane) => {
      const rowEnds: number[] = []
      const placed = lane.homes
        .map((home) => {
          // An unresolved cutoff has no honest position, so it parks at the far
          // left with a dashed border rather than pretending to be due today.
          const at = home.cutoffDate ? Date.parse(`${home.cutoffDate}T00:00:00`) : axis.start
          const percent = Math.min(94, Math.max(0.5, ((at - axis.start) / axis.span) * 100))
          return { home, percent }
        })
        .sort((a, b) => a.percent - b.percent)
        .map(({ home, percent }) => {
          let row = rowEnds.findIndex((end) => percent >= end)
          if (row === -1) row = rowEnds.length
          rowEnds[row] = percent + MIN_GAP_PERCENT
          return { home, percent, row }
        })
      return { lane, placed, rows: Math.max(1, rowEnds.length) }
    })
  }, [runway.lanes, axis])

  const counters: Array<{ key: Focus; label: string; value: number }> = [
    { key: "overdue", label: "Past cutoff", value: runway.counters.overdue },
    { key: "due_soon", label: "Cuts off in 14 days", value: runway.counters.dueSoon },
    { key: "unbooked", label: "No appointment booked", value: runway.counters.unbooked },
    { key: "ready", label: "Ready to sign", value: runway.counters.readyToSign },
  ]

  const isEmpty = runway.lanes.length === 0

  return (
    <StudioShell
      active="runway"
      communityId={communityId}
      communities={communities}
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
            data-active={focus === counter.key}
            onClick={() => setFocus((current) => (current === counter.key ? "all" : counter.key))}
            aria-pressed={focus === counter.key}
          >
            <span className="font-mono tabular-nums text-2xl leading-none tracking-tight">{counter.value}</span>
            <span className={`text-[11.5px] ${focus === counter.key ? "" : "text-muted-foreground"}`}>
              {counter.label}
            </span>
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
      ) : (
        <>
          <div className="grid" style={{ gridTemplateColumns: "168px minmax(0,1fr)" }}>
            <div />
            <div className="relative h-7 border-b border-border">
              {axis.ticks
                // Drop any tick the "today" marker would sit on top of.
                .filter((tick) => Math.abs(tick.percent - axis.todayPercent) > 7)
                .map((tick) => (
                  <span
                    key={tick.percent}
                    className="microlabel absolute bottom-1.5 whitespace-nowrap"
                    style={{
                      left: `${tick.percent}%`,
                      transform: tick.percent === 0 ? "none" : tick.percent === 100 ? "translateX(-100%)" : "translateX(-50%)",
                    }}
                  >
                    {tick.label}
                  </span>
                ))}
              <span
                className="microlabel absolute bottom-1.5 whitespace-nowrap text-primary"
                style={{ left: `${axis.todayPercent}%`, transform: "translateX(-50%)" }}
              >
                today
              </span>
            </div>
          </div>

          {packedLanes.map(({ lane, placed, rows }) => (
            <div
              key={lane.groupId}
              className="grid border-b border-border"
              style={{ gridTemplateColumns: "168px minmax(0,1fr)" }}
            >
              <div
                className="flex flex-col justify-center gap-0.5 border-r px-3 py-3 border-border bg-muted/40"
              >
                <span className="text-[12.5px] font-semibold">{lane.name}</span>
                <span className="font-mono tabular-nums text-[10px] text-muted-foreground">
                  {lane.cutoffRule}
                </span>
              </div>
              <div className="studio-track" style={{ height: `${rows * 38 + 16}px` }}>
                <div className="studio-gutter" style={{ width: `${axis.todayPercent}%` }} />
                <div className="studio-today" style={{ left: `${axis.todayPercent}%` }} />
                {placed.map(({ home, percent, row }) => (
                  <Link
                    key={`${home.projectId}-${lane.groupId}`}
                    href={`/design-studio/sheet/${home.projectId}`}
                    className="studio-chip"
                    data-state={home.state}
                    data-dimmed={focus !== "all" && !matchesFocus(home, focus)}
                    style={{ left: `${percent}%`, top: `${row * 38 + 8}px` }}
                    title={`${home.lotLabel} · ${home.buyerName} — ${home.chosenCount} of ${home.categoryCount} chosen · cutoff ${formatDay(home.cutoffDate)}`}
                  >
                    <span className="studio-ring" style={{ "--studio-progress": home.progress } as React.CSSProperties} />
                    <span className="font-mono tabular-nums text-[11px]">{home.lotLabel}</span>
                    <span className="text-[11px]">{home.buyerName}</span>
                    {home.blocksStart && <AlertTriangle className="h-3 w-3" />}
                  </Link>
                ))}
              </div>
            </div>
          ))}
        </>
      )}

      <div className="grid border-t lg:grid-cols-[minmax(0,1fr)_320px] border-border">
        <section className="flex flex-col gap-2 px-5 py-4">
          <p className="microlabel">This week</p>
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
          <p className="microlabel">Holding a start</p>
          {runway.blockedStarts.length === 0 ? (
            <p className="py-6 text-[13px] text-muted-foreground">
              No start package is waiting on selections.
            </p>
          ) : (
            <ul className="flex flex-col">
              {runway.blockedStarts.map((blocked) => (
                <li
                  key={blocked.projectId}
                  className="flex gap-2.5 border-b py-2.5 last:border-b-0 border-border"
                >
                  <span className="w-[3px] flex-none bg-destructive" />
                  <span className="min-w-0">
                    <Link
                      href={`/design-studio/sheet/${blocked.projectId}`}
                      className="font-mono tabular-nums block text-[11.5px] underline-offset-2 hover:underline"
                    >
                      {blocked.lotLabel} · {blocked.buyerName}
                    </Link>
                    <span className="block text-[11.5px] text-muted-foreground">
                      {blocked.groupNames.length} open{" "}
                      {blocked.groupNames.length === 1 ? "group" : "groups"} ({blocked.groupNames.join(", ")})
                      {blocked.worstDaysOverdue !== null ? ` · ${blocked.worstDaysOverdue} days past cutoff` : ""}
                      {blocked.targetWeek ? ` · target ${formatDay(blocked.targetWeek)}` : ""}
                    </span>
                  </span>
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
