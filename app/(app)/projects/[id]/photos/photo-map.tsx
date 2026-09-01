"use client"

import { useEffect, useMemo, useRef, useState } from "react"
import { useTheme } from "next-themes"
import { MapPin } from "lucide-react"

import { Skeleton } from "@/components/ui/skeleton"
import type { ProjectPhoto } from "@/lib/services/photos"

/**
 * The slice of the Google Maps API this view touches, typed by hand.
 *
 * The app loads the Maps JS API globally (app/layout.tsx) but installs no type
 * package for it, so the alternative to naming these six members is `any` across
 * the whole file. Naming them also documents exactly how much of Maps this
 * depends on.
 */
interface LatLngLiteral {
  lat: number
  lng: number
}

interface MapsBounds {
  extend(point: LatLngLiteral): void
  isEmpty(): boolean
}

interface MapsMarker {
  addListener(event: string, handler: () => void): void
  setMap(map: unknown): void
}

interface MapsMap {
  fitBounds(bounds: MapsBounds, padding?: number): void
  setCenter(point: LatLngLiteral): void
  setZoom(zoom: number): void
}

interface MapsNamespace {
  Map: new (element: HTMLElement, options: Record<string, unknown>) => MapsMap
  LatLngBounds: new () => MapsBounds
  Marker: new (options: Record<string, unknown>) => MapsMarker
}

/** The one place that reaches through `window` for the Maps global. */
function mapsNamespace(): MapsNamespace | null {
  if (typeof window === "undefined") return null
  const maps = (window as unknown as { google?: { maps?: MapsNamespace } }).google?.maps
  return maps?.Map ? maps : null
}

type MapStatus = "loading" | "ready" | "unavailable"

interface PhotoMapProps {
  photos: ProjectPhoto[]
  onOpen: (photo: ProjectPhoto) => void
  /** How many geotagged photos the project has in total, so a filtered-down map
   *  can say whether the emptiness is the filter's doing or the project's. */
  geotaggedTotal: number
}

export function PhotoMap({ photos, onOpen, geotaggedTotal }: PhotoMapProps) {
  const { resolvedTheme } = useTheme()
  const container = useRef<HTMLDivElement>(null)
  const map = useRef<MapsMap | null>(null)
  const markers = useRef<MapsMarker[]>([])
  const fitted = useRef(false)
  const [status, setStatus] = useState<MapStatus>("loading")

  const placed = useMemo(
    () => photos.filter((photo) => photo.latitude !== null && photo.longitude !== null),
    [photos],
  )

  // The Maps script is loaded by the root layout with `afterInteractive`, so it
  // may well not be there yet on first paint — and if the API key is missing it
  // never will be. Poll briefly, then say so rather than spinning forever.
  useEffect(() => {
    if (mapsNamespace()) {
      setStatus("ready")
      return
    }
    let cancelled = false
    let waited = 0
    const timer = window.setInterval(() => {
      if (cancelled) return
      if (mapsNamespace()) {
        window.clearInterval(timer)
        setStatus("ready")
        return
      }
      waited += 250
      if (waited >= 10_000) {
        window.clearInterval(timer)
        setStatus("unavailable")
      }
    }, 250)
    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [])

  useEffect(() => {
    if (status !== "ready" || !container.current) return
    const maps = mapsNamespace()
    if (!maps) return

    if (!map.current) {
      map.current = new maps.Map(container.current, {
        zoom: 17,
        center: { lat: 0, lng: 0 },
        mapTypeId: "hybrid",
        // Satellite with labels is the useful default for a jobsite: a photo pin
        // means far more against the roof it was taken on than against a road
        // map of an empty lot.
        disableDefaultUI: true,
        zoomControl: true,
        fullscreenControl: true,
        // Maps renders its own chrome; ask it to match the app instead of
        // hand-styling it, which would mean raw colour literals.
        colorScheme: resolvedTheme === "dark" ? "DARK" : "LIGHT",
      })
    }

    for (const marker of markers.current) marker.setMap(null)
    markers.current = []

    const bounds = new maps.LatLngBounds()
    for (const photo of placed) {
      const position = { lat: photo.latitude as number, lng: photo.longitude as number }
      const marker = new maps.Marker({ position, map: map.current, title: photo.file_name })
      marker.addListener("click", () => onOpen(photo))
      markers.current.push(marker)
      bounds.extend(position)
    }

    // Frame the work once. Re-fitting as infinite scroll loads more pages would
    // yank the viewport out from under someone who has zoomed into a corner of
    // the site to read it.
    if (!bounds.isEmpty() && !fitted.current) {
      map.current.fitBounds(bounds, 48)
      fitted.current = true
    }
  }, [status, placed, onOpen, resolvedTheme])

  // Reading the ref inside the cleanup rather than capturing it at mount is the
  // point: the array is rebuilt on every filter change, and capturing would take
  // the empty first one to the grave and leave the real markers attached.
  useEffect(() => () => {
    for (const marker of markers.current) marker.setMap(null)
    markers.current = []
  }, [])

  if (status === "unavailable") {
    return (
      <div className="flex flex-col items-center px-6 py-24 text-center">
        <MapPin className="size-6 text-muted-foreground" />
        <p className="mt-4 text-sm font-medium">Map unavailable</p>
        <p className="mt-1 max-w-sm text-sm text-muted-foreground">
          The Google Maps key is not configured for this environment, so photo locations cannot be plotted.
        </p>
      </div>
    )
  }

  if (placed.length === 0) {
    return (
      <div className="flex flex-col items-center px-6 py-24 text-center">
        <MapPin className="size-6 text-muted-foreground" />
        <p className="mt-4 text-sm font-medium">
          {geotaggedTotal > 0 ? "No located photos match these filters" : "No photos have a location yet"}
        </p>
        <p className="mt-1 max-w-sm text-sm text-muted-foreground">
          {geotaggedTotal > 0
            ? "Clear a filter to see the rest of this project's located photos."
            : "Photos carry a location when the camera records one. Turn on location for the camera app on site and new photos will appear here."}
        </p>
      </div>
    )
  }

  return (
    <div className="relative">
      {status === "loading" && <Skeleton className="absolute inset-4 z-10" />}
      <div ref={container} className="h-[calc(100vh-13rem)] min-h-[420px] w-full border-t" />
      <p className="border-t px-4 py-2 text-xs text-muted-foreground sm:px-6">
        {placed.length} of {photos.length} loaded photo{photos.length === 1 ? "" : "s"} have a location.
        {photos.length < geotaggedTotal ? " Scroll the timeline to load more." : ""}
      </p>
    </div>
  )
}
