import { NextRequest, NextResponse } from "next/server"

import { backfillImagePreviews } from "@/lib/services/preview-backfill"

export const runtime = "nodejs"

const CRON_SECRET = process.env.CRON_SECRET
const DEFAULT_BATCH_SIZE = 200
const MAX_BATCH_SIZE = 1000

function isAuthorized(request: NextRequest) {
  if (process.env.NODE_ENV !== "production") return true
  const authHeader = request.headers.get("authorization") ?? request.headers.get("Authorization")
  const bearer = typeof authHeader === "string" ? authHeader.trim() : ""
  const legacy = request.headers.get("x-cron-secret")
  return Boolean(CRON_SECRET) && (bearer === `Bearer ${CRON_SECRET}` || legacy === CRON_SECRET)
}

/**
 * Re-previews images that predate the responsive ladder, one bounded batch per
 * call. Idempotent — call repeatedly until `enqueued` comes back 0.
 */
export async function POST(request: NextRequest) {
  if (!isAuthorized(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  const requested = Number.parseInt(
    new URL(request.url).searchParams.get("batch") ?? "",
    10,
  )
  const batchSize = Number.isFinite(requested)
    ? Math.min(Math.max(requested, 1), MAX_BATCH_SIZE)
    : DEFAULT_BATCH_SIZE

  try {
    const result = await backfillImagePreviews({ batchSize })
    return NextResponse.json(result)
  } catch (error) {
    const message = error instanceof Error ? error.message : "Backfill failed"
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
