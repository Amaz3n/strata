import "server-only"
import { isDeepStrictEqual } from "node:util"
import type { SupabaseClient } from "@supabase/supabase-js"

/** Stable IDs use the existing primary key to survive crashes and competing retries. */
export async function insertImmutableRecord(
  supabase: SupabaseClient, table: "events" | "notifications", record: Record<string, unknown> & { id: string; org_id: string },
) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(record.id)) throw new Error("Invalid immutable record identity")
  const expected = JSON.parse(JSON.stringify(record)) as typeof record
  const read = async () => {
    const { data, error } = await supabase.from(table).select("*").eq("org_id", record.org_id).eq("id", record.id).maybeSingle()
    if (error) throw new Error(`Failed to recover ${table} receipt: ${error.message}`)
    if (!data) return null
    for (const [key, value] of Object.entries(expected)) {
      if (!isDeepStrictEqual(data[key], value)) throw new Error(`Immutable ${table} receipt does not match its original scope or payload`)
    }
    return data as Record<string, unknown> & { id: string; created_at: string }
  }
  const prior = await read()
  if (prior) return { record: prior, created: false }
  const { data, error } = await supabase.from(table).insert(expected).select("*").single()
  if (error?.code === "23505") {
    const winner = await read()
    if (!winner) throw new Error(`Immutable ${table} identity belongs to another scope`)
    return { record: winner, created: false }
  }
  if (error || !data) throw new Error(`Failed to persist ${table} receipt: ${error?.message ?? "Record unavailable"}`)
  return { record: data as Record<string, unknown> & { id: string; created_at: string }, created: true }
}
