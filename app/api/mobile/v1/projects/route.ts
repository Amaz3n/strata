import { mobileErrorResponse, mobilePageResponse, mobileRequestId, MobileAPIError } from "@/lib/mobile/api"
import { decodeCursor, encodeCursor, parsePageSize } from "@/lib/mobile/contracts"
import { requireMobileOrg } from "@/lib/mobile/auth"
import { mapMobileProject } from "@/lib/mobile/projects"
import { listProjects } from "@/lib/services/projects"

export const runtime = "nodejs"

export async function GET(request: Request) {
  const requestId = mobileRequestId(request)
  try {
    const context = await requireMobileOrg(request)
    const url = new URL(request.url)
    const limit = parsePageSize(url.searchParams.get("limit"))
    const cursorValue = url.searchParams.get("cursor")
    const cursor = decodeCursor(cursorValue)
    if (cursorValue && !cursor) {
      throw new MobileAPIError(400, "invalid_cursor", "The pagination cursor is invalid.")
    }

    const projects = (await listProjects(context.orgId, context.serviceContext))
      .map(mapMobileProject)
      .sort((left, right) => {
        const dateComparison = right.updated_at.localeCompare(left.updated_at)
        return dateComparison === 0 ? right.id.localeCompare(left.id) : dateComparison
      })

    const afterCursor = cursor
      ? projects.filter(
          (project) =>
            project.updated_at < cursor.updated_at ||
            (project.updated_at === cursor.updated_at && project.id < cursor.id),
        )
      : projects
    const page = afterCursor.slice(0, limit)
    const hasMore = afterCursor.length > page.length
    const last = page.at(-1)
    const nextCursor = hasMore && last ? encodeCursor(last.updated_at, last.id) : null

    return mobilePageResponse(page, requestId, nextCursor)
  } catch (error) {
    return mobileErrorResponse(error, requestId)
  }
}
