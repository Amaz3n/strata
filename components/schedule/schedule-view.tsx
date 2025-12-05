"use client"

import { useState, useCallback } from "react"
import { cn } from "@/lib/utils"
import type { ScheduleItem, ScheduleDependency, ScheduleAssignment, ScheduleBaseline } from "@/lib/types"
import { ScheduleProvider } from "./schedule-context"
import { ScheduleToolbar } from "./schedule-toolbar"
import { ScheduleItemSheet } from "./schedule-item-sheet"
import { GanttChart } from "./gantt-chart"
import { LookaheadView } from "./lookahead-view"
import { useSchedule } from "./schedule-context"
import type { ScheduleViewType } from "./types"

// List view component (simplified version using existing patterns)
import { format, parseISO, isAfter, isBefore, differenceInDays } from "date-fns"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Progress } from "@/components/ui/progress"
import { Checkbox } from "@/components/ui/checkbox"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { 
  CheckSquare, 
  Flag, 
  ClipboardCheck, 
  ArrowRightLeft, 
  Layers, 
  Truck, 
  AlertTriangle,
  Link2,
  MoreHorizontal,
} from "lucide-react"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { STATUS_COLORS, PHASE_COLORS, parseDate } from "./types"
import { scheduleStatuses } from "@/lib/validation/schedule"

// List view component
function ListView() {
  const { items, selectedItem, setSelectedItem, onItemUpdate, isLoading } = useSchedule()
  const today = new Date()

  const getItemIcon = (type: string) => {
    switch (type) {
      case "milestone": return <Flag className="h-4 w-4" />
      case "inspection": return <ClipboardCheck className="h-4 w-4" />
      case "handoff": return <ArrowRightLeft className="h-4 w-4" />
      case "phase": return <Layers className="h-4 w-4" />
      case "delivery": return <Truck className="h-4 w-4" />
      default: return <CheckSquare className="h-4 w-4" />
    }
  }

  const isOverdue = (item: ScheduleItem) => {
    const endDate = parseDate(item.end_date) || parseDate(item.start_date)
    return endDate && isBefore(endDate, today) && item.status !== "completed"
  }

  const handleStatusChange = async (itemId: string, newStatus: string) => {
    await onItemUpdate(itemId, { status: newStatus as ScheduleItem["status"] })
  }

  return (
    <div className="flex-1 overflow-auto">
      <Table>
        <TableHeader className="sticky top-0 bg-background z-10">
          <TableRow>
            <TableHead className="w-12"></TableHead>
            <TableHead>Item</TableHead>
            <TableHead>Type</TableHead>
            <TableHead>Phase</TableHead>
            <TableHead>Dates</TableHead>
            <TableHead>Status</TableHead>
            <TableHead className="w-32">Progress</TableHead>
            <TableHead className="w-12"></TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {items.map((item) => {
            const statusColors = STATUS_COLORS[item.status] || STATUS_COLORS.planned
            const overdue = isOverdue(item)
            const isSelected = selectedItem?.id === item.id
            
            return (
              <TableRow
                key={item.id}
                className={cn(
                  "cursor-pointer transition-colors",
                  isSelected && "bg-primary/5",
                  overdue && "border-l-2 border-l-red-500"
                )}
                onClick={() => setSelectedItem(item)}
              >
                <TableCell>
                  <Checkbox
                    checked={item.status === "completed"}
                    onClick={(e) => {
                      e.stopPropagation()
                      handleStatusChange(item.id, item.status === "completed" ? "in_progress" : "completed")
                    }}
                  />
                </TableCell>
                <TableCell>
                  <div className="flex items-center gap-2">
                    <div className={cn("p-1 rounded", statusColors.bg)}>
                      {getItemIcon(item.item_type)}
                    </div>
                    <div className="min-w-0">
                      <div className="font-medium truncate max-w-[200px]">{item.name}</div>
                      {item.location && (
                        <div className="text-xs text-muted-foreground truncate">{item.location}</div>
                      )}
                    </div>
                    {item.dependencies && item.dependencies.length > 0 && (
                      <Link2 className="h-3.5 w-3.5 text-muted-foreground" />
                    )}
                    {item.is_critical_path && (
                      <AlertTriangle className="h-3.5 w-3.5 text-orange-500" />
                    )}
                  </div>
                </TableCell>
                <TableCell>
                  <Badge variant="outline" className="capitalize">
                    {item.item_type}
                  </Badge>
                </TableCell>
                <TableCell>
                  {item.phase ? (
                    <div className="flex items-center gap-1.5">
                      <div
                        className="w-2 h-2 rounded-full"
                        style={{ backgroundColor: PHASE_COLORS[item.phase] || "#64748b" }}
                      />
                      <span className="text-sm capitalize">{item.phase.replace(/_/g, " ")}</span>
                    </div>
                  ) : (
                    <span className="text-muted-foreground">—</span>
                  )}
                </TableCell>
                <TableCell className="text-sm text-muted-foreground">
                  {item.start_date ? (
                    <>
                      {format(parseDate(item.start_date)!, "MMM d")}
                      {item.end_date && ` – ${format(parseDate(item.end_date)!, "MMM d")}`}
                    </>
                  ) : (
                    "No dates"
                  )}
                  {overdue && (
                    <span className="text-red-500 text-xs ml-2">Overdue</span>
                  )}
                </TableCell>
                <TableCell>
                  <Select
                    value={item.status}
                    onValueChange={(value) => handleStatusChange(item.id, value)}
                  >
                    <SelectTrigger 
                      className={cn("h-8 w-32", statusColors.bg, statusColors.text)}
                      onClick={(e) => e.stopPropagation()}
                    >
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {scheduleStatuses.map((status) => (
                        <SelectItem key={status} value={status}>
                          <span className="capitalize">{status.replace(/_/g, " ")}</span>
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </TableCell>
                <TableCell>
                  <div className="space-y-1">
                    <Progress value={item.progress || 0} className="h-2" />
                    <span className="text-xs text-muted-foreground">{item.progress || 0}%</span>
                  </div>
                </TableCell>
                <TableCell>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild onClick={(e) => e.stopPropagation()}>
                      <Button variant="ghost" size="icon" className="h-8 w-8">
                        <MoreHorizontal className="h-4 w-4" />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuItem>Edit</DropdownMenuItem>
                      <DropdownMenuItem>Duplicate</DropdownMenuItem>
                      <DropdownMenuItem className="text-destructive">Delete</DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </TableCell>
              </TableRow>
            )
          })}
          {items.length === 0 && (
            <TableRow>
              <TableCell colSpan={8} className="text-center py-12 text-muted-foreground">
                No schedule items yet. Add your first item to get started.
              </TableCell>
            </TableRow>
          )}
        </TableBody>
      </Table>
    </div>
  )
}

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

  // Render the appropriate view
  const renderView = () => {
    switch (viewState.view) {
      case "gantt":
        return <GanttChart className="flex-1" onQuickAdd={handleQuickAdd} onEditItem={handleEditItem} />
      case "list":
        return <ListView />
      case "lookahead":
        return <LookaheadView className="flex-1" />
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
      onItemCreate={onItemCreate}
      onItemDelete={onItemDelete}
      onDependencyCreate={onDependencyCreate}
      onDependencyDelete={onDependencyDelete}
    >
      <ScheduleViewInner projectId={projectId} className={className} />
    </ScheduleProvider>
  )
}

