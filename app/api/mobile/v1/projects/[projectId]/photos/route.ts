import { mobileDataResponse, mobileErrorResponse, mobileRequestId } from "@/lib/mobile/api"
import { requireMobileOrg } from "@/lib/mobile/auth"
import { runWithServiceOrgContext } from "@/lib/services/context"
import { listPhotoAlbums, listProjectPhotos, updatePhotoMetadata } from "@/lib/services/photos"
import type { ProjectPhotoFilters } from "@/lib/validation/photos"

/**
 * `URLSearchParams.get` answers `null` for an absent parameter, and the filter
 * schema's optional fields reject null — an absent `visibility` used to fail
 * validation and take the whole request with it.
 */
function optional(value: string | null): string | undefined {
  return value ?? undefined
}

function readFilters(search: URLSearchParams): ProjectPhotoFilters {
  const visibility = optional(search.get("visibility"))
  const mediaKind = optional(search.get("mediaKind"))
  return {
    album_id: optional(search.get("albumId")),
    location_id: optional(search.get("locationId")),
    visibility: visibility === "internal" || visibility === "client" ? visibility : undefined,
    media_kind: mediaKind === "image" || mediaKind === "video" ? mediaKind : undefined,
    search: optional(search.get("q")),
  }
}

function readLimit(search: URLSearchParams): number {
  const raw = Number(search.get("limit"))
  if (!Number.isFinite(raw) || raw <= 0) return 30
  return Math.min(Math.trunc(raw), 48)
}

export async function GET(request: Request, { params }: { params: Promise<{ projectId: string }> }) {
  const requestId = mobileRequestId(request)
  try {
    const context = await requireMobileOrg(request)
    const { projectId } = await params
    const search = new URL(request.url).searchParams
    const result = await runWithServiceOrgContext(context.serviceContext, async () => {
      const [page, albums] = await Promise.all([
        listProjectPhotos(
          {
            projectId,
            cursor: search.get("cursor"),
            limit: readLimit(search),
            filters: readFilters(search),
          },
          context.orgId,
        ),
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
