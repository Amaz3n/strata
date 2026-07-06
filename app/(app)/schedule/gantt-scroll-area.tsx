"use client"

import { useEffect, useRef, type ReactNode } from "react"

/**
 * Scroll wrapper for the portfolio Gantt. The chart preloads every job's whole
 * lifecycle, so on mount we jump the horizontal scroll to "today" (server passes
 * the pixel offset) instead of stranding the viewer back at the earliest month.
 * Children stay server-rendered — this only owns the scroll position.
 */
export function GanttScrollArea({
  initialScrollLeft,
  className,
  children,
}: {
  initialScrollLeft: number
  className?: string
  children: ReactNode
}) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const el = ref.current
    if (el) el.scrollLeft = initialScrollLeft
  }, [initialScrollLeft])
  return (
    <div ref={ref} className={className}>
      {children}
    </div>
  )
}
