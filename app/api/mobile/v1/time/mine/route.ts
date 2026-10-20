import { handleMobileTime, loadMobileMyHours } from "@/lib/mobile/time"

export const GET = (request: Request) => handleMobileTime(request, loadMobileMyHours)
