"use client"

import { useState, useCallback, useRef, useEffect } from "react"

/**
 * Performance timing phases for drawing viewer
 *
 * Current flow (with react-pdf):
 * 1. urlGeneration: Time to generate signed URL from Supabase
 * 2. pdfImport: Time to dynamically import react-pdf bundle (~2MB)
 * 3. workerLoad: Time to load PDF.js worker from unpkg
 * 4. pdfDownload: Time to download the PDF file
 * 5. pdfParsing: Time for PDF.js to parse the PDF in browser
 * 6. rendering: Time to render the PDF to canvas
 *
 * Target flow (with image generation):
 * 1. thumbnailLoad: Time to load thumbnail image (<100ms)
 * 2. mediumLoad: Time to load medium resolution (<200ms)
 * 3. fullLoad: Time to load full resolution (<500ms)
 */
export interface DrawingPerformanceTimings {
  // Phase identifiers
  startTime: number
  urlGeneration: number | null
  pdfImport: number | null
  workerLoad: number | null
  pdfDownload: number | null
  pdfParsing: number | null
  rendering: number | null
  // For future image-based loading
  thumbnailLoad: number | null
  mediumLoad: number | null
  fullLoad: number | null
  // Overall metrics
  firstVisible: number | null
  fullyLoaded: number | null
}

export interface DrawingPerformanceMetrics {
  sheetId: string
  fileSize?: number
  device: "desktop" | "mobile" | "tablet"
  connection?: "4g" | "3g" | "slow" | "unknown"
  loadTime: number
  isPdf: boolean
  // For debugging
  breakdown: {
    urlGeneration?: number
    pdfImport?: number
    workerLoad?: number
    pdfDownload?: number
    pdfParsing?: number
    rendering?: number
    thumbnailLoad?: number
    mediumLoad?: number
    fullLoad?: number
  }
}

interface UseDrawingPerformanceOptions {
  sheetId: string
  fileSize?: number
  isPdf: boolean
  onComplete?: (metrics: DrawingPerformanceMetrics) => void
}

export function useDrawingPerformance({
  sheetId,
  fileSize,
  isPdf,
  onComplete,
}: UseDrawingPerformanceOptions) {
  const [timings, setTimings] = useState<DrawingPerformanceTimings>({
    startTime: 0,
    urlGeneration: null,
    pdfImport: null,
    workerLoad: null,
    pdfDownload: null,
    pdfParsing: null,
    rendering: null,
    thumbnailLoad: null,
    mediumLoad: null,
    fullLoad: null,
    firstVisible: null,
    fullyLoaded: null,
  })

  const [isComplete, setIsComplete] = useState(false)
  const startTimeRef = useRef<number>(0)
  const reportedRef = useRef(false)

  // Detect device type
  const getDeviceType = useCallback((): "desktop" | "mobile" | "tablet" => {
    if (typeof window === "undefined") return "desktop"
    const ua = navigator.userAgent.toLowerCase()
    if (/tablet|ipad|playbook|silk/i.test(ua)) return "tablet"
    if (/mobile|iphone|ipod|android|blackberry|opera mini|opera mobi|skyfire|maemo|windows phone|palm|iemobile|symbian|symbianos|fennec/i.test(ua)) return "mobile"
    return "desktop"
  }, [])

  // Detect connection type
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

  // Start timing when component mounts or sheet changes
  useEffect(() => {
    startTimeRef.current = performance.now()
    reportedRef.current = false
    setIsComplete(false)
    setTimings({
      startTime: startTimeRef.current,
      urlGeneration: null,
      pdfImport: null,
      workerLoad: null,
      pdfDownload: null,
      pdfParsing: null,
      rendering: null,
      thumbnailLoad: null,
      mediumLoad: null,
      fullLoad: null,
      firstVisible: null,
      fullyLoaded: null,
    })

    console.log(`[Drawing Performance] Started timing for sheet ${sheetId}`)
  }, [sheetId])

  // Mark timing for a specific phase
  const markTiming = useCallback((phase: keyof Omit<DrawingPerformanceTimings, "startTime">) => {
    const now = performance.now()
    const elapsed = Math.round(now - startTimeRef.current)

    setTimings((prev) => ({
      ...prev,
      [phase]: elapsed,
    }))

    console.log(`[Drawing Performance] ${phase}: ${elapsed}ms`)

    return elapsed
  }, [])

  // Report final metrics
  const reportMetrics = useCallback(() => {
    if (reportedRef.current) return
    reportedRef.current = true

    const now = performance.now()
    const totalTime = Math.round(now - startTimeRef.current)

    setTimings((prev) => ({
      ...prev,
      fullyLoaded: totalTime,
    }))
    setIsComplete(true)

    const metrics: DrawingPerformanceMetrics = {
      sheetId,
      fileSize,
      device: getDeviceType(),
      connection: getConnectionType(),
      loadTime: totalTime,
      isPdf,
      breakdown: {
        urlGeneration: timings.urlGeneration ?? undefined,
        pdfImport: timings.pdfImport ?? undefined,
        workerLoad: timings.workerLoad ?? undefined,
        pdfDownload: timings.pdfDownload ?? undefined,
        pdfParsing: timings.pdfParsing ?? undefined,
        rendering: timings.rendering ?? undefined,
        thumbnailLoad: timings.thumbnailLoad ?? undefined,
        mediumLoad: timings.mediumLoad ?? undefined,
        fullLoad: timings.fullLoad ?? undefined,
      },
    }

    console.log(`[Drawing Performance] Complete:`, {
      sheetId,
      totalTime: `${totalTime}ms`,
      device: metrics.device,
      connection: metrics.connection,
      breakdown: metrics.breakdown,
    })

    onComplete?.(metrics)
  }, [sheetId, fileSize, isPdf, timings, getDeviceType, getConnectionType, onComplete])

  // Mark first visible content (thumbnail or initial render)
  const markFirstVisible = useCallback(() => {
    const elapsed = markTiming("firstVisible")
    console.log(`[Drawing Performance] First visible content: ${elapsed}ms`)
  }, [markTiming])

  // Mark fully loaded (full resolution or PDF fully rendered)
  const markFullyLoaded = useCallback(() => {
    markTiming("fullyLoaded")
    reportMetrics()
  }, [markTiming, reportMetrics])

  return {
    timings,
    isComplete,
    markTiming,
    markFirstVisible,
    markFullyLoaded,
    reportMetrics,
    getElapsed: () => Math.round(performance.now() - startTimeRef.current),
  }
}

/**
 * Utility to measure async operation timing
 */
export async function measureAsync<T>(
  operation: () => Promise<T>,
  onTiming: (elapsed: number) => void
): Promise<T> {
  const start = performance.now()
  const result = await operation()
  const elapsed = Math.round(performance.now() - start)
  onTiming(elapsed)
  return result
}

/**
 * Log performance summary to console in a table format
 */
export function logPerformanceSummary(metrics: DrawingPerformanceMetrics) {
  console.group(`📊 Drawing Performance Report - ${metrics.sheetId}`)
  console.log(`Total Load Time: ${metrics.loadTime}ms`)
  console.log(`Device: ${metrics.device}`)
  console.log(`Connection: ${metrics.connection}`)
  console.log(`File Type: ${metrics.isPdf ? "PDF" : "Image"}`)
  if (metrics.fileSize) {
    console.log(`File Size: ${(metrics.fileSize / 1024).toFixed(1)}KB`)
  }
  console.table(metrics.breakdown)
  console.groupEnd()

  // Performance rating
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
