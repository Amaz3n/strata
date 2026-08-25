import "server-only"

import { after } from "next/server"

import { logger } from "@/lib/logging/logger"

/**
 * Runs best-effort follow-up work after the response has been sent.
 *
 * Notification fan-out and search reindexing are consequences of a mutation, not
 * part of it: nothing in the response depends on them, and a failure in either
 * has always been swallowed. Awaiting them inside the handler only made the user
 * wait for work they will never see.
 *
 * `after` is available in Server Components, Server Actions, Route Handlers and
 * proxy — every context these services run from. It does not make a route
 * dynamic. Errors are logged here so a deferred callback cannot reject into a
 * handler that has already finished.
 */
export function afterResponse(event: string, work: () => Promise<unknown>) {
  after(async () => {
    try {
      await work()
    } catch (error) {
      logger.error(event, { error })
    }
  })
}
