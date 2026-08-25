import { NextResponse, type NextRequest } from "next/server"
import { createServerClient } from "@supabase/ssr"
import type { SupabaseClient } from "@supabase/supabase-js"

import { normalizeInternalReturnPath } from "@/lib/auth/return-path"
import {
  MFA_GATE_COOKIE,
  MFA_GATE_TTL_SECONDS,
  signMfaGateCookie,
  verifyMfaGateCookie,
} from "@/lib/auth/mfa-gate-cookie"

const AUTH_ROUTES = ["/auth/signin", "/auth/signup", "/auth/forgot-password", "/auth/accept-invite"]
const PUBLIC_ROUTES = ["/proposal", "/e/", "/i/", "/p/", "/s/", "/r/", "/b/", "/d/", "/f/", "/access", "/terms", "/privacy", "/esign-terms"]
const PUBLIC_API_ROUTES = [
  "/api/esign/executed/",
  "/api/jobs/session-cleanup",
  "/api/jobs/process-outbox",
  "/api/jobs/backfill-search-index",
  "/api/jobs/backfill-image-previews",
  "/api/jobs/rbac-evidence",
  "/api/webhooks/stripe",
  // Resend inbound-email webhook (emailed vendor bills) — self-authenticates
  // via the svix signature (RESEND_INBOUND_WEBHOOK_SECRET).
  "/api/webhooks/resend-inbound",
  // Accounting infra routes — no user session; they self-authenticate via
  // CRON_SECRET. Without these, the proxy redirects them to /auth/signin (307)
  // and they never run.
  "/api/accounting/process-changes",
  "/api/accounting/process-inbound",
  "/api/accounting/process-outbox",
  // Intuit webhook endpoint — Intuit authenticates via signature, not a session.
  "/api/qbo/payment-webhook",
  // Codex review callback — no user session cookie; it self-authenticates via
  // CODEX_REVIEW_CALLBACK_SECRET. Without this, GitHub receives a 307 to sign-in.
  "/api/platform/bugs/ai-review-callback",
  "/api/platform/bugs/ai-fix-callback",
  // Mobile API — no web session cookie; each route self-authenticates via the
  // Supabase bearer token (requireMobileUser). Without this, the proxy 307s
  // every request to /auth/signin and the iOS app sees empty orgs/projects.
  "/api/mobile/",
  // Drawings pipeline kick — self-authenticates via CRON_SECRET.
  "/api/jobs/drawings-pipeline",
  "/api/jobs/specs-pipeline",
  "/api/jobs/meeting-transcription",
  "/api/jobs/meeting-audio-cleanup",
  // Task self-reminder sweep — cron only, self-authenticates via CRON_SECRET.
  "/api/jobs/task-reminders",
  // Selection deadline reminder and lock sweep — cron only, self-authenticates via CRON_SECRET.
  "/api/jobs/selection-cutoff-sweep",
  "/api/jobs/purchasing-maintenance",
  "/api/jobs/starts-pipeline",
  "/api/jobs/warranty-sla-sweep",
  "/api/jobs/lot-hold-sweep",
  "/api/jobs/takedown-reminders",
  "/api/jobs/warranty-courtesy-inspections",
  // Recurring invoice generator — cron only, self-authenticates via CRON_SECRET.
  "/api/jobs/invoice-schedules",
  "/api/jobs/forecast-snapshots",
  "/api/jobs/books-projection",
  "/api/jobs/books-maintenance",
  "/api/jobs/accounting-reconciliation",
  "/api/jobs/bank-feed-sync",
  "/api/jobs/report-schedules",
  "/api/exports/reports/",
  // Scheduled jobs — no user session; each route self-authenticates via CRON_SECRET.
  // Keep this list mirrored with vercel.json/CRON_JOBS or Vercel receives a sign-in 307.
  "/api/jobs/weekly-executive-snapshot",
  "/api/jobs/follow-up-reminders",
  "/api/jobs/reminders",
  "/api/jobs/compliance-autopilot",
  "/api/jobs/esign",
  "/api/jobs/late-fees",
  "/api/jobs/payment-controls",
  "/api/jobs/payment-release",
  "/api/jobs/payment-reconciliation",
  "/api/jobs/ops-watchdog",
  // Standing assistant questions — cron only, self-authenticates via CRON_SECRET.
  "/api/jobs/ai-standing-questions",
  // Portal drawing sheet PDFs — self-authenticate via the portal access token
  // in the path (no session cookie on client/sub portals).
  "/api/portal/drawings/",
  "/api/portal/files/",
  "/api/portal/log-file-access",
  "/api/portal/s/",
  "/api/portal/b/",
  "/api/webhooks/plaid",
]
const PUBLIC_FILE_EXTENSIONS = [
  ".svg",
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".ico",
  ".txt",
  ".xml",
  ".json",
  ".map",
  ".css",
  ".js",
  // ES-module assets. pdf.js ships its worker as .mjs and fetches it directly;
  // without this it is answered with a sign-in redirect, and the empty MIME type
  // fails the worker with "'' is not a valid JavaScript MIME type".
  ".mjs",
  ".woff",
  ".woff2",
  ".ttf",
  ".otf",
  ".eot",
]

function isBlockedHiddenPath(pathname: string) {
  let decodedPathname: string
  try {
    decodedPathname = decodeURIComponent(pathname)
  } catch {
    return true
  }

  return decodedPathname
    .split("/")
    .some((segment, index) => segment.startsWith(".") && !(index === 1 && segment === ".well-known"))
}

export async function proxy(request: NextRequest) {
  const pathname = request.nextUrl.pathname

  if (isBlockedHiddenPath(pathname)) {
    return new NextResponse(null, {
      status: 404,
      headers: {
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      },
    })
  }

  // Static assets and the self-authenticating API routes below (cron secrets,
  // webhook signatures, portal path tokens, mobile bearer tokens) never read the
  // session cookie. Leaving before the client is built stops them paying for a
  // Supabase construction and a claims verification they then ignore.
  if (
    PUBLIC_FILE_EXTENSIONS.some((extension) => pathname.endsWith(extension)) ||
    PUBLIC_API_ROUTES.some((route) => pathname.startsWith(route))
  ) {
    return NextResponse.next()
  }

  const requestHeaders = new Headers(request.headers)

  let response = NextResponse.next({
    request: {
      headers: requestHeaders,
    },
  })

  const clientUserAgent = request.headers.get("user-agent")
  const clientForwardedFor = request.headers.get("x-forwarded-for")
  const clientIdentityHeaders: Record<string, string> = {
    ...(clientUserAgent ? { "User-Agent": clientUserAgent } : {}),
    ...(clientForwardedFor ? { "X-Forwarded-For": clientForwardedFor } : {}),
  }

  const supabase = createServerClient(
    requireEnv(process.env.NEXT_PUBLIC_SUPABASE_URL, "NEXT_PUBLIC_SUPABASE_URL"),
    requireEnv(process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY, "NEXT_PUBLIC_SUPABASE_ANON_KEY"),
    {
      // Token refreshes from this proxy overwrite the session's User-Agent/IP in
      // auth.sessions — forward the browser's so the Devices list stays truthful.
      global: { headers: clientIdentityHeaders },
      cookies: {
        getAll() {
          return request.cookies.getAll()
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value))
          requestHeaders.set("cookie", request.cookies.toString())

          // Recreate the pass-through response so Server Components receive
          // refreshed tokens during this same request. Note this REBINDS
          // `response` — anything written to the old object is lost, so cookies
          // must always be set on `response` as read at the point of use.
          response = NextResponse.next({
            request: {
              headers: requestHeaders,
            },
          })
          cookiesToSet.forEach(({ name, value, options }) => {
            response.cookies.set(name, value, options)
          })
        },
      },
    },
  )

  // getClaims verifies the session JWT locally when the project uses asymmetric
  // signing keys (no network), and falls back to the Auth server otherwise —
  // never slower than the getUser() round-trip this replaced. Expired tokens
  // still refresh here, writing the new cookies onto the response.
  const { data: claimsData } = await supabase.auth.getClaims()
  const claims = claimsData?.claims ?? null

  const isAuthRoute = pathname.startsWith("/auth")
  const isPublicRoute = PUBLIC_ROUTES.some(route => pathname.startsWith(route))

  // Basic authentication checks only - keep proxy lightweight
  if (!claims && !isAuthRoute && !isPublicRoute) {
    const redirectUrl = new URL("/auth/signin", request.url)
    redirectUrl.searchParams.set("next", `${request.nextUrl.pathname}${request.nextUrl.search}`)
    return withSupabaseCookies(response, NextResponse.redirect(redirectUrl))
  }

  if (claims && !isAuthRoute && !isPublicRoute && claims.aal !== "aal2") {
    const gate = await resolveMfaGate(request, supabase, claims)
    if (gate.stepUp) {
      return withSupabaseCookies(response, NextResponse.redirect(new URL("/auth/mfa", request.url)))
    }
    // Read `response` here, not before the await: a token refresh during the
    // lookup above rebinds it, and a cookie set on the old object never ships.
    if (gate.proof) {
      response.cookies.set({
        name: MFA_GATE_COOKIE,
        value: gate.proof,
        httpOnly: true,
        secure: true,
        sameSite: "lax",
        path: "/",
        maxAge: MFA_GATE_TTL_SECONDS,
      })
    }
  }

  if (claims && AUTH_ROUTES.includes(pathname)) {
    const redirectUrl = new URL(normalizeInternalReturnPath(request.nextUrl.searchParams.get("next")), request.url)
    return withSupabaseCookies(response, NextResponse.redirect(redirectUrl))
  }

  // Permission checks moved to app layout for better caching and memoization

  return response
}


/**
 * Decide whether this aal1 session must step up to aal2.
 *
 * Supabase's assurance-level helper reads `getSession().user.factors`, which is
 * client-controlled cookie storage — trusting it would let anyone strip their
 * factors and skip the challenge. The Auth server is the only authority, so the
 * first request in a window pays that round-trip and returns `proof`: a signed
 * "this user has no verified factor" the caller stores. Later navigations verify
 * that signature locally instead of asking again, which is what stops a non-MFA
 * user — permanently aal1, so permanently taking this branch — from paying a
 * GoTrue call on every single request.
 *
 * Returns the proof rather than writing it, because the caller's response object
 * can be rebound by a token refresh while this runs.
 */
async function resolveMfaGate(
  request: NextRequest,
  supabase: SupabaseClient,
  claims: { sub?: unknown; session_id?: unknown },
): Promise<{ stepUp: boolean; proof?: string }> {
  const sub = typeof claims.sub === "string" ? claims.sub : null
  const sessionId = typeof claims.session_id === "string" ? claims.session_id : null
  const identity = sub && sessionId ? { sub, sessionId } : null

  if (identity && (await verifyMfaGateCookie(request.cookies.get(MFA_GATE_COOKIE)?.value, identity))) {
    return { stepUp: false }
  }

  const {
    data: { user: verifiedUser },
    error: verifiedUserError,
  } = await supabase.auth.getUser()

  // A failed lookup is not proof of absence — leave the session alone rather
  // than either challenging or exempting it on a network error.
  if (verifiedUserError) return { stepUp: false }

  if ((verifiedUser?.factors ?? []).some((factor) => factor.status === "verified")) {
    return { stepUp: true }
  }

  return { stepUp: false, proof: identity ? (await signMfaGateCookie(identity)) ?? undefined : undefined }
}

function requireEnv(value: string | undefined, name: string) {
  if (!value) throw new Error(`Missing required environment variable ${name}`)
  return value
}

function withSupabaseCookies(source: NextResponse, target: NextResponse) {
  source.cookies.getAll().forEach((cookie) => {
    target.cookies.set(cookie)
  })
  return target
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|robots.txt|sitemap.xml).*)"],
}
