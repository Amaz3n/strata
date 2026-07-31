"use client"

import { useCallback, useEffect, useRef } from "react"

/**
 * Load-time telemetry for the tiled drawing viewer.
 *
 * Phases:
 *   1. thumbnailLoad — the static thumbnail behind the GPU canvas is showing
 *   2. firstVisible  — first meaningful content on screen
 *   3. fullyLoaded   — the viewer reports a fully-loaded frame (reported once per sheet)
 */
export interface DrawingPerformanceTimings {
  startTime: number
  thumbnailLoad: number | null
  firstVisible: number | null
  fullyLoaded: number | null
}

export interface DrawingPerformanceMetrics {
  sheetId: string
  fileSize?: number
  device: "desktop" | "mobile" | "tablet"
  connection?: "4g" | "3g" | "slow" | "unknown"
  loadTime: number
  breakdown: {
    thumbnailLoad?: number
    firstVisible?: number
  }
}

interface UseDrawingPerformanceOptions {
  sheetId: string
  fileSize?: number
  onComplete?: (metrics: DrawingPerformanceMetrics) => void
}

const DEBUG_PERFORMANCE = process.env.NODE_ENV !== "production"

function emptyTimings(startTime = 0): DrawingPerformanceTimings {
  return { startTime, thumbnailLoad: null, firstVisible: null, fullyLoaded: null }
}

export function useDrawingPerformance({
  sheetId,
  fileSize,
  onComplete,
}: UseDrawingPerformanceOptions) {
  const startTimeRef = useRef<number>(0)
  const timingsRef = useRef<DrawingPerformanceTimings>(emptyTimings())
  // Keyed by sheet id rather than a boolean so a completion event fires
  // exactly once per sheet load, whichever onLoad path gets there first.
  const reportedSheetRef = useRef<string | null>(null)
  // Latest values for the report, so the callback never closes over stale props.
  const reportInputsRef = useRef({ sheetId, fileSize, onComplete })
  reportInputsRef.current = { sheetId, fileSize, onComplete }

  const getDeviceType = useCallback((): "desktop" | "mobile" | "tablet" => {
    if (typeof window === "undefined") return "desktop"
    const ua = navigator.userAgent.toLowerCase()
    if (/tablet|ipad|playbook|silk/i.test(ua)) return "tablet"
    if (/mobile|iphone|ipod|android|blackberry|opera mini|opera mobi|skyfire|maemo|windows phone|palm|iemobile|symbian|symbianos|fennec/i.test(ua)) return "mobile"
    return "desktop"
  }, [])

  const getConnectionType = useCallback((): "4g" | "3g" | "slow" | "unknown" => {
    if (typeof navigator === "undefined") return "unknown"
    const connection = (navigator as Navigator & { connection?: { effectiveType?: string } }).connection
    if (!connection) return "unknown"
    const effectiveType = connection.effectiveType
    if (effectiveType === "4g") return "4g"
    if (effectiveType === "3g") return "3g"
    if (effectiveType === "2g" || effectiveType === "slow-2g") return "slow"
    return "unknown"
  }, [])

  // Restart the clock whenever the sheet changes.
  useEffect(() => {
    startTimeRef.current = performance.now()
    reportedSheetRef.current = null
    timingsRef.current = emptyTimings(startTimeRef.current)

    if (DEBUG_PERFORMANCE) {
      console.log(`[Drawing Performance] Started timing for sheet ${sheetId}`)
    }
  }, [sheetId])

  const markTiming = useCallback((phase: keyof Omit<DrawingPerformanceTimings, "startTime">) => {
    const elapsed = Math.round(performance.now() - startTimeRef.current)
    timingsRef.current = { ...timingsRef.current, [phase]: elapsed }

    if (DEBUG_PERFORMANCE) {
      console.log(`[Drawing Performance] ${phase}: ${elapsed}ms`)
    }
    return elapsed
  }, [])

  const markFullyLoaded = useCallback(() => {
    const { sheetId: currentSheetId, fileSize: currentFileSize, onComplete: currentOnComplete } =
      reportInputsRef.current
    if (reportedSheetRef.current === currentSheetId) return
    reportedSheetRef.current = currentSheetId

    const totalTime = markTiming("fullyLoaded")
    const breakdownSource = timingsRef.current
    const metrics: DrawingPerformanceMetrics = {
      sheetId: currentSheetId,
      fileSize: currentFileSize,
      device: getDeviceType(),
      connection: getConnectionType(),
      loadTime: totalTime,
      breakdown: {
        thumbnailLoad: breakdownSource.thumbnailLoad ?? undefined,
        firstVisible: breakdownSource.firstVisible ?? undefined,
      },
    }

    currentOnComplete?.(metrics)
  }, [markTiming, getDeviceType, getConnectionType])

  return { markTiming, markFullyLoaded }
}

/**
 * Log performance summary to console in a table format
 */
export function logPerformanceSummary(metrics: DrawingPerformanceMetrics) {
  if (!DEBUG_PERFORMANCE) return

  console.group(`📊 Drawing Performance Report - ${metrics.sheetId}`)
  console.log(`Total Load Time: ${metrics.loadTime}ms`)
  console.log(`Device: ${metrics.device}`)
  console.log(`Connection: ${metrics.connection}`)
  if (metrics.fileSize) {
    console.log(`File Size: ${(metrics.fileSize / 1024).toFixed(1)}KB`)
  }
  console.table(metrics.breakdown)
  console.groupEnd()

  if (metrics.loadTime < 300) {
    console.log(`✅ Performance: EXCELLENT (<300ms)`)
  } else if (metrics.loadTime < 1000) {
    console.log(`🟡 Performance: GOOD (<1s)`)
  } else if (metrics.loadTime < 3000) {
    console.log(`🟠 Performance: NEEDS IMPROVEMENT (<3s)`)
  } else {
    console.log(`🔴 Performance: POOR (>3s) - Target: <300ms`)
  }
}
