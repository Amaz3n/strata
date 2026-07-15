"use client"

import Image from "next/image"
import Link from "next/link"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { format, parseISO, startOfMonth, subDays } from "date-fns"
import { ExternalLink, ImagePlus, Loader2, SlidersHorizontal } from "lucide-react"
import { toast } from "sonner"
import type { DateRange } from "react-day-picker"

import { getFileDownloadUrlAction, uploadProjectFileAction } from "../actions"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Calendar } from "@/components/ui/calendar"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { FileViewer } from "@/components/files/file-viewer"
import { downloadUrlToFile } from "@/components/files/download"
import { formatFileSize, type FileWithDetails } from "@/components/files/types"
import { unwrapAction } from "@/lib/action-result"
import type { ProjectPhoto, ProjectPhotoPage, ProjectPhotoUploader } from "@/lib/services/photos"
import type { ProjectPhotoFilters } from "@/lib/validation/photos"
import { ensureTodayDailyLogForPhotosAction, listProjectPhotosAction } from "./actions"

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

const RANGE_OPTIONS = [
  { value: "all", label: "Any time" },
  { value: "7d", label: "Last 7 days" },
  { value: "30d", label: "Last 30 days" },
  { value: "90d", label: "Last 90 days" },
  { value: "month", label: "This month" },
  { value: "custom", label: "Custom range" },
] as const

type RangePreset = (typeof RANGE_OPTIONS)[number]["value"]

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

function sourceLabel(type: string) {
  return SOURCE_OPTIONS.find((option) => option.value === type)?.label.replace(/s$/, "") ?? type.replaceAll("_", " ")
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

function PhotoDetails({ photo }: { photo: ProjectPhoto }) {
  return (
    <div className="p-4">
      <p className="truncate text-sm font-medium">{photo.file_name}</p>
      <p className="mt-0.5 text-xs text-muted-foreground">
        {format(parseISO(photo.created_at), "EEE, MMM d, yyyy 'at' h:mm a")}
      </p>

      <dl className="mt-5 divide-y border-y text-xs">
        <div className="grid grid-cols-[72px_1fr] gap-3 py-2.5">
          <dt className="text-muted-foreground">Uploader</dt>
          <dd className="min-w-0 truncate">{photo.uploader_name ?? "Unknown"}</dd>
        </div>
        <div className="grid grid-cols-[72px_1fr] gap-3 py-2.5">
          <dt className="text-muted-foreground">Size</dt>
          <dd className="min-w-0 truncate tabular-nums">{formatFileSize(photo.size_bytes ?? undefined)}</dd>
        </div>
        <div className="grid grid-cols-[72px_1fr] gap-3 py-2.5">
          <dt className="text-muted-foreground">Location</dt>
          <dd className="min-w-0">{photo.locations.length ? photo.locations.join(", ") : "Not assigned"}</dd>
        </div>
      </dl>

      <p className="mt-5 text-xs font-medium uppercase tracking-wide text-muted-foreground">Filed under</p>
      <div className="mt-1 -mx-2">
        {photo.sources.map((source) => (
          <Link
            key={`${source.type}:${source.entity_id}`}
            href={source.href}
            className="flex items-start justify-between gap-2 px-2 py-2 text-xs transition-colors hover:bg-accent/50"
          >
            <span className="min-w-0">
              <span className="block truncate font-medium">{source.label}</span>
              {source.location ? (
                <span className="mt-0.5 block truncate text-muted-foreground">{source.location}</span>
              ) : null}
            </span>
            <ExternalLink className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
          </Link>
        ))}
      </div>
    </div>
  )
}

export function PhotosLens({
  projectId,
  initialPage,
  locations,
  uploaders,
  canUpload,
}: {
  projectId: string
  initialPage: ProjectPhotoPage
  locations: Array<{ id: string; full_path: string }>
  uploaders: ProjectPhotoUploader[]
  canUpload: boolean
}) {
  const [photos, setPhotos] = useState(initialPage.photos)
  const [cursor, setCursor] = useState(initialPage.next_cursor)
  const [range, setRange] = useState<RangePreset>("all")
  const [customRange, setCustomRange] = useState<DateRange | undefined>()
  const [sourceType, setSourceType] = useState<string>(ALL)
  const [uploaderId, setUploaderId] = useState<string>(ALL)
  const [locationId, setLocationId] = useState<string>(ALL)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)
  const loadSentinel = useRef<HTMLDivElement | null>(null)
  const fileInput = useRef<HTMLInputElement | null>(null)
  const requestRef = useRef(0)

  const filters = useMemo<ProjectPhotoFilters>(() => ({
    ...rangeToFilters(range, customRange),
    source_type: sourceType === ALL ? undefined : sourceType,
    uploader_id: uploaderId === ALL ? undefined : uploaderId,
    location_id: locationId === ALL ? undefined : locationId,
  }), [range, customRange, sourceType, uploaderId, locationId])
  const filtersKey = JSON.stringify(filters)

  // "Custom range" only narrows anything once a start date is picked.
  const rangeActive = range !== "all" && (range !== "custom" || Boolean(customRange?.from))
  const activeFilterCount =
    (rangeActive ? 1 : 0) +
    (sourceType === ALL ? 0 : 1) +
    (uploaderId === ALL ? 0 : 1) +
    (locationId === ALL ? 0 : 1)

  const currentYear = new Date().getFullYear()
  const grouped = useMemo(() => {
    const groups = new Map<string, ProjectPhoto[]>()
    for (const photo of photos) {
      const key = photo.created_at.slice(0, 10)
      groups.set(key, [...(groups.get(key) ?? []), photo])
    }
    return Array.from(groups.entries())
  }, [photos])

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

  // The server rendered the first page unfiltered; reload whenever the filter set actually changes.
  const loadedFiltersKey = useRef(filtersKey)
  useEffect(() => {
    if (filtersKey === loadedFiltersKey.current) return
    loadedFiltersKey.current = filtersKey
    void loadPage(null, true, filters)
  }, [filters, filtersKey, loadPage])

  useEffect(() => {
    const node = loadSentinel.current
    if (!node || !cursor) return
    const observer = new IntersectionObserver((entries) => {
      if (entries[0]?.isIntersecting && !loading) void loadPage(cursor, false, filters)
    }, { rootMargin: "300px" })
    observer.observe(node)
    return () => observer.disconnect()
  }, [cursor, filters, loadPage, loading])

  function clearFilters() {
    setRange("all")
    setCustomRange(undefined)
    setSourceType(ALL)
    setUploaderId(ALL)
    setLocationId(ALL)
  }

  async function handleDownload(file: FileWithDetails) {
    try {
      await downloadUrlToFile(await getFileDownloadUrlAction(file.id), file.file_name)
    } catch {
      toast.error("Photo could not be downloaded")
    }
  }

  async function uploadPhotos(files: FileList | null) {
    const selectedFiles = Array.from(files ?? [])
    if (!selectedFiles.length) return
    const nonImages = selectedFiles.filter((file) => {
      const knownImageExtension = /\.(?:hei[cf]|jpe?g|png|gif|webp|avif)$/i.test(file.name)
      return !file.type.startsWith("image/") && !knownImageExtension
    })
    if (nonImages.length) {
      toast.error("Choose image files only")
      return
    }
    setUploading(true)
    try {
      const dailyLog = unwrapAction(await ensureTodayDailyLogForPhotosAction(projectId, toIsoDate(new Date())))
      for (const file of selectedFiles) {
        const formData = new FormData()
        formData.append("file", file)
        formData.append("daily_log_id", dailyLog.id)
        formData.append("category", "photos")
        unwrapAction(await uploadProjectFileAction(projectId, formData))
      }
      toast.success(`${selectedFiles.length} photo${selectedFiles.length === 1 ? "" : "s"} added to today's daily log`)
      await loadPage(null, true, filters)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Photos could not be uploaded")
    } finally {
      setUploading(false)
      if (fileInput.current) fileInput.current.value = ""
    }
  }

  return (
    <div className="min-h-0">
      <div className="sticky top-0 z-20 flex h-12 items-center gap-2 border-b bg-background/95 px-4 backdrop-blur sm:px-6">
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
                <SelectTrigger size="sm" className="w-full">
                  <SelectValue />
                </SelectTrigger>
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
                <SelectTrigger size="sm" className="w-full">
                  <SelectValue />
                </SelectTrigger>
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
                <SelectTrigger size="sm" className="w-full">
                  <SelectValue />
                </SelectTrigger>
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
                <p className="text-xs text-muted-foreground">Location</p>
                <Select value={locationId} onValueChange={setLocationId}>
                  <SelectTrigger size="sm" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={ALL}>All locations</SelectItem>
                    {locations.map((location) => (
                      <SelectItem key={location.id} value={location.id}>{location.full_path}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            ) : null}
          </PopoverContent>
        </Popover>

        <div className="flex-1" />

        {canUpload ? (
          <>
            <input
              ref={fileInput}
              className="sr-only"
              type="file"
              accept="image/*,.heic,.heif"
              multiple
              onChange={(event) => void uploadPhotos(event.target.files)}
            />
            <Button size="sm" className="h-8" onClick={() => fileInput.current?.click()} disabled={uploading}>
              {uploading ? <Loader2 className="animate-spin" /> : <ImagePlus />}
              Add photos
            </Button>
          </>
        ) : null}
      </div>

      {grouped.length === 0 && !loading ? (
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
              "Photos filed on daily logs, punch items, inspections, observations, RFIs, and project files land here."
            )}
          </p>
          {activeFilterCount === 0 && canUpload ? (
            <Button className="mt-5" variant="outline" size="sm" onClick={() => fileInput.current?.click()}>
              Add the first photos
            </Button>
          ) : null}
        </div>
      ) : (
        <ol className="px-4 sm:px-6">
          {grouped.map(([date, dayPhotos]) => {
            const day = parseISO(date)
            return (
              <li key={date} className="flex">
                <div className="w-20 shrink-0 pr-3 text-right sm:w-28 sm:pr-4">
                  {/* Clears the h-12 toolbar stuck above it. */}
                  <div className="sticky top-14 py-5">
                    <p className="text-xs font-medium tabular-nums">
                      {format(day, day.getFullYear() === currentYear ? "MMM d" : "MMM d, yyyy")}
                    </p>
                    <p className="mt-0.5 text-[11px] text-muted-foreground">{format(day, "EEE")}</p>
                    <p className="mt-2 hidden text-[11px] tabular-nums text-muted-foreground sm:block">
                      {dayPhotos.length} photo{dayPhotos.length === 1 ? "" : "s"}
                    </p>
                  </div>
                </div>

                <div className="relative min-w-0 flex-1 border-l py-5 pl-3 sm:pl-4">
                  <span aria-hidden className="absolute -left-[3px] top-[26px] size-[5px] bg-foreground" />
                  <div className="grid grid-cols-3 gap-px sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-6 2xl:grid-cols-8">
                    {dayPhotos.map((photo) => (
                      <button
                        key={photo.id}
                        type="button"
                        className="group relative aspect-square overflow-hidden bg-muted text-left focus-visible:z-10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        onClick={() => setSelectedId(photo.id)}
                        aria-label={`Open ${photo.file_name}`}
                      >
                        <Image
                          src={photo.thumbnail_url}
                          alt=""
                          fill
                          unoptimized
                          sizes="(max-width: 640px) 33vw, (max-width: 1024px) 20vw, 13vw"
                          className="object-cover"
                        />
                        <span className="absolute inset-x-0 bottom-0 translate-y-full truncate bg-background px-1.5 py-1 text-[10px] font-medium transition-transform duration-150 group-hover:translate-y-0 group-focus-visible:translate-y-0">
                          {sourceLabel(photo.primary_source.type)}
                        </span>
                      </button>
                    ))}
                  </div>
                </div>
              </li>
            )
          })}
        </ol>
      )}

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

      <FileViewer
        file={selectedViewerFile}
        files={viewerFiles}
        open={Boolean(selectedViewerFile)}
        onOpenChange={(open) => {
          if (!open) setSelectedId(null)
        }}
        onDownload={(file) => void handleDownload(file)}
        onFileChange={(file) => setSelectedId(file.id)}
        details={selected ? <PhotoDetails photo={selected} /> : undefined}
      />
    </div>
  )
}
