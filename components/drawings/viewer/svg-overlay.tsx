"use client"

import { memo, useImperativeHandle, useLayoutEffect, useMemo, useRef } from "react"
import type { Ref } from "react"
import type { ImageToScreenMatrix } from "./tiled-drawing-viewer"
import { cn } from "@/lib/utils"
import { measurementLabel } from "@/lib/drawings/measure"
import type { DrawingMarkup, DrawingPin } from "@/app/(app)/drawings/types"

export interface SVGOverlayHandle {
  /**
   * Apply the current image→screen transform. Called directly from the GPU
   * viewer's transform handler (potentially every frame), so it writes
   * straight to the DOM instead of going through React state.
   */
  setTransform: (matrix: ImageToScreenMatrix | null) => void
}

export interface SVGOverlayProps {
  ref?: Ref<SVGOverlayHandle>
  className?: string
  container: { width: number; height: number } | null
  imageSize: { width: number; height: number }
  markups: DrawingMarkup[]
  draftMarkups?: Array<{
    type: string
    points: Array<{ x: number; y: number }>
    color: string
    strokeWidth: number
    text?: string
    label?: string | null
  }>
  pins: DrawingPin[]
  showMarkups: boolean
  showPins: boolean
  highlightedPinId?: string
  interactive?: boolean
  onPinClick?: (pin: DrawingPin) => void
  /** Sheet calibration: measurement labels render in real units when set. */
  feetPerImagePx?: number | null
  /**
   * Render takeoff geometry — the markups bound to a condition. Off by
   * default: an estimator's areas, lines, and counts are working geometry, not
   * annotation, and outside takeoff mode nothing selects a condition, so they
   * would draw at full opacity over a sheet everyone else reads for
   * coordination. Only the takeoff surface passes this.
   */
  showTakeoff?: boolean
  /**
   * Takeoff mode. When a condition is selected, its geometry stays fully
   * opaque and everything else recedes, so an estimator can see exactly what
   * is counted without hiding the rest of the sheet.
   */
  selectedConditionId?: string | null
  /** Measured markups clicked in the panel; drawn with a halo. */
  highlightedMarkupIds?: ReadonlySet<string>
  onMarkupClick?: (markup: DrawingMarkup) => void
  /**
   * Vector-snap indicator (image px): where the cursor will land if clicked.
   * Drawn with the draft geometry so the estimator sees the snap before
   * committing to it.
   */
  snapIndicator?: { x: number; y: number; color: string } | null
}

type PxPoint = { x: number; y: number }

function toPxPoint(p: [number, number], imageSize: { width: number; height: number }): PxPoint {
  return { x: p[0] * imageSize.width, y: p[1] * imageSize.height }
}

function toTransformAttr(matrix: ImageToScreenMatrix) {
  return `matrix(${matrix.a} ${matrix.b} ${matrix.c} ${matrix.d} ${matrix.e} ${matrix.f})`
}

function pathFromPoints(points: PxPoint[], close: boolean): string {
  if (points.length === 0) return ""
  const d = points.map((p, i) => `${i === 0 ? "M" : "L"} ${p.x} ${p.y}`).join(" ")
  return close ? `${d} Z` : d
}

function centroidOf(points: PxPoint[]): PxPoint {
  let sx = 0
  let sy = 0
  for (const p of points) {
    sx += p.x
    sy += p.y
  }
  return { x: sx / points.length, y: sy / points.length }
}

/**
 * Measurement labels sit on a filled plate so a number stays readable over
 * hatching, dimension strings, and dark linework. Sized in image pixels so it
 * scales with the sheet exactly like the geometry does.
 */
function MeasurementLabel({
  x,
  y,
  text,
  color,
  anchor = "middle",
}: {
  x: number
  y: number
  text: string
  color: string
  anchor?: "middle" | "start"
}) {
  const padding = 4
  const fontSize = 13
  const width = text.length * fontSize * 0.58 + padding * 2
  const rectX = anchor === "middle" ? x - width / 2 : x - padding
  return (
    <g style={{ pointerEvents: "none" }}>
      <rect
        x={rectX}
        y={y - fontSize}
        width={width}
        height={fontSize + padding}
        fill={color}
        opacity={0.92}
      />
      <text
        x={anchor === "middle" ? x : x}
        y={y - padding}
        fill="#FFFFFF"
        fontSize={fontSize}
        fontWeight={600}
        textAnchor={anchor}
        style={{ fontVariantNumeric: "tabular-nums" }}
      >
        {text}
      </text>
    </g>
  )
}

export function SVGOverlay({
  ref,
  className,
  container,
  imageSize,
  markups,
  draftMarkups = [],
  pins,
  showMarkups,
  showPins,
  highlightedPinId,
  interactive = false,
  onPinClick,
  feetPerImagePx = null,
  showTakeoff = false,
  selectedConditionId = null,
  highlightedMarkupIds,
  onMarkupClick,
  snapIndicator = null,
}: SVGOverlayProps) {
  const gRef = useRef<SVGGElement>(null)
  const matrixRef = useRef<ImageToScreenMatrix | null>(null)

  const visibleMarkups = useMemo(
    () => (showTakeoff ? markups : markups.filter((m) => !m.condition_id)),
    [markups, showTakeoff]
  )

  const applyTransform = () => {
    const g = gRef.current
    if (!g) return
    const matrix = matrixRef.current
    if (matrix) {
      g.setAttribute("transform", toTransformAttr(matrix))
      g.style.visibility = "visible"
    } else {
      g.style.visibility = "hidden"
    }
  }

  useImperativeHandle(
    ref,
    () => ({
      setTransform: (matrix: ImageToScreenMatrix | null) => {
        matrixRef.current = matrix
        applyTransform()
      },
    }),
    []
  )

  // Re-apply after every commit: React never manages the transform attribute,
  // so a re-render (markups/pins changed) must not leave a stale/missing one.
  useLayoutEffect(() => {
    applyTransform()
  })

  if (!container) return null

  return (
    <svg
      className={cn("absolute inset-0", interactive ? "pointer-events-auto" : "pointer-events-none", className)}
      width={container.width}
      height={container.height}
      viewBox={`0 0 ${container.width} ${container.height}`}
      preserveAspectRatio="none"
    >
      <defs>
        <marker
          id="arrowhead"
          markerWidth="10"
          markerHeight="7"
          refX="9"
          refY="3.5"
          orient="auto"
        >
          <polygon points="0 0, 10 3.5, 0 7" fill="currentColor" />
        </marker>
      </defs>

      {/* Hidden until the first transform arrives; applyTransform flips it. */}
      <g ref={gRef} style={{ visibility: "hidden" }}>
        {/* Markups */}
        {showMarkups &&
          visibleMarkups.map((m) => (
            <MarkupShape
              key={m.id}
              markup={m}
              imageSize={imageSize}
              feetPerImagePx={feetPerImagePx}
              dimmed={!!selectedConditionId && m.condition_id !== selectedConditionId}
              highlighted={highlightedMarkupIds?.has(m.id) ?? false}
              onClick={onMarkupClick ? () => onMarkupClick(m) : undefined}
            />
          ))}
        {showMarkups &&
          draftMarkups.map((m, idx) => (
            <DraftMarkupShape key={`draft-${idx}`} markup={m} />
          ))}
        {showMarkups && snapIndicator && (
          <g style={{ pointerEvents: "none" }}>
            <circle
              cx={snapIndicator.x}
              cy={snapIndicator.y}
              r={7}
              fill="none"
              stroke={snapIndicator.color}
              strokeWidth={1.5}
              vectorEffect="non-scaling-stroke"
            />
            <circle cx={snapIndicator.x} cy={snapIndicator.y} r={2.5} fill={snapIndicator.color} />
          </g>
        )}

        {/* Pins */}
        {showPins &&
          pins.map((pin) => (
            <PinMarker
              key={pin.id}
              pin={pin}
              isHighlighted={pin.id === highlightedPinId}
              onClick={onPinClick ? () => onPinClick(pin) : undefined}
              imageSize={imageSize}
            />
          ))}
      </g>
    </svg>
  )
}

const DraftMarkupShape = memo(function DraftMarkupShape({
  markup,
}: {
  markup: {
    type: string
    points: Array<{ x: number; y: number }>
    color: string
    strokeWidth: number
    text?: string
    /** Pre-computed live measurement; the draft has no persisted quantity yet. */
    label?: string | null
  }
}) {
  const color = markup.color
  const strokeWidth = markup.strokeWidth
  const pts = markup.points

  switch (markup.type) {
    case "arrow":
      if (pts.length < 2) return null
      return (
        <line
          x1={pts[0].x}
          y1={pts[0].y}
          x2={pts[1].x}
          y2={pts[1].y}
          stroke={color}
          strokeWidth={strokeWidth}
          markerEnd="url(#arrowhead)"
          style={{ pointerEvents: "none" }}
        />
      )
    case "circle":
      if (pts.length < 2) return null
      return (
        <circle
          cx={pts[0].x}
          cy={pts[0].y}
          r={Math.hypot(pts[1].x - pts[0].x, pts[1].y - pts[0].y)}
          stroke={color}
          strokeWidth={strokeWidth}
          fill="none"
          style={{ pointerEvents: "none" }}
        />
      )
    case "rectangle":
      if (pts.length < 2) return null
      return (
        <rect
          x={Math.min(pts[0].x, pts[1].x)}
          y={Math.min(pts[0].y, pts[1].y)}
          width={Math.abs(pts[1].x - pts[0].x)}
          height={Math.abs(pts[1].y - pts[0].y)}
          stroke={color}
          strokeWidth={strokeWidth}
          fill="none"
          style={{ pointerEvents: "none" }}
        />
      )
    case "freehand":
      if (pts.length < 2) return null
      return (
        <path
          d={pts.map((p, i) => `${i === 0 ? "M" : "L"} ${p.x} ${p.y}`).join(" ")}
          stroke={color}
          strokeWidth={strokeWidth}
          fill="none"
          strokeLinecap="round"
          strokeLinejoin="round"
          style={{ pointerEvents: "none" }}
        />
      )
    case "highlight":
      if (pts.length < 2) return null
      return (
        <rect
          x={Math.min(pts[0].x, pts[1].x)}
          y={Math.min(pts[0].y, pts[1].y)}
          width={Math.abs(pts[1].x - pts[0].x)}
          height={Math.abs(pts[1].y - pts[0].y)}
          fill={color}
          opacity={0.25}
          style={{ pointerEvents: "none" }}
        />
      )
    case "text":
    case "callout":
      if (pts.length < 1 || !markup.text) return null
      return (
        <text x={pts[0].x} y={pts[0].y} fill={color} fontSize={14} style={{ pointerEvents: "none" }}>
          {markup.text}
        </text>
      )
    case "dimension": {
      if (pts.length < 2) return null
      const label = markup.label ?? null
      return (
        <g style={{ pointerEvents: "none" }}>
          <line x1={pts[0].x} y1={pts[0].y} x2={pts[1].x} y2={pts[1].y} stroke={color} strokeWidth={strokeWidth} />
          {label && (
            <MeasurementLabel
              x={(pts[0].x + pts[1].x) / 2}
              y={(pts[0].y + pts[1].y) / 2 - 6}
              text={label}
              color={color}
            />
          )}
        </g>
      )
    }
    // Takeoff drafts: committed geometry plus a rubber band to the cursor.
    case "polyline":
      if (pts.length < 1) return null
      return (
        <g style={{ pointerEvents: "none" }}>
          <path
            d={pathFromPoints(pts, false)}
            stroke={color}
            strokeWidth={strokeWidth + 1}
            fill="none"
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeDasharray="10 5"
            vectorEffect="non-scaling-stroke"
          />
          {pts.map((p, i) => (
            <circle key={i} cx={p.x} cy={p.y} r={strokeWidth + 2} fill={color} />
          ))}
          {markup.label && (
            <MeasurementLabel
              x={pts[pts.length - 1].x + 14}
              y={pts[pts.length - 1].y - 8}
              text={markup.label}
              color={color}
              anchor="start"
            />
          )}
        </g>
      )
    case "area":
      if (pts.length < 1) return null
      return (
        <g style={{ pointerEvents: "none" }}>
          {pts.length >= 3 && <path d={pathFromPoints(pts, true)} fill={color} opacity={0.14} />}
          <path
            d={pathFromPoints(pts, pts.length >= 3)}
            stroke={color}
            strokeWidth={strokeWidth + 1}
            fill="none"
            strokeLinejoin="round"
            strokeDasharray="10 5"
            vectorEffect="non-scaling-stroke"
          />
          {pts.map((p, i) => (
            // The first vertex is the close target, so it reads as a target.
            <circle
              key={i}
              cx={p.x}
              cy={p.y}
              r={i === 0 ? strokeWidth + 5 : strokeWidth + 2}
              fill={i === 0 ? "none" : color}
              stroke={color}
              strokeWidth={i === 0 ? 2 : 0}
            />
          ))}
          {markup.label && (
            <MeasurementLabel
              x={pts[pts.length - 1].x + 14}
              y={pts[pts.length - 1].y - 8}
              text={markup.label}
              color={color}
              anchor="start"
            />
          )}
        </g>
      )
    case "count":
      if (pts.length < 1) return null
      return (
        <g style={{ pointerEvents: "none" }}>
          {pts.map((p, i) => (
            <g key={i}>
              <circle cx={p.x} cy={p.y} r={9} fill={color} opacity={0.22} />
              <circle cx={p.x} cy={p.y} r={4.5} fill={color} />
            </g>
          ))}
          <MeasurementLabel
            x={pts[pts.length - 1].x + 12}
            y={pts[pts.length - 1].y - 6}
            text={`${pts.length}`}
            color={color}
            anchor="start"
          />
        </g>
      )
    case "cloud":
      if (pts.length < 2) return null
      return (
        <rect
          x={Math.min(pts[0].x, pts[1].x)}
          y={Math.min(pts[0].y, pts[1].y)}
          width={Math.abs(pts[1].x - pts[0].x)}
          height={Math.abs(pts[1].y - pts[0].y)}
          stroke={color}
          strokeWidth={strokeWidth}
          fill="none"
          strokeDasharray="6 4"
          style={{ pointerEvents: "none" }}
        />
      )
    default:
      return null
  }
})

const MarkupShape = memo(function MarkupShape({
  markup,
  imageSize,
  feetPerImagePx,
  dimmed = false,
  highlighted = false,
  onClick,
}: {
  markup: DrawingMarkup
  imageSize: { width: number; height: number }
  feetPerImagePx?: number | null
  dimmed?: boolean
  highlighted?: boolean
  onClick?: () => void
}) {
  const data = (markup as any).data as any
  const type = data?.type as string | undefined
  const color = (typeof data?.color === "string" ? data.color : "#EF4444") as string
  const strokeWidth = typeof data?.strokeWidth === "number" ? data.strokeWidth : 2
  const points: [number, number][] = Array.isArray(data?.points) ? data.points : []

  const px = points.map((p) => toPxPoint(p, imageSize))

  const shape = renderShape()
  if (!shape) return null

  // Takeoff focus: everything outside the selected condition recedes rather
  // than disappearing, so the estimator keeps context on the sheet.
  if (!dimmed && !highlighted && !onClick) return shape
  return (
    <g
      opacity={dimmed ? 0.18 : 1}
      onClick={onClick}
      className={onClick ? "cursor-pointer" : undefined}
      style={{ pointerEvents: onClick ? "auto" : "none" }}
    >
      {highlighted && <HighlightHalo points={px} type={type} color={color} />}
      {shape}
    </g>
  )

  function renderShape() {
  switch (type) {
    case "polyline": {
      if (px.length < 2) return null
      const label = measurementLabel({ type: "polyline", points }, imageSize, feetPerImagePx)
      const mid = px[Math.floor(px.length / 2)]
      return (
        <g style={{ pointerEvents: "none" }}>
          <path
            d={pathFromPoints(px, false)}
            stroke={color}
            strokeWidth={strokeWidth + 1}
            fill="none"
            strokeLinecap="round"
            strokeLinejoin="round"
            vectorEffect="non-scaling-stroke"
          />
          {px.map((p, i) => (
            <circle key={i} cx={p.x} cy={p.y} r={strokeWidth + 1.5} fill={color} />
          ))}
          {label && <MeasurementLabel x={mid.x} y={mid.y - 8} text={label} color={color} />}
        </g>
      )
    }
    case "area": {
      if (px.length < 3) return null
      const label = measurementLabel({ type: "area", points }, imageSize, feetPerImagePx)
      const center = centroidOf(px)
      return (
        <g style={{ pointerEvents: "none" }}>
          <path d={pathFromPoints(px, true)} fill={color} opacity={0.18} />
          <path
            d={pathFromPoints(px, true)}
            stroke={color}
            strokeWidth={strokeWidth + 1}
            fill="none"
            strokeLinejoin="round"
            vectorEffect="non-scaling-stroke"
          />
          {label && <MeasurementLabel x={center.x} y={center.y} text={label} color={color} />}
        </g>
      )
    }
    case "count": {
      if (px.length < 1) return null
      const last = px[px.length - 1]
      return (
        <g style={{ pointerEvents: "none" }}>
          {px.map((p, i) => (
            <g key={i}>
              <circle cx={p.x} cy={p.y} r={9} fill={color} opacity={0.22} />
              <circle cx={p.x} cy={p.y} r={4.5} fill={color} />
            </g>
          ))}
          <MeasurementLabel x={last.x + 12} y={last.y - 6} text={`${px.length}`} color={color} anchor="start" />
        </g>
      )
    }
    case "arrow": {
      if (px.length < 2) return null
      return (
        <line
          x1={px[0].x}
          y1={px[0].y}
          x2={px[1].x}
          y2={px[1].y}
          stroke={color}
          strokeWidth={strokeWidth}
          markerEnd="url(#arrowhead)"
          style={{ pointerEvents: "none" }}
        />
      )
    }
    case "circle": {
      if (px.length < 2) return null
      const dx = px[1].x - px[0].x
      const dy = px[1].y - px[0].y
      const r = Math.sqrt(dx * dx + dy * dy)
      return (
        <circle
          cx={px[0].x}
          cy={px[0].y}
          r={r}
          stroke={color}
          strokeWidth={strokeWidth}
          fill="none"
          style={{ pointerEvents: "none" }}
        />
      )
    }
    case "rectangle": {
      if (px.length < 2) return null
      const x = Math.min(px[0].x, px[1].x)
      const y = Math.min(px[0].y, px[1].y)
      const w = Math.abs(px[1].x - px[0].x)
      const h = Math.abs(px[1].y - px[0].y)
      return (
        <rect
          x={x}
          y={y}
          width={w}
          height={h}
          stroke={color}
          strokeWidth={strokeWidth}
          fill="none"
          style={{ pointerEvents: "none" }}
        />
      )
    }
    case "freehand": {
      if (px.length < 2) return null
      const d = px.map((p, i) => `${i === 0 ? "M" : "L"} ${p.x} ${p.y}`).join(" ")
      return (
        <path
          d={d}
          stroke={color}
          strokeWidth={strokeWidth}
          fill="none"
          strokeLinecap="round"
          strokeLinejoin="round"
          style={{ pointerEvents: "none" }}
        />
      )
    }
    case "highlight": {
      if (px.length < 2) return null
      const x = Math.min(px[0].x, px[1].x)
      const y = Math.min(px[0].y, px[1].y)
      const w = Math.abs(px[1].x - px[0].x)
      const h = Math.abs(px[1].y - px[0].y)
      return (
        <rect
          x={x}
          y={y}
          width={w}
          height={h}
          fill={color}
          opacity={0.25}
          style={{ pointerEvents: "none" }}
        />
      )
    }
    case "text":
    case "callout": {
      if (px.length < 1) return null
      const text = typeof data?.text === "string" ? data.text : ""
      if (!text) return null
      return (
        <text
          x={px[0].x}
          y={px[0].y}
          fill={color}
          fontSize={14}
          style={{ pointerEvents: "none" }}
        >
          {text}
        </text>
      )
    }
    case "dimension": {
      if (px.length < 2) return null
      const midX = (px[0].x + px[1].x) / 2
      const midY = (px[0].y + px[1].y) / 2
      const label = measurementLabel({ type: "dimension", points }, imageSize, feetPerImagePx)
      return (
        <g style={{ pointerEvents: "none" }}>
          <line
            x1={px[0].x}
            y1={px[0].y}
            x2={px[1].x}
            y2={px[1].y}
            stroke={color}
            strokeWidth={strokeWidth}
          />
          {label && <MeasurementLabel x={midX} y={midY - 6} text={label} color={color} />}
        </g>
      )
    }
    case "cloud": {
      if (px.length < 2) return null
      const x = Math.min(px[0].x, px[1].x)
      const y = Math.min(px[0].y, px[1].y)
      const w = Math.abs(px[1].x - px[0].x)
      const h = Math.abs(px[1].y - px[0].y)
      const r = Math.min(24, Math.max(8, Math.min(w, h) / 6))
      return (
        <rect
          x={x}
          y={y}
          width={w}
          height={h}
          rx={r}
          ry={r}
          stroke={color}
          strokeWidth={strokeWidth}
          fill="none"
          strokeDasharray="6 4"
          style={{ pointerEvents: "none" }}
        />
      )
    }
    default:
      return null
  }
  }
})

/**
 * The "you clicked this row in the takeoff panel" ring. Drawn under the shape
 * so it reads as a glow rather than an outline change.
 */
function HighlightHalo({
  points,
  type,
  color,
}: {
  points: PxPoint[]
  type: string | undefined
  color: string
}) {
  if (points.length === 0) return null
  if (type === "count") {
    return (
      <g style={{ pointerEvents: "none" }}>
        {points.map((p, i) => (
          <circle key={i} cx={p.x} cy={p.y} r={16} fill={color} opacity={0.28} />
        ))}
      </g>
    )
  }
  return (
    <path
      d={pathFromPoints(points, type === "area")}
      stroke={color}
      strokeWidth={14}
      strokeLinecap="round"
      strokeLinejoin="round"
      fill="none"
      opacity={0.28}
      vectorEffect="non-scaling-stroke"
      style={{ pointerEvents: "none" }}
    />
  )
}

const PinMarker = memo(function PinMarker({
  pin,
  isHighlighted,
  onClick,
  imageSize,
}: {
  pin: DrawingPin
  isHighlighted: boolean
  onClick?: () => void
  imageSize: { width: number; height: number }
}) {
  const x = (pin as any).x_position * imageSize.width
  const y = (pin as any).y_position * imageSize.height
  const status = (pin as any).status as string | undefined

  const color = getPinColor(status)

  return (
    <g
      transform={`translate(${x} ${y})`}
      onClick={onClick}
      className={cn(onClick ? "cursor-pointer" : "")}
      style={{ pointerEvents: onClick ? "auto" : "none" }}
    >
      {/* shadow */}
      <ellipse cx={0} cy={2} rx={8} ry={4} fill="rgba(0,0,0,0.2)" />
      {/* pin */}
      <path
        d="M0,-24 C-8,-24 -12,-16 -12,-12 C-12,-4 0,0 0,0 C0,0 12,-4 12,-12 C12,-16 8,-24 0,-24 Z"
        fill={color}
        stroke={isHighlighted ? "#fff" : "none"}
        strokeWidth={isHighlighted ? 2 : 0}
      />
      <circle cx={0} cy={-14} r={4} fill="#fff" />
    </g>
  )
})

function getPinColor(status?: string): string {
  switch (status) {
    case "open":
      return "#EF4444"
    case "in_progress":
      return "#F97316"
    case "closed":
    case "approved":
      return "#22C55E"
    default:
      return "#3B82F6"
  }
}
