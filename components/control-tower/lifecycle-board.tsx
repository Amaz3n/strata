"use client"

import { useState } from "react"
import Link from "next/link"
import {
  Compass,
  HardHat,
  Hammer,
  Receipt,
  ShieldCheck,
  ChevronRight,
  ExternalLink,
  Circle,
  AlertCircle,
  AlertTriangle,
} from "lucide-react"
import type { LifecycleStage, LifecycleItem } from "@/lib/services/dashboard"

/* ── stage visual config ── */

const stageConfig: Record<
  string,
  {
    icon: typeof Compass
    accent: string
    accentMuted: string
    headerBg: string
    badgeBg: string
    badgeText: string
    emptyIcon: string
  }
> = {
  precon: {
    icon: Compass,
    accent: "text-violet-600 dark:text-violet-400",
    accentMuted: "text-violet-500/60 dark:text-violet-400/60",
    headerBg: "bg-violet-500/[0.06] dark:bg-violet-400/[0.08]",
    badgeBg: "bg-violet-500/10 dark:bg-violet-400/15",
    badgeText: "text-violet-700 dark:text-violet-300",
    emptyIcon: "text-violet-300 dark:text-violet-700",
  },
  setup: {
    icon: HardHat,
    accent: "text-sky-600 dark:text-sky-400",
    accentMuted: "text-sky-500/60 dark:text-sky-400/60",
    headerBg: "bg-sky-500/[0.06] dark:bg-sky-400/[0.08]",
    badgeBg: "bg-sky-500/10 dark:bg-sky-400/15",
    badgeText: "text-sky-700 dark:text-sky-300",
    emptyIcon: "text-sky-300 dark:text-sky-700",
  },
  execution: {
    icon: Hammer,
    accent: "text-amber-600 dark:text-amber-400",
    accentMuted: "text-amber-500/60 dark:text-amber-400/60",
    headerBg: "bg-amber-500/[0.06] dark:bg-amber-400/[0.08]",
    badgeBg: "bg-amber-500/10 dark:bg-amber-400/15",
    badgeText: "text-amber-700 dark:text-amber-300",
    emptyIcon: "text-amber-300 dark:text-amber-700",
  },
  commercials: {
    icon: Receipt,
    accent: "text-emerald-600 dark:text-emerald-400",
    accentMuted: "text-emerald-500/60 dark:text-emerald-400/60",
    headerBg: "bg-emerald-500/[0.06] dark:bg-emerald-400/[0.08]",
    badgeBg: "bg-emerald-500/10 dark:bg-emerald-400/15",
    badgeText: "text-emerald-700 dark:text-emerald-300",
    emptyIcon: "text-emerald-300 dark:text-emerald-700",
  },
  closeout: {
    icon: ShieldCheck,
    accent: "text-rose-600 dark:text-rose-400",
    accentMuted: "text-rose-500/60 dark:text-rose-400/60",
    headerBg: "bg-rose-500/[0.06] dark:bg-rose-400/[0.08]",
    badgeBg: "bg-rose-500/10 dark:bg-rose-400/15",
    badgeText: "text-rose-700 dark:text-rose-300",
    emptyIcon: "text-rose-300 dark:text-rose-700",
  },
}

/* ── severity indicator ── */

const severityIcon: Record<string, { icon: typeof Circle; className: string }> = {
  info: { icon: Circle, className: "text-blue-400 dark:text-blue-500 fill-blue-400 dark:fill-blue-500" },
  warn: { icon: AlertTriangle, className: "text-amber-500 dark:text-amber-400" },
  critical: { icon: AlertCircle, className: "text-red-500 dark:text-red-400" },
}

/* ── item card ── */

function ItemCard({ item, stageKey }: { item: LifecycleItem; stageKey: string }) {
  const sev = severityIcon[item.severity]
  const SevIcon = sev.icon
  const config = stageConfig[stageKey]

  const inner = (
    <div
      className={`
        group/card relative
        bg-card
        border border-border/60
        px-3.5 py-3
        transition-all duration-200 ease-out
        hover:border-border
        hover:shadow-[0_2px_8px_-2px_rgba(0,0,0,0.08)]
        dark:hover:shadow-[0_2px_8px_-2px_rgba(0,0,0,0.3)]
        cursor-default
      `}
    >
      {/* severity bar */}
      <div
        className={`
          absolute left-0 top-2.5 bottom-2.5 w-[2px] rounded-full
          ${item.severity === "critical" ? "bg-red-500 dark:bg-red-400" : item.severity === "warn" ? "bg-amber-400 dark:bg-amber-500" : "bg-blue-300 dark:bg-blue-600"}
        `}
      />

      <div className="flex items-start gap-2.5 pl-1.5">
        <SevIcon className={`h-3.5 w-3.5 mt-0.5 shrink-0 ${sev.className}`} />
        <div className="min-w-0 flex-1">
          <p className="text-[13px] font-medium text-foreground leading-snug truncate">
            {item.label}
          </p>
          <p className="text-[11px] text-muted-foreground mt-0.5 leading-tight">
            {item.detail}
          </p>
          {item.projectName && (
            <p className={`text-[10px] mt-1.5 font-medium ${config?.accentMuted ?? "text-muted-foreground"} uppercase tracking-wider`}>
              {item.projectName}
            </p>
          )}
        </div>
        {item.href && (
          <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground/40 mt-0.5 opacity-0 group-hover/card:opacity-100 transition-opacity" />
        )}
      </div>
    </div>
  )

  if (item.href) {
    return (
      <Link href={item.href} className="block focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
        {inner}
      </Link>
    )
  }

  return inner
}

/* ── stage column ── */

const COLLAPSED_COUNT = 4

function StageColumn({ stage }: { stage: LifecycleStage }) {
  const [expanded, setExpanded] = useState(false)
  const config = stageConfig[stage.key] ?? stageConfig.execution
  const Icon = config.icon

  const criticalCount = stage.items.filter((i) => i.severity === "critical").length
  const warnCount = stage.items.filter((i) => i.severity === "warn").length
  const hasOverflow = stage.items.length > COLLAPSED_COUNT
  const visibleItems = expanded ? stage.items : stage.items.slice(0, COLLAPSED_COUNT)

  // Sort: critical first, then warn, then info
  const sortedItems = [...visibleItems].sort((a, b) => {
    const order = { critical: 0, warn: 1, info: 2 }
    return (order[a.severity] ?? 2) - (order[b.severity] ?? 2)
  })

  return (
    <div className="flex flex-col min-w-0">
      {/* Column header */}
      <div className={`${config.headerBg} px-4 py-3 border-b border-border/50`}>
        <div className="flex items-center gap-2.5">
          <Icon className={`h-4 w-4 ${config.accent}`} strokeWidth={1.75} />
          <span className="text-[13px] font-semibold text-foreground tracking-tight">
            {stage.label}
          </span>
          <span className={`ml-auto text-[11px] font-semibold tabular-nums px-2 py-0.5 ${config.badgeBg} ${config.badgeText}`}>
            {stage.items.length}
          </span>
        </div>
        {/* Severity breakdown */}
        {stage.items.length > 0 && (criticalCount > 0 || warnCount > 0) && (
          <div className="flex items-center gap-3 mt-1.5">
            {criticalCount > 0 && (
              <span className="flex items-center gap-1 text-[10px] text-red-600 dark:text-red-400 font-medium">
                <AlertCircle className="h-2.5 w-2.5" />
                {criticalCount} critical
              </span>
            )}
            {warnCount > 0 && (
              <span className="flex items-center gap-1 text-[10px] text-amber-600 dark:text-amber-400 font-medium">
                <AlertTriangle className="h-2.5 w-2.5" />
                {warnCount} needs attention
              </span>
            )}
          </div>
        )}
      </div>

      {/* Items */}
      <div className="flex flex-col gap-px bg-muted/30 flex-1">
        {sortedItems.length === 0 && (
          <div className="flex flex-col items-center justify-center py-10 px-4">
            <Icon className={`h-8 w-8 ${config.emptyIcon} mb-2`} strokeWidth={1} />
            <p className="text-[12px] text-muted-foreground/60 font-medium">All clear</p>
          </div>
        )}
        {sortedItems.map((item) => (
          <ItemCard key={item.id} item={item} stageKey={stage.key} />
        ))}
        {hasOverflow && !expanded && (
          <button
            onClick={() => setExpanded(true)}
            className="flex items-center justify-center gap-1.5 py-2.5 text-[11px] font-medium text-muted-foreground hover:text-foreground bg-card border border-border/60 transition-colors"
          >
            <ExternalLink className="h-3 w-3" />
            {stage.items.length - COLLAPSED_COUNT} more items
          </button>
        )}
        {hasOverflow && expanded && (
          <button
            onClick={() => setExpanded(false)}
            className="flex items-center justify-center gap-1.5 py-2.5 text-[11px] font-medium text-muted-foreground hover:text-foreground bg-card border border-border/60 transition-colors"
          >
            Show less
          </button>
        )}
      </div>
    </div>
  )
}

/* ── board ── */

export function LifecycleBoard({ stages }: { stages: LifecycleStage[] }) {
  const totalItems = stages.reduce((acc, s) => acc + s.items.length, 0)

  return (
    <div>
      {/* Board header */}
      <div className="flex items-center justify-between mb-3">
        <div>
          <h2 className="text-[15px] font-semibold text-foreground tracking-tight">
            Lifecycle Board
          </h2>
          <p className="text-[12px] text-muted-foreground mt-0.5">
            {totalItems === 0
              ? "Nothing needs attention across your portfolio"
              : `${totalItems} item${totalItems !== 1 ? "s" : ""} across ${stages.filter((s) => s.items.length > 0).length} stages need attention`}
          </p>
        </div>

        {/* Stage flow indicator */}
        <div className="hidden xl:flex items-center gap-1">
          {stages.map((stage, i) => {
            const config = stageConfig[stage.key]
            const hasItems = stage.items.length > 0
            return (
              <div key={stage.key} className="flex items-center gap-1">
                <div
                  className={`
                    h-1.5 w-6 rounded-full transition-all
                    ${hasItems
                      ? stage.items.some((it) => it.severity === "critical")
                        ? "bg-red-400 dark:bg-red-500"
                        : stage.items.some((it) => it.severity === "warn")
                          ? "bg-amber-400 dark:bg-amber-500"
                          : "bg-blue-300 dark:bg-blue-500"
                      : "bg-muted-foreground/15"
                    }
                  `}
                  title={`${stage.label}: ${stage.items.length} items`}
                />
                {i < stages.length - 1 && (
                  <ChevronRight className="h-2.5 w-2.5 text-muted-foreground/30" />
                )}
              </div>
            )
          })}
        </div>
      </div>

      {/* Columns */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5 gap-px bg-border ring-1 ring-border overflow-hidden">
        {stages.map((stage) => (
          <StageColumn key={stage.key} stage={stage} />
        ))}
      </div>
    </div>
  )
}
