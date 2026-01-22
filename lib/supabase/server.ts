import { cookies } from "next/headers"
import { createServerClient, type CookieOptions } from "@supabase/ssr"
import { createClient as createBrowserlessClient, type SupabaseClient } from "@supabase/supabase-js"

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL
const SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY

function requireEnv(value: string | undefined, name: string) {
  if (!value) {
    throw new Error(`Missing environment variable: ${name}`)
  }
  return value
}

export async function createServerSupabaseClient(): Promise<SupabaseClient> {
  const url = requireEnv(SUPABASE_URL, "NEXT_PUBLIC_SUPABASE_URL")
  const anonKey = requireEnv(SUPABASE_ANON_KEY, "NEXT_PUBLIC_SUPABASE_ANON_KEY")

  try {
    const cookieStore = await cookies()

    return createServerClient(url, anonKey, {
      cookies: {
        get: (name: string) => {
          try {
            const cookie = cookieStore.get(name)
            return cookie?.value
          } catch {
            return undefined
          }
        },
        set: (name: string, value: string, options: CookieOptions) => {
          try {
            cookieStore.set(name, value, options)
          } catch {
            // Failed to set cookie
          }
        },
        remove: (name: string, options: CookieOptions) => {
          try {
            cookieStore.set(name, "", { ...options, maxAge: 0 })
          } catch {
            // Failed to remove cookie
          }
        },
      },
    })
  } catch (error) {
    // If cookies fail, create a client without cookies (for server-side operations)
    console.warn('Cookies not available, creating client without cookies:', error)
    return createBrowserlessClient(url, anonKey, {
      auth: {
        autoRefreshToken: false,
        persistSession: false,
      },
    })
  }
}


export function createServiceSupabaseClient(): SupabaseClient {
  const url = requireEnv(SUPABASE_URL, "NEXT_PUBLIC_SUPABASE_URL")
  const serviceRoleKey = requireEnv(SUPABASE_SERVICE_ROLE_KEY, "SUPABASE_SERVICE_ROLE_KEY")

  return createBrowserlessClient(url, serviceRoleKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  })
}
