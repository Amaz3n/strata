"use client"

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import Link from "next/link"
import { useRouter, useSearchParams } from "next/navigation"
import { toast } from "sonner"
import { ArrowLeft, FileText, Search, X } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion"
import {
  createDrawingMarkupAction,
  createDrawingPinAction,
  createPunchItemFromDrawingAction,
  createRfiFromDrawingAction,
  createTaskFromDrawingAction,
  deleteDrawingMarkupAction,
  getSheetDownloadUrlAction,
  getSheetOptimizedImageUrlsAction,
  listDrawingMarkupsAction,
  listDrawingPinsWithEntitiesAction,
  updateDrawingSheetAction,
} from "@/app/(app)/drawings/actions"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Button } from "@/components/ui/button"
import type {
  DrawingMarkup,
  DrawingPin,
  DrawingSet,
  DrawingSheet,
} from "@/app/(app)/drawings/actions"
import { DISCIPLINE_LABELS } from "@/lib/validation/drawings"
import type { DrawingDiscipline } from "@/lib/validation/drawings"
import { cn } from "@/lib/utils"
import { DrawingViewer } from "./drawing-viewer"
import { CreateFromDrawingDialog } from "./create-from-drawing-dialog"

interface DrawingSetDetailProps {
  set: DrawingSet
  sheets: DrawingSheet[]
  projectId: string
  projectName?: string
}

const DISCIPLINE_ORDER: DrawingDiscipline[] = [
  "G",
  "T",
  "A",
  "S",
  "M",
  "E",
  "P",
  "FP",
  "C",
  "L",
  "I",
  "SP",
  "D",
  "X",
]

function disciplineLabel(code?: DrawingDiscipline | string | null) {
  if (!code) return "Unassigned"
  return (
    DISCIPLINE_LABELS[code as DrawingDiscipline] ??
    String(code).toUpperCase()
  )
}

function formatDate(value?: string | null) {
  if (!value) return "—"
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(new Date(value))
}

function compareSheets(a: DrawingSheet, b: DrawingSheet) {
  if (a.sort_order !== b.sort_order) return a.sort_order - b.sort_order
  return a.sheet_number.localeCompare(b.sheet_number, undefined, {
    numeric: true,
    sensitivity: "base",
  })
}

export function DrawingSetDetail({
  set,
  sheets: initialSheets,
  projectId,
  projectName,
}: DrawingSetDetailProps) {
  const router = useRouter()
  const searchParams = useSearchParams()
  const [search, setSearch] = useState("")
  const [sheets, setSheets] = useState<DrawingSheet[]>(initialSheets)

  useEffect(() => {
    setSheets(initialSheets)
  }, [initialSheets])

  const handleDisciplineChange = useCallback(
    async (sheetId: string, discipline: DrawingDiscipline) => {
      const prev = sheets
      setSheets((curr) =>
        curr.map((s) => (s.id === sheetId ? { ...s, discipline } : s)),
      )
      try {
        await updateDrawingSheetAction(sheetId, { discipline })
        toast.success(`Moved to ${disciplineLabel(discipline)}`)
      } catch (err) {
        console.error(err)
        setSheets(prev)
        toast.error("Failed to change discipline")
      }
    },
    [sheets],
  )

  const [viewerOpen, setViewerOpen] = useState(false)
  const [viewerSheet, setViewerSheet] = useState<DrawingSheet | null>(null)
  const [viewerUrl, setViewerUrl] = useState<string | null>(null)
  const [viewerMarkups, setViewerMarkups] = useState<DrawingMarkup[]>([])
  const [viewerPins, setViewerPins] = useState<DrawingPin[]>([])
  const [viewerHighlightedPinId, setViewerHighlightedPinId] = useState<
    string | null
  >(null)

  const [createDialogOpen, setCreateDialogOpen] = useState(false)
  const [createPosition, setCreatePosition] = useState<{
    x: number
    y: number
  } | null>(null)

  const sheetOpenRequestIdRef = useRef(0)

  const filteredSheets = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return sheets
    return sheets.filter((s) => {
      const haystack = [s.sheet_number, s.sheet_title, s.discipline]
        .filter(Boolean)
        .join(" ")
        .toLowerCase()
      return haystack.includes(q)
    })
  }, [sheets, search])

  const groups = useMemo(() => {
    const map = new Map<string, DrawingSheet[]>()
    for (const sheet of filteredSheets) {
      const key = sheet.discipline ?? "X"
      const existing = map.get(key)
      if (existing) existing.push(sheet)
      else map.set(key, [sheet])
    }
    const entries = Array.from(map.entries()).map(([code, list]) => ({
      code,
      label: disciplineLabel(code),
      sheets: list.sort(compareSheets),
    }))
    entries.sort((a, b) => {
      const ai = DISCIPLINE_ORDER.indexOf(a.code as DrawingDiscipline)
      const bi = DISCIPLINE_ORDER.indexOf(b.code as DrawingDiscipline)
      const av = ai === -1 ? Number.MAX_SAFE_INTEGER : ai
      const bv = bi === -1 ? Number.MAX_SAFE_INTEGER : bi
      return av - bv
    })
    return entries
  }, [filteredSheets])

  const totalSheets = sheets.length

  const handleViewSheet = useCallback(
    async (sheet: DrawingSheet, highlightPinId?: string | null) => {
      const requestId = ++sheetOpenRequestIdRef.current
      setViewerSheet(sheet)
      setViewerHighlightedPinId(highlightPinId ?? null)
      setViewerUrl(null)
      setViewerMarkups([])
      setViewerPins([])
      setViewerOpen(true)

      try {
        const hasTiles =
          !!(sheet as any).tile_base_url && !!(sheet as any).tile_manifest
        const hasOptimized =
          !!sheet.image_full_url &&
          !!sheet.image_medium_url &&
          !!sheet.image_thumbnail_url

        const [signedImages, url, markups, pins] = await Promise.all([
          hasOptimized && !hasTiles
            ? getSheetOptimizedImageUrlsAction(sheet.id).catch(() => null)
            : Promise.resolve(null),
          getSheetDownloadUrlAction(sheet.id).catch(() => null),
          listDrawingMarkupsAction({ drawing_sheet_id: sheet.id }).catch(
            () => [],
          ),
          listDrawingPinsWithEntitiesAction(sheet.id).catch(() => []),
        ])

        if (sheetOpenRequestIdRef.current !== requestId) return

        if (signedImages && !hasTiles) {
          setViewerSheet((prev) => {
            if (!prev || prev.id !== sheet.id) return prev
            return {
              ...prev,
              image_thumbnail_url:
                signedImages.thumbnailUrl ?? prev.image_thumbnail_url ?? null,
              image_medium_url:
                signedImages.mediumUrl ?? prev.image_medium_url ?? null,
              image_full_url:
                signedImages.fullUrl ?? prev.image_full_url ?? null,
              image_width: signedImages.width ?? prev.image_width ?? null,
              image_height: signedImages.height ?? prev.image_height ?? null,
            }
          })
        }

        if (!hasOptimized && !hasTiles && !url) {
          toast.error("Sheet file not available")
          setViewerOpen(false)
          return
        }

        setViewerUrl(url)
        setViewerMarkups(markups)
        setViewerPins(pins)
      } catch (err) {
        console.error("Failed to open sheet:", err)
        if (sheetOpenRequestIdRef.current === requestId) {
          toast.error("Failed to load sheet")
        }
      }
    },
    [],
  )

  useEffect(() => {
    const sheetId = searchParams?.get("sheetId")
    if (!sheetId) return
    const sheet = sheets.find((s) => s.id === sheetId)
    if (!sheet) return
    const pinId = searchParams?.get("pinId")
    handleViewSheet(sheet, pinId)
  }, [searchParams, sheets, handleViewSheet])

  const handleSaveMarkup = async (
    markup: Omit<DrawingMarkup, "id" | "org_id" | "created_at" | "updated_at">,
  ) => {
    try {
      const created = await createDrawingMarkupAction(markup)
      setViewerMarkups((prev) => [...prev, created])
      toast.success("Markup saved")
    } catch (err) {
      console.error(err)
      toast.error("Failed to save markup")
    }
  }

  const handleDeleteMarkup = async (markupId: string) => {
    try {
      await deleteDrawingMarkupAction(markupId)
      setViewerMarkups((prev) => prev.filter((m) => m.id !== markupId))
      toast.success("Markup deleted")
    } catch (err) {
      console.error(err)
      toast.error("Failed to delete markup")
    }
  }

  const handleCreatePin = (x: number, y: number) => {
    setCreatePosition({ x, y })
    setCreateDialogOpen(true)
  }

  const handlePinClick = (pin: DrawingPin) => {
    const base = pin.project_id ? `/projects/${pin.project_id}` : null
    if (!base) return
    switch (pin.entity_type) {
      case "task":
        router.push(`${base}/tasks`)
        break
      case "rfi":
        router.push(`${base}/rfis`)
        break
      case "submittal":
        router.push(`${base}/submittals`)
        break
      case "punch_list":
        router.push(`${base}/punch`)
        break
      case "daily_log":
        router.push(`${base}/daily-logs`)
        break
      default:
        router.push(base)
    }
    setViewerOpen(false)
  }

  const handleCreateFromDrawing = async (input: any) => {
    if (!viewerSheet || !createPosition) return
    try {
      const pinProjectId = input.project_id ?? projectId
      let entityId: string | null = null

      if (input.entityType === "task") {
        const created = await createTaskFromDrawingAction(pinProjectId, {
          title: input.title,
          description: input.description,
          priority:
            input.priority === "high"
              ? "high"
              : input.priority === "low"
                ? "low"
                : "normal",
          status: "todo",
        })
        entityId = created.id
      } else if (input.entityType === "rfi") {
        const created = await createRfiFromDrawingAction({
          projectId: pinProjectId,
          subject: input.subject ?? input.title,
          question: input.question ?? input.description ?? "",
          priority:
            input.priority === "high"
              ? "high"
              : input.priority === "low"
                ? "low"
                : "normal",
        })
        entityId = created.id
      } else if (input.entityType === "punch_list") {
        const created = await createPunchItemFromDrawingAction({
          projectId: pinProjectId,
          title: input.title,
          description: input.description,
          location: input.location,
          severity: input.priority,
        })
        entityId = created.id
      } else if (input.entityType === "issue") {
        const created = await createTaskFromDrawingAction(pinProjectId, {
          title: input.title,
          description: input.description,
          priority: "high",
          status: "todo",
          tags: ["issue"],
        })
        entityId = created.id
      }

      if (!entityId) throw new Error("Unsupported entity type")

      const pin = await createDrawingPinAction({
        project_id: pinProjectId,
        drawing_sheet_id: viewerSheet.id,
        x_position: createPosition.x,
        y_position: createPosition.y,
        entity_type: input.entityType,
        entity_id: entityId,
        label: input.title,
        status: "open",
      })

      setViewerPins((prev) => [...prev, pin])
      setCreateDialogOpen(false)
      setCreatePosition(null)
      setViewerHighlightedPinId(pin.id)
      toast.success("Created and pinned to drawing")
    } catch (err) {
      console.error(err)
      toast.error("Failed to create entity")
    }
  }

  const defaultOpenValues =
    groups.length > 0 && groups.length <= 3
      ? groups.map((g) => g.code)
      : groups.length > 0
        ? [groups[0].code]
        : []

  return (
    <div className="flex h-full flex-col">
      <div className="border-b px-4 py-4">
        <Link
          href={`/projects/${projectId}/drawings`}
          className="mb-2 inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="h-3.5 w-3.5" />
          {projectName ? `${projectName} drawings` : "All plan sets"}
        </Link>
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div className="min-w-0">
            <h1 className="truncate text-xl font-semibold leading-tight">
              {set.title}
            </h1>
            <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted-foreground">
              <span>
                {totalSheets} {totalSheets === 1 ? "sheet" : "sheets"}
              </span>
              <span aria-hidden>·</span>
              <span>{groups.length} {groups.length === 1 ? "trade" : "trades"}</span>
              <span aria-hidden>·</span>
              <span>Updated {formatDate(set.updated_at)}</span>
            </div>
          </div>
        </div>
      </div>

      <div className="flex items-center gap-2 border-b px-4 py-2">
        <div className="relative max-w-sm flex-1">
          <Search className="absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder="Search sheets…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="h-9 pl-9"
          />
          {search && (
            <button
              onClick={() => setSearch("")}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
              aria-label="Clear search"
            >
              <X className="h-4 w-4" />
            </button>
          )}
        </div>
        <div className="ml-auto text-xs text-muted-foreground tabular-nums">
          {filteredSheets.length} of {totalSheets}
        </div>
      </div>

      <div className="flex-1 overflow-auto">
        {totalSheets === 0 ? (
          <EmptyState
            title="No sheets yet"
            description="Sheets will appear here once the plan set is processed."
          />
        ) : filteredSheets.length === 0 ? (
          <EmptyState
            title="No matches"
            description="No sheets match your search."
          />
        ) : (
          <div className="mx-auto max-w-4xl px-4 py-2">
            <Accordion
              key={defaultOpenValues.join(",")}
              type="multiple"
              defaultValue={defaultOpenValues}
              className="w-full"
            >
              {groups.map((group) => (
                <AccordionItem key={group.code} value={group.code}>
                  <AccordionTrigger className="py-3 hover:no-underline">
                    <div className="flex flex-1 items-center gap-3">
                      <Badge
                        variant="outline"
                        className="h-5 w-8 justify-center px-0 font-mono text-[11px]"
                      >
                        {group.code}
                      </Badge>
                      <span className="font-medium">{group.label}</span>
                      <span className="ml-auto mr-2 text-xs text-muted-foreground tabular-nums">
                        {group.sheets.length}
                      </span>
                    </div>
                  </AccordionTrigger>
                  <AccordionContent className="pb-2">
                    <ul className="divide-y border-y">
                      {group.sheets.map((sheet) => (
                        <li
                          key={sheet.id}
                          className="group flex items-center gap-3 px-3 py-2 transition-colors hover:bg-muted/50"
                        >
                          <button
                            type="button"
                            onClick={() => handleViewSheet(sheet)}
                            className="flex min-w-0 flex-1 items-center gap-3 text-left"
                          >
                            <span className="w-20 shrink-0 font-mono text-sm tabular-nums">
                              {sheet.sheet_number}
                            </span>
                            <span className="flex-1 truncate text-sm">
                              {sheet.sheet_title || (
                                <span className="text-muted-foreground">
                                  Untitled
                                </span>
                              )}
                            </span>
                            {sheet.current_revision_label && (
                              <span className="shrink-0 text-xs text-muted-foreground">
                                Rev {sheet.current_revision_label}
                              </span>
                            )}
                          </button>
                          <DisciplineMenu
                            current={
                              (sheet.discipline as DrawingDiscipline) ?? "X"
                            }
                            onChange={(d) =>
                              handleDisciplineChange(sheet.id, d)
                            }
                          />
                        </li>
                      ))}
                    </ul>
                  </AccordionContent>
                </AccordionItem>
              ))}
            </Accordion>
          </div>
        )}
      </div>

      {viewerOpen && viewerSheet && (
        <DrawingViewer
          sheet={viewerSheet}
          fileUrl={viewerUrl ?? undefined}
          markups={viewerMarkups}
          pins={viewerPins}
          highlightedPinId={viewerHighlightedPinId ?? undefined}
          onClose={() => setViewerOpen(false)}
          onSaveMarkup={handleSaveMarkup}
          onDeleteMarkup={handleDeleteMarkup}
          onCreatePin={handleCreatePin}
          onPinClick={handlePinClick}
          sheets={sheets}
          onNavigateSheet={handleViewSheet}
          imageThumbnailUrl={viewerSheet.image_thumbnail_url}
          imageMediumUrl={viewerSheet.image_medium_url}
          imageFullUrl={viewerSheet.image_full_url}
          imageWidth={viewerSheet.image_width}
          imageHeight={viewerSheet.image_height}
        />
      )}

      <CreateFromDrawingDialog
        open={createDialogOpen}
        onOpenChange={setCreateDialogOpen}
        onCreate={handleCreateFromDrawing}
        sheet={viewerSheet}
        position={createPosition || { x: 0, y: 0 }}
        projectId={projectId}
      />
    </div>
  )
}

function DisciplineMenu({
  current,
  onChange,
}: {
  current: DrawingDiscipline
  onChange: (discipline: DrawingDiscipline) => void
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          className="h-6 w-12 shrink-0 px-0 font-mono text-[11px]"
          onClick={(e) => e.stopPropagation()}
          title={`${disciplineLabel(current)} — click to change`}
        >
          {current}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="max-h-80 overflow-y-auto">
        {DISCIPLINE_ORDER.map((code) => (
          <DropdownMenuItem
            key={code}
            onClick={() => {
              if (code !== current) onChange(code)
            }}
            className={cn(
              "gap-2",
              code === current && "bg-muted font-medium",
            )}
          >
            <span className="inline-flex h-5 w-8 items-center justify-center border font-mono text-[11px]">
              {code}
            </span>
            <span>{disciplineLabel(code)}</span>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function EmptyState({
  title,
  description,
}: {
  title: string
  description: string
}) {
  return (
    <div className="flex flex-col items-center justify-center py-16 text-center">
      <div className="mb-4 flex h-12 w-12 items-center justify-center border bg-muted/40">
        <FileText className="h-5 w-5 text-muted-foreground" />
      </div>
      <h2 className="mb-1 text-base font-semibold">{title}</h2>
      <p className="max-w-sm text-sm text-muted-foreground">{description}</p>
    </div>
  )
}
