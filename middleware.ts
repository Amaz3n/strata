import { NextResponse, type NextRequest } from "next/server"
import { createServerClient } from "@supabase/ssr"

const AUTH_ROUTES = ["/auth/signin", "/auth/signup", "/auth/forgot-password"]

export async function middleware(request: NextRequest) {
  const response = NextResponse.next({
    request: {
      headers: request.headers,
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
    data: { session },
  } = await supabase.auth.getSession()

  const pathname = request.nextUrl.pathname
  const isAuthRoute = pathname.startsWith("/auth")
  const isResetRoute = pathname.startsWith("/auth/reset")

  if (!session && !isAuthRoute) {
    const redirectUrl = new URL("/auth/signin", request.url)
    return withSupabaseCookies(response, NextResponse.redirect(redirectUrl))
  }

  if (session && AUTH_ROUTES.includes(pathname)) {
    const redirectUrl = new URL("/", request.url)
    return withSupabaseCookies(response, NextResponse.redirect(redirectUrl))
  }

  if (session && isResetRoute) {
    return response
  }

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
