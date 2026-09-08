import { NextRequest, NextResponse } from "next/server"
import { z } from "zod"
import { actionError } from "@/lib/action-result"
import {
  loadDailyLogDayAction,
  loadDailyLogHistoryAction,
  loadDailyLogContextAction,
  resolveDailyLogDateAction,
  loadDailyLogDelayMonthAction,
  loadPreviousDailyLogCrewsAction,
} from "@/app/(app)/projects/[id]/daily-logs/actions"

/** Independent GET reads avoid placing background prefetches in the mutation queue. */
export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const started = performance.now()
  try {
    const { id: projectId } = await params
    z.string().uuid().parse(projectId)
    const query = request.nextUrl.searchParams
    const mode = z.enum(["day", "history", "context", "resolve", "delays", "crews"]).parse(query.get("mode"))
    const date = mode === "context" || mode === "resolve" ? "" : z.string().date().parse(query.get("date"))
    const result =
      mode === "day"
        ? await loadDailyLogDayAction(projectId, date)
        : mode === "history"
          ? await loadDailyLogHistoryAction(projectId, date)
          : mode === "context"
            ? await loadDailyLogContextAction(projectId)
            : mode === "resolve"
              ? await resolveDailyLogDateAction(projectId, z.string().uuid().parse(query.get("logId")))
              : mode === "delays"
                ? await loadDailyLogDelayMonthAction(projectId, date)
                : await loadPreviousDailyLogCrewsAction(projectId, date)
    return NextResponse.json(result, {
      status: result.success ? 200 : 400,
      headers: {
        "Cache-Control": "private, no-store",
        "Server-Timing": `daily-log;dur=${(performance.now() - started).toFixed(1)}`,
      },
    })
  } catch (error) {
    return NextResponse.json(actionError(error, "Unable to load daily logs"), {
      status: 400,
      headers: { "Cache-Control": "private, no-store" },
    })
  }
}

/** Multipart uploads run independently of the text-save action. */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    // Match server-action origin protection for the cookie-authenticated upload.
    if (request.headers.get("origin") !== request.nextUrl.origin)
      return NextResponse.json({ success: false, error: "Invalid request origin" }, { status: 403 })
    const { id: projectId } = await params
    z.string().uuid().parse(projectId)
    const { uploadProjectFileAction } = await import("@/app/(app)/projects/[id]/actions")
    const result = await uploadProjectFileAction(projectId, await request.formData())
    return NextResponse.json(result, {
      status: result.success ? 200 : 400,
      headers: { "Cache-Control": "private, no-store" },
    })
  } catch (error) {
    return NextResponse.json(actionError(error, "Unable to upload attachment"), { status: 400 })
  }
}
