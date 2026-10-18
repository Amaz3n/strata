import { NextRequest, NextResponse } from "next/server"
import { unstable_rethrow } from "next/navigation"

import { logger } from "@/lib/logging/logger"
import { AuditExportRefusal, exportOrgAuditEvidence } from "@/lib/services/audit-export"
import { AuthorizationError } from "@/lib/services/authorization"

/**
 * The organization's audit evidence as a verifiable CSV. Session-authenticated:
 * the caller's own membership and `audit.read` decide, never a token.
 */
export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams
  try {
    const file = await exportOrgAuditEvidence({
      source: params.get("source") ?? "",
      from: params.get("from") ?? "",
      to: params.get("to") ?? "",
    })
    return new NextResponse(file.csv, {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="${file.filename}"`,
        "Cache-Control": "no-store",
        "X-Arc-Export-Digest": `sha256:${file.digest}`,
        "X-Arc-Export-Rows": String(file.manifest.row_count),
      },
    })
  } catch (error) {
    unstable_rethrow(error)
    if (error instanceof AuthorizationError) {
      return NextResponse.json({ error: "Exporting the audit trail requires the audit.read permission." }, { status: 403 })
    }
    if (error instanceof AuditExportRefusal) {
      return NextResponse.json({ error: error.message }, { status: error.reason === "forbidden" ? 403 : 400 })
    }
    logger.error("audit.export_failed", { error })
    return NextResponse.json({ error: "The audit export could not be produced. Try again." }, { status: 500 })
  }
}
