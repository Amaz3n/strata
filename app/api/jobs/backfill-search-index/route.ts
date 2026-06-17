import { NextRequest, NextResponse } from "next/server"

import { createServiceSupabaseClient } from "@/lib/supabase/server"
import { SEARCH_CONFIGS, type SearchEntityType } from "@/lib/services/search-config"
import { REINDEX_JOB_TYPE } from "@/lib/services/search-index"

export const runtime = "nodejs"

const CRON_SECRET = process.env.CRON_SECRET
const PAGE_SIZE = 1000
// Cap how many reindex jobs a single invocation enqueues so the request stays
// bounded; call repeatedly (or per type/org) to backfill larger datasets.
const MAX_ENQUEUE_PER_CALL = 5000

function isAuthorized(request: NextRequest) {
  if (process.env.NODE_ENV !== "production") return true
  const authHeader = request.headers.get("authorization") ?? request.headers.get("Authorization")
  const bearer = typeof authHeader === "string" ? authHeader.trim() : ""
  const legacy = request.headers.get("x-cron-secret")
  return Boolean(CRON_SECRET) && (bearer === `Bearer ${CRON_SECRET}` || legacy === CRON_SECRET)
}

function resolveTypes(requested: string | null): SearchEntityType[] {
  const all = Object.keys(SEARCH_CONFIGS) as SearchEntityType[]
  if (!requested) return all
  const set = new Set(all)
  return requested
    .split(",")
    .map((value) => value.trim())
    .filter((value): value is SearchEntityType => set.has(value as SearchEntityType))
}

// Backfills / repairs the unified search index by enqueuing reindex_search jobs
// for existing rows. The outbox worker then upserts search_documents (and
// embeddings) with retries. Idempotent: re-running simply re-enqueues upserts.
export async function POST(request: NextRequest) {
  if (!isAuthorized(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  const { searchParams } = new URL(request.url)
  const orgId = searchParams.get("org")?.trim() || null
  const types = resolveTypes(searchParams.get("type"))
  const supabase = createServiceSupabaseClient()

  let enqueued = 0
  const perType: Record<string, number> = {}
  let reachedCap = false

  for (const entityType of types) {
    if (reachedCap) break
    const config = SEARCH_CONFIGS[entityType]
    let from = 0

    for (;;) {
      if (enqueued >= MAX_ENQUEUE_PER_CALL) {
        reachedCap = true
        break
      }

      let query = supabase
        .from(config.table)
        .select("id, org_id")
        .order("created_at", { ascending: true })
        .range(from, from + PAGE_SIZE - 1)
      if (orgId) query = query.eq("org_id", orgId)

      const { data, error } = await query
      if (error) {
        return NextResponse.json({ error: `${entityType}: ${error.message}`, enqueued, perType }, { status: 500 })
      }
      if (!data || data.length === 0) break

      const rows = data as Array<{ id: string; org_id: string }>
      const jobs = rows
        .filter((row) => row.org_id && row.id)
        .map((row) => ({
          org_id: row.org_id,
          job_type: REINDEX_JOB_TYPE,
          payload: { entity_type: entityType, entity_id: row.id },
          run_at: new Date().toISOString(),
        }))

      if (jobs.length > 0) {
        const { error: insertError } = await supabase.from("outbox").insert(jobs)
        if (insertError) {
          return NextResponse.json({ error: insertError.message, enqueued, perType }, { status: 500 })
        }
        enqueued += jobs.length
        perType[entityType] = (perType[entityType] ?? 0) + jobs.length
      }

      if (rows.length < PAGE_SIZE) break
      from += PAGE_SIZE
    }
  }

  return NextResponse.json({ enqueued, perType, reachedCap })
}
