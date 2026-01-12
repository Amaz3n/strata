"use client"

import { useMemo } from "react"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { ChartContainer, ChartTooltip, ChartTooltipContent } from "@/components/ui/chart"
import { RadialBarChart, RadialBar, PolarAngleAxis, ResponsiveContainer, Legend } from "recharts"
import { cn } from "@/lib/utils"

interface ProjectOverviewProgressChartProps {
  scheduleProgress: number
  timeElapsedPercent: number
  budgetUsedPercent: number
  daysRemaining: number
  totalDays: number
}

const chartConfig = {
  schedule: {
    label: "Schedule Complete",
    color: "hsl(var(--chart-1))",
  },
  time: {
    label: "Time Elapsed",
    color: "hsl(var(--chart-2))",
  },
  budget: {
    label: "Budget Used",
    color: "hsl(var(--chart-3))",
  },
}

export function ProjectOverviewProgressChart({
  scheduleProgress,
  timeElapsedPercent,
  budgetUsedPercent,
  daysRemaining,
  totalDays,
}: ProjectOverviewProgressChartProps) {
  // Calculate if project is ahead or behind schedule
  const scheduleVsTime = scheduleProgress - timeElapsedPercent
  const isAhead = scheduleVsTime >= 0
  const isBudgetHealthy = budgetUsedPercent <= timeElapsedPercent + 10

  const data = useMemo(() => [
    {
      name: "Schedule",
      value: scheduleProgress,
      fill: "hsl(var(--chart-1))",
    },
    {
      name: "Time",
      value: timeElapsedPercent,
      fill: "hsl(var(--chart-2))",
    },
    {
      name: "Budget",
      value: Math.min(100, budgetUsedPercent),
      fill: "hsl(var(--chart-3))",
    },
  ], [scheduleProgress, timeElapsedPercent, budgetUsedPercent])

  return (
    <Card className="flex flex-col">
      <CardHeader className="pb-2">
        <CardTitle className="text-base">Project Progress</CardTitle>
        <CardDescription>
          Schedule vs time elapsed vs budget used
        </CardDescription>
      </CardHeader>
      <CardContent className="flex-1 pb-0">
        <div className="flex flex-col lg:flex-row items-center gap-4">
          {/* Chart */}
          <ChartContainer
            config={chartConfig}
            className="mx-auto aspect-square w-full max-w-[200px]"
          >
            <RadialBarChart
              data={data}
              startAngle={180}
              endAngle={0}
              innerRadius="30%"
              outerRadius="100%"
              barSize={18}
            >
              <PolarAngleAxis
                type="number"
                domain={[0, 100]}
                angleAxisId={0}
                tick={false}
              />
              <RadialBar
                background
                dataKey="value"
                cornerRadius={10}
                fill="#8884d8"
              />
              <ChartTooltip
                cursor={false}
                content={
                  <ChartTooltipContent
                    hideLabel
                    formatter={(value, name) => (
                      <div className="flex items-center gap-2">
                        <span className="font-medium">{name}:</span>
                        <span className="font-mono">{value}%</span>
                      </div>
                    )}
                  />
                }
              />
            </RadialBarChart>
          </ChartContainer>

          {/* Legend and Stats */}
          <div className="flex-1 space-y-3 text-sm">
            {/* Schedule */}
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <div className="h-3 w-3 rounded-full bg-[hsl(var(--chart-1))]" />
                <span className="text-muted-foreground">Schedule</span>
              </div>
              <span className="font-mono font-semibold">{scheduleProgress}%</span>
            </div>

            {/* Time */}
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <div className="h-3 w-3 rounded-full bg-[hsl(var(--chart-2))]" />
                <span className="text-muted-foreground">Time Elapsed</span>
              </div>
              <span className="font-mono font-semibold">{timeElapsedPercent}%</span>
            </div>

            {/* Budget */}
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <div className="h-3 w-3 rounded-full bg-[hsl(var(--chart-3))]" />
                <span className="text-muted-foreground">Budget Used</span>
              </div>
              <span className={cn(
                "font-mono font-semibold",
                budgetUsedPercent > 100 && "text-destructive",
                budgetUsedPercent > 90 && budgetUsedPercent <= 100 && "text-warning"
              )}>
                {budgetUsedPercent}%
              </span>
            </div>

            {/* Status Summary */}
            <div className="pt-2 border-t">
              <div className={cn(
                "text-xs font-medium px-2 py-1 rounded inline-block",
                isAhead ? "bg-success/10 text-success" : "bg-warning/10 text-warning"
              )}>
                {isAhead
                  ? `${Math.abs(scheduleVsTime)}% ahead of schedule`
                  : `${Math.abs(scheduleVsTime)}% behind schedule`
                }
              </div>
              {daysRemaining > 0 && (
                <p className="text-xs text-muted-foreground mt-1">
                  {daysRemaining} of {totalDays} days remaining
                </p>
              )}
            </div>
          </div>
        </div>
      </CardContent>
    </Card>
  )
}
