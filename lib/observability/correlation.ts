import "server-only"

import { AsyncLocalStorage } from "node:async_hooks"
import { randomUUID } from "node:crypto"
import { cache } from "react"
import { headers } from "next/headers"
import { unstable_rethrow } from "next/navigation"

/**
 * The id that ties together every row one unit of work writes: its audit rows,
 * its events and its authorization decisions.
 *
 * A worker names its unit explicitly (`withCorrelation`, e.g. one outbox job);
 * a request uses the id its edge already stamped on it (`x-request-id`, which
 * the mobile client sends, else Vercel's `x-vercel-id`), so a log line, a
 * Vercel trace and the database rows can be joined on one value. Anything else
 * gets a fresh id. Text, not uuid: header ids are not uuids.
 */
const MAX_LENGTH = 200

const scoped = new AsyncLocalStorage<string>()

/** Run `work` with every write inside it correlated to `id`. */
export function withCorrelation<T>(id: string, work: () => Promise<T>): Promise<T> {
  return scoped.run(id.slice(0, MAX_LENGTH), work)
}

// One id per request. Outside a request scope cache() does not memoize, so a
// caller with neither a scope nor a request gets a fresh id per call.
const requestCorrelationId = cache(async () => {
  try {
    const store = await headers()
    const id = store.get("x-request-id")?.trim() || store.get("x-vercel-id")?.trim()
    if (id) return id.slice(0, MAX_LENGTH)
  } catch (error) {
    // Prerender bail-outs are framework control flow, not a missing request.
    unstable_rethrow(error)
  }
  return randomUUID()
})

export async function correlationId(): Promise<string> {
  return scoped.getStore() ?? requestCorrelationId()
}

/**
 * A fetch for Supabase clients that stamps every database write with the
 * current correlation id, so rows written inside database functions (whose
 * columns default to `request_correlation_id()`) join the same unit of work.
 * The id is read per request, not when the client is built: the service client
 * is a singleton shared by every unit of work.
 *
 * Reads are not stamped. Nothing a read does lands in an audited table, and a
 * read may run inside a `"use cache"` scope, where resolving the request id
 * (`headers()`) is an error that fails the render even when caught.
 */
export function correlatedFetch(fetchRequest: typeof fetch = globalThis.fetch): typeof fetch {
  return async (input, init) => {
    const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase()
    if (method === "GET" || method === "HEAD") return fetchRequest(input, init)
    const stamped = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined))
    stamped.set("x-correlation-id", await correlationId())
    return fetchRequest(input, { ...init, headers: stamped })
  }
}
