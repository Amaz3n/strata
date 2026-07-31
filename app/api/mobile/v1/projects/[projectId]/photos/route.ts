import { mobileDataResponse, mobileErrorResponse, mobileRequestId } from "@/lib/mobile/api"
import { requireMobileOrg } from "@/lib/mobile/auth"
import { runWithServiceOrgContext } from "@/lib/services/context"
import { listPhotoAlbums, listProjectPhotos, updatePhotoMetadata } from "@/lib/services/photos"

export const runtime = "nodejs"

export async function GET(request: Request, { params }: { params: Promise<{ projectId: string }> }) {
  const requestId = mobileRequestId(request)
  try {
    const context = await requireMobileOrg(request)
    const { projectId } = await params
    const search = new URL(request.url).searchParams
    const result = await runWithServiceOrgContext(context.serviceContext, async () => {
      const [page, albums] = await Promise.all([
        listProjectPhotos({ projectId, cursor: search.get("cursor"), limit: Math.min(Number(search.get("limit") ?? 30), 48), filters: { album_id: search.get("albumId") ?? undefined, visibility: search.get("visibility") as "internal" | "client" | undefined, search: search.get("q") ?? undefined } }, context.orgId),
        listPhotoAlbums(projectId, context.orgId),
      ])
      return { ...page, albums }
    })
    return mobileDataResponse(result, requestId)
  } catch (error) { return mobileErrorResponse(error, requestId) }
}

export async function PATCH(request: Request, { params }: { params: Promise<{ projectId: string }> }) {
  const requestId = mobileRequestId(request)
  try {
    const context = await requireMobileOrg(request)
    const { projectId } = await params
    const body = await request.json()
    const photo = await runWithServiceOrgContext(context.serviceContext, () => updatePhotoMetadata({ ...body, project_id: projectId }, context.orgId))
    return mobileDataResponse(photo, requestId)
  } catch (error) { return mobileErrorResponse(error, requestId) }
}
