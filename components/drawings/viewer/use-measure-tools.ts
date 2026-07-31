"use client"

import { useCallback, useEffect, useMemo, useRef, useState } from "react"

import {
  computeMarkupQuantity,
  measurementLabel,
  type ImageSize,
  type MeasureUom,
} from "@/lib/drawings/measure"

/**
 * The multi-click measuring tools.
 *
 * `dimension` (the legacy 2-point tool) is a drag: press, move, release. The
 * takeoff tools are not — a wall run has eight corners and a room has six, so
 * they collect clicks until the user says "done". That state machine is the
 * whole reason this lives outside drawing-viewer.tsx.
 *
 * Rules, per tool:
 *   linear  — click each vertex; double-click / Enter / clicking the last
 *             vertex again finishes. Needs 2 points.
 *   area    — same, plus clicking within CLOSE_RADIUS of the first vertex
 *             closes the ring. Needs 3 points.
 *   count   — every click is one item; Enter or switching tools commits the
 *             whole batch as a single markup. Needs 1 point.
 *
 * Escape cancels the whole in-progress shape, Backspace drops the last point.
 */

export type MeasureToolType = "polyline" | "area" | "count"

export interface NormPoint {
  x: number
  y: number
}

/** Screen-space radius (in rendered-image px) for "clicked the first vertex". */
const CLOSE_RADIUS_PX = 12

const MIN_POINTS: Record<MeasureToolType, number> = {
  polyline: 2,
  area: 3,
  count: 1,
}

export interface MeasureDraft {
  tool: MeasureToolType
  points: NormPoint[]
  /** Follows the cursor; drawn as a rubber band, never committed. */
  cursor: NormPoint | null
}

export interface CommitPayload {
  type: MeasureToolType
  points: Array<[number, number]>
}

export interface UseMeasureToolsOptions {
  imageSize: ImageSize | null
  feetPerImagePx: number | null
  /** Persist the finished shape. Rejecting restores the draft so nothing is lost. */
  onCommit: (payload: CommitPayload) => Promise<void>
  /**
   * Vector snapping. Applied to every placed point and to the rubber-band
   * cursor; a null return means "no linework near enough — use the raw point".
   * The host resolves availability and modifier bypass (Alt) BEFORE this is
   * called — pass null when snapping is off entirely.
   */
  snap?: ((point: NormPoint) => NormPoint | null) | null
}

export interface MeasureToolsApi {
  activeTool: MeasureToolType | null
  setActiveTool: (tool: MeasureToolType | null) => void
  draft: MeasureDraft | null
  /** True while a shape is being collected — the viewer suppresses pan. */
  isDrafting: boolean
  saving: boolean
  /** Live label for the shape under construction, e.g. `142'-6"`. */
  draftLabel: string | null
  draftQuantity: { quantity: number; uom: MeasureUom } | null
  /** Point count needed before the shape can be committed. */
  remainingPoints: number
  handleClick: (point: NormPoint) => void
  handleMove: (point: NormPoint | null) => void
  handleDoubleClick: () => void
  finish: () => void
  cancel: () => void
  undoPoint: () => void
}

export function useMeasureTools({
  imageSize,
  feetPerImagePx,
  onCommit,
  snap = null,
}: UseMeasureToolsOptions): MeasureToolsApi {
  const [activeTool, setActiveToolState] = useState<MeasureToolType | null>(null)
  const [draft, setDraft] = useState<MeasureDraft | null>(null)
  const [saving, setSaving] = useState(false)

  // The commit callback changes identity every render in the host component;
  // keeping it in a ref lets finish() stay stable for the keyboard effect.
  const commitRef = useRef(onCommit)
  commitRef.current = onCommit
  const draftRef = useRef<MeasureDraft | null>(null)
  draftRef.current = draft
  // Same identity trick as the commit callback: the snap fn is rebuilt by the
  // host per render, and handleClick/handleMove must not churn on it.
  const snapRef = useRef(snap)
  snapRef.current = snap

  const commit = useCallback(async (current: MeasureDraft) => {
    if (current.points.length < MIN_POINTS[current.tool]) return
    const payload: CommitPayload = {
      type: current.tool,
      points: current.points.map((p) => [p.x, p.y] as [number, number]),
    }
    setDraft(null)
    setSaving(true)
    try {
      await commitRef.current(payload)
    } catch {
      // Persisting failed — hand the geometry back rather than making the user
      // re-trace a forty-click room.
      setDraft(current)
    } finally {
      setSaving(false)
    }
  }, [])

  const finish = useCallback(() => {
    const current = draftRef.current
    if (!current) return
    void commit(current)
  }, [commit])

  const cancel = useCallback(() => {
    setDraft(null)
  }, [])

  const undoPoint = useCallback(() => {
    setDraft((prev) => {
      if (!prev) return prev
      if (prev.points.length <= 1) return null
      return { ...prev, points: prev.points.slice(0, -1) }
    })
  }, [])

  // Switching tools commits a count batch (it has no natural end gesture) and
  // discards an unfinished line or ring (which would be nonsense half-drawn).
  const setActiveTool = useCallback(
    (tool: MeasureToolType | null) => {
      const current = draftRef.current
      if (current && current.tool !== tool) {
        if (current.tool === "count" && current.points.length >= 1) {
          void commit(current)
        } else {
          setDraft(null)
        }
      }
      setActiveToolState(tool)
    },
    [commit],
  )

  const handleClick = useCallback(
    (rawPoint: NormPoint) => {
      if (!activeTool) return
      // Snap before any close-gesture math: the first vertex was itself
      // snapped, so clicking near it snaps to the same spot and closes clean.
      const point = snapRef.current?.(rawPoint) ?? rawPoint

      setDraft((prev) => {
        if (!prev || prev.tool !== activeTool) {
          return { tool: activeTool, points: [point], cursor: null }
        }

        // Closing an area on its own start vertex.
        if (activeTool === "area" && prev.points.length >= 3 && imageSize) {
          const start = prev.points[0]
          const dx = (point.x - start.x) * imageSize.width
          const dy = (point.y - start.y) * imageSize.height
          if (Math.hypot(dx, dy) <= CLOSE_RADIUS_PX) {
            void commit(prev)
            return null
          }
        }

        // Clicking the last vertex again finishes a line (matches every other
        // takeoff tool on the market, and double-click is fiddly on a trackpad).
        if (activeTool === "polyline" && prev.points.length >= 2 && imageSize) {
          const last = prev.points[prev.points.length - 1]
          const dx = (point.x - last.x) * imageSize.width
          const dy = (point.y - last.y) * imageSize.height
          if (Math.hypot(dx, dy) <= CLOSE_RADIUS_PX) {
            void commit(prev)
            return null
          }
        }

        return { ...prev, points: [...prev.points, point] }
      })
    },
    [activeTool, commit, imageSize],
  )

  const handleMove = useCallback((rawPoint: NormPoint | null) => {
    const point = rawPoint ? snapRef.current?.(rawPoint) ?? rawPoint : null
    setDraft((prev) => {
      if (!prev || prev.tool === "count") return prev
      return { ...prev, cursor: point }
    })
  }, [])

  const handleDoubleClick = useCallback(() => {
    const current = draftRef.current
    if (!current || current.tool === "count") return
    // The double-click's first click already added the point.
    if (current.points.length > MIN_POINTS[current.tool]) {
      void commit({ ...current, points: current.points.slice(0, -1) })
    } else {
      void commit(current)
    }
  }, [commit])

  // Keyboard is captured so Escape reaches the tool before the viewer's own
  // "close the sheet" handler.
  useEffect(() => {
    if (!draft) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation()
        event.preventDefault()
        cancel()
      } else if (event.key === "Enter") {
        event.stopPropagation()
        event.preventDefault()
        finish()
      } else if (event.key === "Backspace" || event.key === "Delete") {
        event.stopPropagation()
        event.preventDefault()
        undoPoint()
      }
    }
    window.addEventListener("keydown", onKey, true)
    return () => window.removeEventListener("keydown", onKey, true)
  }, [draft, cancel, finish, undoPoint])

  // Live readout: the shape as it would measure if finished right now,
  // including the rubber-band segment for lines and rings.
  const previewPoints = useMemo(() => {
    if (!draft) return []
    const points = draft.points.map((p) => [p.x, p.y] as [number, number])
    if (draft.cursor && draft.tool !== "count") {
      points.push([draft.cursor.x, draft.cursor.y])
    }
    return points
  }, [draft])

  const draftQuantity = useMemo(() => {
    if (!draft) return null
    return computeMarkupQuantity({ type: draft.tool, points: previewPoints }, imageSize, feetPerImagePx)
  }, [draft, previewPoints, imageSize, feetPerImagePx])

  const draftLabel = useMemo(() => {
    if (!draft) return null
    return measurementLabel({ type: draft.tool, points: previewPoints }, imageSize, feetPerImagePx)
  }, [draft, previewPoints, imageSize, feetPerImagePx])

  const remainingPoints = draft ? Math.max(0, MIN_POINTS[draft.tool] - draft.points.length) : 0

  return {
    activeTool,
    setActiveTool,
    draft,
    isDrafting: !!draft,
    saving,
    draftLabel,
    draftQuantity,
    remainingPoints,
    handleClick,
    handleMove,
    handleDoubleClick,
    finish,
    cancel,
    undoPoint,
  }
}
