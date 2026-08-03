"use client"

import { useEffect, useRef, useState } from "react"

import { toRenderableDrawingsUrl } from "@/lib/drawings/tile-urls"
import {
  buildVectorIndex,
  parseVectorsBin,
  type ImageSize,
  type VectorIndex,
} from "@/lib/drawings/vector-snap"

export type SheetVectorsStatus = "idle" | "loading" | "ready" | "unavailable"

export interface SheetVectors {
  index: VectorIndex | null
  /**
   * The raw normalized segments the index was built from, kept because
   * count-by-example matches on segment geometry directly rather than through
   * the snap index's spatial buckets. Same buffer, no second download.
   */
  segments: Float32Array | null
  status: SheetVectorsStatus
}

interface LoadedSheet {
  index: VectorIndex | null
  segments: Float32Array | null
}

const CACHE_LIMIT = 8

/** tile_base_url → settled vector index. */
const cache = new Map<string, Promise<LoadedSheet>>()

function sheetCacheKey(tileBaseUrl: string, imageSize: ImageSize): string {
  return `${tileBaseUrl.replace(/\/$/, "")}|${Math.round(imageSize.width)}x${Math.round(imageSize.height)}`
}

function loadSheet(tileBaseUrl: string, imageSize: ImageSize): Promise<LoadedSheet> {
  const key = sheetCacheKey(tileBaseUrl, imageSize)
  const cached = cache.get(key)
  if (cached) {
    cache.delete(key)
    cache.set(key, cached)
    return cached
  }

  const base = tileBaseUrl.replace(/\/$/, "")
  const vectorsUrl = toRenderableDrawingsUrl(`${base}/vectors.bin`)

  const promise = (vectorsUrl
    ? fetch(vectorsUrl, { credentials: "include" })
        .then(async (response) => (response.ok ? response.arrayBuffer() : null))
        .catch(() => null)
    : Promise.resolve(null)
  ).then((buffer): LoadedSheet => {
    if (!buffer) return { index: null, segments: null }
    const parsed = parseVectorsBin(buffer)
    if (!parsed || parsed.segments.length === 0) {
      return { index: null, segments: null }
    }
    const index = buildVectorIndex(parsed, imageSize)
    return { index, segments: parsed.segments }
  })

  cache.set(key, promise)
  while (cache.size > CACHE_LIMIT) {
    const oldest = cache.keys().next().value
    if (oldest === undefined) break
    cache.delete(oldest)
  }
  return promise
}

export function useSheetVectors({
  tileBaseUrl,
  imageSize,
  active,
}: {
  tileBaseUrl: string | null
  imageSize: ImageSize | null
  active: boolean
}): SheetVectors {
  const [state, setState] = useState<SheetVectors>({
    index: null,
    segments: null,
    status: "idle",
  })
  const currentEntryRef = useRef<{ key: string; entry: LoadedSheet } | null>(null)

  useEffect(() => {
    if (!active || !tileBaseUrl || !imageSize) return
    let cancelled = false
    const key = sheetCacheKey(tileBaseUrl, imageSize)
    if (currentEntryRef.current?.key !== key) {
      setState({ index: null, segments: null, status: "loading" })
    }
    loadSheet(tileBaseUrl, imageSize).then((entry) => {
      if (cancelled) return
      currentEntryRef.current = { key, entry }
      const available = !!entry.index
      setState({
        index: entry.index,
        segments: entry.segments,
        status: available ? "ready" : "unavailable",
      })
    })
    return () => {
      cancelled = true
    }
  }, [active, tileBaseUrl, imageSize])

  // Deliberately no unmount eviction: the CACHE_LIMIT LRU above already bounds
  // retention, and dropping the entry on unmount forced a re-download and
  // re-parse of vectors.bin every time a user stepped away and came back.

  return state
}
