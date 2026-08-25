import { createBrowserClient } from "@supabase/ssr"
import type { SupabaseClient } from "@supabase/supabase-js"

// One GoTrueClient per tab, not per component. Every consumer used to memoize
// this per instance, so mounting two of them concurrently produced two clients
// racing to refresh the same stored session — the "Multiple GoTrueClient
// instances detected" warning, and intermittently a lost token rotation.
let browserClient: SupabaseClient | null = null

export function createClient(): SupabaseClient {
  if (!browserClient) {
    browserClient = createBrowserClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    )
  }
  return browserClient
}
