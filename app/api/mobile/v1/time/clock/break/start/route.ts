import { startBreakMobile, handleMobileTime, optionalJsonBody } from "@/lib/mobile/time"

export const POST = (request: Request) =>
  handleMobileTime(request, async (context) => startBreakMobile(context, await optionalJsonBody(request)))
