import type { NextRequest } from "next/server"

export function isAuthorizedCronRequest(request: NextRequest) {
  if (process.env.NODE_ENV !== "production") return true

  const secret = process.env.CRON_SECRET
  const authHeader = request.headers.get("authorization")
  const legacyHeader = request.headers.get("x-cron-secret")
  const secretMatches =
    Boolean(secret) &&
    (authHeader?.trim() === `Bearer ${secret}` || legacyHeader === secret)

  if (secret) return secretMatches
  return request.headers.get("x-vercel-cron") === "1"
}
