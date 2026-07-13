"use client"

import Image from "next/image"
import Link from "next/link"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { format, parseISO } from "date-fns"
import { ChevronLeft, ChevronRight, ExternalLink, ImagePlus, Loader2, MapPin, RotateCcw } from "lucide-react"
import { toast } from "sonner"

import { uploadProjectFileAction } from "../actions"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { DateRangePicker } from "@/components/ui/date-range-picker"
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { unwrapAction } from "@/lib/action-result"
import type { ProjectPhoto, ProjectPhotoPage, ProjectPhotoUploader } from "@/lib/services/photos"
import type { ProjectPhotoFilters } from "@/lib/validation/photos"
import { cn } from "@/lib/utils"
import { ensureTodayDailyLogForPhotosAction, listProjectPhotosAction } from "./actions"
import type { DateRange } from "react-day-picker"

const ALL = "__all__"
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

type FilterDraft = {
  dateRange?: DateRange
  sourceType: string
  uploaderId: string
  locationId: string
}

const EMPTY_FILTERS: FilterDraft = { sourceType: ALL, uploaderId: ALL, locationId: ALL }

function toServiceFilters(draft: FilterDraft): ProjectPhotoFilters {
  return {
    date_from: draft.dateRange?.from ? format(draft.dateRange.from, "yyyy-MM-dd") : undefined,
    date_to: draft.dateRange?.to ? format(draft.dateRange.to, "yyyy-MM-dd") : undefined,
    source_type: draft.sourceType === ALL ? undefined : draft.sourceType,
    uploader_id: draft.uploaderId === ALL ? undefined : draft.uploaderId,
    location_id: draft.locationId === ALL ? undefined : draft.locationId,
  }
}

function sourceLabel(type: string) {
  return SOURCE_OPTIONS.find((option) => option.value === type)?.label.replace(/s$/, "") ?? type.replaceAll("_", " ")
}

function formatBytes(bytes: number | null) {
  if (!bytes) return "Unknown size"
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
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
  const [draftFilters, setDraftFilters] = useState<FilterDraft>(EMPTY_FILTERS)
  const [filters, setFilters] = useState<ProjectPhotoFilters>({})
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)
  const loadSentinel = useRef<HTMLDivElement | null>(null)
  const fileInput = useRef<HTMLInputElement | null>(null)
  const selectedIndex = photos.findIndex((photo) => photo.id === selectedId)
  const selected = selectedIndex >= 0 ? photos[selectedIndex] : null

  const grouped = useMemo(() => {
    const groups = new Map<string, ProjectPhoto[]>()
    for (const photo of photos) {
      const key = photo.created_at.slice(0, 10)
      groups.set(key, [...(groups.get(key) ?? []), photo])
    }
    return Array.from(groups.entries())
  }, [photos])

  const loadPage = useCallback(async (nextCursor: string | null, replace = false, nextFilters = filters) => {
    if (loading) return
    setLoading(true)
    setLoadError(null)
    try {
      const page = unwrapAction(await listProjectPhotosAction({ projectId, cursor: nextCursor, limit: 30, filters: nextFilters }))
      setPhotos((current) => replace ? page.photos : [...current, ...page.photos.filter((photo) => !current.some((existing) => existing.id === photo.id))])
      setCursor(page.next_cursor)
    } catch (error) {
      const message = error instanceof Error ? error.message : "Photos could not be loaded"
      setLoadError(message)
      toast.error(message)
    } finally {
      setLoading(false)
    }
  }, [filters, loading, projectId])

  useEffect(() => {
    const node = loadSentinel.current
    if (!node || !cursor) return
    const observer = new IntersectionObserver((entries) => {
      if (entries[0]?.isIntersecting && !loading) void loadPage(cursor)
    }, { rootMargin: "300px" })
    observer.observe(node)
    return () => observer.disconnect()
  }, [cursor, loadPage, loading])

  async function applyFilters() {
    const nextFilters = toServiceFilters(draftFilters)
    setFilters(nextFilters)
    await loadPage(null, true, nextFilters)
  }

  async function clearFilters() {
    setDraftFilters(EMPTY_FILTERS)
    setFilters({})
    await loadPage(null, true, {})
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
      const dailyLog = unwrapAction(await ensureTodayDailyLogForPhotosAction(projectId, format(new Date(), "yyyy-MM-dd")))
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
    <div className="min-h-0 px-4 py-4 sm:px-6">
      <div className="mb-4 flex flex-col gap-3 border-b pb-4 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <p className="text-sm font-medium">Project photo register</p>
          <p className="text-xs text-muted-foreground">One chronological lens across field records and project files.</p>
        </div>
        {canUpload ? (
          <>
            <input ref={fileInput} className="sr-only" type="file" accept="image/*,.heic,.heif" multiple onChange={(event) => void uploadPhotos(event.target.files)} />
            <Button size="sm" onClick={() => fileInput.current?.click()} disabled={uploading}>
              {uploading ? <Loader2 className="animate-spin" /> : <ImagePlus />}
              Add photos
            </Button>
          </>
        ) : null}
      </div>

      <div className="mb-6 grid gap-2 border bg-muted/20 p-2 sm:grid-cols-2 xl:grid-cols-[minmax(220px,1.2fr)_repeat(3,minmax(150px,0.8fr))_auto]">
        <DateRangePicker dateRange={draftFilters.dateRange} onDateRangeChange={(dateRange) => setDraftFilters((current) => ({ ...current, dateRange }))} placeholder="Date range" />
        <Select value={draftFilters.sourceType} onValueChange={(sourceType) => setDraftFilters((current) => ({ ...current, sourceType }))}>
          <SelectTrigger className="w-full"><SelectValue placeholder="Source" /></SelectTrigger>
          <SelectContent><SelectItem value={ALL}>All sources</SelectItem>{SOURCE_OPTIONS.map((option) => <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>)}</SelectContent>
        </Select>
        <Select value={draftFilters.uploaderId} onValueChange={(uploaderId) => setDraftFilters((current) => ({ ...current, uploaderId }))}>
          <SelectTrigger className="w-full"><SelectValue placeholder="Uploader" /></SelectTrigger>
          <SelectContent><SelectItem value={ALL}>All uploaders</SelectItem>{uploaders.map((uploader) => <SelectItem key={uploader.id} value={uploader.id}>{uploader.name}</SelectItem>)}</SelectContent>
        </Select>
        <Select value={draftFilters.locationId} onValueChange={(locationId) => setDraftFilters((current) => ({ ...current, locationId }))}>
          <SelectTrigger className="w-full"><SelectValue placeholder="Location" /></SelectTrigger>
          <SelectContent><SelectItem value={ALL}>All locations</SelectItem>{locations.map((location) => <SelectItem key={location.id} value={location.id}>{location.full_path}</SelectItem>)}</SelectContent>
        </Select>
        <div className="flex gap-2"><Button className="flex-1" variant="outline" onClick={() => void applyFilters()} disabled={loading}>Apply</Button><Button variant="ghost" size="icon" onClick={() => void clearFilters()} disabled={loading} aria-label="Clear photo filters"><RotateCcw /></Button></div>
      </div>

      {photos.length === 0 && !loading ? (
        <div className="border border-dashed px-6 py-20 text-center">
          <ImagePlus className="mx-auto size-8 text-muted-foreground" />
          <h2 className="mt-4 text-sm font-semibold">No photos yet</h2>
          <p className="mx-auto mt-2 max-w-md text-xs text-muted-foreground">Photos attached to daily logs, punch items, inspections, observations, RFIs, and project files appear here. Photos added here are filed on today's daily log.</p>
          {canUpload ? <Button className="mt-5" variant="outline" size="sm" onClick={() => fileInput.current?.click()}>Add the first photos</Button> : null}
        </div>
      ) : (
        <div className="space-y-8">
          {grouped.map(([date, datePhotos]) => (
            <section key={date} aria-labelledby={`photo-day-${date}`}>
              <div className="mb-2 flex items-baseline gap-3 border-b pb-2">
                <h2 id={`photo-day-${date}`} className="text-sm font-semibold">{format(parseISO(date), "EEEE, MMMM d")}</h2>
                <span className="text-xs tabular-nums text-muted-foreground">{datePhotos.length} photo{datePhotos.length === 1 ? "" : "s"}</span>
              </div>
              <div className="grid grid-cols-2 gap-px border bg-border sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 2xl:grid-cols-6">
                {datePhotos.map((photo) => (
                  <button key={photo.id} type="button" className="group relative aspect-[4/3] overflow-hidden bg-muted text-left focus-visible:z-10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" onClick={() => setSelectedId(photo.id)} aria-label={`Open ${photo.file_name}`}>
                    <Image src={photo.thumbnail_url} alt="" fill unoptimized sizes="(max-width: 640px) 50vw, (max-width: 1024px) 25vw, 17vw" className="object-cover transition-transform duration-200 group-hover:scale-[1.02]" />
                    <div className="absolute inset-x-0 bottom-0 border-t bg-background p-2">
                      <div className="flex min-w-0 items-center justify-between gap-2">
                        <span className="truncate text-[11px] font-medium">{photo.primary_source.label}</span>
                        <Badge variant="outline" className="bg-background px-1.5 py-0 text-[10px]">{sourceLabel(photo.primary_source.type)}</Badge>
                      </div>
                      {photo.locations[0] ? <p className="mt-1 flex items-center gap-1 truncate text-[10px] text-muted-foreground"><MapPin className="size-2.5 shrink-0" />{photo.locations[0]}</p> : null}
                    </div>
                  </button>
                ))}
              </div>
            </section>
          ))}
        </div>
      )}

      <div ref={loadSentinel} className="flex h-20 items-center justify-center" aria-live="polite">
        {loading ? <span className="flex items-center gap-2 text-xs text-muted-foreground"><Loader2 className="size-4 animate-spin" />Loading photos</span> : null}
        {loadError && cursor ? <Button size="sm" variant="outline" onClick={() => void loadPage(cursor)}>Try again</Button> : null}
      </div>

      <Dialog open={Boolean(selected)} onOpenChange={(open) => { if (!open) setSelectedId(null) }}>
        <DialogContent className="h-[min(88vh,860px)] max-w-[min(96vw,1280px)] grid-cols-1 gap-0 overflow-hidden p-0 lg:grid-cols-[minmax(0,1fr)_320px]" showCloseButton>
          {selected ? (
            <>
              <div className="relative min-h-0 bg-muted/40">
                <Image src={selected.image_url} alt={selected.file_name} fill unoptimized sizes="(max-width: 1024px) 100vw, 75vw" className="object-contain" />
                <Button className="absolute left-3 top-1/2 -translate-y-1/2" size="icon" variant="secondary" disabled={selectedIndex <= 0} onClick={() => setSelectedId(photos[selectedIndex - 1]?.id ?? null)} aria-label="Previous photo"><ChevronLeft /></Button>
                <Button className="absolute right-3 top-1/2 -translate-y-1/2 lg:right-3" size="icon" variant="secondary" disabled={selectedIndex >= photos.length - 1} onClick={() => setSelectedId(photos[selectedIndex + 1]?.id ?? null)} aria-label="Next photo"><ChevronRight /></Button>
              </div>
              <aside className="min-h-0 overflow-y-auto border-t bg-background p-5 lg:border-l lg:border-t-0">
                <DialogTitle className="pr-8 text-sm">{selected.file_name}</DialogTitle>
                <DialogDescription className="mt-1 text-xs">{format(parseISO(selected.created_at), "MMM d, yyyy 'at' h:mm a")}</DialogDescription>
                <dl className="mt-6 divide-y border-y text-xs">
                  <div className="grid grid-cols-[88px_1fr] gap-3 py-3"><dt className="text-muted-foreground">Uploader</dt><dd>{selected.uploader_name ?? "Unknown"}</dd></div>
                  <div className="grid grid-cols-[88px_1fr] gap-3 py-3"><dt className="text-muted-foreground">File</dt><dd>{formatBytes(selected.size_bytes)}{selected.mime_type ? ` · ${selected.mime_type}` : ""}</dd></div>
                  <div className="grid grid-cols-[88px_1fr] gap-3 py-3"><dt className="text-muted-foreground">Location</dt><dd>{selected.locations.length ? selected.locations.join(", ") : "Not assigned"}</dd></div>
                </dl>
                <div className="mt-6">
                  <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Sources</p>
                  <div className="mt-2 divide-y border">
                    {selected.sources.map((source) => (
                      <Link key={`${source.type}:${source.entity_id}`} href={source.href} className="flex items-start justify-between gap-3 p-3 text-xs hover:bg-muted/50">
                        <span><span className="block font-medium">{source.label}</span>{source.location ? <span className="mt-1 block text-muted-foreground">{source.location}</span> : null}</span>
                        <ExternalLink className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
                      </Link>
                    ))}
                  </div>
                </div>
                <Button asChild variant="outline" size="sm" className="mt-6 w-full"><a href={selected.image_url} target="_blank" rel="noreferrer">Open original</a></Button>
              </aside>
            </>
          ) : null}
        </DialogContent>
      </Dialog>
    </div>
  )
}
