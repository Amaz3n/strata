import { NextResponse, type NextRequest } from "next/server"
import { createServerClient } from "@supabase/ssr"

const AUTH_ROUTES = ["/auth/signin", "/auth/signup", "/auth/forgot-password", "/auth/accept-invite"]
const PUBLIC_ROUTES = ["/proposal", "/e/", "/i/", "/p/", "/s/", "/r/", "/b/", "/d/", "/f/", "/access", "/terms", "/privacy", "/esign-terms"]
const PUBLIC_API_ROUTES = [
  "/api/esign/executed/",
  "/api/jobs/process-outbox",
  "/api/jobs/backfill-search-index",
  "/api/jobs/rbac-evidence",
  "/api/webhooks/stripe",
  // Resend inbound-email webhook (emailed vendor bills) — self-authenticates
  // via the svix signature (RESEND_INBOUND_WEBHOOK_SECRET).
  "/api/webhooks/resend-inbound",
  // QBO infra routes — no user session; they self-authenticate via CRON_SECRET
  // (crons) or Intuit webhook signature (payment-webhook). Without these, the
  // proxy redirects them to /auth/signin (307) and they never run.
  "/api/qbo/process-cdc",
  "/api/qbo/process-webhooks",
  "/api/qbo/process-outbox",
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
  // Task self-reminder sweep — cron only, self-authenticates via CRON_SECRET.
  "/api/jobs/task-reminders",
  // Recurring invoice generator — cron only, self-authenticates via CRON_SECRET.
  "/api/jobs/invoice-schedules",
  // Scheduled jobs — no user session; each route self-authenticates via CRON_SECRET.
  // Keep this list mirrored with vercel.json/CRON_JOBS or Vercel receives a sign-in 307.
  "/api/jobs/weekly-executive-snapshot",
  "/api/jobs/follow-up-reminders",
  "/api/jobs/reminders",
  "/api/jobs/compliance-autopilot",
  "/api/jobs/esign",
  "/api/jobs/late-fees",
  // Portal drawing sheet PDFs — self-authenticate via the portal access token
  // in the path (no session cookie on client/sub portals).
  "/api/portal/drawings/",
  "/api/portal/files/",
  "/api/portal/log-file-access",
  "/api/portal/s/",
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
  if (isBlockedHiddenPath(request.nextUrl.pathname)) {
    return new NextResponse(null, {
      status: 404,
      headers: {
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      },
    })
  }

  const requestHeaders = new Headers(request.headers)
  requestHeaders.set("x-pathname", request.nextUrl.pathname)
  requestHeaders.set("x-search", request.nextUrl.search)

  const response = NextResponse.next({
    request: {
      headers: requestHeaders,
    },
  })

  const supabase = createServerClient(
    requireEnv(process.env.NEXT_PUBLIC_SUPABASE_URL, "NEXT_PUBLIC_SUPABASE_URL"),
    requireEnv(process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY, "NEXT_PUBLIC_SUPABASE_ANON_KEY"),
    {
      cookies: {
        get(name: string) {
          return request.cookies.get(name)?.value
        },
        set(name: string, value: string, options: any) {
          response.cookies.set({ name, value, ...options })
        },
        remove(name: string, options: any) {
          response.cookies.set({ name, value: "", ...options, maxAge: 0 })
        },
      },
    },
  )

  const {
    data: { user },
  } = await supabase.auth.getUser()

  const pathname = request.nextUrl.pathname
  const isAuthRoute = pathname.startsWith("/auth")
  const isPublicRoute = PUBLIC_ROUTES.some(route => pathname.startsWith(route))
  const isPublicApiRoute = PUBLIC_API_ROUTES.some(route => pathname.startsWith(route))
  const isPublicFile = PUBLIC_FILE_EXTENSIONS.some((extension) => pathname.endsWith(extension))

  if (isPublicFile) {
    return response
  }

  // Basic authentication checks only - keep proxy lightweight
  if (!user && !isAuthRoute && !isPublicRoute && !isPublicApiRoute) {
    const redirectUrl = new URL("/auth/signin", request.url)
    return withSupabaseCookies(response, NextResponse.redirect(redirectUrl))
  }

  if (user && !isAuthRoute && !isPublicRoute && !isPublicApiRoute) {
    const { data: assuranceData, error: assuranceError } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel()
    if (!assuranceError) {
      const requiresMfa = assuranceData?.nextLevel === "aal2" && assuranceData?.currentLevel !== "aal2"
      if (requiresMfa) {
        const redirectUrl = new URL("/auth/mfa", request.url)
        return withSupabaseCookies(response, NextResponse.redirect(redirectUrl))
      }
    }
  }

  if (user && AUTH_ROUTES.includes(pathname)) {
    const redirectUrl = new URL("/", request.url)
    return withSupabaseCookies(response, NextResponse.redirect(redirectUrl))
  }

  // Permission checks moved to app layout for better caching and memoization

  return response
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
