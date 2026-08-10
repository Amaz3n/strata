"use client"

import { useEffect, useRef, useState } from "react"

import { toRenderableDrawingsUrl } from "@/lib/drawings/tile-urls"
import { parseTextRuns, TEXT_RUNS_FILE, type TextRun } from "@/lib/drawings/text-runs"

/**
 * The sheet's extracted text, loaded lazily alongside its vectors.
 *
 * Two takeoff features read it, both about not trusting a number:
 *
 *   - the local-scale check, which compares the dimensions PRINTED inside a
 *     region against the scale the sheet is calibrated at (a 1/2" detail on a
 *     1/4" sheet measures double, silently);
 *   - count-by-example's text disambiguation, where a GFCI is a duplex symbol
 *     plus a "GFI" tag and matching linework alone would merge them.
 *
 * Mirrors `use-sheet-vectors`: cached per sheet, fetched only when something
 * actually wants it, and every failure resolves to an empty list rather than an
 * error — a sheet with no extracted text simply gets no second opinion.
 */

export type SheetTextRunsStatus = "idle" | "loading" | "ready" | "unavailable"

export interface SheetTextRuns {
  runs: TextRun[]
  status: SheetTextRunsStatus
}

const CACHE_LIMIT = 8
const cache = new Map<string, Promise<TextRun[]>>()

function load(tileBaseUrl: string): Promise<TextRun[]> {
  const key = tileBaseUrl.replace(/\/$/, "")
  const cached = cache.get(key)
  if (cached) {
    cache.delete(key)
    cache.set(key, cached)
    return cached
  }

  const url = toRenderableDrawingsUrl(`${key}/${TEXT_RUNS_FILE}`)
  const promise = (
    url
      ? fetch(url, { credentials: "include" })
          .then(async (response) => (response.ok ? response.text() : null))
          .catch(() => null)
      : Promise.resolve(null)
  ).then((body) => (body ? parseTextRuns(body) : []))

  cache.set(key, promise)
  while (cache.size > CACHE_LIMIT) {
    const oldest = cache.keys().next().value
    if (oldest === undefined) break
    cache.delete(oldest)
  }
  return promise
}

export function useSheetTextRuns({
  tileBaseUrl,
  active,
}: {
  tileBaseUrl: string | null
  active: boolean
}): SheetTextRuns {
  const [state, setState] = useState<SheetTextRuns>({ runs: [], status: "idle" })
  const keyRef = useRef<string | null>(null)

  useEffect(() => {
    if (!active || !tileBaseUrl) return
    let cancelled = false
    const key = tileBaseUrl.replace(/\/$/, "")
    if (keyRef.current !== key) setState({ runs: [], status: "loading" })
    keyRef.current = key

    load(tileBaseUrl).then((runs) => {
      if (cancelled) return
      setState({ runs, status: runs.length > 0 ? "ready" : "unavailable" })
    })
    return () => {
      cancelled = true
    }
  }, [active, tileBaseUrl])

  return state
}
