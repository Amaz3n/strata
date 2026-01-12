"use client"

import { cn } from "@/lib/utils"
import { Skeleton } from "@/components/ui/skeleton"
import { GANTT_ROW_HEIGHT, GANTT_HEADER_HEIGHT, GANTT_SIDEBAR_WIDTH } from "./types"

interface ScheduleSkeletonProps {
  className?: string
  rows?: number
}

// Staggered animation delays for smoother loading feel
const getStaggerDelay = (index: number, baseMs = 50) => ({
  animationDelay: `${index * baseMs}ms`,
})

/**
 * Loading skeleton for the Gantt chart view
 */
export function GanttChartSkeleton({ className, rows = 8 }: ScheduleSkeletonProps) {
  return (
    <div className={cn("flex flex-col h-full overflow-hidden rounded-lg border bg-background animate-in fade-in duration-300", className)}>
      {/* Toolbar skeleton */}
      <div className="flex items-center justify-between p-4 border-b bg-muted/30 animate-in fade-in slide-in-from-top-2 duration-300">
        <div className="flex items-center gap-2">
          <Skeleton className="h-9 w-[200px] rounded-lg" />
        </div>
        <div className="flex items-center gap-2">
          <Skeleton className="h-8 w-8 rounded-md" />
          <Skeleton className="h-8 w-16 rounded-md" />
          <Skeleton className="h-8 w-8 rounded-md" />
        </div>
        <div className="flex items-center gap-2">
          <Skeleton className="h-6 w-20 rounded-full" />
          <Skeleton className="h-6 w-24 rounded-full" />
          <Skeleton className="h-9 w-24 rounded-md" />
        </div>
      </div>

      {/* Header skeleton */}
      <div className="flex flex-shrink-0 border-b bg-muted/30" style={{ height: GANTT_HEADER_HEIGHT }}>
        <div
          className="flex-shrink-0 border-r bg-muted/50 flex items-end px-3 pb-2"
          style={{ width: GANTT_SIDEBAR_WIDTH }}
        >
          <Skeleton className="h-3 w-12" />
        </div>
        <div className="flex-1 flex flex-col">
          {/* Month row */}
          <div className="flex h-7 border-b border-border/50">
            {[1, 2, 3].map((i) => (
              <div key={i} className="flex-1 flex items-center justify-center px-4">
                <Skeleton className="h-3 w-24" />
              </div>
            ))}
          </div>
          {/* Day row */}
          <div className="flex h-8">
            {Array.from({ length: 14 }).map((_, i) => (
              <div key={i} className="flex-1 flex items-center justify-center min-w-[40px]">
                <Skeleton className="h-3 w-4" />
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Content skeleton */}
      <div className="flex flex-1 overflow-hidden">
        {/* Sidebar */}
        <div
          className="flex-shrink-0 border-r bg-background"
          style={{ width: GANTT_SIDEBAR_WIDTH }}
        >
          {Array.from({ length: rows }).map((_, i) => (
            <div
              key={i}
              className="flex items-center gap-2 px-3 border-b animate-in fade-in slide-in-from-left-2"
              style={{
                height: GANTT_ROW_HEIGHT,
                ...getStaggerDelay(i, 30),
              }}
            >
              <Skeleton className="h-4 w-4 rounded" />
              <Skeleton className="h-4 w-4 rounded" />
              <div className="flex-1 min-w-0">
                <Skeleton className="h-4 w-3/4 mb-1" />
                <Skeleton className="h-3 w-1/2" />
              </div>
            </div>
          ))}
        </div>

        {/* Timeline grid */}
        <div className="flex-1 relative">
          {Array.from({ length: rows }).map((_, i) => (
            <div
              key={i}
              className="border-b relative"
              style={{ height: GANTT_ROW_HEIGHT }}
            >
              <Skeleton
                className="absolute h-7 rounded-md animate-in fade-in zoom-in-95 duration-500"
                style={{
                  left: `${8 + (i * 4)}%`,
                  width: `${15 + (i * 2.5)}%`,
                  top: 6,
                  ...getStaggerDelay(i, 60),
                }}
              />
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

/**
 * Loading skeleton for the Lookahead view
 */
export function LookaheadSkeleton({ className, rows = 5 }: ScheduleSkeletonProps) {
  const days = 14 // 2 weeks

  return (
    <div className={cn("flex flex-col h-full animate-in fade-in duration-300", className)}>
      {/* Header skeleton */}
      <div className="flex items-center justify-between px-4 py-3 border-b bg-muted/30 animate-in fade-in slide-in-from-top-2 duration-300">
        <div className="flex items-center gap-3">
          <Skeleton className="h-8 w-8 rounded-md" />
          <Skeleton className="h-8 w-16 rounded-md" />
          <Skeleton className="h-8 w-8 rounded-md" />
          <Skeleton className="h-4 w-40" />
        </div>
        <Skeleton className="h-8 w-[130px] rounded-md" />
      </div>

      {/* Grid skeleton */}
      <div className="flex-1 overflow-auto">
        <div className="min-w-max">
          {/* Day headers */}
          <div className="flex border-b sticky top-0 bg-background z-10">
            <div className="w-48 flex-shrink-0 px-3 py-2 border-r bg-muted/50">
              <Skeleton className="h-3 w-16" />
            </div>
            {Array.from({ length: days }).map((_, i) => (
              <div key={i} className="w-32 flex-shrink-0 px-2 py-2 border-r text-center space-y-1">
                <Skeleton className="h-3 w-8 mx-auto" />
                <Skeleton className="h-5 w-4 mx-auto" />
                <div className="flex items-center justify-center gap-1 mt-1">
                  <Skeleton className="h-3 w-3 rounded-full" />
                  <Skeleton className="h-3 w-6" />
                </div>
              </div>
            ))}
          </div>

          {/* Crew rows */}
          {Array.from({ length: rows }).map((_, rowIndex) => (
            <div
              key={rowIndex}
              className="flex border-b animate-in fade-in slide-in-from-left-2"
              style={getStaggerDelay(rowIndex, 40)}
            >
              <div className="w-48 flex-shrink-0 px-3 py-3 border-r bg-muted/20">
                <div className="flex items-center gap-2">
                  <Skeleton className="h-8 w-8 rounded-full" />
                  <div className="min-w-0">
                    <Skeleton className="h-4 w-24 mb-1" />
                    <Skeleton className="h-3 w-12" />
                  </div>
                </div>
              </div>
              {Array.from({ length: days }).map((_, dayIndex) => (
                <div key={dayIndex} className="w-32 flex-shrink-0 px-1 py-2 border-r min-h-[80px]">
                  {(rowIndex + dayIndex) % 3 === 0 && (
                    <Skeleton
                      className="h-10 w-full rounded animate-in fade-in zoom-in-95"
                      style={getStaggerDelay(dayIndex, 20)}
                    />
                  )}
                  {(rowIndex + dayIndex) % 4 === 1 && (
                    <>
                      <Skeleton
                        className="h-10 w-full rounded mb-1 animate-in fade-in zoom-in-95"
                        style={getStaggerDelay(dayIndex, 20)}
                      />
                      <Skeleton
                        className="h-10 w-full rounded animate-in fade-in zoom-in-95"
                        style={getStaggerDelay(dayIndex + 1, 20)}
                      />
                    </>
                  )}
                </div>
              ))}
            </div>
          ))}
        </div>
      </div>

      {/* Footer skeleton */}
      <div className="border-t px-4 py-3 bg-muted/30 animate-in fade-in slide-in-from-bottom-2 duration-300 delay-200">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-4">
            <div className="flex items-center gap-1.5">
              <Skeleton className="w-2 h-2 rounded-full" />
              <Skeleton className="h-3 w-20" />
            </div>
            <div className="flex items-center gap-1.5">
              <Skeleton className="w-2 h-2 rounded-full" />
              <Skeleton className="h-3 w-20" />
            </div>
            <div className="flex items-center gap-1.5">
              <Skeleton className="w-2 h-2 rounded-full" />
              <Skeleton className="h-3 w-16" />
            </div>
          </div>
          <Skeleton className="h-3 w-24" />
        </div>
      </div>
    </div>
  )
}

/**
 * Full page schedule skeleton with toolbar
 */
export function SchedulePageSkeleton({ className }: { className?: string }) {
  return (
    <div className={cn("flex flex-col h-full", className)}>
      <GanttChartSkeleton />
    </div>
  )
}
