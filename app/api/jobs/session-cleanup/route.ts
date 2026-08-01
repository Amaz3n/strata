import { NextRequest, NextResponse } from "next/server"
import { isAuthorizedCronRequest } from "@/lib/services/cron-auth"
import { withCronRun } from "@/lib/services/job-runs"
import { purgeExpiredExternalSessions } from "@/lib/services/external-portal-auth"

export const runtime = "nodejs"
export const maxDuration = 60

async function handler(request: NextRequest) {
  if (!isAuthorizedCronRequest(request)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  return NextResponse.json({ ok: true, removed: await purgeExpiredExternalSessions() })
}

export const GET = withCronRun("session-cleanup", handler)
export const POST = GET
