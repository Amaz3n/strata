import Link from "next/link"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Progress } from "@/components/ui/progress"
import {
  CalendarDays,
  DollarSign,
  MessageSquare,
  Hammer,
  AlertCircle,
  TrendingUp,
  CheckCircle,
} from "@/components/icons"
import type { HealthCounts } from "@/app/(app)/projects/[id]/overview-actions"
import { cn } from "@/lib/utils"

interface ProjectOverviewHealthStripProps {
  projectId: string
  health: HealthCounts
  scheduleProgress: number
}

export function ProjectOverviewHealthStrip({
  projectId,
  health,
  scheduleProgress,
}: ProjectOverviewHealthStripProps) {
  const scheduleHasIssues = health.schedule.atRisk > 0 || health.schedule.overdue > 0
  const commsHasIssues = health.rfis.overdue > 0 || health.submittals.overdue > 0
  const fieldHasIssues = health.punch.overdue > 0 || health.warranty.open > 0
  const budgetHasIssues = health.financial.budgetVariancePercent > 90

  return (
    <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
      {/* Schedule Health */}
      <Link href={`/projects/${projectId}/schedule`}>
        <Card className="hover:bg-muted/50 transition-colors cursor-pointer h-full">
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium">Schedule</CardTitle>
            {scheduleHasIssues ? (
              <AlertCircle className="h-4 w-4 text-warning" />
            ) : (
              <TrendingUp className="h-4 w-4 text-success" />
            )}
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{scheduleProgress}%</div>
            <p className="text-xs text-muted-foreground">
              {scheduleHasIssues ? (
                <>
                  <span className="text-warning">{health.schedule.atRisk} at risk</span>
                  {health.schedule.overdue > 0 && (
                    <span className="text-destructive"> &bull; {health.schedule.overdue} overdue</span>
                  )}
                </>
              ) : (
                "On track"
              )}
            </p>
            <Progress value={scheduleProgress} className="mt-2" />
          </CardContent>
        </Card>
      </Link>

      {/* Budget Health */}
      <Link href={`/projects/${projectId}/financials`}>
        <Card className="hover:bg-muted/50 transition-colors cursor-pointer h-full">
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium">Budget</CardTitle>
            {budgetHasIssues ? (
              <AlertCircle className="h-4 w-4 text-warning" />
            ) : (
              <DollarSign className="h-4 w-4 text-success" />
            )}
          </CardHeader>
          <CardContent>
            <div className={cn(
              "text-2xl font-bold",
              health.financial.budgetVariancePercent > 100 && "text-destructive",
              health.financial.budgetVariancePercent > 90 && health.financial.budgetVariancePercent <= 100 && "text-warning"
            )}>
              {health.financial.budgetVariancePercent}%
            </div>
            <p className="text-xs text-muted-foreground">
              {health.financial.contractTotalCents > 0 ? (
                <>
                  Contract: ${(health.financial.contractTotalCents / 100).toLocaleString()}
                </>
              ) : (
                "No contract set"
              )}
            </p>
            <Progress
              value={Math.min(100, health.financial.budgetVariancePercent)}
              className={cn(
                "mt-2",
                health.financial.budgetVariancePercent > 100 && "[&>div]:bg-destructive",
                health.financial.budgetVariancePercent > 90 && health.financial.budgetVariancePercent <= 100 && "[&>div]:bg-warning"
              )}
            />
          </CardContent>
        </Card>
      </Link>

      {/* Comms Health (RFIs + Submittals) */}
      <Link href={`/rfis?project=${projectId}`}>
        <Card className="hover:bg-muted/50 transition-colors cursor-pointer h-full">
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium">Comms</CardTitle>
            {commsHasIssues ? (
              <AlertCircle className="h-4 w-4 text-warning" />
            ) : (
              <MessageSquare className="h-4 w-4 text-muted-foreground" />
            )}
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">
              {health.rfis.open + health.submittals.pending}
            </div>
            <p className="text-xs text-muted-foreground">
              {health.rfis.open} RFIs open &bull; {health.submittals.pending} submittals pending
              {(health.rfis.overdue > 0 || health.submittals.overdue > 0) && (
                <span className="block text-destructive">
                  {health.rfis.overdue + health.submittals.overdue} overdue
                </span>
              )}
            </p>
          </CardContent>
        </Card>
      </Link>

      {/* Field/Closeout Health */}
      <Link href={`/projects/${projectId}/punch`}>
        <Card className="hover:bg-muted/50 transition-colors cursor-pointer h-full">
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium">Field</CardTitle>
            {fieldHasIssues ? (
              <AlertCircle className="h-4 w-4 text-warning" />
            ) : health.punch.open === 0 && health.warranty.open === 0 ? (
              <CheckCircle className="h-4 w-4 text-success" />
            ) : (
              <Hammer className="h-4 w-4 text-muted-foreground" />
            )}
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{health.punch.open}</div>
            <p className="text-xs text-muted-foreground">
              punch items open
              {health.punch.overdue > 0 && (
                <span className="text-destructive"> &bull; {health.punch.overdue} overdue</span>
              )}
              {health.warranty.open > 0 && (
                <span className="block">{health.warranty.open} warranty requests</span>
              )}
            </p>
          </CardContent>
        </Card>
      </Link>
    </div>
  )
}
