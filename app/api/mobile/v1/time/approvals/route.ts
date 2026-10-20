import { handleMobileTime, loadMobileApprovals } from "@/lib/mobile/time"

export const GET = (request: Request) =>
  handleMobileTime(request, (context) => loadMobileApprovals(context, new URL(request.url).searchParams))
