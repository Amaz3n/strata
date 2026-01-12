import { NextRequest, NextResponse } from "next/server"
import { logPortalFileAccessAction } from "@/app/(app)/files/actions"

export async function POST(request: NextRequest) {
  try {
    const { fileId, portalToken, action, metadata } = await request.json()

    if (!fileId || !portalToken || !action) {
      return NextResponse.json(
        { error: "Missing required fields: fileId, portalToken, action" },
        { status: 400 }
      )
    }

    // Validate action type
    const validActions = ["view", "download", "share", "unshare", "print"]
    if (!validActions.includes(action)) {
      return NextResponse.json(
        { error: "Invalid action type" },
        { status: 400 }
      )
    }

    await logPortalFileAccessAction(fileId, portalToken, action, metadata || {})

    return NextResponse.json({ success: true })
  } catch (error: any) {
    console.error("Portal file access logging error:", error)
    return NextResponse.json(
      { error: "Failed to log file access" },
      { status: 500 }
    )
  }
}



