"use client"

import { useRef, useState, useCallback, useMemo, useEffect } from "react"
import { format, differenceInDays, startOfDay, isSameDay, isWeekend as checkIsWeekend, addDays as dateAddDays } from "date-fns"
import { cn } from "@/lib/utils"
import type { ScheduleItem } from "@/lib/types"
import {
  GANTT_ROW_HEIGHT,
  GANTT_HEADER_HEIGHT,
  GANTT_SIDEBAR_WIDTH,
  GANTT_BAR_HEIGHT,
  GANTT_BAR_PADDING,
  GANTT_MILESTONE_SIZE,
  STATUS_COLORS,
  PHASE_COLORS,
  type GanttZoomLevel,
  type GroupByOption,
  type DragState,
  parseDate,
  toDateString,
} from "./types"
import { useSchedule } from "./schedule-context"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Progress } from "@/components/ui/progress"
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip"
import {
  ChevronDown,
  ChevronRight,
  Flag,
  GripVertical,
  CheckSquare,
  ClipboardCheck,
  ArrowRightLeft,
  Layers,
  Truck,
  AlertTriangle,
  Link2,
  Plus,
} from "lucide-react"
import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core"
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable"
import { CSS } from "@dnd-kit/utilities"

interface GanttChartProps {
  className?: string
  onQuickAdd?: (startDate: Date, endDate: Date) => void
  onEditItem?: (item: ScheduleItem) => void
}

// Get icon for item type
function getItemIcon(type: string) {
  switch (type) {
    case "milestone":
      return <Flag className="h-3.5 w-3.5" />
    case "inspection":
      return <ClipboardCheck className="h-3.5 w-3.5" />
    case "handoff":
      return <ArrowRightLeft className="h-3.5 w-3.5" />
    case "phase":
      return <Layers className="h-3.5 w-3.5" />
    case "delivery":
      return <Truck className="h-3.5 w-3.5" />
    default:
      return <CheckSquare className="h-3.5 w-3.5" />
  }
}

// Sortable task row component for drag-and-drop reordering
interface SortableTaskRowProps {
  item: ScheduleItem
  isSelected: boolean
  onSelect: (item: ScheduleItem) => void
}

function SortableTaskRow({ item, isSelected, onSelect }: SortableTaskRowProps) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: item.id })

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    height: GANTT_ROW_HEIGHT,
    zIndex: isDragging ? 50 : undefined,
  }

  const statusColors = STATUS_COLORS[item.status] || STATUS_COLORS.planned

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={cn(
        "flex items-center gap-2 px-3 border-b cursor-pointer transition-colors",
        isSelected ? "bg-primary/5 border-l-2 border-l-primary" : "hover:bg-muted/30",
        item.is_critical_path && !isSelected && "border-l-2 border-l-orange-500",
        isDragging && "bg-muted shadow-lg opacity-90"
      )}
      onClick={() => onSelect(item)}
    >
      <div 
        {...attributes} 
        {...listeners}
        className="cursor-grab active:cursor-grabbing flex-shrink-0 touch-none"
      >
        <GripVertical className="h-4 w-4 text-muted-foreground/50 hover:text-muted-foreground" />
      </div>
      <Checkbox
        checked={item.status === "completed"}
        className="h-4 w-4 flex-shrink-0"
        onClick={(e) => e.stopPropagation()}
      />
      <div className={cn("p-1 rounded flex-shrink-0", statusColors.bg)}>
        {getItemIcon(item.item_type)}
      </div>
      <div className="flex-1 min-w-0">
        <div className="text-sm font-medium truncate">{item.name}</div>
        {item.trade && (
          <div className="text-xs text-muted-foreground truncate capitalize">
            {item.trade.replace(/_/g, " ")}
          </div>
        )}
      </div>
      {item.dependencies && item.dependencies.length > 0 && (
        <Tooltip>
          <TooltipTrigger>
            <Link2 className="h-3.5 w-3.5 text-muted-foreground flex-shrink-0" />
          </TooltipTrigger>
          <TooltipContent>
            {item.dependencies.length} dependencies
          </TooltipContent>
        </Tooltip>
      )}
      {item.is_critical_path && (
        <Tooltip>
          <TooltipTrigger>
            <AlertTriangle className="h-3.5 w-3.5 text-orange-500 flex-shrink-0" />
          </TooltipTrigger>
          <TooltipContent>Critical path item</TooltipContent>
        </Tooltip>
      )}
    </div>
  )
}

// Group items by a key
function groupItems(items: ScheduleItem[], groupBy: GroupByOption): Map<string, ScheduleItem[]> {
  if (groupBy === "none") {
    return new Map([["all", items]])
  }

  const grouped = new Map<string, ScheduleItem[]>()
  
  for (const item of items) {
    let key: string
    switch (groupBy) {
      case "phase":
        key = item.phase || "Unassigned"
        break
      case "trade":
        key = item.trade || "Unassigned"
        break
      case "assignee":
        key = item.assigned_to || "Unassigned"
        break
      case "status":
        key = item.status || "planned"
        break
      default:
        key = "all"
    }
    
    if (!grouped.has(key)) {
      grouped.set(key, [])
    }
    grouped.get(key)!.push(item)
  }
  
  return grouped
}

// Calculate column width based on zoom level
function getColumnWidth(zoom: GanttZoomLevel): number {
  switch (zoom) {
    case "day":
      return 60
    case "week":
      return 40
    case "month":
      return 20
    case "quarter":
      return 8
    default:
      return 40
  }
}

// Generate timeline columns based on zoom
function generateTimelineColumns(start: Date, end: Date, zoom: GanttZoomLevel) {
  const columns: { date: Date; label: string; isToday: boolean; isWeekend: boolean }[] = []
  const current = new Date(start)
  const today = startOfDay(new Date())
  
  while (current <= end) {
    const isToday = isSameDay(current, today)
    const isWeekend = checkIsWeekend(current)
    
    let label: string
    switch (zoom) {
      case "day":
        label = format(current, "EEE d")
        break
      case "week":
        label = format(current, "d")
        break
      case "month":
        label = format(current, "d")
        break
      case "quarter":
        label = current.getDate() === 1 ? format(current, "MMM") : ""
        break
      default:
        label = format(current, "d")
    }
    
    columns.push({ date: new Date(current), label, isToday, isWeekend })
    current.setDate(current.getDate() + 1)
  }
  
  return columns
}

// Generate month headers for the timeline
function generateMonthHeaders(start: Date, end: Date) {
  const headers: { start: Date; end: Date; label: string; span: number }[] = []
  const current = new Date(start.getFullYear(), start.getMonth(), 1)
  
  while (current <= end) {
    const monthEnd = new Date(current.getFullYear(), current.getMonth() + 1, 0)
    const effectiveStart = current < start ? start : current
    const effectiveEnd = monthEnd > end ? end : monthEnd
    const span = differenceInDays(effectiveEnd, effectiveStart) + 1
    
    headers.push({
      start: effectiveStart,
      end: effectiveEnd,
      label: format(current, "MMMM yyyy"),
      span,
    })
    
    current.setMonth(current.getMonth() + 1)
  }
  
  return headers
}

// Selection state for click-to-add
interface DateSelection {
  startDate: Date
  endDate: Date
  startX: number
  isDragging: boolean
}

export function GanttChart({ className, onQuickAdd, onEditItem }: GanttChartProps) {
  const {
    items: rawItems,
    dependencies,
    viewState,
    selectedItem,
    setSelectedItem,
    onItemUpdate,
    scrollToTodayTrigger,
  } = useSchedule()

  const items = Array.isArray(rawItems) ? rawItems : []

  const containerRef = useRef<HTMLDivElement>(null)
  const scrollContainerRef = useRef<HTMLDivElement>(null)
  const sidebarRef = useRef<HTMLDivElement>(null)
  const hasScrolledToToday = useRef(false)
  const [dragState, setDragState] = useState<DragState | null>(null)
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set(["all", "Unassigned"]))
  const [scrollLeft, setScrollLeft] = useState(0)
  const [dateSelection, setDateSelection] = useState<DateSelection | null>(null)
  const [viewportHeight, setViewportHeight] = useState(0)

  // DnD sensors for drag-to-reorder
  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: {
        distance: 8, // Require 8px movement before starting drag
      },
    }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    })
  )

  // Handle drag end for reordering
  const handleDragEnd = useCallback(async (event: DragEndEvent) => {
    const { active, over } = event
    
    if (!over || active.id === over.id) return

    // Use items directly - sort_order determines display order
    const sortedItems = [...items].sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0))
    
    const oldIndex = sortedItems.findIndex(item => item.id === active.id)
    const newIndex = sortedItems.findIndex(item => item.id === over.id)
    
    if (oldIndex === -1 || newIndex === -1) return

    // Get the new order
    const reorderedItems = arrayMove(sortedItems, oldIndex, newIndex)
    
    // Update sort_order for affected items (only those that changed)
    for (let i = 0; i < reorderedItems.length; i++) {
      const item = reorderedItems[i]
      if ((item.sort_order ?? 0) !== i) {
        await onItemUpdate(item.id, { sort_order: i })
      }
    }
  }, [items, onItemUpdate])

  // Memoized calculations
  const { start: rangeStart, end: rangeEnd } = viewState.dateRange
  const columnWidth = getColumnWidth(viewState.zoom)
  const columns = useMemo(() => generateTimelineColumns(rangeStart, rangeEnd, viewState.zoom), [rangeStart, rangeEnd, viewState.zoom])
  const monthHeaders = useMemo(() => generateMonthHeaders(rangeStart, rangeEnd), [rangeStart, rangeEnd])
  const totalWidth = columns.length * columnWidth

  // Group items - Ensure items are sorted by sort_order first
  const sortedItems = useMemo(() => 
    [...items].sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0)), 
  [items])
  
  const groupedItems = useMemo(() => groupItems(sortedItems, viewState.groupBy), [sortedItems, viewState.groupBy])
  const sortedGroups = useMemo(() => {
    const groups = Array.from(groupedItems.keys())
    // Put "Unassigned" at the end
    return groups.sort((a, b) => {
      if (a === "Unassigned") return 1
      if (b === "Unassigned") return -1
      return a.localeCompare(b)
    })
  }, [groupedItems])

  // Calculate item positions
  const getBarPosition = useCallback((item: ScheduleItem) => {
    const startDate = parseDate(item.start_date)
    const endDate = parseDate(item.end_date)
    
    if (!startDate) return null
    
    const effectiveEnd = endDate || startDate
    const startOffset = differenceInDays(startDate, rangeStart)
    const duration = differenceInDays(effectiveEnd, startDate) + 1
    
    return {
      left: startOffset * columnWidth,
      width: Math.max(duration * columnWidth - 4, columnWidth - 4),
    }
  }, [rangeStart, columnWidth])

  // Handle drag start for items
  const handleDragStart = useCallback((e: React.MouseEvent, item: ScheduleItem, type: "move" | "resize-start" | "resize-end") => {
    e.preventDefault()
    e.stopPropagation()
    
    const startDate = parseDate(item.start_date) || new Date()
    const endDate = parseDate(item.end_date) || startDate
    
    setDragState({
      itemId: item.id,
      type,
      startX: e.clientX,
      startDate,
      endDate,
      originalStart: startDate,
      originalEnd: endDate,
    })
  }, [])

  // Handle drag move for items
  useEffect(() => {
    if (!dragState) return

    const handleMouseMove = (e: MouseEvent) => {
      const deltaX = e.clientX - dragState.startX
      const daysDelta = Math.round(deltaX / columnWidth)
      
      if (daysDelta === 0) return

      let newStart = dragState.originalStart
      let newEnd = dragState.originalEnd

      switch (dragState.type) {
        case "move":
          newStart = dateAddDays(dragState.originalStart, daysDelta)
          newEnd = dateAddDays(dragState.originalEnd, daysDelta)
          break
        case "resize-start":
          newStart = dateAddDays(dragState.originalStart, daysDelta)
          if (newStart >= newEnd) {
            newStart = dateAddDays(newEnd, -1)
          }
          break
        case "resize-end":
          newEnd = dateAddDays(dragState.originalEnd, daysDelta)
          if (newEnd <= newStart) {
            newEnd = dateAddDays(newStart, 1)
          }
          break
      }

      setDragState((prev) => prev ? { ...prev, startDate: newStart, endDate: newEnd } : null)
    }

    const handleMouseUp = async () => {
      if (dragState) {
        const { itemId, startDate, endDate, originalStart, originalEnd } = dragState
        
        // Only update if dates changed
        if (!isSameDay(startDate, originalStart) || !isSameDay(endDate, originalEnd)) {
          await onItemUpdate(itemId, {
            start_date: toDateString(startDate),
            end_date: toDateString(endDate),
          })
        }
      }
      setDragState(null)
    }

    document.addEventListener("mousemove", handleMouseMove)
    document.addEventListener("mouseup", handleMouseUp)

    return () => {
      document.removeEventListener("mousemove", handleMouseMove)
      document.removeEventListener("mouseup", handleMouseUp)
    }
  }, [dragState, columnWidth, onItemUpdate])

  // Get dragged position for item
  const getDraggedPosition = useCallback((item: ScheduleItem) => {
    if (!dragState || dragState.itemId !== item.id) return null
    
    const startOffset = differenceInDays(dragState.startDate, rangeStart)
    const duration = differenceInDays(dragState.endDate, dragState.startDate) + 1
    
    return {
      left: startOffset * columnWidth,
      width: Math.max(duration * columnWidth - 4, columnWidth - 4),
    }
  }, [dragState, rangeStart, columnWidth])

  // Toggle group expansion
  const toggleGroup = useCallback((groupKey: string) => {
    setExpandedGroups((prev) => {
      const next = new Set(prev)
      if (next.has(groupKey)) {
        next.delete(groupKey)
      } else {
        next.add(groupKey)
      }
      return next
    })
  }, [])

  // Sync scroll between header and body
  const handleScroll = useCallback((e: React.UIEvent<HTMLDivElement>) => {
    const target = e.target as HTMLDivElement
    setScrollLeft(target.scrollLeft)
  }, [])

  // Sync sidebar scroll with main scroll
  const handleMainScroll = useCallback((e: React.UIEvent<HTMLDivElement>) => {
    const target = e.target as HTMLDivElement
    if (sidebarRef.current) {
      sidebarRef.current.scrollTop = target.scrollTop
    }
    setScrollLeft(target.scrollLeft)
  }, [])

  // Click to select date range for quick add
  const handleTimelineMouseDown = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    // Only handle left click on empty area
    if (e.button !== 0) return
    const target = e.target as HTMLElement
    if (target.closest('[data-bar]')) return // Clicked on a bar

    const rect = e.currentTarget.getBoundingClientRect()
    const x = e.clientX - rect.left + scrollLeft
    const dayIndex = Math.floor(x / columnWidth)
    
    if (dayIndex >= 0 && dayIndex < columns.length) {
      const clickedDate = columns[dayIndex].date
      setDateSelection({
        startDate: clickedDate,
        endDate: clickedDate,
        startX: x,
        isDragging: true,
      })
    }
  }, [columns, columnWidth, scrollLeft])

  const handleTimelineMouseMove = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    if (!dateSelection?.isDragging) return

    const rect = e.currentTarget.getBoundingClientRect()
    const x = e.clientX - rect.left + scrollLeft
    const dayIndex = Math.floor(x / columnWidth)
    
    if (dayIndex >= 0 && dayIndex < columns.length) {
      const currentDate = columns[dayIndex].date
      // Keep start as the earlier date
      if (currentDate < dateSelection.startDate) {
        setDateSelection(prev => prev ? {
          ...prev,
          startDate: currentDate,
          endDate: prev.startDate,
        } : null)
      } else {
        setDateSelection(prev => prev ? {
          ...prev,
          endDate: currentDate,
        } : null)
      }
    }
  }, [dateSelection, columns, columnWidth, scrollLeft])

  const handleTimelineMouseUp = useCallback(() => {
    if (dateSelection?.isDragging && onQuickAdd) {
      // Ensure start is before end
      const start = dateSelection.startDate < dateSelection.endDate ? dateSelection.startDate : dateSelection.endDate
      const end = dateSelection.startDate < dateSelection.endDate ? dateSelection.endDate : dateSelection.startDate
      onQuickAdd(start, end)
    }
    setDateSelection(null)
  }, [dateSelection, onQuickAdd])

  // Calculate row index for each item
  let currentRowIndex = 0
  const itemRowIndices = new Map<string, number>()
  
  for (const groupKey of sortedGroups) {
    if (viewState.groupBy !== "none") {
      currentRowIndex++ // Group header row
    }
    
    const isExpanded = expandedGroups.has(groupKey) || viewState.groupBy === "none"
    if (isExpanded) {
      const groupItemsList = groupedItems.get(groupKey) || []
      for (const item of groupItemsList) {
        itemRowIndices.set(item.id, currentRowIndex)
        currentRowIndex++
      }
    }
  }

  // Draw dependency lines
  const dependencyLines = useMemo(() => {
    if (!viewState.showDependencies) return []
    
    return dependencies.map((dep) => {
      const fromItem = items.find((i) => i.id === dep.depends_on_item_id)
      const toItem = items.find((i) => i.id === dep.item_id)
      
      if (!fromItem || !toItem) return null
      
      const fromRowIndex = itemRowIndices.get(fromItem.id)
      const toRowIndex = itemRowIndices.get(toItem.id)
      
      if (fromRowIndex === undefined || toRowIndex === undefined) return null
      
      const fromPos = getBarPosition(fromItem)
      const toPos = getBarPosition(toItem)
      
      if (!fromPos || !toPos) return null
      
      const fromX = fromPos.left + fromPos.width
      const fromY = fromRowIndex * GANTT_ROW_HEIGHT + GANTT_ROW_HEIGHT / 2
      const toX = toPos.left
      const toY = toRowIndex * GANTT_ROW_HEIGHT + GANTT_ROW_HEIGHT / 2
      
      return {
        id: dep.id,
        from: { x: fromX, y: fromY },
        to: { x: toX, y: toY },
        type: dep.dependency_type,
        isCritical: fromItem.is_critical_path && toItem.is_critical_path,
      }
    }).filter(Boolean)
  }, [dependencies, items, itemRowIndices, viewState.showDependencies, getBarPosition])

  // Calculate total height
  const totalRows = currentRowIndex || 1
  const totalHeight = Math.max(totalRows * GANTT_ROW_HEIGHT, 200)
  const timelineHeight = Math.max(totalHeight, viewportHeight || 0)

  // Today marker position - use local timezone by constructing date from local components
  const now = new Date()
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const rangeStartLocal = new Date(rangeStart.getFullYear(), rangeStart.getMonth(), rangeStart.getDate())
  const todayOffset = Math.floor((today.getTime() - rangeStartLocal.getTime()) / (1000 * 60 * 60 * 24))
  const todayPosition = todayOffset >= 0 && todayOffset <= columns.length ? todayOffset * columnWidth + columnWidth / 2 : null

  // Scroll to today on mount and when triggered
  useEffect(() => {
    if (!hasScrolledToToday.current && scrollContainerRef.current && todayPosition !== null) {
      const containerWidth = scrollContainerRef.current.clientWidth
      // Center today in view
      const scrollPos = Math.max(0, todayPosition - containerWidth / 2)
      scrollContainerRef.current.scrollLeft = scrollPos
      setScrollLeft(scrollPos)
      hasScrolledToToday.current = true
    }
  }, [todayPosition])

  // Scroll to today when triggered from toolbar
  useEffect(() => {
    if (scrollToTodayTrigger > 0 && scrollContainerRef.current && todayPosition !== null) {
      const containerWidth = scrollContainerRef.current.clientWidth
      // Center today in view with smooth scroll
      const scrollPos = Math.max(0, todayPosition - containerWidth / 2)
      scrollContainerRef.current.scrollTo({ left: scrollPos, behavior: "smooth" })
      setScrollLeft(scrollPos)
    }
  }, [scrollToTodayTrigger, todayPosition])

  // Keep the gantt grid stretched to the available vertical space
  useEffect(() => {
    const el = scrollContainerRef.current
    if (!el) return

    const updateHeight = () => setViewportHeight(el.clientHeight || 0)
    updateHeight()

    const observer = new ResizeObserver(updateHeight)
    observer.observe(el)

    return () => observer.disconnect()
  }, [])

  // Selection highlight position
  const selectionPosition = useMemo(() => {
    if (!dateSelection) return null
    const startIdx = columns.findIndex(c => isSameDay(c.date, dateSelection.startDate))
    const endIdx = columns.findIndex(c => isSameDay(c.date, dateSelection.endDate))
    if (startIdx === -1 || endIdx === -1) return null
    const left = Math.min(startIdx, endIdx) * columnWidth
    const width = (Math.abs(endIdx - startIdx) + 1) * columnWidth
    return { left, width }
  }, [dateSelection, columns, columnWidth])

  return (
    <TooltipProvider>
      <div
        className={cn("flex flex-col h-full overflow-hidden rounded-lg border bg-background w-full max-w-full min-w-0", className)}
        ref={containerRef}
        style={{ maxWidth: "100%" }} // Clamp to parent width
      >
        {/* Timeline Header - Fixed */}
        <div className="flex flex-shrink-0 border-b bg-muted/30 min-w-0">
          {/* Sidebar header */}
          <div 
            className="flex-shrink-0 border-r bg-muted/50 flex items-end px-3 pb-2"
            style={{ width: GANTT_SIDEBAR_WIDTH, minWidth: GANTT_SIDEBAR_WIDTH, height: GANTT_HEADER_HEIGHT }}
          >
            <span className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Task</span>
          </div>
          
          {/* Timeline header - scrolls horizontally */}
          <div className="flex-1 overflow-hidden min-w-0" style={{ maxWidth: '100%' }}>
            <div 
              className="overflow-hidden w-full"
            >
              <div 
                className="will-change-transform"
                style={{ 
                  width: totalWidth, 
                  height: GANTT_HEADER_HEIGHT,
                  transform: `translateX(-${scrollLeft}px)`,
                }}
              >
                {/* Month row */}
                <div className="flex h-7 border-b border-border/50">
                  {monthHeaders.map((month, i) => (
                    <div
                      key={i}
                      className="flex items-center justify-center text-xs font-medium text-muted-foreground border-r border-border/30"
                      style={{ width: month.span * columnWidth }}
                    >
                      {month.label}
                    </div>
                  ))}
                </div>
                
                {/* Day row */}
                <div className="flex h-8">
                  {columns.map((col, i) => (
                    <div
                      key={i}
                      className={cn(
                        "flex items-center justify-center text-xs border-r border-border/20 cursor-pointer hover:bg-primary/5 transition-colors",
                        col.isToday && "bg-primary/10 text-primary font-semibold",
                        col.isWeekend && !col.isToday && "bg-muted/50 text-muted-foreground"
                      )}
                      style={{ width: columnWidth, minWidth: columnWidth }}
                    >
                      {col.label}
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Main content area */}
        <div className="flex flex-1 overflow-hidden min-h-0 min-w-0">
          {/* Sidebar - scrolls vertically only */}
          <div 
            ref={sidebarRef}
            className="flex-shrink-0 border-r overflow-y-auto overflow-x-hidden"
            style={{ width: GANTT_SIDEBAR_WIDTH, minWidth: GANTT_SIDEBAR_WIDTH }}
          >
            <DndContext
              sensors={sensors}
              collisionDetection={closestCenter}
              onDragEnd={handleDragEnd}
            >
              <div style={{ minHeight: timelineHeight }}>
                {sortedGroups.map((groupKey) => {
                  const groupItemsList = groupedItems.get(groupKey) || []
                  const isExpanded = expandedGroups.has(groupKey) || viewState.groupBy === "none"
                  const itemIds = groupItemsList.map(item => item.id)
                  
                  return (
                    <div key={groupKey}>
                      {/* Group header */}
                      {viewState.groupBy !== "none" && (
                        <div
                          className="flex items-center gap-2 px-3 bg-muted/30 border-b cursor-pointer hover:bg-muted/50 transition-colors"
                          style={{ height: GANTT_ROW_HEIGHT }}
                          onClick={() => toggleGroup(groupKey)}
                        >
                          <Button variant="ghost" size="icon" className="h-5 w-5 p-0">
                            {isExpanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                          </Button>
                          <div
                            className="w-3 h-3 rounded-full flex-shrink-0"
                            style={{ backgroundColor: PHASE_COLORS[groupKey] || "#64748b" }}
                          />
                          <span className="text-sm font-medium capitalize truncate">
                            {groupKey.replace(/_/g, " ")}
                          </span>
                          <Badge variant="secondary" className="ml-auto text-xs flex-shrink-0">
                            {groupItemsList.length}
                          </Badge>
                        </div>
                      )}
                      
                      {/* Items - Sortable */}
                      {isExpanded && (
                        <SortableContext items={itemIds} strategy={verticalListSortingStrategy}>
                          {groupItemsList.map((item) => (
                            <SortableTaskRow
                              key={item.id}
                              item={item}
                              isSelected={selectedItem?.id === item.id}
                              onSelect={setSelectedItem}
                            />
                          ))}
                        </SortableContext>
                      )}
                    </div>
                  )
                })}
              
              {/* Empty state */}
                {items.length === 0 && (
                  <div className="flex flex-col items-center justify-center py-12 px-4 text-center">
                    <div className="w-12 h-12 rounded-full bg-muted flex items-center justify-center mb-3">
                      <Plus className="h-6 w-6 text-muted-foreground" />
                    </div>
                    <p className="text-sm text-muted-foreground">No schedule items yet</p>
                    <p className="text-xs text-muted-foreground mt-1">Click "Add Item" or drag on the timeline</p>
                  </div>
                )}
              </div>
            </DndContext>
          </div>

          {/* Timeline grid - scrolls both directions */}
          <div
            ref={scrollContainerRef}
            className="flex-1 overflow-auto min-w-0"
            style={{ maxWidth: '100%' }} // Ensure scroll container doesn't exceed parent width
            onScroll={handleMainScroll}
            onMouseDown={handleTimelineMouseDown}
            onMouseMove={handleTimelineMouseMove}
            onMouseUp={handleTimelineMouseUp}
            onMouseLeave={handleTimelineMouseUp}
          >
            <div
              className="relative"
              style={{
                width: totalWidth,
                minWidth: totalWidth,
                height: timelineHeight,
                minHeight: timelineHeight,
              }}
            >
              {/* Background grid */}
              <div className="absolute inset-0 pointer-events-none">
                {columns.map((col, i) => (
                  <div
                    key={i}
                    className={cn(
                      "absolute top-0 bottom-0 border-r border-border/10",
                      col.isWeekend && "bg-muted/20"
                    )}
                    style={{ left: i * columnWidth, width: columnWidth }}
                  />
                ))}
              </div>

              {/* Date selection highlight */}
              {selectionPosition && (
                <div
                  className="absolute top-0 bottom-0 bg-primary/10 border-x-2 border-primary/30 pointer-events-none z-5"
                  style={{ left: selectionPosition.left, width: selectionPosition.width }}
                >
                  <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 bg-primary text-primary-foreground px-2 py-1 rounded text-xs font-medium shadow-lg">
                    <Plus className="h-3 w-3 inline mr-1" />
                    {format(dateSelection!.startDate, "MMM d")}
                    {!isSameDay(dateSelection!.startDate, dateSelection!.endDate) && 
                      ` – ${format(dateSelection!.endDate, "MMM d")}`
                    }
                  </div>
                </div>
              )}

              {/* Today marker */}
              {todayPosition !== null && (
                <div
                  className="absolute top-0 bottom-0 w-0.5 bg-primary z-20 pointer-events-none"
                  style={{ left: todayPosition }}
                >
                  <div className="absolute -top-1 left-1/2 -translate-x-1/2 w-2 h-2 rounded-full bg-primary" />
                </div>
              )}

              {/* Dependency lines (SVG overlay) */}
              {viewState.showDependencies && dependencyLines.length > 0 && (
                <svg 
                  className="absolute inset-0 pointer-events-none z-10" 
                  style={{ width: totalWidth, height: timelineHeight }}
                >
                  <defs>
                    <marker
                      id="arrowhead"
                      markerWidth="8"
                      markerHeight="6"
                      refX="8"
                      refY="3"
                      orient="auto"
                    >
                      <polygon
                        points="0 0, 8 3, 0 6"
                        className="fill-muted-foreground/50"
                      />
                    </marker>
                    <marker
                      id="arrowhead-critical"
                      markerWidth="8"
                      markerHeight="6"
                      refX="8"
                      refY="3"
                      orient="auto"
                    >
                      <polygon
                        points="0 0, 8 3, 0 6"
                        className="fill-orange-500/70"
                      />
                    </marker>
                  </defs>
                  {dependencyLines.map((line: any) => {
                    if (!line) return null
                    
                    const dx = line.to.x - line.from.x
                    const controlOffset = Math.min(Math.abs(dx) / 3, 50)
                    
                    const path = `M ${line.from.x} ${line.from.y} 
                      C ${line.from.x + controlOffset} ${line.from.y}, 
                        ${line.to.x - controlOffset} ${line.to.y}, 
                        ${line.to.x} ${line.to.y}`
                    
                    return (
                      <path
                        key={line.id}
                        d={path}
                        fill="none"
                        className={cn(
                          "stroke-[1.5]",
                          line.isCritical ? "stroke-orange-500/70" : "stroke-muted-foreground/30"
                        )}
                        markerEnd={line.isCritical ? "url(#arrowhead-critical)" : "url(#arrowhead)"}
                      />
                    )
                  })}
                </svg>
              )}

              {/* Row backgrounds */}
              {sortedGroups.map((groupKey) => {
                const groupItemsList = groupedItems.get(groupKey) || []
                const isExpanded = expandedGroups.has(groupKey) || viewState.groupBy === "none"
                
                if (!isExpanded) return null
                
                return groupItemsList.map((item) => {
                  const rowIndex = itemRowIndices.get(item.id)
                  if (rowIndex === undefined) return null
                  
                  return (
                    <div
                      key={`row-${item.id}`}
                      className={cn(
                        "absolute left-0 right-0 border-b border-border/5",
                        selectedItem?.id === item.id && "bg-primary/5"
                      )}
                      style={{
                        top: rowIndex * GANTT_ROW_HEIGHT,
                        height: GANTT_ROW_HEIGHT,
                      }}
                    />
                  )
                })
              })}

              {/* Task bars */}
              {sortedGroups.map((groupKey) => {
                const groupItemsList = groupedItems.get(groupKey) || []
                const isExpanded = expandedGroups.has(groupKey) || viewState.groupBy === "none"
                
                if (!isExpanded) return null
                
                return groupItemsList.map((item) => {
                  const rowIndex = itemRowIndices.get(item.id)
                  if (rowIndex === undefined) return null
                  
                  const position = dragState?.itemId === item.id 
                    ? getDraggedPosition(item) 
                    : getBarPosition(item)
                  
                  if (!position) return null
                  
                  const isMilestone = item.item_type === "milestone"
                  const isSelected = selectedItem?.id === item.id
                  const isDragging = dragState?.itemId === item.id
                  const barColor = item.color || PHASE_COLORS[item.phase || ""] || "#3b82f6"
                  const progress = item.progress || 0
                  
                  const top = rowIndex * GANTT_ROW_HEIGHT + GANTT_BAR_PADDING
                  
                  if (isMilestone) {
                    return (
                      <Tooltip key={item.id}>
                        <TooltipTrigger asChild>
                          <div
                            data-bar
                            className={cn(
                              "absolute cursor-pointer z-10",
                              "transition-all duration-200 ease-out",
                              "hover:scale-125 hover:shadow-lg",
                              isSelected && "ring-2 ring-primary ring-offset-2 scale-125",
                              isDragging && "opacity-80 scale-150 shadow-xl z-50"
                            )}
                            style={{
                              left: position.left + position.width / 2 - GANTT_MILESTONE_SIZE / 2,
                              top: top + (GANTT_BAR_HEIGHT - GANTT_MILESTONE_SIZE) / 2,
                              width: GANTT_MILESTONE_SIZE,
                              height: GANTT_MILESTONE_SIZE,
                              backgroundColor: barColor,
                              transform: "rotate(45deg)",
                              transformOrigin: "center center",
                            }}
                            onClick={(e) => {
                              e.stopPropagation()
                              setSelectedItem(item)
                              onEditItem?.(item)
                            }}
                            onMouseDown={(e) => handleDragStart(e, item, "move")}
                          />
                        </TooltipTrigger>
                        <TooltipContent>
                          <div className="text-sm font-medium">{item.name}</div>
                          <div className="text-xs text-muted-foreground">
                            {item.start_date && format(parseDate(item.start_date)!, "MMM d, yyyy")}
                          </div>
                        </TooltipContent>
                      </Tooltip>
                    )
                  }
                  
                  return (
                    <Tooltip key={item.id}>
                      <TooltipTrigger asChild>
                        <div
                          data-bar
                          className={cn(
                            "absolute rounded-md cursor-pointer group z-10",
                            "shadow-sm hover:shadow-lg hover:scale-[1.02] hover:-translate-y-0.5",
                            "transition-all duration-200 ease-out",
                            isSelected && "ring-2 ring-primary ring-offset-1 scale-[1.02]",
                            isDragging && "opacity-80 shadow-xl scale-105 z-50",
                            item.is_critical_path && "ring-1 ring-orange-500/70"
                          )}
                          style={{
                            left: position.left,
                            top,
                            width: position.width,
                            height: GANTT_BAR_HEIGHT,
                            backgroundColor: barColor,
                            transformOrigin: "center center",
                          }}
                          onClick={(e) => {
                            e.stopPropagation()
                            setSelectedItem(item)
                            onEditItem?.(item)
                          }}
                          onMouseDown={(e) => handleDragStart(e, item, "move")}
                        >
                          {/* Progress fill */}
                          {progress > 0 && (
                            <div
                              className="absolute inset-y-0 left-0 rounded-l-md bg-black/20"
                              style={{ width: `${progress}%` }}
                            />
                          )}
                          
                          {/* Content */}
                          <div className="relative h-full flex items-center px-2 overflow-hidden">
                            <span className="text-xs font-medium text-white truncate drop-shadow-sm">
                              {item.name}
                            </span>
                            {progress > 0 && progress < 100 && (
                              <span className="ml-auto text-xs text-white/80 font-medium flex-shrink-0">
                                {progress}%
                              </span>
                            )}
                          </div>
                          
                          {/* Resize handles */}
                          <div
                            className={cn(
                              "absolute left-0 top-0 bottom-0 w-2 cursor-ew-resize rounded-l-md",
                              "bg-white/0 group-hover:bg-white/40",
                              "transition-all duration-150",
                              "hover:!bg-white/60 hover:w-3"
                            )}
                            onMouseDown={(e) => handleDragStart(e, item, "resize-start")}
                          />
                          <div
                            className={cn(
                              "absolute right-0 top-0 bottom-0 w-2 cursor-ew-resize rounded-r-md",
                              "bg-white/0 group-hover:bg-white/40",
                              "transition-all duration-150",
                              "hover:!bg-white/60 hover:w-3"
                            )}
                            onMouseDown={(e) => handleDragStart(e, item, "resize-end")}
                          />
                        </div>
                      </TooltipTrigger>
                      <TooltipContent side="top" className="max-w-xs">
                        <div className="space-y-1">
                          <div className="font-medium">{item.name}</div>
                          <div className="text-xs text-muted-foreground flex items-center gap-2">
                            <span className="capitalize">{item.item_type}</span>
                            {item.trade && (
                              <>
                                <span>•</span>
                                <span className="capitalize">{item.trade.replace(/_/g, " ")}</span>
                              </>
                            )}
                          </div>
                          {item.start_date && (
                            <div className="text-xs">
                              {format(parseDate(item.start_date)!, "MMM d")}
                              {item.end_date && ` – ${format(parseDate(item.end_date)!, "MMM d, yyyy")}`}
                            </div>
                          )}
                          {progress > 0 && (
                            <div className="pt-1">
                              <Progress value={progress} className="h-1.5" />
                            </div>
                          )}
                        </div>
                      </TooltipContent>
                    </Tooltip>
                  )
                })
              })}
            </div>
          </div>
        </div>
      </div>
    </TooltipProvider>
  )
}
