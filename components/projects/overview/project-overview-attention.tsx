"use client"

import Link from "next/link"
import { format, parseISO, differenceInDays } from "date-fns"
import { Card, CardContent } from "@/components/ui/card"
import {
  AlertCircle,
  CheckCircle,
  CalendarDays,
  MessageSquare,
  FileText,
  Hammer,
  AlertTriangle,
  ArrowRight,
  Clock,
  Ban,
} from "@/components/icons"
import type { AttentionItem } from "@/app/(app)/projects/[id]/overview-actions"
import { cn } from "@/lib/utils"

interface ProjectOverviewAttentionProps {
  items: AttentionItem[]
  projectId: string
}

const typeIcons: Record<string, React.ReactNode> = {
  task: <CheckCircle className="h-4 w-4" />,
  schedule: <CalendarDays className="h-4 w-4" />,
  rfi: <MessageSquare className="h-4 w-4" />,
  submittal: <FileText className="h-4 w-4" />,
  punch: <Hammer className="h-4 w-4" />,
  closeout: <AlertTriangle className="h-4 w-4" />,
  warranty: <AlertTriangle className="h-4 w-4" />,
}

const typeLabels: Record<string, string> = {
  task: "Task",
  schedule: "Schedule",
  rfi: "RFI",
  submittal: "Submittal",
  punch: "Punch",
  closeout: "Closeout",
  warranty: "Warranty",
}

function getUrgencyInfo(reason: string, dueDate?: string | null) {
  const today = new Date()

  if (dueDate) {
    const due = parseISO(dueDate)
    const daysOverdue = differenceInDays(today, due)

    if (daysOverdue > 0) {
      return {
        label: daysOverdue === 1 ? "1 day overdue" : `${daysOverdue} days overdue`,
        severity: daysOverdue > 7 ? "critical" : daysOverdue > 3 ? "high" : "medium",
      }
    }
  }

  switch (reason) {
    case "overdue":
      return { label: "Overdue", severity: "critical" as const }
    case "blocked":
      return { label: "Blocked", severity: "critical" as const }
    case "at_risk":
      return { label: "At Risk", severity: "high" as const }
    case "pending":
      return { label: "Pending", severity: "medium" as const }
    case "missing":
      return { label: "Missing", severity: "medium" as const }
    default:
      return { label: reason, severity: "medium" as const }
  }
}

const reasonIcons: Record<string, React.ReactNode> = {
  overdue: <Clock className="h-3 w-3" />,
  blocked: <Ban className="h-3 w-3" />,
  at_risk: <AlertTriangle className="h-3 w-3" />,
  pending: <Clock className="h-3 w-3" />,
  missing: <AlertCircle className="h-3 w-3" />,
}

export function ProjectOverviewAttention({ items, projectId }: ProjectOverviewAttentionProps) {
  if (items.length === 0) {
    return null
  }

  // Count by severity
  const criticalCount = items.filter(i =>
    i.reason === "overdue" || i.reason === "blocked"
  ).length
  const atRiskCount = items.filter(i => i.reason === "at_risk").length

  return (
    <Card className="h-full flex flex-col py-3">
      {/* Compact Header */}
      <div className="px-3 py-1.5 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <div className="flex h-5 w-5 items-center justify-center rounded bg-destructive/10 text-destructive">
            <AlertCircle className="h-3.5 w-3.5" />
          </div>
          <span className="text-sm font-semibold">Attention Required</span>
        </div>
        <div className="flex items-center gap-2">
          {criticalCount > 0 && (
            <span className="flex items-center gap-1 text-[10px] font-medium text-destructive">
              <span className="inline-block w-1.5 h-1.5 rounded-full bg-destructive animate-pulse" />
              {criticalCount}
            </span>
          )}
          {atRiskCount > 0 && (
            <span className="flex items-center gap-1 text-[10px] font-medium text-warning">
              <span className="inline-block w-1.5 h-1.5 rounded-full bg-warning" />
              {atRiskCount}
            </span>
          )}
        </div>
      </div>

      {/* Items List */}
      <CardContent className="px-3 pb-4 pt-2 flex-1 overflow-y-auto">
        <div className="space-y-1.5">
          {items.map((item) => {
            const urgency = getUrgencyInfo(item.reason, item.dueDate)
            const isCritical = urgency.severity === "critical"
            const isHigh = urgency.severity === "high"

            return (
              <Link
                key={`${item.type}-${item.id}`}
                href={item.link}
                className="group block"
              >
                <div
                  className={cn(
                    "relative flex items-start gap-3 rounded-lg border p-3 transition-all duration-200",
                    "hover:shadow-sm hover:-translate-y-0.5",
                    isCritical && "border-destructive/30 bg-destructive/5 hover:border-destructive/50",
                    isHigh && "border-warning/30 bg-warning/5 hover:border-warning/50",
                    !isCritical && !isHigh && "border-border bg-card hover:border-muted-foreground/30"
                  )}
                >
                  {/* Type Icon */}
                  <div
                    className={cn(
                      "flex h-8 w-8 shrink-0 items-center justify-center rounded-md",
                      isCritical && "bg-destructive/10 text-destructive",
                      isHigh && "bg-warning/10 text-warning",
                      !isCritical && !isHigh && "bg-muted text-muted-foreground"
                    )}
                  >
                    {typeIcons[item.type]}
                  </div>

                  {/* Content */}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-start justify-between gap-2">
                      <p className="text-sm font-medium leading-tight truncate pr-2">
                        {item.title}
                      </p>
                      {isCritical && (
                        <span className="inline-block w-2 h-2 rounded-full bg-destructive animate-pulse shrink-0 mt-1" />
                      )}
                    </div>
                    <div className="flex items-center gap-2 mt-1">
                      <span
                        className={cn(
                          "inline-flex items-center gap-1 text-[10px] font-medium uppercase tracking-wide",
                          isCritical && "text-destructive",
                          isHigh && "text-warning",
                          !isCritical && !isHigh && "text-muted-foreground"
                        )}
                      >
                        {reasonIcons[item.reason]}
                        {urgency.label}
                      </span>
                      <span className="text-[10px] text-muted-foreground">
                        {typeLabels[item.type]}
                      </span>
                    </div>
                  </div>

                  {/* Arrow */}
                  <ArrowRight className="h-4 w-4 text-muted-foreground/0 transition-all group-hover:text-muted-foreground/50 shrink-0 mt-2" />
                </div>
              </Link>
            )
          })}
        </div>
      </CardContent>
    </Card>
  )
}
