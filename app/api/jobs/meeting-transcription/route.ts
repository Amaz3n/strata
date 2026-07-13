import { NextRequest, NextResponse } from "next/server"
import { isAuthorizedCronRequest } from "@/lib/services/cron-auth"
import { withCronRun } from "@/lib/services/job-runs"
import { processPendingMeetingTranscripts } from "@/lib/services/meeting-transcripts"

export const runtime = "nodejs"
export const maxDuration = 300
async function handler(request: NextRequest) {
  if (!isAuthorizedCronRequest(request)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  return NextResponse.json({ ok: true, ...(await processPendingMeetingTranscripts()) })
}
export const GET = withCronRun("meeting-transcription", handler)
export const POST = GET
