"use client"

import { useEffect, useMemo, useRef, useState } from "react"
import { toast } from "sonner"

import { cn } from "@/lib/utils"
import type { DocumentFieldType } from "@/lib/types"
import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Separator } from "@/components/ui/separator"
import { Switch } from "@/components/ui/switch"
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip"
import {
  ArrowLeft,
  Calendar,
  Check,
  CheckSquare,
  ChevronLeft,
  ChevronRight,
  Mail,
  Loader2,
  PenLine,
  Trash2,
  Type,
  User,
  X,
  ZoomIn,
  ZoomOut,
} from "@/components/icons"

export type ESignFieldDraft = {
  id: string
  page_index: number
  field_type: DocumentFieldType
  label?: string
  required?: boolean
  signer_role?: string
  x: number
  y: number
  w: number
  h: number
  sort_order?: number
  metadata?: Record<string, any>
}

const FIELD_SIZES: Record<DocumentFieldType, { w: number; h: number; minW: number; minH: number }> = {
  signature: { w: 200, h: 60, minW: 120, minH: 40 },
  initials: { w: 80, h: 44, minW: 50, minH: 30 },
  name: { w: 180, h: 32, minW: 100, minH: 24 },
  text: { w: 200, h: 32, minW: 80, minH: 24 },
  date: { w: 120, h: 32, minW: 80, minH: 24 },
  checkbox: { w: 24, h: 24, minW: 18, minH: 18 },
}

const FIELD_CONFIG: Record<DocumentFieldType, { label: string; icon: typeof PenLine; shortLabel: string }> = {
  signature: { label: "Signature", icon: PenLine, shortLabel: "Sig" },
  initials: { label: "Initials", icon: Type, shortLabel: "Init" },
  name: { label: "Full Name", icon: User, shortLabel: "Name" },
  text: { label: "Text", icon: Type, shortLabel: "Text" },
  date: { label: "Date", icon: Calendar, shortLabel: "Date" },
  checkbox: { label: "Checkbox", icon: CheckSquare, shortLabel: "Check" },
}

const PLACEABLE_FIELD_TYPES: DocumentFieldType[] = ["signature", "initials", "text", "date", "checkbox"]

const FONT_SIZES = [
  { value: "10", label: "10px" },
  { value: "12", label: "12px" },
  { value: "14", label: "14px" },
  { value: "16", label: "16px" },
  { value: "18", label: "18px" },
]

const FONT_FAMILIES = [
  { value: "sans", label: "Sans Serif" },
  { value: "serif", label: "Serif" },
  { value: "mono", label: "Monospace" },
]

// Color classes for signers - maps to CSS variables defined in globals.css
const SIGNER_COLORS = [
  "signer-color-1", // Blue (primary)
  "signer-color-2", // Green
  "signer-color-3", // Amber
  "signer-color-4", // Purple
  "signer-color-5", // Rose
]

export type SignerRoleOption = {
  value: string
  label: string
}

const BASE_PAGE_WIDTH = 816 // Standard letter width at 96 DPI

interface ESignDocumentViewerProps {
  open: boolean
  onClose?: () => void
  title: string
  documentType: string
  fileUrl: string
  fields: ESignFieldDraft[]
  setFields: React.Dispatch<React.SetStateAction<ESignFieldDraft[]>>
  onSave: () => void
  signerRoles?: SignerRoleOption[]
  onSend?: () => void
  sendDisabled?: boolean
  sendLabel?: string
  sendLoading?: boolean
  embedded?: boolean
  className?: string
  onBack?: () => void
}

export function ESignDocumentViewer({
  open,
  onClose,
  title,
  documentType,
  fileUrl,
  fields,
  setFields,
  onSave,
  signerRoles = [],
  onSend,
  sendDisabled = false,
  sendLabel = "Send",
  sendLoading = false,
  embedded = false,
  className,
  onBack,
}: ESignDocumentViewerProps) {
  const [PDFComponents, setPDFComponents] = useState<{ Document: any; Page: any; pdfjs: any } | null>(null)
  const [pageCount, setPageCount] = useState(0)
  const [activeTool, setActiveTool] = useState<DocumentFieldType | null>(null)
  const [activeSignerRole, setActiveSignerRole] = useState(signerRoles[0]?.value ?? "")
  const [zoom, setZoom] = useState(1)
  const [activePage, setActivePage] = useState(0)
  const [selectedFieldId, setSelectedFieldId] = useState<string | null>(null)
  const pageRefs = useRef<Record<number, HTMLDivElement | null>>({})
  const overlayRefs = useRef<Record<number, HTMLDivElement | null>>({})
  const suppressPlacementUntilRef = useRef(0)
  const scrollContainerRef = useRef<HTMLDivElement | null>(null)

  const selectedField = useMemo(() => {
    if (!selectedFieldId) return null
    return fields.find((f) => f.id === selectedFieldId) ?? null
  }, [fields, selectedFieldId])

  // Load PDF components
  useEffect(() => {
    if (!open) return
    const loadPdf = async () => {
      try {
        const { Document, Page, pdfjs } = await import("react-pdf")
        pdfjs.GlobalWorkerOptions.workerSrc = `https://unpkg.com/pdfjs-dist@${pdfjs.version}/build/pdf.worker.min.mjs`
        setPDFComponents({ Document, Page, pdfjs })
      } catch (error) {
        console.error("Failed to load PDF components", error)
        toast.error("Failed to load PDF renderer")
      }
    }
    loadPdf()
  }, [open])

  // Sync active signer role with available options
  useEffect(() => {
    if (signerRoles.length === 0) return
    const hasActiveRole = signerRoles.some((role) => role.value === activeSignerRole)
    if (!hasActiveRole) {
      setActiveSignerRole(signerRoles[0].value)
    }
  }, [activeSignerRole, signerRoles])

  const pageWidth = Math.round(BASE_PAGE_WIDTH * zoom)

  // Get color class for a signer role
  const getSignerColorClass = (signerRole?: string) => {
    if (!signerRole) return SIGNER_COLORS[0]
    const index = signerRoles.findIndex((r) => r.value === signerRole)
    return SIGNER_COLORS[index >= 0 ? index % SIGNER_COLORS.length : 0]
  }

  // Get signer label from role
  const getSignerLabel = (signerRole?: string) => {
    if (!signerRole) return signerRoles[0]?.label ?? "Signer"
    const signer = signerRoles.find((r) => r.value === signerRole)
    return signer?.label ?? signerRole
  }

  // Group fields by page
  const fieldsByPage = useMemo(() => {
    return fields.reduce<Record<number, ESignFieldDraft[]>>((acc, field) => {
      acc[field.page_index] = acc[field.page_index] ? [...acc[field.page_index], field] : [field]
      return acc
    }, {})
  }, [fields])

  const handlePlaceField = (pageIndex: number, event: React.MouseEvent<HTMLDivElement>) => {
    if (Date.now() < suppressPlacementUntilRef.current) return
    if (!activeTool) {
      return
    }

    const rect = event.currentTarget.getBoundingClientRect()
    const size = FIELD_SIZES[activeTool]
    const rawX = (event.clientX - rect.left) / rect.width
    const rawY = (event.clientY - rect.top) / rect.height

    const w = Math.min(size.w / BASE_PAGE_WIDTH, 1)
    const h = Math.min(size.h / BASE_PAGE_WIDTH, 1)
    const x = Math.min(Math.max(rawX - w / 2, 0), 1 - w)
    const y = Math.min(Math.max(rawY - h / 2, 0), 1 - h)
    const id = crypto.randomUUID()

    const signerRoleForField = activeSignerRole || signerRoles[0]?.value || ""
    setFields((prev) => [
      ...prev,
      {
        id,
        page_index: pageIndex,
        field_type: activeTool,
        label: FIELD_CONFIG[activeTool].label,
        required: true,
        signer_role: signerRoleForField,
        x,
        y,
        w,
        h,
        sort_order: prev.length,
      },
    ])
    setActiveTool(null)
  }

  const handleRemoveField = (id: string) => {
    setFields((prev) => prev.filter((field) => field.id !== id))
    if (selectedFieldId === id) setSelectedFieldId(null)
  }

  const handleSelectField = (id: string) => {
    setSelectedFieldId(id)
    const field = fields.find((item) => item.id === id)
    if (field?.signer_role) {
      setActiveSignerRole(field.signer_role)
    }
  }

  const handleUpdateField = (id: string, updates: Partial<ESignFieldDraft>) => {
    setFields((prev) => prev.map((f) => (f.id === id ? { ...f, ...updates } : f)))
    if (updates.signer_role) {
      setActiveSignerRole(updates.signer_role)
    }
  }

  const handleUpdateFieldMetadata = (id: string, metadataUpdates: Record<string, any>) => {
    setFields((prev) =>
      prev.map((f) =>
        f.id === id ? { ...f, metadata: { ...(f.metadata ?? {}), ...metadataUpdates } } : f
      )
    )
  }

  const resolveFieldSignerRole = (field: ESignFieldDraft) => {
    const fallback = signerRoles[0]?.value ?? ""
    if (!field.signer_role) return fallback
    return signerRoles.some((role) => role.value === field.signer_role) ? field.signer_role : fallback
  }

  const startDragField = (event: React.MouseEvent<HTMLDivElement>, field: ESignFieldDraft) => {
    event.preventDefault()
    event.stopPropagation()
    const overlay = overlayRefs.current[field.page_index]
    if (!overlay) return

    const rect = overlay.getBoundingClientRect()
    const startClientX = event.clientX
    const startClientY = event.clientY
    const startX = field.x
    const startY = field.y
    let moved = false
    let rafId: number | null = null
    let pendingPosition: { x: number; y: number } | null = null

    const flushMove = () => {
      if (!pendingPosition) return
      const { x: nextX, y: nextY } = pendingPosition
      pendingPosition = null
      setFields((prev) =>
        prev.map((item) => (item.id === field.id ? { ...item, x: nextX, y: nextY } : item)),
      )
    }

    const onMouseMove = (moveEvent: MouseEvent) => {
      const dxPx = moveEvent.clientX - startClientX
      const dyPx = moveEvent.clientY - startClientY
      if (Math.abs(dxPx) > 2 || Math.abs(dyPx) > 2) moved = true

      const dx = dxPx / rect.width
      const dy = dyPx / rect.height
      const nextX = Math.min(Math.max(startX + dx, 0), 1 - field.w)
      const nextY = Math.min(Math.max(startY + dy, 0), 1 - field.h)
      pendingPosition = { x: nextX, y: nextY }
      if (rafId === null) {
        rafId = window.requestAnimationFrame(() => {
          rafId = null
          flushMove()
        })
      }
    }

    const onMouseUp = () => {
      if (rafId !== null) {
        window.cancelAnimationFrame(rafId)
        rafId = null
      }
      flushMove()
      window.removeEventListener("mousemove", onMouseMove)
      window.removeEventListener("mouseup", onMouseUp)
      if (moved) suppressPlacementUntilRef.current = Date.now() + 150
    }

    window.addEventListener("mousemove", onMouseMove)
    window.addEventListener("mouseup", onMouseUp)
  }

  const startResizeField = (
    event: React.MouseEvent<HTMLDivElement>,
    field: ESignFieldDraft,
    corner: "se" | "sw" | "ne" | "nw" | "n" | "s" | "e" | "w"
  ) => {
    event.preventDefault()
    event.stopPropagation()
    const overlay = overlayRefs.current[field.page_index]
    if (!overlay) return

    const rect = overlay.getBoundingClientRect()
    const startClientX = event.clientX
    const startClientY = event.clientY
    const startX = field.x
    const startY = field.y
    const startW = field.w
    const startH = field.h
    let rafId: number | null = null
    let pendingRect: { x: number; y: number; w: number; h: number } | null = null

    const minW = (FIELD_SIZES[field.field_type]?.minW ?? 50) / BASE_PAGE_WIDTH
    const minH = (FIELD_SIZES[field.field_type]?.minH ?? 24) / BASE_PAGE_WIDTH

    const flushResize = () => {
      if (!pendingRect) return
      const { x, y, w, h } = pendingRect
      pendingRect = null
      setFields((prev) =>
        prev.map((item) =>
          item.id === field.id ? { ...item, x, y, w, h } : item
        )
      )
    }

    const onMouseMove = (moveEvent: MouseEvent) => {
      const dxPx = moveEvent.clientX - startClientX
      const dyPx = moveEvent.clientY - startClientY
      const dx = dxPx / rect.width
      const dy = dyPx / rect.height

      let newX = startX
      let newY = startY
      let newW = startW
      let newH = startH

      if (corner.includes("e")) {
        newW = Math.max(minW, Math.min(startW + dx, 1 - startX))
      }
      if (corner.includes("s")) {
        newH = Math.max(minH, Math.min(startH + dy, 1 - startY))
      }
      if (corner.includes("w")) {
        const maxX = startX + startW - minW
        newX = Math.max(0, Math.min(startX + dx, maxX))
        newW = Math.max(minW, startW + (startX - newX))
      }
      if (corner.includes("n")) {
        const maxY = startY + startH - minH
        newY = Math.max(0, Math.min(startY + dy, maxY))
        newH = Math.max(minH, startH + (startY - newY))
      }

      newW = Math.min(newW, 1 - newX)
      newH = Math.min(newH, 1 - newY)

      pendingRect = { x: newX, y: newY, w: newW, h: newH }
      if (rafId === null) {
        rafId = window.requestAnimationFrame(() => {
          rafId = null
          flushResize()
        })
      }
    }

    const onMouseUp = () => {
      if (rafId !== null) {
        window.cancelAnimationFrame(rafId)
        rafId = null
      }
      flushResize()
      window.removeEventListener("mousemove", onMouseMove)
      window.removeEventListener("mouseup", onMouseUp)
      suppressPlacementUntilRef.current = Date.now() + 150
    }

    window.addEventListener("mousemove", onMouseMove)
    window.addEventListener("mouseup", onMouseUp)
  }

  const goToPage = (index: number) => {
    const target = Math.max(0, Math.min(index, Math.max(pageCount - 1, 0)))
    setActivePage(target)
    pageRefs.current[target]?.scrollIntoView({ behavior: "smooth", block: "start" })
  }

  const adjustZoom = (delta: number) => {
    setZoom((z) => Math.min(1.5, Math.max(0.6, Math.round((z + delta) * 10) / 10)))
  }

  if (!open) return null

  return (
    <div className={cn("h-full w-full flex flex-col bg-background", className)}>
      {/* Toolbar */}
      <div className="flex-shrink-0 border-b bg-muted/30">
        <div className="relative flex items-center justify-between px-4 py-3 gap-4">
          {/* Left: Field tools */}
          <div className="flex items-center gap-3">
            {/* Field type buttons */}
            <TooltipProvider delayDuration={300}>
              <div className="flex items-center gap-1">
                {PLACEABLE_FIELD_TYPES.map((type) => {
                  const config = FIELD_CONFIG[type]
                  const Icon = config.icon
                  const isActive = activeTool === type
                  return (
                    <Tooltip key={type}>
                      <TooltipTrigger asChild>
                        <Button
                          variant={isActive ? "default" : "ghost"}
                          size="sm"
                          className={cn("h-9 px-3 gap-1.5", isActive && "shadow-sm")}
                          onClick={() => setActiveTool((current) => (current === type ? null : type))}
                        >
                          <Icon className="h-4 w-4" />
                          <span className="hidden sm:inline text-xs">{config.shortLabel}</span>
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent side="bottom">
                        <p>{config.label}</p>
                        <p className="text-xs text-muted-foreground">Click on document to place</p>
                      </TooltipContent>
                    </Tooltip>
                  )
                })}
              </div>
            </TooltipProvider>
          </div>

          {/* Center: Page navigation (absolutely centered) */}
          <div className="absolute left-1/2 -translate-x-1/2 flex items-center gap-1">
            {pageCount > 1 ? (
              <>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8"
                  onClick={() => goToPage(activePage - 1)}
                  disabled={activePage === 0}
                >
                  <ChevronLeft className="h-4 w-4" />
                </Button>
                <span className="text-sm text-muted-foreground min-w-[60px] text-center">
                  {activePage + 1} / {pageCount}
                </span>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8"
                  onClick={() => goToPage(activePage + 1)}
                  disabled={activePage >= pageCount - 1}
                >
                  <ChevronRight className="h-4 w-4" />
                </Button>
              </>
            ) : (
              <span className="text-sm font-medium truncate max-w-[200px]">{title}</span>
            )}
          </div>

          {/* Right: Zoom controls */}
          <div className="flex items-center gap-1 ml-auto">
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8"
              onClick={() => adjustZoom(-0.1)}
              disabled={zoom <= 0.6}
            >
              <ZoomOut className="h-4 w-4" />
            </Button>
            <span className="text-xs text-muted-foreground min-w-[40px] text-center">
              {Math.round(zoom * 100)}%
            </span>
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8"
              onClick={() => adjustZoom(0.1)}
              disabled={zoom >= 1.5}
            >
              <ZoomIn className="h-4 w-4" />
            </Button>
          </div>
        </div>
      </div>

      {/* Main content area with optional sidebar */}
      <div className="flex-1 min-h-0 relative overflow-hidden">
        {/* Field Settings Sidebar */}
        <div
          className={cn(
            "absolute left-0 top-0 bottom-0 z-20 w-72 border-r bg-background shadow-sm flex flex-col",
            "transition-transform duration-200 ease-out",
            selectedField ? "translate-x-0" : "-translate-x-full pointer-events-none",
          )}
        >
          {selectedField && (
            <>
              <div className="flex items-center justify-between px-4 py-3 border-b">
                <div>
                  <h3 className="text-sm font-semibold">{FIELD_CONFIG[selectedField.field_type].label}</h3>
                  <p className="text-xs text-muted-foreground">Field settings</p>
                </div>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8"
                  onClick={() => setSelectedFieldId(null)}
                >
                  <X className="h-4 w-4" />
                </Button>
              </div>

              <ScrollArea className="flex-1">
                <div className="p-4 space-y-6">
                  {/* Assigned signer */}
                  <div className="space-y-2">
                    <Label className="text-xs font-medium">Assigned to</Label>
                    <Select
                      value={resolveFieldSignerRole(selectedField)}
                      onValueChange={(value) => handleUpdateField(selectedField.id, { signer_role: value })}
                    >
                      <SelectTrigger className="w-full">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {signerRoles.map((role, index) => (
                          <SelectItem key={role.value} value={role.value}>
                            <div className="flex items-center gap-2">
                              <div className={cn("w-2 h-2 rounded-full esign-field-dot", SIGNER_COLORS[index % SIGNER_COLORS.length])} />
                              <span>{role.label}</span>
                            </div>
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>

                  {/* Required toggle */}
                  <div className="flex items-center justify-between">
                    <Label className="text-xs font-medium">Required</Label>
                    <Switch
                      checked={selectedField.required !== false}
                      onCheckedChange={(checked) => handleUpdateField(selectedField.id, { required: checked })}
                    />
                  </div>

                  <Separator />

                  {/* Text/Name specific settings */}
                  {(selectedField.field_type === "text" || selectedField.field_type === "name") && (
                    <>
                      <div className="space-y-2">
                        <Label className="text-xs font-medium">Font Size</Label>
                        <Select
                          value={selectedField.metadata?.fontSize ?? "14"}
                          onValueChange={(value) => handleUpdateFieldMetadata(selectedField.id, { fontSize: value })}
                        >
                          <SelectTrigger className="w-full">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            {FONT_SIZES.map((size) => (
                              <SelectItem key={size.value} value={size.value}>
                                {size.label}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>

                      <div className="space-y-2">
                        <Label className="text-xs font-medium">Font Style</Label>
                        <Select
                          value={selectedField.metadata?.fontFamily ?? "sans"}
                          onValueChange={(value) => handleUpdateFieldMetadata(selectedField.id, { fontFamily: value })}
                        >
                          <SelectTrigger className="w-full">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            {FONT_FAMILIES.map((font) => (
                              <SelectItem key={font.value} value={font.value}>
                                {font.label}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                    </>
                  )}

                  {/* Signature specific settings */}
                  {selectedField.field_type === "signature" && (
                    <div className="space-y-2">
                      <Label className="text-xs font-medium">Signature Style</Label>
                      <Select
                        value={selectedField.metadata?.signatureStyle ?? "draw"}
                        onValueChange={(value) => handleUpdateFieldMetadata(selectedField.id, { signatureStyle: value })}
                      >
                        <SelectTrigger className="w-full">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="draw">Draw signature</SelectItem>
                          <SelectItem value="type">Type signature</SelectItem>
                          <SelectItem value="upload">Upload image</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                  )}

                  {/* Date specific settings */}
                  {selectedField.field_type === "date" && (
                    <div className="space-y-2">
                      <Label className="text-xs font-medium">Date Format</Label>
                      <Select
                        value={selectedField.metadata?.dateFormat ?? "MM/DD/YYYY"}
                        onValueChange={(value) => handleUpdateFieldMetadata(selectedField.id, { dateFormat: value })}
                      >
                        <SelectTrigger className="w-full">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="MM/DD/YYYY">MM/DD/YYYY</SelectItem>
                          <SelectItem value="DD/MM/YYYY">DD/MM/YYYY</SelectItem>
                          <SelectItem value="YYYY-MM-DD">YYYY-MM-DD</SelectItem>
                          <SelectItem value="MMM D, YYYY">MMM D, YYYY</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                  )}

                  <Separator />

                  {/* Delete field button */}
                  <Button
                    variant="destructive"
                    size="sm"
                    className="w-full"
                    onClick={() => handleRemoveField(selectedField.id)}
                  >
                    <Trash2 className="h-4 w-4 mr-2" />
                    Delete field
                  </Button>
                </div>
              </ScrollArea>
            </>
          )}
        </div>

        {/* PDF Viewer */}
        <div className="h-full w-full bg-muted/20 overflow-hidden" ref={scrollContainerRef}>
          {!PDFComponents ? (
          <div className="flex h-full items-center justify-center">
            <div className="flex flex-col items-center gap-3">
              <div className="h-8 w-8 animate-spin rounded-full border-2 border-primary border-t-transparent" />
              <p className="text-sm text-muted-foreground">Loading document...</p>
            </div>
          </div>
        ) : (
          <ScrollArea className="h-full">
            <div className="py-6 px-4">
              <div className="mx-auto" style={{ maxWidth: pageWidth + 48 }}>
                <PDFComponents.Document
                  file={fileUrl}
                  onLoadSuccess={(info: { numPages: number }) => setPageCount(info.numPages)}
                  onLoadError={(error: any) => {
                    console.error("Failed to load PDF", error)
                    toast.error("Failed to load PDF")
                  }}
                  className="space-y-4"
                >
                  {Array.from({ length: pageCount || 1 }).map((_, pageIndex) => (
                    <div
                      key={pageIndex}
                      ref={(el) => {
                        pageRefs.current[pageIndex] = el
                      }}
                      className="relative mx-auto"
                      onFocus={() => setActivePage(pageIndex)}
                    >
                      {/* PDF Page with field overlay */}
                      <div
                        className={cn(
                          "relative rounded-lg border bg-white shadow-sm overflow-hidden",
                          activeTool ? "cursor-crosshair" : "cursor-default",
                        )}
                        onClick={(event) => {
                          setSelectedFieldId(null)
                          handlePlaceField(pageIndex, event)
                        }}
                      >
                        <PDFComponents.Page
                          pageNumber={pageIndex + 1}
                          width={pageWidth}
                          renderTextLayer={false}
                          renderAnnotationLayer={false}
                        />

                        {/* Field overlay */}
                        <div
                          className="absolute inset-0 pointer-events-none"
                          ref={(el) => {
                            overlayRefs.current[pageIndex] = el
                          }}
                        >
                          {(fieldsByPage[pageIndex] ?? []).map((field) => {
                            const colorClass = getSignerColorClass(resolveFieldSignerRole(field))
                            const signerLabel = getSignerLabel(resolveFieldSignerRole(field))
                            const fieldConfig = FIELD_CONFIG[field.field_type]
                            const isSelected = selectedFieldId === field.id
                            const Icon = fieldConfig.icon

                            return (
                              <div
                                key={field.id}
                                className={cn(
                                  "group absolute pointer-events-auto cursor-move will-change-transform",
                                  isSelected && "z-10",
                                )}
                                style={{
                                  left: `${field.x * 100}%`,
                                  top: `${field.y * 100}%`,
                                  width: `${field.w * 100}%`,
                                  height: `${field.h * 100}%`,
                                }}
                                onClick={(event) => {
                                  event.stopPropagation()
                                  handleSelectField(field.id)
                                }}
                                onMouseDown={(event) => {
                                  if ((event.target as HTMLElement).dataset.resize) return
                                  startDragField(event, field)
                                }}
                              >
                                {/* Field visual based on type */}
                                {field.field_type === "signature" && (
                                  <div
                                    className={cn(
                                      "h-full rounded-lg border-2 border-dashed esign-field",
                                      "text-zinc-800 dark:text-zinc-800",
                                      "flex flex-col items-center justify-center gap-1",
                                      "bg-gradient-to-br from-white/80 to-white/40",
                                      isSelected && "ring-2 ring-primary ring-offset-1",
                                      colorClass,
                                    )}
                                  >
                                    <PenLine className="h-5 w-5 opacity-40" />
                                    <span className="text-[10px] font-medium opacity-60">Sign here</span>
                                    <span className="text-[9px] opacity-40">{signerLabel}</span>
                                  </div>
                                )}

                                {field.field_type === "initials" && (
                                  <div
                                    className={cn(
                                      "h-full rounded-lg border-2 border-dashed esign-field",
                                      "text-zinc-800 dark:text-zinc-800",
                                      "flex flex-col items-center justify-center",
                                      "bg-gradient-to-br from-white/80 to-white/40",
                                      isSelected && "ring-2 ring-primary ring-offset-1",
                                      colorClass,
                                    )}
                                  >
                                    <span className="text-xs font-semibold opacity-50">AB</span>
                                    <span className="text-[8px] opacity-40">{signerLabel}</span>
                                  </div>
                                )}

                                {field.field_type === "name" && (
                                  <div
                                    className={cn(
                                      "h-full rounded border-2 esign-field",
                                      "text-zinc-800 dark:text-zinc-800",
                                      "flex items-center px-2 gap-1.5",
                                      "bg-white/60",
                                      isSelected && "ring-2 ring-primary ring-offset-1",
                                      colorClass,
                                    )}
                                  >
                                    <User className="h-3.5 w-3.5 opacity-40 flex-shrink-0" />
                                    <div className="flex-1 border-b border-current/20" />
                                    <span className="text-[8px] opacity-40 flex-shrink-0">{signerLabel}</span>
                                  </div>
                                )}

                                {field.field_type === "text" && (
                                  <div
                                    className={cn(
                                      "h-full rounded border-2 esign-field",
                                      "text-zinc-800 dark:text-zinc-800",
                                      "flex items-center px-2 gap-1.5",
                                      "bg-white/60",
                                      isSelected && "ring-2 ring-primary ring-offset-1",
                                      colorClass,
                                    )}
                                  >
                                    <Type className="h-3.5 w-3.5 opacity-40 flex-shrink-0" />
                                    <div className="flex-1 border-b border-current/20" />
                                    <span className="text-[8px] opacity-40 flex-shrink-0">{signerLabel}</span>
                                  </div>
                                )}

                                {field.field_type === "date" && (
                                  <div
                                    className={cn(
                                      "h-full rounded border-2 esign-field",
                                      "text-zinc-800 dark:text-zinc-800",
                                      "flex items-center px-2 gap-1.5",
                                      "bg-white/60",
                                      isSelected && "ring-2 ring-primary ring-offset-1",
                                      colorClass,
                                    )}
                                  >
                                    <Calendar className="h-3.5 w-3.5 opacity-40 flex-shrink-0" />
                                    <span className="text-[10px] opacity-40">MM/DD/YYYY</span>
                                    <span className="text-[8px] opacity-40 flex-shrink-0 ml-auto">{signerLabel}</span>
                                  </div>
                                )}

                                {field.field_type === "checkbox" && (
                                  <div
                                    className={cn(
                                      "h-full rounded border-2 esign-field",
                                      "text-zinc-800 dark:text-zinc-800",
                                      "flex items-center justify-center",
                                      "bg-white/60",
                                      isSelected && "ring-2 ring-primary ring-offset-1",
                                      colorClass,
                                    )}
                                  >
                                    <Check className="h-3 w-3 opacity-30" />
                                  </div>
                                )}

                                {/* Resize handles - show on hover or selection */}
                                {(isSelected || field.field_type !== "checkbox") && (
                                  <>
                                    <div
                                      data-resize="se"
                                      className={cn(
                                        "absolute -bottom-1.5 -right-1.5 h-3 w-3 rounded-full bg-primary border-2 border-white",
                                        "cursor-se-resize opacity-0 group-hover:opacity-100 transition-opacity shadow-sm",
                                        isSelected && "opacity-100",
                                      )}
                                      onMouseDown={(e) => startResizeField(e, field, "se")}
                                    />
                                    {isSelected && (
                                      <>
                                        <div
                                          data-resize="sw"
                                          className="absolute -bottom-1.5 -left-1.5 h-3 w-3 rounded-full bg-primary border-2 border-white cursor-sw-resize shadow-sm"
                                          onMouseDown={(e) => startResizeField(e, field, "sw")}
                                        />
                                        <div
                                          data-resize="ne"
                                          className="absolute -top-1.5 -right-1.5 h-3 w-3 rounded-full bg-primary border-2 border-white cursor-ne-resize shadow-sm"
                                          onMouseDown={(e) => startResizeField(e, field, "ne")}
                                        />
                                        <div
                                          data-resize="nw"
                                          className="absolute -top-1.5 -left-1.5 h-3 w-3 rounded-full bg-primary border-2 border-white cursor-nw-resize shadow-sm"
                                          onMouseDown={(e) => startResizeField(e, field, "nw")}
                                        />
                                        <div
                                          data-resize="e"
                                          className="absolute top-1/2 -right-1.5 h-4 w-2 -translate-y-1/2 rounded-full bg-primary border-2 border-white cursor-e-resize shadow-sm"
                                          onMouseDown={(e) => startResizeField(e, field, "e")}
                                        />
                                        <div
                                          data-resize="w"
                                          className="absolute top-1/2 -left-1.5 h-4 w-2 -translate-y-1/2 rounded-full bg-primary border-2 border-white cursor-w-resize shadow-sm"
                                          onMouseDown={(e) => startResizeField(e, field, "w")}
                                        />
                                        <div
                                          data-resize="n"
                                          className="absolute -top-1.5 left-1/2 h-2 w-4 -translate-x-1/2 rounded-full bg-primary border-2 border-white cursor-n-resize shadow-sm"
                                          onMouseDown={(e) => startResizeField(e, field, "n")}
                                        />
                                        <div
                                          data-resize="s"
                                          className="absolute -bottom-1.5 left-1/2 h-2 w-4 -translate-x-1/2 rounded-full bg-primary border-2 border-white cursor-s-resize shadow-sm"
                                          onMouseDown={(e) => startResizeField(e, field, "s")}
                                        />
                                      </>
                                    )}
                                  </>
                                )}

                                {/* Delete button - appears on hover */}
                                <button
                                  type="button"
                                  className={cn(
                                    "absolute -top-2 -right-2 h-5 w-5 rounded-full bg-destructive text-destructive-foreground",
                                    "flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity",
                                    "shadow-sm hover:bg-destructive/90 z-10",
                                    isSelected && "opacity-100 -top-3 -right-3",
                                  )}
                                  onClick={(e) => {
                                    e.stopPropagation()
                                    handleRemoveField(field.id)
                                  }}
                                >
                                  <Trash2 className="h-3 w-3" />
                                </button>
                              </div>
                            )
                          })}
                        </div>
                      </div>
                    </div>
                  ))}
                </PDFComponents.Document>
              </div>
            </div>
          </ScrollArea>
        )}
        </div>
      </div>

      {/* Footer */}
      <div className="flex-shrink-0 border-t bg-background">
        <div className="flex items-center justify-between px-4 py-3">
          {/* Left: Back button (muted styling) */}
          {onBack ? (
            <Button
              variant="ghost"
              size="sm"
              onClick={onBack}
              className="text-muted-foreground hover:text-foreground"
            >
              <ArrowLeft className="h-4 w-4 mr-1.5" />
              Recipients
            </Button>
          ) : (
            <div />
          )}

          {/* Right: Save + Send buttons */}
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" onClick={onSave}>
              <Check className="h-4 w-4 mr-1.5" />
              Save draft
            </Button>
            {onSend && (
              <Button size="sm" onClick={onSend} disabled={sendDisabled || fields.length === 0}>
                {sendLoading ? <Loader2 className="h-4 w-4 mr-1.5 animate-spin" /> : <Mail className="h-4 w-4 mr-1.5" />}
                {sendLabel}
              </Button>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
