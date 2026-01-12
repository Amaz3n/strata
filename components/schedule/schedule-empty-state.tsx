"use client"

import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { CalendarDays, Plus, FileText, Upload, Sparkles } from "lucide-react"

interface ScheduleEmptyStateProps {
  className?: string
  projectName?: string
  onAddItem?: () => void
  onImportTemplate?: () => void
}

/**
 * Empty state shown when a project has no schedule items
 */
export function ScheduleEmptyState({
  className,
  projectName,
  onAddItem,
  onImportTemplate,
}: ScheduleEmptyStateProps) {
  return (
    <div className={cn("flex flex-col items-center justify-center h-full p-8 text-center", className)}>
      {/* Animated icon container */}
      <div className="rounded-full bg-gradient-to-br from-primary/10 to-primary/5 p-6 mb-6 animate-in fade-in zoom-in-50 duration-500">
        <CalendarDays className="h-12 w-12 text-primary/60 animate-pulse" />
      </div>

      <h3 className="text-xl font-semibold mb-2 animate-in fade-in slide-in-from-bottom-2 duration-500 delay-100">
        {projectName ? `No schedule for ${projectName}` : "No schedule items yet"}
      </h3>

      <p className="text-muted-foreground max-w-md mb-8 leading-relaxed animate-in fade-in slide-in-from-bottom-2 duration-500 delay-150">
        Create your project schedule to track tasks, milestones, inspections, and keep your team on track.
        Drag bars to adjust dates, link dependencies, and monitor critical path.
      </p>

      <div className="flex flex-col sm:flex-row gap-3 animate-in fade-in slide-in-from-bottom-2 duration-500 delay-200">
        <Button
          onClick={onAddItem}
          size="lg"
          className="gap-2 transition-all duration-200 hover:scale-105 hover:shadow-lg"
        >
          <Plus className="h-4 w-4" />
          Add First Item
        </Button>

        <Button
          variant="outline"
          size="lg"
          onClick={onImportTemplate}
          className="gap-2 transition-all duration-200 hover:scale-105"
        >
          <FileText className="h-4 w-4" />
          Use Template
        </Button>
      </div>

      <div className="mt-12 pt-8 border-t w-full max-w-lg animate-in fade-in slide-in-from-bottom-4 duration-700 delay-300">
        <p className="text-xs text-muted-foreground mb-4">Quick Start Tips</p>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 text-left">
          <div className="flex gap-3 p-3 rounded-lg bg-muted/30 transition-all duration-200 hover:bg-muted/50 hover:scale-[1.02] hover:shadow-sm cursor-default">
            <div className="flex-shrink-0 w-8 h-8 rounded-full bg-blue-500/10 flex items-center justify-center">
              <span className="text-blue-600 dark:text-blue-400 font-semibold text-sm">1</span>
            </div>
            <div>
              <p className="text-sm font-medium">Add phases</p>
              <p className="text-xs text-muted-foreground">Foundation, framing, MEP...</p>
            </div>
          </div>

          <div className="flex gap-3 p-3 rounded-lg bg-muted/30 transition-all duration-200 hover:bg-muted/50 hover:scale-[1.02] hover:shadow-sm cursor-default">
            <div className="flex-shrink-0 w-8 h-8 rounded-full bg-emerald-500/10 flex items-center justify-center">
              <span className="text-emerald-600 dark:text-emerald-400 font-semibold text-sm">2</span>
            </div>
            <div>
              <p className="text-sm font-medium">Link tasks</p>
              <p className="text-xs text-muted-foreground">Set dependencies</p>
            </div>
          </div>

          <div className="flex gap-3 p-3 rounded-lg bg-muted/30 transition-all duration-200 hover:bg-muted/50 hover:scale-[1.02] hover:shadow-sm cursor-default">
            <div className="flex-shrink-0 w-8 h-8 rounded-full bg-amber-500/10 flex items-center justify-center">
              <span className="text-amber-600 dark:text-amber-400 font-semibold text-sm">3</span>
            </div>
            <div>
              <p className="text-sm font-medium">Assign trades</p>
              <p className="text-xs text-muted-foreground">Track by crew</p>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

/**
 * Compact empty state for inline use (e.g., in a tab)
 */
export function ScheduleEmptyStateCompact({
  className,
  onAddItem,
}: {
  className?: string
  onAddItem?: () => void
}) {
  return (
    <div className={cn("flex flex-col items-center justify-center py-12 px-4 text-center", className)}>
      <div className="w-12 h-12 rounded-full bg-muted flex items-center justify-center mb-4 animate-in fade-in zoom-in-75 duration-300">
        <CalendarDays className="h-6 w-6 text-muted-foreground" />
      </div>
      <p className="text-sm text-muted-foreground mb-4 animate-in fade-in slide-in-from-bottom-1 duration-300 delay-75">
        No schedule items yet
      </p>
      {onAddItem && (
        <Button
          variant="outline"
          size="sm"
          onClick={onAddItem}
          className="gap-2 animate-in fade-in slide-in-from-bottom-1 duration-300 delay-150 transition-all hover:scale-105"
        >
          <Plus className="h-3.5 w-3.5" />
          Add Item
        </Button>
      )}
    </div>
  )
}

/**
 * Empty state for the multi-project overview when no projects have schedules
 */
export function ScheduleOverviewEmptyState({ className }: { className?: string }) {
  return (
    <div className={cn("flex flex-col items-center justify-center h-full p-8 text-center", className)}>
      <div className="rounded-full bg-gradient-to-br from-primary/10 to-primary/5 p-6 mb-6 animate-in fade-in zoom-in-50 duration-500">
        <Sparkles className="h-12 w-12 text-primary/60 animate-pulse" />
      </div>

      <h3 className="text-xl font-semibold mb-2 animate-in fade-in slide-in-from-bottom-2 duration-500 delay-100">
        Master Schedule Overview
      </h3>

      <p className="text-muted-foreground max-w-md mb-6 leading-relaxed animate-in fade-in slide-in-from-bottom-2 duration-500 delay-150">
        View all your project schedules in one place. Select a project to get started,
        or create schedules for your active projects.
      </p>

      <div className="text-sm text-muted-foreground animate-in fade-in slide-in-from-bottom-2 duration-500 delay-200">
        <p className="px-4 py-2 rounded-lg bg-muted/50 border border-dashed">
          Select a project from the sidebar to view its schedule
        </p>
      </div>
    </div>
  )
}
