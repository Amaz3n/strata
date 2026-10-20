import { approveTimeMobile, handleMobileTime, optionalJsonBody } from "@/lib/mobile/time"

export const POST = (request: Request) =>
  handleMobileTime(request, async (context) => approveTimeMobile(context, await optionalJsonBody(request)))
