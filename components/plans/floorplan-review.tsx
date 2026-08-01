"use client"

/**
 * 2D review: the interpreted wall graph, drawn on the sheet it came from.
 *
 * Corrections happen HERE rather than in the 3D view, because judging a wall
 * is a two-dimensional job — you compare the traced centerline against the
 * linework a foot away from it, which is exactly what a plan sheet is for.
 * The 3D view is the reward, not the workbench.
 *
 * These are MODEL edits, never drawing markups: a false wall the interpreter
 * invented is not an annotation on the drawing, and writing it to
 * `drawing_markups` would put interpretation debris in front of every
 * superintendent who opens the sheet.
 */

import { useCallback, useEffect, useRef, useState } from "react"

import { Check, Loader2, PencilRuler, Trash2, X } from "@/components/icons"
import { TiledDrawingViewer, type ImageToScreenMatrix, type TileManifest } from "@/components/drawings/viewer/tiled-drawing-viewer"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import {
  modelToImagePx,
  imagePxToModel,
  polygonCentroid,
  wallDirection,
  wallLengthFt,
  type FloorplanEdit,
  type Level,
  type OpeningKind,
  type Wall,
} from "@/lib/drawings/floorplan-model"
import type { FloorplanSheetView } from "@/lib/services/floorplan-models"
import { cn } from "@/lib/utils"

type Tool = "select" | "draw"

const OPENING_LABEL: Record<OpeningKind, string> = {
  door: "Door",
  window: "Window",
  cased: "Cased opening",
}

/** Confidence below this gets tinted for attention. */
const LOW_CONFIDENCE = 0.6

export interface FloorplanReviewProps {
  level: Level
  sheet: FloorplanSheetView | null
  editable: boolean
  saving: boolean
  onEdit: (edit: FloorplanEdit) => void
}

export function FloorplanReview({ level, sheet, editable, saving, onEdit }: FloorplanReviewProps) {
  const [tool, setTool] = useState<Tool>("select")
  const [selectedWallId, setSelectedWallId] = useState<string | null>(null)
  const [editingRoomId, setEditingRoomId] = useState<string | null>(null)
  const [roomDraft, setRoomDraft] = useState("")
  const [drawStart, setDrawStart] = useState<{ x: number; y: number } | null>(null)
  const [cursor, setCursor] = useState<{ x: number; y: number } | null>(null)

  const svgRef = useRef<SVGSVGElement>(null)
  const groupRef = useRef<SVGGElement>(null)
  const wrapperRef = useRef<HTMLDivElement>(null)
  const matrixRef = useRef<ImageToScreenMatrix | null>(null)

  // The overlay writes the transform straight to the DOM on every viewer
  // frame; routing it through React state would drop frames while panning.
  const onTransformChange = useCallback(({ matrix }: { matrix: ImageToScreenMatrix }) => {
    matrixRef.current = matrix
    groupRef.current?.setAttribute(
      "transform",
      `matrix(${matrix.a} ${matrix.b} ${matrix.c} ${matrix.d} ${matrix.e} ${matrix.f})`,
    )
  }, [])

  /** Screen point → model feet, through the viewer's current transform. */
  const toModelPoint = useCallback(
    (clientX: number, clientY: number): { x: number; y: number } | null => {
      const matrix = matrixRef.current
      const element = wrapperRef.current
      if (!matrix || !element) return null
      const rect = element.getBoundingClientRect()
      const sx = clientX - rect.left
      const sy = clientY - rect.top
      const determinant = matrix.a * matrix.d - matrix.b * matrix.c
      if (Math.abs(determinant) < 1e-9) return null
      const dx = sx - matrix.e
      const dy = sy - matrix.f
      const px = (dx * matrix.d - dy * matrix.c) / determinant
      const py = (dy * matrix.a - dx * matrix.b) / determinant
      return imagePxToModel(level.source, px, py)
    },
    [level.source],
  )

  useEffect(() => {
    setSelectedWallId(null)
    setDrawStart(null)
    setEditingRoomId(null)
  }, [level.id])

  useEffect(() => {
    if (!editable) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setDrawStart(null)
        setSelectedWallId(null)
        setTool("select")
        return
      }
      if ((event.key === "Delete" || event.key === "Backspace") && selectedWallId) {
        const target = event.target as HTMLElement | null
        if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA")) return
        event.preventDefault()
        onEdit({ type: "wall.delete", levelId: level.id, wallId: selectedWallId })
        setSelectedWallId(null)
      }
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [editable, level.id, onEdit, selectedWallId])

  // A drag that pans the sheet ends in a click event too. Only a pointer that
  // barely moved is a placement — otherwise every pan would drop a wall end.
  const pressRef = useRef<{ x: number; y: number } | null>(null)
  const onSurfaceDown = useCallback((event: React.MouseEvent<HTMLDivElement>) => {
    pressRef.current = { x: event.clientX, y: event.clientY }
  }, [])

  const onSurfaceClick = useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      if (tool !== "draw" || !editable) return
      const press = pressRef.current
      pressRef.current = null
      if (press && Math.hypot(event.clientX - press.x, event.clientY - press.y) > 5) return
      const point = toModelPoint(event.clientX, event.clientY)
      if (!point) return
      if (!drawStart) {
        setDrawStart(point)
        return
      }
      onEdit({ type: "wall.add", levelId: level.id, x0: drawStart.x, y0: drawStart.y, x1: point.x, y1: point.y })
      setDrawStart(null)
    },
    [drawStart, editable, level.id, onEdit, toModelPoint, tool],
  )

  const onSurfaceMove = useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      if (tool !== "draw" || !drawStart) return
      setCursor(toModelPoint(event.clientX, event.clientY))
    },
    [drawStart, toModelPoint, tool],
  )

  const selectedWall = level.walls.find((wall) => wall.id === selectedWallId) ?? null
  const px = (x: number, y: number) => modelToImagePx(level.source, x, y)
  /** Room labels are sized in FEET so they stay legible at any zoom. */
  const labelSizePx = 2.2 / level.source.feetPerImagePx

  return (
    <div className="flex h-full flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b border-border px-3 py-2">
        {editable ? (
          <>
            <Button
              size="sm"
              variant={tool === "select" ? "default" : "ghost"}
              onClick={() => {
                setTool("select")
                setDrawStart(null)
              }}
            >
              Select
            </Button>
            <Button
              size="sm"
              variant={tool === "draw" ? "default" : "ghost"}
              className="gap-1.5"
              onClick={() => {
                setTool("draw")
                setSelectedWallId(null)
              }}
            >
              <PencilRuler className="h-3.5 w-3.5" />
              Draw wall
            </Button>
            {selectedWall ? (
              <Button
                size="sm"
                variant="ghost"
                className="gap-1.5 text-destructive"
                onClick={() => {
                  onEdit({ type: "wall.delete", levelId: level.id, wallId: selectedWall.id })
                  setSelectedWallId(null)
                }}
              >
                <Trash2 className="h-3.5 w-3.5" />
                Delete wall
              </Button>
            ) : null}
          </>
        ) : null}

        <div className="ml-auto flex items-center gap-2">
          {saving ? (
            <span className="flex items-center gap-1 text-xs text-muted-foreground">
              <Loader2 className="h-3 w-3 animate-spin" />
              Saving
            </span>
          ) : null}
          {editable ? (
            <div className="flex items-center gap-1.5">
              <Label htmlFor={`ceiling-${level.id}`} className="text-xs text-muted-foreground">
                Ceiling
              </Label>
              <Select
                value={String(level.ceilingHeightFt)}
                onValueChange={(value) =>
                  onEdit({ type: "level.height", levelId: level.id, ceilingHeightFt: Number(value) })
                }
              >
                <SelectTrigger id={`ceiling-${level.id}`} className="h-7 w-24 text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {[8, 9, 10, 11, 12, 14].map((height) => (
                    <SelectItem key={height} value={String(height)}>
                      {height}′
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          ) : (
            <span className="text-xs text-muted-foreground tabular-nums">{level.ceilingHeightFt}′ ceilings</span>
          )}
          <span className="text-xs text-muted-foreground tabular-nums">
            {level.walls.length} walls · {level.openings.length} openings · {level.rooms.length} rooms
          </span>
        </div>
      </div>

      <div
        ref={wrapperRef}
        className={cn("relative min-h-0 flex-1", tool === "draw" && editable ? "cursor-crosshair" : null)}
        onMouseDown={onSurfaceDown}
        onClick={onSurfaceClick}
        onMouseMove={onSurfaceMove}
      >
        {sheet?.tileBaseUrl && sheet.tileManifest ? (
          <TiledDrawingViewer
            tileBaseUrl={sheet.tileBaseUrl}
            tileManifest={sheet.tileManifest as unknown as TileManifest}
            thumbnailUrl={sheet.thumbnailUrl ?? undefined}
            onTransformChange={onTransformChange}
          />
        ) : (
          <SheetlessCanvas level={level} onTransform={onTransformChange} />
        )}

        <svg ref={svgRef} className="pointer-events-none absolute inset-0 h-full w-full">
          {/* Under the transform, `vectorEffect` is what keeps a hairline a
              hairline at every zoom; wall strokes deliberately do NOT use it,
              because their width IS the wall's real thickness. */}
          <g ref={groupRef} className={tool === "draw" && editable ? "pointer-events-none" : undefined}>
            {level.rooms.map((room) => {
              const points = room.polygon.map(([x, y]) => px(x, y))
              const centroid = polygonCentroid(room.polygon.map(([x, y]) => [x, y] as [number, number]))
              const center = px(centroid[0], centroid[1])
              return (
                <g key={room.id}>
                  <polygon
                    points={points.map((point) => `${point.x},${point.y}`).join(" ")}
                    vectorEffect="non-scaling-stroke"
                    strokeWidth={1.5}
                    className={cn(
                      "pointer-events-auto cursor-pointer fill-primary/5 stroke-primary/25",
                      !room.label && "fill-warning/10 stroke-warning/40",
                    )}
                    onClick={(event) => {
                      if (!editable) return
                      event.stopPropagation()
                      setEditingRoomId(room.id)
                      setRoomDraft(room.label ?? "")
                    }}
                  />
                  <text
                    x={center.x}
                    y={center.y}
                    textAnchor="middle"
                    dominantBaseline="middle"
                    fontSize={labelSizePx}
                    className={cn(
                      "pointer-events-none font-medium",
                      room.label ? "fill-foreground" : "fill-muted-foreground",
                    )}
                  >
                    {room.label ?? "Unnamed"}
                  </text>
                </g>
              )
            })}

            {level.walls.map((wall) => {
              const a = px(wall.x0, wall.y0)
              const b = px(wall.x1, wall.y1)
              const selected = wall.id === selectedWallId
              const low = wall.confidence < LOW_CONFIDENCE
              const thicknessPx = wall.thicknessFt / level.source.feetPerImagePx
              return (
                <line
                  key={wall.id}
                  x1={a.x}
                  y1={a.y}
                  x2={b.x}
                  y2={b.y}
                  strokeLinecap="butt"
                  strokeWidth={thicknessPx}
                  className={cn(
                    "pointer-events-auto cursor-pointer",
                    selected
                      ? "stroke-destructive"
                      : wall.source === "manual"
                        ? "stroke-success/70"
                        : low
                          ? "stroke-warning/70"
                          : "stroke-primary/60",
                  )}
                  onClick={(event) => {
                    if (!editable || tool === "draw") return
                    event.stopPropagation()
                    setSelectedWallId(selected ? null : wall.id)
                  }}
                />
              )
            })}

            {level.openings.map((opening) => {
              const wall = level.walls.find((candidate) => candidate.id === opening.wallId)
              if (!wall) return null
              const { ux, uy } = wallDirection(wall)
              const mid = opening.offsetFt + opening.widthFt / 2
              const point = px(wall.x0 + ux * mid, wall.y0 + uy * mid)
              const radius = Math.max(0.5, opening.widthFt / 3) / level.source.feetPerImagePx
              return (
                <circle
                  key={opening.id}
                  cx={point.x}
                  cy={point.y}
                  r={radius}
                  vectorEffect="non-scaling-stroke"
                  strokeWidth={1.5}
                  className={cn(
                    "pointer-events-auto cursor-pointer",
                    opening.kind === "door"
                      ? "fill-success/40 stroke-success"
                      : opening.kind === "window"
                        ? "fill-chart-2/40 stroke-chart-2"
                        : "fill-muted stroke-muted-foreground",
                  )}
                  onClick={(event) => {
                    if (!editable) return
                    event.stopPropagation()
                    const order: OpeningKind[] = ["door", "window", "cased"]
                    const next = order[(order.indexOf(opening.kind) + 1) % order.length]
                    onEdit({ type: "opening.set", levelId: level.id, openingId: opening.id, kind: next })
                  }}
                >
                  <title>{`${OPENING_LABEL[opening.kind]} — ${opening.widthFt.toFixed(1)}′ (click to change)`}</title>
                </circle>
              )
            })}

            {drawStart && cursor ? (
              <line
                x1={px(drawStart.x, drawStart.y).x}
                y1={px(drawStart.x, drawStart.y).y}
                x2={px(cursor.x, cursor.y).x}
                y2={px(cursor.x, cursor.y).y}
                strokeWidth={0.4583 / level.source.feetPerImagePx}
                strokeDasharray="8 6"
                className="stroke-success"
              />
            ) : null}
          </g>
        </svg>

        {editingRoomId ? (
          <div className="absolute bottom-3 left-3 flex items-center gap-1.5 border border-border bg-card p-2 shadow-sm">
            <Input
              autoFocus
              value={roomDraft}
              onChange={(event) => setRoomDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  onEdit({ type: "room.label", levelId: level.id, roomId: editingRoomId, label: roomDraft || null })
                  setEditingRoomId(null)
                }
                if (event.key === "Escape") setEditingRoomId(null)
              }}
              placeholder="Room name"
              className="h-8 w-44 text-sm"
            />
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                onEdit({ type: "room.label", levelId: level.id, roomId: editingRoomId, label: roomDraft || null })
                setEditingRoomId(null)
              }}
              aria-label="Save room name"
            >
              <Check className="h-3.5 w-3.5" />
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setEditingRoomId(null)} aria-label="Cancel">
              <X className="h-3.5 w-3.5" />
            </Button>
          </div>
        ) : null}

        {tool === "draw" && editable ? (
          <div className="pointer-events-none absolute left-1/2 top-3 -translate-x-1/2 border border-border bg-card px-3 py-1.5 text-xs text-muted-foreground">
            {drawStart ? "Click the far end of the wall" : "Click where the wall starts"} · Esc to cancel
          </div>
        ) : null}
      </div>

      <div className="flex items-center gap-4 border-t border-border px-3 py-2 text-xs text-muted-foreground">
        <LegendDot className="bg-primary/60" label="Traced wall" />
        <LegendDot className="bg-warning/70" label="Low confidence" />
        <LegendDot className="bg-success/70" label="Drawn by hand" />
        <span className="ml-auto tabular-nums">
          {selectedWall ? `${wallLengthFt(selectedWall).toFixed(1)}′ · ${(selectedWall.thicknessFt * 12).toFixed(1)}″ thick` : "Click a wall to select it"}
        </span>
      </div>
    </div>
  )
}

function LegendDot({ className, label }: { className: string; label: string }) {
  return (
    <span className="flex items-center gap-1.5">
      <span className={cn("h-2 w-2 rounded-full", className)} />
      {label}
    </span>
  )
}

/**
 * Fallback when the source sheet's tiles are gone (a re-tile moved them, or an
 * older set never had them): the model still reviews against itself on a plain
 * fitted canvas. Corrections stay possible; only the linework underneath is
 * missing.
 */
function SheetlessCanvas({
  level,
  onTransform,
}: {
  level: Level
  onTransform: (args: { matrix: ImageToScreenMatrix }) => void
}) {
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const element = ref.current
    if (!element) return
    const fit = () => {
      const width = element.clientWidth
      const height = element.clientHeight
      if (!width || !height) return
      const bounds = wallBoundsPx(level)
      const scale = Math.min(width / Math.max(bounds.width, 1), height / Math.max(bounds.height, 1)) * 0.85
      onTransform({
        matrix: {
          a: scale,
          b: 0,
          c: 0,
          d: scale,
          e: (width - bounds.width * scale) / 2 - bounds.minX * scale,
          f: (height - bounds.height * scale) / 2 - bounds.minY * scale,
        },
      })
    }
    fit()
    const observer = new ResizeObserver(fit)
    observer.observe(element)
    return () => observer.disconnect()
  }, [level, onTransform])

  return <div ref={ref} className="absolute inset-0 bg-muted" />
}

function wallBoundsPx(level: Level): { minX: number; minY: number; width: number; height: number } {
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  const consider = (wall: Wall) => {
    for (const [x, y] of [
      [wall.x0, wall.y0],
      [wall.x1, wall.y1],
    ]) {
      const point = modelToImagePx(level.source, x, y)
      minX = Math.min(minX, point.x)
      minY = Math.min(minY, point.y)
      maxX = Math.max(maxX, point.x)
      maxY = Math.max(maxY, point.y)
    }
  }
  for (const wall of level.walls) consider(wall)
  if (!Number.isFinite(minX)) return { minX: 0, minY: 0, width: 1, height: 1 }
  return { minX, minY, width: maxX - minX, height: maxY - minY }
}
