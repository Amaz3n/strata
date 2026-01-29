import { NextResponse, type NextRequest } from "next/server"
import { createServerClient } from "@supabase/ssr"

const AUTH_ROUTES = ["/auth/signin", "/auth/signup", "/auth/forgot-password", "/auth/accept-invite"]
const PUBLIC_ROUTES = ["/proposal", "/i/", "/p/", "/s/"]
const PUBLIC_API_ROUTES = ["/api/jobs/process-outbox"]

export async function middleware(request: NextRequest) {
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
  const isResetRoute = pathname.startsWith("/auth/reset")
  const isUnauthorizedRoute = pathname.startsWith("/unauthorized")
  const isPublicRoute = PUBLIC_ROUTES.some(route => pathname.startsWith(route))
  const isPublicApiRoute = PUBLIC_API_ROUTES.some(route => pathname.startsWith(route))

  // Basic authentication checks only - keep middleware lightweight
  if (!user && !isAuthRoute && !isPublicRoute && !isPublicApiRoute) {
    const redirectUrl = new URL("/auth/signin", request.url)
    return withSupabaseCookies(response, NextResponse.redirect(redirectUrl))
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
