"use client"

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { format, startOfMonth, subDays } from "date-fns"
import { GitCompareArrows, ImagePlus, Images, Loader2, Map as MapIcon, Rows3, Search, SlidersHorizontal } from "lucide-react"
import { toast } from "sonner"
import type { DateRange } from "react-day-picker"

import { getFileDownloadUrlAction } from "../actions"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Calendar } from "@/components/ui/calendar"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Input } from "@/components/ui/input"
import { FileViewer } from "@/components/files/file-viewer"
import { downloadFilesAsZip, downloadUrlToFile } from "@/components/files/download"
import { type FileWithDetails } from "@/components/files/types"
import { unwrapAction } from "@/lib/action-result"
import { PHOTO_UPLOAD_ACCEPT } from "@/lib/media/photo-media"
import { cn } from "@/lib/utils"
import type { PhotoAlbum, ProjectPhoto, ProjectPhotoFacets, ProjectPhotoPage, ProjectPhotoUploader } from "@/lib/services/photos"
import { UNASSIGNED, type ProjectPhotoFilters } from "@/lib/validation/photos"
import {
  bulkUpdatePhotoMetadataAction,
  getProjectPhotoFacetsAction,
  listProjectPhotosAction,
  updatePhotoMetadataAction,
} from "./actions"
import { PhotoAlbumsDialog } from "./photo-albums-dialog"
import { PhotoBulkBar } from "./photo-bulk-bar"
import { PhotoCompare } from "./photo-compare"
import { PhotoDetails, type PhotoPatch } from "./photo-details"
import { PhotoGrid } from "./photo-grid"
import { PhotoMap } from "./photo-map"
import { usePhotoUpload } from "./use-photo-upload"

const ALL = "__all__"
const PAGE_SIZE = 30

const SOURCE_OPTIONS = [
  { value: "daily_log", label: "Daily logs" },
  { value: "punch_item", label: "Punch" },
  { value: "inspection", label: "Inspections" },
  { value: "observation", label: "Observations" },
  { value: "safety_incident", label: "Incidents" },
  { value: "rfi", label: "RFIs" },
  { value: "submittal", label: "Submittals" },
  { value: "files", label: "Files" },
] as const

const SOURCE_LABELS: Record<string, string> = Object.fromEntries(
  SOURCE_OPTIONS.map((option) => [option.value, option.label.replace(/s$/, "")]),
)

const RANGE_OPTIONS = [
  { value: "all", label: "Any time" },
  { value: "7d", label: "Last 7 days" },
  { value: "30d", label: "Last 30 days" },
  { value: "90d", label: "Last 90 days" },
  { value: "month", label: "This month" },
  { value: "custom", label: "Custom range" },
] as const

type RangePreset = (typeof RANGE_OPTIONS)[number]["value"]
type PhotoView = "timeline" | "map" | "compare"

function toIsoDate(date: Date) {
  return format(date, "yyyy-MM-dd")
}

function rangeToFilters(preset: RangePreset, custom: DateRange | undefined): Pick<ProjectPhotoFilters, "date_from" | "date_to"> {
  const today = new Date()
  switch (preset) {
    case "all":
      return {}
    case "7d":
      return { date_from: toIsoDate(subDays(today, 6)), date_to: toIsoDate(today) }
    case "30d":
      return { date_from: toIsoDate(subDays(today, 29)), date_to: toIsoDate(today) }
    case "90d":
      return { date_from: toIsoDate(subDays(today, 89)), date_to: toIsoDate(today) }
    case "month":
      return { date_from: toIsoDate(startOfMonth(today)), date_to: toIsoDate(today) }
    case "custom":
      return {
        date_from: custom?.from ? toIsoDate(custom.from) : undefined,
        date_to: custom?.to ? toIsoDate(custom.to) : undefined,
      }
  }
}

function toViewerFile(photo: ProjectPhoto): FileWithDetails {
  return {
    id: photo.id,
    org_id: photo.org_id,
    project_id: photo.project_id,
    file_name: photo.file_name,
    storage_path: photo.storage_path,
    visibility: photo.visibility,
    mime_type: photo.mime_type ?? undefined,
    size_bytes: photo.size_bytes ?? undefined,
    created_at: photo.created_at,
    uploaded_by: photo.uploaded_by ?? undefined,
    uploader_name: photo.uploader_name ?? undefined,
    uploader_avatar: photo.uploader_avatar ?? undefined,
    thumbnail_url: photo.thumbnail_url,
    download_url: photo.download_url,
  }
}

export function PhotosLens({
  projectId,
  initialPage,
  initialFacets,
  locations,
  uploaders,
  initialAlbums,
  trades,
  canUpload,
  canFileToDailyLog,
}: {
  projectId: string
  initialPage: ProjectPhotoPage
  initialFacets: ProjectPhotoFacets
  locations: Array<{ id: string; full_path: string }>
  uploaders: ProjectPhotoUploader[]
  initialAlbums: PhotoAlbum[]
  trades: Array<{ id: string; name: string }>
  /** `docs.upload`. Deliberately no longer bundled with daily-log rights: a
   *  photographer who cannot write logs was locked out of the page entirely. */
  canUpload: boolean
  canFileToDailyLog: boolean
}) {
  const [photos, setPhotos] = useState(initialPage.photos)
  const [cursor, setCursor] = useState(initialPage.next_cursor)
  const [albums, setAlbums] = useState(initialAlbums)
  const [facets, setFacets] = useState(initialFacets)
  const [view, setView] = useState<PhotoView>("timeline")

  const [range, setRange] = useState<RangePreset>("all")
  const [customRange, setCustomRange] = useState<DateRange | undefined>()
  const [sourceType, setSourceType] = useState<string>(ALL)
  const [uploaderId, setUploaderId] = useState<string>(ALL)
  const [locationId, setLocationId] = useState<string>(ALL)
  const [albumId, setAlbumId] = useState<string>(ALL)
  const [tradeId, setTradeId] = useState<string>(ALL)
  const [visibility, setVisibility] = useState<string>(ALL)
  const [mediaKind, setMediaKind] = useState<string>(ALL)
  const [search, setSearch] = useState("")

  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [selection, setSelection] = useState<Set<string>>(new Set())
  const [loading, setLoading] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [pendingPatch, setPendingPatch] = useState(false)
  const [downloading, setDownloading] = useState(false)
  const [albumsOpen, setAlbumsOpen] = useState(false)
  const [dragging, setDragging] = useState(false)

  const loadSentinel = useRef<HTMLDivElement | null>(null)
  const fileInput = useRef<HTMLInputElement | null>(null)
  const requestRef = useRef(0)
  const lastToggledIndex = useRef<number | null>(null)
  const dragDepth = useRef(0)

  const filters = useMemo<ProjectPhotoFilters>(() => ({
    ...rangeToFilters(range, customRange),
    source_type: sourceType === ALL ? undefined : sourceType,
    uploader_id: uploaderId === ALL ? undefined : uploaderId,
    location_id: locationId === ALL ? undefined : locationId,
    album_id: albumId === ALL ? undefined : albumId,
    trade_company_id: tradeId === ALL ? undefined : tradeId,
    visibility: visibility === ALL ? undefined : visibility as "internal" | "client",
    media_kind: mediaKind === ALL ? undefined : mediaKind as "image" | "video",
    // The map can only plot photos that carry a fix, so asking for them is the
    // filter — paging then walks the located ones instead of everything.
    geotagged: view === "map" ? true : undefined,
    search: search.trim().length >= 2 ? search.trim() : undefined,
  }), [range, customRange, sourceType, uploaderId, locationId, albumId, tradeId, visibility, mediaKind, view, search])
  const filtersKey = JSON.stringify(filters)

  // "Custom range" only narrows anything once a start date is picked.
  const rangeActive = range !== "all" && (range !== "custom" || Boolean(customRange?.from))
  const activeFilterCount =
    (rangeActive ? 1 : 0) +
    [sourceType, uploaderId, locationId, albumId, tradeId, visibility, mediaKind].filter((value) => value !== ALL).length +
    (search.trim().length >= 2 ? 1 : 0)

  const viewerFiles = useMemo(() => photos.map(toViewerFile), [photos])
  const selected = photos.find((photo) => photo.id === selectedId) ?? null
  const selectedViewerFile = useMemo(
    () => viewerFiles.find((file) => file.id === selectedId) ?? null,
    [viewerFiles, selectedId],
  )

  const loadPage = useCallback(async (nextCursor: string | null, replace: boolean, nextFilters: ProjectPhotoFilters) => {
    const requestId = ++requestRef.current
    setLoading(true)
    setLoadError(null)
    try {
      const page = unwrapAction(
        await listProjectPhotosAction({ projectId, cursor: nextCursor, limit: PAGE_SIZE, filters: nextFilters }),
      )
      if (requestId !== requestRef.current) return
      setPhotos((current) =>
        replace
          ? page.photos
          : [...current, ...page.photos.filter((photo) => !current.some((existing) => existing.id === photo.id))],
      )
      setCursor(page.next_cursor)
    } catch (error) {
      if (requestId !== requestRef.current) return
      const message = error instanceof Error ? error.message : "Photos could not be loaded"
      setLoadError(message)
      toast.error(message)
    } finally {
      if (requestId === requestRef.current) setLoading(false)
    }
  }, [projectId])

  const reload = useCallback(() => loadPage(null, true, filters), [loadPage, filters])

  // The server rendered the first page unfiltered; reload whenever the filter set
  // actually changes.
  const loadedFiltersKey = useRef(filtersKey)
  useEffect(() => {
    if (filtersKey === loadedFiltersKey.current) return
    loadedFiltersKey.current = filtersKey
    setSelection(new Set())
    void loadPage(null, true, filters)
  }, [filters, filtersKey, loadPage])

  useEffect(() => {
    const node = loadSentinel.current
    if (!node || !cursor || view === "compare") return
    const observer = new IntersectionObserver((entries) => {
      if (entries[0]?.isIntersecting && !loading) void loadPage(cursor, false, filters)
    }, { rootMargin: "300px" })
    observer.observe(node)
    return () => observer.disconnect()
  }, [cursor, filters, loadPage, loading, view])

  function clearFilters() {
    setRange("all")
    setCustomRange(undefined)
    setSourceType(ALL)
    setUploaderId(ALL)
    setLocationId(ALL)
    setAlbumId(ALL)
    setTradeId(ALL)
    setVisibility(ALL)
    setMediaKind(ALL)
    setSearch("")
  }

  const refreshAfterUpload = useCallback(async () => {
    // Facets travel with the reload: a batch that carried GPS is what turns the
    // map view on, and the button would otherwise stay disabled on a stale zero.
    const [, nextFacets] = await Promise.all([reload(), getProjectPhotoFacetsAction(projectId)])
    if (nextFacets.success) setFacets(nextFacets.data)
  }, [reload, projectId])

  const { progress, uploading, upload } = usePhotoUpload({
    projectId,
    canFileToDailyLog,
    onUploaded: refreshAfterUpload,
  })

  // Paste straight from the clipboard — the fastest path from a screenshot or a
  // photo copied out of a message to the project record.
  useEffect(() => {
    if (!canUpload) return
    const onPaste = (event: ClipboardEvent) => {
      const target = event.target
      if (target instanceof HTMLElement && (target.isContentEditable || ["INPUT", "TEXTAREA"].includes(target.tagName))) return
      const files = Array.from(event.clipboardData?.files ?? [])
      if (files.length === 0) return
      event.preventDefault()
      void upload(files)
    }
    window.addEventListener("paste", onPaste)
    return () => window.removeEventListener("paste", onPaste)
  }, [canUpload, upload])

  function toggleSelection(photo: ProjectPhoto, index: number, extend: boolean) {
    setSelection((current) => {
      const next = new Set(current)
      const anchor = lastToggledIndex.current
      if (extend && anchor !== null) {
        const [from, to] = anchor < index ? [anchor, index] : [index, anchor]
        // A shift-click extends by adding, never by clearing what is already
        // picked — losing a selection to a stray shift is infuriating.
        for (let cursorIndex = from; cursorIndex <= to; cursorIndex += 1) {
          const target = photos[cursorIndex]
          if (target) next.add(target.id)
        }
      } else if (next.has(photo.id)) {
        next.delete(photo.id)
      } else {
        next.add(photo.id)
      }
      return next
    })
    lastToggledIndex.current = index
  }

  /**
   * Whether a change makes a photo stop matching what is on screen. Publishing
   * while filtered to "internal" has to remove it from the list, and the honest
   * way to get that right for every combination is to ask the server again.
   */
  function patchLeavesFilter(patch: PhotoPatch) {
    return (
      (patch.album_id !== undefined && albumId !== ALL) ||
      (patch.location_id !== undefined && locationId !== ALL) ||
      (patch.trade_company_id !== undefined && tradeId !== ALL) ||
      (patch.visibility !== undefined && visibility !== ALL)
    )
  }

  function applyLocally(ids: Set<string>, patch: PhotoPatch) {
    setPhotos((current) => current.map((photo) => (
      ids.has(photo.id)
        ? {
            ...photo,
            album_id: patch.album_id !== undefined ? patch.album_id : photo.album_id,
            location_id: patch.location_id !== undefined ? patch.location_id : photo.location_id,
            trade_company_id: patch.trade_company_id !== undefined ? patch.trade_company_id : photo.trade_company_id,
            curated_visibility: patch.visibility ?? photo.curated_visibility,
          }
        : photo
    )))
  }

  async function patchOne(photo: ProjectPhoto, patch: PhotoPatch) {
    setPendingPatch(true)
    try {
      unwrapAction(await updatePhotoMetadataAction({ project_id: projectId, file_id: photo.id, ...patch }))
      if (patchLeavesFilter(patch)) {
        await reload()
      } else {
        applyLocally(new Set([photo.id]), patch)
      }
      if (patch.visibility) {
        toast.success(patch.visibility === "client" ? "Published to client feed" : "Photo is internal")
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not update photo")
    } finally {
      setPendingPatch(false)
    }
  }

  async function patchSelection(patch: PhotoPatch) {
    const ids = Array.from(selection)
    if (ids.length === 0) return
    setPendingPatch(true)
    try {
      const { updated } = unwrapAction(
        await bulkUpdatePhotoMetadataAction({ project_id: projectId, file_ids: ids, ...patch }),
      )
      if (patchLeavesFilter(patch)) {
        await reload()
        setSelection(new Set())
      } else {
        applyLocally(new Set(ids), patch)
      }
      toast.success(`${updated} photo${updated === 1 ? "" : "s"} updated`)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not update photos")
    } finally {
      setPendingPatch(false)
    }
  }

  async function downloadSelection() {
    const ids = Array.from(selection)
    if (ids.length === 0) return
    setDownloading(true)
    try {
      if (ids.length === 1) {
        const photo = photos.find((item) => item.id === ids[0])
        if (photo) {
          await downloadUrlToFile(await getFileDownloadUrlAction(photo.id), photo.file_name)
          return
        }
      }
      await downloadFilesAsZip(ids, `photos-${toIsoDate(new Date())}.zip`)
      toast.success(`Downloading ${ids.length} photos`)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Photos could not be downloaded")
    } finally {
      setDownloading(false)
    }
  }

  async function handleViewerDownload(file: FileWithDetails) {
    try {
      await downloadUrlToFile(await getFileDownloadUrlAction(file.id), file.file_name)
    } catch {
      toast.error("Photo could not be downloaded")
    }
  }

  const showEmpty = photos.length === 0 && !loading

  return (
    <div
      className="relative min-h-0"
      onDragEnter={(event) => {
        if (!canUpload || !event.dataTransfer.types.includes("Files")) return
        dragDepth.current += 1
        setDragging(true)
      }}
      onDragOver={(event) => {
        if (canUpload && event.dataTransfer.types.includes("Files")) event.preventDefault()
      }}
      onDragLeave={() => {
        dragDepth.current = Math.max(0, dragDepth.current - 1)
        if (dragDepth.current === 0) setDragging(false)
      }}
      onDrop={(event) => {
        if (!canUpload) return
        event.preventDefault()
        dragDepth.current = 0
        setDragging(false)
        void upload(event.dataTransfer.files)
      }}
    >
      <div className="sticky top-0 z-20 flex h-12 items-center gap-2 border-b bg-background/95 px-4 backdrop-blur sm:px-6">
        <div className="relative w-full max-w-xs">
          <Search className="absolute left-2.5 top-2 size-4 text-muted-foreground" />
          <Input
            className="h-8 pl-8"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search captions, tags, file names"
          />
        </div>

        <Popover>
          <PopoverTrigger asChild>
            <Button variant="outline" size="sm" className="h-8">
              <SlidersHorizontal className="size-4" />
              Filter
              {activeFilterCount > 0 ? (
                <Badge className="ml-1 h-4 min-w-4 justify-center rounded-none px-1 text-[10px] tabular-nums">
                  {activeFilterCount}
                </Badge>
              ) : null}
            </Button>
          </PopoverTrigger>
          <PopoverContent align="start" className="w-72 space-y-3 p-3">
            <div className="flex items-center justify-between">
              <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Filters</p>
              {activeFilterCount > 0 ? (
                <button type="button" onClick={clearFilters} className="text-xs text-muted-foreground hover:text-foreground">
                  Clear all
                </button>
              ) : null}
            </div>

            <div className="space-y-1.5">
              <p className="text-xs text-muted-foreground">Taken</p>
              <Select value={range} onValueChange={(value) => setRange(value as RangePreset)}>
                <SelectTrigger size="sm" className="w-full"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {RANGE_OPTIONS.map((option) => (
                    <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {range === "custom" ? (
                <Calendar
                  mode="range"
                  numberOfMonths={1}
                  defaultMonth={customRange?.from}
                  selected={customRange}
                  onSelect={setCustomRange}
                  className="border p-2"
                />
              ) : null}
            </div>

            <div className="space-y-1.5">
              <p className="text-xs text-muted-foreground">Source</p>
              <Select value={sourceType} onValueChange={setSourceType}>
                <SelectTrigger size="sm" className="w-full"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value={ALL}>All sources</SelectItem>
                  {SOURCE_OPTIONS.map((option) => (
                    <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-1.5">
              <p className="text-xs text-muted-foreground">Uploader</p>
              <Select value={uploaderId} onValueChange={setUploaderId}>
                <SelectTrigger size="sm" className="w-full"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value={ALL}>All uploaders</SelectItem>
                  {uploaders.map((uploader) => (
                    <SelectItem key={uploader.id} value={uploader.id}>{uploader.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {locations.length > 0 ? (
              <div className="space-y-1.5">
                <p className="text-xs text-muted-foreground">Area</p>
                <Select value={locationId} onValueChange={setLocationId}>
                  <SelectTrigger size="sm" className="w-full"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value={ALL}>All areas</SelectItem>
                    <SelectItem value={UNASSIGNED}>Unassigned</SelectItem>
                    {locations.map((location) => (
                      <SelectItem key={location.id} value={location.id}>{location.full_path}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            ) : null}

            {trades.length > 0 ? (
              <div className="space-y-1.5">
                <p className="text-xs text-muted-foreground">Trade</p>
                <Select value={tradeId} onValueChange={setTradeId}>
                  <SelectTrigger size="sm" className="w-full"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value={ALL}>All trades</SelectItem>
                    {trades.map((trade) => (
                      <SelectItem key={trade.id} value={trade.id}>{trade.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            ) : null}

            {albums.length > 0 ? (
              <div className="space-y-1.5">
                <p className="text-xs text-muted-foreground">Album</p>
                <Select value={albumId} onValueChange={setAlbumId}>
                  <SelectTrigger size="sm" className="w-full"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value={ALL}>All albums</SelectItem>
                    <SelectItem value={UNASSIGNED}>Not in an album</SelectItem>
                    {albums.map((album) => (
                      <SelectItem key={album.id} value={album.id}>{album.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            ) : null}

            {facets.videos > 0 ? (
              <div className="space-y-1.5">
                <p className="text-xs text-muted-foreground">Type</p>
                <Select value={mediaKind} onValueChange={setMediaKind}>
                  <SelectTrigger size="sm" className="w-full"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value={ALL}>Photos and video</SelectItem>
                    <SelectItem value="image">Photos</SelectItem>
                    <SelectItem value="video">Video</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            ) : null}

            <div className="space-y-1.5">
              <p className="text-xs text-muted-foreground">Visibility</p>
              <Select value={visibility} onValueChange={setVisibility}>
                <SelectTrigger size="sm" className="w-full"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value={ALL}>All photos</SelectItem>
                  <SelectItem value="internal">Internal</SelectItem>
                  <SelectItem value="client">Client feed</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </PopoverContent>
        </Popover>

        <div className="flex items-center gap-0.5">
          <Button size="sm" variant={view === "timeline" ? "secondary" : "ghost"} className="h-8" onClick={() => setView("timeline")}>
            <Rows3 className="size-4" />
            <span className="hidden sm:inline">Timeline</span>
          </Button>
          <Button
            size="sm"
            variant={view === "map" ? "secondary" : "ghost"}
            className="h-8"
            onClick={() => setView("map")}
            disabled={facets.geotagged === 0}
            title={facets.geotagged === 0 ? "No photo in this project carries a location yet" : undefined}
          >
            <MapIcon className="size-4" />
            <span className="hidden sm:inline">Map</span>
          </Button>
          <Button size="sm" variant={view === "compare" ? "secondary" : "ghost"} className="h-8" onClick={() => setView("compare")}>
            <GitCompareArrows className="size-4" />
            <span className="hidden sm:inline">Compare</span>
          </Button>
        </div>

        <div className="flex-1" />

        <Button size="sm" variant="ghost" className="h-8" onClick={() => setAlbumsOpen(true)}>
          <Images className="size-4" />
          <span className="hidden sm:inline">Albums</span>
          {albums.length > 0 && <span className="text-xs tabular-nums text-muted-foreground">{albums.length}</span>}
        </Button>

        {canUpload ? (
          <>
            <input
              ref={fileInput}
              className="sr-only"
              type="file"
              accept={PHOTO_UPLOAD_ACCEPT}
              multiple
              onChange={(event) => {
                void upload(event.target.files)
                event.target.value = ""
              }}
            />
            <Button size="sm" className="h-8" onClick={() => fileInput.current?.click()} disabled={uploading}>
              {uploading ? <Loader2 className="animate-spin" /> : <ImagePlus />}
              {progress
                ? `${progress.completed + progress.failed}/${progress.total}`
                : "Add photos"}
            </Button>
          </>
        ) : null}
      </div>

      {showEmpty && view !== "compare" ? (
        <div className="flex flex-col items-center px-6 py-24 text-center">
          <ImagePlus className="size-6 text-muted-foreground" />
          <p className="mt-4 text-sm font-medium">
            {activeFilterCount > 0 ? "No photos match these filters" : "No photos yet"}
          </p>
          <p className="mt-1 max-w-sm text-sm text-muted-foreground">
            {activeFilterCount > 0 ? (
              <button type="button" onClick={clearFilters} className="underline underline-offset-2 hover:text-foreground">
                Clear filters
              </button>
            ) : (
              "Photos filed on daily logs, punch items, inspections, observations, RFIs, and project files land here. Drop them anywhere on this page to add more."
            )}
          </p>
          {activeFilterCount === 0 && canUpload ? (
            <Button className="mt-5" variant="outline" size="sm" onClick={() => fileInput.current?.click()}>
              Add the first photos
            </Button>
          ) : null}
        </div>
      ) : view === "map" ? (
        <PhotoMap photos={photos} onOpen={(photo) => setSelectedId(photo.id)} geotaggedTotal={facets.geotagged} />
      ) : view === "compare" ? (
        <PhotoCompare photos={photos} />
      ) : (
        <PhotoGrid
          photos={photos}
          sourceLabels={SOURCE_LABELS}
          selection={selection}
          selecting={selection.size > 0}
          onToggle={toggleSelection}
          onOpen={(photo) => setSelectedId(photo.id)}
        />
      )}

      {view !== "compare" && (
        <div ref={loadSentinel} className="flex h-20 items-center justify-center" aria-live="polite">
          {loading ? (
            <span className="flex items-center gap-2 text-xs text-muted-foreground">
              <Loader2 className="size-4 animate-spin" />
              Loading photos
            </span>
          ) : null}
          {loadError && cursor ? (
            <Button size="sm" variant="outline" onClick={() => void loadPage(cursor, false, filters)}>
              Try again
            </Button>
          ) : null}
        </div>
      )}

      {selection.size > 0 && (
        <PhotoBulkBar
          count={selection.size}
          albums={albums}
          locations={locations}
          canEdit={canUpload}
          pending={pendingPatch}
          downloading={downloading}
          onPatch={(patch) => void patchSelection(patch)}
          onDownload={() => void downloadSelection()}
          onClear={() => setSelection(new Set())}
        />
      )}

      {dragging && (
        <div className="pointer-events-none fixed inset-0 z-40 flex items-center justify-center bg-background/80 backdrop-blur-sm">
          <div className="border-2 border-dashed px-8 py-6 text-center">
            <ImagePlus className="mx-auto size-6 text-muted-foreground" />
            <p className="mt-3 text-sm font-medium">Drop to add to this project</p>
            <p className="mt-1 text-xs text-muted-foreground">Photos and video</p>
          </div>
        </div>
      )}

      <PhotoAlbumsDialog
        projectId={projectId}
        albums={albums}
        canEdit={canUpload}
        open={albumsOpen}
        onOpenChange={setAlbumsOpen}
        onAlbumsChange={setAlbums}
      />

      <FileViewer
        file={selectedViewerFile}
        files={viewerFiles}
        open={Boolean(selectedViewerFile)}
        onOpenChange={(open) => {
          if (!open) setSelectedId(null)
        }}
        onDownload={(file) => void handleViewerDownload(file)}
        onFileChange={(file) => setSelectedId(file.id)}
        details={selected ? (
          <PhotoDetails
            photo={selected}
            albums={albums}
            locations={locations}
            trades={trades}
            canEdit={canUpload}
            pending={pendingPatch}
            onPatch={(patch) => void patchOne(selected, patch)}
          />
        ) : undefined}
      />
    </div>
  )
}
