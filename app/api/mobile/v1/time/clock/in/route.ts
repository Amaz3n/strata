import { clockInMobile, handleMobileTime, optionalJsonBody } from "@/lib/mobile/time"

export const POST = (request: Request) =>
  handleMobileTime(request, async (context) => clockInMobile(context, await optionalJsonBody(request)))
