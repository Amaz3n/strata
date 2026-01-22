"use client"

import { useMemo } from "react"
import Link from "next/link"
import { Card, CardContent } from "@/components/ui/card"
import {
  CalendarDays,
  DollarSign,
  MessageSquare,
  FileText,
  Hammer,
  CheckCircle2,
  AlertCircle,
  AlertTriangle,
  TrendingUp,
  TrendingDown,
  Clock,
  ArrowRight,
  Zap,
  ClipboardList,
} from "@/components/icons"
import { cn } from "@/lib/utils"
import type { Project } from "@/lib/types"
import type { ProjectOverviewDTO, HealthCounts } from "@/app/(app)/projects/[id]/overview-actions"

interface ProjectOverviewHeroProps {
  project: Project
  scheduleProgress: number
  timeElapsedPercent: number
  daysRemaining: number
  totalDays: number
  budgetSummary?: ProjectOverviewDTO["budgetSummary"]
  health: HealthCounts
  projectId: string
}

function formatCurrency(cents: number): string {
  if (cents >= 100000000) {
    return `$${(cents / 100000000).toFixed(1)}M`
  }
  if (cents >= 100000) {
    return `$${Math.round(cents / 100000)}K`
  }
  return (cents / 100).toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  })
}

function formatCurrencyFull(cents: number): string {
  return (cents / 100).toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  })
}

// Compute overall project health score
function computeProjectHealth(
  scheduleProgress: number,
  timeElapsedPercent: number,
  health: HealthCounts
): { score: "excellent" | "good" | "attention" | "critical"; label: string } {
  const scheduleDiff = scheduleProgress - timeElapsedPercent
  const hasOverdue = health.schedule.overdue > 0 || health.rfis.overdue > 0 || health.submittals.overdue > 0
  const hasCritical = health.schedule.overdue > 2 || health.financial.budgetVariancePercent > 100

  if (hasCritical) return { score: "critical", label: "Needs Attention" }
  if (hasOverdue || scheduleDiff < -10) return { score: "attention", label: "Monitor Closely" }
  if (scheduleDiff >= 0 && !hasOverdue) return { score: "excellent", label: "On Track" }
  return { score: "good", label: "Progressing" }
}

// Progress Arc Component - the centerpiece visualization
interface ProgressArcProps {
  scheduleProgress: number
  timeElapsedPercent: number
}

function ProgressArc({ scheduleProgress, timeElapsedPercent }: ProgressArcProps) {
  const size = 200
  const strokeWidth = 12
  const center = size / 2
  const radius = (size - strokeWidth * 2) / 2
  const circumference = 2 * Math.PI * radius

  // Calculate offsets for both arcs
  const scheduleOffset = circumference - (scheduleProgress / 100) * circumference
  const timeOffset = circumference - (timeElapsedPercent / 100) * circumference

  const difference = scheduleProgress - timeElapsedPercent
  const isAhead = difference >= 0

  return (
    <div className="relative" style={{ width: size, height: size }}>
      <svg width={size} height={size} className="transform -rotate-90">
        {/* Background track */}
        <circle
          cx={center}
          cy={center}
          r={radius}
          fill="none"
          stroke="currentColor"
          strokeWidth={strokeWidth}
          className="text-muted/20"
        />

        {/* Time elapsed indicator (thinner, behind) */}
        <circle
          cx={center}
          cy={center}
          r={radius}
          fill="none"
          stroke="currentColor"
          strokeWidth={4}
          strokeDasharray={circumference}
          strokeDashoffset={timeOffset}
          strokeLinecap="round"
          className="text-muted-foreground/40 transition-all duration-1000 ease-out"
        />

        {/* Schedule progress (main arc) */}
        <circle
          cx={center}
          cy={center}
          r={radius}
          fill="none"
          stroke="url(#progressGradient)"
          strokeWidth={strokeWidth}
          strokeDasharray={circumference}
          strokeDashoffset={scheduleOffset}
          strokeLinecap="round"
          className="transition-all duration-1000 ease-out"
          style={{
            filter: "drop-shadow(0 0 6px rgba(var(--primary), 0.3))",
          }}
        />

        {/* Gradient definition */}
        <defs>
          <linearGradient id="progressGradient" x1="0%" y1="0%" x2="100%" y2="0%">
            <stop
              offset="0%"
              stopColor={isAhead ? "oklch(0.65 0.18 145)" : difference > -10 ? "oklch(0.75 0.15 65)" : "oklch(0.55 0.22 25)"}
            />
            <stop
              offset="100%"
              stopColor={isAhead ? "oklch(0.55 0.18 145)" : difference > -10 ? "oklch(0.65 0.15 65)" : "oklch(0.45 0.22 25)"}
            />
          </linearGradient>
        </defs>
      </svg>

      {/* Center content */}
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <span className="text-4xl font-bold tracking-tight">{scheduleProgress}%</span>
        <span className="text-xs text-muted-foreground mt-0.5">Complete</span>
      </div>
    </div>
  )
}

// Health Indicator Dot
function HealthDot({ status }: { status: "ok" | "warning" | "critical" }) {
  return (
    <span
      className={cn(
        "inline-block w-2 h-2 rounded-full",
        status === "ok" && "bg-success",
        status === "warning" && "bg-warning",
        status === "critical" && "bg-destructive animate-pulse"
      )}
    />
  )
}

// Metric Card Component
interface MetricCardProps {
  href: string
  icon: React.ReactNode
  label: string
  value: string | number
  subValue?: string
  status: "ok" | "warning" | "critical"
  trend?: "up" | "down" | "neutral"
}

function MetricCard({ href, icon, label, value, subValue, status, trend }: MetricCardProps) {
  return (
    <Link href={href} className="group block">
      <div
        className={cn(
          "relative overflow-hidden rounded-lg border p-3 transition-all duration-200",
          "hover:shadow-md hover:-translate-y-0.5",
          status === "ok" && "border-border bg-card hover:border-success/30",
          status === "warning" && "border-warning/30 bg-warning/5 hover:border-warning/50",
          status === "critical" && "border-destructive/30 bg-destructive/5 hover:border-destructive/50"
        )}
      >
        <div className="flex items-start justify-between gap-2">
          <div className="flex items-center gap-2">
            <div
              className={cn(
                "flex h-8 w-8 items-center justify-center rounded-md",
                status === "ok" && "bg-muted text-muted-foreground",
                status === "warning" && "bg-warning/10 text-warning",
                status === "critical" && "bg-destructive/10 text-destructive"
              )}
            >
              {icon}
            </div>
            <div>
              <p className="text-xs text-muted-foreground">{label}</p>
              <div className="flex items-center gap-1.5">
                <p className="text-lg font-semibold leading-none mt-0.5">{value}</p>
                {trend && trend !== "neutral" && (
                  <span
                    className={cn(
                      "text-xs",
                      trend === "up" && "text-success",
                      trend === "down" && "text-destructive"
                    )}
                  >
                    {trend === "up" ? <TrendingUp className="h-3 w-3" /> : <TrendingDown className="h-3 w-3" />}
                  </span>
                )}
              </div>
            </div>
          </div>
          <HealthDot status={status} />
        </div>
        {subValue && (
          <p className="text-[10px] text-muted-foreground mt-2 pl-10">{subValue}</p>
        )}
        <ArrowRight className="absolute bottom-2 right-2 h-3 w-3 text-muted-foreground/0 transition-all group-hover:text-muted-foreground/50" />
      </div>
    </Link>
  )
}

export function ProjectOverviewHero({
  project,
  scheduleProgress,
  timeElapsedPercent,
  daysRemaining,
  totalDays,
  budgetSummary,
  health,
  projectId,
}: ProjectOverviewHeroProps) {
  const difference = scheduleProgress - timeElapsedPercent
  const isAhead = difference >= 0

  const projectHealth = useMemo(
    () => computeProjectHealth(scheduleProgress, timeElapsedPercent, health),
    [scheduleProgress, timeElapsedPercent, health]
  )

  // Calculate statuses for metric cards
  const scheduleStatus = health.schedule.overdue > 0 ? "critical" : health.schedule.atRisk > 0 ? "warning" : "ok"
  const budgetStatus = health.financial.budgetVariancePercent > 100 ? "critical" : health.financial.budgetVariancePercent > 90 ? "warning" : "ok"
  const rfiStatus = health.rfis.overdue > 0 ? "critical" : health.rfis.open > 3 ? "warning" : "ok"
  const submittalStatus = health.submittals.overdue > 0 ? "critical" : health.submittals.pending > 3 ? "warning" : "ok"
  const punchStatus = health.punch.overdue > 0 ? "critical" : health.punch.open > 5 ? "warning" : "ok"
  const taskStatus = health.tasks.overdue > 0 ? "critical" : health.tasks.open > 10 ? "warning" : "ok"

  // Financial calculations
  const contractValue = health.financial.contractTotalCents
  const invoiced = health.financial.invoicedCents
  const invoicedPercent = contractValue > 0 ? Math.round((invoiced / contractValue) * 100) : 0

  return (
    <Card className="overflow-hidden">
      <CardContent className="p-0">
        {/* Top Section: Health Banner */}
        <div
          className={cn(
            "px-4 py-2 flex items-center justify-between",
            projectHealth.score === "excellent" && "bg-success/10",
            projectHealth.score === "good" && "bg-primary/10",
            projectHealth.score === "attention" && "bg-warning/10",
            projectHealth.score === "critical" && "bg-destructive/10"
          )}
        >
          <div className="flex items-center gap-2">
            <div
              className={cn(
                "flex h-6 w-6 items-center justify-center rounded-full",
                projectHealth.score === "excellent" && "bg-success text-success-foreground",
                projectHealth.score === "good" && "bg-primary text-primary-foreground",
                projectHealth.score === "attention" && "bg-warning text-warning-foreground",
                projectHealth.score === "critical" && "bg-destructive text-destructive-foreground"
              )}
            >
              {projectHealth.score === "excellent" && <CheckCircle2 className="h-3.5 w-3.5" />}
              {projectHealth.score === "good" && <Zap className="h-3.5 w-3.5" />}
              {projectHealth.score === "attention" && <AlertTriangle className="h-3.5 w-3.5" />}
              {projectHealth.score === "critical" && <AlertCircle className="h-3.5 w-3.5" />}
            </div>
            <span className="text-sm font-medium">{projectHealth.label}</span>
          </div>
          <div className="flex items-center gap-4 text-xs text-muted-foreground">
            <span className="flex items-center gap-1">
              <Clock className="h-3 w-3" />
              {daysRemaining} days left
            </span>
            {totalDays > 0 && (
              <span className="hidden sm:inline">Day {totalDays - daysRemaining} of {totalDays}</span>
            )}
          </div>
        </div>

        {/* Main Content */}
        <div className="p-4 lg:p-6">
          <div className="flex flex-col lg:flex-row gap-6 lg:gap-8">
            {/* Left: Progress Visualization */}
            <div className="flex flex-col items-center gap-4 lg:min-w-[220px]">
              <ProgressArc
                scheduleProgress={scheduleProgress}
                timeElapsedPercent={timeElapsedPercent}
              />

              {/* Progress Legend */}
              <div className="flex flex-col gap-1.5 text-xs w-full max-w-[200px]">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <span className="w-3 h-1 rounded-full bg-primary" />
                    <span className="text-muted-foreground">Work Done</span>
                  </div>
                  <span className="font-medium">{scheduleProgress}%</span>
                </div>
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <span className="w-3 h-1 rounded-full bg-muted-foreground/40" />
                    <span className="text-muted-foreground">Time Elapsed</span>
                  </div>
                  <span className="font-medium">{timeElapsedPercent}%</span>
                </div>
                <div className="border-t pt-1.5 mt-1">
                  <div className="flex items-center justify-between">
                    <span className="text-muted-foreground">Variance</span>
                    <span
                      className={cn(
                        "font-semibold flex items-center gap-1",
                        isAhead ? "text-success" : difference > -10 ? "text-warning" : "text-destructive"
                      )}
                    >
                      {isAhead ? <TrendingUp className="h-3 w-3" /> : <TrendingDown className="h-3 w-3" />}
                      {isAhead ? "+" : ""}{difference}%
                    </span>
                  </div>
                </div>
              </div>
            </div>

            {/* Right: Financial + Health Grid */}
            <div className="flex-1 flex flex-col gap-4">
              {/* Financial Summary Bar */}
              {contractValue > 0 && (
                <div className="rounded-lg border bg-muted/30 p-3">
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-xs font-medium text-muted-foreground">Contract Progress</span>
                    <span className="text-xs text-muted-foreground">{invoicedPercent}% Billed</span>
                  </div>

                  {/* Progress bar */}
                  <div className="relative h-2 bg-muted rounded-full overflow-hidden mb-3">
                    <div
                      className="absolute inset-y-0 left-0 bg-primary rounded-full transition-all duration-700 ease-out"
                      style={{ width: `${Math.min(100, invoicedPercent)}%` }}
                    />
                  </div>

                  {/* Financial Metrics Row */}
                  <div className="grid grid-cols-3 gap-4">
                    <div>
                      <p className="text-[10px] text-muted-foreground uppercase tracking-wide">Contract</p>
                      <p className="text-sm font-semibold">{formatCurrency(contractValue)}</p>
                    </div>
                    <div>
                      <p className="text-[10px] text-muted-foreground uppercase tracking-wide">Billed</p>
                      <p className="text-sm font-semibold">{formatCurrency(invoiced)}</p>
                    </div>
                    <div>
                      <p className="text-[10px] text-muted-foreground uppercase tracking-wide">Margin</p>
                      <p
                        className={cn(
                          "text-sm font-semibold",
                          budgetSummary && budgetSummary.grossMarginPercent > 0
                            ? "text-success"
                            : budgetSummary && budgetSummary.grossMarginPercent < 0
                            ? "text-destructive"
                            : ""
                        )}
                      >
                        {budgetSummary ? `${budgetSummary.grossMarginPercent}%` : "—"}
                      </p>
                    </div>
                  </div>
                </div>
              )}

              {/* Health Metrics Grid */}
              <div className="grid grid-cols-2 lg:grid-cols-3 gap-2">
                <MetricCard
                  href={`/projects/${projectId}/schedule`}
                  icon={<CalendarDays className="h-4 w-4" />}
                  label="Schedule"
                  value={health.schedule.overdue > 0 ? `${health.schedule.overdue} late` : "On track"}
                  subValue={
                    health.schedule.overdue > 0
                      ? `${health.schedule.atRisk} at risk`
                      : health.schedule.atRisk > 0
                      ? `${health.schedule.atRisk} at risk`
                      : "all items on track"
                  }
                  status={scheduleStatus}
                />

                <MetricCard
                  href={`/projects/${projectId}/financials`}
                  icon={<DollarSign className="h-4 w-4" />}
                  label="Budget"
                  value={`${health.financial.budgetVariancePercent}%`}
                  subValue={
                    health.financial.budgetVariancePercent > 100
                      ? "over budget"
                      : health.financial.budgetVariancePercent > 90
                      ? "near limit"
                      : "healthy spend"
                  }
                  status={budgetStatus}
                />

                <MetricCard
                  href={`/projects/${projectId}/rfis`}
                  icon={<MessageSquare className="h-4 w-4" />}
                  label="RFIs"
                  value={health.rfis.open}
                  subValue={health.rfis.overdue > 0 ? `${health.rfis.overdue} overdue` : "open"}
                  status={rfiStatus}
                />

                <MetricCard
                  href={`/projects/${projectId}/submittals`}
                  icon={<FileText className="h-4 w-4" />}
                  label="Submittals"
                  value={health.submittals.pending}
                  subValue={health.submittals.overdue > 0 ? `${health.submittals.overdue} overdue` : "pending"}
                  status={submittalStatus}
                />

                <MetricCard
                  href={`/projects/${projectId}/punch`}
                  icon={<Hammer className="h-4 w-4" />}
                  label="Punch List"
                  value={health.punch.open}
                  subValue={health.punch.overdue > 0 ? `${health.punch.overdue} overdue` : "open items"}
                  status={punchStatus}
                />

                <MetricCard
                  href={`/projects/${projectId}/tasks`}
                  icon={<ClipboardList className="h-4 w-4" />}
                  label="Tasks"
                  value={health.tasks.open}
                  subValue={health.tasks.overdue > 0 ? `${health.tasks.overdue} overdue` : "open tasks"}
                  status={taskStatus}
                />
              </div>
            </div>
          </div>
        </div>
      </CardContent>
    </Card>
  )
}
