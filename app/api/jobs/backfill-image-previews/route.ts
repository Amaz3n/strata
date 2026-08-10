import { NextRequest, NextResponse } from "next/server"

import { isAuthorizedCronRequest } from "@/lib/services/cron-auth"

import { backfillImagePreviews } from "@/lib/services/preview-backfill"

export const runtime = "nodejs"

const DEFAULT_BATCH_SIZE = 200
const MAX_BATCH_SIZE = 1000

/**
 * Re-previews images that predate the responsive ladder, one bounded batch per
 * call. Idempotent — call repeatedly until `enqueued` comes back 0.
 */
export async function POST(request: NextRequest) {
  if (!isAuthorizedCronRequest(request)) {
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
