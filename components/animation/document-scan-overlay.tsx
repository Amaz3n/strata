"use client"

import { useEffect, useRef, useState } from "react"

import { cn } from "@/lib/utils"

/**
 * Dot-matrix scan overlay.
 *
 * Sized to whatever it is placed in, and plays for exactly as long as the work
 * takes. Dots light up under a few soft blobs that wander the surface, so the
 * work looks like sampling rather than a progress bar with extra steps. When it
 * ends, the matrix drains outward off the edges and fades as it goes.
 *
 * Two variants:
 *  - `document` (default) dims the page it covers and lights it with fixed
 *    colours, for a rendered invoice being read.
 *  - `surface` drops the veil and takes its colours from the theme, for the
 *    drop targets that promise a read is coming.
 *
 * All of the look lives in `.doc-scan` in app/globals.css.
 */

/** Covers the drain animation and the fade that trails it. */
const SETTLE_MS = 1000

/**
 * How long the matrix stays up once it has appeared. A cached or trivially
 * short read would otherwise flash the overlay for a few frames, which reads as
 * a glitch rather than as work — and leaves the reader unsure anything happened.
 */
const MIN_VISIBLE_MS = 900

type ScanState = "idle" | "scanning" | "settling"

interface DocumentScanOverlayProps {
  /** True while the work this overlay stands for is running. */
  active: boolean
  /** `document` dims the page beneath; `surface` sits on app chrome. */
  variant?: "document" | "surface"
  className?: string
  /** Short, honest work label rendered above the matrix. */
  label?: string
}

export function DocumentScanOverlay({
  active,
  variant = "document",
  className,
  label = "Scanning…",
}: DocumentScanOverlayProps) {
  const [state, setState] = useState<ScanState>(active ? "scanning" : "idle")
  const shownAt = useRef(0)
  // Bumped per scan and used as the root's key, which forces a remount.
  // Without it, a scan starting while the previous one is still draining
  // reuses the same node — and `animation-play-state: paused` freezes the
  // wash at its current time rather than rewinding it, so the matrix would
  // come back already half-erased and never recover.
  const [runId, setRunId] = useState(0)

  useEffect(() => {
    if (active) {
      shownAt.current = performance.now()
      // This effect only re-runs when `active` changes, so reaching here is
      // always the start of a new scan.
      setRunId((id) => id + 1)
      setState("scanning")
      return
    }

    let settleTimer = 0
    // A scan that never started has nothing to drain — going straight to idle
    // keeps a surface that was merely re-rendered from flashing a matrix.
    const holdFor = shownAt.current
      ? Math.max(0, MIN_VISIBLE_MS - (performance.now() - shownAt.current))
      : 0

    const startTimer = window.setTimeout(() => {
      setState((current) => (current === "scanning" ? "settling" : current))
      settleTimer = window.setTimeout(() => setState("idle"), SETTLE_MS)
    }, holdFor)

    return () => {
      window.clearTimeout(startTimer)
      window.clearTimeout(settleTimer)
    }
  }, [active])

  if (state === "idle") return null

  return (
    <>
      <div
        key={runId}
        className={cn("doc-scan", className)}
        data-state={state}
        data-variant={variant}
        aria-hidden
      >
        {variant === "document" ? <div className="doc-scan-veil" /> : null}
        <div className="doc-scan-grid" />
        <div className="doc-scan-glow-lit" />
        {variant === "document" ? (
          <div className="doc-scan-status">
            <span data-label={label}>{label}</span>
          </div>
        ) : null}
      </div>
      {variant === "document" ? <span className="sr-only" role="status">{label}</span> : null}
    </>
  )
}
