import { clockOutMobile, handleMobileTime, optionalJsonBody } from "@/lib/mobile/time"

export const POST = (request: Request) =>
  handleMobileTime(request, async (context) => clockOutMobile(context, await optionalJsonBody(request)))
