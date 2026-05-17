import Link from "next/link"
import {
  CheckCircle2,
  Building2,
  CalendarDays,
  DollarSign,
  FileText,
} from "@/components/icons"
import { cn } from "@/lib/utils"
import type { WatchlistProject, WatchlistSignal } from "@/lib/services/dashboard"

interface ControlTowerWatchProps {
  projects: WatchlistProject[]
}

type GroupKey = "critical" | "warning"
type Tone = "destructive" | "warning" | "neutral"

const GROUP_LABELS: Record<GroupKey, string> = {
  critical: "Critical",
  warning: "Needs monitoring",
}

const GROUP_TONE: Record<GroupKey, Tone> = {
  critical: "destructive",
  warning: "warning",
}

const GROUP_ORDER: GroupKey[] = ["critical", "warning"]

const toneText: Record<Tone, string> = {
  destructive: "text-destructive",
  warning: "text-warning",
  neutral: "text-muted-foreground/85",
}

const toneRule: Record<Tone, string> = {
  destructive: "bg-destructive/40",
  warning: "bg-warning/40",
  neutral: "bg-muted-foreground/30",
}

const SIGNAL_ICON: Record<WatchlistSignal["key"], React.ReactNode> = {
  schedule: <CalendarDays className="h-2.5 w-2.5" strokeWidth={2.5} />,
  cost: <DollarSign className="h-2.5 w-2.5" strokeWidth={2.5} />,
  docs: <FileText className="h-2.5 w-2.5" strokeWidth={2.5} />,
}

const SIGNAL_LABEL: Record<WatchlistSignal["key"], string> = {
  schedule: "Sched",
  cost: "Cost",
  docs: "Docs",
}

function groupOf(project: WatchlistProject): GroupKey {
  return project.signals.some((s) => s.status === "critical") ? "critical" : "warning"
}

export function ControlTowerWatch({ projects }: ControlTowerWatchProps) {
  const visible = projects.slice(0, 12)
  const grouped = GROUP_ORDER.map((key) => ({
    key,
    label: GROUP_LABELS[key],
    tone: GROUP_TONE[key],
    items: visible.filter((p) => groupOf(p) === key),
  })).filter((g) => g.items.length > 0)

  const criticalCount = visible.filter((p) => groupOf(p) === "critical").length

  return (
    <section>
      <header className="px-5 sm:px-8 lg:px-12 pt-10 pb-5 flex items-baseline justify-between gap-3">
        <div className="flex items-baseline gap-3">
          <h2 className="text-[10px] font-semibold uppercase tracking-[0.16em] text-foreground/85">
            Watchlist
          </h2>
          {visible.length > 0 && (
            <span className="text-[10px] font-medium tabular-nums text-muted-foreground/65">
              {visible.length} flagged
            </span>
          )}
        </div>
        {criticalCount > 0 && (
          <span className="inline-flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-[0.16em] text-destructive bg-destructive/10 px-2 py-0.5 rounded-sm">
            <span className="h-1 w-1 rounded-full bg-destructive" />
            {criticalCount} critical
          </span>
        )}
      </header>

      <div className="px-5 sm:px-8 lg:px-12 pb-10">
        {visible.length === 0 ? (
          <EmptyState
            icon={<CheckCircle2 className="h-5 w-5 text-success" />}
            tone="success"
            title="All projects steady"
            description="Nothing on the watchlist right now."
          />
        ) : (
          <div className="space-y-7">
            {grouped.map((group) => (
              <div key={group.key}>
                <GroupHeader label={group.label} count={group.items.length} tone={group.tone} />
                <ul className="space-y-0.5">
                  {group.items.map((project) => {
                    const isCritical = group.key === "critical"
                    const activeSignals = project.signals.filter((s) => s.status !== "ok")
                    const worst = pickWorst(activeSignals)
                    return (
                      <li key={project.id}>
                        <Link
                          href={`/projects/${project.id}`}
                          className={cn(
                            "group flex items-center gap-3 py-2 -mx-2 px-2 rounded-md transition-all duration-150",
                            isCritical
                              ? "bg-destructive/[0.03] hover:bg-destructive/[0.07]"
                              : "hover:bg-muted/45"
                          )}
                        >
                          <IconChip tone={isCritical ? "destructive" : "warning"}>
                            <Building2 className="h-3.5 w-3.5" />
                          </IconChip>
                          <div className="flex-1 min-w-0">
                            <p className="text-sm font-medium text-foreground truncate">
                              {project.name}
                            </p>
                            {worst && (
                              <p
                                className={cn(
                                  "text-[11px] truncate",
                                  worst.status === "critical"
                                    ? "text-destructive/85"
                                    : "text-muted-foreground"
                                )}
                              >
                                {worst.detail}
                              </p>
                            )}
                          </div>
                          <SignalBadges signals={activeSignals} />
                        </Link>
                      </li>
                    )
                  })}
                </ul>
              </div>
            ))}
          </div>
        )}
      </div>
    </section>
  )
}

function pickWorst(signals: WatchlistSignal[]): WatchlistSignal | null {
  if (signals.length === 0) return null
  const weight = (s: WatchlistSignal["status"]) =>
    s === "critical" ? 2 : s === "warn" ? 1 : 0
  return [...signals].sort((a, b) => weight(b.status) - weight(a.status))[0]
}

function SignalBadges({ signals }: { signals: WatchlistSignal[] }) {
  if (signals.length === 0) return null
  return (
    <div className="shrink-0 hidden sm:flex items-center gap-1">
      {signals.map((signal) => (
        <span
          key={signal.key}
          className={cn(
            "inline-flex items-center gap-1 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-[0.08em] rounded-sm",
            signal.status === "critical" && "bg-destructive/10 text-destructive",
            signal.status === "warn" && "bg-warning/10 text-warning"
          )}
          title={signal.detail}
        >
          {SIGNAL_ICON[signal.key]}
          {SIGNAL_LABEL[signal.key]}
        </span>
      ))}
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
      <span className="text-[10px] font-medium tabular-nums text-muted-foreground/55 shrink-0">
        {count}
      </span>
    </div>
  )
}

function IconChip({
  children,
  tone,
}: {
  children: React.ReactNode
  tone: "neutral" | "destructive" | "warning" | "success"
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
      <p className="mt-1 text-xs text-muted-foreground">{description}</p>
    </div>
  )
}
