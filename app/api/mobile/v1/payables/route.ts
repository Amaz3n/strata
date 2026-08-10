import { mobileDataResponse, mobileErrorResponse, mobileRequestId } from "@/lib/mobile/api"
import { requireMobileOrg } from "@/lib/mobile/auth"
import { parsePageSize } from "@/lib/mobile/contracts"
import { listMobilePayables } from "@/lib/mobile/payables"

export const runtime = "nodejs"

/**
 * Payables waiting on this person's approval.
 *
 * A bill sitting in "pending" is a vendor not being paid and a discount window
 * closing, and the people who can approve it are on job sites. The queue is
 * scoped to projects where the caller actually holds `bill.approve`, so what it
 * lists is what they can decide.
 *
 * Paged by number rather than cursor: this is a deadline list ordered by due
 * date, and it changes underneath the reader as approvals land, so a stable
 * cursor over `updated_at` would describe the wrong sequence.
 */
export async function GET(request: Request) {
  const requestId = mobileRequestId(request)
  try {
    const context = await requireMobileOrg(request)
    const url = new URL(request.url)
    const page = Number.parseInt(url.searchParams.get("page") ?? "1", 10)
    return mobileDataResponse(
      await listMobilePayables(context, {
        page: Number.isFinite(page) ? page : 1,
        pageSize: parsePageSize(url.searchParams.get("page_size")),
        search: url.searchParams.get("search") ?? undefined,
      }),
      requestId,
    )
  } catch (error) {
    return mobileErrorResponse(error, requestId)
  }
}
