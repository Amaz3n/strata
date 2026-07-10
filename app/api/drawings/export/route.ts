import { NextResponse } from "next/server"

import { exportProjectSetPdf, exportSheetPdf } from "@/lib/services/drawings-export"

export const runtime = "nodejs"
// Whole-set exports copy hundreds of pages; give them the full window.
export const maxDuration = 300

export async function GET(request: Request) {
  const url = new URL(request.url)
  const sheetId = url.searchParams.get("sheetId")
  const versionId = url.searchParams.get("versionId")
  const projectId = url.searchParams.get("projectId")
  const discipline = url.searchParams.get("discipline")
  const includeMarkups = url.searchParams.get("markups") !== "0"

  try {
    if (sheetId) {
      const { bytes, fileName } = await exportSheetPdf({
        sheetId,
        versionId: versionId ?? undefined,
        includeMarkups,
      })
      return pdfResponse(bytes, fileName)
    }

    if (projectId) {
      const { bytes, fileName } = await exportProjectSetPdf({
        projectId,
        discipline: discipline ?? undefined,
        includeMarkups,
      })
      return pdfResponse(bytes, fileName)
    }

    return NextResponse.json({ error: "sheetId or projectId is required." }, { status: 400 })
  } catch (error) {
    const message = error instanceof Error ? error.message : "Export failed."
    console.error("[drawings export] failed:", error)
    const status = /not found|no published/i.test(message) ? 404 : 500
    return NextResponse.json({ error: message }, { status })
  }
}

function pdfResponse(bytes: Uint8Array, fileName: string) {
  return new NextResponse(Buffer.from(bytes), {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="${fileName.replace(/"/g, "")}"`,
      "Cache-Control": "private, no-store",
    },
  })
}
