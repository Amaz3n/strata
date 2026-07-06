import Link from "next/link"
import {
  AlertTriangle,
  CalendarDays,
  CheckCircle2,
  CheckSquare,
  Clock,
  Flag,
  Hammer,
  Truck,
} from "@/components/icons"
import { cn } from "@/lib/utils"
import type {
  ControlTowerData,
  OperationsLookaheadItem,
} from "@/lib/services/dashboard"

interface ControlTowerLookaheadProps {
  lookahead: ControlTowerData["operationsLookahead"]
}

type Tone = "destructive" | "warning" | "neutral" | "success"

const toneText: Record<Tone, string> = {
  destructive: "text-destructive",
  warning: "text-warning",
  neutral: "text-muted-foreground/85",
  success: "text-success",
}

const toneRule: Record<Tone, string> = {
  destructive: "bg-destructive/40",
  warning: "bg-warning/40",
  neutral: "bg-muted-foreground/30",
  success: "bg-success/40",
}

const itemIcon: Record<string, React.ReactNode> = {
  inspection: <CheckSquare className="h-3.5 w-3.5" />,
  milestone: <Flag className="h-3.5 w-3.5" />,
  delivery: <Truck className="h-3.5 w-3.5" />,
  task: <Hammer className="h-3.5 w-3.5" />,
}

function kindLabel(item: OperationsLookaheadItem): string {
  if (item.kind === "task_due") return "Task due"
  if (item.kind === "schedule_finish") return "Finishes"
  return "Starts"
}

function itemTone(item: OperationsLookaheadItem): Tone {
  if (item.isCriticalPath || item.status === "blocked") return "destructive"
  if (item.status === "at_risk") return "warning"
  return "neutral"
}

export function ControlTowerLookahead({ lookahead }: ControlTowerLookaheadProps) {
  const hasWork =
    lookahead.totalItems > 0 ||
    lookahead.conflictCount > 0 ||
    lookahead.overdueCount > 0

  return (
    <section className="border-b lg:border-b-0 lg:border-r">
      <header className="px-5 sm:px-8 lg:px-12 pt-10 pb-5 flex items-baseline justify-between gap-3">
        <div className="flex items-baseline gap-3">
          <h2 className="text-[10px] font-semibold uppercase tracking-[0.16em] text-foreground/85">
            Operations lookahead
          </h2>
          {hasWork && (
            <span className="text-[10px] font-medium tabular-nums text-muted-foreground/65">
              {lookahead.totalItems} this week
            </span>
          )}
        </div>
        {lookahead.conflictCount > 0 && (
          <span className="inline-flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-[0.16em] text-warning bg-warning/10 px-2 py-0.5 rounded-sm">
            <span className="h-1 w-1 rounded-full bg-warning" />
            {lookahead.conflictCount} collision{lookahead.conflictCount === 1 ? "" : "s"}
          </span>
        )}
      </header>

      <div className="px-5 sm:px-8 lg:px-12 pb-10">
        {!hasWork ? (
          <EmptyState
            icon={<CheckCircle2 className="h-5 w-5 text-success" />}
            tone="success"
            title="No field pressure this week"
            description="No starts, finishes, due tasks, or schedule collisions in the next seven days."
          />
        ) : (
          <div className="max-h-[min(680px,calc(100vh-22rem))] min-h-0 overflow-y-auto pr-2 -mr-2">
            <div className="space-y-6">
            {lookahead.overdueCount > 0 && (
              <div className="flex items-center gap-3 rounded-md bg-destructive/[0.04] px-3 py-2 text-sm">
                <IconChip tone="destructive">
                  <Clock className="h-3.5 w-3.5" />
                </IconChip>
                <div className="min-w-0 flex-1">
                  <p className="font-medium text-foreground">
                    {lookahead.overdueCount} overdue item{lookahead.overdueCount === 1 ? "" : "s"}
                  </p>
                  <p className="text-[11px] text-muted-foreground">
                    Late schedule work or tasks may affect this week's plan.
                  </p>
                </div>
              </div>
            )}

            <div className="space-y-5">
              {lookahead.days.map((day) => (
                <DayGroup key={day.key} day={day} />
              ))}
            </div>
            </div>
          </div>
        )}
      </div>
    </section>
  )
}

function DayGroup({ day }: { day: ControlTowerData["operationsLookahead"]["days"][number] }) {
  const visibleItems = day.items.slice(0, 4)
  const hiddenCount = Math.max(0, day.items.length - visibleItems.length)
  const hasContent = day.items.length > 0 || day.conflicts.length > 0

  return (
    <div>
      <GroupHeader
        label={day.label}
        count={day.items.length + day.conflicts.length}
        tone={day.conflicts.some((conflict) => conflict.tone === "destructive") ? "destructive" : day.conflicts.length > 0 ? "warning" : day.isToday ? "success" : "neutral"}
      />
      {!hasContent ? (
        <p className="pl-6 text-xs text-muted-foreground/70">No scheduled activity.</p>
      ) : (
        <ul className="space-y-0.5">
          {day.conflicts.map((conflict) => (
            <li key={conflict.id}>
              <div
                className={cn(
                  "flex items-center gap-3 py-2 -mx-2 px-2 rounded-md",
                  conflict.tone === "destructive"
                    ? "bg-destructive/[0.03]"
                    : "bg-warning/[0.04]"
                )}
              >
                <IconChip tone={conflict.tone}>
                  <AlertTriangle className="h-3.5 w-3.5" />
                </IconChip>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-foreground truncate">
                    {conflict.title}
                  </p>
                  <p className="text-[11px] text-muted-foreground truncate">
                    {conflict.detail}
                  </p>
                </div>
              </div>
            </li>
          ))}
          {visibleItems.map((item) => (
            <li key={item.id}>
              <Link
                href={item.href}
                className={cn(
                  "group flex items-center gap-3 py-2 -mx-2 px-2 rounded-md transition-all duration-150 hover:bg-muted/45",
                  itemTone(item) === "destructive" && "bg-destructive/[0.025] hover:bg-destructive/[0.06]",
                  itemTone(item) === "warning" && "bg-warning/[0.025] hover:bg-warning/[0.06]"
                )}
              >
                <IconChip tone={itemTone(item)}>
                  {itemIcon[item.itemType ?? ""] ?? <CalendarDays className="h-3.5 w-3.5" />}
                </IconChip>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-foreground truncate">
                    {item.title}
                  </p>
                  <p className="text-[11px] text-muted-foreground truncate">
                    {kindLabel(item)}
                    {item.trade ? ` · ${item.trade.replace(/_/g, " ")}` : ""}
                    {item.projectName ? ` · ${item.projectName}` : ""}
                  </p>
                </div>
                {item.isCriticalPath && (
                  <span className="hidden sm:inline-flex text-[10px] font-semibold uppercase tracking-[0.12em] text-destructive">
                    Critical
                  </span>
                )}
              </Link>
            </li>
          ))}
          {hiddenCount > 0 && (
            <li className="pl-9 pt-1 text-[11px] font-medium text-muted-foreground">
              +{hiddenCount} more item{hiddenCount === 1 ? "" : "s"}
            </li>
          )}
        </ul>
      )}
    </div>
  )
}

function GroupHeader({ label, count, tone }: { label: string; count: number; tone: Tone }) {
  return (
    <div className="flex items-center justify-between gap-3 mb-3">
      <div className="flex items-center gap-2.5 min-w-0">
        <span className={cn("h-px w-4 shrink-0", toneRule[tone])} />
        <span className={cn("text-[10px] font-semibold uppercase tracking-[0.16em] truncate", toneText[tone])}>
          {label}
        </span>
      </div>
      {count > 0 && (
        <span className="text-[10px] font-medium tabular-nums text-muted-foreground/55 shrink-0">
          {count}
        </span>
      )}
    </div>
  )
}

function IconChip({
  children,
  tone,
}: {
  children: React.ReactNode
  tone: Tone
}) {
  return (
    <span
      className={cn(
        "shrink-0 inline-flex items-center justify-center h-7 w-7 rounded-md transition-colors",
        tone === "neutral" &&
          "bg-muted/60 text-muted-foreground ring-1 ring-foreground/[0.04] ring-inset",
        tone === "destructive" && "bg-destructive/10 text-destructive",
        tone === "warning" && "bg-warning/12 text-warning",
        tone === "success" && "bg-success/12 text-success"
      )}
    >
      {children}
    </span>
  )
}

function EmptyState({
  icon,
  tone,
  title,
  description,
}: {
  icon: React.ReactNode
  tone: "success" | "neutral"
  title: string
  description: string
}) {
  return (
    <div className="flex flex-col items-center justify-center py-12 text-center">
      <div
        className={cn(
          "mb-3 inline-flex h-10 w-10 items-center justify-center rounded-full",
          tone === "success" && "bg-success/10",
          tone === "neutral" && "bg-muted/60"
        )}
      >
        {icon}
      </div>
      <p className="text-sm font-medium text-foreground">{title}</p>
      <p className="mt-1 max-w-sm text-xs text-muted-foreground">{description}</p>
    </div>
  )
}
