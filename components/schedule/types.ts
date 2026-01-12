import type { ScheduleItem, ScheduleDependency, ScheduleAssignment, ScheduleBaseline } from "@/lib/types"

// View types (List view removed - redundant with Gantt)
export type ScheduleViewType = "gantt" | "lookahead"

// Zoom levels for Gantt
export type GanttZoomLevel = "day" | "week" | "month" | "quarter"

// Grouping options
export type GroupByOption = "none" | "phase" | "trade" | "assignee" | "status"

// Schedule view state
export interface ScheduleViewState {
  view: ScheduleViewType
  zoom: GanttZoomLevel
  groupBy: GroupByOption
  showBaseline: boolean
  showDependencies: boolean
  showCriticalPath: boolean
  showWeekends: boolean
  dateRange: {
    start: Date
    end: Date
  }
  selectedItemId: string | null
  hoveredItemId: string | null
  expandedGroups: Set<string>
}

// Gantt specific types
export interface GanttRow {
  id: string
  item: ScheduleItem
  level: number
  isGroupHeader?: boolean
  groupKey?: string
  children?: GanttRow[]
}

export interface GanttBarPosition {
  left: number
  width: number
  top: number
  height: number
}

export interface DependencyLine {
  id: string
  from: { x: number; y: number }
  to: { x: number; y: number }
  type: "FS" | "SS" | "FF" | "SF"
  isCritical?: boolean
}

// Drag state
export interface DragState {
  itemId: string
  type: "move" | "resize-start" | "resize-end"
  startX: number
  startDate: Date
  endDate: Date
  originalStart: Date
  originalEnd: Date
}

// Schedule context
export interface ScheduleContextValue {
  // Data
  items: ScheduleItem[]
  dependencies: ScheduleDependency[]
  assignments: ScheduleAssignment[]
  baselines: ScheduleBaseline[]
  activeBaseline: ScheduleBaseline | null
  
  // View state
  viewState: ScheduleViewState
  setViewState: (state: Partial<ScheduleViewState>) => void
  
  // Selection
  selectedItem: ScheduleItem | null
  setSelectedItem: (item: ScheduleItem | null) => void
  
  // Actions
  onItemUpdate: (id: string, updates: Partial<ScheduleItem>) => Promise<ScheduleItem>
  onItemCreate: (item: Partial<ScheduleItem>) => Promise<ScheduleItem>
  onItemDelete: (id: string) => Promise<void>
  onDependencyCreate: (from: string, to: string, type?: string) => Promise<void>
  onDependencyDelete: (id: string) => Promise<void>
  
  // Navigation
  scrollToToday: () => void
  scrollToTodayTrigger: number
  
  // UI state
  isLoading: boolean
  error: string | null
}

// Constants
export const GANTT_ROW_HEIGHT = 40
export const GANTT_HEADER_HEIGHT = 60
export const GANTT_SIDEBAR_WIDTH = 300
export const GANTT_MIN_COL_WIDTH = 40
export const GANTT_BAR_HEIGHT = 28
export const GANTT_BAR_PADDING = 6
export const GANTT_MILESTONE_SIZE = 16

// Animation constants
export const ANIMATION = {
  fast: "150ms",
  normal: "200ms",
  slow: "300ms",
  spring: "cubic-bezier(0.34, 1.56, 0.64, 1)",
  ease: "cubic-bezier(0.4, 0, 0.2, 1)",
  easeOut: "cubic-bezier(0, 0, 0.2, 1)",
  easeIn: "cubic-bezier(0.4, 0, 1, 1)",
}

// Colors with improved dark mode support
export const STATUS_COLORS: Record<string, {
  bg: string
  text: string
  border: string
  ganttBar: string
  ganttProgress: string
  pdfColor: string
}> = {
  planned: {
    bg: "bg-slate-100 dark:bg-slate-800/60",
    text: "text-slate-600 dark:text-slate-300",
    border: "border-slate-300 dark:border-slate-600",
    ganttBar: "bg-slate-200 dark:bg-slate-700",
    ganttProgress: "bg-slate-400 dark:bg-slate-500",
    pdfColor: "#94a3b8",
  },
  in_progress: {
    bg: "bg-blue-50 dark:bg-blue-950/40",
    text: "text-blue-700 dark:text-blue-300",
    border: "border-blue-200 dark:border-blue-800",
    ganttBar: "bg-blue-100 dark:bg-blue-900/50",
    ganttProgress: "bg-blue-500 dark:bg-blue-400",
    pdfColor: "#3b82f6",
  },
  at_risk: {
    bg: "bg-amber-50 dark:bg-amber-950/40",
    text: "text-amber-700 dark:text-amber-300",
    border: "border-amber-200 dark:border-amber-800",
    ganttBar: "bg-amber-100 dark:bg-amber-900/50",
    ganttProgress: "bg-amber-500 dark:bg-amber-400",
    pdfColor: "#f59e0b",
  },
  blocked: {
    bg: "bg-red-50 dark:bg-red-950/40",
    text: "text-red-700 dark:text-red-300",
    border: "border-red-200 dark:border-red-800",
    ganttBar: "bg-red-100 dark:bg-red-900/50",
    ganttProgress: "bg-red-500 dark:bg-red-400",
    pdfColor: "#ef4444",
  },
  completed: {
    bg: "bg-emerald-50 dark:bg-emerald-950/40",
    text: "text-emerald-700 dark:text-emerald-300",
    border: "border-emerald-200 dark:border-emerald-800",
    ganttBar: "bg-emerald-100 dark:bg-emerald-900/50",
    ganttProgress: "bg-emerald-500 dark:bg-emerald-400",
    pdfColor: "#10b981",
  },
  cancelled: {
    bg: "bg-gray-50 dark:bg-gray-900/60",
    text: "text-gray-500 dark:text-gray-400",
    border: "border-gray-200 dark:border-gray-700",
    ganttBar: "bg-gray-100 dark:bg-gray-800",
    ganttProgress: "bg-gray-400 dark:bg-gray-600",
    pdfColor: "#6b7280",
  },
}

export const ITEM_TYPE_ICONS: Record<string, string> = {
  task: "CheckSquare",
  milestone: "Flag",
  inspection: "ClipboardCheck",
  handoff: "ArrowRightLeft",
  phase: "Layers",
  delivery: "Truck",
}

export const PHASE_COLORS: Record<string, string> = {
  pre_construction: "#8b5cf6",
  site_work: "#f97316",
  foundation: "#64748b",
  framing: "#eab308",
  roofing: "#22c55e",
  mep_rough: "#3b82f6",
  insulation: "#ec4899",
  drywall: "#06b6d4",
  finishes: "#8b5cf6",
  mep_trim: "#3b82f6",
  landscaping: "#22c55e",
  punch_list: "#f97316",
  closeout: "#64748b",
}

// Utility functions
export function getDatesBetween(start: Date, end: Date): Date[] {
  const dates: Date[] = []
  const current = new Date(start)
  while (current <= end) {
    dates.push(new Date(current))
    current.setDate(current.getDate() + 1)
  }
  return dates
}

export function getWeeksBetween(start: Date, end: Date): { start: Date; end: Date }[] {
  const weeks: { start: Date; end: Date }[] = []
  const current = new Date(start)
  // Adjust to Monday
  current.setDate(current.getDate() - current.getDay() + 1)
  
  while (current <= end) {
    const weekStart = new Date(current)
    const weekEnd = new Date(current)
    weekEnd.setDate(weekEnd.getDate() + 6)
    weeks.push({ start: weekStart, end: weekEnd })
    current.setDate(current.getDate() + 7)
  }
  return weeks
}

export function getMonthsBetween(start: Date, end: Date): { start: Date; end: Date; label: string }[] {
  const months: { start: Date; end: Date; label: string }[] = []
  const current = new Date(start.getFullYear(), start.getMonth(), 1)
  
  while (current <= end) {
    const monthStart = new Date(current)
    const monthEnd = new Date(current.getFullYear(), current.getMonth() + 1, 0)
    months.push({
      start: monthStart,
      end: monthEnd,
      label: current.toLocaleDateString("en-US", { month: "short", year: "numeric" }),
    })
    current.setMonth(current.getMonth() + 1)
  }
  return months
}

export function daysBetween(start: Date, end: Date): number {
  const diffTime = end.getTime() - start.getTime()
  return Math.ceil(diffTime / (1000 * 60 * 60 * 24))
}

export function addDays(date: Date, days: number): Date {
  const result = new Date(date)
  result.setDate(result.getDate() + days)
  return result
}

export function isWeekend(date: Date): boolean {
  const day = date.getDay()
  return day === 0 || day === 6
}

export function formatDate(date: Date, format: "short" | "medium" | "long" = "medium"): string {
  const options: Intl.DateTimeFormatOptions = 
    format === "short" ? { month: "numeric", day: "numeric" } :
    format === "medium" ? { month: "short", day: "numeric" } :
    { month: "long", day: "numeric", year: "numeric" }
  return date.toLocaleDateString("en-US", options)
}

export function parseDate(dateString?: string): Date | null {
  if (!dateString) return null
  const date = new Date(dateString)
  return isNaN(date.getTime()) ? null : date
}

export function toDateString(date: Date): string {
  return date.toISOString().split("T")[0]
}
