"use client"

import { useState, useCallback } from "react"
import { cn } from "@/lib/utils"
import type { ScheduleItem, ScheduleDependency, ScheduleAssignment, ScheduleBaseline } from "@/lib/types"
import type { ScheduleBulkItemUpdate } from "./types"
import { ScheduleProvider } from "./schedule-context"
import { ScheduleToolbar } from "./schedule-toolbar"
import { ScheduleItemSheet } from "./schedule-item-sheet"
import { GanttChart } from "./gantt-chart"
import { LookaheadView } from "./lookahead-view"
import { useSchedule } from "./schedule-context"

// Inner component that uses the schedule context
function ScheduleViewInner({ projectId, className }: { projectId: string; className?: string }) {
  const { viewState, selectedItem, setSelectedItem } = useSchedule()
  const [sheetOpen, setSheetOpen] = useState(false)
  const [quickAddDates, setQuickAddDates] = useState<{ start: Date; end: Date } | null>(null)

  const handleAddItem = useCallback(() => {
    setSelectedItem(null)
    setQuickAddDates(null)
    setSheetOpen(true)
  }, [setSelectedItem])

  const handleEditItem = useCallback((item: ScheduleItem) => {
    setSelectedItem(item)
    setSheetOpen(true)
  }, [setSelectedItem])

  const handleQuickAdd = useCallback((startDate: Date, endDate: Date) => {
    setSelectedItem(null)
    setQuickAddDates({ start: startDate, end: endDate })
    setSheetOpen(true)
  }, [setSelectedItem])

  const handleSheetClose = useCallback((open: boolean) => {
    setSheetOpen(open)
    if (!open) {
      setQuickAddDates(null)
    }
  }, [])

  // Render the appropriate view (Gantt or Lookahead)
  const renderView = () => {
    switch (viewState.view) {
      case "lookahead":
        return <LookaheadView className="flex-1" onAddItem={handleAddItem} />
      case "gantt":
      default:
        return <GanttChart className="flex-1" onQuickAdd={handleQuickAdd} onEditItem={handleEditItem} />
    }
  }

  return (
    <div className={cn("flex flex-col h-full bg-background overflow-hidden overflow-x-hidden w-full max-w-full", className)}>
      <ScheduleToolbar onAddItem={handleAddItem} projectId={projectId} />
      {renderView()}
      <ScheduleItemSheet
        open={sheetOpen}
        onOpenChange={handleSheetClose}
        item={selectedItem}
        projectId={projectId}
        initialDates={quickAddDates}
      />
    </div>
  )
}

// Main export with provider
interface ScheduleViewProps {
  className?: string
  projectId: string
  items: ScheduleItem[]
  dependencies?: ScheduleDependency[]
  assignments?: ScheduleAssignment[]
  baselines?: ScheduleBaseline[]
  onItemUpdate?: (id: string, updates: Partial<ScheduleItem>) => Promise<ScheduleItem>
  onItemsBulkUpdate?: (updates: ScheduleBulkItemUpdate[]) => Promise<ScheduleItem[]>
  onItemCreate?: (item: Partial<ScheduleItem>) => Promise<ScheduleItem>
  onItemDelete?: (id: string) => Promise<void>
  onDependencyCreate?: (from: string, to: string, type?: string) => Promise<ScheduleDependency>
  onDependencyDelete?: (id: string) => Promise<void>
}

export function ScheduleView({
  className,
  projectId,
  items,
  dependencies = [],
  assignments = [],
  baselines = [],
  onItemUpdate,
  onItemsBulkUpdate,
  onItemCreate,
  onItemDelete,
  onDependencyCreate,
  onDependencyDelete,
}: ScheduleViewProps) {
  return (
    <ScheduleProvider
      initialItems={items}
      initialDependencies={dependencies}
      initialAssignments={assignments}
      initialBaselines={baselines}
      onItemUpdate={onItemUpdate}
      onItemsBulkUpdate={onItemsBulkUpdate}
      onItemCreate={onItemCreate}
      onItemDelete={onItemDelete}
      onDependencyCreate={onDependencyCreate}
      onDependencyDelete={onDependencyDelete}
    >
      <ScheduleViewInner projectId={projectId} className={className} />
    </ScheduleProvider>
  )
}
