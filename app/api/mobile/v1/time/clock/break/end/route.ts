import { endBreakMobile, handleMobileTime, optionalJsonBody } from "@/lib/mobile/time"

export const POST = (request: Request) =>
  handleMobileTime(request, async (context) => endBreakMobile(context, await optionalJsonBody(request)))
