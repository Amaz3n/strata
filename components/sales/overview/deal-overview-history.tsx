import { differenceInCalendarDays, format, isToday, isYesterday, parseISO } from "date-fns"

import { Activity, Home, Mail, MessageSquare, PenLine, Phone } from "@/components/icons"
import {
  BandBody,
  BandHeader,
  GroupHeader,
  IconChip,
  OverviewEmptyState,
  OverviewRow,
} from "@/components/overview/primitives"
import { LogActivityButton } from "@/components/sales/log-activity-dialog"
import { describeActivity, type ActivityKind } from "@/lib/sales/activity"
import type { ProspectActivity } from "@/lib/services/prospects"
import { cn } from "@/lib/utils"

const kindIcon: Record<ActivityKind, typeof Phone> = {
  call: Phone,
  visit: Home,
  text: MessageSquare,
  email: Mail,
  note: PenLine,
}

interface DayGroup {
  key: string
  primary: string
  secondary: string
  isToday: boolean
  isYesterday: boolean
  events: ProspectActivity[]
}

/** Newest day first — this log is read backwards, from the last thing that happened. */
function groupByDay(events: ProspectActivity[]): DayGroup[] {
  const map = new Map<string, ProspectActivity[]>()
  for (const event of events) {
    const key = event.created_at.slice(0, 10)
    if (!map.has(key)) map.set(key, [])
    map.get(key)!.push(event)
  }

  return Array.from(map.entries())
    .sort(([a], [b]) => b.localeCompare(a))
    .map(([key, dayEvents]) => {
      const date = parseISO(`${key}T00:00:00`)
      const today = isToday(date)
      const yesterday = isYesterday(date)
      const daysBack = Math.abs(differenceInCalendarDays(date, new Date()))
      return {
        key,
        primary: today
          ? "Today"
          : yesterday
          ? "Yesterday"
          : daysBack <= 7
          ? format(date, "EEEE")
          : format(date, "MMM d, yyyy"),
        secondary: format(date, "MMM d"),
        isToday: today,
        isYesterday: yesterday,
        events: dayEvents,
      }
    })
}

function formatTime(value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ""
  return date.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })
}

/**
 * "Contact" rather than "activity": the count beside it is every event on the
 * file, and this is the narrower number — the last time a person spoke to them.
 */
function sinceLabel(value: string): string {
  const days = Math.abs(differenceInCalendarDays(new Date(value), new Date()))
  if (days === 0) return "last contact today"
  if (days === 1) return "last contact yesterday"
  return `last contact ${days}d ago`
}

/**
 * The buyer's whole file as a log, grouped by day.
 *
 * Calls the consultant logged sit in the same list as the holds, prices and
 * signatures the system recorded, because "when did we last talk to them" and
 * "when did they sign" are one question asked two ways. Logged touches carry the
 * inverted chip so a scan finds the human contact first; the days count down,
 * because the only date anyone hunts for here is the most recent one.
 */
export function DealOverviewHistory({
  activity,
  truncated,
  prospectId,
  buyerName,
}: {
  activity: ProspectActivity[]
  /** True when the query itself capped the log. */
  truncated: boolean
  /** Null for a deal with no lead record behind it — nothing to log against. */
  prospectId: string | null
  buyerName: string
}) {
  const groups = groupByDay(activity)
  const touches = activity.filter((event) => describeActivity(event).logged)

  return (
    <section className="border-b lg:border-b-0 lg:border-r">
      <BandHeader
        title="History"
        count={
          activity.length > 0
            ? `${activity.length} ${activity.length === 1 ? "event" : "events"}${
                touches[0] ? ` · ${sinceLabel(touches[0].created_at)}` : ""
              }`
            : null
        }
      >
        {touches.length > 0 && (
          <span className="inline-flex items-center gap-1.5 rounded-sm bg-foreground/[0.07] px-2 py-0.5 text-[10px] font-semibold tracking-[0.16em] text-foreground uppercase">
            <MessageSquare className="h-2.5 w-2.5" strokeWidth={2.5} />
            {touches.length}
          </span>
        )}
        {/* The one mutation this pane owns, at the head of the log it writes to. */}
        {prospectId ? <LogActivityButton prospectId={prospectId} buyerName={buyerName} /> : null}
      </BandHeader>

      <BandBody>
        {groups.length === 0 ? (
          <OverviewEmptyState
            icon={<MessageSquare className="h-5 w-5 text-muted-foreground/70" />}
            tone="neutral"
            title="Nothing recorded yet"
            description="Use Log activity, above. Holds, pricing and signatures land here on their own."
          />
        ) : (
          <div className="space-y-7">
            {groups.map((group) => (
              <div key={group.key}>
                <GroupHeader
                  label={group.primary}
                  count={group.events.length}
                  ruleClassName={
                    group.isToday
                      ? "bg-foreground/40"
                      : group.isYesterday
                      ? "bg-foreground/25"
                      : "bg-muted-foreground/30"
                  }
                  labelClassName={
                    group.isToday
                      ? "text-foreground"
                      : group.isYesterday
                      ? "text-foreground/85"
                      : "text-muted-foreground/85"
                  }
                >
                  <span className="text-[10px] tabular-nums text-muted-foreground/55">
                    {group.secondary}
                  </span>
                  {group.isToday && (
                    <span aria-hidden className="h-1 w-1 rounded-full bg-foreground" />
                  )}
                </GroupHeader>
                <ul className="space-y-0.5">
                  {group.events.map((event) => {
                    const { title, note, logged, kind } = describeActivity(event)
                    const Icon = kind ? kindIcon[kind] : logged ? MessageSquare : Activity
                    return (
                      <li key={event.id}>
                        <OverviewRow tone={logged ? "emphasis" : "neutral"}>
                          <IconChip tone={logged ? "inverted" : "neutral"}>
                            <Icon className="h-3.5 w-3.5" strokeWidth={logged ? 2.5 : 2} />
                          </IconChip>
                          <span className="min-w-0 flex-1 truncate text-sm">
                            <span
                              className={cn(
                                logged
                                  ? "font-semibold text-foreground"
                                  : "font-medium text-foreground",
                              )}
                            >
                              {title}
                            </span>
                            {note ? <span className="text-muted-foreground"> — {note}</span> : null}
                          </span>
                          <span className="shrink-0 text-[11px] font-medium tabular-nums text-muted-foreground/70">
                            {formatTime(event.created_at)}
                          </span>
                        </OverviewRow>
                      </li>
                    )
                  })}
                </ul>
              </div>
            ))}

            {truncated ? (
              <p className="text-[11px] text-muted-foreground/70">
                Showing the 60 most recent events on this buyer.
              </p>
            ) : null}
          </div>
        )}
      </BandBody>
    </section>
  )
}
