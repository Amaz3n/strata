"use client"

import { createContext, useContext, useState, useCallback, useMemo, type ReactNode } from "react"
import type { ScheduleItem, ScheduleDependency, ScheduleAssignment, ScheduleBaseline } from "@/lib/types"
import type { ScheduleContextValue, ScheduleViewState, ScheduleViewType, GanttZoomLevel, GroupByOption } from "./types"
import { addDays } from "./types"

const defaultViewState: ScheduleViewState = {
  view: "gantt",
  zoom: "week",
  groupBy: "none", // Default to no grouping for cleaner initial view
  showBaseline: false,
  showDependencies: true,
  showCriticalPath: true,
  showWeekends: false,
  dateRange: {
    start: addDays(new Date(), -180), // 6 months back
    end: addDays(new Date(), 180), // 6 months forward
  },
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
  onItemCreate?: (item: Partial<ScheduleItem>) => Promise<ScheduleItem>
  onItemDelete?: (id: string) => Promise<void>
  onDependencyCreate?: (from: string, to: string, type?: string) => Promise<ScheduleDependency>
  onDependencyDelete?: (id: string) => Promise<void>
}

export function ScheduleProvider({
  children,
  initialItems,
  initialDependencies = [],
  initialAssignments = [],
  initialBaselines = [],
  onItemUpdate,
  onItemCreate,
  onItemDelete,
  onDependencyCreate,
  onDependencyDelete,
}: ScheduleProviderProps) {
  const [items, setItems] = useState<ScheduleItem[]>(initialItems)
  const [dependencies, setDependencies] = useState<ScheduleDependency[]>(initialDependencies)
  const [assignments] = useState<ScheduleAssignment[]>(initialAssignments)
  const [baselines] = useState<ScheduleBaseline[]>(initialBaselines)
  const [viewState, setViewStateInternal] = useState<ScheduleViewState>(defaultViewState)
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [scrollToTodayTrigger, setScrollToTodayTrigger] = useState(0)

  // Scroll to today function
  const scrollToToday = useCallback(() => {
    setScrollToTodayTrigger((prev) => prev + 1)
  }, [])

  // Update items when initialItems change
  useMemo(() => {
    setItems(initialItems)
  }, [initialItems])

  // Active baseline
  const activeBaseline = useMemo(() => {
    return baselines.find((b) => b.is_active) ?? null
  }, [baselines])

  // Selected item
  const selectedItem = useMemo(() => {
    if (!viewState.selectedItemId) return null
    return items.find((i) => i.id === viewState.selectedItemId) ?? null
  }, [items, viewState.selectedItemId])

  // Set view state
  const setViewState = useCallback((updates: Partial<ScheduleViewState>) => {
    setViewStateInternal((prev) => ({ ...prev, ...updates }))
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
      }
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

  // Handle item create
  const handleItemCreate = useCallback(async (item: Partial<ScheduleItem>) => {
    setIsLoading(true)
    setError(null)
    try {
      if (onItemCreate) {
        const created = await onItemCreate(item)
        setItems((prev) => [...prev, created])
      }
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
  const handleDependencyCreate = useCallback(async (from: string, to: string, type: string = "FS") => {
    setIsLoading(true)
    setError(null)
    try {
      if (onDependencyCreate) {
        const created = await onDependencyCreate(from, to, type)
        setDependencies((prev) => [...prev, created])
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create dependency")
      throw err
    } finally {
      setIsLoading(false)
    }
  }, [onDependencyCreate])

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
    onItemCreate: handleItemCreate,
    onItemDelete: handleItemDelete,
    onDependencyCreate: handleDependencyCreate,
    onDependencyDelete: handleDependencyDelete,
    scrollToToday,
    scrollToTodayTrigger,
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
    handleItemCreate,
    handleItemDelete,
    handleDependencyCreate,
    handleDependencyDelete,
    scrollToToday,
    scrollToTodayTrigger,
    isLoading,
    error,
  ])

  return (
    <ScheduleContext.Provider value={value}>
      {children}
    </ScheduleContext.Provider>
  )
}

