"use client"

import Link from "next/link"
import {
  CalendarClock,
  DollarSign,
  FileCheck,
  ChevronRight,
  Eye,
} from "lucide-react"
import type { WatchlistProject, WatchlistSignal } from "@/lib/services/dashboard"

const signalConfig: Record<
  WatchlistSignal["key"],
  { icon: typeof CalendarClock; label: string }
> = {
  schedule: { icon: CalendarClock, label: "Schedule" },
  cost: { icon: DollarSign, label: "Cost" },
  docs: { icon: FileCheck, label: "Docs" },
}

const statusStyles = {
  ok: {
    dot: "bg-emerald-500 dark:bg-emerald-400",
    text: "text-emerald-700 dark:text-emerald-300",
    bg: "",
  },
  warn: {
    dot: "bg-amber-500 dark:bg-amber-400",
    text: "text-amber-700 dark:text-amber-300",
    bg: "",
  },
  critical: {
    dot: "bg-red-500 dark:bg-red-400",
    text: "text-red-700 dark:text-red-300",
    bg: "",
  },
}

function SignalPill({ signal }: { signal: WatchlistSignal }) {
  const config = signalConfig[signal.key]
  const styles = statusStyles[signal.status]
  const Icon = config.icon

  return (
    <div className="flex items-center gap-2 min-w-0 flex-1">
      <div className="flex items-center gap-1.5 shrink-0">
        <div className={`h-1.5 w-1.5 rounded-full ${styles.dot} ${signal.status === "critical" ? "health-pulse" : ""}`} />
        <Icon className="h-3 w-3 text-muted-foreground/60" strokeWidth={1.75} />
      </div>
      <div className="min-w-0">
        <p className={`text-[10px] font-semibold uppercase tracking-wider ${styles.text} leading-none`}>
          {config.label}
        </p>
        <p className="text-[11px] text-muted-foreground leading-tight mt-0.5 truncate">
          {signal.detail}
        </p>
      </div>
    </div>
  )
}

function ProjectRow({ project, rank }: { project: WatchlistProject; rank: number }) {
  const worstSignal = project.signals.reduce((worst, s) => {
    const order = { critical: 0, warn: 1, ok: 2 }
    return order[s.status] < order[worst.status] ? s : worst
  }, project.signals[0])

  const borderColor =
    worstSignal.status === "critical"
      ? "border-l-red-500 dark:border-l-red-400"
      : worstSignal.status === "warn"
        ? "border-l-amber-400 dark:border-l-amber-500"
        : "border-l-emerald-500 dark:border-l-emerald-400"

  return (
    <Link
      href={`/projects/${project.id}`}
      className={`
        group flex items-stretch border-b border-border/50 last:border-b-0
        border-l-2 ${borderColor}
        transition-colors hover:bg-muted/40
      `}
    >
      {/* Rank + name */}
      <div className="flex items-center gap-3 px-4 py-3 w-[200px] shrink-0 border-r border-border/30">
        <span className="text-[11px] font-bold text-muted-foreground/40 tabular-nums w-4 text-right">
          {rank}
        </span>
        <div className="min-w-0">
          <p className="text-[13px] font-medium text-foreground truncate leading-snug">
            {project.name}
          </p>
          <p className="text-[10px] text-muted-foreground/60 mt-0.5">
            Risk score: {project.riskScore}
          </p>
        </div>
      </div>

      {/* 3 signal columns */}
      <div className="flex-1 grid grid-cols-3 divide-x divide-border/30">
        {project.signals.map((signal) => (
          <div key={signal.key} className="flex items-center px-3.5 py-2.5">
            <SignalPill signal={signal} />
          </div>
        ))}
      </div>

      {/* Arrow */}
      <div className="flex items-center px-3 shrink-0">
        <ChevronRight className="h-3.5 w-3.5 text-muted-foreground/30 group-hover:text-muted-foreground transition-colors" />
      </div>
    </Link>
  )
}

export function Watchlist({ projects }: { projects: WatchlistProject[] }) {
  return (
    <div>
      {/* Header */}
      <div className="flex items-center justify-between mb-3">
        <div>
          <h2 className="text-[15px] font-semibold text-foreground tracking-tight">
            Watchlist
          </h2>
          <p className="text-[12px] text-muted-foreground mt-0.5">
            {projects.length === 0
              ? "All projects healthy — nothing to watch"
              : `${projects.length} project${projects.length !== 1 ? "s" : ""} with elevated risk`}
          </p>
        </div>
      </div>

      {/* Table */}
      <div className="ring-1 ring-border overflow-hidden bg-card">
        {/* Column headers */}
        <div className="flex items-center border-b border-border bg-muted/30 text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">
          <div className="w-[200px] shrink-0 px-4 py-2 border-r border-border/30">
            Project
          </div>
          <div className="flex-1 grid grid-cols-3 divide-x divide-border/30">
            {(["schedule", "cost", "docs"] as const).map((key) => {
              const config = signalConfig[key]
              const Icon = config.icon
              return (
                <div key={key} className="flex items-center gap-1.5 px-3.5 py-2">
                  <Icon className="h-3 w-3" strokeWidth={1.75} />
                  {config.label}
                </div>
              )
            })}
          </div>
          <div className="w-[44px] shrink-0" />
        </div>

        {projects.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-10">
            <Eye className="h-8 w-8 text-muted-foreground/15 mb-2" strokeWidth={1} />
            <p className="text-[12px] text-muted-foreground/50 font-medium">
              Nothing on watch
            </p>
          </div>
        ) : (
          projects.map((project, i) => (
            <ProjectRow key={project.id} project={project} rank={i + 1} />
          ))
        )}
      </div>
    </div>
  )
}
