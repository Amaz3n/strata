import { NextRequest, NextResponse } from "next/server"
import { isAuthorizedCronRequest } from "@/lib/services/cron-auth"
import { withCronRun } from "@/lib/services/job-runs"
import { cleanupMeetingTranscriptAudio } from "@/lib/services/meeting-transcripts"

export const runtime = "nodejs"
export const maxDuration = 120
async function handler(request: NextRequest) {
  if (!isAuthorizedCronRequest(request)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  const dryRun = request.nextUrl.searchParams.get("dryRun") === "true"
  return NextResponse.json({ ok: true, dryRun, ...(await cleanupMeetingTranscriptAudio({ dryRun })) })
}
export const GET = withCronRun("meeting-audio-cleanup", handler)
export const POST = GET
