import { handleMobileTime, loadMobileClockCostCodes } from "@/lib/mobile/time"

export const GET = (request: Request) =>
  handleMobileTime(request, (context) =>
    loadMobileClockCostCodes(context, new URL(request.url).searchParams.get("project_id")),
  )
