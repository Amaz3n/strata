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

export function createServerSupabaseClient(): SupabaseClient {
  const url = requireEnv(SUPABASE_URL, "NEXT_PUBLIC_SUPABASE_URL")
  const anonKey = requireEnv(SUPABASE_ANON_KEY, "NEXT_PUBLIC_SUPABASE_ANON_KEY")

  return createServerClient(url, anonKey, {
    cookies: {
      get: async (name: string) => {
        const store = await safeCookies()
        if (store && typeof (store as any).get === "function") {
          return (store as any).get(name)?.value
        }
        const value = (store as any)?.[name]
        if (!value) return undefined
        if (typeof value === "string") return value
        return value?.value ?? undefined
      },
      set: async (name: string, value: string, options: CookieOptions) => {
        const store = await safeCookies()
        if (store && typeof (store as any).set === "function") {
          store.set({ name, value, ...options })
        }
      },
      remove: async (name: string, options: CookieOptions) => {
        const store = await safeCookies()
        if (store && typeof (store as any).set === "function") {
          store.set({ name, value: "", ...options, maxAge: 0 })
        }
      },
    },
  })
}

async function safeCookies() {
  try {
    return await cookies()
  } catch {
    return undefined
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
