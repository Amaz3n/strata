"use client"

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react"
import type { DocumentProps } from "react-pdf"
import { Document, Page } from "react-pdf"
import { configurePdfWorker } from "@/lib/pdf/worker"

import "react-pdf/dist/Page/AnnotationLayer.css"
import "react-pdf/dist/Page/TextLayer.css"

import { AlertTriangle, Download, RefreshCcw } from "@/components/icons"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { reportFileViewUrlFailure, resolveFileViewUrl } from "@/lib/files/view-url"
import { cn } from "@/lib/utils"
import {
  PDF_THUMB_HEIGHT,
  PDF_THUMB_WIDTH,
  PdfSkeleton,
  type PdfViewerStatus,
  type PdfZoom,
} from "./pdf-chrome"

configurePdfWorker()

// Sourced from react-pdf rather than from `pdfjs-dist` directly: pnpm resolves a
// second copy of pdfjs-dist under react-pdf, and the two copies' proxy types are
// structurally incompatible.
type PdfDocument = Parameters<NonNullable<DocumentProps["onLoadSuccess"]>>[0]
type PdfPage = Awaited<ReturnType<PdfDocument["getPage"]>>

/**
 * pdf.js's 64KB default chunk is tuned for a server on the same machine. Over a
 * network a larger chunk trades a few wasted bytes for far fewer round trips.
 */
const PDF_RANGE_CHUNK_SIZE = 256 * 1024

/**
 * Reading straight from storage. `disableAutoFetch` stops pdf.js from streaming
 * the rest of the document in the background the moment page 1 is up, so a 60MB
 * permit set costs the pages actually looked at rather than 60MB. That is only
 * the right trade when a byte range is cheap, which it is here.
 *
 * Both option objects must stay module constants: react-pdf re-loads the
 * document whenever the identity of this prop changes.
 */
const PDF_OPTIONS_DIRECT: DocumentProps["options"] = {
  disableAutoFetch: true,
  rangeChunkSize: PDF_RANGE_CHUNK_SIZE,
}

/**
 * Reading through the app instead. Every range re-runs the file lookup and both
 * permission checks before a byte moves, so fetching pages on demand would cost
 * more than letting pdf.js stream the file once in the background — the exact
 * opposite of the direct case, which is why the strategy follows the transport.
 */
const PDF_OPTIONS_PROXIED: DocumentProps["options"] = {
  rangeChunkSize: PDF_RANGE_CHUNK_SIZE,
}

interface PdfViewerProps {
  url: string
  /**
   * Enables direct-from-storage reads. With it, the viewer signs one URL and
   * pdf.js pulls every byte range straight from the bucket instead of through
   * the app; without it, `url` is used as-is. Omit for URLs the app does not
   * own — a portal token route, say — where no signed equivalent exists.
   */
  fileId?: string
  fileName: string
  zoom: PdfZoom
  rotation: number
  /** Reported on every meaningful change; must be referentially stable. */
  onStatusChange: (status: PdfViewerStatus) => void
  onDownload?: () => void
  className?: string
}

/** Unrotated media box of one page, in PDF points, plus its intrinsic /Rotate. */
interface PageMeta {
  width: number
  height: number
  rotate: number
}

/** CSS px per PDF point. 100% zoom renders the page at its print size. */
const CSS_UNITS = 96 / 72
/** US Letter portrait — the estimate used until a page reports its real box. */
const FALLBACK_META: PageMeta = { width: 612, height: 792, rotate: 0 }

const PAGE_GAP = 16
const PAGE_PAD_X = 24
const PAGE_PAD_Y = 24
const MIN_PAGE_WIDTH = 240
/** Canvases render at width × devicePixelRatio; past this it is a memory bomb. */
const MAX_PAGE_WIDTH = 4200

const RAIL_STRIDE = PDF_THUMB_WIDTH + 8
const RAIL_OVERSCAN = 3
/** Vertical space the floating rail covers, reserved at the end of the scroller. */
const RAIL_RESERVE = 148

const EMPTY_META: ReadonlyMap<number, PageMeta> = new Map()

interface PageLayout {
  /** Scroll-space top of each page, 0-indexed. */
  offsets: number[]
  /** Rendered height of each page, 0-indexed. */
  heights: number[]
  contentHeight: number
  trackWidth: number
  pageWidth: number
}

const EMPTY_LAYOUT: PageLayout = {
  offsets: [],
  heights: [],
  contentHeight: 0,
  trackWidth: 0,
  pageWidth: 0,
}

/** Index of the last page whose top is at or above `y`. Offsets are ascending. */
function indexAt(offsets: number[], y: number): number {
  let lo = 0
  let hi = offsets.length - 1
  let found = 0
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (offsets[mid] <= y) {
      found = mid
      lo = mid + 1
    } else {
      hi = mid - 1
    }
  }
  return found
}

function totalRotation(meta: PageMeta, rotation: number): number {
  return (((meta.rotate + rotation) % 360) + 360) % 360
}

/**
 * Displayed dimensions of a page once its intrinsic /Rotate and the user's
 * rotation are both applied. pdf.js swaps the axes on odd quarter turns, so we
 * mirror that here rather than inferring it from a rendered canvas.
 */
function displaySize(meta: PageMeta, rotation: number): { width: number; height: number } {
  return totalRotation(meta, rotation) % 180 === 0
    ? { width: meta.width, height: meta.height }
    : { width: meta.height, height: meta.width }
}

/**
 * A continuously scrollable PDF with a real text layer, a real annotation
 * layer, and a virtualized page rail — all served by ONE pdf.js document.
 *
 * Pages are absolutely positioned from a computed offset table rather than laid
 * out in flow, so only the visible page ±1 is ever mounted and a 200-page set
 * costs the same as a two-page one. The offset table is built from each page's
 * real media box where we have it and page 1's box where we do not; when a real
 * box lands late, `useLayoutEffect` re-pins the reader's anchor page so the
 * correction never shows up as a jump.
 */
export function PdfViewer({
  url,
  fileId,
  fileName,
  zoom,
  rotation,
  onStatusChange,
  onDownload,
  className,
}: PdfViewerProps) {
  /**
   * The signed storage URL, once we know one way or the other:
   * `undefined` while still resolving, `null` once we have settled on `url`.
   * Rendering waits for this rather than starting on `url` and swapping, which
   * would fetch the same document twice.
   */
  const [directUrl, setDirectUrl] = useState<string | null | undefined>(
    fileId ? undefined : null
  )
  const [pdf, setPdf] = useState<PdfDocument | null>(null)
  const [pageCount, setPageCount] = useState(0)
  const [failed, setFailed] = useState(false)
  const [reloadKey, setReloadKey] = useState(0)
  const [meta, setMeta] = useState<ReadonlyMap<number, PageMeta>>(EMPTY_META)
  const [viewport, setViewport] = useState({ width: 0, height: 0 })
  const [mountRange, setMountRange] = useState({ from: 1, to: 1 })
  const [activePage, setActivePage] = useState(1)
  const [railScrollLeft, setRailScrollLeft] = useState(0)
  const [railWidth, setRailWidth] = useState(0)

  const scrollRef = useRef<HTMLDivElement | null>(null)
  const [scrollNode, setScrollNode] = useState<HTMLDivElement | null>(null)
  const railRef = useRef<HTMLDivElement | null>(null)
  const [railNode, setRailNode] = useState<HTMLDivElement | null>(null)
  const layoutRef = useRef<PageLayout>(EMPTY_LAYOUT)
  const prevLayoutRef = useRef<PageLayout | null>(null)
  const anchorRef = useRef({ index: 0, within: 0 })
  const frameRef = useRef<number | null>(null)

  const attachScroll = useCallback((node: HTMLDivElement | null) => {
    scrollRef.current = node
    setScrollNode(node)
  }, [])

  const attachRail = useCallback((node: HTMLDivElement | null) => {
    railRef.current = node
    setRailNode(node)
  }, [])

  // Sign a storage URL for this file, and settle on the proxied `url` if there
  // is nothing to sign or signing fails. A retry re-resolves: the usual reason
  // to retry is an expired signature.
  useEffect(() => {
    if (!fileId) {
      setDirectUrl(null)
      return
    }

    let cancelled = false
    setDirectUrl(undefined)
    void resolveFileViewUrl(fileId).then((resolved) => {
      if (!cancelled) setDirectUrl(resolved)
    })

    return () => {
      cancelled = true
    }
  }, [fileId, reloadKey])

  /** What pdf.js actually reads. `null` means we are still deciding. */
  const sourceUrl = directUrl === undefined ? null : (directUrl ?? url)

  // A different file is a different document: drop everything derived from the
  // old one so no stale geometry survives the swap.
  useEffect(() => {
    setPdf(null)
    setPageCount(0)
    setFailed(false)
    setMeta(EMPTY_META)
    setMountRange({ from: 1, to: 1 })
    setActivePage(1)
    prevLayoutRef.current = null
    anchorRef.current = { index: 0, within: 0 }
  }, [sourceUrl, reloadKey])

  useEffect(() => {
    if (!scrollNode) return
    const measure = () => {
      setViewport((prev) =>
        prev.width === scrollNode.clientWidth && prev.height === scrollNode.clientHeight
          ? prev
          : { width: scrollNode.clientWidth, height: scrollNode.clientHeight }
      )
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(scrollNode)
    return () => observer.disconnect()
  }, [scrollNode])

  useEffect(() => {
    if (!railNode) return
    const measure = () => setRailWidth(railNode.clientWidth)
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(railNode)
    return () => observer.disconnect()
  }, [railNode])

  const baseMeta = meta.get(1) ?? FALLBACK_META
  const baseSize = displaySize(baseMeta, rotation)
  const baseWidth = baseSize.width
  const baseHeight = baseSize.height

  const hasViewport = viewport.width > 0
  const ready = pageCount > 0 && hasViewport

  /**
   * One width for the whole document. `fit-page` and `scale` measure against
   * page 1 rather than the page under the cursor, so scrolling a document with
   * mixed page sizes never resizes what you are already reading.
   */
  const pageWidth = useMemo(() => {
    if (!hasViewport) return 0
    const fitWidth = viewport.width - PAGE_PAD_X * 2
    let raw: number
    if (zoom.kind === "fit-page") {
      raw = Math.min(fitWidth, (viewport.height - PAGE_PAD_Y * 2) * (baseWidth / baseHeight))
    } else if (zoom.kind === "scale") {
      raw = baseWidth * CSS_UNITS * zoom.value
    } else {
      raw = fitWidth
    }
    return Math.round(Math.min(MAX_PAGE_WIDTH, Math.max(MIN_PAGE_WIDTH, raw)))
  }, [hasViewport, viewport.width, viewport.height, zoom, baseWidth, baseHeight])

  const effectiveScale = pageWidth > 0 ? pageWidth / (baseWidth * CSS_UNITS) : 1

  const layout = useMemo<PageLayout>(() => {
    if (!ready) return EMPTY_LAYOUT
    const offsets: number[] = new Array(pageCount)
    const heights: number[] = new Array(pageCount)
    let y = PAGE_PAD_Y
    for (let index = 0; index < pageCount; index += 1) {
      const size = displaySize(meta.get(index + 1) ?? baseMeta, rotation)
      // Mirrors react-pdf: it derives a scale from `width` and floors the
      // canvas's CSS height, so the slot matches the rendered page exactly.
      const height = Math.max(1, Math.floor((pageWidth * size.height) / size.width))
      offsets[index] = y
      heights[index] = height
      y += height + PAGE_GAP
    }
    return {
      offsets,
      heights,
      contentHeight: y - PAGE_GAP + PAGE_PAD_Y,
      trackWidth: Math.max(viewport.width, pageWidth + PAGE_PAD_X * 2),
      pageWidth,
    }
  }, [ready, pageCount, meta, baseMeta, rotation, pageWidth, viewport.width])

  /**
   * Reads scroll position and republishes the anchor, the mounted window and
   * the current page. Stable by design — it reads refs, never props — so the
   * scroll listener never has to be torn down and re-attached.
   */
  const syncFromScroll = useCallback(() => {
    const element = scrollRef.current
    const { offsets, heights } = layoutRef.current
    if (!element || offsets.length === 0) return

    const top = element.scrollTop
    const viewportHeight = element.clientHeight
    const first = indexAt(offsets, top)
    const last = indexAt(offsets, top + viewportHeight)

    anchorRef.current = { index: first, within: top - offsets[first] }

    // Page numbers, so `first` is the page one *before* the first visible one.
    const from = Math.max(1, first)
    const to = Math.min(offsets.length, last + 2)
    setMountRange((prev) => (prev.from === from && prev.to === to ? prev : { from, to }))

    // The page occupying the upper third is the one being read.
    const current = indexAt(offsets, top + viewportHeight * 0.34) + 1
    const clamped = Math.min(Math.max(current, 1), heights.length)
    setActivePage((prev) => (prev === clamped ? prev : clamped))
  }, [])

  /**
   * Zooming, rotating and late-arriving page dimensions all move every page
   * below the change. Re-pin the page the reader was on — scaling how far into
   * it they were — so the correction never surfaces as a jump.
   */
  useLayoutEffect(() => {
    layoutRef.current = layout
    const previous = prevLayoutRef.current
    prevLayoutRef.current = layout
    const element = scrollRef.current

    if (
      element &&
      previous &&
      previous.offsets.length > 0 &&
      previous.offsets.length === layout.offsets.length
    ) {
      const index = Math.min(anchorRef.current.index, layout.offsets.length - 1)
      const growth =
        previous.heights[index] > 0 ? layout.heights[index] / previous.heights[index] : 1
      const next = layout.offsets[index] + anchorRef.current.within * growth
      if (Math.abs(next - element.scrollTop) > 0.5) {
        element.scrollTop = next
      }
    }

    syncFromScroll()
  }, [layout, syncFromScroll])

  const handleScroll = useCallback(() => {
    if (frameRef.current !== null) return
    frameRef.current = window.requestAnimationFrame(() => {
      frameRef.current = null
      syncFromScroll()
    })
  }, [syncFromScroll])

  useEffect(() => {
    return () => {
      if (frameRef.current !== null) window.cancelAnimationFrame(frameRef.current)
    }
  }, [])

  const recordMeta = useCallback((pageNumber: number, page: PdfPage) => {
    const unrotated = page.getViewport({ scale: 1, rotation: 0 })
    setMeta((prev) => {
      const existing = prev.get(pageNumber)
      if (
        existing &&
        existing.width === unrotated.width &&
        existing.height === unrotated.height &&
        existing.rotate === page.rotate
      ) {
        return prev
      }
      const next = new Map(prev)
      next.set(pageNumber, {
        width: unrotated.width,
        height: unrotated.height,
        rotate: page.rotate,
      })
      return next
    })
  }, [])

  /**
   * Page geometry for a band around what is mounted. Without it the scrollbar
   * would be sized from page 1's aspect for the entire document; with it the
   * estimate is only ever wrong far outside the viewport. Deliberately NOT the
   * whole document: on a 200-page set that parses every page dictionary — and
   * drags most of the file over the wire — before the first page appears.
   */
  useEffect(() => {
    if (!pdf || pageCount === 0) return
    const from = Math.max(1, mountRange.from - 4)
    const to = Math.min(pageCount, mountRange.to + 4)
    const wanted: number[] = []
    if (!meta.has(1)) wanted.push(1)
    for (let pageNumber = from; pageNumber <= to; pageNumber += 1) {
      if (pageNumber !== 1 && !meta.has(pageNumber)) wanted.push(pageNumber)
    }
    if (wanted.length === 0) return

    let cancelled = false
    void (async () => {
      const found: Array<[number, PageMeta]> = []
      for (const pageNumber of wanted) {
        try {
          const page = await pdf.getPage(pageNumber)
          if (cancelled) return
          const unrotated = page.getViewport({ scale: 1, rotation: 0 })
          found.push([
            pageNumber,
            { width: unrotated.width, height: unrotated.height, rotate: page.rotate },
          ])
        } catch {
          // A page we cannot measure keeps page 1's estimate. If it ever
          // renders, onLoadSuccess corrects the layout then.
        }
      }
      if (cancelled || found.length === 0) return
      setMeta((prev) => {
        const next = new Map(prev)
        for (const [pageNumber, value] of found) next.set(pageNumber, value)
        return next
      })
    })()

    return () => {
      cancelled = true
    }
  }, [pdf, pageCount, mountRange, meta])

  const scrollToPage = useCallback(
    (pageNumber: number) => {
      const element = scrollRef.current
      const { offsets } = layoutRef.current
      if (!element || offsets.length === 0) return
      const index = Math.min(Math.max(pageNumber, 1), offsets.length) - 1
      // Instant, not smooth: a jump from page 2 to page 180 would otherwise
      // mount and tear down every page in between.
      element.scrollTop = Math.max(0, offsets[index] - PAGE_PAD_Y)
      syncFromScroll()
    },
    [syncFromScroll]
  )

  const handleItemClick = useCallback(
    ({ pageNumber }: { pageNumber: number }) => scrollToPage(pageNumber),
    [scrollToPage]
  )

  // Keep the active thumbnail in view, whether the page changed by scrolling or
  // by clicking the rail.
  useEffect(() => {
    const element = railRef.current
    if (!element) return
    const left = (activePage - 1) * RAIL_STRIDE
    if (left < element.scrollLeft || left + PDF_THUMB_WIDTH > element.scrollLeft + element.clientWidth) {
      element.scrollLeft = Math.max(0, left - element.clientWidth / 2 + PDF_THUMB_WIDTH / 2)
    }
  }, [activePage])

  const state: PdfViewerStatus["state"] = failed ? "error" : pageCount > 0 ? "ready" : "loading"

  useEffect(() => {
    onStatusChange({ state, pageCount, activePage, effectiveScale })
  }, [onStatusChange, state, pageCount, activePage, effectiveScale])

  const handleDocumentLoad = useCallback((proxy: PdfDocument) => {
    setPdf(proxy)
    setPageCount(proxy.numPages)
    setFailed(false)
  }, [])

  const handleDocumentError = useCallback(
    (error: Error) => {
      // A signed storage URL fails in ways the proxied route cannot: a
      // signature that lapsed while the file sat open, or a bucket whose CORS
      // policy does not admit this origin. Neither means the document is
      // broken, so drop back to the route that always works instead of
      // reporting a damaged file.
      if (fileId && directUrl) {
        reportFileViewUrlFailure(fileId)
        setDirectUrl(null)
        return
      }
      console.error("Failed to load PDF", error)
      setFailed(true)
    },
    [fileId, directUrl]
  )

  const handleRetry = useCallback(() => setReloadKey((key) => key + 1), [])

  const showRail = state === "ready" && pageCount > 1

  const mountedPages = useMemo(() => {
    if (!ready) return []
    const pages: number[] = []
    for (let pageNumber = mountRange.from; pageNumber <= mountRange.to; pageNumber += 1) {
      pages.push(pageNumber)
    }
    return pages
  }, [ready, mountRange])

  const railPages = useMemo(() => {
    if (!showRail) return []
    const width = railWidth > 0 ? railWidth : 480
    const from = Math.max(1, Math.floor(railScrollLeft / RAIL_STRIDE) + 1 - RAIL_OVERSCAN)
    const to = Math.min(pageCount, Math.ceil((railScrollLeft + width) / RAIL_STRIDE) + RAIL_OVERSCAN)
    const pages: number[] = []
    for (let pageNumber = from; pageNumber <= to; pageNumber += 1) pages.push(pageNumber)
    return pages
  }, [showRail, railWidth, railScrollLeft, pageCount])

  return (
    <div className={cn("relative h-full w-full bg-sidebar", className)}>
      <Document
        key={`${sourceUrl ?? "pending"}#${reloadKey}`}
        file={sourceUrl ?? undefined}
        options={directUrl ? PDF_OPTIONS_DIRECT : PDF_OPTIONS_PROXIED}
        className="contents"
        externalLinkTarget="_blank"
        externalLinkRel="noopener noreferrer"
        onItemClick={handleItemClick}
        onLoadSuccess={handleDocumentLoad}
        onLoadError={handleDocumentError}
        onSourceError={handleDocumentError}
        loading={null}
        error={null}
        noData={null}
      >
        <div
          ref={attachScroll}
          onScroll={handleScroll}
          tabIndex={0}
          role="region"
          aria-label={`${fileName}, ${pageCount} ${pageCount === 1 ? "page" : "pages"}`}
          className="h-full w-full overflow-auto outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
        >
          {ready && (
            <div
              className="relative"
              style={{
                width: layout.trackWidth,
                height: layout.contentHeight + (showRail ? RAIL_RESERVE : 0),
              }}
            >
              {mountedPages.map((pageNumber) => {
                const index = pageNumber - 1
                const pageMeta = meta.get(pageNumber) ?? baseMeta
                return (
                  <div
                    key={pageNumber}
                    data-page-number={pageNumber}
                    className="absolute"
                    style={{
                      top: layout.offsets[index],
                      left: Math.max(0, (layout.trackWidth - layout.pageWidth) / 2),
                      width: layout.pageWidth,
                      height: layout.heights[index],
                    }}
                  >
                    <Page
                      pageNumber={pageNumber}
                      width={layout.pageWidth}
                      rotate={totalRotation(pageMeta, rotation)}
                      renderTextLayer
                      renderAnnotationLayer
                      onLoadSuccess={(page) => recordMeta(pageNumber, page)}
                      className="shadow-2xl"
                      loading={
                        <Skeleton
                          style={{ width: layout.pageWidth, height: layout.heights[index] }}
                        />
                      }
                      error={
                        <div
                          className="flex items-center justify-center border border-sidebar-border bg-card text-sm text-muted-foreground"
                          style={{ width: layout.pageWidth, height: layout.heights[index] }}
                        >
                          Page {pageNumber} could not be rendered
                        </div>
                      }
                      noData={null}
                    />
                  </div>
                )
              })}
            </div>
          )}
        </div>

        {showRail && (
          <div className="pointer-events-none absolute inset-x-0 bottom-[max(env(safe-area-inset-bottom),0.75rem)] z-20 flex justify-center px-3">
            <div className="pointer-events-auto max-w-full overflow-hidden border bg-background/95 p-1.5 shadow-lg backdrop-blur-md">
              <div
                ref={attachRail}
                onScroll={(event) => setRailScrollLeft(event.currentTarget.scrollLeft)}
                className="overflow-x-auto"
              >
                <div
                  className="relative"
                  style={{ width: pageCount * RAIL_STRIDE, height: PDF_THUMB_HEIGHT }}
                >
                  {railPages.map((pageNumber) => {
                    const pageMeta = meta.get(pageNumber) ?? baseMeta
                    const size = displaySize(pageMeta, rotation)
                    const thumbWidth = Math.max(
                      24,
                      Math.min(
                        PDF_THUMB_WIDTH,
                        Math.round((PDF_THUMB_HEIGHT * size.width) / size.height)
                      )
                    )
                    const active = pageNumber === activePage
                    return (
                      <button
                        key={pageNumber}
                        type="button"
                        onClick={() => scrollToPage(pageNumber)}
                        aria-label={`Go to page ${pageNumber}`}
                        aria-current={active ? "true" : undefined}
                        className={cn(
                          "absolute top-0 flex items-center justify-center overflow-hidden bg-card transition-opacity",
                          active
                            ? "opacity-100 ring-2 ring-primary"
                            : "opacity-70 ring-1 ring-border hover:opacity-100"
                        )}
                        style={{
                          left: (pageNumber - 1) * RAIL_STRIDE,
                          width: PDF_THUMB_WIDTH,
                          height: PDF_THUMB_HEIGHT,
                        }}
                      >
                        <Page
                          pageNumber={pageNumber}
                          width={thumbWidth}
                          rotate={totalRotation(pageMeta, rotation)}
                          renderTextLayer={false}
                          renderAnnotationLayer={false}
                          loading={<Skeleton className="h-full w-full" />}
                          error={
                            <span className="text-[10px] font-medium tabular-nums text-muted-foreground">
                              {pageNumber}
                            </span>
                          }
                          noData={null}
                        />
                        <span
                          className={cn(
                            "absolute bottom-1 right-1 px-1.5 py-0.5 text-[10px] font-medium tabular-nums",
                            active
                              ? "bg-primary text-primary-foreground"
                              : "bg-sidebar text-sidebar-foreground"
                          )}
                        >
                          {pageNumber}
                        </span>
                      </button>
                    )
                  })}
                </div>
              </div>
            </div>
          </div>
        )}
      </Document>

      {state === "loading" && <PdfSkeleton />}

      {state === "error" && (
        <div className="absolute inset-0 flex items-center justify-center p-4">
          <div className="flex max-w-sm flex-col items-center gap-4 border bg-background/95 px-8 py-10 text-center shadow-xl backdrop-blur-md">
            <span className="flex h-14 w-14 items-center justify-center bg-destructive/10 text-destructive">
              <AlertTriangle className="h-7 w-7" />
            </span>
            <div>
              <p className="font-semibold">This PDF could not be displayed</p>
              <p className="mt-1 text-sm text-muted-foreground">
                It may still be uploading, or the file may be damaged. The original is
                untouched and can still be downloaded.
              </p>
            </div>
            <div className="flex flex-wrap items-center justify-center gap-2">
              <Button variant="outline" onClick={handleRetry}>
                <RefreshCcw className="mr-2 h-4 w-4" />
                Try again
              </Button>
              {onDownload && (
                <Button onClick={onDownload}>
                  <Download className="mr-2 h-4 w-4" />
                  Download
                </Button>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
