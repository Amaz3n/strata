"use client"

import { useMemo } from "react"
import type { ImageToScreenMatrix } from "./tiled-drawing-viewer"
import { cn } from "@/lib/utils"
import type { DrawingMarkup, DrawingPin } from "@/app/(app)/drawings/actions"

export interface SVGOverlayProps {
  className?: string
  container: { width: number; height: number } | null
  matrix: ImageToScreenMatrix | null
  imageSize: { width: number; height: number }
  markups: DrawingMarkup[]
  draftMarkups?: Array<{
    type: string
    points: Array<{ x: number; y: number }>
    color: string
    strokeWidth: number
    text?: string
  }>
  pins: DrawingPin[]
  showMarkups: boolean
  showPins: boolean
  highlightedPinId?: string
  interactive?: boolean
  onPinClick?: (pin: DrawingPin) => void
}

type PxPoint = { x: number; y: number }

function toPxPoint(p: [number, number], imageSize: { width: number; height: number }): PxPoint {
  return { x: p[0] * imageSize.width, y: p[1] * imageSize.height }
}

export function SVGOverlay({
  className,
  container,
  matrix,
  imageSize,
  markups,
  draftMarkups = [],
  pins,
  showMarkups,
  showPins,
  highlightedPinId,
  interactive = false,
  onPinClick,
}: SVGOverlayProps) {
  const transform = useMemo(() => {
    if (!matrix) return null
    return `matrix(${matrix.a} ${matrix.b} ${matrix.c} ${matrix.d} ${matrix.e} ${matrix.f})`
  }, [matrix])

  if (!container || !transform) return null

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

      <g transform={transform}>
        {/* Markups */}
        {showMarkups &&
          markups.map((m) => (
            <MarkupShape key={m.id} markup={m} imageSize={imageSize} />
          ))}
        {showMarkups &&
          draftMarkups.map((m, idx) => (
            <DraftMarkupShape key={`draft-${idx}`} markup={m} />
          ))}

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

function DraftMarkupShape({
  markup,
}: {
  markup: {
    type: string
    points: Array<{ x: number; y: number }>
    color: string
    strokeWidth: number
    text?: string
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
    case "dimension":
      if (pts.length < 2) return null
      return (
        <g style={{ pointerEvents: "none" }}>
          <line x1={pts[0].x} y1={pts[0].y} x2={pts[1].x} y2={pts[1].y} stroke={color} strokeWidth={strokeWidth} />
          <text x={(pts[0].x + pts[1].x) / 2} y={(pts[0].y + pts[1].y) / 2 - 6} fill={color} fontSize={12}>
            {Math.round(Math.hypot(pts[1].x - pts[0].x, pts[1].y - pts[0].y))}px
          </text>
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
}

function MarkupShape({
  markup,
  imageSize,
}: {
  markup: DrawingMarkup
  imageSize: { width: number; height: number }
}) {
  const data = (markup as any).data as any
  const type = data?.type as string | undefined
  const color = (typeof data?.color === "string" ? data.color : "#EF4444") as string
  const strokeWidth = typeof data?.strokeWidth === "number" ? data.strokeWidth : 2
  const points: [number, number][] = Array.isArray(data?.points) ? data.points : []

  const px = points.map((p) => toPxPoint(p, imageSize))

  switch (type) {
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
      const dx = px[1].x - px[0].x
      const dy = px[1].y - px[0].y
      const dist = Math.sqrt(dx * dx + dy * dy)
      const midX = (px[0].x + px[1].x) / 2
      const midY = (px[0].y + px[1].y) / 2
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
          <text x={midX} y={midY - 6} fill={color} fontSize={12}>
            {Math.round(dist)}px
          </text>
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

function PinMarker({
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
}

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

