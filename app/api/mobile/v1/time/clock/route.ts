import { handleMobileTime, loadMobileClock } from "@/lib/mobile/time"

export const GET = (request: Request) => handleMobileTime(request, loadMobileClock)
