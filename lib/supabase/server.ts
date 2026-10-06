// This module holds the service-role key. `server-only` makes an accidental
// import from a client component a build error rather than a runtime surprise.
import "server-only"

import { cache } from "react"
import { cookies, headers } from "next/headers"
import { unstable_rethrow } from "next/navigation"
import { createServerClient } from "@supabase/ssr"
import { createClient as createBrowserlessClient, type SupabaseClient } from "@supabase/supabase-js"
import { createWorkerDatabaseFetch, hasWorkerDatabaseScope } from "@/lib/supabase/worker-request-context"
import { getScopedServiceSupabaseClient } from "@/lib/supabase/service-client-context"

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL
const SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY

function requireEnv(value: string | undefined, name: string) {
  if (!value) {
    throw new Error(`Missing environment variable: ${name}`)
  }
  return value
}

// Request-cached: the client is bound to the request's cookie store, so a single
// instance per request is correct and avoids rebuilding it in every service call.
export const createServerSupabaseClient = cache(async (): Promise<SupabaseClient> => {
  const url = requireEnv(SUPABASE_URL, "NEXT_PUBLIC_SUPABASE_URL")
  const anonKey = requireEnv(SUPABASE_ANON_KEY, "NEXT_PUBLIC_SUPABASE_ANON_KEY")

  try {
    const cookieStore = await cookies()

    // GoTrue stamps sessions with the caller's User-Agent/IP on sign-in AND on every
    // token refresh. Without forwarding, that caller is this Vercel function ("node",
    // AWS IP), which turns the Devices list into nonsense.
    const headerStore = await headers()
    const forwardedHeaders: Record<string, string> = {}
    const userAgent = headerStore.get("user-agent")
    const forwardedFor = headerStore.get("x-forwarded-for")
    if (userAgent) forwardedHeaders["User-Agent"] = userAgent
    if (forwardedFor) forwardedHeaders["X-Forwarded-For"] = forwardedFor

    return createServerClient(url, anonKey, {
      global: { headers: forwardedHeaders, ...(hasWorkerDatabaseScope() ? { fetch: createWorkerDatabaseFetch() } : {}) },
      cookies: {
        getAll: () => {
          return cookieStore.getAll()
        },
        setAll: (cookiesToSet) => {
          try {
            cookiesToSet.forEach(({ name, value, options }) => {
              cookieStore.set(name, value, options)
            })
          } catch {
            // Server Components cannot write cookies. The proxy refreshes the
            // session and persists any rotated tokens on the response instead.
          }
        },
      },
    })
  } catch (error) {
    // cookies()/headers() intentionally suspend Cache Components prerenders.
    // Preserve that framework control flow instead of mistaking it for a
    // missing-cookie environment and continuing with an anonymous client.
    unstable_rethrow(error)
    // If cookies fail, create a client without cookies (for server-side operations)
    console.warn('Cookies not available, creating client without cookies:', error)
    return createBrowserlessClient(url, anonKey, {
      ...(hasWorkerDatabaseScope() ? { global: { fetch: createWorkerDatabaseFetch() } } : {}),
      auth: {
        autoRefreshToken: false,
        persistSession: false,
      },
    })
  }
})


// Module singleton: the service client is stateless (no session, fixed key),
// so one instance can serve every call instead of being rebuilt per invocation.
let serviceClient: SupabaseClient | null = null

export function createServiceSupabaseClient(): SupabaseClient {
  const scoped = getScopedServiceSupabaseClient()
  if (scoped) return scoped
  if (!serviceClient) {
    const url = requireEnv(SUPABASE_URL, "NEXT_PUBLIC_SUPABASE_URL")
    const serviceRoleKey = requireEnv(SUPABASE_SERVICE_ROLE_KEY, "SUPABASE_SERVICE_ROLE_KEY")

    serviceClient = createBrowserlessClient(url, serviceRoleKey, {
      auth: {
        autoRefreshToken: false,
        persistSession: false,
      },
    })
  }
  return serviceClient
}

/** A separate client per worker claim; never mutate the shared service headers. */
export function createDrawingWorkerSupabaseClient(jobId: number, claimToken: string): SupabaseClient {
  return createBrowserlessClient(requireEnv(SUPABASE_URL, "NEXT_PUBLIC_SUPABASE_URL"),
    requireEnv(SUPABASE_SERVICE_ROLE_KEY, "SUPABASE_SERVICE_ROLE_KEY"), {
      auth: { autoRefreshToken: false, persistSession: false },
      global: { headers: { "x-drawing-job-id": String(jobId), "x-drawing-claim-token": claimToken } },
    })
}

/** Staged starts consumer support: requires approved claim/fencing schema before activation. */
export function createStartsWorkerSupabaseClient(jobId: number, claimToken: string): SupabaseClient {
  if (!Number.isSafeInteger(jobId) || jobId <= 0) throw new Error("Invalid starts worker job identifier")
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(claimToken)) throw new Error("Invalid starts claim token")
  return createBrowserlessClient(requireEnv(SUPABASE_URL, "NEXT_PUBLIC_SUPABASE_URL"),
    requireEnv(SUPABASE_SERVICE_ROLE_KEY, "SUPABASE_SERVICE_ROLE_KEY"), {
      auth: { autoRefreshToken: false, persistSession: false },
      global: { headers: { "x-starts-job-id": String(jobId), "x-starts-claim-token": claimToken } },
    })
}

/** Accounting invocation client: finite transport, isolated from the singleton. */
export function createAccountingWorkerSupabaseClient(): SupabaseClient {
  return createBrowserlessClient(requireEnv(SUPABASE_URL, "NEXT_PUBLIC_SUPABASE_URL"),
    requireEnv(SUPABASE_SERVICE_ROLE_KEY, "SUPABASE_SERVICE_ROLE_KEY"), {
      auth: { autoRefreshToken: false, persistSession: false },
      global: { fetch: createWorkerDatabaseFetch() },
    })
}
