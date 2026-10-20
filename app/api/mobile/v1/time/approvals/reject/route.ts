import { rejectTimeMobile, handleMobileTime, optionalJsonBody } from "@/lib/mobile/time"

export const POST = (request: Request) =>
  handleMobileTime(request, async (context) => rejectTimeMobile(context, await optionalJsonBody(request)))
