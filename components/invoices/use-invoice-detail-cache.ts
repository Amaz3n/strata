"use client"

import { useCallback, useEffect, useMemo, useRef, useState } from "react"

import { getInvoiceDetailAction } from "@/app/(app)/invoices/actions"
import { unwrapAction } from "@/lib/action-result"
import type { Invoice } from "@/lib/types"

import type { InvoiceDetailBundle } from "./invoice-inspector"

/**
 * The inspector's memory.
 *
 * Opening an invoice used to cost a full page re-render plus a detail request,
 * and nothing was kept, so walking back to the row you had just read paid the
 * whole price again. Bundles now live here, keyed by invoice id and stamped
 * with the row's `updated_at` — a row that has moved on invalidates its own
 * bundle, and a mutation invalidates explicitly. Hovering a row warms it; the
 * rows above and below the open one are warmed as soon as it is open, so j/k
 * and the next click are free.
 *
 * Module-level on purpose: the cache survives the list component remounting
 * on a soft navigation, which is exactly when people come back to a row.
 */

type CacheEntry = { bundle: InvoiceDetailBundle; updatedAt: string | null; fetchedAt: number }

const cache = new Map<string, CacheEntry>()
const inFlight = new Map<string, Promise<InvoiceDetailBundle | null>>()

/** Bundles older than this are refetched when opened, whatever the row says. */
const MAX_AGE_MS = 5 * 60_000

function isFresh(entry: CacheEntry | undefined, rowUpdatedAt: string | null | undefined) {
  if (!entry) return false
  if (Date.now() - entry.fetchedAt > MAX_AGE_MS) return false
  if (rowUpdatedAt && entry.updatedAt && rowUpdatedAt > entry.updatedAt) return false
  return true
}

function fetchBundle(invoiceId: string): Promise<InvoiceDetailBundle | null> {
  const pending = inFlight.get(invoiceId)
  if (pending) return pending
  const request = getInvoiceDetailAction(invoiceId)
    .then((result) => {
      const bundle = unwrapAction(result)
      cache.set(invoiceId, {
        bundle,
        updatedAt: bundle.invoice.updated_at ?? null,
        fetchedAt: Date.now(),
      })
      return bundle
    })
    .finally(() => {
      inFlight.delete(invoiceId)
    })
  inFlight.set(invoiceId, request)
  return request
}

export function invalidateInvoiceDetail(invoiceId?: string) {
  if (invoiceId) cache.delete(invoiceId)
  else cache.clear()
}

export function prefetchInvoiceDetail(invoiceId: string, rowUpdatedAt?: string | null) {
  if (isFresh(cache.get(invoiceId), rowUpdatedAt)) return
  void fetchBundle(invoiceId).catch(() => null)
}

export interface UseInvoiceDetailResult {
  detail: InvoiceDetailBundle | null
  loading: boolean
  error: string | null
  /** Drop the cached bundle and load it again — after a mutation. */
  refresh: () => Promise<InvoiceDetailBundle | null>
}

export function useInvoiceDetail(
  invoiceId: string | null,
  rows: Invoice[],
): UseInvoiceDetailResult {
  const rowById = useMemo(() => new Map(rows.map((row) => [row.id, row])), [rows])
  const row = invoiceId ? rowById.get(invoiceId) ?? null : null

  // Render reads the cache without consulting the clock: the age check lives in
  // the effect, so a prerender never sees the current time.
  const [state, setState] = useState<{ id: string | null; detail: InvoiceDetailBundle | null; error: string | null }>(
    () => ({ id: invoiceId, detail: invoiceId ? cache.get(invoiceId)?.bundle ?? null : null, error: null }),
  )
  const seq = useRef(0)

  const load = useCallback(
    async (id: string, options?: { force?: boolean }) => {
      const requestSeq = ++seq.current
      if (options?.force) cache.delete(id)
      try {
        const bundle = await fetchBundle(id)
        if (requestSeq !== seq.current) return null
        setState({ id, detail: bundle, error: null })
        return bundle
      } catch (error) {
        if (requestSeq !== seq.current) return null
        setState({ id, detail: null, error: error instanceof Error ? error.message : "Could not load the invoice." })
        return null
      }
    },
    [],
  )

  useEffect(() => {
    if (!invoiceId) {
      seq.current += 1
      setState({ id: null, detail: null, error: null })
      return
    }
    const entry = cache.get(invoiceId)
    if (isFresh(entry, row?.updated_at) && entry) {
      seq.current += 1
      setState({ id: invoiceId, detail: entry.bundle, error: null })
      return
    }
    // Keep the stale bundle on screen while the fresh one loads: a number that
    // is about to be corrected beats a skeleton that says nothing.
    setState((current) => (current.id === invoiceId ? current : { id: invoiceId, detail: entry?.bundle ?? null, error: null }))
    void load(invoiceId)
  }, [invoiceId, load, row?.updated_at])

  // Warm the neighbours once something is open, so the next row is instant.
  useEffect(() => {
    if (!invoiceId) return
    const index = rows.findIndex((entry) => entry.id === invoiceId)
    if (index < 0) return
    const neighbours = [rows[index + 1], rows[index - 1]].filter((entry): entry is Invoice => Boolean(entry))
    const handle = window.setTimeout(() => {
      for (const neighbour of neighbours) prefetchInvoiceDetail(neighbour.id, neighbour.updated_at)
    }, 150)
    return () => window.clearTimeout(handle)
  }, [invoiceId, rows])

  const refresh = useCallback(async () => {
    if (!invoiceId) return null
    return load(invoiceId, { force: true })
  }, [invoiceId, load])

  const detail = state.id === invoiceId ? state.detail : null
  return {
    detail,
    loading: Boolean(invoiceId) && !detail && !state.error,
    error: state.id === invoiceId ? state.error : null,
    refresh,
  }
}

/** Hover intent: warm a row's bundle after the pointer has rested on it briefly. */
export function useHoverPrefetch(delayMs = 120) {
  const timer = useRef<number | null>(null)
  const cancel = useCallback(() => {
    if (timer.current !== null) window.clearTimeout(timer.current)
    timer.current = null
  }, [])
  const arm = useCallback(
    (invoice: Pick<Invoice, "id" | "updated_at">) => {
      cancel()
      timer.current = window.setTimeout(() => prefetchInvoiceDetail(invoice.id, invoice.updated_at), delayMs)
    },
    [cancel, delayMs],
  )
  useEffect(() => cancel, [cancel])
  return { arm, cancel }
}
