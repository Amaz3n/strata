import { NextResponse, type NextRequest } from "next/server"
import { build1099FilingFile } from "@/lib/services/books/vendor-1099-packages"

// The filing-partner import file of an approved 1099 package. It carries full
// taxpayer IDs, so it is built per request for members who file taxes and never cached.
export async function GET(request: NextRequest, { params }: { params: Promise<{ packageId: string }> }) {
  try {
    const { packageId } = await params
    request.signal.throwIfAborted()
    const file = await build1099FilingFile(packageId)
    return new Response(file.content, { headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${file.filename}"`,
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
    } })
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not build the filing file"
    const status = /permission|not authorized|access denied|forbidden|not authenticated/i.test(message) ? 403 : /not found/i.test(message) ? 404 : 409
    return NextResponse.json({ error: status === 403 ? "You do not have access to 1099 filing files." : message }, { status, headers: { "Cache-Control": "private, no-store" } })
  }
}
