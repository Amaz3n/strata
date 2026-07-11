"use client"

import { createContext, useContext, useState, useCallback, useMemo, useEffect, type ReactNode } from "react"
import { startOfDay } from "date-fns"
import type { ScheduleItem, ScheduleDependency, ScheduleAssignment, ScheduleBaseline } from "@/lib/types"
import type {
  ScheduleContextValue,
  ScheduleViewState,
  ScheduleViewType,
  GanttZoomLevel,
  GroupByOption,
  ScheduleBulkItemUpdate,
} from "./types"
import { addDays, parseDate } from "./types"
import { useIsMobile } from "@/hooks/use-mobile"

// The timeline's natural span: the window that fits every scheduled item.
// Floor is today ±6 months (so a sparse/empty schedule still shows a sensible
// window); we then extend it, with padding, to include any item whose dates
// fall outside that floor. Pure — derived from items, no state.
function computeContentBounds(items: ScheduleItem[]): { start: Date; end: Date } {
  let start = startOfDay(addDays(new Date(), -180)) // 6 months back
  let end = startOfDay(addDays(new Date(), 180)) // 6 months forward

  for (const item of items) {
    const itemStart = parseDate(item.start_date)
    const itemEnd = parseDate(item.end_date) ?? itemStart
    if (itemStart && itemStart < start) start = startOfDay(addDays(itemStart, -14))
    if (itemEnd && itemEnd > end) end = startOfDay(addDays(itemEnd, 14))
  }

  return { start, end }
}

// dateRange in viewState is derived (content bounds unless the user has panned),
// so the placeholder here is only a type-level default and is always overridden
// by the provider before being exposed.
const defaultViewState: ScheduleViewState = {
  view: "gantt",
  zoom: "week",
  groupBy: "none", // Default to no grouping for cleaner initial view
  showBaseline: false,
  showDependencies: true,
  showCriticalPath: true,
  showWeekends: false,
  dateRange: { start: startOfDay(addDays(new Date(), -180)), end: startOfDay(addDays(new Date(), 180)) },
  selectedItemId: null,
  hoveredItemId: null,
  expandedGroups: new Set(),
}

const ScheduleContext = createContext<ScheduleContextValue | null>(null)

export function useSchedule() {
  const context = useContext(ScheduleContext)
  if (!context) {
    throw new Error("useSchedule must be used within a ScheduleProvider")
  }
  return context
}

interface ScheduleProviderProps {
  children: ReactNode
  initialItems: ScheduleItem[]
  initialDependencies?: ScheduleDependency[]
  initialAssignments?: ScheduleAssignment[]
  initialBaselines?: ScheduleBaseline[]
  onItemUpdate?: (id: string, updates: Partial<ScheduleItem>) => Promise<ScheduleItem>
  onItemsBulkUpdate?: (updates: ScheduleBulkItemUpdate[]) => Promise<ScheduleItem[]>
  onItemCreate?: (item: Partial<ScheduleItem>) => Promise<ScheduleItem>
  onItemDelete?: (id: string) => Promise<void>
  onDependencyCreate?: (from: string, to: string, type?: ScheduleDependency["dependency_type"], lagDays?: number) => Promise<ScheduleDependency>
  onDependencyUpdate?: (id: string, type: ScheduleDependency["dependency_type"], lagDays: number) => Promise<ScheduleDependency>
  onDependencyDelete?: (id: string) => Promise<void>
}

export function ScheduleProvider({
  children,
  initialItems,
  initialDependencies = [],
  initialAssignments = [],
  initialBaselines = [],
  onItemUpdate,
  onItemsBulkUpdate,
  onItemCreate,
  onItemDelete,
  onDependencyCreate,
  onDependencyUpdate,
  onDependencyDelete,
}: ScheduleProviderProps) {
  const isMobile = useIsMobile()
  const [items, setItems] = useState<ScheduleItem[]>(initialItems)
  const [dependencies, setDependencies] = useState<ScheduleDependency[]>(initialDependencies)
  const [assignments] = useState<ScheduleAssignment[]>(initialAssignments)
  const [baselines] = useState<ScheduleBaseline[]>(initialBaselines)
  const [viewStateInternal, setViewStateInternal] = useState<ScheduleViewState>(defaultViewState)
  // The visible timeline range. `null` means "follow the schedule" — derive it
  // from item dates (computeContentBounds). Once the user pans/zooms/jumps, we
  // store their explicit window here and stop auto-following, so adding an item
  // elsewhere never yanks their viewport. "Fit to schedule" clears it back to null.
  const [userRange, setUserRange] = useState<{ start: Date; end: Date } | null>(null)
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [scrollToTodayTrigger, setScrollToTodayTrigger] = useState(0)

  // Natural span of the schedule, recomputed only when items change.
  const contentBounds = useMemo(() => computeContentBounds(items), [items])

  // The range actually shown: the user's explicit window if they've navigated,
  // otherwise the auto-fitting content bounds.
  const dateRange = userRange ?? contentBounds

  // Exposed view state, with the derived range merged in.
  const viewState = useMemo<ScheduleViewState>(
    () => ({ ...viewStateInternal, dateRange }),
    [viewStateInternal, dateRange],
  )

  // Force lookahead view on mobile
  useEffect(() => {
    if (isMobile && viewStateInternal.view !== "lookahead") {
      setViewStateInternal((prev) => ({ ...prev, view: "lookahead" }))
    }
  }, [isMobile, viewStateInternal.view])

  // Scroll to today function
  const scrollToToday = useCallback(() => {
    setScrollToTodayTrigger((prev) => prev + 1)
  }, [])

  // Snap the timeline back to fitting the whole schedule (clears manual panning).
  const fitToSchedule = useCallback(() => {
    setUserRange(null)
  }, [])

  // Keep local items aligned with parent-provided items (e.g. filter/project
  // changes). The visible range follows automatically via contentBounds unless
  // the user has taken manual control — no range bookkeeping needed here.
  useEffect(() => {
    setItems(initialItems)
  }, [initialItems])

  // Active baseline
  const activeBaseline = useMemo(() => {
    return baselines.find((b) => b.is_active) ?? null
  }, [baselines])

  // Selected item
  const selectedItem = useMemo(() => {
    if (!viewStateInternal.selectedItemId) return null
    return items.find((i) => i.id === viewStateInternal.selectedItemId) ?? null
  }, [items, viewStateInternal.selectedItemId])

  // Set view state. A dateRange update is the user taking manual control of the
  // timeline window, so it's routed to the override rather than the (derived)
  // viewState; everything else updates view state normally.
  const setViewState = useCallback((updates: Partial<ScheduleViewState>) => {
    const { dateRange: nextRange, ...rest } = updates
    if (nextRange) setUserRange(nextRange)
    if (Object.keys(rest).length > 0) {
      setViewStateInternal((prev) => ({ ...prev, ...rest }))
    }
  }, [])

  // Set selected item
  const setSelectedItem = useCallback((item: ScheduleItem | null) => {
    setViewState({ selectedItemId: item?.id ?? null })
  }, [setViewState])

  // Handle item update
  const handleItemUpdate = useCallback(async (id: string, updates: Partial<ScheduleItem>) => {
    const originalItem = items.find(i => i.id === id)
    
    // Optimistic update
    setItems((prev) => prev.map((item) => (item.id === id ? { ...item, ...updates } : item)))

    setIsLoading(true)
    setError(null)
    try {
      if (onItemUpdate) {
        const updated = await onItemUpdate(id, updates)
        setItems((prev) => prev.map((item) => (item.id === id ? updated : item)))
        return updated
      }
      const fallback = items.find((i) => i.id === id) ?? originalItem
      if (!fallback) throw new Error("Schedule item not found")
      return { ...fallback, ...updates }
    } catch (err) {
      // Rollback on error
      if (originalItem) {
        setItems((prev) => prev.map((item) => (item.id === id ? originalItem! : item)))
      }
      setError(err instanceof Error ? err.message : "Failed to update item")
      throw err
    } finally {
      setIsLoading(false)
    }
  }, [items, onItemUpdate])

  // Handle bulk item updates
  const handleItemsBulkUpdate = useCallback(async (updates: ScheduleBulkItemUpdate[]) => {
    if (updates.length === 0) return []

    const originalItems = items
    const updatesById = new Map(updates.map((update) => [update.id, update]))

    // Optimistic update
    setItems((prev) =>
      prev.map((item) => {
        const update = updatesById.get(item.id)
        return update ? { ...item, ...update } : item
      })
    )

    setIsLoading(true)
    setError(null)
    try {
      if (onItemsBulkUpdate) {
        const updatedItems = await onItemsBulkUpdate(updates)
        if (updatedItems.length > 0) {
          const updatedMap = new Map(updatedItems.map((item) => [item.id, item]))
          setItems((prev) => prev.map((item) => updatedMap.get(item.id) ?? item))
        }
        return updatedItems
      }

      if (!onItemUpdate) {
        return updates
          .map((update) => {
            const item = originalItems.find((original) => original.id === update.id)
            return item ? { ...item, ...update } : null
          })
          .filter((item): item is ScheduleItem => item !== null)
      }

      const updatedItems = await Promise.all(
        updates.map((update) => {
          const { id, ...rest } = update
          return onItemUpdate(id, rest)
        })
      )

      const updatedMap = new Map(updatedItems.map((item) => [item.id, item]))
      setItems((prev) => prev.map((item) => updatedMap.get(item.id) ?? item))
      return updatedItems
    } catch (err) {
      setItems(originalItems)
      setError(err instanceof Error ? err.message : "Failed to update items")
      throw err
    } finally {
      setIsLoading(false)
    }
  }, [items, onItemsBulkUpdate, onItemUpdate])

  // Handle item create
  const handleItemCreate = useCallback(async (item: Partial<ScheduleItem>) => {
    setIsLoading(true)
    setError(null)
    try {
      if (onItemCreate) {
        const created = await onItemCreate(item)
        setItems((prev) => [...prev, created])
        return created
      }
      throw new Error("Create is not configured")
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create item")
      throw err
    } finally {
      setIsLoading(false)
    }
  }, [onItemCreate])

  // Handle item delete
  const handleItemDelete = useCallback(async (id: string) => {
    setIsLoading(true)
    setError(null)
    try {
      if (onItemDelete) {
        await onItemDelete(id)
      }
      setItems((prev) => prev.filter((item) => item.id !== id))
      // Also remove any dependencies
      setDependencies((prev) => prev.filter((d) => d.item_id !== id && d.depends_on_item_id !== id))
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to delete item")
      throw err
    } finally {
      setIsLoading(false)
    }
  }, [onItemDelete])

  // Handle dependency create
  const handleDependencyCreate = useCallback(async (from: string, to: string, type: ScheduleDependency["dependency_type"] = "FS", lagDays = 0) => {
    setIsLoading(true)
    setError(null)
    try {
      if (onDependencyCreate) {
        const created = await onDependencyCreate(from, to, type, lagDays)
        setDependencies((prev) => [...prev, created])
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create dependency")
      throw err
    } finally {
      setIsLoading(false)
    }
  }, [onDependencyCreate])

  const handleDependencyUpdate = useCallback(async (id: string, type: ScheduleDependency["dependency_type"], lagDays: number) => {
    setIsLoading(true)
    setError(null)
    try {
      if (!onDependencyUpdate) throw new Error("Dependency editing is not configured")
      const updated = await onDependencyUpdate(id, type, lagDays)
      setDependencies((current) => current.map((dependency) => dependency.id === id ? updated : dependency))
      return updated
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to update dependency")
      throw err
    } finally { setIsLoading(false) }
  }, [onDependencyUpdate])

  // Handle dependency delete
  const handleDependencyDelete = useCallback(async (id: string) => {
    setIsLoading(true)
    setError(null)
    try {
      if (onDependencyDelete) {
        await onDependencyDelete(id)
      }
      setDependencies((prev) => prev.filter((d) => d.id !== id))
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to delete dependency")
      throw err
    } finally {
      setIsLoading(false)
    }
  }, [onDependencyDelete])

  const value: ScheduleContextValue = useMemo(() => ({
    items,
    dependencies,
    assignments,
    baselines,
    activeBaseline,
    viewState,
    setViewState,
    selectedItem,
    setSelectedItem,
    onItemUpdate: handleItemUpdate,
    onItemsBulkUpdate: handleItemsBulkUpdate,
    onItemCreate: handleItemCreate,
    onItemDelete: handleItemDelete,
    onDependencyCreate: handleDependencyCreate,
    onDependencyUpdate: handleDependencyUpdate,
    onDependencyDelete: handleDependencyDelete,
    scrollToToday,
    scrollToTodayTrigger,
    fitToSchedule,
    isFollowingSchedule: userRange === null,
    isLoading,
    error,
  }), [
    items,
    dependencies,
    assignments,
    baselines,
    activeBaseline,
    viewState,
    setViewState,
    selectedItem,
    setSelectedItem,
    handleItemUpdate,
    handleItemsBulkUpdate,
    handleItemCreate,
    handleItemDelete,
    handleDependencyCreate,
    handleDependencyUpdate,
    handleDependencyDelete,
    scrollToToday,
    scrollToTodayTrigger,
    fitToSchedule,
    userRange,
    isLoading,
    error,
  ])

  return (
    <ScheduleContext.Provider value={value}>
      {children}
    </ScheduleContext.Provider>
  )
}
