import "server-only"

import { AsyncLocalStorage } from "node:async_hooks"
import type { SupabaseClient } from "@supabase/supabase-js"

const scopedServiceClient = new AsyncLocalStorage<SupabaseClient>()

/** Isolate a worker's ownership headers across nested services and concurrent jobs. */
export function runWithServiceSupabaseClient<T>(client: SupabaseClient, work: () => Promise<T>): Promise<T> {
  return scopedServiceClient.run(client, work)
}

export function getScopedServiceSupabaseClient(): SupabaseClient | undefined {
  return scopedServiceClient.getStore()
}
