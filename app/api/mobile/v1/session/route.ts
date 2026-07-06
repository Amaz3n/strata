import { mobileDataResponse, mobileErrorResponse, mobileRequestId } from "@/lib/mobile/api"
import { mapMobileUser, listMobileOrganizations, requireMobileUser } from "@/lib/mobile/auth"

export const runtime = "nodejs"

export async function GET(request: Request) {
  const requestId = mobileRequestId(request)
  try {
    const context = await requireMobileUser(request)
    const organizations = await listMobileOrganizations(context)
    const requestedOrgId = request.headers.get("x-arc-organization-id")
    const selectedOrgId = organizations.some((org) => org.id === requestedOrgId)
      ? requestedOrgId
      : organizations[0]?.id ?? null

    return mobileDataResponse(
      {
        user: mapMobileUser(context.user),
        organizations,
        selected_organization_id: selectedOrgId,
      },
      requestId,
    )
  } catch (error) {
    return mobileErrorResponse(error, requestId)
  }
}
