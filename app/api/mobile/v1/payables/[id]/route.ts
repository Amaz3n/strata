import { mobileDataResponse, mobileErrorResponse, mobileRequestId } from "@/lib/mobile/api"
import { requireMobileOrg } from "@/lib/mobile/auth"
import { getMobilePayable } from "@/lib/mobile/payables"


/**
 * One payable, in enough detail to decide it.
 *
 * Beyond the list row this carries the invoice document and the advisory
 * evidence already computed against the record — the line match against the
 * commitment, and the lien-waiver verification. None of it is a gate; it is what
 * a person would look at before saying yes.
 */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const requestId = mobileRequestId(request)
  try {
    const { id } = await params
    const context = await requireMobileOrg(request)
    return mobileDataResponse(await getMobilePayable(context, id), requestId)
  } catch (error) {
    return mobileErrorResponse(error, requestId)
  }
}
