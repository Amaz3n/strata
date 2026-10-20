import { switchClockMobile, handleMobileTime, optionalJsonBody } from "@/lib/mobile/time"

export const POST = (request: Request) =>
  handleMobileTime(request, async (context) => switchClockMobile(context, await optionalJsonBody(request)))
