import { NextResponse, type NextRequest } from "next/server"
import { ZodError } from "zod"

import { recordPortalFileAccess } from "@/lib/services/file-access-events"
import { portalFileAccessLogSchema } from "@/lib/validation/files"

export async function POST(request: NextRequest) {
  try {
    const parsed = portalFileAccessLogSchema.parse(await request.json())
    await recordPortalFileAccess(parsed)

    return NextResponse.json({ success: true })
  } catch (error) {
    if (error instanceof ZodError) {
      return NextResponse.json({ error: "Invalid file access payload" }, { status: 400 })
    }
    console.error("Portal file access logging error:", error)
    return NextResponse.json({ error: "Failed to log file access" }, { status: 500 })
  }
}
