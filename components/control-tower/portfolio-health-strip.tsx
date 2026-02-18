"use client"

import {
  FolderKanban,
  AlertTriangle,
  Banknote,
  ShieldAlert,
  CalendarClock,
} from "lucide-react"
import type { PortfolioHealth } from "@/lib/services/dashboard"

function formatCompact(cents: number): string {
  const dollars = cents / 100
  if (dollars >= 1_000_000) return `$${(dollars / 1_000_000).toFixed(1)}M`
  if (dollars >= 1_000) return `$${(dollars / 1_000).toFixed(0)}K`
  return `$${dollars.toFixed(0)}`
}

type Severity = "green" | "amber" | "red"

interface KPI {
  label: string
  value: string | number
  sub: string
  icon: typeof FolderKanban
  severity: Severity
}

const severityConfig = {
  green: {
    bg: "from-emerald-500/10 to-emerald-500/5 dark:from-emerald-400/15 dark:to-emerald-400/5",
    iconBg: "bg-emerald-500/15 dark:bg-emerald-400/20",
    iconColor: "text-emerald-600 dark:text-emerald-400",
    valueColor: "text-emerald-700 dark:text-emerald-300",
    ring: "ring-emerald-500/20 dark:ring-emerald-400/20",
    dot: "bg-emerald-500 dark:bg-emerald-400",
    glow: "shadow-emerald-500/10 dark:shadow-emerald-400/10",
  },
  amber: {
    bg: "from-amber-500/10 to-amber-500/5 dark:from-amber-400/15 dark:to-amber-400/5",
    iconBg: "bg-amber-500/15 dark:bg-amber-400/20",
    iconColor: "text-amber-600 dark:text-amber-400",
    valueColor: "text-amber-700 dark:text-amber-300",
    ring: "ring-amber-500/20 dark:ring-amber-400/20",
    dot: "bg-amber-500 dark:bg-amber-400",
    glow: "shadow-amber-500/10 dark:shadow-amber-400/10",
  },
  red: {
    bg: "from-red-500/10 to-red-500/5 dark:from-red-400/15 dark:to-red-400/5",
    iconBg: "bg-red-500/15 dark:bg-red-400/20",
    iconColor: "text-red-600 dark:text-red-400",
    valueColor: "text-red-700 dark:text-red-300",
    ring: "ring-red-500/20 dark:ring-red-400/20",
    dot: "bg-red-500 dark:bg-red-400",
    glow: "shadow-red-500/10 dark:shadow-red-400/10",
  },
}

function getSeverity(value: number, thresholds: [number, number]): Severity {
  if (value <= thresholds[0]) return "green"
  if (value <= thresholds[1]) return "amber"
  return "red"
}

function KPICell({ kpi, index }: { kpi: KPI; index: number }) {
  const config = severityConfig[kpi.severity]
  const Icon = kpi.icon

  return (
    <div
      className="group relative flex-1 min-w-0"
      style={{ animationDelay: `${index * 80}ms` }}
    >
      {/* Card */}
      <div
        className={`
          relative overflow-hidden
          bg-gradient-to-br ${config.bg}
          ring-1 ${config.ring}
          px-5 py-4
          transition-all duration-300 ease-out
          hover:scale-[1.02] hover:shadow-lg ${config.glow}
          cursor-default
        `}
      >
        {/* Subtle background pattern */}
        <div className="absolute inset-0 opacity-[0.03] dark:opacity-[0.05]"
          style={{
            backgroundImage: `radial-gradient(circle at 1px 1px, currentColor 0.5px, transparent 0)`,
            backgroundSize: '16px 16px',
          }}
        />

        {/* Top row: icon + severity dot */}
        <div className="relative flex items-center justify-between mb-3">
          <div className={`flex h-8 w-8 items-center justify-center ${config.iconBg} transition-transform duration-300 group-hover:scale-110`}>
            <Icon className={`h-4 w-4 ${config.iconColor}`} strokeWidth={2} />
          </div>
          <div className="flex items-center gap-1.5">
            <div className={`h-1.5 w-1.5 rounded-full ${config.dot} ${kpi.severity === "red" ? "health-pulse" : ""}`} />
          </div>
        </div>

        {/* Value */}
        <div className="relative">
          <p className={`text-2xl font-semibold tracking-tight leading-none ${config.valueColor} tabular-nums`}>
            {kpi.value}
          </p>
        </div>

        {/* Label + sub */}
        <div className="relative mt-2 space-y-0.5">
          <p className="text-[13px] font-medium text-foreground/80 leading-tight">
            {kpi.label}
          </p>
          <p className="text-[11px] text-muted-foreground/70 leading-tight">
            {kpi.sub}
          </p>
        </div>
      </div>
    </div>
  )
}

export function PortfolioHealthStrip({ data }: { data: PortfolioHealth }) {
  const kpis: KPI[] = [
    {
      label: "Active Projects",
      value: data.activeProjects,
      sub: data.activeProjects === 1 ? "1 project in progress" : `${data.activeProjects} projects in progress`,
      icon: FolderKanban,
      severity: data.activeProjects > 0 ? "green" : "amber",
    },
    {
      label: "Projects at Risk",
      value: data.projectsAtRisk,
      sub: data.projectsAtRisk === 0
        ? "All projects on track"
        : `Schedule or cost issues`,
      icon: AlertTriangle,
      severity: getSeverity(data.projectsAtRisk, [0, 1]),
    },
    {
      label: "Cash Exposure",
      value: data.cashRiskCents > 0 ? formatCompact(data.cashRiskCents) : "$0",
      sub: data.cashRiskCents === 0
        ? "No outstanding risk"
        : `${formatCompact(data.overdueARCents)} AR + ${formatCompact(data.unpaidApprovedBillsCents)} AP`,
      icon: Banknote,
      severity: getSeverity(data.cashRiskCents, [0, 500_000]),
    },
    {
      label: "Blockers",
      value: data.totalBlockers,
      sub: data.totalBlockers === 0
        ? "Nothing waiting on you"
        : `Decisions needed`,
      icon: ShieldAlert,
      severity: getSeverity(data.totalBlockers, [0, 3]),
    },
    {
      label: "Due This Week",
      value: data.itemsDueNext7Days,
      sub: data.itemsDueNext7Days === 0
        ? "Clear schedule ahead"
        : `Items in the next 7 days`,
      icon: CalendarClock,
      severity: getSeverity(data.itemsDueNext7Days, [5, 15]),
    },
  ]

  return (
    <div className="grid grid-cols-2 gap-px bg-border sm:grid-cols-3 lg:grid-cols-5 lg:gap-px overflow-hidden ring-1 ring-border">
      {kpis.map((kpi, i) => (
        <KPICell key={kpi.label} kpi={kpi} index={i} />
      ))}
    </div>
  )
}
