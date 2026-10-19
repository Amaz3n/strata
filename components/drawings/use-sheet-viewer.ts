"use client"

import { useCallback, useRef, useState } from "react"
import { toast } from "sonner"

import {
  createDrawingMarkupAction,
  deleteDrawingMarkupAction,
  getSheetDownloadUrlAction,
  getSheetOptimizedImageUrlsAction,
  listDrawingMarkupsAction,
  listDrawingPinsWithEntitiesAction,
  prioritizeSheetProcessingAction,
} from "@/app/(app)/drawings/actions"
import type { DrawingMarkup, DrawingPin, DrawingSheet } from "@/app/(app)/drawings/types"
import { unwrapAction } from "@/lib/action-result"
import { formatQuantityWithUom } from "@/lib/drawings/measure"
import type { SaveMarkupInput } from "./drawing-viewer"

type Loaded = { fileUrl: string | null; sheet: DrawingSheet; markups: DrawingMarkup[]; pins: DrawingPin[] }

/**
 * Everything a host needs to put the full-screen drawing viewer over its page:
 * which sheet is open and its siblings, the sheet's file, markups and pins
 * (cached per sheet so paging back is instant), and the writes the viewer
 * hands back. The register and the deal's plan room both host the viewer
 * through this.
 */
export function useSheetViewer() {
  const [open, setOpen] = useState(false)
  const [sheet, setSheet] = useState<DrawingSheet | null>(null)
  const [sheets, setSheets] = useState<DrawingSheet[]>([])
  const [url, setUrl] = useState<string | null>(null)
  const [markups, setMarkups] = useState<DrawingMarkup[]>([])
  const [pins, setPins] = useState<DrawingPin[]>([])
  const [highlightedPinId, setHighlightedPinId] = useState<string | null>(null)
  const [versionsOpen, setVersionsOpen] = useState(false)
  const cache = useRef(new Map<string, Loaded>())
  const request = useRef(0)

  const patchCache = useCallback((sheetId: string, change: (loaded: Loaded) => Loaded) => {
    const loaded = cache.current.get(sheetId)
    if (loaded) cache.current.set(sheetId, change(loaded))
  }, [])

  const openSheet = useCallback(
    async (target: DrawingSheet, siblings: DrawingSheet[], options: { highlightPinId?: string | null; openVersions?: boolean } = {}) => {
      const requestId = ++request.current
      setSheets(siblings.length ? siblings : [target])
      setHighlightedPinId(options.highlightPinId ?? null)
      setVersionsOpen(options.openVersions ?? false)
      setOpen(true)
      const cached = cache.current.get(target.id)
      if (cached) {
        setSheet(cached.sheet)
        setUrl(cached.fileUrl)
        setMarkups(cached.markups)
        setPins(cached.pins)
        return
      }
      setSheet(target)
      setUrl(null)
      setMarkups([])
      setPins([])
      try {
        const hasTiles = !!target.tile_base_url && !!target.tile_manifest
        // The user is looking at an unrendered sheet — jump its page job to
        // the front of the processing queue. Fire-and-forget.
        if (!hasTiles) void prioritizeSheetProcessingAction(target.id).catch(() => {})
        const hasOptimized = !!target.image_full_url && !!target.image_medium_url && !!target.image_thumbnail_url
        const [signed, fileUrl, loadedMarkups, loadedPins] = await Promise.all([
          hasOptimized && !hasTiles ? getSheetOptimizedImageUrlsAction(target.id).catch(() => null) : Promise.resolve(null),
          getSheetDownloadUrlAction(target.id).catch(() => null),
          listDrawingMarkupsAction({ drawing_sheet_id: target.id }).catch(() => []),
          listDrawingPinsWithEntitiesAction(target.id).catch(() => []),
        ])
        if (request.current !== requestId) return
        if (!hasOptimized && !hasTiles && !fileUrl) {
          toast.error("Sheet file not available")
          setOpen(false)
          return
        }
        const resolved: DrawingSheet =
          signed && !hasTiles
            ? {
                ...target,
                image_thumbnail_url: signed.thumbnailUrl ?? target.image_thumbnail_url ?? null,
                image_medium_url: signed.mediumUrl ?? target.image_medium_url ?? null,
                image_full_url: signed.fullUrl ?? target.image_full_url ?? null,
                image_width: signed.width ?? target.image_width ?? null,
                image_height: signed.height ?? target.image_height ?? null,
              }
            : target
        cache.current.set(target.id, { fileUrl, sheet: resolved, markups: loadedMarkups, pins: loadedPins })
        setSheet(resolved)
        setUrl(fileUrl)
        setMarkups(loadedMarkups)
        setPins(loadedPins)
      } catch {
        if (request.current === requestId) toast.error("Failed to load sheet")
      }
    },
    [],
  )

  const close = useCallback(() => setOpen(false), [])

  const saveMarkup = useCallback(
    async (markup: SaveMarkupInput) => {
      try {
        const created = unwrapAction(await createDrawingMarkupAction(markup))
        setMarkups((previous) => [...previous, created])
        patchCache(markup.drawing_sheet_id, (loaded) => ({ ...loaded, markups: [...loaded.markups, created] }))
      } catch {
        toast.error("Couldn't save that redline")
      }
    },
    [patchCache],
  )

  /**
   * A finished measurement. Same write path, different feedback: the panel
   * reports the rollup, so the toast names the quantity instead of saying
   * "saved" and leaving the user to hunt for the number.
   */
  const saveMeasurement = useCallback(
    async (markup: SaveMarkupInput) => {
      const created = unwrapAction(await createDrawingMarkupAction(markup))
      setMarkups((previous) => [...previous, created])
      patchCache(markup.drawing_sheet_id, (loaded) => ({ ...loaded, markups: [...loaded.markups, created] }))
      if (created.quantity !== null && created.uom) toast.success(`${formatQuantityWithUom(created.quantity, created.uom)} measured`)
      else toast.success("Measurement saved — set the sheet scale to price it")
    },
    [patchCache],
  )

  const deleteMarkup = useCallback(
    async (markupId: string) => {
      try {
        unwrapAction(await deleteDrawingMarkupAction(markupId))
        setMarkups((previous) => previous.filter((markup) => markup.id !== markupId))
        if (sheet) patchCache(sheet.id, (loaded) => ({ ...loaded, markups: loaded.markups.filter((markup) => markup.id !== markupId) }))
        toast.success("Markup deleted")
      } catch {
        toast.error("Failed to delete markup")
      }
    },
    [sheet, patchCache],
  )

  /**
   * Re-read the open sheet's markups after the server saved some on its own
   * (rooms filled from detection, accepted counts, moved measurements).
   */
  const markupsChanged = useCallback(() => {
    if (!sheet) return
    const sheetId = sheet.id
    void listDrawingMarkupsAction({ drawing_sheet_id: sheetId })
      .then((loaded) => {
        setMarkups(loaded)
        patchCache(sheetId, (current) => ({ ...current, markups: loaded }))
      })
      .catch(() => {})
  }, [sheet, patchCache])

  const addPin = useCallback(
    (pin: DrawingPin) => {
      setPins((previous) => [...previous, pin])
      patchCache(pin.drawing_sheet_id, (loaded) => ({ ...loaded, pins: [...loaded.pins, pin] }))
      setHighlightedPinId(pin.id)
    },
    [patchCache],
  )

  return {
    open,
    sheet,
    sheets,
    url,
    markups,
    pins,
    highlightedPinId,
    versionsOpen,
    openSheet,
    close,
    saveMarkup,
    saveMeasurement,
    deleteMarkup,
    markupsChanged,
    addPin,
  }
}
