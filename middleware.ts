import { NextResponse, type NextRequest } from "next/server"
import { createServerClient } from "@supabase/ssr"
import { createServiceSupabaseClient } from "@/lib/supabase/server"
import { isPlatformAdminId } from "@/lib/auth/platform"

const AUTH_ROUTES = ["/auth/signin", "/auth/signup", "/auth/forgot-password"]
const PROTECTED_ROUTES: { prefix: string; permission: string }[] = [
  { prefix: "/settings", permission: "members.manage" },
  { prefix: "/team", permission: "org.read" },
  { prefix: "/settings/billing", permission: "billing.manage" },
  { prefix: "/settings/support", permission: "billing.manage" },
  { prefix: "/admin", permission: "billing.manage" },
]

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
  const isUnauthorizedRoute = pathname.startsWith("/unauthorized")

  if (!session && !isAuthRoute) {
    const redirectUrl = new URL("/auth/signin", request.url)
    return withSupabaseCookies(response, NextResponse.redirect(redirectUrl))
  }

  if (session && AUTH_ROUTES.includes(pathname)) {
    const redirectUrl = new URL("/", request.url)
    return withSupabaseCookies(response, NextResponse.redirect(redirectUrl))
  }

  if (!session) {
    return response
  }

  if (!isAuthRoute && !isResetRoute && !isUnauthorizedRoute) {
    const matched = PROTECTED_ROUTES.find((route) => pathname.startsWith(route.prefix))
    if (matched) {
      const orgId = await resolveOrgId(supabase, session.user.id, request)
      const isPlatformAdmin = isPlatformAdminId(session.user.id, session.user.email)
      const permissions = isPlatformAdmin ? ["*"] : orgId ? await fetchPermissionsForOrg(session.user.id, orgId) : []
      const hasPermission = isPlatformAdmin || permissions.includes(matched.permission)

      if (!orgId || !hasPermission) {
        const redirectUrl = new URL("/unauthorized", request.url)
        return withSupabaseCookies(response, NextResponse.redirect(redirectUrl))
      }
    }
  }

  return response
}

async function resolveOrgId(supabase: any, userId: string, request: NextRequest) {
  const cookieOrg = request.cookies.get("org_id")?.value
  if (cookieOrg) return cookieOrg

  const { data, error } = await supabase
    .from("memberships")
    .select("org_id")
    .eq("user_id", userId)
    .eq("status", "active")
    .order("created_at", { ascending: true })
    .limit(1)

  if (error) {
    console.error("Unable to resolve org for middleware", error)
    return null
  }

  return Array.isArray(data) && data[0]?.org_id ? data[0].org_id : null
}

async function fetchPermissionsForOrg(userId: string, orgId: string) {
  // Use service role to bypass restrictive RLS on role_permissions.
  const serviceClient = createServiceSupabaseClient()
  const { data, error } = await serviceClient
    .from("memberships")
    .select("role:roles!inner(permissions:role_permissions(permission_key))")
    .eq("org_id", orgId)
    .eq("user_id", userId)
    .eq("status", "active")
    .order("created_at", { ascending: true })
    .limit(1)

  if (error) {
    console.error("Unable to load permissions in middleware", error)
    return []
  }

  const row = Array.isArray(data) ? data[0] : (data as any)
  return row?.role?.permissions?.map((p: any) => p.permission_key) ?? []
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
