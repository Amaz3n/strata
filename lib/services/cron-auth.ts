import type { NextRequest } from "next/server"

/**
 * The single authorization gate for every cron route.
 *
 * Fails CLOSED in production: without `CRON_SECRET` the request is denied. The
 * previous fallback trusted an `x-vercel-cron: 1` header when no secret was
 * configured, and that header is attacker-settable on a public route — it
 * authenticated nothing. Vercel sends `Authorization: Bearer $CRON_SECRET`
 * automatically once the environment variable exists, so setting it is the whole
 * deployment requirement.
 *
 * Outside production the secret is honored when configured and the gate is open
 * when it is not, so a local `curl` against a job route still works.
 */
export function isAuthorizedCronRequest(request: NextRequest) {
  const secret = process.env.CRON_SECRET
  if (!secret) return process.env.NODE_ENV !== "production"

  const authHeader = request.headers.get("authorization")
  const legacyHeader = request.headers.get("x-cron-secret")
  return authHeader?.trim() === `Bearer ${secret}` || legacyHeader === secret
}
