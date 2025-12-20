"use client"

import { useState, useRef, useCallback, useEffect } from "react"
import { toast } from "sonner"
import { cn } from "@/lib/utils"
import {
  ArrowRight,
  Circle,
  Square,
  Type,
  Pencil,
  MessageSquare,
  Ruler,
  Cloud,
  Highlighter,
  Trash2,
  Undo2,
  Save,
  Download,
  ZoomIn,
  ZoomOut,
  Move,
  X,
  MapPin,
  Eye,
  EyeOff,
  Layers,
  RotateCcw,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Badge } from "@/components/ui/badge"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Slider } from "@/components/ui/slider"
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { PIN_ENTITY_TYPE_LABELS } from "@/lib/validation/drawings"
import type { DrawingSheet, DrawingMarkup, DrawingPin, MarkupType } from "@/app/drawings/actions"
import { Document, Page, pdfjs } from "react-pdf"

pdfjs.GlobalWorkerOptions.workerSrc = `https://unpkg.com/pdfjs-dist@${pdfjs.version}/build/pdf.worker.min.mjs`

// Color palette for markups
const MARKUP_COLORS = [
  "#EF4444", // red
  "#F97316", // orange
  "#EAB308", // yellow
  "#22C55E", // green
  "#3B82F6", // blue
  "#8B5CF6", // purple
  "#EC4899", // pink
  "#000000", // black
]

// Stroke width options
const STROKE_WIDTHS = [1, 2, 3, 4, 6, 8]

// Markup tool definitions
const MARKUP_TOOLS: Array<{
  type: MarkupType
  icon: React.ElementType
  label: string
}> = [
  { type: "arrow", icon: ArrowRight, label: "Arrow" },
  { type: "circle", icon: Circle, label: "Circle" },
  { type: "rectangle", icon: Square, label: "Rectangle" },
  { type: "text", icon: Type, label: "Text" },
  { type: "freehand", icon: Pencil, label: "Freehand" },
  { type: "callout", icon: MessageSquare, label: "Callout" },
  { type: "dimension", icon: Ruler, label: "Dimension" },
  { type: "cloud", icon: Cloud, label: "Cloud" },
  { type: "highlight", icon: Highlighter, label: "Highlight" },
]

interface DrawingViewerProps {
  sheet: DrawingSheet
  fileUrl: string
  markups?: DrawingMarkup[]
  pins?: DrawingPin[]
  onClose: () => void
  onSaveMarkup?: (markup: Omit<DrawingMarkup, "id" | "org_id" | "created_at" | "updated_at">) => Promise<void>
  onDeleteMarkup?: (markupId: string) => Promise<void>
  onCreatePin?: (x: number, y: number) => void
  onPinClick?: (pin: DrawingPin) => void
  readOnly?: boolean
}

interface Point {
  x: number
  y: number
}

interface MarkupInProgress {
  type: MarkupType
  points: Point[]
  color: string
  strokeWidth: number
  text?: string
}

export function DrawingViewer({
  sheet,
  fileUrl,
  markups = [],
  pins = [],
  onClose,
  onSaveMarkup,
  onDeleteMarkup,
  onCreatePin,
  onPinClick,
  readOnly = false,
}: DrawingViewerProps) {
  // View state
  const [zoom, setZoom] = useState(1)
  const [pan, setPan] = useState({ x: 0, y: 0 })
  const [isPanning, setIsPanning] = useState(false)
  const [panStart, setPanStart] = useState({ x: 0, y: 0 })

  // Tool state
  const [activeTool, setActiveTool] = useState<MarkupType | "pan" | "pin" | null>("pan")
  const [selectedColor, setSelectedColor] = useState(MARKUP_COLORS[0])
  const [strokeWidth, setStrokeWidth] = useState(2)
  const [showMarkups, setShowMarkups] = useState(true)
  const [showPins, setShowPins] = useState(true)

  // Drawing state
  const [currentMarkup, setCurrentMarkup] = useState<MarkupInProgress | null>(null)
  const [isDrawing, setIsDrawing] = useState(false)
  const [textInput, setTextInput] = useState("")
  const [textDialogOpen, setTextDialogOpen] = useState(false)
  const [textPosition, setTextPosition] = useState<Point | null>(null)

  // History for undo
  const [localMarkups, setLocalMarkups] = useState<MarkupInProgress[]>([])
  const [history, setHistory] = useState<MarkupInProgress[][]>([])

  // Refs
  const containerRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const imageRef = useRef<HTMLImageElement>(null)
  const pdfCanvasRef = useRef<HTMLCanvasElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)

  const isPdf =
    fileUrl.endsWith(".pdf") || fileUrl.includes("application/pdf")
  const [contentSize, setContentSize] = useState<{ width: number; height: number } | null>(
    null
  )
  const [pdfRenderWidth, setPdfRenderWidth] = useState<number | null>(null)

  // Get normalized coordinates (0-1)
  const getNormalizedCoords = useCallback(
    (clientX: number, clientY: number): Point | null => {
      if (!containerRef.current || !contentRef.current) return null

      const imgRect = contentRef.current.getBoundingClientRect()

      // Get position relative to the image
      const x = (clientX - imgRect.left) / imgRect.width
      const y = (clientY - imgRect.top) / imgRect.height

      // Return null if outside image bounds
      if (x < 0 || x > 1 || y < 0 || y > 1) return null

      return { x, y }
    },
    []
  )

  // Handle mouse down
  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault()
      const coords = getNormalizedCoords(e.clientX, e.clientY)
      if (!coords) return

      if (activeTool === "pan") {
        setIsPanning(true)
        setPanStart({ x: e.clientX - pan.x, y: e.clientY - pan.y })
        return
      }

      if (activeTool === "pin" && onCreatePin) {
        onCreatePin(coords.x, coords.y)
        return
      }

      if (activeTool && activeTool !== "pan" && activeTool !== "pin" && !readOnly) {
        if (activeTool === "text" || activeTool === "callout") {
          setTextPosition(coords)
          setTextDialogOpen(true)
          return
        }

        setIsDrawing(true)
        setCurrentMarkup({
          type: activeTool,
          points: [coords],
          color: selectedColor,
          strokeWidth,
        })
      }
    },
    [activeTool, pan, getNormalizedCoords, selectedColor, strokeWidth, readOnly, onCreatePin]
  )

  // Handle mouse move
  const handleMouseMove = useCallback(
    (e: React.MouseEvent) => {
      if (isPanning) {
        setPan({
          x: e.clientX - panStart.x,
          y: e.clientY - panStart.y,
        })
        return
      }

      if (!isDrawing || !currentMarkup) return

      const coords = getNormalizedCoords(e.clientX, e.clientY)
      if (!coords) return

      if (currentMarkup.type === "freehand") {
        // Add point for freehand drawing
        setCurrentMarkup((prev) =>
          prev ? { ...prev, points: [...prev.points, coords] } : null
        )
      } else {
        // For other shapes, just update the second point
        setCurrentMarkup((prev) =>
          prev ? { ...prev, points: [prev.points[0], coords] } : null
        )
      }
    },
    [isPanning, panStart, isDrawing, currentMarkup, getNormalizedCoords]
  )

  // Handle mouse up
  const handleMouseUp = useCallback(() => {
    if (isPanning) {
      setIsPanning(false)
      return
    }

    if (isDrawing && currentMarkup && currentMarkup.points.length >= 2) {
      // Save to local markups
      setHistory((prev) => [...prev, localMarkups])
      setLocalMarkups((prev) => [...prev, currentMarkup])
    }

    setIsDrawing(false)
    setCurrentMarkup(null)
  }, [isPanning, isDrawing, currentMarkup, localMarkups])

  // Handle text submit
  const handleTextSubmit = async () => {
    if (!textPosition || !textInput.trim()) {
      setTextDialogOpen(false)
      setTextInput("")
      setTextPosition(null)
      return
    }

    const markup: MarkupInProgress = {
      type: activeTool === "callout" ? "callout" : "text",
      points: [textPosition],
      color: selectedColor,
      strokeWidth,
      text: textInput,
    }

    setHistory((prev) => [...prev, localMarkups])
    setLocalMarkups((prev) => [...prev, markup])

    setTextDialogOpen(false)
    setTextInput("")
    setTextPosition(null)
  }

  // Undo last markup
  const handleUndo = () => {
    if (history.length === 0) return
    const previousState = history[history.length - 1]
    setLocalMarkups(previousState)
    setHistory((prev) => prev.slice(0, -1))
  }

  // Clear all local markups
  const handleClear = () => {
    if (localMarkups.length === 0) return
    setHistory((prev) => [...prev, localMarkups])
    setLocalMarkups([])
  }

  // Save all markups
  const handleSave = async () => {
    if (!onSaveMarkup || localMarkups.length === 0) return

    try {
      for (const markup of localMarkups) {
        await onSaveMarkup({
          drawing_sheet_id: sheet.id,
          data: {
            type: markup.type,
            points: markup.points.map((p) => [p.x, p.y] as [number, number]),
            color: markup.color,
            strokeWidth: markup.strokeWidth,
            text: markup.text,
          },
          is_private: false,
          share_with_clients: false,
          share_with_subs: false,
        })
      }

      setLocalMarkups([])
      setHistory([])
      toast.success("Markups saved")
    } catch {
      toast.error("Failed to save markups")
    }
  }

  // Zoom controls
  const handleZoomIn = () => setZoom((z) => Math.min(z * 1.2, 5))
  const handleZoomOut = () => setZoom((z) => Math.max(z / 1.2, 0.5))
  const handleResetView = () => {
    setZoom(1)
    setPan({ x: 0, y: 0 })
  }

  // Render markup on canvas
  const renderMarkup = useCallback(
    (
      ctx: CanvasRenderingContext2D,
      markup: MarkupInProgress,
      canvasWidth: number,
      canvasHeight: number
    ) => {
      ctx.strokeStyle = markup.color
      ctx.fillStyle = markup.color
      ctx.lineWidth = markup.strokeWidth
      ctx.lineCap = "round"
      ctx.lineJoin = "round"

      const toCanvas = (p: Point) => ({
        x: p.x * canvasWidth,
        y: p.y * canvasHeight,
      })

      switch (markup.type) {
        case "arrow": {
          if (markup.points.length < 2) break
          const start = toCanvas(markup.points[0])
          const end = toCanvas(markup.points[1])

          // Draw line
          ctx.beginPath()
          ctx.moveTo(start.x, start.y)
          ctx.lineTo(end.x, end.y)
          ctx.stroke()

          // Draw arrowhead
          const angle = Math.atan2(end.y - start.y, end.x - start.x)
          const headLen = 15
          ctx.beginPath()
          ctx.moveTo(end.x, end.y)
          ctx.lineTo(
            end.x - headLen * Math.cos(angle - Math.PI / 6),
            end.y - headLen * Math.sin(angle - Math.PI / 6)
          )
          ctx.moveTo(end.x, end.y)
          ctx.lineTo(
            end.x - headLen * Math.cos(angle + Math.PI / 6),
            end.y - headLen * Math.sin(angle + Math.PI / 6)
          )
          ctx.stroke()
          break
        }

        case "circle": {
          if (markup.points.length < 2) break
          const center = toCanvas(markup.points[0])
          const edge = toCanvas(markup.points[1])
          const radius = Math.sqrt(
            Math.pow(edge.x - center.x, 2) + Math.pow(edge.y - center.y, 2)
          )
          ctx.beginPath()
          ctx.arc(center.x, center.y, radius, 0, 2 * Math.PI)
          ctx.stroke()
          break
        }

        case "rectangle": {
          if (markup.points.length < 2) break
          const p1 = toCanvas(markup.points[0])
          const p2 = toCanvas(markup.points[1])
          ctx.strokeRect(p1.x, p1.y, p2.x - p1.x, p2.y - p1.y)
          break
        }

        case "freehand": {
          if (markup.points.length < 2) break
          ctx.beginPath()
          const first = toCanvas(markup.points[0])
          ctx.moveTo(first.x, first.y)
          for (let i = 1; i < markup.points.length; i++) {
            const p = toCanvas(markup.points[i])
            ctx.lineTo(p.x, p.y)
          }
          ctx.stroke()
          break
        }

        case "text":
        case "callout": {
          if (markup.points.length < 1 || !markup.text) break
          const pos = toCanvas(markup.points[0])
          ctx.font = `${14 * (markup.strokeWidth / 2)}px sans-serif`
          ctx.fillText(markup.text, pos.x, pos.y)

          if (markup.type === "callout") {
            // Draw callout bubble
            const metrics = ctx.measureText(markup.text)
            const padding = 8
            ctx.strokeRect(
              pos.x - padding,
              pos.y - 14 * (markup.strokeWidth / 2) - padding,
              metrics.width + padding * 2,
              14 * (markup.strokeWidth / 2) + padding * 2
            )
          }
          break
        }

        case "cloud": {
          if (markup.points.length < 2) break
          const p1 = toCanvas(markup.points[0])
          const p2 = toCanvas(markup.points[1])

          // Draw a cloud-like shape with bumps
          const width = Math.abs(p2.x - p1.x)
          const height = Math.abs(p2.y - p1.y)
          const minX = Math.min(p1.x, p2.x)
          const minY = Math.min(p1.y, p2.y)

          ctx.beginPath()
          const bumps = 8
          const bumpRadius = width / bumps / 2

          for (let i = 0; i < bumps; i++) {
            ctx.arc(
              minX + bumpRadius + (i * width) / bumps,
              minY,
              bumpRadius,
              Math.PI,
              0
            )
          }
          for (let i = 0; i < bumps / 2; i++) {
            ctx.arc(
              minX + width,
              minY + bumpRadius * 2 + (i * height) / (bumps / 2),
              bumpRadius,
              -Math.PI / 2,
              Math.PI / 2
            )
          }
          for (let i = bumps - 1; i >= 0; i--) {
            ctx.arc(
              minX + bumpRadius + (i * width) / bumps,
              minY + height,
              bumpRadius,
              0,
              Math.PI
            )
          }
          for (let i = bumps / 2 - 1; i >= 0; i--) {
            ctx.arc(
              minX,
              minY + bumpRadius * 2 + (i * height) / (bumps / 2),
              bumpRadius,
              Math.PI / 2,
              -Math.PI / 2
            )
          }
          ctx.closePath()
          ctx.stroke()
          break
        }

        case "highlight": {
          if (markup.points.length < 2) break
          const p1 = toCanvas(markup.points[0])
          const p2 = toCanvas(markup.points[1])
          ctx.globalAlpha = 0.3
          ctx.fillRect(
            Math.min(p1.x, p2.x),
            Math.min(p1.y, p2.y),
            Math.abs(p2.x - p1.x),
            Math.abs(p2.y - p1.y)
          )
          ctx.globalAlpha = 1
          break
        }

        case "dimension": {
          if (markup.points.length < 2) break
          const start = toCanvas(markup.points[0])
          const end = toCanvas(markup.points[1])

          // Draw dimension line with ticks
          ctx.beginPath()
          ctx.moveTo(start.x, start.y)
          ctx.lineTo(end.x, end.y)
          ctx.stroke()

          // Draw tick marks
          const angle = Math.atan2(end.y - start.y, end.x - start.x)
          const perpAngle = angle + Math.PI / 2
          const tickLen = 10

          for (const p of [start, end]) {
            ctx.beginPath()
            ctx.moveTo(
              p.x - tickLen * Math.cos(perpAngle),
              p.y - tickLen * Math.sin(perpAngle)
            )
            ctx.lineTo(
              p.x + tickLen * Math.cos(perpAngle),
              p.y + tickLen * Math.sin(perpAngle)
            )
            ctx.stroke()
          }

          // Draw length label
          const dist = Math.sqrt(
            Math.pow(end.x - start.x, 2) + Math.pow(end.y - start.y, 2)
          )
          const midX = (start.x + end.x) / 2
          const midY = (start.y + end.y) / 2
          ctx.font = "12px sans-serif"
          ctx.fillText(`${Math.round(dist)}px`, midX, midY - 5)
          break
        }
      }
    },
    []
  )

  // Draw canvas
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || !contentSize) return

    const ctx = canvas.getContext("2d")
    if (!ctx) return

    // Clear canvas
    ctx.clearRect(0, 0, canvas.width, canvas.height)

    // Draw saved markups
    if (showMarkups) {
      for (const markup of markups) {
        renderMarkup(
          ctx,
          {
            type: markup.data.type,
            points: markup.data.points.map(([x, y]) => ({ x, y })),
            color: markup.data.color,
            strokeWidth: markup.data.strokeWidth,
            text: markup.data.text,
          },
          canvas.width,
          canvas.height
        )
      }

      // Draw local markups
      for (const markup of localMarkups) {
        renderMarkup(ctx, markup, canvas.width, canvas.height)
      }

      // Draw current markup
      if (currentMarkup) {
        renderMarkup(ctx, currentMarkup, canvas.width, canvas.height)
      }
    }
  }, [markups, localMarkups, currentMarkup, showMarkups, renderMarkup, contentSize])

  useEffect(() => {
    if (!contentSize || !canvasRef.current) return
    canvasRef.current.width = contentSize.width
    canvasRef.current.height = contentSize.height
  }, [contentSize])

  useEffect(() => {
    if (!isPdf || !containerRef.current) return

    const updateWidth = () => {
      const width = containerRef.current?.clientWidth ?? 0
      if (!width) return
      const targetWidth = Math.min(Math.max(width * 0.9, 900), 1800)
      setPdfRenderWidth(targetWidth)
    }

    updateWidth()
    const observer = new ResizeObserver(updateWidth)
    observer.observe(containerRef.current)

    return () => observer.disconnect()
  }, [isPdf])

  const syncPdfSize = useCallback(() => {
    const pdfCanvas = pdfCanvasRef.current
    if (!pdfCanvas) return
    const rect = pdfCanvas.getBoundingClientRect()
    if (!rect.width || !rect.height) return
    setContentSize({ width: rect.width, height: rect.height })
  }, [])

  // Get status color for pins
  const getStatusColor = (status?: string) => {
    switch (status) {
      case "open":
        return "#EF4444" // red
      case "in_progress":
        return "#F97316" // orange
      case "closed":
        return "#22C55E" // green
      case "pending":
        return "#EAB308" // yellow
      case "approved":
        return "#22C55E" // green
      case "rejected":
        return "#EF4444" // red
      default:
        return "#3B82F6" // blue
    }
  }

  return (
    <div className="fixed inset-0 z-50 bg-background">
      <div className="h-full w-full flex flex-col">
        {/* Header with tools */}
        <div className="p-4 border-b flex-shrink-0">
          <div className="flex items-center justify-between">
            <h2 className="flex items-center gap-2 text-lg font-semibold">
              {sheet.sheet_number}
              {sheet.sheet_title && (
                <span className="text-muted-foreground font-normal">
                  - {sheet.sheet_title}
                </span>
              )}
              {sheet.discipline && (
                <Badge variant="outline">{sheet.discipline}</Badge>
              )}
            </h2>

            <div className="flex items-center gap-2">
              <Button variant="ghost" size="icon" onClick={onClose}>
                <X className="h-4 w-4" />
              </Button>
            </div>
          </div>
        </div>

        <div className="flex flex-1 min-h-0">
          {/* Toolbar */}
          {!readOnly && (
            <div className="w-14 border-r bg-muted/30 flex flex-col items-center py-2 gap-1">
              <TooltipProvider>
                {/* Pan tool */}
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      variant={activeTool === "pan" ? "secondary" : "ghost"}
                      size="icon"
                      className="h-10 w-10"
                      onClick={() => setActiveTool("pan")}
                    >
                      <Move className="h-4 w-4" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent side="right">Pan</TooltipContent>
                </Tooltip>

                {/* Pin tool */}
                {onCreatePin && (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        variant={activeTool === "pin" ? "secondary" : "ghost"}
                        size="icon"
                        className="h-10 w-10"
                        onClick={() => setActiveTool("pin")}
                      >
                        <MapPin className="h-4 w-4" />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent side="right">Add Pin</TooltipContent>
                  </Tooltip>
                )}

                <div className="w-8 border-t my-2" />

                {/* Markup tools */}
                {MARKUP_TOOLS.map((tool) => (
                  <Tooltip key={tool.type}>
                    <TooltipTrigger asChild>
                      <Button
                        variant={activeTool === tool.type ? "secondary" : "ghost"}
                        size="icon"
                        className="h-10 w-10"
                        onClick={() => setActiveTool(tool.type)}
                      >
                        <tool.icon className="h-4 w-4" />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent side="right">{tool.label}</TooltipContent>
                  </Tooltip>
                ))}

                <div className="w-8 border-t my-2" />

                {/* Color picker */}
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button variant="ghost" size="icon" className="h-10 w-10">
                      <div
                        className="h-5 w-5 rounded-full border-2"
                        style={{ backgroundColor: selectedColor }}
                      />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent side="right" className="p-2">
                    <div className="grid grid-cols-4 gap-1">
                      {MARKUP_COLORS.map((color) => (
                        <button
                          key={color}
                          className={cn(
                            "h-6 w-6 rounded-full border-2",
                            selectedColor === color
                              ? "border-foreground"
                              : "border-transparent"
                          )}
                          style={{ backgroundColor: color }}
                          onClick={() => setSelectedColor(color)}
                        />
                      ))}
                    </div>
                  </DropdownMenuContent>
                </DropdownMenu>

                {/* Stroke width */}
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button variant="ghost" size="icon" className="h-10 w-10">
                      <div
                        className="rounded-full bg-current"
                        style={{ width: strokeWidth * 2, height: strokeWidth * 2 }}
                      />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent side="right" className="w-40 p-3">
                    <Label className="text-xs">Stroke Width</Label>
                    <Slider
                      value={[strokeWidth]}
                      min={1}
                      max={8}
                      step={1}
                      onValueChange={([v]) => setStrokeWidth(v)}
                      className="mt-2"
                    />
                  </DropdownMenuContent>
                </DropdownMenu>

                <div className="flex-1" />

                {/* Actions */}
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-10 w-10"
                      onClick={handleUndo}
                      disabled={history.length === 0}
                    >
                      <Undo2 className="h-4 w-4" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent side="right">Undo</TooltipContent>
                </Tooltip>

                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-10 w-10"
                      onClick={handleClear}
                      disabled={localMarkups.length === 0}
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent side="right">Clear</TooltipContent>
                </Tooltip>

                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-10 w-10"
                      onClick={handleSave}
                      disabled={localMarkups.length === 0 || !onSaveMarkup}
                    >
                      <Save className="h-4 w-4" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent side="right">Save Markups</TooltipContent>
                </Tooltip>
              </TooltipProvider>
            </div>
          )}

          {/* Main viewer */}
          <div className="flex-1 flex flex-col min-w-0">
            {/* View controls */}
            <div className="flex items-center justify-between p-2 border-b bg-muted/30">
              <div className="flex items-center gap-1">
                <Button variant="ghost" size="icon" onClick={handleZoomOut}>
                  <ZoomOut className="h-4 w-4" />
                </Button>
                <span className="text-sm w-16 text-center">
                  {Math.round(zoom * 100)}%
                </span>
                <Button variant="ghost" size="icon" onClick={handleZoomIn}>
                  <ZoomIn className="h-4 w-4" />
                </Button>
                <Button variant="ghost" size="icon" onClick={handleResetView}>
                  <RotateCcw className="h-4 w-4" />
                </Button>
              </div>

              <div className="flex items-center gap-2">
                <Button
                  variant={showMarkups ? "secondary" : "ghost"}
                  size="sm"
                  onClick={() => setShowMarkups(!showMarkups)}
                >
                  {showMarkups ? (
                    <Eye className="h-4 w-4 mr-1" />
                  ) : (
                    <EyeOff className="h-4 w-4 mr-1" />
                  )}
                  Markups
                </Button>

                <Button
                  variant={showPins ? "secondary" : "ghost"}
                  size="sm"
                  onClick={() => setShowPins(!showPins)}
                >
                  {showPins ? (
                    <Eye className="h-4 w-4 mr-1" />
                  ) : (
                    <EyeOff className="h-4 w-4 mr-1" />
                  )}
                  Pins
                </Button>

                <Button variant="outline" size="sm" asChild>
                  <a href={fileUrl} download target="_blank" rel="noreferrer">
                    <Download className="h-4 w-4 mr-1" />
                    Download
                  </a>
                </Button>
              </div>
            </div>

            {/* Drawing area */}
            <div
              ref={containerRef}
              className="flex-1 overflow-hidden bg-muted/50 relative"
              style={{ cursor: activeTool === "pan" ? "grab" : "crosshair" }}
              onMouseDown={handleMouseDown}
              onMouseMove={handleMouseMove}
              onMouseUp={handleMouseUp}
              onMouseLeave={handleMouseUp}
            >
              <div
                className="absolute inset-0 flex items-start justify-center"
                style={{
                  transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
                  transformOrigin: "center",
                }}
              >
                {/* PDF/Image */}
                <div
                  ref={contentRef}
                  className="relative inline-block bg-white shadow-lg"
                >
                  {isPdf ? (
                    <Document
                      file={fileUrl}
                      loading={null}
                      error={null}
                    >
                      <Page
                        pageNumber={1}
                        width={pdfRenderWidth ?? undefined}
                        renderTextLayer={false}
                        renderAnnotationLayer={false}
                        canvasRef={pdfCanvasRef}
                        onRenderSuccess={syncPdfSize}
                      />
                    </Document>
                  ) : (
                    <img
                      ref={imageRef}
                      src={fileUrl}
                      alt={sheet.sheet_number}
                      className="max-w-full max-h-full object-contain bg-white"
                      draggable={false}
                      onDragStart={(e) => e.preventDefault()}
                      onLoad={(e) => {
                        const rect = e.currentTarget.getBoundingClientRect()
                        if (rect.width && rect.height) {
                          setContentSize({ width: rect.width, height: rect.height })
                        }
                      }}
                    />
                  )}

                  {/* Canvas overlay for markups */}
                  <canvas
                    ref={canvasRef}
                    className="absolute inset-0 pointer-events-none"
                    style={{
                      width: contentSize?.width ?? "100%",
                      height: contentSize?.height ?? "100%",
                    }}
                  />

                  {/* Pins overlay */}
                  {showPins &&
                    pins.map((pin) => (
                      <button
                        key={pin.id}
                        className="absolute flex items-center justify-center w-6 h-6 -ml-3 -mt-6 hover:scale-110 transition-transform"
                        style={{
                          left: `${pin.x_position * 100}%`,
                          top: `${pin.y_position * 100}%`,
                        }}
                        onClick={(e) => {
                          e.stopPropagation()
                          onPinClick?.(pin)
                        }}
                        title={pin.entity_title ?? pin.label}
                      >
                        <MapPin
                          className="h-6 w-6 drop-shadow-md"
                          style={{ color: getStatusColor(pin.status) }}
                          fill="currentColor"
                        />
                      </button>
                    ))}
                </div>
              </div>
            </div>
          </div>

          {/* Pins sidebar */}
          {pins.length > 0 && (
            <div className="w-64 border-l bg-background flex flex-col">
              <div className="p-3 border-b font-medium flex items-center gap-2">
                <Layers className="h-4 w-4" />
                Linked Items ({pins.length})
              </div>
              <ScrollArea className="flex-1">
                <div className="p-2 space-y-2">
                  {pins.map((pin) => (
                    <button
                      key={pin.id}
                      className="w-full p-2 rounded-md border hover:bg-muted/50 text-left transition-colors"
                      onClick={() => onPinClick?.(pin)}
                    >
                      <div className="flex items-center gap-2">
                        <MapPin
                          className="h-4 w-4 flex-shrink-0"
                          style={{ color: getStatusColor(pin.status) }}
                        />
                        <span className="text-sm font-medium truncate">
                          {pin.entity_title ?? pin.label ?? "Untitled"}
                        </span>
                      </div>
                      <div className="flex items-center gap-2 mt-1 text-xs text-muted-foreground">
                        <Badge variant="outline" className="text-xs">
                          {PIN_ENTITY_TYPE_LABELS[pin.entity_type]}
                        </Badge>
                        {pin.status && (
                          <span className="capitalize">{pin.status}</span>
                        )}
                      </div>
                    </button>
                  ))}
                </div>
              </ScrollArea>
            </div>
          )}
        </div>

        {/* Text input dialog */}
        <Dialog open={textDialogOpen} onOpenChange={setTextDialogOpen}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>
                {activeTool === "callout" ? "Add Callout" : "Add Text"}
              </DialogTitle>
            </DialogHeader>
            <div>
              <Label htmlFor="text">Text</Label>
              <Input
                id="text"
                value={textInput}
                onChange={(e) => setTextInput(e.target.value)}
                placeholder="Enter text..."
                autoFocus
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    handleTextSubmit()
                  }
                }}
              />
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setTextDialogOpen(false)}>
                Cancel
              </Button>
              <Button onClick={handleTextSubmit}>Add</Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>
    </div>
  )
}
