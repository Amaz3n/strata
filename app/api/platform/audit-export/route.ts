import { NextRequest, NextResponse } from "next/server"

import { requireAuth } from "@/lib/auth/context"
import { requireAnyPermission } from "@/lib/services/permissions"
import { getAuditLogs } from "@/lib/services/admin"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

// Hard cap so an "all time" export can't fetch the whole table.
const MAX_ROWS = 5000
const PAGE_SIZE = 500

const CSV_HEADERS = [
  "id",
  "created_at",
  "action",
  "entity_type",
  "entity_id",
  "user_name",
  "user_email",
  "organization",
  "project",
  "description",
]

function csvCell(value: string | null): string {
  if (value === null || value === "") return ""
  return `"${value.replace(/"/g, '""')}"`
}

function param(request: NextRequest, key: string): string {
  return request.nextUrl.searchParams.get(key) ?? ""
}

export async function GET(request: NextRequest) {
  try {
    const { user } = await requireAuth()
    await requireAnyPermission(["audit.read", "platform.support.read"], { userId: user.id })
  } catch {
    return NextResponse.json({ error: "Unauthorized" }, { status: 403 })
  }

  const search = param(request, "search")
  const action = param(request, "action")
  const entityType = param(request, "entityType")
  const userFilter = param(request, "user")
  const orgId = param(request, "orgId")
  const timePeriod = param(request, "timePeriod")
  let startDate = param(request, "startDate")
  const endDate = param(request, "endDate")

  // Mirror the audit page default: 7 days unless a period or range is set.
  if (!startDate && timePeriod !== "all" && timePeriod !== "custom") {
    const days = timePeriod === "today" ? 1 : timePeriod === "30d" ? 30 : timePeriod === "90d" ? 90 : 7
    startDate = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString()
  }

  const rows: string[] = [CSV_HEADERS.join(",")]
  let page = 1
  let fetched = 0

  while (fetched < MAX_ROWS) {
    const result = await getAuditLogs({
      search,
      action: action && action !== "all" ? action : undefined,
      entityType: entityType && entityType !== "all" ? entityType : undefined,
      user: userFilter && userFilter !== "all" ? userFilter : undefined,
      orgId: orgId && orgId !== "all" ? orgId : undefined,
      startDate: startDate || undefined,
      endDate: endDate || undefined,
      page,
      limit: PAGE_SIZE,
    })

    for (const log of result.auditLogs) {
      rows.push(
        [
          csvCell(log.id),
          csvCell(log.createdAt),
          csvCell(log.action),
          csvCell(log.entityType),
          csvCell(log.entityId),
          csvCell(log.userName),
          csvCell(log.userEmail),
          csvCell(log.orgName),
          csvCell(log.projectName),
          csvCell(log.description),
        ].join(","),
      )
    }

    fetched += result.auditLogs.length
    if (!result.hasNextPage || result.auditLogs.length === 0) break
    page += 1
  }

  const filename = `arc-audit-log-${new Date().toISOString().slice(0, 10)}.csv`
  return new NextResponse(rows.join("\n"), {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Cache-Control": "no-store",
    },
  })
}
